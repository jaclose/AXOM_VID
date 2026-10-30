#!/usr/bin/env python3
"""Verify SSD-based AXOM_VID / Phosphene integration without touching installers.

Default mode only probes loopback services and writes a small local report.
Explicit --render mode queues ONE 3-second Quick test on the owner's Mac,
downloads the MP4 and GIF to this checkout on the external SSD, and decodes
the MP4 with local FFmpeg tools. No cloud GPU, token, model download, or
changes to running ComfyUI/Phosphene installations.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import shutil
import struct
import subprocess
import sys
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_REPORT_DIR = ROOT / "local" / "reports"
AXOM_PORTS = tuple(range(8765, 8776))
PHOSPHENE_PORTS = (8198, 8199)
MAX_DOWNLOAD_BYTES = 700 * 1024 * 1024
MAX_GIF_BYTES = 64 * 1024 * 1024

JSON_GETTER = Callable[[str], dict[str, Any] | None]
JSON_REQUEST = Callable[..., dict[str, Any]]
MEDIA_DOWNLOADER = Callable[[str, Path, int], int]


class AcceptanceError(Exception):
    """Local runtime is missing, or an acceptance check failed."""


def get_json(url: str) -> dict[str, Any] | None:
    """Read a short JSON response from local loopback only."""
    if not safe_loopback_url(url):
        return None
    try:
        with urlopen(Request(url, headers={"Accept": "application/json"}), timeout=5) as res:
            if res.status != 200:
                return None
            raw = res.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                return None
            obj = json.loads(raw)
            return obj if isinstance(obj, dict) else None
    except (OSError, HTTPError, URLError, ValueError, UnicodeError):
        return None


def safe_loopback_url(url: str) -> bool:
    try:
        parsed = urlsplit(url)
        return (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")
                and parsed.username is None and parsed.password is None
                and parsed.port is not None
                and parsed.port in (*PHOSPHENE_PORTS, *AXOM_PORTS, 8188, 8189, 8788)
                and not parsed.fragment)
    except ValueError:
        return False


def choose_axom(fetch: JSON_GETTER = get_json) -> dict[str, Any] | None:
    """Find the AXOM_VID loopback bridge, including a fallback port."""
    for port in AXOM_PORTS:
        base = f"http://127.0.0.1:{port}"
        health = fetch(base + "/local/health")
        if not isinstance(health, dict):
            continue
        if not isinstance(health.get("online"), bool):
            continue
        if health.get("provider") != "Phosphene LTX local" and "error" not in health:
            continue
        return {"url": base, "health": health}
    return None


def choose_phosphene(fetch: JSON_GETTER = get_json) -> dict[str, Any] | None:
    """Find normal (8198) or DEV (8199) Phosphene panel via its status schema."""
    for port in PHOSPHENE_PORTS:
        base = f"http://127.0.0.1:{port}"
        status = fetch(base + "/status")
        if not isinstance(status, dict):
            continue
        if not any(key in status for key in ("running", "queue", "history", "deferred_downloads")):
            continue
        return {"url": base, "online": True, "status": status}
    return None


def inspect_install_state(
    status: dict[str, Any],
    options: dict[str, Any] | None,
) -> dict[str, Any]:
    """Conservatively evaluate availability, without reading incomplete weights.

    A reachable HTTP panel does not prove a usable LTX model. It may be serving
    the installer while large .part files continue to be written to the SSD.
    """
    deferred = status.get("deferred_downloads")
    deferred = deferred if isinstance(deferred, dict) else {}
    models = status.get("app_models")
    models = models if isinstance(models, dict) else {}

    downloading = (
        models.get("locked") is True
        or models.get("state") in ("starting", "downloading", "waiting", "retry_wait")
        or (deferred.get("active") is True and deferred.get("state") in
            ("starting", "downloading", "waiting", "retry_wait"))
    )
    blocked = models.get("state") in ("waiting_disk", "failed") or deferred.get("state") in (
        "waiting_disk", "failed"
    )
    engines = options.get("engines") if isinstance(options, dict) else None
    ltx = engines.get("ltx") if isinstance(engines, dict) else None
    available = ltx.get("available") if isinstance(ltx, dict) else None

    if blocked:
        state = "blocked"
    elif downloading:
        state = "downloading"
    elif available is False:
        state = "unavailable"
    elif available is True:
        state = "ready"
    else:
        state = "unknown"

    return {
        "state": state,
        "ready_to_test": state == "ready",
        "ltx_available_reported": available if isinstance(available, bool) else None,
        "deferred_downloads": {
            "state": deferred.get("state"),
            "active": deferred.get("active"),
            "pending_count": len(deferred.get("pending", []))
            if isinstance(deferred.get("pending"), list) else None,
        },
        "model_download_locked": models.get("locked") is True,
    }


def make_reference_png(width: int = 512, height: int = 288) -> bytes:
    """Create a deterministic safe RGB gradient test frame, no Pillow required."""
    if width != 512 or height != 288:
        raise ValueError("The test reference size is fixed for consistent runs.")

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data +
                struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    raw_rows = bytearray()
    for y in range(height):
        raw_rows.append(0)  # PNG filter: none
        for x in range(width):
            # Gold/teal sky, blue foreground, with a clear central sun circle.
            dx = x - 350
            dy = y - 95
            sun = dx * dx + dy * dy < 28 * 28
            if sun:
                color = (249, 226, 150)
            elif y > 200:
                color = (24 + x // 80, 71 + y // 25, 114 + x // 110)
            else:
                color = (25 + x // 12, 82 + y // 12, 119 + x // 18)
            raw_rows.extend(min(255, max(0, n)) for n in color)
    return (
        b"\x89PNG\r\n\x1a\n" +
        chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) +
        chunk(b"IDAT", zlib.compress(bytes(raw_rows), level=7)) +
        chunk(b"IEND", b"")
    )


def post_json(method: str, url: str, body: bytes | None = None,
              content_type: str | None = None) -> dict[str, Any]:
    if not safe_loopback_url(url):
        raise AcceptanceError("Only the owner's local loopback services may be contacted.")
    headers = {"Accept": "application/json"}
    if content_type:
        headers["Content-Type"] = content_type
    req = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(req, timeout=120 if method == "POST" else 20) as res:
            raw = res.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise AcceptanceError("Local server returned oversized JSON.")
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise AcceptanceError("Unexpected JSON response from local renderer.")
            return result
    except HTTPError as exc:
        detail = exc.read(2048).decode("utf-8", errors="replace")
        raise AcceptanceError(f"Local service returned HTTP {exc.code}: {detail[:300]}") from exc
    except (URLError, OSError, ValueError) as exc:
        raise AcceptanceError(f"Cannot complete local HTTP request: {exc}") from exc


def download_media(url: str, target: Path, limit: int) -> int:
    if not safe_loopback_url(url):
        raise AcceptanceError("Media download must remain on localhost.")
    staging = target.with_suffix(target.suffix + ".part")
    total = 0
    try:
        with urlopen(Request(url), timeout=120) as res, staging.open("wb") as output:
            if res.status != 200:
                raise AcceptanceError(f"Local media download returned HTTP {res.status}.")
            while block := res.read(256 * 1024):
                total += len(block)
                if total > limit:
                    raise AcceptanceError("Media exceeded the SSD acceptance test size cap.")
                output.write(block)
        staging.replace(target)
        return total
    except (HTTPError, URLError, OSError) as exc:
        raise AcceptanceError(f"Local media download failed: {exc}") from exc
    finally:
        staging.unlink(missing_ok=True)


def validate_mp4(path: Path) -> tuple[bool, str]:
    """Require an MP4 signature plus a complete local video decode."""
    if not path.is_file() or path.stat().st_size < 1024:
        return False, "Video missing or too small."
    with path.open("rb") as file:
        header = file.read(12)
    if header[4:8] != b"ftyp":
        return False, "Video does not contain an MP4 file-type header."

    probe = shutil.which("ffprobe")
    ffmpeg = os.getenv("AXOM_FFMPEG") or shutil.which("ffmpeg")
    if not probe or not ffmpeg:
        return False, "FFprobe and FFmpeg are required for a verified video decode."
    try:
        check = subprocess.run(
            [probe, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name,width,height",
             "-of", "json", str(path)],
            text=True, capture_output=True, timeout=60, check=False,
        )
        if check.returncode != 0:
            return False, "FFprobe rejected the generated video."
        parsed = json.loads(check.stdout)
        streams = parsed.get("streams", [])
        if not streams or int(streams[0].get("width", 0)) <= 0:
            return False, "MP4 has no valid video stream."
        decode = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
             "-i", str(path), "-f", "null", "-"],
            capture_output=True, timeout=180, check=False,
        )
        if decode.returncode != 0:
            return False, "Full MP4 decode failed."
        return True, f"Video decoded: {streams[0].get('codec_name', '?')}, " \
                     f"{streams[0].get('width')}x{streams[0].get('height')}"
    except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
        return False, f"Video validation could not complete: {exc}"


def multipart_source(image: bytes) -> tuple[bytes, str]:
    boundary = "AXOMACCEPT" + secrets.token_hex(12)
    params = {
        "prompt": "The sunlit sky subtly changes, clouds drift gently, and the camera slowly pushes forward.",
        "duration_seconds": 3,
        "orientation": "landscape",
        "batch_count": 1,
        "quality": "quick",
    }
    body = (
        ("--" + boundary + "\r\n"
         'Content-Disposition: form-data; name="image"; filename="acceptance.png"\r\n'
         "Content-Type: image/png\r\n\r\n").encode() +
        image +
        ("\r\n--" + boundary + "\r\n"
         'Content-Disposition: form-data; name="params"\r\n\r\n' +
         json.dumps(params).encode().decode() +
         "\r\n--" + boundary + "--\r\n").encode()
    )
    return body, "multipart/form-data; boundary=" + boundary


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.part")
    try:
        tmp.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def run_smoke_test(
    studio: str,
    report_dir: Path,
    *,
    max_wait_seconds: float = 3600,
    request_json: JSON_REQUEST = post_json,
    download: MEDIA_DOWNLOADER = download_media,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    """Opt-in end-to-end local GPU acceptance; never touches the installer."""
    parsed = urlsplit(studio)
    if (not safe_loopback_url(studio + "/local/health")
            or parsed.port not in AXOM_PORTS
            or parsed.path not in ("", "/")
            or max_wait_seconds <= 0):
        raise ValueError("Expected a dedicated local AXOM_VID studio and a positive time limit.")

    report_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, Any] = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "mode": "local_phosphene_3s_quick",
        "passed": False,
        "job_id": None,
        "checks": {},
    }
    try:
        image = make_reference_png()
        body, content_type = multipart_source(image)
        accepted = request_json("POST", studio + "/local/generate", body, content_type)
        job_id = accepted.get("jobId")
        if not isinstance(job_id, str) or not re.fullmatch(r"j-[a-zA-Z0-9-]{1,100}", job_id):
            raise AcceptanceError("Local bridge did not return a valid job ID.")
        report["job_id"] = job_id
        report["checks"]["queued"] = True
        print("Submitted one 3-second Quick render: " + job_id, flush=True)

        deadline = time.monotonic() + max_wait_seconds
        while True:
            if time.monotonic() > deadline:
                raise AcceptanceError("GPU test exceeded its time limit. The queued job may still be running.")
            item = request_json(
                "GET", studio + "/local/status?" + urlencode({"jobId": job_id}),
            )
            state = item.get("status")
            if state == "done":
                if not isinstance(item.get("videoUrl"), str):
                    raise AcceptanceError("Render returned done without a playable MP4 URL.")
                break
            if state in ("failed", "error", "stopped", "cancelled"):
                raise AcceptanceError(f"Phosphene reported {state}: {item.get('error', '')}")
            if state not in ("queued", "running"):
                raise AcceptanceError(f"Unexpected Phosphene job state: {state!r}")
            print(f"Phosphene: {state} {item.get('message', '')}", flush=True)
            sleep(min(15, max(0.1, deadline - time.monotonic())))

        mp4_path = report_dir / "smoke-video.mp4"
        video_url = studio + "/local/video?" + urlencode({"jobId": job_id, "download": 1})
        size = download(video_url, mp4_path, MAX_DOWNLOAD_BYTES)
        video_ok, detail = validate_mp4(mp4_path)
        report["checks"]["mp4"] = {"passed": video_ok, "bytes": size, "detail": detail}
        if not video_ok:
            raise AcceptanceError(detail)
        with mp4_path.open("rb") as rendered_file:
            report["checks"]["mp4"]["sha256"] = hashlib.file_digest(
                rendered_file, "sha256"
            ).hexdigest()

        gif_path = report_dir / "smoke-video.gif"
        gif_url = studio + "/local/gif?" + urlencode(
            {"jobId": job_id, "seconds": 3, "fps": 8, "width": 320}
        )
        gif_size = download(gif_url, gif_path, MAX_GIF_BYTES)
        with gif_path.open("rb") as file:
            gif_ok = file.read(6) in (b"GIF89a", b"GIF87a")
        report["checks"]["gif"] = {"passed": gif_ok, "bytes": gif_size}
        if not gif_ok:
            raise AcceptanceError("The local GIF export was not a GIF file.")
        report["passed"] = True
        report["result"] = "Verified local image-to-video MP4 and GIF, including full video decode."
    except Exception as exc:
        report["error"] = str(exc)
        report["result"] = "Hardware acceptance incomplete. See error and retain the Phosphene job."
    finally:
        report["finished_at"] = datetime.now(timezone.utc).isoformat()
        write_report(report_dir / "acceptance-result.json", report)
    return report


def run_preflight(
    fetch: JSON_GETTER = get_json,
) -> dict[str, Any]:
    axom = choose_axom(fetch)
    phosphene = choose_phosphene(fetch)
    model = (
        inspect_install_state(
            phosphene["status"], fetch(phosphene["url"] + "/oneshot/options")
        ) if phosphene else
        {"state": "offline", "ready_to_test": False}
    )
    comfy_url: str | None = None
    comfy: dict[str, Any] | None = None
    comfy_queue: dict[str, Any] | None = None
    # Real installations often run a second ComfyUI process on 8189;
    # avoid a false "offline" result when 8188 is unused.
    for port in (8188, 8189):
        candidate_url = f"http://127.0.0.1:{port}"
        candidate = fetch(candidate_url + "/system_stats")
        if isinstance(candidate, dict) and "system" in candidate:
            comfy_url = candidate_url
            comfy = candidate
            comfy_queue = fetch(candidate_url + "/queue")
            break
    comfy_busy = bool(
        isinstance(comfy_queue, dict)
        and (comfy_queue.get("queue_running") or comfy_queue.get("queue_pending"))
    )
    gpu = phosphene["status"].get("gpu") if phosphene else None
    phosphene_busy = bool(
        phosphene and (
            phosphene["status"].get("current") is not None
            or bool(phosphene["status"].get("queue"))
            or (isinstance(gpu, dict) and gpu.get("busy") is True)
        )
    )
    gpu_busy = phosphene_busy or comfy_busy
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "ssd_checkout": str(ROOT),
        "axom": axom,
        "phosphene": {"url": phosphene["url"], "online": True} if phosphene else None,
        "model": model,
        "comfyui_http_responsive": isinstance(comfy, dict) and "system" in comfy,
        "comfyui_url": comfy_url,
        "local_gpu_busy": gpu_busy,
        "comfyui_gpu_busy": comfy_busy,
        "axom_bridge_online": bool(axom and axom["health"].get("online") is True),
        "ready_to_render": bool(
            axom and axom["health"].get("online") is True
            and phosphene and model["ready_to_test"] and not gpu_busy
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Read-only local preflight; optional explicit 3-second GPU acceptance."
    )
    parser.add_argument("--render", action="store_true", help="Run one local 3-second Quick video+GIF hardware test.")
    parser.add_argument("--max-minutes", type=int, default=60, help="Maximum GPU test wait (1–180 minutes).")
    parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR)
    args = parser.parse_args()
    if not 1 <= args.max_minutes <= 180:
        parser.error("GPU wait must be between 1 and 180 minutes.")

    report_dir = args.report_dir.resolve()
    # Integration output should stay inside this checkout on the user's SSD.
    if not report_dir.is_relative_to(ROOT):
        parser.error("Report directory must stay inside the AXOM_VID checkout on the SSD.")

    status = run_preflight()
    write_report(report_dir / "last-preflight.json", status)
    print(json.dumps(status, indent=2, ensure_ascii=False), flush=True)
    print("\nReport written locally: " + str(report_dir / "last-preflight.json"), flush=True)
    if not status["axom"]:
        print("Start AXOM_VID: bash /Volumes/JDabSSD/Developer/AXOM_VID/local/start.command", flush=True)
    if not status["phosphene"]:
        print("Phosphene is offline. Finish SSD model installation and start the panel in Pinokio.", flush=True)
    if status["phosphene"] and status["phosphene"]["url"].endswith(":8199"):
        print("Phosphene uses DEV port 8199. Restart AXOM_VID with PHOSPHENE_URL=http://127.0.0.1:8199.", flush=True)
    if status["model"]["state"] in ("downloading", "blocked"):
        print("Phosphene model download is still active/blocked. Do not overwrite or remove .part files.", flush=True)
    if status["local_gpu_busy"]:
        print("Phosphene or ComfyUI has another GPU job running/queued. No acceptance render will be started.", flush=True)

    if args.render:
        if not status["ready_to_render"]:
            print("GPU render test NOT submitted: local engine is not verified ready.", flush=True)
            return 2
        if not status["axom"]:
            return 2
        result = run_smoke_test(
            status["axom"]["url"], report_dir,
            max_wait_seconds=args.max_minutes * 60,
        )
        print(json.dumps(result, indent=2, ensure_ascii=False), flush=True)
        return 0 if result["passed"] else 1

    return 0 if status["ready_to_render"] else 2


if __name__ == "__main__":
    sys.exit(main())
