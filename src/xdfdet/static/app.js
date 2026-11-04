const fileInput = document.querySelector("#video-file");
const dropzone = document.querySelector("#dropzone");
const filePreview = document.querySelector("#file-preview");
const videoPreview = document.querySelector("#video-preview");
const analyzeButton = document.querySelector("#analyze-button");
const uploadError = document.querySelector("#upload-error");
const progressPanel = document.querySelector("#upload-progress");
const resultState = document.querySelector("#result-state");
const accountDialog = document.querySelector("#account-dialog");
const settingsKey = "deepfake.connection";
const sessionKey = "deepfake.auth";
const allowedExtensions = new Set(["mp4", "mov", "avi", "mkv", "webm"]);
const maxUploadBytes = 100 * 1024 * 1024;
let selectedFile = null;
let previewUrl = null;
let requestInProgress = false;
let historyOffset = 0;
const historyPageSize = 50;

const elements = {
  dropTitle: document.querySelector("#drop-title"),
  dropSubtitle: document.querySelector("#drop-subtitle"),
  fileName: document.querySelector("#file-name"),
  fileSize: document.querySelector("#file-size"),
  progressStatus: document.querySelector("#progress-status"),
  progressPercent: document.querySelector("#progress-percent"),
  progressBar: document.querySelector("#progress-bar"),
  emptyState: document.querySelector("#empty-state"),
  emptyTitle: document.querySelector("#empty-title"),
  emptyCopy: document.querySelector("#empty-copy"),
  resultContent: document.querySelector("#result-content"),
  verdictBanner: document.querySelector("#verdict-banner"),
  verdictIcon: document.querySelector("#verdict-icon"),
  verdictText: document.querySelector("#verdict-text"),
  probabilityValue: document.querySelector("#probability-value"),
  gaugeValue: document.querySelector("#gauge-value"),
  gauge: document.querySelector("#probability-gauge"),
  heatmapSection: document.querySelector("#heatmap-section"),
  heatmapImage: document.querySelector("#heatmap-image"),
  regionList: document.querySelector("#region-list"),
  noHeatmap: document.querySelector("#no-heatmap"),
  resultModel: document.querySelector("#result-model"),
  toast: document.querySelector("#toast"),
};

function getSettings() {
  const saved = localStorage.getItem(settingsKey);
  return {
    ...(window.XDFDET_CONFIG || {}),
    ...(saved ? JSON.parse(saved) : {}),
  };
}

function apiUrl(path) {
  const base = (getSettings().apiBaseUrl || window.location.origin).replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function getSession() {
  const value = sessionStorage.getItem(sessionKey);
  return value ? JSON.parse(value) : null;
}

function setSession(session) {
  if (session?.access_token) {
    sessionStorage.setItem(sessionKey, JSON.stringify(session));
  } else {
    sessionStorage.removeItem(sessionKey);
  }
}

function authHeaders() {
  const session = getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

async function refreshSession() {
  const session = getSession();
  const settings = getSettings();
  if (!session?.refresh_token || !settings.supabaseUrl || !settings.supabaseAnonKey) return null;
  const response = await fetch(`${settings.supabaseUrl.replace(/\/+$/, "")}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: settings.supabaseAnonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  if (!response.ok) {
    setSession(null);
    return null;
  }
  const refreshed = await response.json();
  setSession(refreshed);
  return refreshed;
}

async function authFetch(path, options = {}) {
  const send = (session) => fetch(apiUrl(path), {
    ...options,
    headers: {
      ...options.headers,
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
  });
  let session = getSession();
  let response = await send(session);
  if (response.status === 401 && session?.refresh_token) {
    session = await refreshSession();
    if (session) response = await send(session);
  }
  if (response.status === 401) {
    setSession(null);
    syncAccountUI();
  }
  return response;
}

function supabaseHeaders() {
  const settings = getSettings();
  if (!settings.supabaseUrl || !settings.supabaseAnonKey) {
    throw new Error("Save your API and Supabase project settings first.");
  }
  return {
    url: settings.supabaseUrl.replace(/\/+$/, ""),
    headers: { apikey: settings.supabaseAnonKey, "Content-Type": "application/json" },
  };
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(0)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setStatus(label, state = "") {
  resultState.className = `result-state ${state}`.trim();
  resultState.lastChild.textContent = ` ${label}`;
}

function setProgress(percent, status) {
  elements.progressStatus.textContent = status;
  elements.progressPercent.textContent = `${percent}%`;
  elements.progressBar.style.width = `${percent}%`;
}

function clearSelection({ resetResults = false } = {}) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  selectedFile = null;
  fileInput.value = "";
  filePreview.hidden = true;
  dropzone.hidden = false;
  analyzeButton.disabled = true;
  elements.dropTitle.textContent = "Drop your video here";
  elements.dropSubtitle.innerHTML = 'or <span>browse files</span> from your device';
  uploadError.hidden = true;
  uploadError.textContent = "";
  if (resetResults) showEmpty();
}

function showEmpty() {
  elements.resultContent.hidden = true;
  elements.emptyState.hidden = false;
  elements.emptyTitle.textContent = "Ready when you are";
  elements.emptyCopy.textContent = "Upload a video to see its real probability, verdict, and visual evidence.";
  setStatus("AWAITING VIDEO");
}

function showSelection(file) {
  uploadError.hidden = true;
  uploadError.textContent = "";
  if (!file) return;
  const extension = file.name.split(".").pop().toLowerCase();
  if (!allowedExtensions.has(extension)) {
    showError("Unsupported file type. Choose an MP4, MOV, AVI, MKV or WEBM video.");
    fileInput.value = "";
    return;
  }
  if (file.size > maxUploadBytes) {
    showError("This video is larger than the 100 MB upload limit.");
    fileInput.value = "";
    return;
  }
  if (!file.size) {
    showError("This video file is empty. Choose another file.");
    fileInput.value = "";
    return;
  }

  if (previewUrl) URL.revokeObjectURL(previewUrl);
  selectedFile = file;
  previewUrl = URL.createObjectURL(file);
  videoPreview.src = previewUrl;
  elements.fileName.textContent = file.name;
  elements.fileSize.textContent = formatBytes(file.size);
  elements.dropTitle.textContent = "Video ready for analysis";
  elements.dropSubtitle.textContent = "Select another file by clicking here";
  filePreview.hidden = false;
  dropzone.hidden = true;
  analyzeButton.disabled = false;
  showEmpty();
  setStatus("VIDEO READY", "ready");
}

function showError(message) {
  uploadError.textContent = message;
  uploadError.hidden = false;
}

function formatRegion(name) {
  return name.replaceAll("_", " ");
}

function renderResult(result, includeGradcam) {
  const score = Number(result.real_probability);
  if (!Number.isFinite(score) || score < 0 || score > 1 || !["real", "fake"].includes(result.verdict)) {
    throw new Error("The API returned an invalid prediction. Check that the xdfdet server is up to date.");
  }
  const percentage = (score * 100).toFixed(2);
  const isReal = result.verdict === "real";

  elements.emptyState.hidden = true;
  elements.resultContent.hidden = false;
  elements.verdictBanner.className = `verdict-banner ${result.verdict}`;
  elements.verdictText.textContent = result.verdict;
  elements.verdictIcon.innerHTML = isReal
    ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10 3.7 3.7 7.3-7.4"/></svg>'
    : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8"/></svg>';
  elements.probabilityValue.textContent = percentage;
  elements.gaugeValue.textContent = `${Math.round(score * 100)}%`;
  elements.gauge.style.setProperty("--score", `${score * 100}%`);
  elements.gauge.setAttribute("aria-label", `Real probability ${percentage} percent`);
  elements.resultModel.textContent = result.model;

  const hasHeatmap = includeGradcam && typeof result.gradcam === "string";
  elements.heatmapSection.hidden = !hasHeatmap;
  elements.noHeatmap.hidden = includeGradcam || hasHeatmap;
  elements.regionList.replaceChildren();
  if (hasHeatmap) {
    elements.heatmapImage.src = result.gradcam;
    for (const [region, value] of Object.entries(result.regions || {})) {
      const chip = document.createElement("span");
      chip.className = "region-chip";
      const label = document.createElement("span");
      label.textContent = formatRegion(region);
      const scoreLabel = document.createElement("strong");
      scoreLabel.textContent = `${Number(value).toFixed(1)}%`;
      chip.append(label, scoreLabel);
      elements.regionList.append(chip);
    }
  } else {
    elements.heatmapImage.removeAttribute("src");
  }
  setStatus("ANALYSIS COMPLETE", "done");
}

function getErrorMessage(xhr) {
  try {
    const body = JSON.parse(xhr.responseText);
    if (typeof body.detail === "string") {
      return body.detail;
    }
  } catch (error) {
    console.error("Could not parse the API error response.", error);
  }
  if (xhr.status === 413) return "This video exceeds the server's 100 MB upload limit.";
  if (xhr.status === 401) return "Your session expired. Sign in again before analyzing a video.";
  if (xhr.status === 0) return "Could not reach the API. Check that xdfdet is running and open at this address.";
  return `Analysis failed (HTTP ${xhr.status}). Please try another video.`;
}

function showDialogMessage(message, isError = false) {
  const feedback = document.querySelector("#dialog-feedback");
  feedback.textContent = message;
  feedback.className = `dialog-feedback${isError ? " error" : ""}`;
  feedback.hidden = false;
}

function openAccountDialog() {
  const settings = getSettings();
  document.querySelector("#api-url-input").value = settings.apiBaseUrl || window.location.origin;
  document.querySelector("#supabase-url-input").value = settings.supabaseUrl || "";
  document.querySelector("#supabase-key-input").value = settings.supabaseAnonKey || "";
  const signedIn = Boolean(getSession()?.access_token);
  document.querySelector("#auth-actions").hidden = signedIn;
  document.querySelector("#dialog-signout").hidden = !signedIn;
  document.querySelector("#account-form-fields").hidden = signedIn;
  document.querySelector(".dialog-divider").hidden = signedIn;
  showDialogMessage(signedIn ? `Signed in as ${getSession().user?.email || "your account"}.` : "Configure the connection, then sign in or create an account.");
  accountDialog.showModal();
}

function syncAccountUI() {
  const session = getSession();
  const signedIn = Boolean(session?.access_token);
  document.querySelector("#account-button").textContent = signedIn ? "Account" : "Sign in";
  document.querySelector("#account-button").title = signedIn ? "Account settings and sign out" : "Connect and sign in";
  document.querySelector("#history-nav").hidden = !signedIn;
  document.querySelector("#history").hidden = !signedIn;
  if (signedIn) loadHistory();
}

async function submitAccount(action) {
  try {
    const config = supabaseHeaders();
    const email = document.querySelector("#account-email").value.trim();
    const password = document.querySelector("#account-password").value;
    if (!email || password.length < 8) {
      showDialogMessage("Enter a valid email address and a password with at least 8 characters.", true);
      return;
    }
    const path = action === "signup" ? "/auth/v1/signup" : "/auth/v1/token?grant_type=password";
    const response = await fetch(`${config.url}${path}`, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.msg || data.message || data.error_description || "Could not authenticate this account.");
    }
    if (!data.access_token) {
      showDialogMessage("Account created. Check your email to confirm it, then sign in.");
      return;
    }
    setSession(data);
    accountDialog.close();
    syncAccountUI();
    setStatus("ACCOUNT CONNECTED", "ready");
  } catch (error) {
    console.error("Account sign-in failed.", error);
    showDialogMessage(error.message, true);
  }
}

async function signOut() {
  const session = getSession();
  const settings = getSettings();
  if (session?.access_token && settings.supabaseUrl && settings.supabaseAnonKey) {
    try {
      const response = await fetch(`${settings.supabaseUrl.replace(/\/+$/, "")}/auth/v1/logout`, {
        method: "POST",
        headers: { apikey: settings.supabaseAnonKey, Authorization: `Bearer ${session.access_token}` },
      });
      if (!response.ok) {
        console.error("Supabase could not revoke the current session.", await response.text());
      }
    } catch (error) {
      console.error("Supabase could not be reached to revoke the current session.", error);
    }
  }
  setSession(null);
  syncAccountUI();
  showDialogMessage("Signed out. This tab's session has been cleared.");
}

async function loadHistory(append = false) {
  const list = document.querySelector("#history-list");
  const empty = document.querySelector("#history-empty");
  const error = document.querySelector("#history-error");
  const loadMore = document.querySelector("#load-more-history");
  error.hidden = true;
  try {
    const offset = append ? historyOffset : 0;
    const response = await authFetch(`/history?offset=${offset}&limit=${historyPageSize}`);
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.detail || `History request failed (HTTP ${response.status}).`);
    }
    const page = await response.json();
    const { items } = page;
    const storageResponse = await authFetch("/storage-info");
    if (!storageResponse.ok) {
      const body = await storageResponse.json();
      throw new Error(body.detail || `Storage details request failed (HTTP ${storageResponse.status}).`);
    }
    const storage = await storageResponse.json();
    const region = storage.region || "see your Supabase project settings";
    document.querySelector("#storage-description").textContent =
      `Videos and heatmaps: private Supabase "${storage.bucket}" bucket (${region}). Results: ${storage.database_table}. Retained until you delete them; signed links expire after 10 minutes.`;
    if (!append) {
      list.replaceChildren();
      historyOffset = 0;
    }
    empty.hidden = page.total > 0;
    for (const item of items) {
      const row = document.createElement("article");
      row.className = "history-item";
      const summary = document.createElement("div");
      summary.className = "history-summary";
      const verdict = document.createElement("strong");
      verdict.className = `history-verdict ${item.verdict}`;
      verdict.textContent = item.verdict;
      const score = document.createElement("span");
      score.className = "history-score";
      score.textContent = `${(Number(item.real_probability) * 100).toFixed(2)}% real`;
      const date = document.createElement("span");
      date.className = "history-date";
      date.textContent = new Date(item.created_at).toLocaleString();
      const model = document.createElement("span");
      model.className = "history-model";
      model.textContent = item.model;
      summary.append(verdict, score, date, model);
      const actions = document.createElement("div");
      actions.className = "history-actions";
      const videoLink = document.createElement("a");
      videoLink.href = item.video_url;
      videoLink.target = "_blank";
      videoLink.rel = "noopener noreferrer";
      videoLink.textContent = "Open video";
      actions.append(videoLink);
      if (item.gradcam_url) {
        const heatmapLink = document.createElement("a");
        heatmapLink.href = item.gradcam_url;
        heatmapLink.target = "_blank";
        heatmapLink.rel = "noopener noreferrer";
        heatmapLink.textContent = "Heatmap";
        actions.append(heatmapLink);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "history-delete";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => removeHistoryItem(item.id, remove));
      actions.append(remove);
      row.append(summary, actions);
      list.append(row);
    }
    historyOffset = offset + items.length;
    loadMore.hidden = !page.has_more;
  } catch (errorValue) {
    console.error("Could not load saved analysis history.", errorValue);
    error.textContent = errorValue.message;
    error.hidden = false;
    empty.hidden = true;
    loadMore.hidden = true;
    if (!getSession()?.access_token) syncAccountUI();
  }
}

async function removeHistoryItem(id, button) {
  if (!window.confirm("Permanently delete this saved video and its prediction?")) return;
  button.disabled = true;
  try {
    const response = await authFetch(`/history/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.detail || `Delete failed (HTTP ${response.status}).`);
    }
    await loadHistory();
  } catch (error) {
    console.error("Could not delete the saved analysis.", error);
    const historyError = document.querySelector("#history-error");
    historyError.textContent = error.message;
    historyError.hidden = false;
    button.disabled = false;
  }
}

async function checkApi() {
  const status = document.querySelector("#server-status");
  try {
    const response = await fetch(apiUrl("/health"));
    if (!response.ok) throw new Error(`API health check failed (HTTP ${response.status}).`);
    const health = await response.json();
    const dot = status.querySelector(".online-dot");
    if (!health.storage_configured) {
      dot.className = "online-dot warning";
      status.lastChild.textContent = " Storage not configured";
      return;
    }
    dot.className = "online-dot";
    status.lastChild.textContent = " API connected";
  } catch (error) {
    console.error("Could not connect to the prediction API.", error);
    status.querySelector(".online-dot").className = "online-dot offline";
    status.lastChild.textContent = " API unavailable";
  }
}

async function loadModels() {
  try {
    const response = await fetch(apiUrl("/models"));
    if (!response.ok) throw new Error(`Model list request failed (HTTP ${response.status}).`);
    const data = await response.json();
    const select = document.querySelector("#model-select");
    select.replaceChildren();
    for (const model of data.models) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      option.selected = model === data.default;
      select.append(option);
    }
    document.querySelector("#model-count").textContent = data.models.length;
  } catch (error) {
    console.error("Could not load xdfdet models.", error);
    document.querySelector("#model-count").textContent = "—";
    elements.toast.textContent = "Could not load the model list. Check the API URL in connection settings.";
    elements.toast.hidden = false;
    setStatus("API UNAVAILABLE");
    analyzeButton.disabled = true;
  }
}

document.querySelector(".docs-link").href = apiUrl("/docs");
document.querySelector("#account-button").addEventListener("click", () => {
  openAccountDialog();
});
document.querySelector("#settings-button").addEventListener("click", openAccountDialog);
document.querySelector("#save-connection").addEventListener("click", () => {
  const apiBaseUrl = document.querySelector("#api-url-input").value.trim().replace(/\/+$/, "");
  const supabaseUrl = document.querySelector("#supabase-url-input").value.trim().replace(/\/+$/, "");
  const supabaseAnonKey = document.querySelector("#supabase-key-input").value.trim();
  try {
    const api = new URL(apiBaseUrl);
    const auth = new URL(supabaseUrl);
    if (!["http:", "https:"].includes(api.protocol) || !["http:", "https:"].includes(auth.protocol) || !supabaseAnonKey) {
      throw new Error("Enter valid HTTP(S) API and Supabase URLs plus the public anon key.");
    }
    const previous = getSettings();
    if (previous.supabaseUrl !== supabaseUrl || previous.supabaseAnonKey !== supabaseAnonKey) {
      setSession(null);
      syncAccountUI();
    }
    localStorage.setItem(settingsKey, JSON.stringify({ apiBaseUrl, supabaseUrl, supabaseAnonKey }));
    document.querySelector(".docs-link").href = apiUrl("/docs");
    showDialogMessage("Connection saved for this browser.");
    void checkApi();
    void loadModels();
  } catch (error) {
    showDialogMessage(error.message, true);
  }
});
document.querySelector("#sign-in-button").addEventListener("click", () => void submitAccount("signin"));
document.querySelector("#sign-up-button").addEventListener("click", () => void submitAccount("signup"));
document.querySelector("#dialog-signout").addEventListener("click", () => void signOut());
document.querySelector("#close-dialog").addEventListener("click", () => accountDialog.close());
document.querySelector("#refresh-history").addEventListener("click", () => void loadHistory());
document.querySelector("#load-more-history").addEventListener("click", () => void loadHistory(true));
accountDialog.addEventListener("click", (event) => {
  if (event.target === accountDialog) accountDialog.close();
});

fileInput.addEventListener("change", () => showSelection(fileInput.files[0]));
document.querySelector("#remove-file").addEventListener("click", () => clearSelection());
document.querySelector("#analyze-another").addEventListener("click", () => {
  clearSelection({ resetResults: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
  fileInput.click();
});

for (const eventName of ["dragenter", "dragover"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("drag-over");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("drag-over");
  });
}
dropzone.addEventListener("drop", (event) => showSelection(event.dataTransfer.files[0]));
window.addEventListener("beforeunload", () => {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
});

analyzeButton.addEventListener("click", () => {
  if (!selectedFile || requestInProgress) return;
  if (!getSession()?.access_token) {
    openAccountDialog();
    showError("Sign in to save and analyze a video.");
    return;
  }
  requestInProgress = true;
  analyzeButton.disabled = true;
  analyzeButton.classList.add("loading");
  elements.toast.hidden = true;
  uploadError.hidden = true;
  progressPanel.hidden = false;
  setProgress(0, "Uploading video");
  setStatus("UPLOADING", "loading");

  const form = new FormData();
  form.append("file", selectedFile);
  form.append("model", document.querySelector("#model-select").value);
  const includeGradcam = document.querySelector("#include-gradcam").checked;
  form.append("include_gradcam", String(includeGradcam));

  const request = new XMLHttpRequest();
  request.open("POST", apiUrl("/predict"));
  for (const [name, value] of Object.entries(authHeaders())) request.setRequestHeader(name, value);
  request.upload.addEventListener("progress", (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.round((event.loaded / event.total) * 100);
    setProgress(percent, percent === 100 ? "Analyzing sampled frames" : "Uploading video");
    if (percent === 100) setStatus("ANALYZING", "loading");
  });
  request.addEventListener("load", () => {
    requestInProgress = false;
    analyzeButton.disabled = !selectedFile;
    analyzeButton.classList.remove("loading");
    progressPanel.hidden = true;
    if (request.status < 200 || request.status >= 300) {
      if (request.status === 401 && getSession()?.refresh_token) {
        void refreshSession().then((session) => {
          if (session) showError("Your session was refreshed. Click Analyze video again.");
          else {
            syncAccountUI();
            showError("Your session expired. Sign in again before analyzing a video.");
          }
        }).catch((error) => {
          console.error("Could not refresh the sign-in session.", error);
          showError("Could not refresh your session. Check your connection and sign in again.");
        });
        setStatus("SIGN-IN REQUIRED");
        return;
      }
      showError(getErrorMessage(request));
      setStatus("ANALYSIS FAILED");
      return;
    }
    try {
      const result = JSON.parse(request.responseText);
      renderResult(result, includeGradcam);
      void loadHistory();
    } catch (error) {
      console.error("Could not display the xdfdet prediction.", error);
      showError(error instanceof SyntaxError
        ? "The API response was not valid JSON. Check the server logs."
        : error.message);
      setStatus("INVALID RESPONSE");
    }
  });
  request.addEventListener("error", () => {
    requestInProgress = false;
    analyzeButton.disabled = !selectedFile;
    analyzeButton.classList.remove("loading");
    progressPanel.hidden = true;
    showError("Could not reach the xdfdet API. Check your connection and try again.");
    setStatus("API UNAVAILABLE");
  });
  request.send(form);
});

syncAccountUI();
void checkApi();
void loadModels();
