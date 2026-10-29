# Shared handoff: ComfyUI Model Setup and AXOM_VID

This document is the common checklist for two ongoing ChatGPT conversations. They cannot directly send messages to each other. The ComfyUI Model Setup workflow owns model installation on the SSD; the AXOM_VID workflow owns the browser/bridge integration and validation. Do not have two installers modify the same model files concurrently.

## Ownership and paths

| Component | Existing location / endpoint | Responsibility |
| --- | --- | --- |
| SSD | /Volumes/JDabSSD | Store AI models, tools, and generated files here |
| Phosphene | /Volumes/JDabSSD/pinokio/ (existing installation) | ComfyUI setup handles downloading and starting models |
| Phosphene API | 127.0.0.1:8198 (normal) or 8199 (DEV) | Check the actual port, do not assume |
| ComfyUI | /Volumes/JDabSSD/LocalAI and commonly port 8188 | Separate image and Wan workflows |
| Glass Studio | /Volumes/JDabSSD/LocalAI, previously port 8788 | Separate image workflow |
| AXOM_VID | /Volumes/JDabSSD/Developer/AXOM_VID | Browser and local Phosphene bridge, port 8765–8775 |

An earlier setup snapshot reported an actively downloading LTX-2.5 MLX Q4 .part file. It may have progressed since then. Recheck live status instead of presuming installation complete. Do not delete, move, overwrite, or re-download a file while its installer is still writing it.

Local FLUX image generation working does not prove Wan or LTX video inference works. Likewise, HTTP 200 from AXOM_VID proves only that the website responds, not that Phosphene can render.

## Mac initialization and acceptance, in order

1. Let the existing ComfyUI Model Setup workflow finish the Phosphene install on the SSD. Do not start an alternative downloader or manually move weights.
2. Start the installed Phosphene panel when its installer says it is safe. Check the actual port:

       curl -fsS --max-time 8 http://127.0.0.1:8198/status
       curl -fsS --max-time 8 http://127.0.0.1:8199/status

3. Update only the AXOM_VID checkout and start it if not already running:

       git -C "/Volumes/JDabSSD/Developer/AXOM_VID" pull --ff-only
       bash "/Volumes/JDabSSD/Developer/AXOM_VID/local/start.command"

   AXOM_VID chooses an available port from 8765–8775 without killing other processes. If Phosphene uses DEV 8199 instead of production 8198, stop only AXOM_VID (Ctrl+C in its own Terminal) and restart with:

       PHOSPHENE_URL=http://127.0.0.1:8199 bash "/Volumes/JDabSSD/Developer/AXOM_VID/local/start.command"

4. Run the read-only preflight (no models are downloaded; no GPU generation is started):

       python3 "/Volumes/JDabSSD/Developer/AXOM_VID/local/acceptance.py"

   The tool probes loopback services, actual model availability via the official Phosphene API, download locks, and active GPU work. It writes a tiny receipt on the SSD at:

       /Volumes/JDabSSD/Developer/AXOM_VID/local/reports/last-preflight.json

   If model.state says downloading, blocked, unknown, or unavailable, do not claim Phosphene ready. If a GPU job is already active, do not interrupt it.

5. Only when ready_to_render is true, run exactly one genuine hardware acceptance test:

       python3 "/Volumes/JDabSSD/Developer/AXOM_VID/local/acceptance.py" --render --max-minutes 90

   This submits a synthetic 512x288 landscape image, one 3-second Quick LTX image-to-video render, validates its downloaded MP4 (full FFmpeg decode), then checks a locally converted GIF. No paid cloud service is involved. The completed results remain entirely inside the SSD repository:

       local/reports/acceptance-result.json
       local/reports/smoke-video.mp4
       local/reports/smoke-video.gif

   If a test times out, inspect the recorded job ID in Phosphene before submitting another. Closing the terminal or timing out does not cancel the already-queued GPU job.

## Explicit acceptance criteria

- [ ] Phosphene installer has completed essential SSD model files without required partial downloads.
- [ ] Phosphene status responds and API reports LTX available.
- [ ] AXOM_VID health returns online: true rather than only HTTP 200.
- [ ] A real, locally rendered 3-second MP4 is generated and fully decoded.
- [ ] The GIF export is generated and validated on the SSD.
- [ ] The actual ports and report filenames are recorded.
- [ ] Two queued jobs are tested after the first works and the GPU is free.
- [ ] Glass Studio, ComfyUI FLUX, and ComfyUI Wan each retain separate verified/unverified statuses. Wan video should never be represented as working based only on weight availability.

The acceptance script does not modify Phosphene's installation, does not install models, and does not access cloud tokens. Its read-only default is safe to run while installation is ongoing. Optional --render explicitly spends local Mac GPU time and refuses to run if the model is unverified or the GPU is occupied.

## Return to the AXOM_VID conversation

Report actual live evidence, not guesses: Phosphene port; LTX readiness and download status; AXOM_VID port; preflight ready_to_render; smoke job ID; MP4 decoder result and GIF result; any blocked stage. The two workflows can use this document and the local JSON receipts as a shared contract without competing for SSD writes.
