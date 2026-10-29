<div align="center">

![AXOM_VID: image to video with Wan 2.2](web/public/axom-vid-og.png)

# AXOM_VID

**Animate a still image with Wan 2.2 in your browser. Shared free allowance or opt-in private GPU. Open source.**

[This deployment](https://jaclose.github.io/AXOM_VID/) · [Original NiftyVid demo](https://igorcsis.github.io/nifty-vid/) · [Original source](https://github.com/IgorCSIS/nifty-vid)

![Astro](https://img.shields.io/badge/Astro-4-FF5D01?logo=astro&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind-3-38BDF8?logo=tailwindcss&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)
![Hugging Face](https://img.shields.io/badge/Hugging%20Face-Wan%202.2-FFD21E?logo=huggingface&logoColor=black)
![License](https://img.shields.io/badge/License-MIT-10B981)

</div>

## What it does

Drop a photo, write a short motion prompt ("slow camera push, leaves drifting"), and wait for a short MP4 of that image animated. AXOM_VID sends the image and prompt to a public Hugging Face Space running Wan 2.2 image-to-video. Jobs use a shared GPU, so the queue and render can take minutes.

The site is static and hosted on GitHub Pages. Visitors do not need an account, but the deployment owner must configure a Hugging Face token on the proxy Worker. Every visitor's generation uses that account's GPU quota.

AXOM_VID is a separate image-to-video project that uses the AXOM visual identity. It is derived from [NiftyVid](https://github.com/IgorCSIS/nifty-vid) by Igor Lima under the MIT license; it is not part of the AXOM study app.

## Features

- Drag-and-drop or paste an image straight from the clipboard
- Live prompt with sensible defaults (duration, inference steps)
- In-session history strip with hover-to-preview
- Dark mode interface tuned for long sessions
- Download generated videos as MP4
- Zero tracking and no signup for visitors
- Clear error, retry, stop-waiting, and elapsed-time states; upstream failures without details no longer appear as `Failed: null`
- Live shared GPU allowance, including the daily run count and local reset time; exhausted accounts are blocked before image upload
- Optional private Wan 2.2 5B mode with a separately authorized, pay-per-video GPU provider. No automatic switch from free to billed generation

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Astro 4 + Tailwind 3 + TypeScript |
| Hosting | GitHub Pages (static) |
| Edge proxy | Cloudflare Worker (free tier) |
| Inference | Wan 2.2 on shared Hugging Face ZeroGPU, or owner-only fal.ai Wan 2.2 5B |
| Tooling | pnpm 9, Wrangler 4, GitHub Actions |

## Architecture

```
[ browser ]  →  [ Cloudflare Worker ]  →  [ HF Space: Wan 2.2 ]
   GH Pages       axomvidjd.jafardabbagh.workers.dev
                  HF_TOKEN stored as a secret
```

The Worker exists for two reasons. Browsers can't reliably call Hugging Face Spaces because of CORS, and we want one stable URL we control so the upstream backend can change without redeploying the static site. Today the Worker proxies to a public Space; tomorrow it could swap to fal.ai, Replicate, or a private Space without touching the frontend.

### The handoff

<p align="center">
  <img src="assets/handoff.svg" alt="A sequence diagram. The browser posts one multipart form to the Worker. The Worker uploads the image to the Gradio Space, submits the job, gets an event id back, opens the server-sent event stream for it, and returns that response body as its own without reading it. The events then flow from the Space through Cloudflare to the browser, which parses the complete event and pulls the video URL out." width="880">
</p>

In shared mode, the Worker checks the account's ZeroGPU allowance, uploads the image, submits the job with its server-held token, then
opens the upstream event stream and returns that stream to the browser. A
restricted download route streams the finished MP4 as an attachment. The Worker
does not buffer the generated clip or expose the token to the page. Its `/quota`
route returns only remaining GPU seconds, remaining runs, and reset times.

The price is that the browser has to speak SSE. `web/src/scripts/studio.ts`
buffers the stream, splits it on blank lines, and waits for the `complete`
event to pull the video URL out of the return tuple. That file and
`worker/src/index.ts` are two halves of one contract.

## Run locally

You need Node 20+, [pnpm](https://pnpm.io/) 9+, and a clone of this repo. Both lockfiles are v9, which is what CI installs with. The local preview uses the deployed Worker by default, so you can start with the frontend alone:

```powershell
# Frontend (Astro dev server on :4321)
cd web
pnpm install
pnpm dev

```

Open http://localhost:4321 and try a generation. For independent local Worker development, create a [Hugging Face read token](https://huggingface.co/settings/tokens), put it in gitignored `worker/.dev.vars` as `HF_TOKEN=<your token>`, run `pnpm wrangler dev` from `worker/`, and put `PUBLIC_WORKER_URL=http://localhost:8787` in `web/.env`. Never place the token in `web/.env` or a `PUBLIC_` variable. The Worker `/health` route reports `configured: true` when it has a token; it never returns the token itself.

## Deploy

The static site deploys to [AXOM_VID on GitHub Pages](https://jaclose.github.io/AXOM_VID/) on pushes to `main` via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). GitHub forks may require Actions to be enabled and **Settings → Pages → Build and deployment → GitHub Actions** to be selected first. The Worker, named `axomvidjd` in `worker/wrangler.toml`, is typechecked by [`.github/workflows/worker.yml`](.github/workflows/worker.yml) and deployed separately:

```powershell
cd worker
pnpm wrangler login
pnpm wrangler deploy
pnpm wrangler secret put HF_TOKEN
```

Set `PUBLIC_WORKER_URL` to `https://axomvidjd.jafardabbagh.workers.dev` under **Settings → Secrets and variables → Actions → Variables** in the fork. A new Pages build wires the frontend to the Worker. Check the Worker `/health` endpoint for `configured: true`, then test a generation on the public page. The Worker token must be added as a Cloudflare secret, never as a GitHub variable or a committed file.

## Optional private GPU mode (billable, owner only)

The free shared mode remains the default. AXOM_VID also supports a **separate, explicit** private rendering selection using fal.ai's Wan 2.2 5B endpoint, which currently lists approximately **$0.15 per video**. The provider can change pricing and reject jobs according to its policies. Private jobs do not consume your Hugging Face ZeroGPU allowance, but they are not free or guaranteed unlimited: billing credits, rate limits, and GPU availability still apply. This mode does not bypass fal.ai's acceptable-use rules or model safety checks; some prompts and images may be rejected. Only submit content permitted by the provider.

This feature is **off** unless *both* Cloudflare Worker secrets are configured:

1. Create a fal.ai account, buy a small prepaid credit balance, and generate a fal API key. Monitor remaining credits and any automatic top-up setting; do not assume that a hard spend limit is enabled.
2. In Cloudflare > Workers & Pages > `axomvidjd` > Settings > Variables and secrets, add `FAL_KEY` as a **secret**. Never put this key in frontend code or a public variable.
3. Generate a separate long random code locally (for example, `openssl rand -hex 32`). Add that as the Cloudflare Worker secret `PRIVATE_ACCESS_KEY`. Do not reuse your fal key as the access code.
4. Deploy the changed Worker from `worker/` with `pnpm wrangler deploy` and deploy the matching website changes.
5. On the website choose **Private GPU · pay per video**, enter the **private access code**, upload an image, and generate. The code stays in the current browser tab and is not persisted by the site.

The private endpoints require the access code, and the provider key stays server-side. The website never automatically submits a billable job when the free quota runs out. Stopping the browser's wait **does not necessarily cancel or refund** a paid provider job. Access codes must be kept secret; CORS and per-location rate limiting are not replacements for authentication, hard budgets, or abuse controls. Do not expose this owner-only mode to arbitrary visitors. For public paid generation, introduce user accounts, server-side credit accounting, per-user budgets, and durable idempotent job records first.

For test-only changes, no real fal inference request is required. Worker tests mock the provider and exercise private authorization, queue handling, and download URL validation:

```sh
cd worker
pnpm install --frozen-lockfile
pnpm typecheck
node --experimental-strip-types --test tests/*.test.mjs
```

## Limitations

- Generation starts at 1.5 seconds and 3 inference steps to favor a first result. Advanced options allow up to 4.5 seconds and 12 steps; longer clips use more GPU time and may fail on the shared Space.
- The upstream Space uses shared ZeroGPU hardware. Queues, cold starts, service failures, and daily account quota can interrupt generation. Free accounts can reach their daily run cap even with GPU seconds remaining; `/quota` reports both limits and the page shows the reset time. [Hugging Face documents its ZeroGPU quota API](https://huggingface.co/docs/huggingface_hub/guides/manage-spaces#track-your-zerogpu-quota). This Space requests an xlarge GPU, which uses quota at 2×. Every public visitor shares the token owner's quota. A paid or independently hosted backend is required for dependable public capacity.
- The upstream Space can change or disappear. A backend change may require updating `HF_SPACE_BASE` and the input mapping in `worker/src/index.ts`.
- Cloudflare [documents no hard wall-time limit for HTTP Workers while the client remains connected](https://developers.cloudflare.com/workers/platform/limits/). A broken browser connection or upstream stream can still stop a run.

## Roadmap

- [x] Stream Gradio events to the browser for queue and generation states
- [ ] Optional second keyframe ("last frame") for guided motion
- [ ] Saved generations across sessions (opt-in localStorage)
- [ ] Frame extraction tool to use a generated frame as the next input
- [x] Optional private backend: fal.ai with owner-held secrets and per-video billing
- [ ] Per-user accounts, credit budgets, and globally enforced spending controls before making paid generation public

## Credits

- Original project: [NiftyVid](https://github.com/IgorCSIS/nifty-vid) by [Igor Lima](https://github.com/IgorCSIS), released under the MIT license
- [Wan 2.2](https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B-Diffusers) by Alibaba Tongyi Lab
- The [`cbensimon/wan2-2-fp8da-aoti-preview2`](https://huggingface.co/spaces/cbensimon/wan2-2-fp8da-aoti-preview2) Hugging Face Space that hosts the inference
- [Astro](https://astro.build/), [Tailwind](https://tailwindcss.com/), and [Cloudflare Workers](https://workers.cloudflare.com/) for the boring-but-good parts

## License

MIT. See [LICENSE](LICENSE). The original NiftyVid attribution and license are retained in this derivative.
