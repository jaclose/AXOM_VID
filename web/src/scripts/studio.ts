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
// The launcher chooses the first free port between 8765 and 8775.
// Only loopback origins in this small dedicated range may access local GPU UI.
const studioPort = Number(window.location.port);
const LOCAL_STUDIO = ["localhost", "127.0.0.1"].includes(window.location.hostname)
  && Number.isInteger(studioPort) && studioPort >= 8765 && studioPort <= 8775;

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
const localRecipe = $<HTMLSelectElement>("[data-local-recipe]");
const localCamera = $<HTMLSelectElement>("[data-local-camera]");
const localIntensity = $<HTMLSelectElement>("[data-local-intensity]");
const localLook = $<HTMLSelectElement>("[data-local-look]");
const localOrientation = $<HTMLSelectElement>("[data-local-orientation]");
const localResolution = $<HTMLSelectElement>("[data-local-resolution]");
const localSeed = $<HTMLInputElement>("[data-local-seed]");
const modelDiagnostics = $<HTMLDivElement>("[data-model-diagnostics]");
const modelStatus = $<HTMLParagraphElement>("[data-model-status]");
const modelMemory = $<HTMLParagraphElement>("[data-model-memory]");
const modelDownloads = $<HTMLParagraphElement>("[data-model-downloads]");
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

const LOCAL_PREFERENCES_KEY = "AXOM_VID_LOCAL_PREFERENCES_V1";
const CREATIVE_RECIPES: Record<string, { camera: string; intensity: string; look: string }> = {
  natural: { camera: "steady", intensity: "natural", look: "original" },
  cinematic: { camera: "push_in", intensity: "natural", look: "cinematic" },
  landscape: { camera: "pan_right", intensity: "subtle", look: "documentary" },
  product: { camera: "orbit", intensity: "subtle", look: "product" },
  illustrated: { camera: "tracking", intensity: "natural", look: "illustrated" },
  dynamic: { camera: "tracking", intensity: "dynamic", look: "cinematic" },
};

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

function saveLocalPreferences(): void {
  if (!LOCAL_STUDIO) return;
  const preferences = {
    duration: localDuration.value,
    quality: localQuality.value,
    batch: localBatch.value,
    recipe: localRecipe.value,
    camera: localCamera.value,
    intensity: localIntensity.value,
    look: localLook.value,
    orientation: localOrientation.value,
    resolution: localResolution.value,
    seed: localSeed.value,
  };
  try { localStorage.setItem(LOCAL_PREFERENCES_KEY, JSON.stringify(preferences)); }
  catch { /* Disabled browser storage does not prevent local rendering. */ }
}

function restoreLocalPreferences(): void {
  if (!LOCAL_STUDIO) return;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LOCAL_PREFERENCES_KEY) || "null");
    if (!value || typeof value !== "object") return;
    const preferences = value as Record<string, unknown>;
    const controls: Record<string, HTMLSelectElement> = {
      duration: localDuration,
      quality: localQuality,
      batch: localBatch,
      recipe: localRecipe,
      camera: localCamera,
      intensity: localIntensity,
      look: localLook,
      orientation: localOrientation,
      resolution: localResolution,
    };
    for (const [key, control] of Object.entries(controls)) {
      const selected = preferences[key];
      if (typeof selected !== "string") continue;
      if (Array.from(control.options).some((option) => option.value === selected)) {
        control.value = selected;
      }
    }
    if (typeof preferences.seed === "string"
        && /^-?\d{1,10}$/.test(preferences.seed)) {
      const seed = Number(preferences.seed);
      if (Number.isInteger(seed) && seed >= -1 && seed <= 2147483640) localSeed.value = String(seed);
    }
  } catch { /* Corrupt local prefs are ignored. Source images/prompts are never stored. */ }
}

function updateLocalHints(): void {
  const duration = Number(localDuration.value);
  const size = Number(localResolution.value);
  const notes = [];
  if (duration >= 30) notes.push("Long takes chain 10-second parts and may take hours.");
  if (duration >= 10) notes.push("Longer clips use more memory.");
  if (size >= 640) notes.push("Higher resolution is experimental on 18 GB of RAM.");
  if (localQuality.value === "balanced") notes.push("Balanced takes longer than Quick.");
  if (Number(localBatch.value) > 1) notes.push("Queued generations run sequentially.");
  if (!notes.length) notes.push("Recommended on 18 GB: Quick · 3s · 512px · 1 job.");
  localHint.textContent = notes.join(" ");
}

function changeCreativeRecipe(): void {
  const recipe = CREATIVE_RECIPES[localRecipe.value];
  if (recipe) {
    localCamera.value = recipe.camera;
    localIntensity.value = recipe.intensity;
    localLook.value = recipe.look;
  }
  saveLocalPreferences();
}
localRecipe.addEventListener("change", changeCreativeRecipe);
for (const control of [localCamera, localIntensity, localLook]) {
  control.addEventListener("change", () => {
    localRecipe.value = "custom";
    saveLocalPreferences();
  });
}
for (const control of [localOrientation, localResolution, localSeed]) {
  control.addEventListener("change", () => {
    updateLocalHints();
    saveLocalPreferences();
  });
}

promptEl.addEventListener("input", refreshGenerateButton);
localDuration.addEventListener("change", () => {
  durationVal.textContent = localDuration.value + "s";
  updateLocalHints();
  saveLocalPreferences();
});
localBatch.addEventListener("change", () => {
  updateLocalHints();
  refreshGenerateButton();
  saveLocalPreferences();
});
localQuality.addEventListener("change", () => {
  updateLocalHints();
  saveLocalPreferences();
});
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
  modelDiagnostics.classList.toggle("hidden", !local || !LOCAL_STUDIO);
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
  updateLocalHints();
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

interface LocalHealth {
  online?: boolean;
  readyToGenerate?: boolean;
  baseAvailable?: boolean;
  modelIntegrityOK?: boolean;
  tier?: string;
  resolutionMax?: number;
  busy?: boolean;
  queued?: number;
  error?: string;
  memory?: { totalGB?: number; pressurePercent?: number; swapGB?: number };
  download?: {
    active?: boolean;
    state?: string;
    gemmaPending?: boolean;
    pending?: Array<{ name?: string; key?: string; leftGB?: number }>;
  };
}

async function checkLocalEngine(): Promise<void> {
  if (!LOCAL_STUDIO || engineEl.value !== "local") return;
  const reqId = ++localCheckId;
  localEngineReady = false;
  engineHelp.textContent = "Checking Phosphene model, memory and pending downloads…";
  quotaEl.dataset.state = "unknown";
  quotaEl.textContent = "Checking local video engine · no provider fees";
  refreshGenerateButton();

  try {
    const res = await fetch("/local/health", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(await readErrorMessage(res));
    const data: unknown = await res.json();
    if (!data || typeof data !== "object") throw new Error("Invalid local engine response.");
    if (reqId !== localCheckId || engineEl.value !== "local") return;
    const value = data as LocalHealth;
    const online = value.online === true;
    localEngineReady = online && value.readyToGenerate === true;

    if (online) void pollLocalJobs();

    if (!online) {
      engineHelp.textContent = value.error || "Phosphene is offline. Start it in Pinokio, then check again.";
    } else if (localEngineReady) {
      engineHelp.textContent = "Phosphene Q4 ready. Jobs run on this Mac without daily account quotas.";
    } else if (value.download?.gemmaPending) {
      engineHelp.textContent = "Phosphene is online, but Gemma text encoder is still downloading. Let it finish.";
    } else {
      engineHelp.textContent = "Phosphene is online, but the video model has not passed its readiness checks.";
    }

    quotaEl.dataset.state = localEngineReady ? "ready" : "empty";
    quotaEl.textContent = localEngineReady
      ? "Local engine ready · " + (value.busy ? "GPU busy" : "GPU idle")
        + (typeof value.queued === "number" ? " · " + value.queued + " queued" : "")
      : online
        ? "Local model not ready. Do not resubmit until required downloads finish."
        : "Local renderer offline. Shared cloud mode is separate and quota-limited.";

    modelStatus.textContent = !online ? "Phosphene panel offline."
      : "Q4 base: " + (value.baseAvailable ? "installed" : "unavailable")
      + " · Integrity: " + (value.modelIntegrityOK ? "verified" : "unverified")
      + " · Tier: " + (value.tier || "unknown") + " · Maximum supported dimension: "
      + (value.resolutionMax || "?") + "px.";
    const memory = value.memory;
    if (memory) {
      const memoryValues = [];
      if (typeof memory.totalGB === "number") memoryValues.push(memory.totalGB + " GB unified RAM");
      if (typeof memory.pressurePercent === "number") memoryValues.push(memory.pressurePercent + "% memory pressure");
      if (typeof memory.swapGB === "number") memoryValues.push(memory.swapGB.toFixed(1) + " GB swap used");
      modelMemory.textContent = memoryValues.join(" · ")
        + ((memory.pressurePercent || 0) >= 75 || (memory.swapGB || 0) >= 8
          ? ". High memory load: Quick / 512px is recommended." : "");
    } else modelMemory.textContent = "";
    const pending = value.download?.pending || [];
    if (pending.length) {
      modelDownloads.textContent = "Pending: " + pending.slice(0, 3)
        .map((item) => item.name || item.key || "model").join("; ")
        + (pending.length > 3 ? "; and " + (pending.length - 3) + " more" : "");
    } else {
      modelDownloads.textContent = online ? "No pending model downloads reported." : "";
    }
  } catch {
    if (reqId !== localCheckId || engineEl.value !== "local") return;
    engineHelp.textContent = "Cannot reach the local video bridge. Start AXOM_VID from its SSD launcher.";
    quotaEl.dataset.state = "empty";
    quotaEl.textContent = "Local bridge unavailable.";
    modelStatus.textContent = "No local model status available.";
    modelMemory.textContent = "";
    modelDownloads.textContent = "";
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


function persistLocalJobs(): void {
  if (!LOCAL_STUDIO) return;
  try {
    localStorage.setItem(LOCAL_QUEUE_KEY, JSON.stringify(localJobs.slice(0, 50)));
  } catch {
    // Browsers that block storage still support the current queue session.
  }
}

function restoreLocalJobs(): void {
  if (!LOCAL_STUDIO) return;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(LOCAL_QUEUE_KEY) || "[]");
    if (!Array.isArray(saved)) return;
    for (const raw of saved.slice(0, 50)) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.id !== "string" || !/^j-[a-zA-Z0-9-]{1,100}$/.test(item.id)
          || typeof item.label !== "string" || typeof item.duration !== "number") continue;
      if (localJobs.some((job) => job.id === item.id)) continue;
      const status = ["queued", "running", "done", "failed", "error"].includes(String(item.status))
        ? item.status as LocalJobStatus : "queued";
      localJobs.push({
        id: item.id, label: item.label.slice(0, 100), status, duration: item.duration,
        message: typeof item.message === "string" ? item.message.slice(0, 200) : undefined,
      });
    }
  } catch {
    // Invalid stored data is ignored; nothing is sent to external services.
  }
  renderLocalQueue();
}

function selectLocalJob(job: LocalJob): void {
  if (job.status !== "done" || !LOCAL_STUDIO) return;
  selectedLocalJobId = job.id;
  const uri = "/local/video?jobId=" + encodeURIComponent(job.id);
  resultVideo.src = uri;
  downloadLink.href = uri + "&download=1";
  downloadLink.setAttribute("download", "axom-local-" + job.id + ".mp4");
  showResultState("ready");
  setStatus("Local video ready. Download MP4 or convert a short segment into a GIF.", "success");
}

function renderLocalQueue(): void {
  localQueueWrap.classList.toggle("hidden", !LOCAL_STUDIO || localJobs.length === 0);
  localJobList.replaceChildren();
  for (const job of localJobs.slice(0, 50)) {
    const li = document.createElement("li");
    li.className = "rounded-xl border border-white/10 p-3 space-y-2";
    const heading = document.createElement("p");
    heading.className = "font-medium text-sm";
    heading.textContent = job.label;
    const status = document.createElement("p");
    status.className = "field-hint";
    status.textContent = "Status: " + job.status + (job.message ? " · " + job.message : "");
    li.append(heading, status);
    if (job.status === "done") {
      const actions = document.createElement("div");
      actions.className = "flex flex-wrap gap-2";
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "btn-ghost text-xs";
      preview.textContent = "Preview";
      preview.addEventListener("click", () => selectLocalJob(job));
      const mp4 = document.createElement("a");
      mp4.className = "btn-ghost text-xs";
      mp4.textContent = "Download MP4";
      mp4.href = "/local/video?jobId=" + encodeURIComponent(job.id) + "&download=1";
      mp4.download = "axom-local-" + job.id + ".mp4";
      const gif = document.createElement("button");
      gif.type = "button";
      gif.className = "btn-ghost text-xs";
      gif.textContent = "Download GIF";
      gif.addEventListener("click", () => void downloadLocalGif(job.id));
      actions.append(preview, mp4, gif);
      li.append(actions);
    }
    localJobList.append(li);
  }
}

async function pollLocalJobs(): Promise<void> {
  if (!LOCAL_STUDIO || localPollBusy) return;
  if (localPollTimer !== null) {
    window.clearTimeout(localPollTimer);
    localPollTimer = null;
  }
  const pending = localJobs.filter((job) => job.status === "queued" || job.status === "running");
  if (pending.length === 0) { renderLocalQueue(); return; }
  localPollBusy = true;
  try {
    for (const job of pending) {
      try {
        const response = await fetch("/local/status?jobId=" + encodeURIComponent(job.id), {
          signal: AbortSignal.timeout(12_000),
        });
        if (response.status === 404) {
          job.status = "error";
          job.message = "Unknown local job. Check Phosphene's Outputs folder.";
          continue;
        }
        if (!response.ok) throw new Error(await readErrorMessage(response));
        const data = await response.json() as {
          status?: string; message?: string; progress?: number; error?: string; videoUrl?: string;
        };
        const status = data.status;
        if (status === "queued" || status === "running") {
          job.status = status;
          job.message = typeof data.progress === "number"
            ? Math.round(data.progress) + "% · " + (data.message || "Local GPU")
            : data.message || (status === "running" ? "Generating frames on Mac" : "Waiting in local queue");
        } else if (status === "done") {
          job.status = "done";
          job.message = "MP4 ready";
          if (!selectedLocalJobId) selectLocalJob(job);
        } else if (["failed", "error", "cancelled", "stopped"].includes(String(status))) {
          job.status = "failed";
          job.message = data.error || "Render was stopped in Phosphene.";
        }
      } catch (error) {
        // Transient disconnection should not throw away the queued job.
        job.message = "Local renderer unreachable. Retrying when available.";
      }
    }
  } finally {
    persistLocalJobs();
    renderLocalQueue();
    localPollBusy = false;
    if (localJobs.some((job) => job.status === "queued" || job.status === "running")) {
      localPollTimer = window.setTimeout(() => { void pollLocalJobs(); }, 10_000);
    }
  }
}

async function downloadLocalGif(jobId: string): Promise<void> {
  if (!LOCAL_STUDIO || !/^j-[a-zA-Z0-9-]{1,100}$/.test(jobId)) return;
  gifButton.disabled = true;
  const oldLabel = gifButton.textContent;
  gifButton.textContent = "Converting GIF…";
  setStatus("Converting the MP4 to GIF on your Mac with FFmpeg.");
  try {
    const params = new URLSearchParams({
      jobId, seconds: gifSeconds.value, fps: gifFps.value, width: gifWidth.value,
    });
    const response = await fetch("/local/gif?" + params.toString(), {
      signal: AbortSignal.timeout(10 * 60 * 1000 + 15_000),
    });
    if (!response.ok) throw new Error(await readErrorMessage(response));
    const blob = await response.blob();
    if (!blob.type.includes("image/gif") || blob.size < 6) {
      throw new Error("The local server did not return a valid GIF.");
    }
    const objectUrl = URL.createObjectURL(blob);
    const download = document.createElement("a");
    download.href = objectUrl;
    download.download = "axom-" + jobId + ".gif";
    document.body.append(download);
    download.click();
    download.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    setStatus("GIF saved. Conversion uses your Mac without per-video cloud fees.", "success");
  } catch (err) {
    setStatus("GIF export failed: " + describeFailure(err, null), "error");
  } finally {
    gifButton.disabled = false;
    gifButton.textContent = oldLabel;
  }
}

async function runLocalGeneration(): Promise<void> {
  if (!LOCAL_STUDIO || !localEngineReady || !state.file || state.busy || !promptEl.value.trim()) return;
  const batch = Number(localBatch.value);
  const variants = localVariations.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (variants.length > 0 && variants.length !== batch) {
    setStatus("Provide exactly " + batch + " prompt variation(s), or leave variations empty.", "error");
    return;
  }
  const controller = new AbortController();
  state.controller = controller;
  state.cancelReason = null;
  const timeout = window.setTimeout(() => {
    state.cancelReason = "timeout";
    controller.abort();
  }, 90_000);
  const stopElapsed = startElapsedTimer();
  setBusy(true);
  showResultState("loading");
  loadingMsg.textContent = "Submitting " + batch + " render(s) to the Mac queue…";
  setStatus("Submitting local jobs. Phosphene will process the queue sequentially.");
  cancelBtn.textContent = "Stop waiting (jobs may be queued)";
  try {
    let orientation = "landscape";
    try {
      const bitmap = await createImageBitmap(state.file);
      if (bitmap.height > bitmap.width) orientation = "portrait";
      bitmap.close();
    } catch {
      // Source image validation happens again on the local bridge.
    }
    const form = new FormData();
    form.append("image", state.file);
    if (localOrientation.value !== "auto") orientation = localOrientation.value;
    const fixedSeed = Number(localSeed.value);
    if (!Number.isInteger(fixedSeed) || fixedSeed < -1 || fixedSeed > 2147483640) {
      throw new Error("Enter -1 for random or a whole-number seed between 0 and 2147483640.");
    }
    form.append("params", JSON.stringify({
      prompt: promptEl.value.trim(),
      duration_seconds: Number(localDuration.value),
      orientation,
      batch_count: batch,
      prompts: variants.length ? variants : null,
      quality: localQuality.value,
      resolution: localResolution.value,
      camera: localCamera.value,
      intensity: localIntensity.value,
      look: localLook.value,
      seed: fixedSeed,
    }));
    const res = await fetch("/local/generate", {
      method: "POST", body: form, signal: controller.signal,
    });
    if (!res.ok) throw new Error(await readErrorMessage(res));
    const output = await res.json() as { jobIds?: unknown; warning?: unknown };
    if (!Array.isArray(output.jobIds) || output.jobIds.length === 0) {
      throw new Error("The local renderer did not return queued jobs.");
    }
    let accepted = 0;
    for (const value of output.jobIds) {
      if (typeof value !== "string" || !/^j-[a-zA-Z0-9-]{1,100}$/.test(value)) continue;
      if (localJobs.some((job) => job.id === value)) continue;
      accepted++;
      localJobs.unshift({
        id: value, status: "queued",
        label: "Render " + (output.jobIds.indexOf(value) + 1) + " · " + localDuration.value + " seconds",
        duration: Number(localDuration.value), message: "Waiting in Phosphene queue",
      });
    }
    if (!accepted) throw new Error("The renderer returned no new valid job IDs.");
    while (localJobs.length > 50) localJobs.pop();
    persistLocalJobs();
    renderLocalQueue();
    if (!selectedLocalJobId) showResultState("empty");
    setStatus(typeof output.warning === "string" ? output.warning
      : "Queued " + accepted + " local render(s). Track each one below.", "success");
    void pollLocalJobs();
  } catch (err) {
    if (controller.signal.aborted && state.cancelReason === "user") {
      showResultState("empty");
      setStatus("Stopped waiting for submission. Phosphene may still have queued jobs.");
    } else {
      errorTitle.textContent = "Local submission failed";
      errorDetail.textContent = state.cancelReason === "timeout"
        ? "Queue submission exceeded 90 seconds. Inspect Phosphene; jobs may already be queued."
        : describeFailure(err, null);
      retryBtn.textContent = "Retry local submission";
      showResultState("error");
      setStatus("Local submission failed. Check the result panel for details.", "error");
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
if (LOCAL_STUDIO) { restoreLocalJobs(); restoreLocalPreferences(); }
engineEl.value = LOCAL_STUDIO ? "local" : "shared";
applyEngineMode();
