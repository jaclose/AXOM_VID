# AXOM_VID: local rendering with no daily cloud credits

This uses local image-to-video inference, not an unlimited free cloud GPU. On an Apple Silicon Mac, the free Phosphene LTX engine can render repeated clips without consuming Hugging Face ZeroGPU runs, paid API credits or monthly generation subscriptions. Your real limits are the Mac's RAM, speed, storage and electricity.

## What is required

- Apple Silicon with at least 16 GB unified RAM. Start with the Quick profile (512×288 or portrait 288×512, 3 seconds) on an M3 Pro with 18 GB.
- Around 40 GB free for a fresh Phosphene installation, plus room for videos. Phosphene currently needs about 27.5 GB at installation and around 10.7 GB in background extras. Details: https://phosphene.video/docs/install/
- An external SSD is recommended for a Mac with limited internal storage.
- Python 3.10+ and the existing AXOM_VID Node/pnpm frontend dependencies to launch the small bridge.

## Setup steps

1. Install Pinokio from https://desktop.pinokio.co/ on your Mac.
2. If using an external SSD, open Pinokio Settings and set Pinokio Home to the external SSD BEFORE installing Phosphene. Use a filesystem that supports macOS permissions and symlinks (APFS is a good choice); do not migrate an existing Home without backing it up.
3. In Pinokio choose Discover, Download from URL, and paste https://github.com/mrbizarro/Phosphene. Click Install. This downloads the local video model once.
4. When installation finishes choose Start. Confirm Phosphene opens at http://127.0.0.1:8198.
5. Open a terminal inside the separate AXOM_VID repository and run:

       git pull
       bash local/start.command

6. Open http://127.0.0.1:8765/AXOM_VID/ (the script also opens the browser automatically). Select Local Mac, upload a source image and enter a motion prompt. Generate a 3-second clip first, then try 5 seconds.
7. If the browser reports Local renderer offline, start Phosphene and press Check local engine.

The local bridge uses only Python's standard library and never downloads a second model. It binds to 127.0.0.1 only, serves the existing Astro frontend from web/dist, and forwards jobs to the locally running Phosphene panel. The webpage cannot remotely generate on your laptop when its local server is not running.

## Model and storage details

Phosphene's LTX-2.5 engine supports actual image-to-video generation on Macs with 16 GB or more. It is lower resolution and slower on an 18 GB laptop than on a rented NVIDIA GPU, so this is an unlimited-attempt solution, not an instant-output or unlimited-resolution solution. Renders continue in Phosphene if you stop watching in AXOM_VID.

Pinokio's documentation explains that Pinokio Home can be set in Settings; it also supports external storage: https://desktop.pinokio.co/docs/. If the Mac runs short on internal space, install Phosphene on the external SSD rather than filling the internal disk.

Generated videos are retained by Phosphene in its Outputs folder. AXOM_VID's local media links last for the current bridge session; the MP4 files themselves remain on disk. Close other memory-heavy apps while rendering. Do not unplug the model drive during a job.

## Local architecture

    AXOM_VID browser, http://127.0.0.1:8765
          |
          v
    AXOM_VID Python bridge, 127.0.0.1 only
       | /local/generate, /local/status, /local/video
       v
    Phosphene panel, http://127.0.0.1:8198
       | /upload, /queue/add, /status
       v
    Local Apple Silicon GPU + LTX-2.5 model
       |
       v
    Local MP4 file

No fal.ai API key, Cloudflare GPU, or Hugging Face GPU allowance is used in local mode. The older shared cloud option is separate and retains its daily quota.

## Security and limitations

- The bridge rejects foreign origins and Host headers, and does not bind to a public network interface.
- Never port-forward, expose via Cloudflare Tunnel, or publicly proxy ports 8198 or 8765. Phosphene itself does not authenticate its loopback API.
- The bridge serves only MP4s corresponding to jobs submitted in the current session, and refuses arbitrary file paths.
- Clicking Stop waiting in the browser does not cancel the GPU job; use Phosphene's own queue to stop or manage a render.
- The model and software may restrict certain uses. Open weights and free inference do not imply an absence of usage terms.
- Each generation uses real compute, power, disk writes, and minutes of hardware time. Unlimited refers to the absence of a *provider-defined generation-count or payment limit*, not infinite throughput.

## Tests

Run the no-GPU mock integration suite:

    python3 -m unittest discover -s local/tests -v

The suite verifies local-only submission, health, status, MP4 access, image validation, and cross-origin rejection. GitHub Actions runs this suite without a Mac or GPU. A passing test does not replace a real image-to-video hardware render on the user's laptop.

References:
- Phosphene HTTP API: https://github.com/mrbizarro/Phosphene/blob/main/docs/API.md
- Phosphene installation: https://phosphene.video/docs/install/
- Pinokio filesystem and SSD support: https://desktop.pinokio.co/docs/
