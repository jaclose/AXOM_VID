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
const LOCAL_STUDIO = ["localhost", "127.0.0.1"].includes(window.location.hostname) && window.location.port === "8765";

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
const engineEl      = $<HTMLSelectElement>("[data-engine]");
const engineHelp    = $<HTMLParagraphElement>("[data-engine-help]");
const localOpen     = $<HTMLParagraphElement>("[data-local-open]");
const localCheck    = $<HTMLButtonElement>("[data-local-check]");
const localDuration = $<HTMLSelectElement>("[data-local-duration]");
const localSettings = $<HTMLDivElement>("[data-local-settings]");
const localBatch = $<HTMLSelectElement>("[data-local-batch]");
const localQuality = $<HTMLSelectElement>("[data-local-quality]");
const localVariations = $<HTMLTextAreaElement>("[data-local-variations]");
const localHint = $<HTMLParagraphElement>("[data-local-hint]");
const localQueueWrap = $<HTMLDivElement>("[data-local-queue]");
const localJobList = $<HTMLUListElement>("[data-local-job-list]");
const queueRefresh = $<HTMLButtonElement>("[data-queue-refresh]");
const gifButton = $<HTMLButtonElement>("[data-gif-download]");
const gifSettings = $<HTMLDivElement>("[data-gif-settings]");
const gifSeconds = $<HTMLSelectElement>("[data-gif-seconds]");
const gifWidth = $<HTMLSelectElement>("[data-gif-width]");
const gifFps = $<HTMLSelectElement>("[data-gif-fps]");
const durationHelp  = $<HTMLParagraphElement>("[data-duration-help]");
const stepsHelp     = $<HTMLParagraphElement>("[data-steps-help]");
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
let localEngineReady = false;
let localCheckId = 0;

type LocalJobStatus = "queued" | "running" | "done" | "failed" | "error";
interface LocalJob {
  id: string;
  status: LocalJobStatus;
  label: string;
  duration: number;
  message?: string;
}
const LOCAL_QUEUE_KEY = "AXOM_VID_LOCAL_JOBS_V2";
const localJobs: LocalJob[] = [];
let selectedLocalJobId: string | null = null;
let localPollTimer: number | null = null;
let localPollBusy = false;

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
  if (engineEl.value === "local") return null;
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
    if (requestId === quotaRequestId && engineEl.value === "shared") {
      const blocked = quotaBlock(quota);
      quotaEl.dataset.state = blocked ? "empty" : "ready";
      quotaEl.textContent = blocked
        ? blocked.replace(" Your image and prompt are still here.", "")
        : `Shared GPU: ${quota.runsRemaining === null ? "" : `${quota.runsRemaining} run${quota.runsRemaining === 1 ? "" : "s"} left · `}${quota.remainingSeconds} seconds of GPU time left.${resetLabel(quota.runsResetsAt ?? quota.resetsAt)}`;
    }
    return quota;
  } catch {
    if (requestId === quotaRequestId && engineEl.value === "shared") {
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
localDuration.addEventListener("change", () => {
  durationVal.textContent = localDuration.value + "s";
  const seconds = Number(localDuration.value);
  localHint.textContent = seconds >= 30
    ? "Long take: Phosphene will chain several 10-second renders. This may take many hours on an 18 GB Mac."
    : "Local jobs run sequentially on your Mac. Try 3–5 seconds first on 18 GB of memory.";
});
localBatch.addEventListener("change", refreshGenerateButton);
localVariations.addEventListener("input", refreshGenerateButton);
queueRefresh.addEventListener("click", () => { void pollLocalJobs(); });
gifButton.addEventListener("click", () => { if (selectedLocalJobId) void downloadLocalGif(selectedLocalJobId); });

engineEl.addEventListener("change", applyEngineMode);
localCheck.addEventListener("click", () => { void checkLocalEngine(); });

function applyEngineMode(): void {
  const local = engineEl.value === "local";
  localOpen.classList.toggle("hidden", !local || LOCAL_STUDIO);
  localCheck.classList.toggle("hidden", !local || !LOCAL_STUDIO);
  localSettings.classList.toggle("hidden", !local);
  localDuration.classList.toggle("hidden", !local);
  durationEl.classList.toggle("hidden", local);
  durationEl.disabled = local;
  gifSettings.classList.toggle("hidden", !local || !selectedLocalJobId);
  gifButton.classList.toggle("hidden", !local || !selectedLocalJobId);
  durationEl.min = "0.5";
  durationEl.max = "4.5";
  durationEl.step = "0.1";
  durationEl.value = "1.5";
  stepsEl.min = local ? "8" : "1";
  stepsEl.max = local ? "8" : "12";
  stepsEl.value = local ? "8" : "3";
  stepsEl.disabled = local;
  durationHelp.textContent = local
    ? "3–10-second clips or chained 30–120-second takes. Long takes render as 10-second parts."
    : "Shorter clips usually finish sooner on a shared GPU.";
  stepsHelp.textContent = local
    ? "Phosphene handles local inference steps. Quality and batch size are configurable below."
    : "More steps may improve detail, but take longer.";
  localDuration.dispatchEvent(new Event("change"));
  durationEl.dispatchEvent(new Event("input"));
  if (local) durationVal.textContent = localDuration.value + "s";
  stepsEl.dispatchEvent(new Event("input"));
  if (local) {
    quotaEl.dataset.state = "unknown";
    quotaEl.textContent = "Local Mac: no daily run quota or per-render API fees. Uses your Mac GPU, SSD and electricity.";
    engineHelp.textContent = LOCAL_STUDIO
      ? "Checking the Phosphene video engine installed on this Mac…"
      : "Start AXOM_VID's local studio on your Mac; the public site cannot access your local GPU.";
    if (LOCAL_STUDIO) void checkLocalEngine();
  } else {
    engineHelp.textContent = "Shared Hugging Face GPU: limited daily allowance.";
    void refreshQuota();
  }
  buttonLabel.textContent = local ? "Queue local renders" : "Generate video";
  refreshGenerateButton();
}

async function checkLocalEngine(): Promise<void> {
  if (!LOCAL_STUDIO || engineEl.value !== "local") return;
  const reqId = ++localCheckId;
  localEngineReady = false;
  engineHelp.textContent = "Checking Phosphene on http://127.0.0.1:8198…";
  quotaEl.dataset.state = "unknown";
  quotaEl.textContent = "Local GPU · unlimited attempts · no provider charges";
  refreshGenerateButton();
  try {
    const res = await fetch("/local/health", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(await readErrorMessage(res));
    const data: unknown = await res.json();
    if (!data || typeof data !== "object") throw new Error("Invalid local engine response.");
    if (reqId !== localCheckId || engineEl.value !== "local") return;
    const value = data as { online?: boolean; error?: string; busy?: boolean; queued?: number };
    localEngineReady = value.online === true;
    if (localEngineReady) void pollLocalJobs();
    engineHelp.textContent = localEngineReady
      ? "Phosphene connected. Your image stays on this Mac. Local model output may take several minutes."
      : value.error || "Start Phosphene in Pinokio, then click Check local engine.";
    quotaEl.dataset.state = localEngineReady ? "ready" : "empty";
    quotaEl.textContent = localEngineReady
      ? "Local GPU ready · no daily limit · " + (value.busy ? "GPU busy" : "GPU idle") +
        (typeof value.queued === "number" ? " · " + value.queued + " queued" : "")
      : "Local renderer offline. Start Phosphene to generate without provider quotas.";
  } catch {
    if (reqId !== localCheckId || engineEl.value !== "local") return;
    engineHelp.textContent = "Cannot reach the local bridge. Run local/start.command in AXOM_VID.";
    quotaEl.dataset.state = "empty";
    quotaEl.textContent = "Local connection unavailable.";
  }
  refreshGenerateButton();
}


// ---------- UI state helpers ----------

function refreshGenerateButton() {
  const ready = !!state.file && promptEl.value.trim().length > 0 && !state.busy &&
    (engineEl.value === "shared" || (LOCAL_STUDIO && localEngineReady));
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
  engineEl.disabled = busy;
  buttonLabel.textContent = busy ? (engineEl.value === "local" ? "Queueing..." : "Generating...")
    : (engineEl.value === "local" ? "Queue local renders" : "Generate video");
  refreshGenerateButton();
}

function showResultState(s: "empty" | "loading" | "ready" | "error") {
  resultEmpty.classList.toggle("hidden", s !== "empty");
  resultLoad.classList.toggle("hidden", s !== "loading");
  resultError.classList.toggle("hidden", s !== "error");
  resultVideo.classList.toggle("hidden", s !== "ready");
  downloadLink.classList.toggle("hidden", s !== "ready");
  const showGif = s === "ready" && engineEl.value === "local" && !!selectedLocalJobId;
  gifButton.classList.toggle("hidden", !showGif);
  gifSettings.classList.toggle("hidden", !showGif);
}

// ---------- Generate flow ----------

generateBtn.addEventListener("click", runGeneration);
retryBtn.addEventListener("click", runGeneration);
cancelBtn.addEventListener("click", () => {
  state.cancelReason = "user";
  state.controller?.abort();
});

async function runGeneration(): Promise<void> {
  if (engineEl.value === "local") return runLocalGeneration();
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


async function localDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException("Stopped watching", "AbortError");
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      signal.removeEventListener("abort", cancelled);
      resolve();
    };
    const timer = window.setTimeout(done, ms);
    const cancelled = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Stopped watching", "AbortError"));
    };
    signal.addEventListener("abort", cancelled, { once: true });
  });
}

async function runLocalGeneration(): Promise<void> {
  if (!LOCAL_STUDIO || !localEngineReady || !state.file || state.busy || !promptEl.value.trim()) return;
  const controller = new AbortController();
  state.controller = controller;
  state.cancelReason = null;
  const timeout = window.setTimeout(() => {
    state.cancelReason = "timeout";
    controller.abort();
  }, 2 * 60 * 60 * 1000);
  const stopElapsed = startElapsedTimer();
  setBusy(true);
  showResultState("loading");
  loadingMsg.textContent = "Submitting image to your Mac…";
  setStatus("Rendering locally with Phosphene. No Hugging Face account runs are used.");
  cancelBtn.textContent = "Stop watching (render continues)";
  resultVideo.pause();

  try {
    let orientation = "landscape";
    try {
      const bitmap = await createImageBitmap(state.file);
      if (bitmap.height > bitmap.width) orientation = "portrait";
      bitmap.close();
    } catch {
      // Image preview already handled decoding; use a landscape fallback.
    }
    const form = new FormData();
    form.append("image", state.file);
    form.append("params", JSON.stringify({
      prompt: promptEl.value.trim(),
      duration_seconds: Number(durationEl.value),
      orientation,
    }));
    const res = await fetch("/local/generate", {
      method: "POST", body: form, signal: controller.signal,
    });
    if (!res.ok) throw new Error(await readErrorMessage(res));
    const submission = await res.json() as { jobId?: unknown };
    if (typeof submission.jobId !== "string") throw new Error("Local renderer did not return a job ID.");
    const jobId = submission.jobId;
    loadingMsg.textContent = "Local GPU job queued…";

    while (true) {
      await localDelay(7500, controller.signal);
      const response = await fetch("/local/status?jobId=" + encodeURIComponent(jobId), {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await readErrorMessage(response));
      const job = await response.json() as {
        status?: string; message?: string; progress?: number;
        error?: string; videoUrl?: string;
      };
      if (job.status === "queued") {
        loadingMsg.textContent = "Waiting for your Mac GPU…";
      } else if (job.status === "running") {
        loadingMsg.textContent = job.message || (typeof job.progress === "number"
          ? "Rendering locally · " + job.progress + "%"
          : "Your Mac is generating video frames…");
      } else if (job.status === "done") {
        if (!job.videoUrl?.startsWith("/local/video?jobId=")) {
          throw new Error("The local renderer finished without a playable MP4.");
        }
        resultVideo.src = job.videoUrl;
        downloadLink.href = downloadUrl(job.videoUrl);
        downloadLink.setAttribute("download", "axom-local-" + Date.now() + ".mp4");
        showResultState("ready");
        addToHistory(job.videoUrl);
        setStatus("Local MP4 ready. Generated on your Mac with no per-video API fees.", "success");
        break;
      } else {
        throw new Error(job.error || "The local renderer stopped without producing video.");
      }
    }
  } catch (err) {
    if (controller.signal.aborted && state.cancelReason === "user") {
      showResultState("empty");
      setStatus("Stopped watching. Your Mac may keep rendering; find the video in Phosphene's Outputs.");
    } else {
      errorTitle.textContent = "Local generation stopped";
      errorDetail.textContent = state.cancelReason === "timeout"
        ? "No video arrived after two hours. Check the Phosphene panel for the job's status."
        : describeFailure(err, null);
      retryBtn.textContent = "Try again locally";
      showResultState("error");
      setStatus("Local generation stopped. The cloud daily allowance was not used.", "error");
    }
  } finally {
    window.clearTimeout(timeout);
    stopElapsed();
    cancelBtn.textContent = "Stop waiting";
    state.controller = null;
    state.cancelReason = null;
    setBusy(false);
  }
}

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
  if (videoUrl.startsWith("/local/video?jobId=")) return `${videoUrl}&download=1`;
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

function addToHistory(url: string) {
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
    resultVideo.src = url;
    downloadLink.href = downloadUrl(url);
    showResultState("ready");
  });
  button.appendChild(v);
  li.appendChild(button);
  historyList.prepend(li);
}

// Initial UI state: only the loopback server can submit no-quota local jobs.
showResultState("empty");
engineEl.value = LOCAL_STUDIO ? "local" : "shared";
applyEngineMode();
