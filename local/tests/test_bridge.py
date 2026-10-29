"""Contract tests for the local-only Phosphene video bridge.

The mock Phosphene HTTP server uses no GPU, network account or model download.
Run: python3 -m unittest discover -s local/tests -v
"""
import io
import json
import os
from unittest.mock import patch
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs
from urllib.request import Request, urlopen

from local.bridge import LocalVideoServer, LocalVideoHandler

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
                "current": None,
                "queue": [],
                "history": [{"id": job_id, "status": "done",
                             "output_path": str(MockPhosphene.result_file),
                             "elapsed_sec": 12}
                            for job_id in MockPhosphene.job_ids],
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
              orientation="landscape", batch=1, variants=None):
        boundary = "AXOMBOUNDARY123"
        settings = json.dumps({"prompt": prompt, "duration_seconds": duration,
                               "orientation": orientation, "batch_count": batch,
                               "prompts": variants}).encode()
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

    def test_site_is_served_on_same_origin(self):
        status, body, _ = self._get("/")
        self.assertEqual(status, 200)
        self.assertIn(b"AXOM local test", body)

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
        self.assertEqual([f["prompt"][0] for f in MockPhosphene.seen_submissions[start:]], variations)

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
