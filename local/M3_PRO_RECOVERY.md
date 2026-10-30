# AXOM_VID M3 Pro (18 GB): safe local video workflow

This is a **local-only, no per-render API-fee** workflow for the existing Phosphene LTX-2.5 Q4 model on the user's external SSD. It does not install models, modify ComfyUI, or grant unlimited GPU throughput.

## Verified incident (October 30, 2026)

A Phosphene text-to-video request (768 x 448, Balanced quality, 481 frames) failed after 141 seconds during Gemma prompt encoding. The reported error is a Metal command-buffer watchdog timeout (`kIOGPUCommandBufferCallbackErrorTimeout`) followed by SIGABRT. Phosphene attempted shortened GPU steps and a 256-token prompt and still failed. Its error explicitly warns that **a smaller video does not necessarily prevent a prompt-encoding failure**.

The model panel remains responsive and LTX Q4 integrity was verified. Mac memory pressure was ~81%, swap nearly 20 GB. An optional 30 GB Q8 download was running even though Phosphene reports `allows_q8: false` on this 18 GB Compact tier. Do not delete a partial download; manage it in its owning Pinokio/ComfyUI setup session.

See the upstream [Metal watchdog troubleshooting](https://phosphene.video/docs/troubleshooting/) and [the prompt-encoder watchdog issue](https://github.com/mrbizarro/Phosphene/issues/44) for context. These describe similar errors; they do not prove that all affected machines have one cause.

## Default sequence

1. **Finish current work first.** Wait until Phosphene has no active GPU job, ComfyUI's queue is empty, and no model downloads are active in Pinokio.
2. **Reduce GPU competition.** Close idle browser video playback and graphics/AI applications that are not needed for the test, without abruptly terminating active jobs. Consider a normal Mac reboot after downloads finish and work is saved if swap remains very high.
3. Launch Phosphene via Pinokio and AXOM_VID from the separate SSD checkout. The studio is at [http://127.0.0.1:8765/AXOM_VID/](http://127.0.0.1:8765/AXOM_VID/) when that port is available.
4. Check the **Installed model and hardware** panel. `modelReady` means weights are available; `safeToSubmit` means no current conflict, downloader or cooldown blocks a test.
5. If recent Metal watchdog failure is detected, **respect its cooldown**. Do not use the automatic retry button to resubmit the crash repeatedly.
6. Choose **Use low-memory preset**: one 3-second, Quick, 512-pixel I2V, random seed. Use a neutral still image and short motion prompt. This is a diagnostic test, not a guarantee that the GPU cannot crash.
7. Only if that I2V finishes, MP4 decodes correctly, and swap/memory pressure decrease, test 5 seconds Quick. More demanding resolutions, Balanced quality, batch size and chained takes unlock only when the hardware evidence supports them.

AXOM_VID does not automatically switch to billable cloud inference when local GPU generation is blocked. The existing Hugging Face free mode is separate and quota-limited.

## New hardware safety gates

- **Cooldown:** identifies a reported Metal watchdog SIGABRT in recent Phosphene history and disables new submissions during the 15-minute recovery interval.
- **Busy GPU:** prevents another submission while Phosphene or ComfyUI reports ongoing or queued work, even if the browser thinks it is idle.
- **Active weights download:** blocks concurrent rendering on the 18 GB Mac, especially optional Q8 downloads that cannot unlock the Q8 model tier.
- **First I2V validation:** before any verified local I2V success, accepts one 3-second Quick 512px job only. This prevents a default Balanced/768px 20-second re-crash.
- **High memory pressure or swap:** even after first success, limits further jobs to a conservative size, duration, batch and quality until the Mac is less loaded. Advanced settings remain visible but unsupported submissions are rejected before the image is uploaded.

The safety rules are based on **reported current device state**, not a promise of stable performance at any particular resolution. The 18 GB Mac can still encounter Metal-driver failures, and these cannot be fixed by changing only the AXOM_VID frontend.

## Personalization without overloading memory

Creative recipes, seed, orientation, camera movement and visual style remain available with Quick low-memory settings. Save custom settings in the browser; source images and prompt text are not written to preference storage. Once a local I2V succeeds, use the same fixed seed and prompt to compare a single controlled change at a time rather than simultaneously changing quality, duration, LoRAs and resolution.

For longer projects: prepare storyboards/prompts first; generate individual short shots sequentially; review each MP4; assemble and scale using local FFmpeg instead of expecting a 120-second single render on 18 GB.

## When upgrading actually helps

- **Free immediate step:** finish/pause optional downloads cleanly and reduce memory competition. The SSD has plenty of storage; RAM/GPU stability is the present bottleneck.
- **Mac with higher unified memory:** 48 GB or more is the official Phosphene class for Q8/HQ/longer-generation tiers; Hailuo H3 has its own minimum. Unified RAM on this MacBook cannot be upgraded in place.
- **Optional remote provider:** can be faster and stronger but is not free, unmetered, or guaranteed. Never hide API billing behind an automatic fallback.

Hardware test after the guard no longer blocks:

```bash
python3 /Volumes/JDabSSD/Developer/AXOM_VID/local/acceptance.py
# Explicitly opt in to ONE neutral 3-second local I2V once ready:
python3 /Volumes/JDabSSD/Developer/AXOM_VID/local/acceptance.py --render --max-minutes 90
```

Do not claim a successful local I2V until its MP4 and GIF have actually passed verification. 
