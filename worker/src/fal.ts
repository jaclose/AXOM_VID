/**
 * Optional fal.ai video backend.
 * It is deliberately disabled until BOTH secrets are configured.
 * No route silently switches shared free jobs into billable jobs.
 */
export interface FalEnv {
  readonly FAL_KEY?: string;
  readonly PRIVATE_ACCESS_KEY?: string;
  readonly GENERATION_RATE_LIMIT?: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
}

const QUEUE_SUBMIT_URL = "https://queue.fal.run/fal-ai/wan/v2.2-5b/image-to-video";
const QUEUE_REQUEST_ROOT = "https://queue.fal.run/fal-ai/wan/requests/";
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function privateConfigured(env: FalEnv): boolean {
  return Boolean(env.FAL_KEY?.trim() && env.PRIVATE_ACCESS_KEY?.trim());
}

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function failure(message: string, status: number): Response {
  return responseJson({ error: message }, status);
}

function falAuth(env: FalEnv): Record<string, string> {
  return { Authorization: "Key " + env.FAL_KEY!.trim() };
}

function idFromUrl(url: URL): string | null {
  const id = url.searchParams.get("requestId");
  return id && REQUEST_ID.test(id) ? id : null;
}

function safeMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    const fromFal = url.hostname === "fal.media" || url.hostname.endsWith(".fal.media");
    const fromStorage = url.hostname === "storage.googleapis.com" && url.pathname.startsWith("/falserverless/");
    if ((!fromFal && !fromStorage) || !url.pathname.toLowerCase().endsWith(".mp4")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function falError(res: Response): Promise<Response> {
  if (res.status === 401 || res.status === 403) {
    return failure("Private provider rejected its API key. Check the FAL_KEY Cloudflare secret.", 502);
  }
  if (res.status === 402) return failure("Private provider requires billing credits.", 402);
  if (res.status === 429) return failure("Private provider is rate-limited. Try again shortly.", 429);
  let message = "Private provider returned status " + res.status + ".";
  try {
    const obj: unknown = await res.json();
    if (obj && typeof obj === "object") {
      const detail = (obj as { detail?: unknown; error?: unknown }).detail ??
        (obj as { detail?: unknown; error?: unknown }).error;
      if (typeof detail === "string" && detail.trim()) message += " " + detail.slice(0, 300);
    }
  } catch {
    // Provider failures may be empty or HTML; never forward raw upstream HTML.
  }
  return failure(message, res.status >= 400 && res.status < 500 ? res.status : 502);
}

function arrayBufferToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Avoid using one enormous spread argument, which exceeds the JS argument limit.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

async function submitPaidJob(req: Request, env: FalEnv): Promise<Response> {
  if (env.GENERATION_RATE_LIMIT) {
    const rate = await env.GENERATION_RATE_LIMIT.limit({ key: "private-generate" });
    if (!rate.success) {
      const res = failure("Private renderer is busy. Try again in one minute.", 429);
      res.headers.set("Retry-After", "60");
      return res;
    }
  }

  const form = await req.formData();
  const image = form.get("image") as unknown;
  if (!(image instanceof File)) return failure("Choose an image before generating.", 400);
  if (!["image/png", "image/jpeg", "image/webp"].includes(image.type)) return failure("Use a PNG, JPG, or WEBP image.", 415);
  if (image.size === 0 || image.size > MAX_IMAGE_BYTES) return failure("Image must be between 1 byte and 8 MB.", 413);

  const paramsRaw = form.get("params");
  let parsed: unknown;
  try { parsed = typeof paramsRaw === "string" ? JSON.parse(paramsRaw) : null; } catch { parsed = null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return failure("Invalid generation settings.", 400);
  const params = parsed as { prompt?: unknown; duration_seconds?: unknown; steps?: unknown };
  if (typeof params.prompt !== "string" || !params.prompt.trim() || params.prompt.length > 1200) {
    return failure("Write a motion prompt of 1 to 1,200 characters.", 400);
  }
  if (typeof params.duration_seconds !== "number" || !Number.isFinite(params.duration_seconds)
      || params.duration_seconds < 1 || params.duration_seconds > 5) {
    return failure("Private video duration must be 1 to 5 seconds.", 400);
  }
  if (typeof params.steps !== "number" || !Number.isInteger(params.steps)
      || params.steps < 20 || params.steps > 40) {
    return failure("Private rendering requires 20 to 40 inference steps.", 400);
  }

  const imageBytes = new Uint8Array(await image.arrayBuffer());
  const payload = {
    image_url: "data:" + image.type + ";base64," + arrayBufferToBase64(imageBytes),
    prompt: params.prompt.trim(),
    num_frames: Math.max(17, Math.min(121, Math.round(params.duration_seconds * 24) + 1)),
    frames_per_second: 24,
    num_inference_steps: params.steps,
    resolution: "720p",
    aspect_ratio: "auto",
  };
  const res = await fetch(QUEUE_SUBMIT_URL, {
    method: "POST",
    headers: { ...falAuth(env), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "manual",
  });
  if (!res.ok) return falError(res);
  const json = await res.json() as { request_id?: unknown };
  if (typeof json.request_id !== "string" || !REQUEST_ID.test(json.request_id)) {
    return failure("Provider did not return a valid request ID.", 502);
  }
  return responseJson({ requestId: json.request_id });
}

async function readQueue(env: FalEnv, id: string, suffix: string): Promise<Response> {
  // fal routes long-running jobs by the owning app (fal-ai/wan), not the
  // longer submit endpoint path. See its queued response URLs.
  return fetch(QUEUE_REQUEST_ROOT + id + suffix, {
    method: "GET",
    headers: falAuth(env),
    redirect: "manual",
  });
}

async function getResultMedia(env: FalEnv, id: string): Promise<
  { videoUrl: string } | Response
> {
  const res = await readQueue(env, id, "");
  if (!res.ok) return falError(res);
  const raw = await res.json() as { video?: { url?: unknown } };
  const url = safeMediaUrl(raw?.video?.url);
  if (!url) return failure("Provider returned an unsafe or missing video URL.", 502);
  return { videoUrl: url };
}

export async function handleFal(req: Request, env: FalEnv): Promise<Response> {
  if (!privateConfigured(env)) {
    return failure("Private rendering is disabled until the owner configures FAL_KEY and PRIVATE_ACCESS_KEY.", 503);
  }
  const provided = req.headers.get("X-AXOM-Access-Key");
  if (!provided || provided !== env.PRIVATE_ACCESS_KEY) {
    return failure("Private access code is invalid.", 401);
  }

  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname === "/fal/generate") return submitPaidJob(req, env);

  const id = idFromUrl(url);
  if (!id) return failure("Missing or invalid provider request ID.", 400);

  if (req.method === "GET" && url.pathname === "/fal/status") {
    const upstream = await readQueue(env, id, "/status");
    if (!upstream.ok) return falError(upstream);
    const data: unknown = await upstream.json();
    return responseJson(data);
  }
  if (req.method === "GET" && url.pathname === "/fal/result") {
    const result = await getResultMedia(env, id);
    return result instanceof Response ? result : responseJson(result);
  }
  if (req.method === "GET" && url.pathname === "/fal/download") {
    const result = await getResultMedia(env, id);
    if (result instanceof Response) return result;
    const media = await fetch(result.videoUrl, { method: "GET", redirect: "manual" });
    if (!media.ok || !media.body) return failure("Video download is not available.", 502);
    return new Response(media.body, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="axom-vid-private.mp4"',
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return failure("Private provider route not found.", 404);
}
