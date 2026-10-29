/**
 * studio.ts, client-side wiring for the AXOM_VID generator.
 *
 * Lifecycle:
 *   1. User drops or picks an image. We preview it and stash the File object.
 *   2. User types a prompt and tweaks duration/steps (optional).
 *   3. User clicks "Generate". We POST the image + prompt to our Worker.
 *   4. Worker uploads the image, submits the job, and streams the upstream
 *      Gradio SSE back to us. We parse events as they arrive.
 *   5. When we see "complete", we pull the video URL out and display it.
 *
 * Why streaming: long generations (5s+ video) push past Cloudflare's per-call
 * limit if the Worker tries to consume the SSE itself. By piping the upstream
 * stream through, the Worker spends ~zero CPU and the browser holds the open
 * connection, which has no comparable wall-clock cap.
 *
 * Why no framework: this is one form with about five interactive elements.
 * A vanilla module is faster to load, easier to read, and forces us to
 * understand each DOM update instead of letting React paper over the details.
 */

// Type-safe handle on the Worker URL injected at build time via import.meta.env.
// Use the deployed Worker by default so the local preview works immediately.
const WORKER_URL = import.meta.env.PUBLIC_WORKER_URL || "https://axomvidjd.jafardabbagh.workers.dev";

// ---------- DOM lookup helpers ----------

// querySelector with non-null assertion, every selector below is in our own
// HTML, so a missing element is a bug, not a runtime case we need to handle.
// Throwing early is more helpful than a silent null.
const $ = <T extends Element>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
};

const dropzone     = $<HTMLLabelElement>("[data-dropzone]");
const fileInput    = $<HTMLInputElement>("[data-file-input]");
const dropEmpty    = $<HTMLDivElement>("[data-dropzone-empty]");
const dropPreview  = $<HTMLImageElement>("[data-dropzone-preview]");
const promptEl     = $<HTMLTextAreaElement>("[data-prompt]");
const durationEl   = $<HTMLInputElement>("[data-duration]");
const durationVal  = $<HTMLSpanElement>("[data-duration-value]");
const stepsEl      = $<HTMLInputElement>("[data-steps]");
const stepsVal     = $<HTMLSpanElement>("[data-steps-value]");
const generateBtn  = $<HTMLButtonElement>("[data-generate]");
const buttonLabel  = $<HTMLSpanElement>("[data-button-label]");
const spinnerEl    = $<HTMLSpanElement>("[data-spinner]");
const statusEl     = $<HTMLParagraphElement>("[data-status]");
const quotaEl      = $<HTMLParagraphElement>("[data-quota]");
const serviceSelect = $<HTMLSelectElement>("[data-render-service]");
const serviceHelp   = $<HTMLParagraphElement>("[data-service-help]");
const privateKeyWrap = $<HTMLDivElement>("[data-private-key-wrap]");
const privateKeyEl   = $<HTMLInputElement>("[data-private-access-key]");
const durationHelp   = $<HTMLParagraphElement>("[data-duration-help]");
const stepsHelp      = $<HTMLParagraphElement>("[data-steps-help]");
const resultEmpty  = $<HTMLDivElement>("[data-result-empty]");
const resultLoad   = $<HTMLDivElement>("[data-result-loading]");
const resultError  = $<HTMLDivElement>("[data-result-error]");
const errorTitle   = $<HTMLElement>("[data-error-title]");
const errorDetail  = $<HTMLElement>("[data-error-detail]");
const retryBtn     = $<HTMLButtonElement>("[data-retry]");
const cancelBtn    = $<HTMLButtonElement>("[data-cancel]");
const removeBtn    = $<HTMLButtonElement>("[data-remove-image]");
const loadingMsg   = $<HTMLParagraphElement>("[data-loading-message]");
const elapsedEl    = $<HTMLElement>("[data-loading-elapsed]");
const resultVideo  = $<HTMLVideoElement>("[data-result-video]");
const downloadLink = $<HTMLAnchorElement>("[data-download]");
const historyWrap  = $<HTMLDivElement>("[data-history-wrap]");
const historyList  = $<HTMLUListElement>("[data-history]");

// ---------- Local state ----------

// Kept in a tiny mutable object so handlers can read/write it without
// chasing globals. For one screen this is fine, a state machine would
// be overkill.
const state = {
  file: null as File | null,
  busy: false,
  controller: null as AbortController | null,
  cancelReason: null as "user" | "timeout" | null,
};

interface GpuQuota {
  remainingSeconds: number;
  resetsAt: string | null;
  runsRemaining: number | null;
  runsLimit: number | null;
  runsResetsAt: string | null;
}

let quotaRequestId = 0;
let privateAvailable = false;
let privateVideoRequestId: string | null = null;

function resetLabel(timestamp: string | null): string {
  if (!timestamp || Number.isNaN(Date.parse(timestamp)) || Date.parse(timestamp) <= Date.now()) return "";
  return ` Resets ${new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(timestamp))}.`;
}

function quotaBlock(quota: GpuQuota): string | null {
  if (quota.runsRemaining !== null && quota.runsRemaining <= 0) {
    return `All ${quota.runsLimit ?? "available"} shared GPU runs are used.${resetLabel(quota.runsResetsAt ?? quota.resetsAt)} Your image and prompt are still here.`;
  }
  if (quota.remainingSeconds <= 0) {
    return `The shared Hugging Face account has used its GPU time.${resetLabel(quota.resetsAt)} Your image and prompt are still here.`;
  }
  return null;
}

async function refreshQuota(): Promise<GpuQuota | null> {
  if (serviceSelect.value === "private") return null;
  const requestId = ++quotaRequestId;
  try {
    const response = await fetch(`${WORKER_URL}/quota`, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error("GPU allowance unavailable");
    const value: unknown = await response.json();
    if (!value || typeof value !== "object") throw new Error("Unexpected GPU allowance response");
    const data = value as Record<string, unknown>;
    if (typeof data.remainingSeconds !== "number" || !Number.isFinite(data.remainingSeconds)) {
      throw new Error("Unexpected GPU allowance response");
    }
    const quota: GpuQuota = {
      remainingSeconds: Math.max(0, Math.floor(data.remainingSeconds)),
      resetsAt: typeof data.resetsAt === "string" ? data.resetsAt : null,
      runsRemaining: typeof data.runsRemaining === "number" && Number.isFinite(data.runsRemaining) ? Math.max(0, Math.floor(data.runsRemaining)) : null,
      runsLimit: typeof data.runsLimit === "number" && Number.isFinite(data.runsLimit) ? Math.max(0, Math.floor(data.runsLimit)) : null,
      runsResetsAt: typeof data.runsResetsAt === "string" ? data.runsResetsAt : null,
    };
    if (requestId === quotaRequestId && serviceSelect.value === "shared") {
      const blocked = quotaBlock(quota);
      quotaEl.dataset.state = blocked ? "empty" : "ready";
      quotaEl.textContent = blocked
        ? blocked.replace(" Your image and prompt are still here.", "")
        : `Shared GPU: ${quota.runsRemaining === null ? "" : `${quota.runsRemaining} run${quota.runsRemaining === 1 ? "" : "s"} left · `}${quota.remainingSeconds} seconds of GPU time left.${resetLabel(quota.runsResetsAt ?? quota.resetsAt)}`;
    }
    return quota;
  } catch {
    if (requestId === quotaRequestId && serviceSelect.value === "shared") {
      quotaEl.dataset.state = "unknown";
      quotaEl.textContent = "Shared GPU allowance is unavailable. You can still try generating.";
    }
    return null;
  }
}

// ---------- File handling ----------

/**
 * Accept a File, validate it, and update the preview.
 * Rejecting early with a status message is friendlier than letting a bad
 * file reach the Worker and bouncing back as an opaque error.
 */
function acceptFile(file: File) {
  const MAX_BYTES = 8 * 1024 * 1024; // 8 MB. HF Spaces choke on much larger uploads.
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    setStatus("That doesn't look like an image. PNG, JPG, or WEBP please.", "error");
    return;
  }
  if (file.size === 0) {
    setStatus("That image is empty. Choose another file.", "error");
    return;
  }
  if (file.size > MAX_BYTES) {
    setStatus("Image is over 8 MB. Try compressing it.", "error");
    return;
  }

  state.file = file;
  removeBtn.classList.remove("hidden");
  if (!resultError.classList.contains("hidden")) showResultState("empty");

  // Show a preview by reading the file as a data URL.
  // URL.createObjectURL would be marginally faster, but a data URL means we
  // don't have to remember to revokeObjectURL later.
  const reader = new FileReader();
  reader.onload = () => {
    if (state.file !== file) return;
    dropPreview.src = reader.result as string;
    dropPreview.classList.remove("hidden");
    dropEmpty.classList.add("hidden");
  };
  reader.readAsDataURL(file);

  refreshGenerateButton();
  setStatus("Ready. Write a prompt and click generate.");
}

removeBtn.addEventListener("click", () => {
  if (state.busy) return;
  state.file = null;
  fileInput.value = "";
  dropPreview.removeAttribute("src");
  dropPreview.classList.add("hidden");
  dropEmpty.classList.remove("hidden");
  removeBtn.classList.add("hidden");
  if (!resultError.classList.contains("hidden")) showResultState("empty");
  refreshGenerateButton();
  setStatus("Add an image to start.");
});

// Click-to-browse (handled by the <input> being inside the <label>) just needs
// us to listen to the file input's change event.
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) acceptFile(f);
});

// Drag-and-drop. We prevent the default on dragover so the browser doesn't
// open the image in a new tab when dropped.
["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.setAttribute("data-active", "true");
  }),
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, () => dropzone.setAttribute("data-active", "false")),
);
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) acceptFile(f);
});

// Paste an image from the clipboard. Nice ergonomic win on Windows where you
// can hit Shift+Win+S and paste straight in.
window.addEventListener("paste", (e: ClipboardEvent) => {
  const f = e.clipboardData?.files?.[0];
  if (f) acceptFile(f);
});

// ---------- Slider value display ----------

// Wire the duration/steps sliders to their numeric readouts. Simple input
// listeners, but defined as a helper so we don't repeat ourselves.
function bindRange(input: HTMLInputElement, display: HTMLSpanElement, suffix = "") {
  const sync = () => (display.textContent = input.value + suffix);
  input.addEventListener("input", sync);
  sync();
}
bindRange(durationEl, durationVal, "s");
bindRange(stepsEl, stepsVal);

promptEl.addEventListener("input", refreshGenerateButton);

privateKeyEl.addEventListener("input", refreshGenerateButton);

async function checkPrivateProvider(): Promise<void> {
  serviceHelp.textContent = "Checking private provider configuration…";
  privateAvailable = false;
  refreshGenerateButton();
  try {
    const response = await fetch(WORKER_URL + "/health", { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error("Service health unavailable");
    const data = await response.json() as { privateConfigured?: unknown };
    if (serviceSelect.value !== "private") return;
    privateAvailable = data.privateConfigured === true;
    serviceHelp.textContent = privateAvailable
      ? "Private GPU configured. Requires your access code; each submitted video is billable."
      : "Private GPU is not enabled. The owner must configure FAL_KEY and PRIVATE_ACCESS_KEY in Cloudflare first.";
  } catch {
    if (serviceSelect.value !== "private") return;
    serviceHelp.textContent = "Could not check the private GPU configuration. Try selecting the mode again.";
  }
  refreshGenerateButton();
}

serviceSelect.addEventListener("change", () => {
  const isPrivate = serviceSelect.value === "private";
  privateKeyWrap.classList.toggle("hidden", !isPrivate);
  durationEl.min = isPrivate ? "1" : "0.5";
  durationEl.max = isPrivate ? "5" : "4.5";
  durationEl.value = isPrivate ? "3" : "1.5";
  stepsEl.min = isPrivate ? "20" : "1";
  stepsEl.max = isPrivate ? "40" : "12";
  stepsEl.value = isPrivate ? "30" : "3";
  durationHelp.textContent = isPrivate
    ? "Private Wan 2.2 5B supports 1–5 seconds. The provider charges per generated clip."
    : "Shorter clips usually finish sooner on a shared GPU.";
  stepsHelp.textContent = isPrivate
    ? "20–40 steps. More steps can improve detail but increase render time."
    : "More steps may improve detail, but take longer.";
  durationEl.dispatchEvent(new Event("input"));
  stepsEl.dispatchEvent(new Event("input"));
  if (isPrivate) {
    quotaEl.dataset.state = "unknown";
    quotaEl.textContent = "Private GPU: no shared ZeroGPU daily-run cap. Pay per submitted render.";
    void checkPrivateProvider();
  } else {
    serviceHelp.textContent = "Shared Hugging Face GPU. Daily run limits apply to everyone using this site.";
    void refreshQuota();
  }
  refreshGenerateButton();
});


// ---------- UI state helpers ----------

function refreshGenerateButton() {
  const ready = !!state.file && promptEl.value.trim().length > 0 && !state.busy &&
    (serviceSelect.value !== "private" || (privateAvailable && privateKeyEl.value.trim().length > 0));
  generateBtn.disabled = !ready;
}

type StatusTone = "info" | "error" | "success";
function setStatus(text: string, tone: StatusTone = "info") {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function setBusy(busy: boolean) {
  state.busy = busy;
  spinnerEl.classList.toggle("hidden", !busy);
  serviceSelect.disabled = busy;
  privateKeyEl.disabled = busy;
  buttonLabel.textContent = busy ? "Generating..." : "Generate video";
  refreshGenerateButton();
}

function showResultState(s: "empty" | "loading" | "ready" | "error") {
  resultEmpty.classList.toggle("hidden", s !== "empty");
  resultLoad.classList.toggle("hidden", s !== "loading");
  resultError.classList.toggle("hidden", s !== "error");
  resultVideo.classList.toggle("hidden", s !== "ready");
  downloadLink.classList.toggle("hidden", s !== "ready");
}

// ---------- Generate flow ----------

generateBtn.addEventListener("click", runGeneration);
retryBtn.addEventListener("click", runGeneration);
cancelBtn.addEventListener("click", () => {
  state.cancelReason = "user";
  state.controller?.abort();
});

async function runGeneration(): Promise<void> {
  if (serviceSelect.value === "private") return runPrivateGeneration();
  if (!state.file || state.busy || !promptEl.value.trim()) return;

  let blockedAtPreflight: GpuQuota | null = null;
  const controller = new AbortController();
  state.controller = controller;
  state.cancelReason = null;
  const timeout = window.setTimeout(() => {
    state.cancelReason = "timeout";
    controller.abort();
  }, 8 * 60 * 1000);
  const stopElapsed = startElapsedTimer();

  setBusy(true);
  showResultState("loading");
  loadingMsg.textContent = "Checking shared GPU allowance…";
  setStatus("Checking shared GPU allowance before submitting.");
  resultVideo.pause();

  try {
    const quota = await refreshQuota();
    const blocked = quota && quotaBlock(quota);
    if (blocked) {
      blockedAtPreflight = quota;
      throw new Error(blocked);
    }
    loadingMsg.textContent = "Uploading image and submitting the job…";
    setStatus("Submitting to the shared GPU. You can cancel while it runs.");

    const form = new FormData();
    form.append("image", state.file);
    form.append("params", JSON.stringify({
      prompt: promptEl.value.trim(),
      duration_seconds: Number(durationEl.value),
      steps: Number(stepsEl.value),
    }));

    const res = await fetch(`${WORKER_URL}/generate`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(await readErrorMessage(res));

    loadingMsg.textContent = "Waiting for a shared GPU…";
    const spaceBase = res.headers.get("X-HF-Space-Base") || HF_SPACE_BASE;
    const videoUrl = await consumeSseUntilComplete(res.body, spaceBase, (event) => {
      if (event === "generating") loadingMsg.textContent = "Generating frames on the GPU…";
      if (event === "estimation" || event === "pending") loadingMsg.textContent = "Waiting in the GPU queue…";
    });

    privateVideoRequestId = null;
    resultVideo.src = videoUrl;
    downloadLink.href = downloadUrl(videoUrl);
    downloadLink.setAttribute("download", `axom-vid-${Date.now()}.mp4`);
    showResultState("ready");
    setStatus("Video ready. Use Download MP4 to save it.", "success");
    addToHistory(videoUrl);
    void refreshQuota();
  } catch (err) {
    if (controller.signal.aborted && state.cancelReason === "user") {
      showResultState("empty");
      setStatus("Stopped waiting for this result. The GPU job may continue in the background.");
    } else {
      const latestQuota = blockedAtPreflight ?? await refreshQuota();
      const message = state.cancelReason === "timeout"
        ? "No result arrived after eight minutes. The shared GPU may be stalled; try again later."
        : describeFailure(err, latestQuota);
      const allowanceUsed = latestQuota && quotaBlock(latestQuota);
      errorTitle.textContent = allowanceUsed ? "Daily GPU limit reached" : "Generation stopped";
      errorDetail.textContent = message;
      retryBtn.textContent = allowanceUsed ? "Check again" : "Try again";
      showResultState("error");
      setStatus(allowanceUsed ? "Shared GPU allowance is used. See the reset time below." : "Generation stopped. See the result panel for details.", "error");
    }
  } finally {
    window.clearTimeout(timeout);
    stopElapsed();
    state.controller = null;
    state.cancelReason = null;
    setBusy(false);
  }
}


/**
 * Explicitly opted-in, owner-authorized provider. There is no automatic
 * fallback from shared quota to a paid job. The access code lives only in the
 * current tab; it is not stored in localStorage, a cookie, or an image.
 */
async function paidFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-AXOM-Access-Key", privateKeyEl.value.trim());
  return fetch(WORKER_URL + path, { ...init, headers });
}

async function pollDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Stopped waiting", "AbortError")); return; }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    const cancel = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Stopped waiting", "AbortError"));
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

async function preparePrivateImage(file: File): Promise<File> {
  // Smaller image payloads save Worker CPU and avoid multi-megabyte base64
  // uploads. Preserve aspect ratio, never upscale, and keep originals local.
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) { bitmap.close(); return file; }
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ? new File([blob], "axom-input.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

async function runPrivateGeneration(): Promise<void> {
  if (!state.file || state.busy || !promptEl.value.trim() || !privateAvailable || !privateKeyEl.value.trim()) return;

  const controller = new AbortController();
  state.controller = controller;
  state.cancelReason = null;
  const timeout = window.setTimeout(() => {
    state.cancelReason = "timeout";
    controller.abort();
  }, 12 * 60 * 1000);
  const stopElapsed = startElapsedTimer();
  setBusy(true);
  showResultState("loading");
  loadingMsg.textContent = "Submitting to private video GPU…";
  cancelBtn.textContent = "Stop watching (render may still be charged)";
  setStatus("Private rendering is billed per submitted job. It will not consume shared Hugging Face runs.");
  resultVideo.pause();

  try {
    const form = new FormData();
    form.append("image", await preparePrivateImage(state.file));
    form.append("params", JSON.stringify({
      prompt: promptEl.value.trim(),
      duration_seconds: Number(durationEl.value),
      steps: Number(stepsEl.value),
    }));
    const submitted = await paidFetch("/fal/generate", {
      method: "POST", body: form, signal: controller.signal,
    });
    if (!submitted.ok) throw new Error(await readErrorMessage(submitted));
    const submission = await submitted.json() as { requestId?: unknown };
    if (typeof submission.requestId !== "string") throw new Error("Private provider returned no request ID.");
    const requestId = submission.requestId;
    loadingMsg.textContent = "Waiting in private GPU queue…";

    while (true) {
      await pollDelay(3500, controller.signal);
      const statusResponse = await paidFetch("/fal/status?requestId=" + encodeURIComponent(requestId), {
        signal: controller.signal,
      });
      if (!statusResponse.ok) throw new Error(await readErrorMessage(statusResponse));
      const status = await statusResponse.json() as {
        status?: string; queue_position?: number; error?: string; error_type?: string;
      };
      if (status.status === "IN_QUEUE") {
        loadingMsg.textContent = typeof status.queue_position === "number"
          ? "Private GPU queue: " + status.queue_position + " jobs ahead"
          : "Waiting in private GPU queue…";
      } else if (status.status === "IN_PROGRESS") {
        loadingMsg.textContent = "Private GPU is rendering your frames…";
      } else if (status.status === "COMPLETED") {
        if (status.error || status.error_type) {
          throw new Error(status.error || ("Provider reported " + status.error_type));
        }
        break;
      } else {
        throw new Error("Unexpected private provider status.");
      }
    }

    const resultResponse = await paidFetch("/fal/result?requestId=" + encodeURIComponent(requestId), {
      signal: controller.signal,
    });
    if (!resultResponse.ok) throw new Error(await readErrorMessage(resultResponse));
    const result = await resultResponse.json() as { videoUrl?: unknown };
    if (typeof result.videoUrl !== "string") throw new Error("Provider finished but returned no playable MP4.");
    privateVideoRequestId = requestId;
    resultVideo.src = result.videoUrl;
    downloadLink.href = WORKER_URL + "/fal/download?requestId=" + encodeURIComponent(requestId);
    downloadLink.setAttribute("download", "axom-vid-private.mp4");
    showResultState("ready");
    addToHistory(result.videoUrl, requestId);
    setStatus("Private video ready. Use Download MP4 to save it.", "success");
  } catch (err) {
    if (controller.signal.aborted && state.cancelReason === "user") {
      showResultState("empty");
      setStatus("Stopped watching. The submitted job may still run and incur charges.");
    } else {
      errorTitle.textContent = "Private generation stopped";
      errorDetail.textContent = state.cancelReason === "timeout"
        ? "No result arrived after twelve minutes. The provider job may continue and incur charges."
        : describeFailure(err, null);
      retryBtn.textContent = "Try again (new paid job)";
      showResultState("error");
      setStatus("Private generation did not finish in this tab. A retry may incur another charge.", "error");
    }
  } finally {
    window.clearTimeout(timeout);
    stopElapsed();
    state.controller = null;
    state.cancelReason = null;
    cancelBtn.textContent = "Stop waiting";
    setBusy(false);
  }
}

// A normal cross-origin <a download> may open rather than download a video.
// Fetch through our authenticated Worker and create a temporary local blob.
downloadLink.addEventListener("click", async (event) => {
  if (!privateVideoRequestId) return;
  event.preventDefault();
  try {
    setStatus("Downloading private video…");
    const res = await paidFetch("/fal/download?requestId=" + encodeURIComponent(privateVideoRequestId));
    if (!res.ok) throw new Error(await readErrorMessage(res));
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = "axom-vid-private-" + Date.now() + ".mp4";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    setStatus("MP4 downloaded.", "success");
  } catch (err) {
    setStatus("Download failed: " + describeFailure(err, null), "error");
  }
});


function startElapsedTimer(): () => void {
  const started = performance.now();
  const update = () => {
    const seconds = Math.floor((performance.now() - started) / 1000);
    elapsedEl.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  update();
  const handle = window.setInterval(update, 1000);
  return () => window.clearInterval(handle);
}

const NO_UPSTREAM_DETAILS = "The video model stopped without giving a reason. The shared GPU may be busy; try again later.";

function describeFailure(err: unknown, quota: GpuQuota | null): string {
  const message = err instanceof Error ? err.message.trim() : String(err).trim();
  if (message === NO_UPSTREAM_DETAILS && quota) {
    return quotaBlock(quota) ?? `${message} Your image and prompt are still here.`;
  }
  if (err instanceof TypeError && /fetch|network/i.test(message)) {
    return "Could not reach the video service. Check your connection and try again.";
  }
  return message && message !== "null" && message !== "undefined"
    ? message
    : NO_UPSTREAM_DETAILS;
}

/**
 * Read the upstream Gradio SSE stream and return the video URL when the job
 * finishes. Gradio v4 emits events shaped like:
 *
 *   event: generating
 *   data: ...
 *
 *   event: complete
 *   data: [{path, url, ...}, ..., seed]
 *
 *   event: error
 *   data: "...message..."
 *
 * Events are blank-line delimited. We buffer raw bytes until we have a full
 * event, parse it, and act. Heartbeats and generating events update the
 * loading message but don't resolve.
 */
async function consumeSseUntilComplete(
  stream: ReadableStream<Uint8Array>,
  spaceBase: string,
  onProgress: (event: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // A blank line ends an event. Keep the trailing partial event for the
    // next read; Gradio may send either LF or CRLF line endings.
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const raw = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const evt = parseSseEvent(raw);
      if (!evt) continue;

      if (evt.name === "complete") {
        // data is the function's return tuple: [video_file, file_again, seed].
        // The first element is a Gradio FileData object containing `url`.
        let payload: unknown;
        try {
          payload = JSON.parse(evt.data);
        } catch {
          throw new Error("Upstream returned malformed result payload.");
        }
        const url = Array.isArray(payload)
          ? extractVideoUrl(payload[0], spaceBase) ?? extractVideoUrl(payload[1], spaceBase)
          : null;
        if (!url) throw new Error("Job finished but no video URL was returned.");
        return url;
      }

      if (evt.name === "error") {
        throw new Error(parseUpstreamError(evt.data));
      }

      onProgress(evt.name);
    }
  }

  // Stream closed without a "complete" event. This usually means the upstream
  // hit its own queue/wall-clock limit or the connection dropped.
  throw new Error("Connection closed before the video finished. Try again or shorten the duration.");
}

/** Parse a single SSE event chunk into { name, data }. */
function parseSseEvent(raw: string): { name: string; data: string } | null {
  let name = "message";
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      name = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  return { name, data: dataLines.join("\n") };
}

function parseUpstreamError(data: string): string {
  let detail: unknown = data;
  try {
    detail = JSON.parse(data);
  } catch {
    // Some upstream versions send plain text instead of JSON.
  }
  if (typeof detail === "string" && detail.trim() && detail.trim() !== "null") {
    return detail.trim();
  }
  if (detail && typeof detail === "object") {
    const payload = detail as { message?: unknown; error?: unknown };
    const message = payload.message ?? payload.error;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return NO_UPSTREAM_DETAILS;
}

// Hardcoded because the browser doesn't know the Space URL and we'd rather
// not round-trip just to fall back. If the upstream Space ever moves, this is
// the one constant to update.
const HF_SPACE_BASE = "https://cbensimon-wan2-2-fp8da-aoti-preview2.hf.space";

/**
 * Get a playable absolute URL from whatever Gradio returned. v4 wraps files
 * in FileData objects with `url` and `path`; older code returns bare strings.
 * Belt-and-suspenders so a Gradio upgrade upstream doesn't silently break us.
 */
function extractVideoUrl(fileData: unknown, spaceBase: string): string | null {
  if (!fileData) return null;
  if (typeof fileData === "string") {
    return `${spaceBase}/gradio_api/file=${fileData}`;
  }
  if (typeof fileData === "object") {
    const f = fileData as { url?: string; path?: string };
    if (f.url) return f.url;
    if (f.path) return `${spaceBase}/gradio_api/file=${f.path}`;
  }
  return null;
}

function downloadUrl(videoUrl: string): string {
  return `${WORKER_URL}/download?url=${encodeURIComponent(videoUrl)}`;
}

/**
 * Read an error message from a Response. The Worker sends `{error: string}`
 * but if something deeper barfs (CORS, gateway, network), we'll just get text.
 * Either way, return something printable.
 */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.clone().json();
    if (body && typeof body.error === "string") return body.error;
  } catch {
    /* fallthrough */
  }
  const text = await res.text().catch(() => "");
  return text || `${res.status} ${res.statusText}`;
}

// ---------- History ----------

function addToHistory(url: string, privateRequestId: string | null = null) {
  historyWrap.classList.remove("hidden");
  const li = document.createElement("li");
  li.className = "shrink-0";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "history-item";
  button.setAttribute("aria-label", `Show generated clip ${historyList.children.length + 1}`);
  const v = document.createElement("video");
  v.src = url;
  v.muted = true;
  v.loop = true;
  v.playsInline = true;
  v.className = "history-video";
  // Show a frame on hover. Cheap UX win, no thumbnailing required.
  button.addEventListener("mouseenter", () => v.play().catch(() => {}));
  button.addEventListener("mouseleave", () => {
    v.pause();
    v.currentTime = 0;
  });
  // Click to bring it back into the main result slot.
  button.addEventListener("click", () => {
    privateVideoRequestId = privateRequestId;
    resultVideo.src = url;
    downloadLink.href = privateRequestId ? `${WORKER_URL}/fal/download?requestId=${encodeURIComponent(privateRequestId)}` : downloadUrl(url);
    showResultState("ready");
  });
  button.appendChild(v);
  li.appendChild(button);
  historyList.prepend(li);
}

// Initial UI state
showResultState("empty");
refreshGenerateButton();
void refreshQuota();
