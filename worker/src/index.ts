/**
 * AXOM_VID proxy Worker.
 *
 * What it does:
 *   1. Receives a POST from the browser with a multipart form (image + JSON params).
 *   2. Uploads the image to the upstream Gradio Space's /gradio_api/upload endpoint.
 *   3. Calls /gradio_api/call/generate_video to queue a job and get an event_id.
 *   4. Opens the SSE event stream for that event_id and hands the response body
 *      straight back to the browser without reading a byte of it.
 *
 *   5. Streams completed MP4 files on a separate download route so browsers
 *      save them even when the video lives on another origin.
 *
 * Why we need this:
 *   - HF Spaces don't reliably allow cross-origin requests from arbitrary domains,
 *     so the browser can't talk to them directly from GitHub Pages.
 *   - Even if CORS worked, putting the upstream URL in the static bundle would
 *     bake it in. With a Worker we control the endpoint and can swap backends
 *     (e.g. point at fal.ai later) by deploying the Worker, not the whole site.
 *   - We get one tidy place to set timeouts, retries, and origin allowlists.
 *
 * Design notes:
 *   - The handoff is the whole design. An earlier version read the stream here
 *     and returned JSON, which meant the Worker was awake for the entire
 *     generation and burning wall-clock budget on a free plan for the privilege
 *     of waiting. Returning the upstream body as this response's body makes
 *     Cloudflare pipe bytes between two sockets it already owns, so a sixty
 *     second generation costs the same as a one second one.
 *   - The cost of that is a contract: the browser now has to understand SSE.
 *     web/src/scripts/studio.ts is the other half of this file.
 */

// Worker env vars come from wrangler.toml [vars]. Marked `readonly` since
// they're injected at deploy time, not mutated at runtime.
export interface Env {
  readonly ALLOWED_ORIGINS: string;
  readonly HF_SPACE_BASE: string;
  readonly HF_FN_NAME: string;
  readonly HF_TOKEN?: string;
  readonly GENERATION_RATE_LIMIT?: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
}

// Default negative prompt lifted from the upstream Space's app.py. Keeping it
// here means callers don't have to pass it on every request, and the model
// still gets the guidance it expects.
const DEFAULT_NEGATIVE_PROMPT =
  "色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 风格, 作品, 画作, 画面, 静止, 整体发灰, " +
  "最差质量, 低质量, JPEG压缩残留, 丑陋的, 残缺的, 多余的手指, 画得不好的手部, " +
  "画得不好的脸部, 畸形的, 毁容的, 形态畸形的肢体, 手指融合, 静止不动的画面, " +
  "杂乱的背景, 三条腿, 背景人很多, 倒着走";

// User-tunable params with defaults. Anything not in this list is locked to
// what we think gives the best balance of speed and quality on a free Space.
interface UserParams {
  prompt?: string;
  duration_seconds?: number;
  steps?: number;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") ?? "";

    // CORS preflight. Any browser POST with a Content-Type other than the
    // three "simple" ones triggers a preflight, so we MUST answer this.
    if (req.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), origin, env);
    }

    if (req.method === "POST" && url.pathname === "/generate") {
      try {
        if (origin && !isAllowedOrigin(origin, env)) {
          return jsonResponse({ error: "This site is not allowed to use the generator." }, 403);
        }
        if (!env.HF_TOKEN?.trim()) {
          return withCors(jsonResponse({
            error: "Generation is not configured yet. The site owner needs to add a Hugging Face token.",
          }, 503), origin, env);
        }
        // A free account can have GPU seconds left after its daily run count is
        // exhausted. Check both before uploading a visitor's image to the Space.
        try {
          const quotaResponse = await handleQuota(env);
          if (quotaResponse.ok) {
            const quota = await quotaResponse.json() as ZeroGpuQuota;
            if (quota.runsRemaining === 0) {
              return withCors(jsonResponse({
                error: `All ${quota.runsLimit ?? "daily"} Hugging Face runs are used. The allowance resets at ${quota.runsResetsAt ?? quota.resetsAt ?? "the next daily reset"}.`,
                code: "runs_exhausted",
                resetsAt: quota.runsResetsAt ?? quota.resetsAt,
              }, 429), origin, env);
            }
            if (quota.remainingSeconds === 0) {
              return withCors(jsonResponse({
                error: `Hugging Face GPU time is used up. The allowance resets at ${quota.resetsAt ?? "the next daily reset"}.`,
                code: "gpu_exhausted",
                resetsAt: quota.resetsAt,
              }, 429), origin, env);
            }
          }
        } catch {
          // Quota diagnostics must not prevent generation when Hugging Face's
          // quota endpoint is temporarily unavailable.
        }
        if (env.GENERATION_RATE_LIMIT) {
          const { success } = await env.GENERATION_RATE_LIMIT.limit({ key: "generate" });
          if (!success) {
            const limited = jsonResponse({ error: "The shared generator is busy. Wait a minute and try again." }, 429);
            limited.headers.set("Retry-After", "60");
            return withCors(limited, origin, env);
          }
        }
        const result = await handleGenerate(req, env);
        return withCors(result, origin, env);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return withCors(jsonResponse({ error: msg }, 500), origin, env);
      }
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return withCors(jsonResponse({ ok: true, configured: Boolean(env.HF_TOKEN?.trim()) }), origin, env);
    }

    if (req.method === "GET" && url.pathname === "/quota") {
      try {
        const result = await handleQuota(env);
        return withCors(result, origin, env);
      } catch {
        return withCors(jsonResponse({ error: "Could not check Hugging Face GPU allowance." }, 502), origin, env);
      }
    }

    if (req.method === "GET" && url.pathname === "/download") {
      try {
        const result = await handleDownload(url.searchParams.get("url"), env);
        return withCors(result, origin, env);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return withCors(jsonResponse({ error: msg }, 502), origin, env);
      }
    }

    return withCors(jsonResponse({ error: "Not found" }, 404), origin, env);
  },
} satisfies ExportedHandler<Env>;

/**
 * Core flow: upload image, submit job, then stream the upstream SSE through
 * to the browser. Worker does the fast bits (upload, submit) and then steps
 * out of the way for the slow bit (waiting for the video).
 *
 * Why streaming instead of holding the request: Cloudflare Workers count
 * wall-clock time when the Worker reads from a fetch response. For long
 * generations (5s+ video) that pushed us over the limit. By returning the
 * upstream body as our response body, Cloudflare just pipes bytes between
 * the upstream and the browser, no CPU charged to us, no timeout we can hit.
 * The browser then parses SSE events and finds the "complete" event to grab
 * the video URL.
 */
async function handleGenerate(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  // workers-types declares FormData.get as returning `string | null`, which is
  // narrower than the runtime: a file part really does come back as a File.
  // Going through `unknown` lets the instanceof below do the narrowing instead
  // of a declaration that is missing a case.
  const image = form.get("image") as unknown;
  const paramsRaw = form.get("params");

  if (!(image instanceof File)) {
    return jsonResponse({ error: "Missing 'image' form field" }, 400);
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(image.type)) {
    return jsonResponse({ error: "Use a PNG, JPG, or WEBP image." }, 415);
  }
  if (image.size === 0) {
    return jsonResponse({ error: "The image is empty." }, 400);
  }
  if (image.size > 8 * 1024 * 1024) {
    return jsonResponse({ error: "Image must be 8 MB or smaller" }, 413);
  }

  // safeJsonParse hands back whatever was in the field, and "null", "5" and
  // "\"hi\"" are all valid JSON. Assigning any of those straight through meant
  // the next line could read .prompt off a null and throw a 500 at a caller
  // who only sent a slightly wrong body.
  const parsed = typeof paramsRaw === "string" ? safeJsonParse(paramsRaw) : null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return jsonResponse({ error: "Invalid generation settings." }, 400);
  }
  const userParams = parsed as UserParams;
  if (typeof userParams.prompt !== "string" || !userParams.prompt.trim()) {
    return jsonResponse({ error: "Write a motion prompt before generating." }, 400);
  }
  if (userParams.prompt.length > 1200) {
    return jsonResponse({ error: "Keep the motion prompt under 1,200 characters." }, 400);
  }
  if (userParams.duration_seconds !== undefined && !Number.isFinite(userParams.duration_seconds)) {
    return jsonResponse({ error: "Duration must be a number." }, 400);
  }
  if (userParams.steps !== undefined && !Number.isFinite(userParams.steps)) {
    return jsonResponse({ error: "Inference steps must be a number." }, 400);
  }

  // Fast steps. Each is a single short HTTP call, well under any limit.
  const imageRef = await uploadImageToSpace(image, env);
  const eventId = await submitJob(imageRef, image.name, userParams, env);

  // Open the SSE stream upstream. Don't consume the body, we hand it
  // straight to the browser.
  const upstream = await fetch(
    `${env.HF_SPACE_BASE}/gradio_api/call/${env.HF_FN_NAME}/${eventId}`,
    { method: "GET", headers: { Accept: "text/event-stream", ...authHeaders(env) } },
  );
  if (!upstream.ok || !upstream.body) {
    throw await upstreamFailure(upstream, "Result stream");
  }

  // Return the upstream body directly. Cloudflare will pipe it. We add the
  // right headers so EventSource-style readers Just Work, and we disable
  // proxy/CDN buffering so events arrive promptly.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-HF-Space-Base": env.HF_SPACE_BASE,
    },
  });
}

interface ZeroGpuQuota {
  remainingSeconds: number;
  resetsAt: string | null;
  runsRemaining: number | null;
  runsLimit: number | null;
  runsResetsAt: string | null;
}

async function handleQuota(env: Env): Promise<Response> {
  if (!env.HF_TOKEN?.trim()) {
    return jsonResponse({ error: "Hugging Face token is not configured." }, 503);
  }
  const upstream = await fetch("https://huggingface.co/api/spaces/zero-gpu/quota", {
    headers: authHeaders(env),
  });
  if (upstream.status === 401 || upstream.status === 403) {
    return jsonResponse({ error: "This token cannot read its ZeroGPU allowance." }, 403);
  }
  if (!upstream.ok) {
    return jsonResponse({ error: "Hugging Face GPU allowance is temporarily unavailable." }, 502);
  }
  const data = await upstream.json() as {
    current?: unknown;
    resetsAt?: unknown;
    runs?: { remaining?: unknown; limit?: unknown; resetsAt?: unknown };
  };
  if (typeof data.current !== "number" || !Number.isFinite(data.current)) {
    return jsonResponse({ error: "Hugging Face returned an unexpected allowance response." }, 502);
  }
  const quota: ZeroGpuQuota = {
    remainingSeconds: Math.max(0, Math.floor(data.current)),
    resetsAt: typeof data.resetsAt === "string" ? data.resetsAt : null,
    runsRemaining: finiteCount(data.runs?.remaining),
    runsLimit: finiteCount(data.runs?.limit),
    runsResetsAt: typeof data.runs?.resetsAt === "string" ? data.runs.resetsAt : null,
  };
  const response = jsonResponse(quota);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : null;
}

async function handleDownload(rawUrl: string | null, env: Env): Promise<Response> {
  if (!rawUrl) return jsonResponse({ error: "Missing video URL." }, 400);

  let videoUrl: URL;
  try {
    videoUrl = new URL(rawUrl);
  } catch {
    return jsonResponse({ error: "Invalid video URL." }, 400);
  }
  const spaceOrigin = new URL(env.HF_SPACE_BASE).origin;
  if (
    videoUrl.origin !== spaceOrigin ||
    videoUrl.username || videoUrl.password || videoUrl.hash || videoUrl.search ||
    !videoUrl.pathname.startsWith("/gradio_api/file=") ||
    !videoUrl.pathname.toLowerCase().endsWith(".mp4")
  ) {
    return jsonResponse({ error: "This video URL is not from the configured Space." }, 400);
  }

  const upstream = await fetch(videoUrl.href, {
    method: "GET",
    headers: authHeaders(env),
    redirect: "manual",
  });
  if (!upstream.ok || !upstream.body) {
    throw await upstreamFailure(upstream, "Video download");
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="axom-vid-${Date.now()}.mp4"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Upload step. The Gradio /upload endpoint accepts multipart form data with
 * one or more files under the field name "files" and returns an array of
 * server-side paths like ["/tmp/gradio/abc.../filename.png"].
 *
 * We need that path in the next step because Gradio's /call endpoint expects
 * a "FileData" reference, not raw bytes.
 */
async function uploadImageToSpace(file: File, env: Env): Promise<string> {
  const fd = new FormData();
  fd.append("files", file, file.name || "input.png");

  const res = await fetch(`${env.HF_SPACE_BASE}/gradio_api/upload`, {
    method: "POST",
    headers: authHeaders(env),
    body: fd,
  });
  if (!res.ok) {
    throw await upstreamFailure(res, "Image upload");
  }
  const paths = (await res.json()) as string[];
  if (!Array.isArray(paths) || !paths[0]) {
    throw new Error("Upload returned an unexpected response shape.");
  }
  return paths[0];
}

/**
 * Submit the generation job. The data array must match the order of
 * `ui_inputs` in the Space's app.py. If the upstream Space ever reorders
 * its inputs, this list is the one place to fix.
 *
 * Sticking values into a named array first (rather than passing an object)
 * makes the order explicit and easy to audit against the upstream source.
 */
async function submitJob(
  imagePath: string,
  origName: string,
  params: UserParams,
  env: Env,
): Promise<string> {
  // FileData shape Gradio v4 expects when a path was returned by /upload.
  const inputImage = {
    path: imagePath,
    url: `${env.HF_SPACE_BASE}/gradio_api/file=${imagePath}`,
    orig_name: origName,
    size: null,
    mime_type: null,
    meta: { _type: "gradio.FileData" },
  };

  // Order matches Space's ui_inputs:
  // [input_image, last_image, prompt, steps, negative_prompt,
  //  duration_seconds, guidance_scale, guidance_scale_2, seed, randomize_seed,
  //  quality, scheduler, flow_shift, frame_multiplier, safe_mode, play_result_video]
  const data = [
    inputImage,
    null, // last_image, optional second keyframe, we don't expose this in the UI
    params.prompt?.trim() || "make this image come alive, cinematic motion, smooth animation",
    clampInt(params.steps ?? 3, 1, 12),
    DEFAULT_NEGATIVE_PROMPT,
    // Upper bound matches the slider in web/src/components/Studio.astro. The
    // Space reserves more ZeroGPU time for longer clips before they start.
    // The Worker is the public endpoint, so it enforces the UI's cap too.
    clampFloat(params.duration_seconds ?? 1.5, 0.5, 4.5),
    1,    // guidance_scale (kept at 1, higher values double GPU usage for marginal gains here)
    1,    // guidance_scale_2
    42,   // seed (ignored when randomize_seed=true)
    true, // randomize_seed
    6,    // quality
    "UniPCMultistep",
    3.0,  // flow_shift
    16,   // frame_multiplier (16 = no interpolation, the model's native FPS)
    false, // safe_mode
    true,  // play_result_video
  ];

  const res = await fetch(`${env.HF_SPACE_BASE}/gradio_api/call/${env.HF_FN_NAME}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(env) },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) {
    throw await upstreamFailure(res, "Job submission");
  }
  const body = (await res.json()) as { event_id?: string };
  if (!body.event_id) {
    throw new Error("Job submission returned no event_id.");
  }
  return body.event_id;
}

// SSE parsing and video-URL extraction used to live here, but they moved to
// the browser when we switched to streaming pass-through. Now the Worker just
// uploads, submits, and pipes; the browser does the SSE event parsing and
// finds the "complete" payload itself.

// ---------- Generic helpers ----------

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}
function clampFloat(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function authHeaders(env: Env): Record<string, string> {
  return env.HF_TOKEN?.trim() ? { Authorization: `Bearer ${env.HF_TOKEN.trim()}` } : {};
}

async function upstreamFailure(res: Response, stage: string): Promise<Error> {
  if (res.status === 401 || res.status === 403) {
    return new Error("Hugging Face rejected the configured token. The site owner should check HF_TOKEN.");
  }
  if (res.status === 429) {
    return new Error("Hugging Face GPU quota is exhausted. Try again after it resets.");
  }
  let detail = "";
  try {
    const body = await res.json() as { error?: unknown; message?: unknown };
    const value = body.error ?? body.message;
    if (typeof value === "string") detail = value.slice(0, 240);
  } catch {
    // A proxy can return HTML or an empty body instead of JSON.
  }
  return new Error(`${stage} failed (${res.status}).${detail ? ` ${detail}` : " The Space may be temporarily unavailable."}`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Attach CORS headers. We allow a configured set of origins via the
 * ALLOWED_ORIGINS env var (comma-separated). In production this should be
 * just the GitHub Pages URL; in dev it includes localhost.
 *
 * Echoing the request's Origin back (rather than a wildcard) lets the browser
 * send credentials if we ever need that, and keeps us off "tricked into being
 * an open proxy" Status Hacker News posts.
 */
function withCors(res: Response, origin: string, env: Env): Response {
  const headers = new Headers(res.headers);
  if (origin && isAllowedOrigin(origin, env)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Expose-Headers", "X-HF-Space-Base");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function isAllowedOrigin(origin: string, env: Env): boolean {
  if (env.ALLOWED_ORIGINS.split(",").some((allowed) => allowed.trim() === origin)) {
    return true;
  }
  // The public site's Cloudflare Worker is also used by the separately hosted
  // AXOM_VID local studio, which selects ports 8765–8775 as they become free.
  // Restrict CORS to those exact loopback HTTP origins; never use a wildcard
  // or accept arbitrary local/LAN domains. CORS is not an authentication layer.
  return /^http:\/\/(?:127\.0\.0\.1|localhost):(?:876[5-9]|877[0-5])$/.test(origin);
}
