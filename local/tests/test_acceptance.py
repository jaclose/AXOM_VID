"""Unit and local-network contract checks for the SSD integration acceptance tool.

These tests never download model weights, start Phosphene, or render on a GPU.
"""
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from local.acceptance import (
    choose_axom,
    choose_phosphene,
    inspect_install_state,
    make_reference_png,
    run_smoke_test,
    run_preflight,
)


class AcceptanceTests(unittest.TestCase):
    def test_detects_local_studio_on_a_fallback_port_not_an_unrelated_service(self):
        def fetch(url):
            if url.endswith("8765/local/health"):
                return {"unexpected": "other application"}
            if url.endswith("8766/local/health"):
                return {"online": True, "provider": "Phosphene LTX local"}
            return None

        result = choose_axom(fetch)
        self.assertEqual(result["url"], "http://127.0.0.1:8766")
        self.assertTrue(result["health"]["online"])

    def test_probe_reports_normal_or_dev_phosphene_port_without_guessing(self):
        def dev_only(url):
            if url.endswith("8199/status"):
                return {"running": False, "queue": [], "history": []}
            return None

        result = choose_phosphene(dev_only)
        self.assertEqual(result["url"], "http://127.0.0.1:8199")
        self.assertTrue(result["online"])

        self.assertIsNone(choose_phosphene(lambda url: None))

    def test_does_not_claim_engine_ready_while_model_download_is_active(self):
        state = inspect_install_state({
            "app_models": {"state": "downloading", "locked": True},
            "deferred_downloads": {"active": True, "state": "downloading"},
        }, {"engines": {"ltx": {"available": True}}})
        self.assertEqual(state["state"], "downloading")
        self.assertFalse(state["ready_to_test"])

    def test_reports_unavailable_or_unknown_when_model_is_not_verified(self):
        unavailable = inspect_install_state(
            {"running": False, "queue": []},
            {"engines": {"ltx": {"available": False}}},
        )
        self.assertEqual(unavailable["state"], "unavailable")
        self.assertFalse(unavailable["ready_to_test"])

        unknown = inspect_install_state({"running": False}, None)
        self.assertEqual(unknown["state"], "unknown")
        self.assertFalse(unknown["ready_to_test"])

    def test_accepts_supported_ready_ltx_options_without_download_locks(self):
        state = inspect_install_state(
            {"running": False, "deferred_downloads": {"active": False, "state": "done"}},
            {"engines": {"ltx": {"available": True}}},
        )
        self.assertEqual(state["state"], "ready")
        self.assertTrue(state["ready_to_test"])

    def test_makes_valid_512_by_288_png_without_pillow_or_external_dependency(self):
        data = make_reference_png()
        self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(data[12:16], b"IHDR")
        self.assertEqual(struct.unpack(">II", data[16:24]), (512, 288))
        self.assertTrue(data.endswith(b"IEND\xaeB\x60\x82"))
        self.assertGreater(len(data), 512)

    def test_smoke_test_submits_one_quick_three_second_job_and_exports_on_ssd(self):
        with tempfile.TemporaryDirectory() as base:
            root = Path(base)
            calls = []
            mp4 = b"\x00\x00\x00\x18ftypmp42" + b"0" * 100

            def request(method, url, body=None, content_type=None):
                calls.append((method, url, body, content_type))
                if url.endswith("/local/generate"):
                    assert method == "POST"
                    assert b'"duration_seconds": 3' in body
                    assert b'"quality": "quick"' in body
                    assert b"image/png" in body
                    return {"jobId": "j-smoke-0001"}
                if "/local/status?" in url:
                    return {"status": "done", "videoUrl": "/local/video?jobId=j-smoke-0001"}
                raise AssertionError("Unexpected JSON endpoint: " + url)

            def media(url, target, limit):
                target.write_bytes(mp4 if "/local/video?" in url else b"GIF89a" + b"1" * 100)
                return target.stat().st_size

            with patch("local.acceptance.validate_mp4", return_value=(True, "validated")):
                report = run_smoke_test(
                    "http://127.0.0.1:8765", root,
                    max_wait_seconds=5, request_json=request, download=media,
                    sleep=lambda seconds: None,
                )
            self.assertTrue(report["passed"])
            self.assertTrue((root / "smoke-video.mp4").exists())
            self.assertTrue((root / "smoke-video.gif").exists())
            self.assertTrue((root / "acceptance-result.json").exists())
            self.assertEqual(len([c for c in calls if c[0] == "POST"]), 1)

    def test_preflight_blocks_gpu_test_while_another_local_job_is_active(self):
        def fetch(url):
            if url.endswith(":8765/local/health"):
                return {"online": True, "provider": "Phosphene LTX local"}
            if url.endswith(":8198/status"):
                return {
                    "running": True, "current": {"id": "j-comfy-ongoing"},
                    "queue": [{"id": "j-someone-else"}],
                    "gpu": {"busy": True, "holder": "queue"},
                    "deferred_downloads": {"active": False, "state": "done"},
                }
            if url.endswith(":8198/oneshot/options"):
                return {"engines": {"ltx": {"available": True}}}
            return None
        report = run_preflight(fetch)
        self.assertTrue(report["model"]["ready_to_test"])
        self.assertTrue(report["local_gpu_busy"])
        self.assertFalse(report["ready_to_render"])

    def test_preflight_can_accept_idle_model_without_other_jobs(self):
        def fetch(url):
            if url.endswith(":8765/local/health"):
                return {"online": True, "provider": "Phosphene LTX local"}
            if url.endswith(":8198/status"):
                return {"running": False, "current": None, "queue": [],
                        "gpu": {"busy": False},
                        "deferred_downloads": {"active": False, "state": "done"}}
            if url.endswith(":8198/oneshot/options"):
                return {"engines": {"ltx": {"available": True}}}
            if url.endswith(":8188/system_stats"):
                return {"system": {"os": "posix"}}
            return None
        report = run_preflight(fetch)
        self.assertTrue(report["ready_to_render"])
        self.assertTrue(report["comfyui_http_responsive"])
        self.assertFalse(report["local_gpu_busy"])

    def test_render_mode_rejects_a_non_studio_local_port(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                run_smoke_test("http://127.0.0.1:8188", Path(directory), max_wait_seconds=5)

    def test_smoke_test_does_not_claim_success_for_an_invalid_mp4(self):
        with tempfile.TemporaryDirectory() as base:
            root = Path(base)
            def request(method, url, body=None, content_type=None):
                if url.endswith("/local/generate"):
                    return {"jobId": "j-smoke-0002"}
                if "/local/status?" in url:
                    return {"status": "done"}
                return None
            def media(url, target, limit):
                target.write_bytes(b"not an mp4")
                return target.stat().st_size

            report = run_smoke_test(
                "http://127.0.0.1:8765", root, max_wait_seconds=5,
                request_json=request, download=media, sleep=lambda seconds: None,
            )
            self.assertFalse(report["passed"])


if __name__ == "__main__":
    unittest.main()
