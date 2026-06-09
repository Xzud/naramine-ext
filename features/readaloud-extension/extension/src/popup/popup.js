import { createUnavailableRuntimeState } from "../audio/runtimeState.js";
import { buildPopupViewModel } from "./popupState.js";

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = value;
  }
}

function setMarkup(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.innerHTML = value;
  }
}

function setWidth(id, ratio) {
  const element = document.getElementById(id);
  if (element) {
    const safeRatio = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
    element.style.width = `${safeRatio * 100}%`;
  }
}

function setBadge(state) {
  const badge = document.getElementById("availabilityBadge");
  if (!badge) {
    return;
  }

  const isError = !state.stateAvailable || state.state === "error" || state.playbackStatus === "error";
  const isPlaying = state.transportStatus === "playing";
  const isWarm = ["warming", "warm_ready", "starting", "ready"].includes(state.warmupStatus);
  badge.className = `badge ${isError ? "error" : "live"}`;
  badge.textContent = isError ? "Attention" : isPlaying ? "Playing" : isWarm ? "Warm" : "Live";
}

function setHeroTitle(state) {
  const title =
    state.title ||
    (state.partId ? `Part ${state.partId}` : state.stateAvailable ? "Wattpad Session" : "Waiting for Session");
  setText("heroTitle", title);
}

function getChapterRatio(state) {
  if (!state.stateAvailable || !state.totalChunks) {
    return 0;
  }

  if (typeof state.currentChunkIndex !== "number") {
    return state.state === "idle" ? 0 : 0;
  }

  return Math.min(state.currentChunkIndex + 1, state.totalChunks) / state.totalChunks;
}

function getStartupRatio(state) {
  if (!state.stateAvailable) {
    return 0;
  }

  if (state.firstAudioAt) {
    return 1;
  }

  if (state.streamStatus === "connecting") {
    return 0.2;
  }

  if (state.streamStatus === "receiving" || state.streamStatus === "buffering") {
    return Math.min((state.bufferedAudioMs || 0) / 250, 0.9);
  }

  return 0;
}

function isPauseable(state) {
  if (!state?.stateAvailable) {
    return false;
  }

  return ["dispatching", "starting", "playing", "awaiting_chunk_end"].includes(state.playbackStatus);
}

function syncTransportButton(state) {
  setText("playLabel", isPauseable(state) ? "Pause" : "Play");
  setMarkup(
    "playIcon",
    isPauseable(state)
      ? '<path d="M8 5h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm5 1a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1Z" />'
      : '<path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.68L9.54 5.98A1 1 0 0 0 8 6.82Z" />'
  );
}

async function request(type, payload = {}) {
  try {
    return await chrome.runtime.sendMessage({
      scope: "readaloud",
      type,
      payload
    });
  } catch (error) {
    return createUnavailableRuntimeState(String(error));
  }
}

function renderState(state) {
  const view = buildPopupViewModel(state);
  setHeroTitle(state);
  setBadge(state);
  setText("availability", view.availability);
  setText("state", view.state);
  setText("playback", view.playback);
  setText("progress", view.progress);
  setText("chunk", view.chunk);
  setText("startup", view.startup);
  setText("warmup", view.warmup);
  setText("transport", view.transport);
  setText("intent", view.intent);
  setText("buffer", view.buffer);
  setText("cache", view.cache);
  setText("source", view.source);
  setText("part", view.part);
  setText("event", view.event);
  setText("error", view.error);
  setWidth("chapterMeter", getChapterRatio(state));
  setWidth("startupMeter", getStartupRatio(state));
  syncTransportButton(state);
}

let lastRenderedState = createUnavailableRuntimeState("Waiting for runtime state.");

renderState(lastRenderedState);

async function refreshState() {
  const state = await request("GET_STATE");
  lastRenderedState = state;
  renderState(state);
}

document.getElementById("play")?.addEventListener("click", async () => {
  const state = await request(isPauseable(lastRenderedState) ? "PAUSE" : "PLAY");
  lastRenderedState = state;
  renderState(state);
});

document.getElementById("stop")?.addEventListener("click", async () => {
  const state = await request("STOP");
  lastRenderedState = state;
  renderState(state);
});

document.getElementById("refresh")?.addEventListener("click", refreshState);

refreshState();
setInterval(refreshState, 1500);
