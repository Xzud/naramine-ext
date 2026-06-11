import {
  DEFAULT_CHAPTER_ID,
  DEFAULT_PROVIDER_MODE,
  DEFAULT_STORY_ID,
  DEFAULT_VOICE,
  STREAM_LOOKAHEAD_DEPTH
} from "../shared/constants.js";
import { chunkText, stableHash } from "../text/chunkText.js";
import {
  cleanupExpiredAudio,
  getCacheStatus,
  getChapter,
  getChunkByIndex,
  getChunksByChapter,
  saveChunks,
  replaceChapterData,
  saveChapter
} from "../db/idb.js";
import { LocalKokoroProvider } from "../tts/LocalKokoroProvider.js";
import { ModalKokoroProvider } from "../tts/ModalKokoroProvider.js";
import {
  applyPlaybackEnded,
  applyPlaybackError,
  applyPlaybackInterrupted,
  createIdleRuntimeState,
  createRuntimeState,
  deriveTransportStatus,
  deriveWarmupStatus,
  mapSessionToRuntimeState,
  markChunkScheduled,
  markPlaybackStarted,
  shouldDispatchChunk
} from "./runtimeState.js";

const SESSION_PREFIX = "readaloud:session:";
const ACTIVE_CHAPTER_KEY = "readaloud:activeChapterId";
const CHAPTER_REFRESH_LOOKAHEAD = 3;
const PLAYBACK_RUNTIME_EVENTS = new Set([
  "CHUNK_PLAYBACK_STARTED",
  "CHUNK_PLAYBACK_ENDED",
  "CHUNK_PLAYBACK_ERROR",
  "CHUNK_PLAYBACK_INTERRUPTED",
  "STREAM_PLAYBACK_PROGRESS",
  "STREAM_PREPARE_READY",
  "STREAM_PREPARE_ERROR"
]);

export class PlaybackQueue {
  constructor(
    runtimeApi = globalThis.chrome?.runtime,
    storageArea = globalThis.chrome?.storage?.local,
    tabsApi = globalThis.chrome?.tabs
  ) {
    this.runtimeApi = runtimeApi;
    this.storageArea = storageArea;
    this.tabsApi = tabsApi;
    this.sessionTaskChain = Promise.resolve();
    this.runtimeApi.onMessage.addListener((message) => {
      if (!PLAYBACK_RUNTIME_EVENTS.has(message?.type)) {
        return undefined;
      }

      void this.handleRuntimeMessage(message);
      return undefined;
    });
  }

  // Sessions are mutated with read-modify-write cycles that await storage and
  // messaging in between. Serializing every entry point (user commands and
  // offscreen events) prevents a pause from being overwritten by an in-flight
  // progress or playback-started handler that loaded the session before it.
  runExclusive(task) {
    const result = this.sessionTaskChain.then(() => task());
    this.sessionTaskChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
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
        playRequested: Boolean(session.playRequested),
        streamStatus: session.streamStatus || "idle"
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

  async getChunkRecord(chapterId, chunkIndex) {
    return getChunkByIndex(chapterId, chunkIndex);
  }

  async getChapterRecord(chapterId) {
    return getChapter(chapterId);
  }

  async getChapterChunkRecords(chapterId) {
    return getChunksByChapter(chapterId);
  }

  async saveChapterRecord(record) {
    return saveChapter(record);
  }

  async saveChunkRecords(records) {
    return saveChunks(records);
  }

  async replaceChapterChunkRecords(chapterId, chunkRecords) {
    return replaceChapterData(chapterId, chunkRecords);
  }

  async sendPageCommand(tabId, message) {
    if (!this.tabsApi?.sendMessage || typeof tabId !== "number") {
      return { ok: false, error: "page_command_unavailable" };
    }

    try {
      return await this.tabsApi.sendMessage(tabId, {
        scope: "readaloud",
        ...message
      });
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  async resolvePageTabId(session) {
    if (typeof session?.tabId === "number") {
      return session.tabId;
    }

    if (typeof this.tabsApi?.query !== "function") {
      return null;
    }

    try {
      const tabs = await this.tabsApi.query({
        active: true,
        currentWindow: true
      });
      return tabs[0]?.id ?? null;
    } catch (_error) {
      return null;
    }
  }

  async focusChunkOnPage(session, chunkId, { clearPrevious = true } = {}) {
    const tabId = await this.resolvePageTabId(session);
    if (typeof tabId !== "number" || !chunkId) {
      return { ok: false, error: "missing_page_target" };
    }

    const chunk = await this.getChunkRecord(session.chapterId, session.currentChunkIndex);
    if (!chunk || chunk.chunkId !== chunkId) {
      return { ok: false, error: "chunk_not_found" };
    }

    return this.sendPageCommand(tabId, {
      type: "READALOUD_SET_ACTIVE_CHUNK",
      payload: {
        chapterId: session.chapterId,
        chunkId: chunk.chunkId,
        paragraphIds: chunk.paragraphIds || (chunk.paragraphId ? [chunk.paragraphId] : []),
        scroll: true,
        highlight: true,
        clearPrevious
      }
    });
  }

  async findChunkForParagraph(chapterId, paragraphId) {
    if (!chapterId || !paragraphId) {
      return null;
    }

    const chunkRecords = await this.getChapterChunkRecords(chapterId);
    return (
      chunkRecords.find((chunk) => {
        const paragraphIds = Array.isArray(chunk.paragraphIds) ? chunk.paragraphIds.filter(Boolean) : [];
        return paragraphIds.includes(paragraphId) || chunk.paragraphId === paragraphId;
      }) || null
    );
  }

  isNearChapterEnd(session) {
    if (!session || typeof session.currentChunkIndex !== "number" || typeof session.totalChunks !== "number") {
      return false;
    }

    return session.currentChunkIndex >= Math.max(0, session.totalChunks - CHAPTER_REFRESH_LOOKAHEAD);
  }

  chunkMatchesExistingRecord(existingChunk, nextChunk) {
    if (!existingChunk || !nextChunk) {
      return false;
    }

    if (existingChunk.chunkIndex !== nextChunk.chunkIndex) {
      return false;
    }

    if ((existingChunk.text || "") !== (nextChunk.text || "")) {
      return false;
    }

    const existingParagraphIds = Array.isArray(existingChunk.paragraphIds)
      ? existingChunk.paragraphIds.filter(Boolean)
      : [];
    const nextParagraphIds = Array.isArray(nextChunk.paragraphIds)
      ? nextChunk.paragraphIds.filter(Boolean)
      : [];

    if (!existingParagraphIds.length || !nextParagraphIds.length) {
      return true;
    }

    return (
      existingParagraphIds.length === nextParagraphIds.length &&
      existingParagraphIds.every((paragraphId, index) => paragraphId === nextParagraphIds[index])
    );
  }

  async mergeChapterChunkData(session, chapter, chunks, existingChunks) {
    const chapterRecord = {
      chapterId: session.chapterId,
      storyId: session.storyId,
      title: session.title || "Wattpad Chapter",
      sourceUrl: session.sourceUrl || "",
      textHash: stableHash(session.text),
      createdAt: chapter?.createdAt || Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000
    };

    await this.saveChapterRecord(chapterRecord);

    const existingChunkCount = existingChunks.length;
    const canPreserveExistingChunks =
      existingChunkCount > 0 &&
      existingChunkCount <= chunks.length &&
      existingChunks.every((existingChunk, index) => this.chunkMatchesExistingRecord(existingChunk, chunks[index]));

    if (!canPreserveExistingChunks) {
      await this.replaceChapterChunkRecords(session.chapterId, chunks.map((chunk) => ({ ...chunk, status: "pending" })));
      return;
    }

    const upgradedChunks = existingChunks
      .map((existingChunk, index) => {
        const nextChunk = chunks[index];
        if (!nextChunk) {
          return null;
        }

        const nextParagraphIds = Array.isArray(nextChunk.paragraphIds) ? nextChunk.paragraphIds.filter(Boolean) : [];
        const existingParagraphIds = Array.isArray(existingChunk.paragraphIds)
          ? existingChunk.paragraphIds.filter(Boolean)
          : [];
        const shouldUpgradeParagraphAnchors =
          nextParagraphIds.length > 0 &&
          (!existingParagraphIds.length ||
            existingParagraphIds.length !== nextParagraphIds.length ||
            !existingParagraphIds.every((paragraphId, paragraphIndex) => paragraphId === nextParagraphIds[paragraphIndex]));

        if (!shouldUpgradeParagraphAnchors) {
          return null;
        }

        return {
          ...existingChunk,
          paragraphId: nextParagraphIds[0] || existingChunk.paragraphId || null,
          paragraphIds: nextParagraphIds,
          status: existingChunk.status || "pending"
        };
      })
      .filter(Boolean);

    if (upgradedChunks.length > 0) {
      await this.saveChunkRecords(upgradedChunks);
    }

    if (chunks.length > existingChunkCount) {
      await this.saveChunkRecords(
        chunks.slice(existingChunkCount).map((chunk) => ({
          ...chunk,
          status: "pending"
        }))
      );
    }
  }

  // The page extract is slow tab I/O, so it must not run while holding the
  // session lock; only the merge/save step is exclusive. Pass
  // alreadyExclusive: true when calling from inside a locked section.
  async refreshChapterDataFromPage(session, { resumePlayback = false, alreadyExclusive = false } = {}) {
    if (!session?.tabId || !this.isNearChapterEnd(session)) {
      return false;
    }

    const response = await this.sendPageCommand(session.tabId, {
      type: "READALOUD_EXTRACT_TEXT"
    });
    if (!response?.ok || !response.text) {
      return false;
    }

    const apply = () => this.applyChapterRefresh(session, response, { resumePlayback });
    return alreadyExclusive ? apply() : this.runExclusive(apply);
  }

  async applyChapterRefresh(session, response, { resumePlayback = false } = {}) {
    const latestSession = (await this.loadSession(session.chapterId)) || session;
    if (latestSession.stopped || latestSession.state === "error") {
      return false;
    }

    const latestParagraphCount = Array.isArray(latestSession.paragraphs) ? latestSession.paragraphs.length : 0;
    const nextParagraphCount = Array.isArray(response.paragraphs) ? response.paragraphs.length : response.paragraphCount || 0;
    const latestText = latestSession.text || "";
    const nextText = response.text || "";

    if (nextText.length <= latestText.length && nextParagraphCount <= latestParagraphCount) {
      return false;
    }

    const refreshedSession = {
      ...latestSession,
      storyId: response.storyId || latestSession.storyId,
      title: response.title || latestSession.title,
      sourceUrl: response.sourceUrl || latestSession.sourceUrl,
      text: nextText,
      paragraphs: response.paragraphs || latestSession.paragraphs || [],
      extractionStrategy: response.strategy || latestSession.extractionStrategy,
      extractionConfidence: response.confidence || latestSession.extractionConfidence,
      partId: response.partId || latestSession.partId,
      playRequested: Boolean(latestSession.playRequested)
    };

    const chapter = await this.getChapterRecord(refreshedSession.chapterId);
    const chunks = chunkText(refreshedSession.text, {
      storyId: refreshedSession.storyId,
      chapterId: refreshedSession.chapterId,
      paragraphs: refreshedSession.paragraphs || []
    });
    refreshedSession.totalChunks = chunks.length;
    const existingChunks = await this.getChapterChunkRecords(refreshedSession.chapterId);

    await this.mergeChapterChunkData(refreshedSession, chapter, chunks, existingChunks);
    await this.saveSession(refreshedSession);
    if (resumePlayback) {
      await this.processSession(refreshedSession.chapterId);
    }
    return true;
  }

  async playFromParagraph(options = {}) {
    return this.runExclusive(() => this.playFromParagraphExclusive(options));
  }

  async playFromParagraphExclusive(options = {}) {
    const playbackInput = await this.resolvePlaybackInput({
      ...options,
      tabId: typeof options.tabId === "number" ? options.tabId : null
    });
    if (!playbackInput.ok) {
      return this.saveExtractionError(playbackInput);
    }

    const chapterId = playbackInput.chapterId;
    const clickedParagraphId = options.paragraphId || null;
    await this.setActiveChapterId(chapterId);

    const existingSession = await this.loadSession(chapterId);
    const baseSession =
      existingSession && existingSession.text === playbackInput.text && existingSession.state !== "error"
        ? existingSession
        : this.createSessionFromInput(playbackInput, {
            playRequested: true,
            lastEvent: "session_created_from_paragraph"
          });

    const preparedSession = {
      ...baseSession,
      tabId: typeof options.tabId === "number" ? options.tabId : baseSession.tabId || playbackInput.tabId || null,
      playRequested: true,
      paused: false,
      stopped: false,
      state: "playback_starting",
      playbackStatus: "idle",
      currentChunkIndex: typeof baseSession.currentChunkIndex === "number" ? baseSession.currentChunkIndex : 0,
      currentChunkId: baseSession.currentChunkId || null,
      playbackAttemptId: null,
      lastEvent: "play_requested_from_paragraph",
      errorMessage: null,
      retryCount: 0,
      lastRetryReason: null,
      lastRetryKind: null,
      streamStatus: "idle",
      bytesReceived: 0,
      bufferedAudioMs: 0,
      firstByteAt: null,
      firstAudioAt: null,
      stallCount: 0
    };

    await this.ensureChapterData(preparedSession);

    let targetChunk = await this.findChunkForParagraph(chapterId, clickedParagraphId);
    if (!targetChunk) {
      await this.refreshChapterDataFromPage(
        {
          ...preparedSession,
          tabId: preparedSession.tabId || options.tabId || null
        },
        { alreadyExclusive: true }
      ).catch(() => {});
      await this.ensureChapterData(preparedSession);
      targetChunk = await this.findChunkForParagraph(chapterId, clickedParagraphId);
    }

    if (!targetChunk) {
      return this.buildRequestFailureState(
        chapterId,
        `paragraph_not_found: could not find a chunk for paragraph ${clickedParagraphId || "-"}`,
        "paragraph_not_found"
      );
    }

    const nextSession = {
      ...preparedSession,
      currentChunkIndex: targetChunk.chunkIndex,
      currentChunkId: targetChunk.chunkId
    };

    await this.saveSession(nextSession);
    await this.focusChunkOnPage(nextSession, targetChunk.chunkId, { clearPrevious: true }).catch(() => {});
    await this.stopOffscreenPlayback();
    await this.processSession(chapterId);
    return this.getState(chapterId);
  }

  async clearChunkFocus(session) {
    const tabId = await this.resolvePageTabId(session);
    if (typeof tabId !== "number") {
      return { ok: false, error: "missing_page_target" };
    }

    return this.sendPageCommand(tabId, {
      type: "READALOUD_CLEAR_ACTIVE_CHUNK",
      payload: {
        chapterId: session.chapterId
      }
    });
  }

  async cleanupExpiredAudioRecords() {
    return cleanupExpiredAudio();
  }

  async queryOffscreenPlaybackStatus() {
    try {
      const status = await this.runtimeApi.sendMessage({ type: "GET_PLAYBACK_STATUS" });
      return status || {
        playing: false,
        paused: false,
        chunkId: null,
        ended: false,
        error: null,
        streamStatus: "idle",
        bytesReceived: 0,
        bufferedSegmentCount: 0,
        slots: []
      };
    } catch (_error) {
      return {
        playing: false,
        paused: false,
        chunkId: null,
        ended: false,
        error: null,
        streamStatus: "idle",
        bytesReceived: 0,
        bufferedSegmentCount: 0,
        slots: []
      };
    }
  }

  async dispatchStreamPlayback(payload) {
    return this.runtimeApi.sendMessage({
      type: "START_STREAM_PLAYBACK",
      ...payload
    });
  }

  async dispatchPrepareStreamPlayback(payload) {
    return this.runtimeApi.sendMessage({
      type: "PREPARE_STREAM_PLAYBACK",
      ...payload
    });
  }

  async dispatchStartPreparedStream(payload) {
    return this.runtimeApi.sendMessage({
      type: "START_PREPARED_STREAM",
      ...payload
    });
  }

  async stopOffscreenPlayback() {
    try {
      await this.runtimeApi.sendMessage({ type: "STOP_PLAYBACK" });
    } catch (_error) {
      // Best-effort cleanup.
    }
  }

  async resumeOffscreenPlayback() {
    try {
      return await this.runtimeApi.sendMessage({ type: "RESUME_PLAYBACK" });
    } catch (_error) {
      return { ok: false, resumed: false, chunkId: null };
    }
  }

  getPreparedSlotSnapshot(offscreenStatus, chunkId) {
    return offscreenStatus?.slots?.find((slot) => slot.chunkId === chunkId) || null;
  }

  async prefetchChunkAtOffset(chapterId, session, offset) {
    if (!session || typeof session.currentChunkIndex !== "number") {
      return false;
    }

    if (offset < 1 || offset > STREAM_LOOKAHEAD_DEPTH) {
      return false;
    }

    const chunk = await this.getChunkRecord(chapterId, session.currentChunkIndex + offset);
    if (!chunk) {
      return false;
    }

    const offscreenStatus = await this.queryOffscreenPlaybackStatus();
    if (this.getPreparedSlotSnapshot(offscreenStatus, chunk.chunkId)) {
      return false;
    }

    const provider = this.getProvider(session);
    const response = await this.dispatchPrepareStreamPlayback({
      chunkId: chunk.chunkId,
      chapterId,
      attemptId: `${session.chapterId}:lookahead:${chunk.chunkIndex}:${offset}`,
      request: provider.createStreamRequest({
        text: chunk.text,
        voice: session.voice,
        format: "wav"
      })
    });

    return Boolean(response?.ok);
  }

  async prefetchLookahead(chapterId, session, offset = 1) {
    if (offset > STREAM_LOOKAHEAD_DEPTH) {
      return false;
    }

    return this.prefetchChunkAtOffset(chapterId, session, offset);
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
    const cache = await this.getCacheSnapshot(resolvedChapterId).catch(() => ({
      chunkCount: 0,
      readyAudioCount: 0,
      failedCount: 0,
      cacheType: "temporary"
    }));
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
      streamStatus: "error",
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
      tabId: playbackInput.tabId || null,
      text: playbackInput.text,
      paragraphs: playbackInput.paragraphs || [],
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
      transportMode: "live_stream",
      streamStatus: "idle",
      bytesReceived: 0,
      bufferedAudioMs: 0,
      firstByteAt: null,
      firstAudioAt: null,
      stallCount: 0,
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
      playbackAttemptId: null,
      retryCount: 0,
      lastRetryReason: null,
      lastRetryKind: null,
      lastCompletedChunkId: null,
      errorMessage: null,
      streamStatus: "idle",
      bytesReceived: 0,
      bufferedAudioMs: 0,
      firstByteAt: null,
      firstAudioAt: null,
      stallCount: 0,
      ...overrides
    };
  }

  async start(options = {}) {
    return this.runExclusive(() => this.startExclusive(options));
  }

  async startExclusive(options = {}) {
    const activeChapterId = await this.resolveChapterId(options.chapterId || null);
    const existingSession = await this.loadSession(activeChapterId);

    if (existingSession?.state === "paused" && !existingSession.stopped) {
      const resumeResponse = await this.resumeOffscreenPlayback();
      if (resumeResponse?.ok && resumeResponse.resumed) {
        const hasStarted = Boolean(existingSession.hasStartedPlayback);
        const resumedSession = {
          ...existingSession,
          paused: false,
          stopped: false,
          playRequested: true,
          playbackStatus: hasStarted ? "playing" : "starting",
          state: hasStarted ? "awaiting_chunk_end" : "playback_starting",
          streamStatus: hasStarted ? "playing" : "receiving",
          lastEvent: "session_resumed",
          errorMessage: null
        };
        await this.ensureChapterData(resumedSession);
        await this.saveSession(resumedSession);
        return this.getState(activeChapterId);
      }
    }

    if (existingSession?.text && existingSession.state !== "error") {
      const wasPaused = existingSession.state === "paused";
      const resumedWarmSession = existingSession.stopped || existingSession.state === "ended"
        ? this.createRestartedSession(existingSession, {
            tabId: options.tabId || existingSession.tabId || null,
            playRequested: true,
            lastEvent: "play_requested_after_stop"
          })
        : {
            ...existingSession,
            tabId: options.tabId || existingSession.tabId || null,
            paused: false,
            stopped: false,
            playRequested: true,
            state:
              existingSession.state === "startup_ready" || wasPaused
                ? "playback_starting"
                : existingSession.state,
            playbackStatus: wasPaused ? "idle" : existingSession.playbackStatus,
            streamStatus: wasPaused ? "idle" : existingSession.streamStatus,
            lastEvent: "play_requested"
          };
      await this.ensureChapterData(resumedWarmSession);
      await this.saveSession(resumedWarmSession);
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

    await this.cleanupExpiredAudioRecords();
    await this.ensureOffscreenDocument();
    await this.ensureChapterData(nextSession);
    await this.saveSession(nextSession);
    await this.processSession(chapterId);

    return this.getState(chapterId);
  }

  async warmup(options = {}) {
    return this.runExclusive(() => this.warmupExclusive(options));
  }

  async warmupExclusive(options = {}) {
    const playbackInput = await this.resolvePlaybackInput(options);
    if (!playbackInput.ok) {
      return this.saveExtractionError(playbackInput);
    }

    const chapterId = playbackInput.chapterId;
    const existingSession = await this.loadSession(chapterId);
    await this.setActiveChapterId(chapterId);

    if (existingSession && existingSession.text === playbackInput.text && existingSession.state !== "error") {
      const resumedWarmSession = existingSession.stopped || existingSession.state === "ended"
        ? this.createRestartedSession(existingSession, {
            tabId: playbackInput.tabId || existingSession.tabId || null,
            playRequested: false,
            state: "startup_ready",
            lastEvent: "session_warmup_resumed"
          })
        : {
            ...existingSession,
            tabId: playbackInput.tabId || existingSession.tabId || null,
            paused: false,
            stopped: false,
            playRequested: false,
            state: "startup_ready",
            lastEvent: "session_warmup_resumed"
          };
      await this.ensureChapterData(resumedWarmSession);
      await this.saveSession(resumedWarmSession);
      return this.getState(chapterId);
    }

    const nextSession = this.createSessionFromInput(playbackInput, {
      playRequested: false,
      state: "startup_ready",
      lastEvent: "session_warmup_started"
    });

    await this.cleanupExpiredAudioRecords();
    await this.ensureOffscreenDocument();
    await this.ensureChapterData(nextSession);
    await this.saveSession(nextSession);

    return this.getState(chapterId);
  }

  async pause(chapterId = null) {
    return this.runExclusive(() => this.pauseExclusive(chapterId));
  }

  async pauseExclusive(chapterId = null) {
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
      streamStatus: "paused",
      lastEvent: "session_paused"
    };
    await this.saveSession(pausedSession);
    await this.runtimeApi.sendMessage({ type: "PAUSE_PLAYBACK" });
    return this.getState(resolvedChapterId);
  }

  async stop(chapterId = null) {
    return this.runExclusive(() => this.stopExclusive(chapterId));
  }

  async stopExclusive(chapterId = null) {
    const resolvedChapterId = await this.resolveChapterId(chapterId);
    const session = await this.loadSession(resolvedChapterId);
    if (session) {
      const stoppedSession = {
        ...session,
        stopped: true,
        playRequested: false,
        state: "ended",
        playbackStatus: "ended",
        streamStatus: "ended",
        currentChunkId: null,
        lastEvent: "session_stopped"
      };
      await this.saveSession(stoppedSession);
      await this.clearChunkFocus(stoppedSession).catch(() => {});
    }
    await this.runtimeApi.sendMessage({ type: "STOP_PLAYBACK" });
    return this.getState(resolvedChapterId);
  }

  async ensureChapterData(session) {
    const chapterHash = stableHash(session.text);
    const chapter = await this.getChapterRecord(session.chapterId);
    const chunks = chunkText(session.text, {
      storyId: session.storyId,
      chapterId: session.chapterId,
      paragraphs: session.paragraphs || []
    });
    session.totalChunks = chunks.length;

    const existing = await this.getChapterChunkRecords(session.chapterId);

    if (!chapter || chapter.textHash !== chapterHash) {
      await this.mergeChapterChunkData(session, chapter, chunks, existing);
      return;
    }

    if (!existing.length) {
      await this.replaceChapterChunkRecords(session.chapterId, chunks.map((chunk) => ({ ...chunk, status: "pending" })));
    } else {
      if (existing.some((chunk, index) => !this.chunkMatchesExistingRecord(chunk, chunks[index]))) {
        await this.replaceChapterChunkRecords(session.chapterId, chunks.map((chunk) => ({ ...chunk, status: "pending" })));
        return;
      }

      const upgradedChunks = existing
        .map((existingChunk, index) => {
          const nextChunk = chunks[index];
          if (!nextChunk) {
            return null;
          }

          const nextParagraphIds = Array.isArray(nextChunk.paragraphIds) ? nextChunk.paragraphIds.filter(Boolean) : [];
          const existingParagraphIds = Array.isArray(existingChunk.paragraphIds)
            ? existingChunk.paragraphIds.filter(Boolean)
            : [];
          const shouldUpgradeParagraphAnchors =
            nextParagraphIds.length > 0 &&
            (!existingParagraphIds.length ||
              existingParagraphIds.length !== nextParagraphIds.length ||
              !existingParagraphIds.every((paragraphId, paragraphIndex) => paragraphId === nextParagraphIds[paragraphIndex]));

          if (!shouldUpgradeParagraphAnchors) {
            return null;
          }

          return {
            ...existingChunk,
            paragraphId: nextParagraphIds[0] || existingChunk.paragraphId || null,
            paragraphIds: nextParagraphIds,
            status: existingChunk.status || "pending"
          };
        })
        .filter(Boolean);

      if (upgradedChunks.length > 0) {
        await this.saveChunkRecords(upgradedChunks);
      }

      if (existing.length < chunks.length) {
        await this.saveChunkRecords(
          chunks.slice(existing.length).map((chunk) => ({
            ...chunk,
            status: "pending"
          }))
        );
      }
      session.totalChunks = chunks.length;
    }
  }

  getProvider(session) {
    if (session.providerMode === "direct-local") {
      return new LocalKokoroProvider("http://localhost:8880");
    }

    return new ModalKokoroProvider("http://localhost:3000");
  }

  async processSession(chapterId = DEFAULT_CHAPTER_ID) {
    const session = await this.loadSession(chapterId);
    if (!session || session.paused || session.stopped || session.state === "error" || !session.playRequested) {
      return;
    }

    await this.ensureOffscreenDocument();
    await this.startCurrentChunkStream(chapterId);
  }

  async startCurrentChunkStream(chapterId = DEFAULT_CHAPTER_ID) {
    const session = await this.loadSession(chapterId);
    if (!session || session.paused || session.stopped || session.state === "error") {
      return false;
    }

    if (session.currentChunkIndex >= session.totalChunks) {
      const endedSession = {
        ...session,
        state: "ended",
        playbackStatus: "ended",
        streamStatus: "ended",
        currentChunkId: null,
        lastEvent: "session_ended"
      };
      await this.saveSession(endedSession);
      return false;
    }

    const chunk = await this.getChunkRecord(chapterId, session.currentChunkIndex);
    if (!chunk) {
      return false;
    }

    if (!shouldDispatchChunk(session, chunk.chunkId)) {
      return true;
    }

    const offscreenStatus = await this.queryOffscreenPlaybackStatus();
    const offscreenSlot = this.getPreparedSlotSnapshot(offscreenStatus, chunk.chunkId);
    if (offscreenSlot?.role === "active" && (offscreenSlot.streamStatus === "paused" || offscreenSlot.paused)) {
      const resumeResponse = await this.resumeOffscreenPlayback();
      if (resumeResponse?.ok && resumeResponse.resumed) {
        const hasStarted = Boolean(session.hasStartedPlayback);
        await this.saveSession({
          ...session,
          paused: false,
          playRequested: true,
          playbackStatus: hasStarted ? "playing" : "starting",
          state: hasStarted ? "awaiting_chunk_end" : "playback_starting",
          streamStatus: hasStarted ? "playing" : "receiving",
          lastEvent: "stream_resumed"
        });
        return true;
      }
      await this.stopOffscreenPlayback();
    } else if (offscreenSlot?.role === "active" && ["connecting", "buffering", "receiving", "playing"].includes(offscreenSlot.streamStatus)) {
      return true;
    } else if (offscreenSlot?.role === "active" && offscreenSlot.error) {
      await this.stopOffscreenPlayback();
    }

    const attemptId = `${session.chapterId}:attempt:${(session.nextPlaybackAttemptSequence || 0) + 1}`;
    const scheduledSession = {
      ...markChunkScheduled(session, chunk),
      playbackAttemptId: attemptId,
      nextPlaybackAttemptSequence: (session.nextPlaybackAttemptSequence || 0) + 1,
      playbackStatus: "starting",
      state: "playback_starting",
      streamStatus: "connecting",
      bytesReceived: 0,
      bufferedAudioMs: 0,
      firstByteAt: null,
      firstAudioAt: null,
      lastEvent: "stream_dispatch_requested"
    };
    await this.saveSession(scheduledSession);

    try {
      const provider = this.getProvider(scheduledSession);
      const request = provider.createStreamRequest({
        text: chunk.text,
        voice: scheduledSession.voice,
        format: "wav"
      });
      let response = null;
      if (offscreenSlot?.role === "prepared") {
        response = await this.dispatchStartPreparedStream({
          chunkId: chunk.chunkId,
          chapterId,
          attemptId,
          request
        });
        if (!response?.ok) {
          response = await this.dispatchStreamPlayback({
            chunkId: chunk.chunkId,
            chapterId,
            attemptId,
            request
          });
        }
      } else {
        response = await this.dispatchStreamPlayback({
          chunkId: chunk.chunkId,
          chapterId,
          attemptId,
          request
        });
      }
      if (!response?.ok) {
        throw new Error(response?.error || `Failed to dispatch playback for ${chunk.chunkId}`);
      }
      await this.saveSession({
        ...scheduledSession,
        lastEvent: "stream_dispatch_accepted"
      });
      await this.prefetchChunkAtOffset(chapterId, scheduledSession, 1);
      return true;
    } catch (error) {
      const currentSession = (await this.loadSession(chapterId)) || scheduledSession;
      const result = String(error).includes("AbortError")
        ? applyPlaybackInterrupted(currentSession, chunk.chunkId, String(error), attemptId)
        : applyPlaybackError(currentSession, chunk.chunkId, String(error), attemptId);
      await this.saveSession({
        ...result.session,
        streamStatus: result.retryScheduled ? "idle" : "error"
      });
      if (result.retryScheduled) {
        await this.processSession(chapterId);
      }
      return false;
    }
  }

  async handleRuntimeMessage(message) {
    const followUp = await this.runExclusive(() => this.handleRuntimeMessageExclusive(message));
    if (followUp?.refreshSession) {
      await this.refreshChapterDataFromPage(followUp.refreshSession, { resumePlayback: true }).catch(() => {});
    }
    return followUp;
  }

  async handleRuntimeMessageExclusive(message) {
    const chapterId = message.chapterId || DEFAULT_CHAPTER_ID;
    const session = await this.loadSession(chapterId);
    if (!session || session.stopped) {
      return;
    }

    if (message.type === "STREAM_PLAYBACK_PROGRESS") {
      if (session.currentChunkId !== message.chunkId || session.paused) {
        return;
      }

      const nextStreamStatus = message.streamStatus || session.streamStatus || "idle";
      const nextFirstByteAt = message.firstByteAt || session.firstByteAt || null;
      const nextFirstAudioAt = message.firstAudioAt || session.firstAudioAt || null;
      const statusChanged = nextStreamStatus !== session.streamStatus;
      const timestampsChanged =
        nextFirstByteAt !== (session.firstByteAt || null) || nextFirstAudioAt !== (session.firstAudioAt || null);
      const bytesDelta = Math.abs((message.bytesReceived || 0) - (session.bytesReceived || 0));
      const bufferedDelta = Math.abs((message.bufferedAudioMs || 0) - (session.bufferedAudioMs || 0));
      if (!statusChanged && !timestampsChanged && bytesDelta < 65536 && bufferedDelta < 1000) {
        return;
      }

      await this.saveSession({
        ...session,
        streamStatus: nextStreamStatus,
        bytesReceived: message.bytesReceived || 0,
        bufferedAudioMs: message.bufferedAudioMs || 0,
        firstByteAt: nextFirstByteAt,
        firstAudioAt: nextFirstAudioAt,
        stallCount:
          message.streamStatus === "buffering" && session.streamStatus !== "buffering"
            ? (session.stallCount || 0) + 1
            : session.stallCount || 0
      });
      return;
    }

    if (message.type === "STREAM_PREPARE_READY") {
      if (typeof session.currentChunkIndex === "number") {
        const nextChunk = await this.getChunkRecord(chapterId, session.currentChunkIndex + 1);
        if (nextChunk?.chunkId === message.chunkId && STREAM_LOOKAHEAD_DEPTH > 1) {
          await this.prefetchChunkAtOffset(chapterId, session, 2);
        }
      }
      return;
    }

    if (message.type === "CHUNK_PLAYBACK_STARTED") {
      if (session.paused) {
        // A pause landed while the start event was in flight; the offscreen
        // player is already suspended. Record the start without unpausing.
        await this.saveSession({
          ...session,
          hasStartedPlayback: true,
          firstByteAt: session.firstByteAt || message.firstByteAt || null,
          firstAudioAt: session.firstAudioAt || message.firstAudioAt || null
        });
        return;
      }

      const startedSession = {
        ...markPlaybackStarted(session, message.chunkId, message.attemptId || null),
        streamStatus: "playing",
        bytesReceived: message.bytesReceived || session.bytesReceived || 0,
        bufferedAudioMs: message.bufferedAudioMs || session.bufferedAudioMs || 0,
        firstByteAt: message.firstByteAt || session.firstByteAt || Date.now(),
        firstAudioAt: message.firstAudioAt || session.firstAudioAt || Date.now()
      };
      await this.saveSession(startedSession);
      await this.focusChunkOnPage(startedSession, message.chunkId, { clearPrevious: true }).catch(() => {});
      await this.prefetchChunkAtOffset(chapterId, startedSession, 1);
      return { refreshSession: startedSession };
    }

    if (message.type === "CHUNK_PLAYBACK_ENDED") {
      const result = applyPlaybackEnded(session, message.chunkId, message.attemptId || null);
      if (!result.advanced) {
        return;
      }
      await this.saveSession({
        ...result.session,
        streamStatus: result.session.state === "ended" ? "ended" : "idle",
        bytesReceived: 0,
        bufferedAudioMs: 0
      });
      if (result.session.state === "ended") {
        await this.clearChunkFocus(result.session).catch(() => {});
      }
      if (result.session.state !== "ended") {
        await this.processSession(chapterId);
      }
      return;
    }

    if (message.type === "CHUNK_PLAYBACK_INTERRUPTED") {
      if (session.currentChunkId !== message.chunkId) {
        return;
      }

      if (message.attemptId && session.playbackAttemptId && session.playbackAttemptId !== message.attemptId) {
        return;
      }

      const result = applyPlaybackInterrupted(
        session,
        message.chunkId,
        message.error || "Playback start interrupted",
        message.attemptId || null
      );
      await this.saveSession({
        ...result.session,
        streamStatus: result.retryScheduled ? "idle" : "error"
      });
      if (!result.retryScheduled) {
        await this.clearChunkFocus(result.session).catch(() => {});
      }
      if (result.retryScheduled) {
        await this.processSession(chapterId);
      }
      return;
    }

    if (message.type === "CHUNK_PLAYBACK_ERROR") {
      if (session.currentChunkId !== message.chunkId) {
        return;
      }

      if (message.attemptId && session.playbackAttemptId && session.playbackAttemptId !== message.attemptId) {
        return;
      }

      const result = applyPlaybackError(
        session,
        message.chunkId,
        message.error || "Playback failed",
        message.attemptId || null
      );
      await this.saveSession({
        ...result.session,
        streamStatus: result.retryScheduled ? "idle" : "error"
      });
      if (!result.retryScheduled) {
        await this.clearChunkFocus(result.session).catch(() => {});
      }
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
      justification: "Play live-streamed audio chunks outside the popup"
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
        paragraphs: options.paragraphs || [],
        title: options.title || "Wattpad Chapter",
        sourceUrl: options.sourceUrl || "",
        partId: options.partId || options.chapterId || DEFAULT_CHAPTER_ID,
        tabId: options.tabId || null,
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
        paragraphs: [],
        title: options.title || "Manual text",
        sourceUrl: options.sourceUrl || "",
        partId: options.partId || options.chapterId || DEFAULT_CHAPTER_ID,
        tabId: options.tabId || null,
        pageDetected: true,
        pageEligible: true,
        autoplayAllowed: false,
        extractionStrategy: "manual",
        extractionConfidence: "high"
      };
    }

    let tabId = typeof options.tabId === "number" ? options.tabId : null;
    try {
      if (tabId === null) {
        if (typeof this.tabsApi?.query !== "function") {
          return {
            ok: false,
            chapterId: await this.getActiveChapterId(),
            errorMessage: "No active Wattpad tab was found."
          };
        }

        const tabs = await this.tabsApi.query({
          active: true,
          currentWindow: true
        });
        tabId = tabs[0]?.id ?? null;
      }
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
      if (typeof this.tabsApi?.sendMessage !== "function") {
        return {
          ok: false,
          chapterId: await this.getActiveChapterId(),
          errorMessage: "Failed to read the current Wattpad page: page messaging is unavailable."
        };
      }

      extraction = await this.tabsApi.sendMessage(tabId, {
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
      paragraphs: extraction.paragraphs || [],
      title: extraction.title || "Wattpad Chapter",
      sourceUrl: extraction.sourceUrl || "",
      partId: extraction.partId || chapterId,
      tabId,
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
      tabId: input.tabId || null,
      text: "",
      paragraphs: [],
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
      lastCompletedChunkId: null,
      transportMode: "live_stream",
      streamStatus: "error",
      bytesReceived: 0,
      bufferedAudioMs: 0,
      firstByteAt: null,
      firstAudioAt: null,
      stallCount: 0
    };

    await this.setActiveChapterId(chapterId);
    await this.saveSession(session);
    return this.getState(chapterId);
  }
}
