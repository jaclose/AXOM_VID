#!/usr/bin/env python3
"""AXOM_VID free local image-to-video bridge (standard library only).

The bridge runs on loopback, serves the already-built Astro frontend, and
talks solely to the locally running Phosphene panel. It has no paid API keys,
cloud inference calls, or daily account quota.

Phosphene API: https://github.com/mrbizarro/Phosphene/blob/main/docs/API.md
"""
from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
from email import policy
from email.parser import BytesParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_UPLOAD_BYTES = MAX_IMAGE_BYTES + 32 * 1024
MAX_PROMPT = 1200
ALLOWED_DURATIONS = (3, 5, 7, 10, 30, 45, 60, 90, 120)
LONG_TAKES = (30, 45, 60, 90, 120)
MAX_BATCH = 6
DEFAULT_PHOSPHENE_URL = "http://127.0.0.1:8198"
RESOLUTION_SIZES = {"512": (512, 288), "640": (640, 352), "704": (704, 384)}
CAMERA_MOVES = {
    "steady": ("steady, locked-off camera", "a steady locked-off camera"),
    "push_in": ("slow cinematic dolly push-in", "a smooth continuous dolly push forward"),
    "pull_back": ("slow dolly pull-back", "a steady pull-back at one speed"),
    "pan_left": ("smooth camera pan left", "a smooth continuous pan left"),
    "pan_right": ("smooth camera pan right", "a smooth continuous pan right"),
    "orbit": ("smooth slow camera orbit", "a continuous slow orbit around the subject"),
    "tracking": ("steady tracking camera movement", "steady continuous tracking movement"),
    "tilt_up": ("gentle camera tilt up", "a gentle continuous tilt up"),
}
MOTION_LEVELS = {
    "subtle": "very gentle motion with stable framing and consistent details",
    "natural": "natural fluid movement with temporal consistency",
    "dynamic": "expressive cinematic movement with coherent physical motion",
}
VISUAL_LOOKS = {
    "original": "preserve the original image's visual style",
    "cinematic": "cinematic lighting, refined color grade and believable image detail",
    "documentary": "natural documentary footage, restrained realistic camera",
    "illustrated": "polished illustrated animation with stable character design",
    "product": "clean professional product showcase lighting and smooth presentation",
}


def summarize_panel_status(state: dict[str, Any]) -> dict[str, Any]:
    """Browser-safe capabilities from the local panel; no private paths."""
    deferred = state.get("deferred_downloads")
    deferred = deferred if isinstance(deferred, dict) else {}
    pending = deferred.get("pending", [])
    pending = pending if isinstance(pending, list) else []
    items: list[dict[str, Any]] = []
    for item in pending[:15]:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key", ""))[:48]
        name = str(item.get("name", key))[:90]
        left = item.get("left_gb")
        items.append({"key": key, "name": name,
                      "leftGB": round(left, 2) if isinstance(left, (float, int))
                      and not isinstance(left, bool) else None})
    downloading_gemma = (
        deferred.get("active") is True and deferred.get("key") == "gemma"
        or any(item["key"] == "gemma" for item in items)
    )
    tier = state.get("tier")
    tier = tier if isinstance(tier, dict) else {}
    memory = state.get("memory")
    memory = memory if isinstance(memory, dict) else {}
    integrity = state.get("model_integrity")
    integrity = integrity if isinstance(integrity, dict) else {}
    env = state.get("engine_env")
    env = env if isinstance(env, dict) else {}
    base = state.get("base_available") is True
    quality = integrity.get("ok") is True
    healthy = env.get("ok") is not False
    busy = isinstance(state.get("current"), dict)
    queue = state.get("queue", [])
    queued = len(queue) if isinstance(queue, list) else 0
    gpu = state.get("gpu")
    gpu = gpu if isinstance(gpu, dict) else {}
    model_ready = base and quality and healthy and not downloading_gemma
    max_dim = tier.get("i2v_max_dim")
    if not isinstance(max_dim, int) or not (256 <= max_dim <= 8192):
        max_dim = 512
    return {
        "online": True,
        "provider": "Phosphene LTX local",
        "baseAvailable": base,
        "modelIntegrityOK": quality,
        "readyToGenerate": model_ready,
        "download": {
            "active": deferred.get("active") is True,
            "state": str(deferred.get("state", "unknown"))[:40],
            "gemmaPending": downloading_gemma,
            "pending": items,
        },
        "memory": {
            "totalGB": memory.get("total_gb"),
            "pressurePercent": memory.get("pressure_pct"),
            "swapGB": memory.get("swap_gb"),
        },
        "tier": str(tier.get("key", "unknown"))[:50],
        "resolutionMax": max_dim,
        "availableQualities": ["quick", "balanced"],
        "busy": busy or gpu.get("busy") is True,
        "queued": queued,
    }


def composed_prompt(prompt: str, settings: dict[str, Any]) -> str:
    extras = [
        CAMERA_MOVES[settings.get("camera", "steady")][0],
        MOTION_LEVELS[settings.get("intensity", "natural")],
        VISUAL_LOOKS[settings.get("look", "original")],
    ]
    # Keep source prompt unchanged and explicit, append grounded controllable
    # motion cues; the prompt encoder, not a separate imaginary slider,
    # interprets these text instructions.
    result = prompt.strip() + ". " + ". ".join(extras) + "."
    if len(result) > MAX_PROMPT:
        raise BridgeFailure("Shorten the prompt to make room for creative direction.", 400)
    return result


ALLOWED_IMAGE_TYPES = {
    "image/png": (b"\x89PNG\r\n\x1a\n", "png"),
    "image/jpeg": (b"\xff\xd8\xff", "jpg"),
    "image/webp": (b"RIFF", "webp"),
}


class BridgeFailure(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _json_response_from_upstream(
    base_url: str, route: str, *, body: bytes | None = None,
    content_type: str | None = None,
) -> dict[str, Any]:
    headers: dict[str, str] = {}
    if content_type:
        headers["Content-Type"] = content_type
    req = Request(base_url + route, data=body, headers=headers,
                  method="POST" if body is not None else "GET")
    try:
        with urlopen(req, timeout=30) as response:
            data = response.read(8 * 1024 * 1024 + 1)
            if len(data) > 8 * 1024 * 1024:
                raise BridgeFailure("Local engine returned an oversized response.")
    except HTTPError as err:
        try:
            payload = json.loads(err.read(4096))
            message = payload.get("error", "Local engine request failed")
            if not isinstance(message, str):
                message = "Local engine request failed"
        except (ValueError, UnicodeError):
            message = "Local engine returned HTTP " + str(err.code)
        raise BridgeFailure(message[:500], err.code) from err
    except (OSError, URLError) as err:
        raise BridgeFailure(
            "Phosphene is not running. Open Pinokio, start Phosphene, "
            "and open its panel at http://127.0.0.1:8198.", 503,
        ) from err

    try:
        result = json.loads(data)
    except (ValueError, UnicodeError) as err:
        raise BridgeFailure("Local engine returned invalid JSON.") from err
    if not isinstance(result, dict):
        raise BridgeFailure("Local engine returned an unexpected response.")
    return result


def parse_form(data: bytes, content_type: str) -> tuple[bytes, str, dict[str, Any]]:
    if not content_type.lower().startswith("multipart/form-data;") or "\n" in content_type:
        raise BridgeFailure("Expected multipart image upload.", 415)
    preamble = ("MIME-Version: 1.0\r\nContent-Type: " + content_type +
                "\r\n\r\n").encode("ascii", errors="strict")
    message = BytesParser(policy=policy.default).parsebytes(preamble + data)
    if not message.is_multipart():
        raise BridgeFailure("Invalid multipart form.", 400)
    parts: dict[str, tuple[bytes, str]] = {}
    for part in message.iter_parts():
        if part.get_content_disposition() != "form-data":
            continue
        name = part.get_param("name", header="Content-Disposition")
        if name not in ("image", "params") or name in parts:
            raise BridgeFailure("Unexpected or duplicate form field.", 400)
        content = part.get_payload(decode=True)
        if not isinstance(content, bytes):
            raise BridgeFailure("Invalid upload field.", 400)
        parts[name] = (content, part.get_content_type())

    if "image" not in parts or "params" not in parts:
        raise BridgeFailure("Choose an image and enter a motion prompt.", 400)
    image, mime = parts["image"]
    if not (0 < len(image) <= MAX_IMAGE_BYTES):
        raise BridgeFailure("Image must be between 1 byte and 8 MB.", 413)
    marker = ALLOWED_IMAGE_TYPES.get(mime)
    if marker is None or not image.startswith(marker[0]):
        raise BridgeFailure("Use a valid PNG, JPG or WEBP image.", 415)
    if mime == "image/webp" and image[8:12] != b"WEBP":
        raise BridgeFailure("Invalid WEBP image.", 415)
    try:
        settings = json.loads(parts["params"][0])
    except (ValueError, UnicodeError) as err:
        raise BridgeFailure("Invalid generation settings.", 400) from err
    if not isinstance(settings, dict):
        raise BridgeFailure("Invalid generation settings.", 400)
    prompt = settings.get("prompt")
    if not isinstance(prompt, str) or not (1 <= len(prompt.strip()) <= MAX_PROMPT):
        raise BridgeFailure("Enter a motion prompt of 1 to 1,200 characters.", 400)
    seconds = settings.get("duration_seconds")
    if seconds not in ALLOWED_DURATIONS or isinstance(seconds, bool):
        raise BridgeFailure("Duration must be 3, 5, 7, 10, 30, 45, 60, 90 or 120 seconds.", 400)
    if settings.get("orientation") not in ("landscape", "portrait"):
        raise BridgeFailure("Choose portrait or landscape orientation.", 400)
    count = settings.get("batch_count", 1)
    if isinstance(count, bool) or not isinstance(count, int) or not (1 <= count <= MAX_BATCH):
        raise BridgeFailure("Batch size must be an integer from 1 to 6.", 400)
    prompts = settings.get("prompts")
    if prompts is not None:
        if not isinstance(prompts, list) or len(prompts) != count:
            raise BridgeFailure("Provide exactly one motion prompt for each batch render.", 400)
        if any(not isinstance(p, str) or not (1 <= len(p.strip()) <= MAX_PROMPT) for p in prompts):
            raise BridgeFailure("Each batch prompt must contain 1–1,200 characters.", 400)
    quality = settings.get("quality", "quick")
    if quality not in ("quick", "balanced"):
        raise BridgeFailure("Local quality must be quick or balanced.", 400)
    if str(settings.get("resolution", "512")) not in RESOLUTION_SIZES:
        raise BridgeFailure("Select a supported local resolution.", 400)
    for name, allowed in (("camera", CAMERA_MOVES),
                          ("intensity", MOTION_LEVELS), ("look", VISUAL_LOOKS)):
        value = settings.get(name, {
            "camera": "steady", "intensity": "natural", "look": "original",
        }[name])
        if not isinstance(value, str) or value not in allowed:
            raise BridgeFailure(f"Unsupported {name} option.", 400)
    seed = settings.get("seed", -1)
    if not isinstance(seed, int) or isinstance(seed, bool) or not (-1 <= seed < 2**31 - MAX_BATCH):
        raise BridgeFailure("Seed must be -1 (random) or a number from 0 to 2147483640.", 400)
    for text in (settings.get("prompts") or [prompt]):
        composed_prompt(text, settings)
    return image, mime, settings


def multipart_image(image: bytes, mime: str) -> tuple[bytes, str]:
    boundary = "AXOM" + secrets.token_hex(16)
    ext = ALLOWED_IMAGE_TYPES[mime][1]
    raw = (
        ("--" + boundary + "\r\n"
         'Content-Disposition: form-data; name="image"; filename="source.' + ext + '"\r\n'
         "Content-Type: " + mime + "\r\n\r\n").encode()
        + image + ("\r\n--" + boundary + "--\r\n").encode()
    )
    return raw, "multipart/form-data; boundary=" + boundary


def find_job(status: dict[str, Any], job_id: str) -> dict[str, Any] | None:
    for key in ("current", "queue", "history"):
        value = status.get(key)
        if isinstance(value, dict):
            value = [value]
        if not isinstance(value, list):
            continue
        for job in value:
            if isinstance(job, dict) and job.get("id") == job_id:
                return job
    return None


def safe_video_path(job: dict[str, Any]) -> Path | None:
    raw = job.get("output_path")
    if not isinstance(raw, str):
        return None
    path = Path(raw)
    # Only Phosphene-generated MP4s under its owned output directory.
    if not path.is_absolute() or "mlx_outputs" not in path.parts or path.suffix.lower() != ".mp4":
        return None
    try:
        # Pinokio may symlink mlx_outputs to an external SSD. Resolve the
        # expected output directory and require the file to remain inside it.
        idx = path.parts.index("mlx_outputs")
        outputs_root = Path(*path.parts[:idx + 1]).resolve(strict=True)
        resolved = path.resolve(strict=True)
        if not resolved.is_file() or not resolved.is_relative_to(outputs_root):
            return None
        return resolved
    except (OSError, ValueError):
        return None


class LocalVideoServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self, server_address: tuple[str, int], handler: type[LocalVideoHandler],
        *, static_root: Path, phosphene_url: str = DEFAULT_PHOSPHENE_URL,
    ):
        url = urlsplit(phosphene_url)
        if (url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost")
                or url.username or url.password or url.path not in ("", "/")
                or url.query or url.fragment):
            raise ValueError("Phosphene URL must be an HTTP loopback server.")
        self.phosphene_url = phosphene_url.rstrip("/")
        self.static_root = Path(static_root).resolve()
        self.state_file = self.static_root.parent / ".axom-local-state" / "jobs.json"
        self.jobs: dict[str, float] = {}
        self.job_lock = threading.Lock()
        self.gif_lock = threading.Lock()
        try:
            payload = json.loads(self.state_file.read_text(encoding="utf-8"))
            if isinstance(payload, dict):
                for job_id, timestamp in payload.items():
                    if (isinstance(job_id, str) and re.fullmatch(r"j-[a-zA-Z0-9-]{1,100}", job_id)
                            and isinstance(timestamp, (int, float)) and not isinstance(timestamp, bool)
                            and 0 < timestamp < time.time() + 3600):
                        self.jobs[job_id] = float(timestamp)
        except (OSError, ValueError):
            pass  # First launch / corrupt file: stay local and begin a new session.
        super().__init__(server_address, handler)

    def remember_job(self, job_id: str) -> None:
        with self.job_lock:
            self.jobs[job_id] = time.time()
            # Keep a bounded list (30 days) on the owner's disk, not an online account.
            cutoff = time.time() - 30 * 86400
            self.jobs = {key: ts for key, ts in self.jobs.items() if ts > cutoff}
            if len(self.jobs) > 500:
                self.jobs = dict(sorted(self.jobs.items(), key=lambda row: row[1])[-500:])
            tmp_path: Path | None = None
            try:
                self.state_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with tempfile.NamedTemporaryFile(
                    mode="w", encoding="utf-8", dir=self.state_file.parent,
                    prefix=".jobs-", suffix=".tmp", delete=False,
                ) as output:
                    tmp_path = Path(output.name)
                    os.chmod(tmp_path, 0o600)
                    json.dump(self.jobs, output)
                tmp_path.replace(self.state_file)
            except OSError:
                # The GPU job has already been queued: never misreport failure
                # just because the drive is temporarily read-only.
                if tmp_path is not None:
                    tmp_path.unlink(missing_ok=True)


class LocalVideoHandler(SimpleHTTPRequestHandler):
    server: LocalVideoServer

    def __init__(self, *args: Any, **kwargs: Any):
        # Files are always served from web/dist, never from a personal folder.
        super().__init__(*args, directory=str(args[2].static_root), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        # Never log image bytes or prompts.
        super().log_message(format, *args)

    def _json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _fail(self, message: str, status: int) -> None:
        self._json({"error": message}, status)

    def _allowed_request(self) -> bool:
        # A local service should never be accessible through DNS rebinding
        # or writable from a hostile website's cross-origin form submission.
        expected_port = self.server.server_port
        host = self.headers.get("Host", "")
        if host not in (f"127.0.0.1:{expected_port}", f"localhost:{expected_port}"):
            self._fail("Only localhost may open the local video studio.", 403)
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in (
            f"http://127.0.0.1:{expected_port}", f"http://localhost:{expected_port}"
        ):
            self._fail("Another website cannot submit local GPU jobs.", 403)
            return False
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            self._fail("Cross-site access to the local GPU is blocked.", 403)
            return False
        return True

    def translate_path(self, path: str) -> str:
        # Production Astro bundles live under /AXOM_VID/ for GitHub Pages.
        # Serve the same files locally without rebuilding a second bundle.
        url_path = urlsplit(path).path
        if url_path in ("/AXOM_VID", "/AXOM_VID/"):
            path = "/"
        elif url_path.startswith("/AXOM_VID/"):
            path = url_path[len("/AXOM_VID"):]
        return super().translate_path(path)

    def do_OPTIONS(self) -> None:
        # No cross-origin API is offered. The local app calls its own origin.
        self._fail("Use the local studio at http://127.0.0.1:8765.", 403)

    def do_GET(self) -> None:
        if not self._allowed_request():
            return
        route = urlsplit(self.path)
        try:
            if route.path == "/local/health":
                try:
                    status = _json_response_from_upstream(self.server.phosphene_url, "/status")
                    self._json({
                        "online": True,
                        "busy": isinstance(status.get("current"), dict),
                        "queued": len(status.get("queue", [])) if isinstance(status.get("queue"), list) else 0,
                        "provider": "Phosphene LTX local",
                    })
                except BridgeFailure as err:
                    self._json({"online": False, "error": str(err)})
                return
            if route.path == "/local/status":
                self._handle_status(parse_qs(route.query).get("jobId", [""])[0])
                return
            if route.path == "/local/gif":
                self._handle_gif(parse_qs(route.query))
                return
            if route.path == "/local/video":
                self._handle_video(
                    parse_qs(route.query).get("jobId", [""])[0],
                    parse_qs(route.query).get("download", [""])[0] == "1",
                )
                return
            if route.path.startswith("/local/"):
                self._fail("Local endpoint not found.", 404)
                return
            if not (self.server.static_root / "index.html").exists():
                self._fail("Website not built. Run local/start.command from the repository.", 503)
                return
            return super().do_GET()
        except BridgeFailure as err:
            self._fail(str(err), err.status)

    def do_POST(self) -> None:
        if not self._allowed_request():
            return
        if urlsplit(self.path).path != "/local/generate":
            self._fail("Local endpoint not found.", 404)
            return
        try:
            raw_length = self.headers.get("Content-Length", "")
            if not raw_length.isdecimal():
                raise BridgeFailure("Upload is missing a valid size.", 400)
            length = int(raw_length)
            if length > MAX_UPLOAD_BYTES:
                raise BridgeFailure("Image upload is over 8 MB.", 413)
            if length <= 0:
                raise BridgeFailure("Empty upload.", 400)
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise BridgeFailure("Image upload was incomplete.", 400)
            image, mime, settings = parse_form(raw, self.headers.get("Content-Type", ""))
            upload_body, upload_type = multipart_image(image, mime)
            uploaded = _json_response_from_upstream(
                self.server.phosphene_url, "/upload", body=upload_body,
                content_type=upload_type,
            )
            image_path = uploaded.get("path")
            if (not isinstance(image_path, str) or not Path(image_path).is_absolute()
                    or "panel_uploads" not in Path(image_path).parts):
                raise BridgeFailure("Phosphene did not accept the reference image.")

            portrait = settings["orientation"] == "portrait"
            seconds = settings["duration_seconds"]
            count = settings.get("batch_count", 1)
            prompts = settings.get("prompts") or [settings["prompt"].strip()] * count
            args = {
                "mode": "i2v",
                "engine": "ltx",
                "image": image_path,
                "width": "288" if portrait else "512",
                "height": "512" if portrait else "288",
                # 30-120 second takes are chained in Phosphene, one 10s part
                # at a time; this avoids requesting an impossible single pass.
                "frames": str(241 if seconds in LONG_TAKES else seconds * 24 + 1),
                "frame_rate": "24",
                "steps": "8",
                "seed": "-1",
                "quality": settings.get("quality", "quick"),
                "temporal_mode": "native",
                "upscale": "off",
                "enhance": "false",
                "open_when_done": "off",
            }
            if seconds in LONG_TAKES:
                args["take_seconds"] = str(seconds)

            job_ids: list[str] = []
            warning: str | None = None
            for index, prompt in enumerate(prompts, start=1):
                one_job = dict(args)
                one_job["prompt"] = prompt.strip()
                one_job["label"] = f"AXOM_VID · {seconds}s · render {index} of {count}"
                try:
                    queued = _json_response_from_upstream(
                        self.server.phosphene_url, "/queue/add",
                        body=urlencode(one_job).encode(),
                        content_type="application/x-www-form-urlencoded",
                    )
                    job_id = queued.get("id")
                    if (not queued.get("ok") or not isinstance(job_id, str)
                            or not re.fullmatch(r"j-[a-zA-Z0-9-]{1,100}", job_id)):
                        raise BridgeFailure("Phosphene did not return a valid job ID.")
                except BridgeFailure as err:
                    if not job_ids:
                        raise
                    warning = f"{len(job_ids)} of {count} renders queued. Remaining requests were not accepted: {err}"
                    break
                self.server.remember_job(job_id)
                job_ids.append(job_id)
            payload: dict[str, Any] = {
                "jobId": job_ids[0],
                "jobIds": job_ids,
                "status": "queued",
                "requested": count,
                "accepted": len(job_ids),
            }
            if warning:
                payload["warning"] = warning
            self._json(payload)
        except BridgeFailure as err:
            self._fail(str(err), err.status)
        except (UnicodeError, ValueError) as err:
            self._fail("The local upload could not be processed.", 400)

    def _known_job(self, job_id: str) -> None:
        with self.server.job_lock:
            known = job_id in self.server.jobs
        if not known:
            raise BridgeFailure("This job is not part of the current local studio session.", 404)

    def _get_job(self, job_id: str) -> dict[str, Any] | None:
        self._known_job(job_id)
        state = _json_response_from_upstream(self.server.phosphene_url, "/status")
        return find_job(state, job_id)

    def _handle_status(self, job_id: str) -> None:
        job = self._get_job(job_id)
        if job is None:
            self._json({"status": "queued", "message": "Waiting for the local GPU queue."})
            return
        kind = job.get("status")
        if kind not in ("queued", "running", "done", "failed", "cancelled", "stopped", "error"):
            kind = "queued"
        out: dict[str, Any] = {"status": kind}
        progress = job.get("progress")
        if isinstance(progress, dict):
            value = progress.get("pct")
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                out["progress"] = max(0, min(100, round(value)))
            label = progress.get("phase_label")
            if isinstance(label, str):
                out["message"] = label[:200]
        if kind == "done":
            if safe_video_path(job):
                out["videoUrl"] = "/local/video?jobId=" + job_id
            else:
                out = {"status": "error", "error": "Render finished but MP4 output was not found."}
        elif kind in ("failed", "cancelled", "stopped", "error"):
            error = job.get("error")
            out["error"] = error[:400] if isinstance(error, str) else "Local render stopped."
        self._json(out)

    def _handle_gif(self, query: dict[str, list[str]]) -> None:
        job_id = query.get("jobId", [""])[0]
        # Reject unregistered jobs before any file access or subprocess invocation.
        self._known_job(job_id)
        try:
            seconds = int(query.get("seconds", ["10"])[0])
            fps = int(query.get("fps", ["12"])[0])
            width = int(query.get("width", ["480"])[0])
        except (ValueError, IndexError):
            raise BridgeFailure("Invalid GIF export options.", 400)
        if seconds not in (3, 5, 10, 15) or fps not in (8, 12, 15) or width not in (320, 480, 640):
            raise BridgeFailure("GIF duration, frame rate, or width is unsupported.", 400)
        job = self._get_job(job_id)
        if job is None or job.get("status") != "done":
            raise BridgeFailure("Finish the video before exporting a GIF.", 409)
        source = safe_video_path(job)
        if source is None:
            raise BridgeFailure("The video file is missing or is outside the owned output directory.", 404)

        ffmpeg = os.environ.get("AXOM_FFMPEG") or shutil.which("ffmpeg")
        if not ffmpeg or not os.access(ffmpeg, os.X_OK):
            raise BridgeFailure(
                "FFmpeg is required for GIF downloads. Put FFmpeg on the external SSD "
                "and set AXOM_FFMPEG to its executable path before launching the studio.", 503
            )
        sig = hashlib.sha256(
            f"{job_id}:{source.stat().st_mtime_ns}:{seconds}:{fps}:{width}".encode()
        ).hexdigest()[:24]
        cache_dir = self.server.state_file.parent / "gifs"
        cache_path = cache_dir / (sig + ".gif")
        with self.server.gif_lock:
            if not cache_path.is_file():
                try:
                    cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
                except OSError as err:
                    raise BridgeFailure("GIF cache is not writable. Check the SSD.", 507) from err
                with tempfile.NamedTemporaryFile(
                    dir=cache_dir, prefix=".gif-", suffix=".gif", delete=False,
                ) as staging:
                    temp_path = Path(staging.name)
                try:
                    filters = (
                        f"fps={fps},scale={width}:-2:flags=lanczos,split[palettein][gifin];"
                        "[palettein]palettegen=stats_mode=diff[palette];"
                        "[gifin][palette]paletteuse=dither=bayer:bayer_scale=3"
                    )
                    result = subprocess.run(
                        [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                         "-threads", "2", "-t", str(seconds), "-i", str(source),
                         "-filter_complex", filters, "-loop", "0", "-an",
                         "-f", "gif", str(temp_path)],
                        capture_output=True, timeout=600, check=False,
                    )
                    if result.returncode != 0 or not temp_path.is_file() or temp_path.stat().st_size < 6:
                        raise BridgeFailure(
                            "FFmpeg could not convert this MP4 to GIF. Check the video and SSD space.", 502
                        )
                    with temp_path.open("rb") as gif:
                        if gif.read(6) not in (b"GIF89a", b"GIF87a"):
                            raise BridgeFailure("FFmpeg returned a file that was not a valid GIF.", 502)
                    temp_path.replace(cache_path)
                except subprocess.TimeoutExpired as err:
                    raise BridgeFailure("GIF conversion exceeded ten minutes. Select a shorter GIF.", 504) from err
                except OSError as err:
                    raise BridgeFailure("Unable to write the GIF to the SSD.", 507) from err
                finally:
                    temp_path.unlink(missing_ok=True)

        size = cache_path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", "image/gif")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", f'attachment; filename="axom-{job_id[:24]}.gif"')
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        with cache_path.open("rb") as gif:
            while chunk := gif.read(256 * 1024):
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break

    def _handle_video(self, job_id: str, download: bool) -> None:
        job = self._get_job(job_id)
        if job is None or job.get("status") != "done":
            raise BridgeFailure("Video is not complete.", 409)
        path = safe_video_path(job)
        if path is None:
            raise BridgeFailure("The generated MP4 cannot be found.", 404)
        size = path.stat().st_size
        first, last = 0, size - 1
        partial = False
        requested = self.headers.get("Range")
        if requested:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested)
            if not match or not (match.group(1) or match.group(2)):
                raise BridgeFailure("Unsupported byte range.", 416)
            if match.group(1):
                first = int(match.group(1))
                last = int(match.group(2)) if match.group(2) else size - 1
            else:
                suffix = int(match.group(2))
                if suffix <= 0:
                    raise BridgeFailure("Invalid byte range.", 416)
                first = max(0, size - suffix)
            if first >= size or first > last:
                raise BridgeFailure("Byte range is outside the video.", 416)
            last = min(last, size - 1)
            partial = True
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(last - first + 1))
        if partial:
            self.send_header("Content-Range", f"bytes {first}-{last}/{size}")
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if download:
            self.send_header("Content-Disposition", 'attachment; filename="axom-local.mp4"')
        self.end_headers()
        with path.open("rb") as source:
            source.seek(first)
            remaining = last - first + 1
            while remaining > 0:
                chunk = source.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                remaining -= len(chunk)

def create_server_with_fallback(
    *, start_port: int, attempts: int, static_root: Path,
    phosphene_url: str = DEFAULT_PHOSPHENE_URL,
) -> LocalVideoServer:
    """Bind the first available loopback port without affecting other services.

    Only EADDRINUSE can trigger a fallback. Do not hide permissions, invalid
    configuration, or other genuine startup failures by scanning more ports.
    The CLI restricts fallback to the ports supported by the local frontend.
    """
    if not (1 <= start_port <= 65535) or not (1 <= attempts <= 16):
        raise ValueError("Invalid local port range.")
    last_error: OSError | None = None
    for port in range(start_port, min(65536, start_port + attempts)):
        try:
            return LocalVideoServer(
                ("127.0.0.1", port), LocalVideoHandler,
                static_root=static_root, phosphene_url=phosphene_url,
            )
        except OSError as error:
            if error.errno != errno.EADDRINUSE:
                raise
            last_error = error
    raise OSError(
        errno.EADDRINUSE,
        f"All AXOM_VID loopback ports {start_port}–{start_port + attempts - 1} are in use.",
    ) from last_error


def main() -> None:
    parser = argparse.ArgumentParser(description="Run AXOM_VID with no metered cloud GPU.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--phosphene", default=os.getenv("PHOSPHENE_URL", DEFAULT_PHOSPHENE_URL))
    parser.add_argument("--open", action="store_true", help="Open the local studio in a browser.")
    args = parser.parse_args()
    if not (8765 <= args.port <= 8775):
        parser.error("Local studio ports must be in the range 8765–8775.")

    root = Path(__file__).resolve().parent.parent / "web" / "dist"
    try:
        server = create_server_with_fallback(
            start_port=args.port, attempts=8776 - args.port,
            static_root=root, phosphene_url=args.phosphene,
        )
    except OSError as error:
        if error.errno == errno.EADDRINUSE:
            parser.exit(
                2,
                "AXOM_VID cannot start: all local ports 8765–8775 are occupied.\n"
                "Inspect existing listeners with: lsof -nP -iTCP -sTCP:LISTEN\n"
                "Do not terminate an unknown process.\n",
            )
        raise
    address = f"http://127.0.0.1:{server.server_port}"
    if server.server_port != args.port:
        print(
            f"Port {args.port} is in use by another application; "
            f"AXOM_VID selected {server.server_port} instead.",
            flush=True,
        )
    print("AXOM_VID Local Studio: " + address + "/AXOM_VID/", flush=True)
    print("No cloud GPU quota, no paid API key. Phosphene must be running on localhost:8198.", flush=True)
    if args.open:
        import webbrowser
        webbrowser.open(address + "/AXOM_VID/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nLocal studio stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
