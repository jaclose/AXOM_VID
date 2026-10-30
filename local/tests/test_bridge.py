"""Contract tests for the local-only Phosphene video bridge.

The mock Phosphene HTTP server uses no GPU, network account or model download.
Run: python3 -m unittest discover -s local/tests -v
"""
import io
import json
import os
import shutil
import time
import socket
import subprocess
from unittest.mock import patch
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs
from urllib.request import Request, urlopen

from local.bridge import (LocalVideoServer, LocalVideoHandler,
                          create_server_with_fallback, evaluate_generation_guard)

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000b49444154789c636000020000050001a5f645400000000049454e44ae426082"
)


class MockPhosphene(BaseHTTPRequestHandler):
    result_file = None
    seen_params = None
    submission_count = 0
    seen_submissions = []
    job_ids = []
    download_state = {"active": False, "state": "done", "pending": []}
    status_overrides = {}

    def log_message(self, *args):
        pass

    def _json(self, data):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(size)
        if self.path == "/upload":
            assert b'name="image"' in data
            assert b"\x89PNG" in data
            self._json({"path": "/tmp/panel_uploads/test.png"})
        elif self.path == "/queue/add":
            MockPhosphene.seen_params = parse_qs(data.decode())
            MockPhosphene.seen_submissions.append(MockPhosphene.seen_params)
            MockPhosphene.submission_count += 1
            job_id = "j-local-test-" + str(MockPhosphene.submission_count)
            MockPhosphene.job_ids.append(job_id)
            self._json({"ok": True, "id": job_id})
        else:
            self.send_error(404)

    def do_GET(self):
        if self.path == "/status":
            self._json({
                "running": False,
                "base_available": True,
                "model_integrity": {"ok": True, "bad": [], "checked": 26},
                "tier": {"key": "base", "ram_gb": 18, "i2v_max_dim": 768,
                         "allows_q8": False, "allows_keyframe": False},
                "memory": {"total_gb": 18.0, "pressure_pct": 72, "swap_gb": 4.2},
                "deferred_downloads": MockPhosphene.download_state,
                "gpu": {"busy": False, "holder": None},
                "current": None,
                "queue": [],
                "history": [{"id": job_id, "status": "done",
                             "params": {"mode": "i2v"},
                             "output_path": str(MockPhosphene.result_file),
                             "elapsed_sec": 12}
                            for job_id in MockPhosphene.job_ids],
                **MockPhosphene.status_overrides,
            })
        else:
            self.send_error(404)


class LocalBridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tempdir.name)
        cls.site = cls.root / "dist"
        cls.site.mkdir()
        (cls.site / "index.html").write_text("<title>AXOM local test</title>")
        clips = cls.root / "mlx_outputs"
        clips.mkdir()
        MockPhosphene.result_file = clips / "finished.mp4"
        MockPhosphene.result_file.write_bytes(b"\x00\x00\x00\x18ftypmp42example")
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), MockPhosphene)
        cls.upstream_url = "http://127.0.0.1:" + str(cls.upstream.server_port)
        cls.upstream_thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.upstream_thread.start()
        cls.bridge = LocalVideoServer(
            ("127.0.0.1", 0), LocalVideoHandler,
            static_root=cls.site, phosphene_url=cls.upstream_url,
        )
        cls.bridge_url = "http://127.0.0.1:" + str(cls.bridge.server_port)
        cls.bridge_thread = threading.Thread(target=cls.bridge.serve_forever, daemon=True)
        cls.bridge_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.bridge.shutdown()
        cls.bridge.server_close()
        cls.upstream.shutdown()
        cls.upstream.server_close()
        cls.tempdir.cleanup()

    def _get(self, path):
        with urlopen(self.bridge_url + path) as res:
            return res.status, res.read(), dict(res.headers)

    def _post(self, path, body, ctype, origin=None):
        headers = {"Content-Type": ctype}
        if origin:
            headers["Origin"] = origin
        return urlopen(Request(
            self.bridge_url + path, data=body, headers=headers, method="POST",
        ))

    def _form(self, image=PNG, prompt="A golden retriever runs through wildflowers", duration=3,
              orientation="landscape", batch=1, variants=None, **extras):
        boundary = "AXOMBOUNDARY123"
        settings = json.dumps({"prompt": prompt, "duration_seconds": duration,
                               "orientation": orientation, "batch_count": batch,
                               "prompts": variants, **extras}).encode()
        parts = [
            b"--" + boundary.encode() + b"\r\n"
            b'Content-Disposition: form-data; name="image"; filename="frame.png"\r\n'
            b"Content-Type: image/png\r\n\r\n" + image + b"\r\n",
            b"--" + boundary.encode() + b"\r\n"
            b'Content-Disposition: form-data; name="params"\r\n\r\n' + settings + b"\r\n",
            b"--" + boundary.encode() + b"--\r\n",
        ]
        return b"".join(parts), "multipart/form-data; boundary=" + boundary

    def test_local_health_reflects_available_phosphene_engine(self):
        status, body, _ = self._get("/local/health")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["online"])

    def test_occupied_studio_port_falls_back_without_stopping_other_listener(self):
        occupied = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        occupied.bind(("127.0.0.1", 0))
        occupied.listen(1)
        blocked_port = occupied.getsockname()[1]
        try:
            bridge = create_server_with_fallback(
                start_port=blocked_port, attempts=6, static_root=self.site,
                phosphene_url=self.upstream_url,
            )
            try:
                self.assertNotEqual(bridge.server_port, blocked_port)
                self.assertGreater(bridge.server_port, blocked_port)
                self.assertLess(bridge.server_port, blocked_port + 6)
                self.assertEqual(occupied.getsockname()[1], blocked_port)
                background = threading.Thread(target=bridge.serve_forever, daemon=True)
                background.start()
                with urlopen("http://127.0.0.1:" + str(bridge.server_port)
                             + "/AXOM_VID/") as response:
                    self.assertEqual(response.status, 200)
                    self.assertIn(b"AXOM local test", response.read())
            finally:
                bridge.shutdown()
                bridge.server_close()
        finally:
            occupied.close()

    def test_port_fallback_does_not_hide_unavailable_configured_port(self):
        occupied = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        occupied.bind(("127.0.0.1", 0))
        occupied.listen(1)
        try:
            with self.assertRaises(OSError):
                create_server_with_fallback(
                    start_port=occupied.getsockname()[1], attempts=1,
                    static_root=self.site, phosphene_url=self.upstream_url,
                )
        finally:
            occupied.close()

    def test_site_is_served_on_same_origin(self):
        status, body, _ = self._get("/")
        self.assertEqual(status, 200)
        self.assertIn(b"AXOM local test", body)

    def test_local_studio_serves_github_pages_subpath(self):
        status, body, _ = self._get("/AXOM_VID/")
        self.assertEqual(status, 200)
        self.assertIn(b"AXOM local test", body)
        assets = self.site / "_astro"
        assets.mkdir(exist_ok=True)
        (assets / "sample.js").write_text('console.log("offline");')
        status, content, _ = self._get("/AXOM_VID/_astro/sample.js")
        self.assertEqual(status, 200)
        self.assertIn(b"offline", content)

    def test_local_generation_uses_phosphene_not_cloud(self):
        body, ctype = self._form(orientation="portrait")
        with self._post("/local/generate", body, ctype) as res:
            payload = json.loads(res.read())
            self.assertEqual(res.status, 200)
            self.assertTrue(payload["jobId"].startswith("j-local-test-"))
        fields = MockPhosphene.seen_params
        self.assertEqual(fields["mode"], ["i2v"])
        self.assertEqual(fields["quality"], ["quick"])
        self.assertEqual(fields["image"], ["/tmp/panel_uploads/test.png"])
        self.assertEqual(fields["width"], ["288"])
        self.assertEqual(fields["height"], ["512"])
        self.assertEqual(fields["frames"], ["73"])

    def test_completed_video_download_is_restricted_to_owned_job(self):
        body, ctype = self._form()
        with self._post("/local/generate", body, ctype) as submitted:
            self.assertEqual(submitted.status, 200)
            job_id = json.loads(submitted.read())["jobId"]
        status, body, _ = self._get("/local/status?jobId=" + job_id)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["status"], "done")
        self.assertEqual(json.loads(body)["videoUrl"],
                         "/local/video?jobId=" + job_id)
        status, data, headers = self._get("/local/video?jobId=" + job_id)
        self.assertEqual(status, 200)
        self.assertIn(b"ftypmp42", data)
        self.assertTrue(headers["Content-Type"].startswith("video/mp4"))

    def test_video_stream_supports_byte_range_requests(self):
        body, ctype = self._form()
        with self._post("/local/generate", body, ctype) as result:
            job_id = json.load(result)["jobId"]
        request = Request(self.bridge_url + "/local/video?jobId=" + job_id,
                          headers={"Range": "bytes=4-11"})
        with urlopen(request) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.read(), MockPhosphene.result_file.read_bytes()[4:12])
            self.assertIn("bytes 4-11/", response.headers.get("Content-Range", ""))

    def test_out_of_bounds_video_range_returns_416(self):
        body, ctype = self._form()
        with self._post("/local/generate", body, ctype) as result:
            job_id = json.load(result)["jobId"]
        request = Request(self.bridge_url + "/local/video?jobId=" + job_id,
                          headers={"Range": "bytes=99999-100000"})
        with self.assertRaises(HTTPError) as raised:
            urlopen(request)
        self.assertEqual(raised.exception.code, 416)

    def test_unknown_job_cannot_read_arbitrary_local_files(self):
        with self.assertRaises(HTTPError) as raised:
            self._get("/local/video?jobId=../README.md")
        self.assertEqual(raised.exception.code, 404)

    def test_foreign_origin_cannot_submit_gpu_jobs(self):
        before = MockPhosphene.submission_count
        body, ctype = self._form()
        with self.assertRaises(HTTPError) as raised:
            self._post("/local/generate", body, ctype,
                       origin="https://evil.example")
        self.assertEqual(raised.exception.code, 403)
        self.assertEqual(MockPhosphene.submission_count, before)

    def test_invalid_image_is_rejected_before_upstream_upload(self):
        before = MockPhosphene.submission_count
        body, ctype = self._form(image=b"not a real png")
        with self.assertRaises(HTTPError) as raised:
            self._post("/local/generate", body, ctype)
        self.assertEqual(raised.exception.code, 415)
        self.assertEqual(MockPhosphene.submission_count, before)

    def test_unsupported_length_is_rejected(self):
        body, ctype = self._form(duration=9)
        with self.assertRaises(HTTPError) as raised:
            self._post("/local/generate", body, ctype)
        self.assertEqual(raised.exception.code, 400)


    def test_gpu_watchdog_cooldown_is_explicit_in_health_and_rejects_submission(self):
        started = time.time() - 50
        watchdog = {
            "id": "j-watchdog-test",
            "status": "failed", "started_ts": started, "elapsed_sec": 20,
            "error": "helper exited from SIGABRT (kIOGPUCommandBufferCallbackErrorTimeout)",
        }
        before = MockPhosphene.submission_count
        with patch.object(MockPhosphene, "status_overrides", {"history": [watchdog]}):
            status, body, _ = self._get("/local/health")
            health = json.loads(body)
            self.assertTrue(health["readyToGenerate"])
            self.assertFalse(health["safeToSubmit"])
            self.assertEqual(health["guard"]["kind"], "cooldown")
            self.assertGreater(health["guard"]["retryAfterSeconds"], 0)
            req_body, ctype = self._form()
            with self.assertRaises(HTTPError) as response:
                self._post("/local/generate", req_body, ctype)
            self.assertEqual(response.exception.code, 429)
        self.assertEqual(MockPhosphene.submission_count, before)

    def test_busy_phosphene_gpu_prevents_duplicating_job_before_upload(self):
        before = MockPhosphene.submission_count
        current = {"id": "j-existing", "status": "running"}
        with patch.object(MockPhosphene, "status_overrides",
                          {"current": current, "gpu": {"busy": True, "holder": "queue"}}):
            health = json.loads(self._get("/local/health")[1])
            self.assertFalse(health["safeToSubmit"])
            self.assertEqual(health["guard"]["kind"], "busy")
            body, ctype = self._form()
            with self.assertRaises(HTTPError) as response:
                self._post("/local/generate", body, ctype)
            self.assertEqual(response.exception.code, 409)
        self.assertEqual(MockPhosphene.submission_count, before)

    def test_q8_weight_download_pauses_new_mac_renders_without_deleting_files(self):
        before = MockPhosphene.submission_count
        ongoing = {"active": True, "key": "q8_25",
                   "name": "LTX Q8 weights", "size_gb": 30.02}
        with patch.object(MockPhosphene, "status_overrides", {"download": ongoing}):
            health = json.loads(self._get("/local/health")[1])
            self.assertFalse(health["safeToSubmit"])
            self.assertEqual(health["guard"]["kind"], "download")
            self.assertTrue(health["guard"]["unsupportedQ8Download"])
            body, ctype = self._form()
            with self.assertRaises(HTTPError) as response:
                self._post("/local/generate", body, ctype)
            self.assertEqual(response.exception.code, 409)
        self.assertEqual(MockPhosphene.submission_count, before)

    def test_unverified_gpu_uses_only_three_second_quick_single_render(self):
        with patch.object(MockPhosphene, "status_overrides", {"history": []}):
            health = json.loads(self._get("/local/health")[1])
            self.assertTrue(health["safeToSubmit"])
            self.assertTrue(health["guard"]["firstRenderRequired"])
            self.assertEqual(health["guard"]["maxDurationSeconds"], 3)
            for kwargs in ({"duration": 5}, {"batch": 2},
                           {"resolution": "640"}, {"quality": "balanced"}):
                body, ctype = self._form(**kwargs)
                with self.assertRaises(HTTPError) as response:
                    self._post("/local/generate", body, ctype)
                self.assertEqual(response.exception.code, 400)
            body, ctype = self._form()
            with self._post("/local/generate", body, ctype) as response:
                self.assertEqual(response.status, 200)

    def test_first_verified_image_to_video_unblocks_advanced_when_ram_is_healthy(self):
        history = [{"id": "j-done", "status": "done",
                    "params": {"mode": "i2v"}, "output_path": "/tmp/valid.mp4"}]
        state = {
            "tier": {"key": "base", "ram_gb": 18, "i2v_max_dim": 768},
            "memory": {"total_gb": 18, "pressure_pct": 51, "swap_gb": 1.0},
            "base_available": True,
            "model_integrity": {"ok": True},
            "engine_env": {"ok": True},
            "current": None, "queue": [],
            "gpu": {"busy": False},
            "deferred_downloads": {"active": False, "state": "done", "pending": []},
            "history": history,
        }
        guard = evaluate_generation_guard(state, now=time.time())
        self.assertTrue(guard["safeToSubmit"])
        self.assertFalse(guard["firstRenderRequired"])
        self.assertGreaterEqual(guard["maxDurationSeconds"], 10)
        self.assertGreaterEqual(guard["maxBatch"], 2)

    def test_high_memory_pressure_restricts_heavy_settings_even_after_success(self):
        state = {"tier": {"key": "base", "ram_gb": 18},
                 "memory": {"total_gb": 18, "pressure_pct": 83, "swap_gb": 18},
                 "base_available": True, "model_integrity": {"ok": True},
                 "current": None, "queue": [], "gpu": {"busy": False},
                 "history": [{"status": "done", "params": {"mode": "i2v"}}]}
        guard = evaluate_generation_guard(state, now=time.time())
        self.assertTrue(guard["safeToSubmit"])
        self.assertTrue(guard["memoryConstrained"])
        self.assertEqual(guard["maxResolution"], 512)
        self.assertEqual(guard["maxBatch"], 1)

    def test_health_report_distinguishes_online_panel_from_incomplete_text_encoder(self):
        unfinished = {
            "active": True, "state": "downloading", "key": "gemma",
            "pending": [{"key": "gemma", "name": "Gemma text encoder", "left_gb": 3.4}],
        }
        with patch.object(MockPhosphene, "download_state", unfinished):
            status, body, _ = self._get("/local/health")
        self.assertEqual(status, 200)
        health = json.loads(body)
        self.assertTrue(health["online"])
        self.assertTrue(health["baseAvailable"])
        self.assertFalse(health["readyToGenerate"])
        self.assertEqual(health["tier"], "base")
        self.assertEqual(health["memory"]["totalGB"], 18.0)
        self.assertEqual(health["download"]["pending"][0]["name"], "Gemma text encoder")
        self.assertNotIn("model_path", health)
        self.assertNotIn("HF_TOKEN", body.decode())

    def test_health_report_marks_idle_q4_compatible_panel_ready(self):
        with patch.object(MockPhosphene, "download_state",
                          {"state": "done", "active": False, "pending": []}):
            status, body, _ = self._get("/local/health")
        self.assertEqual(status, 200)
        health = json.loads(body)
        self.assertTrue(health["readyToGenerate"])
        self.assertEqual(health["resolutionMax"], 768)

    def test_incomplete_core_text_encoder_prevents_upload_and_job_submissions(self):
        unfinished = {"active": True, "state": "downloading", "key": "gemma",
                      "pending": [{"key": "gemma", "left_gb": 2.0}]}
        before = MockPhosphene.submission_count
        body, content_type = self._form()
        with patch.object(MockPhosphene, "download_state", unfinished):
            with self.assertRaises(HTTPError) as response:
                self._post("/local/generate", body, content_type)
        self.assertEqual(response.exception.code, 503)
        self.assertEqual(MockPhosphene.submission_count, before)

    def test_personalization_settings_are_mapped_and_bounded(self):
        body, content_type = self._form(
            duration=30, orientation="portrait", quality="balanced",
            resolution="640", seed=42, camera="pan_right",
            intensity="subtle", look="cinematic",
        )
        with self._post("/local/generate", body, content_type) as response:
            self.assertEqual(response.status, 200)
        params = MockPhosphene.seen_params
        self.assertEqual(params["width"], ["352"])
        self.assertEqual(params["height"], ["640"])
        self.assertEqual(params["seed"], ["42"])
        self.assertEqual(params["take_seconds"], ["30"])
        self.assertEqual(params["quality"], ["balanced"])
        self.assertIn("pan", params["prompt"][0].lower())
        self.assertIn("cinematic", params["prompt"][0].lower())
        self.assertIn("take_camera", params)

    def test_long_take_supports_timed_storyboard_beats(self):
        beats = "Establish the landscape\nReveal the mountain\nA gentle sunrise"
        body, ctype = self._form(duration=30, camera="push_in", beats=beats)
        with self._post("/local/generate", body, ctype) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(MockPhosphene.seen_params["beats"], [beats])
        self.assertEqual(MockPhosphene.seen_params["take_seconds"], ["30"])

    def test_default_camera_does_not_override_explicit_motion_prompt(self):
        prompt = "The camera smoothly orbits the mountain at sunrise"
        body, ctype = self._form(prompt=prompt)
        with self._post("/local/generate", body, ctype) as res:
            self.assertEqual(res.status, 200)
        generated_prompt = MockPhosphene.seen_params["prompt"][0]
        self.assertIn("orbits", generated_prompt)
        self.assertNotIn("locked-off", generated_prompt)

    def test_storyboard_beats_rejected_for_short_clips_or_too_many_beats(self):
        for duration, beats in ((3, "Establish the shot"),
                                (30, "\n".join(["beat"] * 7))):
            with self.subTest(duration=duration):
                body, ctype = self._form(duration=duration, beats=beats)
                with self.assertRaises(HTTPError) as failed:
                    self._post("/local/generate", body, ctype)
                self.assertEqual(failed.exception.code, 400)

    def test_personalization_rejects_oversized_resolution_and_invalid_seed(self):
        for extras in ({"resolution": "1024"}, {"seed": "bad"},
                       {"camera": "arbitrary-code"}, {"intensity": "ultra"},
                       {"look": "invalid"}):
            with self.subTest(extras=extras):
                before = MockPhosphene.submission_count
                body, ctype = self._form(**extras)
                with self.assertRaises(HTTPError) as response:
                    self._post("/local/generate", body, ctype)
                self.assertEqual(response.exception.code, 400)
                self.assertEqual(MockPhosphene.submission_count, before)

    def test_seven_and_ten_second_clips_submit_valid_frame_counts(self):
        for duration, frames in ((7, "169"), (10, "241")):
            with self.subTest(duration=duration):
                body, content_type = self._form(duration=duration)
                with self._post("/local/generate", body, content_type) as response:
                    self.assertEqual(response.status, 200)
                self.assertEqual(MockPhosphene.seen_params["frames"], [frames])
                self.assertNotIn("take_seconds", MockPhosphene.seen_params)

    def test_long_takes_are_chained_using_official_phosphene_api(self):
        for duration in (30, 45, 60, 90, 120):
            with self.subTest(duration=duration):
                body, ctype = self._form(duration=duration)
                with self._post("/local/generate", body, ctype) as response:
                    self.assertEqual(response.status, 200)
                self.assertEqual(MockPhosphene.seen_params["take_seconds"], [str(duration)])

    def test_batch_supports_distinct_prompts_and_ids(self):
        start = len(MockPhosphene.seen_submissions)
        variations = ["Flowers blow in the wind", "Camera slowly orbits", "Clouds drift overhead"]
        body, ctype = self._form(batch=3, variants=variations)
        with self._post("/local/generate", body, ctype) as response:
            result = json.load(response)
        self.assertEqual(len(result["jobIds"]), 3)
        self.assertEqual(len(set(result["jobIds"])), 3)
        sent = [item["prompt"][0] for item in MockPhosphene.seen_submissions[start:]]
        self.assertEqual(len(sent), len(variations))
        for original, enhanced in zip(variations, sent):
            self.assertTrue(enhanced.startswith(original), enhanced)

    def test_batch_limit_rejected_without_submitting(self):
        before = MockPhosphene.submission_count
        body, ctype = self._form(batch=7)
        with self.assertRaises(HTTPError) as caught:
            self._post("/local/generate", body, ctype)
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(MockPhosphene.submission_count, before)

    def test_gif_export_from_registered_video(self):
        body, ctype = self._form()
        with self._post("/local/generate", body, ctype) as response:
            job_id = json.load(response)["jobId"]
        fake = self.root / "fake_ffmpeg"
        fake.write_text('#!/usr/bin/env python3\nimport sys\nfrom pathlib import Path\n'
                        'Path(sys.argv[-1]).write_bytes(b"GIF89a" + b"test-data")\n')
        fake.chmod(0o700)
        with patch.dict(os.environ, {"AXOM_FFMPEG": str(fake)}):
            status, data, headers = self._get("/local/gif?jobId=" + job_id +
                                              "&seconds=5&fps=12&width=480")
        self.assertEqual(status, 200)
        self.assertTrue(data.startswith(b"GIF89a"))
        self.assertEqual(headers["Content-Type"], "image/gif")
        self.assertIn("attachment", headers["Content-Disposition"])

    @unittest.skipUnless(shutil.which("ffmpeg") or os.environ.get("AXOM_FFMPEG"),
                         "FFmpeg not installed on test runner")
    def test_actual_ffmpeg_converts_synthetic_mp4_to_gif(self):
        original = MockPhosphene.result_file.read_bytes()
        try:
            subprocess.run([
                os.environ.get("AXOM_FFMPEG") or shutil.which("ffmpeg"),
                "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=24",
                "-c:v", "mpeg4", "-q:v", "5",
                str(MockPhosphene.result_file),
            ], check=True, capture_output=True)
            body, ctype = self._form()
            with self._post("/local/generate", body, ctype) as response:
                job_id = json.load(response)["jobId"]
            status, data, headers = self._get("/local/gif?jobId=" + job_id +
                                              "&seconds=3&fps=12&width=320")
            self.assertEqual(status, 200)
            self.assertEqual(data[:6], b"GIF89a")
            self.assertGreater(len(data), 1024)
        finally:
            MockPhosphene.result_file.write_bytes(original)

    def test_unknown_gif_and_invalid_settings_rejected(self):
        for suffix in ("jobId=../../secret&seconds=5", "jobId=j-not-owned&seconds=5",
                       "jobId=j-not-owned&seconds=999"):
            with self.subTest(suffix=suffix):
                with self.assertRaises(HTTPError) as caught:
                    self._get("/local/gif?" + suffix)
                self.assertIn(caught.exception.code, (400, 404))

    def test_jobs_recover_after_local_bridge_restart(self):
        body, ctype = self._form()
        with self._post("/local/generate", body, ctype) as response:
            job_id = json.load(response)["jobId"]
        state_file = self.root / ".axom-local-state" / "jobs.json"
        self.assertTrue(state_file.exists())
        with state_file.open() as record:
            self.assertIn(job_id, json.load(record))
        fresh = LocalVideoServer(("127.0.0.1", 0), LocalVideoHandler,
                                 static_root=self.site, phosphene_url=self.upstream_url)
        try:
            self.assertIn(job_id, fresh.jobs)
        finally:
            fresh.server_close()


if __name__ == "__main__":
    unittest.main()
