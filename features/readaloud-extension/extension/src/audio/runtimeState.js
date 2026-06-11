const ACTIVE_PLAYBACK_STATUSES = new Set(["dispatching", "starting", "playing", "awaiting_chunk_end"]);

export function deriveWarmupStatus(sessionLike) {
  if (!sessionLike?.stateAvailable) {
    return "unavailable";
  }

  if (sessionLike.state === "error") {
    return "error";
  }

  if (sessionLike.state === "idle") {
    return "idle";
  }

  if (!sessionLike.playRequested && ["preparing", "startup_buffering"].includes(sessionLike.state)) {
    return "warming";
  }

  if (!sessionLike.playRequested && sessionLike.state === "startup_ready") {
    return "warm_ready";
  }

  if (["startup_buffering", "startup_ready", "playback_starting"].includes(sessionLike.state)) {
    return "starting";
  }

  if (["buffering", "playing", "awaiting_chunk_end", "advancing", "paused", "ended"].includes(sessionLike.state)) {
    return "ready";
  }

  return sessionLike.state || "idle";
}

export function deriveTransportStatus(sessionLike) {
  if (!sessionLike?.stateAvailable) {
    return "unavailable";
  }

  if (["connecting", "receiving", "buffering", "playing", "paused"].includes(sessionLike.streamStatus)) {
    return sessionLike.streamStatus === "receiving" ? "starting" : sessionLike.streamStatus;
  }

  if (sessionLike.playbackStatus === "error" || sessionLike.state === "error") {
    return "error";
  }

  if (sessionLike.playbackStatus === "paused" || sessionLike.state === "paused") {
    return "paused";
  }

  if (["dispatching", "starting"].includes(sessionLike.playbackStatus)) {
    return "starting";
  }

  if (["playing", "awaiting_chunk_end"].includes(sessionLike.playbackStatus)) {
    return "playing";
  }

  if (sessionLike.playbackStatus === "ended" || sessionLike.state === "ended") {
    return "ended";
  }

  if (sessionLike.playRequested) {
    return "queued";
  }

  return "idle";
}

export function createRuntimeState(overrides = {}) {
  return {
    chapterId: null,
    storyId: null,
    partId: null,
    title: null,
    state: "idle",
    playbackStatus: "idle",
    currentChunkIndex: null,
    currentChunkId: null,
    totalChunks: 0,
    pageDetected: false,
    pageEligible: false,
    autoplayAllowed: false,
    readyAudioCount: 0,
    chapterReadyAudioCount: 0,
    failedCount: 0,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    extractionStrategy: null,
    extractionConfidence: null,
    lastEvent: "idle",
    errorMessage: null,
    stateAvailable: true,
    unavailableReason: null,
    cacheType: "temporary",
    generatedCount: 0,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    playbackAttemptId: null,
    playRequested: false,
    transportMode: "live_stream",
    streamStatus: "idle",
    bytesReceived: 0,
    bufferedAudioMs: 0,
    firstByteAt: null,
    firstAudioAt: null,
    stallCount: 0,
    playbackElapsedMs: 0,
    playbackResumedAt: null,
    warmupStatus: "idle",
    transportStatus: "idle",
    ...overrides
  };
}

export function createIdleRuntimeState(chapterId, cache = {}, overrides = {}) {
  return createRuntimeState({
    chapterId,
    state: "idle",
    playbackStatus: "idle",
    totalChunks: cache.chunkCount || 0,
    readyAudioCount: cache.readyAudioCount || 0,
    chapterReadyAudioCount: cache.readyAudioCount || 0,
    failedCount: cache.failedCount || 0,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    cacheType: cache.cacheType || "temporary",
    generatedCount: cache.readyAudioCount || 0,
    lastEvent: "idle",
    ...overrides
  });
}

export function createUnavailableRuntimeState(reason, overrides = {}) {
  return createRuntimeState({
    state: "unavailable",
    playbackStatus: "unavailable",
    warmupStatus: "unavailable",
    transportStatus: "unavailable",
    stateAvailable: false,
    unavailableReason: reason,
    errorMessage: reason,
    lastEvent: "state_unavailable",
    ...overrides
  });
}

export function mapSessionToRuntimeState(session, cache = {}, overrides = {}) {
  if (!session) {
    return createIdleRuntimeState(overrides.chapterId || null, cache, overrides);
  }

  const playRequested = Boolean(session.playRequested);
  const state = session.state || "idle";
  const playbackStatus = session.playbackStatus || "idle";

  return createRuntimeState({
    chapterId: session.chapterId,
    storyId: session.storyId || null,
    partId: session.partId || null,
    title: session.title || null,
    state,
    playbackStatus,
    currentChunkIndex:
      typeof session.currentChunkIndex === "number" ? session.currentChunkIndex : null,
    currentChunkId: session.currentChunkId || null,
    totalChunks: session.totalChunks || 0,
    pageDetected: Boolean(session.pageDetected),
    pageEligible: Boolean(session.pageEligible),
    autoplayAllowed: Boolean(session.autoplayAllowed),
    readyAudioCount: cache.readyAudioCount || 0,
    chapterReadyAudioCount: cache.readyAudioCount || 0,
    failedCount: cache.failedCount || 0,
    startupReadyAudioCount:
      typeof session.startupReadyAudioCount === "number" ? session.startupReadyAudioCount : 0,
    startupTargetReadyAudioCount:
      typeof session.startupTargetReadyAudioCount === "number"
        ? session.startupTargetReadyAudioCount
        : 0,
    startupBufferingComplete: Boolean(session.startupBufferingComplete),
    extractionStrategy: session.extractionStrategy || null,
    extractionConfidence: session.extractionConfidence || null,
    lastEvent: session.lastEvent || "idle",
    errorMessage: session.errorMessage || null,
    stateAvailable: true,
    unavailableReason: null,
    cacheType: cache.cacheType || "temporary",
    generatedCount: cache.readyAudioCount || 0,
    retryCount: session.retryCount || 0,
    lastRetryReason: session.lastRetryReason || null,
    lastRetryKind: session.lastRetryKind || null,
    playbackAttemptId: session.playbackAttemptId || null,
    playRequested,
    transportMode: session.transportMode || "live_stream",
    streamStatus: session.streamStatus || "idle",
    bytesReceived: session.bytesReceived || 0,
    bufferedAudioMs: session.bufferedAudioMs || 0,
    firstByteAt: session.firstByteAt || null,
    firstAudioAt: session.firstAudioAt || null,
    stallCount: session.stallCount || 0,
    playbackElapsedMs: session.playbackElapsedMs || 0,
    playbackResumedAt: session.playbackResumedAt || null,
    warmupStatus: deriveWarmupStatus({
      stateAvailable: true,
      state,
      playRequested
    }),
    transportStatus: deriveTransportStatus({
      stateAvailable: true,
      state,
      playbackStatus,
      playRequested,
      streamStatus: session.streamStatus || "idle"
    }),
    ...overrides
  });
}

export function isActivePlaybackStatus(playbackStatus) {
  return ACTIVE_PLAYBACK_STATUSES.has(playbackStatus);
}

export function shouldDispatchChunk(session, chunkId) {
  if (!session || !chunkId) {
    return false;
  }

  if (session.currentChunkId === chunkId && isActivePlaybackStatus(session.playbackStatus)) {
    return false;
  }

  return true;
}

export function markChunkScheduled(session, chunk) {
  return {
    ...session,
    state: session.hasStartedPlayback ? "playing" : "playback_starting",
    playbackStatus: "dispatching",
    currentChunkIndex: chunk.chunkIndex,
    currentChunkId: chunk.chunkId,
    lastEvent: "playback_dispatch_requested",
    errorMessage: null
  };
}

export function markPlaybackStarted(session, chunkId, attemptId = null) {
  if (!session || session.currentChunkId !== chunkId) {
    return session;
  }

  if (attemptId && session.playbackAttemptId && session.playbackAttemptId !== attemptId) {
    return session;
  }

  return {
    ...session,
    state: "awaiting_chunk_end",
    playbackStatus: "playing",
    lastEvent: "playback_started",
    errorMessage: null,
    hasStartedPlayback: true,
    startupBufferingComplete: true
  };
}

export function applyPlaybackEnded(session, chunkId, attemptId = null) {
  if (!session || !chunkId) {
    return { session, advanced: false };
  }

  if (attemptId && session.playbackAttemptId && session.playbackAttemptId !== attemptId) {
    return { session, advanced: false };
  }

  if (session.currentChunkId !== chunkId || session.lastCompletedChunkId === chunkId) {
    return { session, advanced: false };
  }

  const nextChunkIndex = Math.min((session.currentChunkIndex || 0) + 1, session.totalChunks || 0);
  const ended = nextChunkIndex >= (session.totalChunks || 0);

  return {
    advanced: true,
    session: {
      ...session,
      state: ended ? "ended" : "advancing",
      playbackStatus: ended ? "ended" : "idle",
      currentChunkIndex: nextChunkIndex,
      currentChunkId: null,
      playbackAttemptId: null,
      lastEvent: "chunk_playback_ended",
      lastCompletedChunkId: chunkId,
      retryCount: 0,
      lastRetryReason: null,
      lastRetryKind: null
    }
  };
}

export function applyPlaybackInterrupted(session, chunkId, errorMessage, attemptId = null, maxRetryCount = 2) {
  if (!session || !chunkId || session.currentChunkId !== chunkId) {
    return { session, retryScheduled: false };
  }

  if (attemptId && session.playbackAttemptId && session.playbackAttemptId !== attemptId) {
    return { session, retryScheduled: false };
  }

  const retryCount = session.retryCount || 0;
  if (retryCount < maxRetryCount) {
    return {
      retryScheduled: true,
      session: {
        ...session,
        state: session.hasStartedPlayback ? "buffering" : "startup_ready",
        playbackStatus: "idle",
        currentChunkId: null,
        playbackAttemptId: null,
        lastEvent: "playback_start_interrupted_retry_scheduled",
        errorMessage,
        retryCount: retryCount + 1,
        lastRetryReason: errorMessage,
        lastRetryKind: "interrupted_startup"
      }
    };
  }

  return {
    retryScheduled: false,
    session: {
      ...session,
      state: "error",
      playbackStatus: "error",
      currentChunkId: null,
      playbackAttemptId: null,
      lastEvent: "playback_failed",
      errorMessage,
      lastRetryReason: errorMessage,
      lastRetryKind: "interrupted_startup"
    }
  };
}

export function applyPlaybackError(session, chunkId, errorMessage, attemptId = null, maxRetryCount = 1) {
  if (!session || !chunkId || session.currentChunkId !== chunkId) {
    return { session, retryScheduled: false };
  }

  if (attemptId && session.playbackAttemptId && session.playbackAttemptId !== attemptId) {
    return { session, retryScheduled: false };
  }

  const retryCount = session.retryCount || 0;
  if (retryCount < maxRetryCount) {
    return {
      retryScheduled: true,
      session: {
        ...session,
        state: "buffering",
        playbackStatus: "idle",
        currentChunkId: null,
        playbackAttemptId: null,
        lastEvent: "playback_retry_scheduled",
        errorMessage,
        retryCount: retryCount + 1,
        lastRetryReason: errorMessage,
        lastRetryKind: "playback_error"
      }
    };
  }

  return {
    retryScheduled: false,
    session: {
      ...session,
      state: "error",
      playbackStatus: "error",
      currentChunkId: null,
      playbackAttemptId: null,
      lastEvent: "playback_failed",
      errorMessage,
      lastRetryReason: errorMessage,
      lastRetryKind: "playback_error"
    }
  };
}
