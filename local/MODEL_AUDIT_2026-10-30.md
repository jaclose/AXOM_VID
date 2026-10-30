# AXOM_VID · Apple Silicon model and capability audit
**Inspected:** October 30, 2026, approximately 11:50 a.m. Atlantic time
**Machine:** MacBook Pro M3 Pro, 18 GB unified memory
**Storage:** external SSD at /Volumes/JDabSSD, approximately 200 GiB free at inspection
**Scope:** AXOM_VID, Phosphene LTX-2.5, and the connected ComfyUI Wan 5B workflow. This is a point-in-time inspection, not a guarantee that downloads have remained unchanged.

## Verified current state

| Engine / component | Evidence | Status |
| --- | --- | --- |
| AXOM_VID local bridge | HTTP 200, Phosphene API on 127.0.0.1:8198 | Running |
| Phosphene LTX-2.5 Q4 base | Phosphene /status: base_available=true; model_integrity.ok=true; 26 files checked | Installed and integrity-checked |
| Gemma 3 12B 4-bit text encoder | Phosphene deferred_downloads.state=downloading; pending key=gemma, reported size 8.07 GB | Incomplete; wait for installer |
| IC-LoRA Upscale and Face Fix | Deferred pending, about 0.33 GB | Not yet ready |
| IC-LoRA Union Control | Deferred pending, about 0.65 GB | Not yet ready |
| IC-LoRA Ingredients | Deferred pending, about 1.31 GB | Not yet ready |
| IC-LoRA Colorize | Deferred pending, about 0.33 GB | Not yet ready |
| LTX Q8 pack | /status: q8_available=false; Q8 pack files absent | Not installed, unsupported in current tier |
| LTX HQ transformer add-ons | Missing transformer-dev.safetensors and ltx-2.5-22b-distilled-lora-450.safetensors | Missing and not recommended on 18 GB |
| Hailuo H3 | /status: h3.capable=false; installed=false; reported minimum 36 GB unified memory for reduced-RAM configuration | Hardware-incompatible |
| Local Q4 Image-to-video | /oneshot/options engines.ltx.available=true, but Gemma download still active; no local panel-rendered MP4 reported | API available; real 3s GPU test pending |
| ComfyUI Wan2.2 Fun 5B Control | Q4_K_M GGUF about 3.2 GB, UMT5 Q4 text encoder about 3.4 GB, VAE about 1.3 GB present on SSD | Model assets present |
| ComfyUI Wan video result | FFprobe: H.264, 320x576, 17 frames, 0.7083 s | A tiny generated output exists; longer/higher quality not verified |
| ComfyUI process | HTTP API on 127.0.0.1:8189, queue empty at inspection | Running |
| Cloudflare/Hugging Face shared GPU | A 1.5s/3-step synthetic landscape successfully generated and fully decoded as MP4 | Functional, quota-limited |
| Shared cloud max 4.5s/12 steps | HTTP 200 SSE event:error data:null; no video | Failed; underlying provider did not state why |

## Hardware ceilings, not merely missing models

Phosphene reports tier=base (Compact) because the Mac has less than 48 GB unified RAM. Its tier explicitly limits Q4 image-to-video to **up to 768 pixels on the longer side** and disables High quality, first/last-frame keyframing, and extension modes on this class of Mac. Hailuo H3 requires at least 36 GB unified RAM for its reduced-RAM lane. This Mac has 18 GB and its memory pressure was around 78–81%, with about 11.8–16.2 GB of swap observed. Rendering at maximum resolution while downloading model weights increases the risk of severe slowdown or memory failure.

The locally installed Q4 model is the correct basis for **no per-video provider fee**, but its feasibility should be established with a small 3-second Quick 512x288 synthetic clip after Gemma finishes. Next test 5 seconds Quick; try 640x352 or Balanced only after those tests pass and memory pressure improves. The 704x384 preset is offered as an opt-in **experimental maximum**, not as a proven stable option. Phosphene's 30–120-second chained One Take modes can take hours on this hardware and must not be confused with a single-pass 120-second generation.

## Upgrade ranking

1. **Finish the existing Gemma text-encoder download** (not a paid upgrade). Do not re-download LTX Q4, move active files, or delete partials. Phosphene handles the ongoing download inside its existing SSD location.
2. **Recover usable RAM by reducing concurrent workloads.** Close memory-heavy applications voluntarily before long renders, and wait until the download finishes. Do not forcibly kill the user's active ComfyUI or Pinokio tasks. Track memory pressure/swap during the first real render.
3. **Keep the existing external SSD.** It already holds the Q4 model and has approximately 200 GiB free, so SSD expansion is not the first constraint. Keep all AXOM_VID caches and outputs on the SSD.
4. **Hardware replacement, not RAM installation, for true High-quality/H3 modes.** Modern MacBook Pro unified RAM is not user-upgradable. Consider 48 GB or higher for Phosphene's larger LTX tier, and consult H3 requirements before purchasing. For sustained high-resolution video rendering, 64 GB or more may be practical depending on models, but it is not a universal minimum or guarantee.
5. **Do not install Q8, HQ transformer or H3 just to fill the SSD.** Phosphene reports them as unsupported on this 18 GB machine; unused weights consume space without unlocking viable inference.
6. **No free remote GPU can guarantee unlimited jobs.** AXOM_VID's shared Hugging Face account has finite runs per day. Unlimited-attempt local inference has no provider-imposed generation count or subscription fee, but takes real time, power, thermal capacity, and storage.

## AXOM_VID personalized controls

The local studio now has human-readable creative recipes and advanced, model-backed controls: camera movement, intensity, visual treatment, source/orientation handling, resolution 512/640/704, reproducible random seed, batch variations, Quick/Balanced quality, duration (3–10s and chained 30–120s), queue monitoring, MP4/GIF downloads, and local-only preference persistence. Prompt text, source images, and user credentials are not stored in preferences. These controls are not a promise of stable generation at every size.

## What qualifies as complete verification

- [ ] Deferred Gemma text-encoder download no longer pending, and Phosphene reports the base model ready.
- [ ] No unrelated ComfyUI or Phosphene GPU work is running.
- [ ] User's Mac passes a genuine local 3-second Quick image-to-video test with a neutral reference image.
- [ ] The resulting MP4 fully decodes, plays and exports a valid GIF.
- [ ] A 5-second second test, and optional Balanced/higher-resolution tests, are attempted only if memory pressure and model behavior permit.
- [ ] Repeatability, batch queue and restored-job playback checked on the actual Mac.

Use the existing SSD-only **read-only** check:

    python3 /Volumes/JDabSSD/Developer/AXOM_VID/local/acceptance.py

When it reports ready_to_render=true and the GPU is idle, the single-job verification can be invoked explicitly:

    python3 /Volumes/JDabSSD/Developer/AXOM_VID/local/acceptance.py --render --max-minutes 90

Do not claim the model has passed local GPU inference until the receipt contains a real job ID, decoded MP4 and GIF.

### References

- Phosphene installed API status, model tier and download information: http://127.0.0.1:8198/status (accessible only from the owner's Mac)
- Phosphene official documented API: https://github.com/mrbizarro/Phosphene/blob/main/docs/API.md
- Local integration handoff: local/COMFYUI_INTEGRATION_HANDOFF.md
