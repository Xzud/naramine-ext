import { createUnavailableRuntimeState } from "../audio/runtimeState.js";

function formatConfidence(strategy, confidence) {
  if (!strategy && !confidence) {
    return "Extraction: unavailable";
  }

  return `Extraction: ${strategy || "unknown"} (${confidence || "unknown"})`;
}

function formatProgress(state) {
  if (!state.stateAvailable) {
    return "Current chunk: unavailable";
  }

  if (state.state === "idle") {
    return state.totalChunks > 0
      ? `Current chunk: not started of ${state.totalChunks}`
      : "Current chunk: not started";
  }

  if (typeof state.currentChunkIndex !== "number" || state.totalChunks <= 0) {
    return "Current chunk: unavailable";
  }

  return `Current chunk: ${Math.min(state.currentChunkIndex + 1, state.totalChunks)} of ${state.totalChunks}`;
}

function formatStartupProgress(state) {
  if (!state.stateAvailable) {
    return "Startup buffer: unavailable";
  }

  if (!state.startupTargetReadyAudioCount) {
    return "Startup buffer: n/a";
  }

  const readyCount = Math.min(state.startupReadyAudioCount || 0, state.startupTargetReadyAudioCount);
  const suffix = state.startupBufferingComplete ? "ready to start playback" : "ready before playback start";
  return `Startup buffer: ${readyCount} / ${state.startupTargetReadyAudioCount} ${suffix}`;
}

function formatSessionState(state) {
  const warmupStatus = state.warmupStatus || state.state;

  if (warmupStatus === "warming") {
    return "warming chapter in background";
  }

  if (warmupStatus === "warm_ready") {
    return "warm buffer ready";
  }

  if (warmupStatus === "starting") {
    return "preparing playback start";
  }

  if (warmupStatus === "ready") {
    return "ready for playback";
  }

  return state.state || "idle";
}

function formatPlayback(state) {
  if (state.lastEvent === "playback_start_interrupted_retry_scheduled") {
    return "retrying interrupted startup";
  }

  if (state.transportStatus === "paused") {
    return "paused";
  }

  if (state.transportStatus === "playing") {
    return "playing";
  }

  if (state.transportStatus === "starting") {
    return "starting playback";
  }

  if (!state.playRequested && ["preparing", "startup_buffering"].includes(state.state)) {
    return "warming in background";
  }

  if (!state.playRequested && state.state === "startup_ready") {
    return "ready when you press play";
  }

  if (state.playRequested && state.state === "startup_buffering") {
    return "waiting for startup buffer";
  }

  if (state.playRequested && state.state === "startup_ready" && state.playbackStatus === "idle") {
    return "ready to start";
  }

  return state.playbackStatus || "idle";
}

function formatWarmupStatus(state) {
  if (!state.stateAvailable) {
    return "Warmup: unavailable";
  }

  const value = state.warmupStatus || "idle";
  return `Warmup: ${value}`;
}

function formatTransportStatus(state) {
  if (!state.stateAvailable) {
    return "Transport: unavailable";
  }

  const value = state.transportStatus || "idle";
  return `Transport: ${value}`;
}

function formatIntent(state) {
  if (!state.stateAvailable) {
    return "Intent: unavailable";
  }

  if (state.playRequested) {
    return `Intent: play requested (autoplay ${state.autoplayAllowed ? "on" : "off"})`;
  }

  if (state.pageDetected && state.pageEligible) {
    return `Intent: warmup only (autoplay ${state.autoplayAllowed ? "on" : "off"})`;
  }

  if (state.pageDetected && !state.pageEligible) {
    return "Intent: page detected, not eligible";
  }

  return "Intent: idle";
}

export function buildPopupViewModel(inputState) {
  const state = inputState || createUnavailableRuntimeState("No state returned from the extension.");

  if (!state.stateAvailable) {
    return {
      availability: "State unavailable",
      state: "Session state: unavailable",
      playback: "Playback: unavailable",
      progress: "Current chunk: unavailable",
      chunk: "Chunk ID: unavailable",
      startup: "Startup buffer: unavailable",
      warmup: "Warmup: unavailable",
      transport: "Transport: unavailable",
      intent: "Intent: unavailable",
      buffer: "Ready audio cache: unavailable",
      cache: "Cache: unavailable",
      source: "Extraction: unavailable",
      part: "Part ID: unavailable",
      event: "Last event: state_unavailable",
      error: `Last error: ${state.errorMessage || state.unavailableReason || "Unknown runtime error"}`
    };
  }

  const playback = formatPlayback(state);
  const error = state.errorMessage || "none";

  return {
    availability: "State live",
    state: `Session state: ${formatSessionState(state)}`,
    playback: `Playback: ${playback}`,
    progress: formatProgress(state),
    chunk: `Chunk ID: ${state.currentChunkId || "none"}`,
    startup: formatStartupProgress(state),
    warmup: formatWarmupStatus(state),
    transport: formatTransportStatus(state),
    intent: formatIntent(state),
    buffer: `Ready audio cache: ${state.chapterReadyAudioCount ?? state.readyAudioCount}`,
    cache: `Cache: ${state.cacheType}`,
    source: formatConfidence(state.extractionStrategy, state.extractionConfidence),
    part: `Part ID: ${state.partId || "none"}`,
    event: `Last event: ${state.lastEvent || "idle"}`,
    error: `Last error: ${error}`
  };
}
