import {
  DEFAULT_CHAPTER_ID,
  DEFAULT_PROVIDER_MODE,
  DEFAULT_STORY_ID,
  DEFAULT_VOICE,
  MAX_READY_CHUNKS,
  STARTUP_READY_CHUNKS,
  TARGET_READY_CHUNKS
} from "../shared/constants.js";
import { chunkText, stableHash } from "../text/chunkText.js";
import {
  cleanupExpiredAudio,
  countReadyAudioAhead,
  getAudioChunkByIndex,
  getCacheStatus,
  getChapter,
  getChunksByChapter,
  getNextPendingChunk,
  replaceChapterData,
  saveAudioChunk,
  saveChapter,
  updateChunkStatus
} from "../db/idb.js";
import { LocalKokoroProvider } from "../tts/LocalKokoroProvider.js";
import { ModalKokoroProvider } from "../tts/ModalKokoroProvider.js";
import {
  applyPlaybackEnded,
  applyPlaybackError,
  applyPlaybackInterrupted,
  createRuntimeState,
  createIdleRuntimeState,
  deriveTransportStatus,
  deriveWarmupStatus,
  mapSessionToRuntimeState,
  markChunkScheduled,
  markPlaybackStarted,
  shouldDispatchChunk
} from "./runtimeState.js";

const SESSION_PREFIX = "readaloud:session:";
const ACTIVE_CHAPTER_KEY = "readaloud:activeChapterId";
const PLAYBACK_RUNTIME_EVENTS = new Set([
  "CHUNK_PLAYBACK_STARTED",
  "CHUNK_PLAYBACK_ENDED",
  "CHUNK_PLAYBACK_ERROR",
  "CHUNK_PLAYBACK_INTERRUPTED"
]);

export class PlaybackQueue {
  constructor(runtimeApi = chrome.runtime, storageArea = chrome.storage.local) {
    this.runtimeApi = runtimeApi;
    this.storageArea = storageArea;
    this.runtimeApi.onMessage.addListener((message) => {
      if (!PLAYBACK_RUNTIME_EVENTS.has(message?.type)) {
        return undefined;
      }

      void this.handleRuntimeMessage(message);
      return undefined;
    });
  }

  log(event, session = {}, extra = {}) {
    const chapterId = session.chapterId || extra.chapterId || DEFAULT_CHAPTER_ID;
    const chunkId = session.currentChunkId || extra.chunkId || "-";
    const attemptId = session.playbackAttemptId || extra.attemptId || "-";
    console.log(`[queue] ${event} chapter=${chapterId} chunk=${chunkId} attempt=${attemptId}`, extra);
  }

  getSessionKey(chapterId) {
    return `${SESSION_PREFIX}${chapterId}`;
  }

  async loadSession(chapterId = DEFAULT_CHAPTER_ID) {
    const key = this.getSessionKey(chapterId);
    const values = await this.storageArea.get(key);
    return values[key] || null;
  }

  async saveSession(session) {
    const normalizedSession = {
      ...session,
      warmupStatus: deriveWarmupStatus({
        stateAvailable: true,
        state: session.state || "idle",
        playRequested: Boolean(session.playRequested)
      }),
      transportStatus: deriveTransportStatus({
        stateAvailable: true,
        state: session.state || "idle",
        playbackStatus: session.playbackStatus || "idle",
        playRequested: Boolean(session.playRequested)
      })
    };
    await this.storageArea.set({
      [this.getSessionKey(session.chapterId)]: normalizedSession
    });
  }

  async getActiveChapterId() {
    const values = await this.storageArea.get(ACTIVE_CHAPTER_KEY);
    return values[ACTIVE_CHAPTER_KEY] || DEFAULT_CHAPTER_ID;
  }

  async setActiveChapterId(chapterId) {
    await this.storageArea.set({
      [ACTIVE_CHAPTER_KEY]: chapterId
    });
  }

  async resolveChapterId(chapterId) {
    return chapterId || (await this.getActiveChapterId());
  }

  async getCacheSnapshot(chapterId) {
    return getCacheStatus(chapterId);
  }

  async getAudioChunkRecord(chapterId, chunkIndex) {
    return getAudioChunkByIndex(chapterId, chunkIndex);
  }

  async getReadyAudioCount(chapterId, currentChunkIndex) {
    return countReadyAudioAhead(chapterId, currentChunkIndex);
  }

  async getNextPendingChunkRecord(chapterId, currentChunkIndex) {
    return getNextPendingChunk(chapterId, currentChunkIndex);
  }

  async saveChunkAudio(record) {
    return saveAudioChunk(record);
  }

  async setChunkStatus(chunkId, status) {
    return updateChunkStatus(chunkId, status);
  }

  async cleanupExpiredAudioRecords() {
    return cleanupExpiredAudio();
  }

  async queryOffscreenPlaybackStatus() {
    try {
      const status = await this.runtimeApi.sendMessage({ type: "GET_PLAYBACK_STATUS" });
      return status || { playing: false, paused: false, chunkId: null, ended: false, error: null };
    } catch (_error) {
      return { playing: false, paused: false, chunkId: null, ended: false, error: null };
    }
  }

  async dispatchChunkPlayback(chunkId, chapterId, attemptId) {
    return this.runtimeApi.sendMessage({
      type: "PLAY_CHUNK_FROM_IDB",
      chunkId,
      chapterId,
      attemptId
    });
  }

  getStartupTarget(totalChunks) {
    if (!totalChunks || totalChunks <= 0) {
      return 0;
    }

    return Math.min(STARTUP_READY_CHUNKS, totalChunks);
  }

  isStartupPending(session) {
    return Boolean(session && !session.hasStartedPlayback);
  }

  getNextPlaybackAttemptId(session) {
    return `${session.chapterId}:attempt:${(session.nextPlaybackAttemptSequence || 0) + 1}`;
  }

  async updateStartupBufferState(session, readyCount) {
    const startupTarget = this.getStartupTarget(session.totalChunks);
    const nextSession = {
      ...session,
      startupTargetReadyAudioCount: startupTarget,
      startupReadyAudioCount: Math.min(readyCount, startupTarget),
      startupBufferingComplete: startupTarget > 0 && readyCount >= startupTarget
    };

    if (!this.isStartupPending(session)) {
      return nextSession;
    }

    if (!["dispatching", "starting", "playing", "awaiting_chunk_end"].includes(session.playbackStatus)) {
      nextSession.state = nextSession.startupBufferingComplete ? "startup_ready" : "startup_buffering";
      nextSession.playbackStatus = "idle";
      nextSession.lastEvent = nextSession.startupBufferingComplete
        ? "startup_buffer_ready"
        : "startup_buffer_progress";
    }

    await this.saveSession(nextSession);
    this.log(nextSession.lastEvent, nextSession, {
      startupReadyAudioCount: nextSession.startupReadyAudioCount,
      startupTargetReadyAudioCount: nextSession.startupTargetReadyAudioCount
    });
    return nextSession;
  }

  async stopOffscreenPlayback() {
    try {
      await this.runtimeApi.sendMessage({ type: "STOP_PLAYBACK" });
    } catch (_error) {
      // Best-effort cleanup before a retry.
    }
  }

  async resumeOffscreenPlayback() {
    try {
      return await this.runtimeApi.sendMessage({ type: "RESUME_PLAYBACK" });
    } catch (_error) {
      return { ok: false, resumed: false, chunkId: null };
    }
  }

  async getState(chapterId = null) {
    const resolvedChapterId = await this.resolveChapterId(chapterId);
    const [session, cache] = await Promise.all([
      this.loadSession(resolvedChapterId),
      this.getCacheSnapshot(resolvedChapterId)
    ]);

    if (!session) {
      return createIdleRuntimeState(resolvedChapterId, cache);
    }

    return mapSessionToRuntimeState(session, cache);
  }

  async buildRequestFailureState(chapterId = null, error, lastEvent = "request_failed") {
    const resolvedChapterId = await this.resolveChapterId(chapterId);
    let cache = {
      chunkCount: 0,
      readyAudioCount: 0,
      failedCount: 0,
      cacheType: "temporary"
    };

    try {
      cache = await this.getCacheSnapshot(resolvedChapterId);
    } catch (_cacheError) {
      cache = {
        chunkCount: 0,
        readyAudioCount: 0,
        failedCount: 0,
        cacheType: "temporary"
      };
    }

    const session = await this.loadSession(resolvedChapterId);
    if (!session) {
      return createRuntimeState({
        chapterId: resolvedChapterId,
        state: "error",
        playbackStatus: "error",
        totalChunks: cache.chunkCount || 0,
        readyAudioCount: cache.readyAudioCount || 0,
        chapterReadyAudioCount: cache.readyAudioCount || 0,
        failedCount: cache.failedCount || 0,
        startupReadyAudioCount: 0,
        startupTargetReadyAudioCount: 0,
        startupBufferingComplete: false,
        cacheType: cache.cacheType || "temporary",
        generatedCount: cache.readyAudioCount || 0,
        lastEvent,
        errorMessage: String(error),
        stateAvailable: true
      });
    }

    const failedSession = {
      ...session,
      state: "error",
      playbackStatus: "error",
      lastEvent,
      errorMessage: String(error)
    };
    await this.saveSession(failedSession);
    return mapSessionToRuntimeState(failedSession, cache);
  }

  createSessionFromInput(playbackInput, overrides = {}) {
    const chapterId = playbackInput.chapterId;
    return {
      chapterId,
      storyId: playbackInput.storyId || DEFAULT_STORY_ID,
      voice: playbackInput.voice || DEFAULT_VOICE,
      providerMode: playbackInput.providerMode || DEFAULT_PROVIDER_MODE,
      text: playbackInput.text,
      title: playbackInput.title || "Wattpad Chapter",
      sourceUrl: playbackInput.sourceUrl || "",
      partId: playbackInput.partId || chapterId,
      extractionStrategy: playbackInput.extractionStrategy || null,
      extractionConfidence: playbackInput.extractionConfidence || null,
      state: "preparing",
      stopped: false,
      paused: false,
      playbackStatus: "idle",
      currentChunkIndex: 0,
      currentChunkId: null,
      totalChunks: 0,
      pageDetected: playbackInput.pageDetected ?? true,
      pageEligible: playbackInput.pageEligible ?? true,
      autoplayAllowed: playbackInput.autoplayAllowed ?? false,
      startupReadyAudioCount: 0,
      startupTargetReadyAudioCount: 0,
      startupBufferingComplete: false,
      hasStartedPlayback: false,
      playbackAttemptId: null,
      nextPlaybackAttemptSequence: 0,
      playRequested: false,
      lastEvent: "session_created",
      errorMessage: null,
      retryCount: 0,
      lastRetryReason: null,
      lastRetryKind: null,
      lastCompletedChunkId: null,
      ...overrides
    };
  }

  createRestartedSession(session, overrides = {}) {
    return {
      ...session,
      stopped: false,
      paused: false,
      playRequested: false,
      state: "preparing",
      playbackStatus: "idle",
      currentChunkIndex: 0,
      currentChunkId: null,
      pageDetected: session.pageDetected ?? true,
      pageEligible: session.pageEligible ?? true,
      autoplayAllowed: session.autoplayAllowed ?? false,
      startupReadyAudioCount: 0,
      startupTargetReadyAudioCount: 0,
      startupBufferingComplete: false,
      hasStartedPlayback: false,
      playbackAttemptId: null,
      retryCount: 0,
      lastRetryReason: null,
      lastRetryKind: null,
      lastCompletedChunkId: null,
      errorMessage: null,
      ...overrides
    };
  }

  async start(options = {}) {
    const activeChapterId = await this.resolveChapterId(options.chapterId || null);
    const existingSession = await this.loadSession(activeChapterId);

    if (existingSession?.state === "paused") {
      const resumeResponse = await this.resumeOffscreenPlayback();
      if (resumeResponse?.ok && resumeResponse.resumed) {
        const resumedSession = {
          ...existingSession,
          paused: false,
          stopped: false,
          playRequested: true,
          playbackStatus: "playing",
          state: "awaiting_chunk_end",
          lastEvent: "session_resumed",
          errorMessage: null
        };
        await this.saveSession(resumedSession);
        this.log("session_resumed", resumedSession, { chunkId: resumedSession.currentChunkId });
        return this.getState(activeChapterId);
      }

      const resumedSession = {
        ...existingSession,
        paused: false,
        stopped: false,
        playRequested: true,
        playbackStatus: "idle",
        state: "preparing",
        lastEvent: "session_resume_fallback_requested"
      };
      await this.saveSession(resumedSession);
      this.log("session_resume_fallback_requested", resumedSession, { chapterId: activeChapterId });
      await this.ensureOffscreenDocument();
      await this.processSession(activeChapterId);
      return this.getState(activeChapterId);
    }

    if (existingSession?.text && existingSession.state !== "error") {
      const resumedWarmSession = existingSession.stopped || existingSession.state === "ended"
        ? this.createRestartedSession(existingSession, {
            playRequested: true,
            lastEvent: "play_requested_after_stop"
          })
        : {
            ...existingSession,
            paused: false,
            stopped: false,
            playRequested: true,
            playbackStatus:
              existingSession.playbackStatus === "paused" || existingSession.playbackStatus === "ended"
                ? "idle"
                : existingSession.playbackStatus,
            state: existingSession.state === "ended" ? "preparing" : existingSession.state,
            lastEvent: "play_requested"
          };
      await this.saveSession(resumedWarmSession);
      this.log(resumedWarmSession.lastEvent, resumedWarmSession, { chapterId: activeChapterId });
      await this.ensureOffscreenDocument();
      await this.processSession(activeChapterId);
      return this.getState(activeChapterId);
    }

    const playbackInput = await this.resolvePlaybackInput(options);
    if (!playbackInput.ok) {
      return this.saveExtractionError(playbackInput);
    }

    const chapterId = playbackInput.chapterId;
    await this.setActiveChapterId(chapterId);

    const nextSession = this.createSessionFromInput(playbackInput, {
      playRequested: true,
      lastEvent: "session_created"
    });

    this.log("session_created", nextSession, { title: nextSession.title });
    await this.cleanupExpiredAudioRecords();
    await this.ensureOffscreenDocument();
    await this.ensureChapterData(nextSession);
    await this.saveSession(nextSession);
    await this.processSession(chapterId);

    return this.getState(chapterId);
  }

  async warmup(options = {}) {
    const playbackInput = await this.resolvePlaybackInput(options);
    if (!playbackInput.ok) {
      return this.saveExtractionError(playbackInput);
    }

    const chapterId = playbackInput.chapterId;
    const existingSession = await this.loadSession(chapterId);
    await this.setActiveChapterId(chapterId);

    if (
      existingSession &&
      existingSession.text === playbackInput.text &&
      existingSession.partId === playbackInput.partId &&
      existingSession.state !== "error"
    ) {
      const resumedWarmSession = existingSession.stopped || existingSession.state === "ended"
        ? this.createRestartedSession(existingSession, {
            playRequested: false,
            lastEvent: "session_warmup_resumed"
          })
        : {
            ...existingSession,
            paused: false,
            stopped: false,
            playRequested: false,
            lastEvent: "session_warmup_resumed"
          };
      await this.saveSession(resumedWarmSession);
      this.log("session_warmup_resumed", resumedWarmSession, { chapterId });
      await this.ensureOffscreenDocument();
      await this.processSession(chapterId);
      return this.getState(chapterId);
    }

    const nextSession = this.createSessionFromInput(playbackInput, {
      playRequested: false,
      lastEvent: "session_warmup_started"
    });

    this.log("session_warmup_started", nextSession, { title: nextSession.title });
    await this.cleanupExpiredAudioRecords();
    await this.ensureOffscreenDocument();
    await this.ensureChapterData(nextSession);
    await this.saveSession(nextSession);
    await this.processSession(chapterId);

    return this.getState(chapterId);
  }

  async pause(chapterId = null) {
    const resolvedChapterId = await this.resolveChapterId(chapterId);
    const session = await this.loadSession(resolvedChapterId);
    if (!session) {
      return this.getState(resolvedChapterId);
    }

    const pausedSession = {
      ...session,
      paused: true,
      playRequested: false,
      state: "paused",
      playbackStatus: "paused",
      lastEvent: "session_paused"
    };
    await this.saveSession(pausedSession);
    await this.runtimeApi.sendMessage({ type: "PAUSE_PLAYBACK" });
    return this.getState(resolvedChapterId);
  }

  async stop(chapterId = null) {
    const resolvedChapterId = await this.resolveChapterId(chapterId);
    const session = await this.loadSession(resolvedChapterId);
    if (session) {
      const stoppedSession = {
        ...session,
        stopped: true,
        playRequested: false,
        state: "ended",
        playbackStatus: "ended",
        currentChunkId: null,
        lastEvent: "session_stopped"
      };
      await this.saveSession(stoppedSession);
    }
    await this.runtimeApi.sendMessage({ type: "STOP_PLAYBACK" });
    return this.getState(resolvedChapterId);
  }

  async ensureChapterData(session) {
    const chapterHash = stableHash(session.text);
    const chapter = await getChapter(session.chapterId);
    const chunks = chunkText(session.text, {
      storyId: session.storyId,
      chapterId: session.chapterId
    });
    session.totalChunks = chunks.length;

    if (!chapter || chapter.textHash !== chapterHash) {
      await saveChapter({
        chapterId: session.chapterId,
        storyId: session.storyId,
        title: session.title || "Wattpad Chapter",
        sourceUrl: session.sourceUrl || "",
        textHash: chapterHash,
        createdAt: Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000
      });
      await replaceChapterData(
        session.chapterId,
        chunks.map((chunk) => ({ ...chunk, status: "pending" }))
      );
      this.log("chapter_data_replaced", session, { totalChunks: chunks.length });
      return;
    }

    const existing = await getChunksByChapter(session.chapterId);
    if (!existing.length) {
      await replaceChapterData(
        session.chapterId,
        chunks.map((chunk) => ({ ...chunk, status: "pending" }))
      );
      this.log("chapter_data_seeded", session, { totalChunks: chunks.length });
    } else {
      session.totalChunks = existing.length;
    }
  }

  getProvider(session) {
    if (session.providerMode === "modal" || session.providerMode === "proxy-local") {
      return new ModalKokoroProvider("http://localhost:3000/tts");
    }

    return new LocalKokoroProvider("http://localhost:8880");
  }

  async processSession(chapterId = DEFAULT_CHAPTER_ID) {
    const session = await this.loadSession(chapterId);
    if (!session || session.paused || session.stopped || session.state === "error") {
      return;
    }

    await this.ensureOffscreenDocument();
    if (!session.playRequested) {
      await this.fillBuffer(chapterId);
      return;
    }

    if (this.isStartupPending(session)) {
      await this.fillBuffer(chapterId);
      await this.playCurrentChunkIfReady(chapterId);
      return;
    }

    const startedPlayback = await this.playCurrentChunkIfReady(chapterId);
    await this.fillBuffer(chapterId);

    if (!startedPlayback) {
      await this.playCurrentChunkIfReady(chapterId);
    }
  }

  async fillBuffer(chapterId = DEFAULT_CHAPTER_ID) {
    let session = await this.loadSession(chapterId);
    if (!session || session.paused || session.stopped || session.state === "error") {
      return;
    }

    const provider = this.getProvider(session);
    let readyCount = await this.getReadyAudioCount(session.chapterId, session.currentChunkIndex);
    session = await this.updateStartupBufferState(session, readyCount);

    while (readyCount < TARGET_READY_CHUNKS && readyCount < MAX_READY_CHUNKS) {
      session = await this.loadSession(chapterId);
      if (!session || session.paused || session.stopped || session.state === "error") {
        return;
      }

      const nextChunk = await this.getNextPendingChunkRecord(session.chapterId, session.currentChunkIndex);
      if (!nextChunk) {
        break;
      }

      if (!["dispatching", "starting", "playing", "awaiting_chunk_end"].includes(session.playbackStatus)) {
        session.state = this.isStartupPending(session) ? "startup_buffering" : "buffering";
      }
      session.lastEvent = "chunk_synthesis_started";
      await this.saveSession(session);
      await this.setChunkStatus(nextChunk.chunkId, "generating");
      this.log("chunk_synthesis_started", session, { chunkId: nextChunk.chunkId });

      try {
        const audioBlob = await provider.synthesize({
          text: nextChunk.text,
          voice: session.voice,
          format: "wav"
        });
        await this.saveChunkAudio({
          chunkId: nextChunk.chunkId,
          chapterId: session.chapterId,
          chunkIndex: nextChunk.chunkIndex,
          mimeType: "audio/wav",
          audioBlob,
          createdAt: Date.now(),
          expiresAt: Date.now() + 24 * 60 * 60 * 1000
        });
        await this.setChunkStatus(nextChunk.chunkId, "ready");
        session = (await this.loadSession(chapterId)) || session;
        session.lastEvent = "chunk_synthesized";
        readyCount = await this.getReadyAudioCount(session.chapterId, session.currentChunkIndex);
        session = await this.updateStartupBufferState(session, readyCount);
        this.log("chunk_synthesized", session, { chunkId: nextChunk.chunkId });
        await this.playCurrentChunkIfReady(chapterId);
      } catch (error) {
        session = (await this.loadSession(chapterId)) || session;
        await this.setChunkStatus(nextChunk.chunkId, "failed");
        const failedSession = {
          ...session,
          state: "error",
          playbackStatus: "error",
          lastEvent: "chunk_synthesis_failed",
          errorMessage: String(error)
        };
        await this.saveSession(failedSession);
        this.log("chunk_synthesis_failed", failedSession, { chunkId: nextChunk.chunkId, error: String(error) });
        return;
      }

      session = await this.loadSession(chapterId);
      if (!session || session.paused || session.stopped || session.state === "error") {
        return;
      }

      readyCount = await this.getReadyAudioCount(session.chapterId, session.currentChunkIndex);
      session = await this.updateStartupBufferState(session, readyCount);
    }

    session = await this.loadSession(chapterId);
    if (!session || session.paused || session.stopped || session.state === "error") {
      return;
    }

    if (!["dispatching", "starting", "playing", "awaiting_chunk_end"].includes(session.playbackStatus)) {
      const nextState = this.isStartupPending(session)
        ? session.startupBufferingComplete
          ? "startup_ready"
          : "startup_buffering"
        : readyCount > 0
          ? "preparing"
          : "buffering";
      if (session.state !== nextState) {
        await this.saveSession({
          ...session,
          state: nextState
        });
      }
    }
  }

  async playCurrentChunkIfReady(chapterId = DEFAULT_CHAPTER_ID) {
    const session = await this.loadSession(chapterId);
    if (!session || session.paused || session.stopped || session.state === "error") {
      return false;
    }

    if (session.currentChunkIndex >= session.totalChunks) {
      const endedSession = {
        ...session,
        state: "ended",
        playbackStatus: "ended",
        currentChunkId: null,
        lastEvent: "session_ended"
      };
      await this.saveSession(endedSession);
      this.log("session_ended", endedSession);
      return false;
    }

    const audio = await this.getAudioChunkRecord(chapterId, session.currentChunkIndex);
    if (!audio) {
      if (!session.currentChunkId && session.state !== "buffering") {
        await this.saveSession({
          ...session,
          state: this.isStartupPending(session) ? "startup_buffering" : "buffering",
          playbackStatus: "idle",
          lastEvent: this.isStartupPending(session) ? "startup_buffer_waiting" : "awaiting_audio_chunk"
        });
      }
      return false;
    }

    if (this.isStartupPending(session)) {
      const readyCount = await this.getReadyAudioCount(chapterId, session.currentChunkIndex);
      const updatedSession = await this.updateStartupBufferState(session, readyCount);
      if (readyCount < updatedSession.startupTargetReadyAudioCount) {
        return false;
      }
      session.startupReadyAudioCount = updatedSession.startupReadyAudioCount;
      session.startupTargetReadyAudioCount = updatedSession.startupTargetReadyAudioCount;
      session.startupBufferingComplete = updatedSession.startupBufferingComplete;
      session.state = "startup_ready";
      session.lastEvent = "startup_buffer_ready";
    }

    if (!shouldDispatchChunk(session, audio.chunkId)) {
      return true;
    }

    const offscreenStatus = await this.queryOffscreenPlaybackStatus();
    if (offscreenStatus.chunkId === audio.chunkId && (offscreenStatus.playing || offscreenStatus.ended)) {
      return true;
    }
    if (offscreenStatus.chunkId === audio.chunkId && offscreenStatus.error) {
      await this.stopOffscreenPlayback();
    }

    const attemptId = this.getNextPlaybackAttemptId(session);
    const scheduledSession = {
      ...markChunkScheduled(session, audio),
      playbackAttemptId: attemptId,
      nextPlaybackAttemptSequence: (session.nextPlaybackAttemptSequence || 0) + 1,
      playbackStatus: "starting",
      lastEvent: "playback_dispatch_requested"
    };
    await this.saveSession(scheduledSession);
    this.log("playback_dispatch_requested", scheduledSession, {
      chunkId: audio.chunkId,
      chunkIndex: audio.chunkIndex,
      attemptId
    });

    try {
      const response = await this.dispatchChunkPlayback(audio.chunkId, chapterId, attemptId);
      if (!response?.ok) {
        throw new Error(response?.error || `Failed to dispatch playback for ${audio.chunkId}`);
      }

      const startedSession = markPlaybackStarted(scheduledSession, audio.chunkId, attemptId);
      await this.saveSession(startedSession);
      this.log("playback_started", startedSession, { chunkId: audio.chunkId, attemptId });
      return true;
    } catch (error) {
      const currentSession = (await this.loadSession(chapterId)) || scheduledSession;
      const result = String(error).includes("AbortError")
        ? applyPlaybackInterrupted(currentSession, audio.chunkId, String(error), attemptId)
        : applyPlaybackError(currentSession, audio.chunkId, String(error), attemptId);
      await this.saveSession(result.session);
      this.log(result.retryScheduled ? result.session.lastEvent : "playback_failed", result.session, {
        chunkId: audio.chunkId,
        error: String(error),
        attemptId
      });
      if (result.retryScheduled) {
        await this.processSession(chapterId);
      }
      return false;
    }
  }

  async handleRuntimeMessage(message) {
    if (message?.type === "CHUNK_PLAYBACK_STARTED") {
      const chapterId = message.chapterId || DEFAULT_CHAPTER_ID;
      const session = await this.loadSession(chapterId);
      if (!session || session.stopped) {
        return;
      }

      const startedSession = markPlaybackStarted(session, message.chunkId, message.attemptId || null);
      await this.saveSession(startedSession);
      this.log("playback_started", startedSession, { chunkId: message.chunkId, attemptId: message.attemptId || null });
      return;
    }

    if (message?.type === "CHUNK_PLAYBACK_ENDED") {
      const chapterId = message.chapterId || DEFAULT_CHAPTER_ID;
      const session = await this.loadSession(chapterId);
      if (!session || session.stopped) {
        return;
      }

      const result = applyPlaybackEnded(session, message.chunkId, message.attemptId || null);
      if (!result.advanced) {
        this.log("playback_end_ignored", session, { chunkId: message.chunkId, attemptId: message.attemptId || null });
        return;
      }

      await this.saveSession(result.session);
      this.log("chunk_playback_ended", result.session, { chunkId: message.chunkId, attemptId: message.attemptId || null });

      if (result.session.state !== "ended") {
        await this.processSession(chapterId);
      }
      return;
    }

    if (message?.type === "CHUNK_PLAYBACK_INTERRUPTED") {
      const chapterId = message.chapterId || DEFAULT_CHAPTER_ID;
      const session = await this.loadSession(chapterId);
      if (!session) {
        return;
      }

      const result = applyPlaybackInterrupted(
        session,
        message.chunkId,
        message.error || "Playback start interrupted",
        message.attemptId || null
      );
      await this.saveSession(result.session);
      this.log(result.retryScheduled ? result.session.lastEvent : "playback_failed", result.session, {
        chunkId: message.chunkId,
        error: message.error || "Playback start interrupted",
        attemptId: message.attemptId || null
      });
      if (result.retryScheduled) {
        await this.processSession(chapterId);
      }
      return;
    }

    if (message?.type === "CHUNK_PLAYBACK_ERROR") {
      const chapterId = message.chapterId || DEFAULT_CHAPTER_ID;
      const session = await this.loadSession(chapterId);
      if (!session) {
        return;
      }

      const result = applyPlaybackError(
        session,
        message.chunkId,
        message.error || "Playback failed",
        message.attemptId || null
      );
      await this.saveSession(result.session);
      this.log(result.retryScheduled ? "playback_retry_scheduled" : "playback_failed", result.session, {
        chunkId: message.chunkId,
        error: message.error || "Playback failed",
        attemptId: message.attemptId || null
      });
      if (result.retryScheduled) {
        await this.processSession(chapterId);
      }
    }
  }

  async ensureOffscreenDocument() {
    if (await chrome.offscreen.hasDocument()) {
      return;
    }

    await chrome.offscreen.createDocument({
      url: "src/offscreen/offscreen.html",
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: "Play temporary buffered audio chunks outside the popup"
    });
  }

  async resolvePlaybackInput(options = {}) {
    if (typeof options.ok === "boolean") {
      if (!options.ok || !options.text) {
        return {
          ok: false,
          chapterId: options.partId || options.chapterId || (await this.getActiveChapterId()),
          pageDetected: options.pageDetected ?? true,
          pageEligible: options.pageEligible ?? false,
          autoplayAllowed: options.autoplayAllowed ?? false,
          errorMessage: options.error || "Could not isolate Wattpad chapter text.",
          extractionStrategy: options.strategy || options.extractionStrategy || null,
          extractionConfidence: options.confidence || options.extractionConfidence || "low",
          title: options.title || null,
          partId: options.partId || null,
          storyId: options.storyId || DEFAULT_STORY_ID
        };
      }

      return {
        ok: true,
        chapterId: options.partId || options.chapterId || DEFAULT_CHAPTER_ID,
        storyId: options.storyId || DEFAULT_STORY_ID,
        voice: options.voice || DEFAULT_VOICE,
        providerMode: options.providerMode || DEFAULT_PROVIDER_MODE,
        text: options.text,
        title: options.title || "Wattpad Chapter",
        sourceUrl: options.sourceUrl || "",
        partId: options.partId || options.chapterId || DEFAULT_CHAPTER_ID,
        pageDetected: options.pageDetected ?? true,
        pageEligible: options.pageEligible ?? true,
        autoplayAllowed: options.autoplayAllowed ?? false,
        extractionStrategy: options.strategy || options.extractionStrategy || "dom-paragraphs",
        extractionConfidence: options.confidence || options.extractionConfidence || "medium"
      };
    }

    if (options.text) {
      return {
        ok: true,
        chapterId: options.chapterId || DEFAULT_CHAPTER_ID,
        storyId: options.storyId || DEFAULT_STORY_ID,
        voice: options.voice || DEFAULT_VOICE,
        providerMode: options.providerMode || DEFAULT_PROVIDER_MODE,
        text: options.text,
        title: options.title || "Manual text",
        sourceUrl: options.sourceUrl || "",
        partId: options.partId || options.chapterId || DEFAULT_CHAPTER_ID,
        pageDetected: true,
        pageEligible: true,
        autoplayAllowed: false,
        extractionStrategy: "manual",
        extractionConfidence: "high"
      };
    }

    let tabId = null;
    try {
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true
      });
      tabId = tabs[0]?.id ?? null;
    } catch (error) {
      return {
        ok: false,
        chapterId: await this.getActiveChapterId(),
        errorMessage: `Failed to find the active tab: ${error}`
      };
    }

    if (typeof tabId !== "number") {
      return {
        ok: false,
        chapterId: await this.getActiveChapterId(),
        errorMessage: "No active Wattpad tab was found."
      };
    }

    let extraction;
    try {
      extraction = await chrome.tabs.sendMessage(tabId, {
        type: "READALOUD_EXTRACT_TEXT"
      });
    } catch (error) {
      return {
        ok: false,
        chapterId: await this.getActiveChapterId(),
        errorMessage: `Failed to read the current Wattpad page: ${error}`
      };
    }

    if (!extraction?.ok || !extraction.text) {
      return {
        ok: false,
        chapterId: extraction?.partId || (await this.getActiveChapterId()),
        errorMessage: extraction?.error || "Could not isolate Wattpad chapter text.",
        extractionStrategy: extraction?.strategy || null,
        extractionConfidence: extraction?.confidence || "low",
        title: extraction?.title || null,
        partId: extraction?.partId || null,
        storyId: extraction?.storyId || DEFAULT_STORY_ID
      };
    }

    const chapterId = extraction.partId || options.chapterId || DEFAULT_CHAPTER_ID;
    return {
      ok: true,
      chapterId,
      storyId: extraction.storyId || options.storyId || DEFAULT_STORY_ID,
      voice: options.voice || DEFAULT_VOICE,
      providerMode: options.providerMode || DEFAULT_PROVIDER_MODE,
      text: extraction.text,
      title: extraction.title || "Wattpad Chapter",
      sourceUrl: extraction.sourceUrl || "",
      partId: extraction.partId || chapterId,
      extractionStrategy: extraction.strategy || "dom-paragraphs",
      extractionConfidence: extraction.confidence || "medium"
    };
  }

  async saveExtractionError(input) {
    const chapterId = input.chapterId || DEFAULT_CHAPTER_ID;
    const session = {
      chapterId,
      storyId: input.storyId || DEFAULT_STORY_ID,
      voice: DEFAULT_VOICE,
      providerMode: DEFAULT_PROVIDER_MODE,
      text: "",
      title: input.title || "Wattpad extraction failed",
      sourceUrl: "",
      partId: input.partId || null,
      pageDetected: input.pageDetected ?? Boolean(input.partId || input.title || input.extractionStrategy),
      pageEligible: input.pageEligible ?? false,
      autoplayAllowed: false,
      extractionStrategy: input.extractionStrategy || null,
      extractionConfidence: input.extractionConfidence || "low",
      state: "error",
      stopped: true,
      paused: false,
      playbackStatus: "error",
      currentChunkIndex: 0,
      currentChunkId: null,
      totalChunks: 0,
      startupReadyAudioCount: 0,
      startupTargetReadyAudioCount: 0,
      startupBufferingComplete: false,
      hasStartedPlayback: false,
      playbackAttemptId: null,
      nextPlaybackAttemptSequence: 0,
      playRequested: false,
      lastEvent: "extraction_failed",
      errorMessage: input.errorMessage || "Could not isolate Wattpad chapter text.",
      retryCount: 0,
      lastRetryReason: null,
      lastRetryKind: null,
      lastCompletedChunkId: null
    };

    this.log("extraction_failed", session, { error: session.errorMessage });
    await this.setActiveChapterId(chapterId);
    await this.saveSession(session);
    return this.getState(chapterId);
  }
}
