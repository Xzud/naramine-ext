import {
  CACHE_TTL_MS,
  DEFAULT_CHAPTER_ID,
  DEFAULT_PROVIDER_MODE,
  DEFAULT_STORY_ID,
  DEFAULT_VOICE,
  STREAM_LOOKAHEAD_DEPTH
} from "../shared/constants.js";
import { groupLibraryByStory } from "../shared/libraryState.js";
import { applySyncToggle, isStorySyncEnabled, planSyncStart } from "../shared/syncState.js";
import { chunkText, stableHash } from "../text/chunkText.js";
import {
  cleanupExpiredAudio,
  deleteChapterData,
  deleteStoryMetadata,
  getAllStoryMetadata,
  getAudioChunksByChapter,
  getCacheStatus,
  getChapter,
  getChapterIdsByStory,
  getChunkByIndex,
  getChunksByChapter,
  getLibraryOverview,
  saveAudioChunk,
  saveChunks,
  saveStoryMetadata,
  replaceChapterData,
  saveChapter,
  updateChunkStatus
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
const NEXT_CHAPTER_PREFETCH_KEY = "readaloud:nextChapterPrefetch";
const SYNC_STORIES_KEY = "readaloud:syncStories";
const SYNC_BACKFILL_KEY = "readaloud:syncBackfill";
const LAST_PLAYED_KEY = "readaloud:lastPlayedByStory";
const RESUME_TARGET_KEY = "readaloud:resumeTarget";
const LAST_PLAYED_LIMIT = 30;
const CHAPTER_REFRESH_LOOKAHEAD = 3;
const PREFETCH_EXTRACT_ATTEMPTS = 6;
const PREFETCH_EXTRACT_RETRY_MS = 1000;
const PLAYBACK_RUNTIME_EVENTS = new Set([
  "CHUNK_PLAYBACK_STARTED",
  "CHUNK_PLAYBACK_ENDED",
  "CHUNK_PLAYBACK_ERROR",
  "CHUNK_PLAYBACK_INTERRUPTED",
  "STREAM_PLAYBACK_PROGRESS",
  "STREAM_PREPARE_READY",
  "STREAM_PREPARE_ERROR"
]);
// Lifecycle transitions after which yielded warmup pipelines should re-check
// whether they can run (playback startup finished, chunk advanced, or the
// session hit a terminal state).
const WARMUP_RESUME_EVENTS = new Set([
  "CHUNK_PLAYBACK_STARTED",
  "CHUNK_PLAYBACK_ENDED",
  "CHUNK_PLAYBACK_ERROR",
  "CHUNK_PLAYBACK_INTERRUPTED"
]);

function isAbortError(error) {
  return error?.name === "AbortError" || /abort/i.test(String(error));
}

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
    this.prefetchTaskChain = Promise.resolve();
    this.activeWarmups = new Map();
    this.pendingWarmups = new Set();
    this.warmupFetchControllers = new Map();
    this.nextChapterPrefetchTask = null;
    this.runtimeApi.onMessage.addListener((message) => {
      if (!PLAYBACK_RUNTIME_EVENTS.has(message?.type)) {
        return undefined;
      }

      void this.handleRuntimeMessage(message);
      return undefined;
    });
    this.tabsApi?.onUpdated?.addListener?.((tabId, changeInfo) => {
      void this.handlePrefetchTabUpdated(tabId, changeInfo).catch(() => {});
      void this.handleBackfillTabUpdated(tabId, changeInfo).catch(() => {});
      void this.handleResumeTabUpdated?.(tabId, changeInfo).catch(() => {});
    });
    this.tabsApi?.onRemoved?.addListener?.((tabId) => {
      void this.handlePrefetchTabRemoved(tabId).catch(() => {});
      void this.handleBackfillTabRemoved(tabId).catch(() => {});
      void this.handleResumeTabRemoved?.(tabId).catch(() => {});
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

  // The next-chapter prefetch record is mutated from independent signals (tab
  // load events, chapter-end advance, tab removal). Serializing those writes
  // keeps a "play when ready" flag from being lost to a concurrent
  // ready-status write. Separate from the session lock because prefetch work
  // runs inside session-exclusive sections.
  runPrefetchExclusive(task) {
    const result = this.prefetchTaskChain.then(() => task());
    this.prefetchTaskChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  // The popup timer derives from playbackElapsedMs plus a live component
  // while playbackResumedAt is set; folding stops the clock exactly when
  // audio stops (pause, stop, chapter end, fatal error).
  foldPlaybackClock(session, now = Date.now()) {
    if (!session.playbackResumedAt) {
      return session;
    }
    return {
      ...session,
      playbackElapsedMs: (session.playbackElapsedMs || 0) + Math.max(0, now - session.playbackResumedAt),
      playbackResumedAt: null
    };
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

  async getAudioRecordsForChapter(chapterId) {
    return getAudioChunksByChapter(chapterId);
  }

  async saveAudioRecord(record) {
    return saveAudioChunk(record);
  }

  async markChunkStatus(chunkId, status) {
    return updateChunkStatus(chunkId, status);
  }

  async fetchAudioForChunk(session, chunk, { signal = null } = {}) {
    const provider = this.getProvider(session);
    const request = provider.createStreamRequest({
      text: chunk.text,
      voice: session.voice,
      format: "wav"
    });
    const response = await fetch(request.url, {
      method: request.method || "POST",
      headers: request.headers || {},
      body: request.body,
      signal
    });
    if (!response.ok) {
      throw new Error(`Warmup synthesis failed: ${response.status}`);
    }
    return response.blob();
  }

  isWarmableSession(session) {
    return Boolean(session) && Boolean(session.text) && !session.stopped && session.state !== "error";
  }

  // A play request whose live stream has not produced audio yet. While this
  // is true the TTS backend belongs to the live stream, not warming.
  isPlaybackStartupInFlight(session) {
    if (!session || session.paused || session.stopped || !session.playRequested) {
      return false;
    }
    return (
      session.state === "playback_starting" ||
      session.playbackStatus === "dispatching" ||
      session.playbackStatus === "starting" ||
      session.streamStatus === "connecting"
    );
  }

  // Sessions that never started playing warm from the top (so the chapter can
  // become a complete download); playing sessions only warm ahead of the
  // playhead.
  getWarmupFloorIndex(session) {
    if (!session.hasStartedPlayback && !session.playRequested) {
      return -1;
    }
    return typeof session.currentChunkIndex === "number" ? session.currentChunkIndex : -1;
  }

  async hasWarmableChunk(chapterId, session) {
    return Boolean(await this.findNextChunkToWarm(chapterId, this.getWarmupFloorIndex(session)));
  }

  async findNextChunkToWarm(chapterId, fromChunkIndex) {
    const [chunks, audioRecords] = await Promise.all([
      this.getChapterChunkRecords(chapterId),
      this.getAudioRecordsForChapter(chapterId)
    ]);
    const cachedChunkIds = new Set(audioRecords.map((record) => record.chunkId));
    return (
      chunks.find(
        (chunk) =>
          chunk.chunkIndex > fromChunkIndex && !cachedChunkIds.has(chunk.chunkId) && chunk.status !== "failed"
      ) || null
    );
  }

  // Decides whether a chapter's pipeline may synthesize right now. "yield"
  // parks the pipeline in pendingWarmups until resumePendingWarmups re-kicks
  // it: the live stream's startup always wins, and the active chapter must be
  // fully warm before any other chapter (the prefetched next one) proceeds.
  async resolveWarmupGate(chapterId) {
    const activeChapterId = await this.getActiveChapterId();
    const activeSession = await this.loadSession(activeChapterId);

    if (this.isPlaybackStartupInFlight(activeSession)) {
      return "yield";
    }

    if (
      chapterId !== activeChapterId &&
      this.isWarmableSession(activeSession) &&
      (await this.hasWarmableChunk(activeChapterId, activeSession))
    ) {
      void this.ensureWarmingPipeline(activeChapterId);
      return "yield";
    }

    return "proceed";
  }

  // Re-kicks pipelines that yielded. Called when a pipeline finishes (the
  // next chapter resumes once the current one is warm), after playback
  // lifecycle events (startup finished or failed), and on pause/stop.
  resumePendingWarmups(excludeChapterId = null) {
    for (const chapterId of [...this.pendingWarmups]) {
      if (chapterId === excludeChapterId) {
        continue;
      }
      this.pendingWarmups.delete(chapterId);
      void this.ensureWarmingPipeline(chapterId);
    }
  }

  // Cancels in-flight warmup synthesis so a fresh play request does not queue
  // behind it at the TTS backend. Aborted chunks stay pending and are
  // retried once the pipeline's gate clears.
  interruptWarmupFetches({ exceptChapterId = null } = {}) {
    for (const [chapterId, controller] of this.warmupFetchControllers) {
      if (exceptChapterId !== null && chapterId === exceptChapterId) {
        continue;
      }
      controller.abort();
    }
  }

  // Continuously synthesizes chunks ahead of the playhead into the IndexedDB
  // audio cache, one at a time, until the chapter tail is warm. Single-flight
  // per chapter; safe to invoke from anywhere because it never writes the
  // session, so it runs outside the session lock. Re-invoking after the
  // chapter grows (lazy-loaded pages) resumes warming the new tail.
  ensureWarmingPipeline(chapterId) {
    if (!chapterId) {
      return Promise.resolve("skipped");
    }
    const existing = this.activeWarmups.get(chapterId);
    if (existing) {
      return existing;
    }
    this.pendingWarmups.delete(chapterId);
    const pipeline = this.runWarmingPipeline(chapterId)
      .catch(() => "errored")
      .then((outcome) => {
        this.activeWarmups.delete(chapterId);
        if (outcome !== "yielded") {
          this.resumePendingWarmups(chapterId);
        }
        return outcome;
      });
    this.activeWarmups.set(chapterId, pipeline);
    return pipeline;
  }

  async runWarmingPipeline(chapterId) {
    const attemptedChunkIds = new Set();
    while (true) {
      const session = await this.loadSession(chapterId);
      if (!this.isWarmableSession(session)) {
        return "completed";
      }

      const chunk = await this.findNextChunkToWarm(chapterId, this.getWarmupFloorIndex(session));
      if (!chunk || attemptedChunkIds.has(chunk.chunkId)) {
        return "completed";
      }

      const gate = await this.resolveWarmupGate(chapterId);
      if (gate !== "proceed") {
        this.pendingWarmups.add(chapterId);
        this.log("warmup_yielded", session, { chapterId, chunkId: chunk.chunkId });
        return "yielded";
      }

      attemptedChunkIds.add(chunk.chunkId);
      const controller = new AbortController();
      this.warmupFetchControllers.set(chapterId, controller);
      try {
        const blob = await this.fetchAudioForChunk(session, chunk, { signal: controller.signal });
        await this.saveAudioRecord({
          chunkId: chunk.chunkId,
          chapterId,
          chunkIndex: chunk.chunkIndex,
          blob,
          mimeType: blob?.type || "audio/wav",
          createdAt: Date.now()
        });
        await this.markChunkStatus(chunk.chunkId, "ready");
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          // Interrupted so a play request gets the backend immediately; leave
          // the chunk pending and let the gate decide when to retry it.
          attemptedChunkIds.delete(chunk.chunkId);
          this.log("warmup_chunk_interrupted", session, { chunkId: chunk.chunkId });
          continue;
        }
        await this.markChunkStatus(chunk.chunkId, "failed").catch(() => {});
        this.log("warmup_chunk_failed", session, { chunkId: chunk.chunkId, error: String(error) });
      } finally {
        if (this.warmupFetchControllers.get(chapterId) === controller) {
          this.warmupFetchControllers.delete(chapterId);
        }
      }
    }
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

  async focusSessionTab(session) {
    if (typeof this.tabsApi?.update !== "function" || typeof session?.tabId !== "number") {
      return;
    }
    try {
      await this.tabsApi.update(session.tabId, { active: true });
    } catch (_error) {
      // The tab may have been closed; playback does not require it focused.
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
      expiresAt: Date.now() + CACHE_TTL_MS
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
      nextPartId: response.nextPart?.partId || latestSession.nextPartId || null,
      nextPartUrl: response.nextPart?.url || latestSession.nextPartUrl || null,
      nextPartTitle: response.nextPart?.title || latestSession.nextPartTitle || null,
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
    // The chapter grew, so the current chapter has unwarmed chunks again; pull
    // the backend away from any other chapter (the prefetched next one) now
    // instead of waiting for its current chunk to finish synthesizing.
    this.interruptWarmupFetches({ exceptChapterId: refreshedSession.chapterId });
    void this.ensureWarmingPipeline(refreshedSession.chapterId);
    if (resumePlayback) {
      await this.processSession(refreshedSession.chapterId);
    }
    return true;
  }

  async loadPrefetchRecord() {
    const values = await this.storageArea.get(NEXT_CHAPTER_PREFETCH_KEY);
    return values[NEXT_CHAPTER_PREFETCH_KEY] || null;
  }

  async savePrefetchRecord(record) {
    await this.storageArea.set({ [NEXT_CHAPTER_PREFETCH_KEY]: record });
  }

  async clearPrefetchRecord() {
    if (typeof this.storageArea.remove === "function") {
      await this.storageArea.remove(NEXT_CHAPTER_PREFETCH_KEY);
      return;
    }
    await this.storageArea.set({ [NEXT_CHAPTER_PREFETCH_KEY]: null });
  }

  async prefetchTabExists(tabId) {
    if (typeof tabId !== "number") {
      return false;
    }
    if (typeof this.tabsApi?.get !== "function") {
      return true;
    }
    try {
      return Boolean(await this.tabsApi.get(tabId));
    } catch (_error) {
      return false;
    }
  }

  // Opens the playing chapter's next part in a background tab so its DOM can
  // be scanned and its audio warmed before the current chapter finishes.
  // Single-flight plus the stored record keep repeated chunk-advance signals
  // from opening duplicate tabs.
  ensureNextChapterPrefetch(session) {
    if (this.nextChapterPrefetchTask) {
      return this.nextChapterPrefetchTask;
    }
    const task = this.openNextChapterPrefetch(session)
      .catch(() => false)
      .finally(() => {
        this.nextChapterPrefetchTask = null;
      });
    this.nextChapterPrefetchTask = task;
    return task;
  }

  async openNextChapterPrefetch(session, { active = false, playOnReady = false } = {}) {
    if (!session?.nextPartUrl || typeof this.tabsApi?.create !== "function") {
      return false;
    }
    if (session.stopped || session.state === "error") {
      return false;
    }
    if (session.nextPartId && String(session.nextPartId) === String(session.chapterId)) {
      return false;
    }

    return this.runPrefetchExclusive(async () => {
      const record = await this.loadPrefetchRecord();
      if (record && record.fromChapterId === session.chapterId && record.url === session.nextPartUrl) {
        if (record.status === "failed") {
          return false;
        }
        if (await this.prefetchTabExists(record.tabId)) {
          return true;
        }
      }

      const tab = await this.tabsApi.create({ url: session.nextPartUrl, active });
      await this.savePrefetchRecord({
        fromChapterId: session.chapterId,
        fromTabId: typeof session.tabId === "number" ? session.tabId : null,
        nextChapterId: session.nextPartId || null,
        url: session.nextPartUrl,
        tabId: tab?.id ?? null,
        status: "opening",
        playOnReady,
        createdAt: Date.now()
      });
      this.log("next_chapter_prefetch_opened", session, {
        url: session.nextPartUrl,
        tabId: tab?.id ?? null,
        active
      });
      return true;
    });
  }

  async handlePrefetchTabUpdated(tabId, changeInfo) {
    if (changeInfo?.status !== "complete") {
      return;
    }

    const claimedRecord = await this.runPrefetchExclusive(async () => {
      const record = await this.loadPrefetchRecord();
      if (!record || record.tabId !== tabId || record.status !== "opening") {
        return null;
      }
      const warmingRecord = { ...record, status: "warming" };
      await this.savePrefetchRecord(warmingRecord);
      return warmingRecord;
    });

    if (claimedRecord) {
      await this.processPrefetchedTab(claimedRecord);
    }
  }

  async handlePrefetchTabRemoved(tabId) {
    await this.runPrefetchExclusive(async () => {
      const record = await this.loadPrefetchRecord();
      if (record && record.tabId === tabId) {
        await this.clearPrefetchRecord();
      }
    });
  }

  // The prefetched page hydrates after the tab reports complete, so the
  // first extraction attempts may come back empty; retry briefly.
  async extractFromTabWithRetry(tabId, attempts = PREFETCH_EXTRACT_ATTEMPTS, delayMs = PREFETCH_EXTRACT_RETRY_MS) {
    let extraction = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      extraction = await this.sendPageCommand(tabId, { type: "READALOUD_EXTRACT_TEXT" });
      if (extraction?.ok && extraction.text) {
        return extraction;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return extraction;
  }

  // Scans the background tab's DOM, stores a warm (non-active) session for
  // the next chapter, and starts synthesizing its audio cache. The active
  // chapter pointer is untouched until the current chapter actually ends.
  async processPrefetchedTab(record) {
    const extraction = await this.extractFromTabWithRetry(record.tabId);
    if (!extraction?.ok || !extraction.text) {
      await this.runPrefetchExclusive(async () => {
        const latest = await this.loadPrefetchRecord();
        if (latest && latest.tabId === record.tabId) {
          await this.savePrefetchRecord({
            ...latest,
            status: "failed",
            error: extraction?.error || "prefetch_extract_failed"
          });
        }
      });
      this.log("next_chapter_prefetch_extract_failed", {}, {
        tabId: record.tabId,
        error: extraction?.error || null
      });
      return;
    }

    const chapterId = await this.warmupPrefetchedChapter(record, extraction);
    if (!chapterId) {
      return;
    }

    const readyRecord = await this.runPrefetchExclusive(async () => {
      const latest = await this.loadPrefetchRecord();
      if (!latest || latest.tabId !== record.tabId) {
        return null;
      }
      const nextRecord = { ...latest, nextChapterId: chapterId, status: "ready" };
      await this.savePrefetchRecord(nextRecord);
      return nextRecord;
    });
    if (!readyRecord) {
      return;
    }

    this.log("next_chapter_prefetch_ready", {}, { chapterId, tabId: record.tabId });
    void this.ensureWarmingPipeline(chapterId);
    if (readyRecord.playOnReady) {
      await this.activatePrefetchedChapter(readyRecord);
    }
  }

  async warmupPrefetchedChapter(record, extraction) {
    return this.runExclusive(async () => {
      const playbackInput = await this.resolvePlaybackInput({ ...extraction, tabId: record.tabId });
      if (!playbackInput.ok) {
        return null;
      }

      const chapterId = playbackInput.chapterId;
      const existingSession = await this.loadSession(chapterId);
      const session =
        existingSession && existingSession.text === playbackInput.text && existingSession.state !== "error"
          ? { ...existingSession, tabId: record.tabId }
          : this.createSessionFromInput(playbackInput, {
              playRequested: false,
              state: "startup_ready",
              lastEvent: "next_chapter_prefetched"
            });
      await this.ensureChapterData(session);
      await this.saveSession(session);
      return chapterId;
    });
  }

  // Moves playback onto the prefetched chapter once the current one finishes.
  // If the warm tab is still loading, mark it play-on-ready and surface it;
  // if there is no prefetch at all, open the next part directly.
  async advanceToNextChapter(endedSession) {
    if (!endedSession?.chapterId) {
      return false;
    }

    const decision = await this.runPrefetchExclusive(async () => {
      const record = await this.loadPrefetchRecord();
      if (
        !record ||
        record.fromChapterId !== endedSession.chapterId ||
        !(await this.prefetchTabExists(record.tabId))
      ) {
        return { action: "open_directly" };
      }

      const mergedRecord = {
        ...record,
        fromTabId: typeof record.fromTabId === "number" ? record.fromTabId : endedSession.tabId ?? null
      };
      if (record.status === "ready" && record.nextChapterId) {
        await this.savePrefetchRecord(mergedRecord);
        return { action: "activate", record: mergedRecord };
      }
      if (record.status === "opening" || record.status === "warming") {
        await this.savePrefetchRecord({ ...mergedRecord, playOnReady: true });
        return { action: "wait", record: mergedRecord };
      }
      return { action: "open_directly" };
    });

    if (decision.action === "activate") {
      return this.activatePrefetchedChapter(decision.record);
    }

    if (decision.action === "wait") {
      if (typeof this.tabsApi?.update === "function" && typeof decision.record.tabId === "number") {
        try {
          await this.tabsApi.update(decision.record.tabId, { active: true });
        } catch (_error) {
          // The tab may have been closed between the existence check and now.
        }
      }
      this.log("auto_advance_waiting_for_prefetch", endedSession, { tabId: decision.record.tabId });
      return true;
    }

    if (!endedSession.nextPartUrl) {
      this.log("auto_advance_no_next_chapter", endedSession);
      return false;
    }

    return this.openNextChapterPrefetch(endedSession, { active: true, playOnReady: true });
  }

  async activatePrefetchedChapter(record) {
    if (!record?.nextChapterId) {
      return false;
    }

    await this.runPrefetchExclusive(() => this.clearPrefetchRecord());

    if (typeof this.tabsApi?.update === "function" && typeof record.tabId === "number") {
      try {
        await this.tabsApi.update(record.tabId, { active: true });
      } catch (_error) {
        // Keep going; playback does not require the tab to be focused.
      }
    }

    await this.setActiveChapterId(record.nextChapterId);
    await this.runExclusive(async () => {
      const session = await this.loadSession(record.nextChapterId);
      if (!session?.text || session.state === "error") {
        return;
      }
      const startedSession = {
        ...session,
        tabId: typeof record.tabId === "number" ? record.tabId : session.tabId || null,
        paused: false,
        stopped: false,
        playRequested: true,
        state: "playback_starting",
        playbackStatus: "idle",
        streamStatus: "idle",
        lastEvent: "auto_advanced_to_next_chapter",
        errorMessage: null
      };
      await this.saveSession(startedSession);
      await this.ensureOffscreenDocument();
      this.interruptWarmupFetches();
      await this.processSession(record.nextChapterId);
    });

    this.log("auto_advance_started", {}, { chapterId: record.nextChapterId, tabId: record.tabId });

    await this.cleanupChapter(record.fromChapterId, record.fromTabId, { keepTabId: record.tabId });
    return true;
  }

  async loadSyncStories() {
    const values = await this.storageArea.get(SYNC_STORIES_KEY);
    return values[SYNC_STORIES_KEY] || {};
  }

  async saveSyncStories(syncStories) {
    await this.storageArea.set({ [SYNC_STORIES_KEY]: syncStories });
  }

  async isSyncEnabled(storyId) {
    return isStorySyncEnabled(await this.loadSyncStories(), storyId);
  }

  // Asks the page what it is: a chapter (returns the full extraction), a
  // story overview (returns scraped metadata), or neither. The popup has no
  // page access of its own, so sync requests route through here.
  async getPageContext(tabId = null) {
    let resolvedTabId = typeof tabId === "number" ? tabId : null;
    if (resolvedTabId === null && typeof this.tabsApi?.query === "function") {
      try {
        const tabs = await this.tabsApi.query({ active: true, currentWindow: true });
        resolvedTabId = tabs[0]?.id ?? null;
      } catch (_error) {
        resolvedTabId = null;
      }
    }
    if (typeof resolvedTabId !== "number") {
      return { kind: "none", ok: false };
    }

    const context = await this.sendPageCommand(resolvedTabId, { type: "READALOUD_GET_PAGE_CONTEXT" });
    if (!context || typeof context !== "object" || !context.kind) {
      return { kind: "none", ok: false };
    }
    return { ...context, tabId: resolvedTabId };
  }

  async getSyncStatus(payload = {}) {
    const context = await this.getPageContext(typeof payload.tabId === "number" ? payload.tabId : null);
    const storyId = payload.storyId || context.storyId || null;
    if (!storyId) {
      return { ok: false, storyId: null, enabled: false, kind: context.kind };
    }
    return { ok: true, storyId, enabled: await this.isSyncEnabled(storyId), kind: context.kind };
  }

  async setSyncEnabled(payload = {}) {
    const context = await this.getPageContext(typeof payload.tabId === "number" ? payload.tabId : null);
    const storyId = payload.storyId || context.storyId || null;
    if (!storyId) {
      return { ok: false, storyId: null, enabled: false, kind: context.kind, error: "no_story_context" };
    }

    const enabled = Boolean(payload.enabled);
    await this.saveSyncStories(applySyncToggle(await this.loadSyncStories(), storyId, enabled));
    this.log(enabled ? "sync_enabled" : "sync_disabled", {}, { storyId, kind: context.kind });

    if (enabled && context.storyId === storyId && context.kind !== "none") {
      await this.startSyncFromContext(context).catch((error) => {
        this.log("sync_start_failed", {}, { storyId, error: String(error) });
      });
    }
    return { ok: true, storyId, enabled, kind: context.kind };
  }

  // Runs the Sync-On kickoff ordering from the page the user toggled on:
  // the focused chapter, then a chapter-1 backfill, then the next chapter.
  async startSyncFromContext(context) {
    if (context.kind === "story") {
      await this.handleStoryPageReady(context).catch(() => {});
    }

    for (const step of planSyncStart(context)) {
      if (step.action === "warm-current") {
        // warmup notices the now-enabled sync flag and starts the download
        // pipeline plus the next-chapter prefetch itself.
        await this.warmup({ ...context, tabId: context.tabId ?? null });
      } else if (step.action === "backfill") {
        await this.openSyncBackfill({
          storyId: context.storyId || null,
          url: step.url,
          partId: step.partId,
          chainNext: step.chainNext,
          activateOnReady: step.activateOnReady
        });
      } else if (step.action === "prefetch-next") {
        const session = await this.loadSession(context.partId);
        if (session) {
          void this.ensureNextChapterPrefetch(session);
        }
      }
    }
  }

  // With Sync on for the story, every visited chapter downloads fully and
  // the next chapter prefetches behind it; the warmup gate keeps the focused
  // chapter ahead of the prefetched one. The frontier therefore follows the
  // user: N+2 stays unreachable until they actually reach N+1.
  async maybeStartStorySync(session) {
    if (!session?.chapterId || !(await this.isSyncEnabled(session.storyId))) {
      return false;
    }
    void this.ensureWarmingPipeline(session.chapterId);
    void this.ensureNextChapterPrefetch(session);
    return true;
  }

  async loadBackfillRecord() {
    const values = await this.storageArea.get(SYNC_BACKFILL_KEY);
    return values[SYNC_BACKFILL_KEY] || null;
  }

  async saveBackfillRecord(record) {
    await this.storageArea.set({ [SYNC_BACKFILL_KEY]: record });
  }

  async clearBackfillRecord() {
    if (typeof this.storageArea.remove === "function") {
      await this.storageArea.remove(SYNC_BACKFILL_KEY);
      return;
    }
    await this.storageArea.set({ [SYNC_BACKFILL_KEY]: null });
  }

  // Opens the story's first chapter in a background tab so a user who turned
  // Sync on mid-novel also gets the beginning. Single slot: only chapter 1
  // is ever backfilled, and re-triggering while one runs is a no-op. Shares
  // the prefetch lock because both records are low-traffic tab lifecycles.
  async openSyncBackfill({ storyId, url, partId = null, chainNext = false, activateOnReady = false }) {
    if (!url || typeof this.tabsApi?.create !== "function") {
      return false;
    }
    if (partId && (await this.getChapterRecord(partId))) {
      return false;
    }

    return this.runPrefetchExclusive(async () => {
      const record = await this.loadBackfillRecord();
      if (record && record.url === url && record.status !== "failed" && (await this.prefetchTabExists(record.tabId))) {
        return true;
      }

      const tab = await this.tabsApi.create({ url, active: false });
      await this.saveBackfillRecord({
        storyId: storyId || null,
        url,
        partId,
        tabId: tab?.id ?? null,
        status: "opening",
        chainNext,
        activateOnReady,
        createdAt: Date.now()
      });
      this.log("sync_backfill_opened", {}, { url, tabId: tab?.id ?? null });
      return true;
    });
  }

  async handleBackfillTabUpdated(tabId, changeInfo) {
    if (changeInfo?.status !== "complete") {
      return;
    }

    const claimedRecord = await this.runPrefetchExclusive(async () => {
      const record = await this.loadBackfillRecord();
      if (!record || record.tabId !== tabId || record.status !== "opening") {
        return null;
      }
      const warmingRecord = { ...record, status: "warming" };
      await this.saveBackfillRecord(warmingRecord);
      return warmingRecord;
    });

    if (claimedRecord) {
      await this.processBackfillTab(claimedRecord);
    }
  }

  async handleBackfillTabRemoved(tabId) {
    await this.runPrefetchExclusive(async () => {
      const record = await this.loadBackfillRecord();
      if (record && record.tabId === tabId) {
        await this.clearBackfillRecord();
      }
    });
  }

  // Scans the backfill tab like a prefetched chapter: extract, store a warm
  // session, and start its download. activateOnReady covers the novel-page
  // trigger, where Play in the popup should start chapter 1 (and only then
  // switch to its tab); chainNext covers chapter 2 syncing behind it.
  async processBackfillTab(record) {
    const extraction = await this.extractFromTabWithRetry(record.tabId);
    if (!extraction?.ok || !extraction.text) {
      await this.runPrefetchExclusive(async () => {
        const latest = await this.loadBackfillRecord();
        if (latest && latest.tabId === record.tabId) {
          await this.saveBackfillRecord({
            ...latest,
            status: "failed",
            error: extraction?.error || "backfill_extract_failed"
          });
        }
      });
      this.log("sync_backfill_extract_failed", {}, { tabId: record.tabId, error: extraction?.error || null });
      return;
    }

    const chapterId = await this.warmupPrefetchedChapter(record, extraction);
    if (!chapterId) {
      return;
    }

    await this.runPrefetchExclusive(async () => {
      const latest = await this.loadBackfillRecord();
      if (latest && latest.tabId === record.tabId) {
        await this.saveBackfillRecord({ ...latest, chapterId, status: "ready" });
      }
    });
    this.log("sync_backfill_ready", {}, { chapterId, tabId: record.tabId });

    if (record.activateOnReady) {
      await this.setActiveChapterId(chapterId);
      await this.runExclusive(async () => {
        const session = await this.loadSession(chapterId);
        if (session) {
          await this.saveSession({ ...session, focusTabOnPlay: true });
        }
      });
    }

    void this.ensureWarmingPipeline(chapterId);

    if (record.chainNext) {
      const session = await this.loadSession(chapterId);
      if (session?.nextPartUrl) {
        void this.ensureNextChapterPrefetch(session);
      }
    }
  }

  // Novel-page visits only record metadata (name, cover, author, avatar);
  // downloads start from chapter visits or the Sync-On trigger.
  async handleStoryPageReady(payload = {}) {
    if (!payload?.storyId) {
      return { ok: false, error: "missing_story_id" };
    }
    await this.saveStoryMetadataRecord({
      storyId: payload.storyId,
      title: payload.title || "",
      author: payload.author || "",
      coverUrl: payload.coverUrl || "",
      avatarUrl: payload.avatarUrl || "",
      sourceUrl: payload.sourceUrl || "",
      firstPartId: payload.firstPart?.partId || null,
      firstPartUrl: payload.firstPart?.url || null,
      updatedAt: Date.now()
    });
    return { ok: true, storyId: payload.storyId };
  }

  async saveStoryMetadataRecord(record) {
    return saveStoryMetadata(record);
  }

  async getStoryMetadataRecords() {
    return getAllStoryMetadata();
  }

  async deleteStoryMetadataRecord(storyId) {
    return deleteStoryMetadata(storyId);
  }

  // Drops the live resources owned by a finished chapter: its tab and its
  // persisted session. Cached chunk and audio records stay in IndexedDB so
  // the chapter remains in the downloads library until the user deletes it.
  async cleanupChapter(chapterId, tabId = null, { keepTabId = null } = {}) {
    if (typeof this.tabsApi?.remove === "function" && typeof tabId === "number" && tabId !== keepTabId) {
      try {
        await this.tabsApi.remove(tabId);
      } catch (_error) {
        // The user may have already closed it.
      }
    }

    if (!chapterId) {
      return;
    }
    await this.deleteSession(chapterId).catch(() => {});
    this.log("chapter_cleaned_up", {}, { chapterId, tabId });
  }

  async deleteChapterRecords(chapterId) {
    return deleteChapterData(chapterId);
  }

  async getLibraryOverviewRecords() {
    return getLibraryOverview();
  }

  async getChapterIdsForStory(storyId) {
    return getChapterIdsByStory(storyId);
  }

  async getLibrary() {
    const [overview, activeChapterId, storyMetadata] = await Promise.all([
      this.getLibraryOverviewRecords(),
      this.getActiveChapterId(),
      this.getStoryMetadataRecords().catch(() => [])
    ]);
    return {
      ok: true,
      stories: groupLibraryByStory(overview, {
        // Yielded pipelines are still queued work, so they read as processing.
        warmingChapterIds: [...this.activeWarmups.keys(), ...this.pendingWarmups],
        activeChapterId,
        storyMetadataById: Object.fromEntries((storyMetadata || []).map((record) => [record.storyId, record]))
      })
    };
  }

  async deleteDownloadedChapter(chapterId) {
    await this.runExclusive(() => this.deleteDownloadedChapterExclusive(chapterId));
    return this.getLibrary();
  }

  // Deleting the session first starves the warming pipeline (it reloads the
  // session before every chunk), so an in-flight warmup stops on its own.
  async deleteDownloadedChapterExclusive(chapterId) {
    if (!chapterId) {
      return;
    }

    this.pendingWarmups.delete(chapterId);
    this.warmupFetchControllers.get(chapterId)?.abort();

    const [session, activeChapterId] = await Promise.all([this.loadSession(chapterId), this.getActiveChapterId()]);
    if (session && !session.stopped && chapterId === activeChapterId) {
      await this.stopOffscreenPlayback();
    }
    await this.deleteSession(chapterId).catch(() => {});
    await this.deleteChapterRecords(chapterId);
    this.log("downloaded_chapter_deleted", {}, { chapterId });
  }

  async deleteDownloadedStory(storyId) {
    if (storyId) {
      await this.runExclusive(async () => {
        const chapterIds = await this.getChapterIdsForStory(storyId);
        for (const chapterId of chapterIds) {
          await this.deleteDownloadedChapterExclusive(chapterId);
        }
      });
      // Deleting a novel also turns its sync off; re-syncing is an explicit
      // (re-charged) user action, not something an open tab should restart.
      await this.saveSyncStories(applySyncToggle(await this.loadSyncStories(), storyId, false));
      await this.deleteStoryMetadataRecord(storyId).catch(() => {});
    }
    return this.getLibrary();
  }

  async deleteSession(chapterId) {
    if (typeof this.storageArea.remove === "function") {
      await this.storageArea.remove(this.getSessionKey(chapterId));
      return;
    }
    await this.storageArea.set({ [this.getSessionKey(chapterId)]: null });
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
    this.interruptWarmupFetches();
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
      ...this.foldPlaybackClock(session),
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
      nextPartId: playbackInput.nextPart?.partId || null,
      nextPartUrl: playbackInput.nextPart?.url || null,
      nextPartTitle: playbackInput.nextPart?.title || null,
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
      playbackElapsedMs: 0,
      playbackResumedAt: null,
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
      playbackElapsedMs: 0,
      playbackResumedAt: null,
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
          playbackResumedAt: hasStarted ? Date.now() : existingSession.playbackResumedAt || null,
          lastEvent: "session_resumed",
          errorMessage: null
        };
        await this.ensureChapterData(resumedSession);
        await this.saveSession(resumedSession);
        void this.ensureWarmingPipeline(activeChapterId);
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
      if (existingSession.focusTabOnPlay) {
        // A backfilled chapter 1 lives in a background tab; the spec switches
        // to it only when the user actually hits Play.
        resumedWarmSession.focusTabOnPlay = false;
        await this.focusSessionTab(resumedWarmSession);
      }
      await this.ensureChapterData(resumedWarmSession);
      await this.saveSession(resumedWarmSession);
      await this.ensureOffscreenDocument();
      this.interruptWarmupFetches();
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
    this.interruptWarmupFetches();
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
      const nextPartUpgrade = {
        nextPartId: playbackInput.nextPart?.partId || existingSession.nextPartId || null,
        nextPartUrl: playbackInput.nextPart?.url || existingSession.nextPartUrl || null,
        nextPartTitle: playbackInput.nextPart?.title || existingSession.nextPartTitle || null
      };
      const resumedWarmSession = existingSession.stopped || existingSession.state === "ended"
        ? this.createRestartedSession(existingSession, {
            tabId: playbackInput.tabId || existingSession.tabId || null,
            playRequested: false,
            state: "startup_ready",
            lastEvent: "session_warmup_resumed",
            ...nextPartUpgrade
          })
        : {
            ...existingSession,
            tabId: playbackInput.tabId || existingSession.tabId || null,
            paused: false,
            stopped: false,
            playRequested: false,
            state: "startup_ready",
            lastEvent: "session_warmup_resumed",
            ...nextPartUpgrade
          };
      await this.ensureChapterData(resumedWarmSession);
      await this.saveSession(resumedWarmSession);
      await this.maybeStartStorySync(resumedWarmSession);
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
    await this.maybeStartStorySync(nextSession);

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
      ...this.foldPlaybackClock(session),
      paused: true,
      playRequested: false,
      state: "paused",
      playbackStatus: "paused",
      streamStatus: "paused",
      lastEvent: "session_paused"
    };
    await this.saveSession(pausedSession);
    await this.runtimeApi.sendMessage({ type: "PAUSE_PLAYBACK" });
    // Pause ends any playback startup, so parked warmups may run again.
    this.resumePendingWarmups();
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
        ...this.foldPlaybackClock(session),
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
    this.resumePendingWarmups();
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

    void this.ensureWarmingPipeline(chapterId);
    void this.ensureNextChapterPrefetch(session);
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
        ...this.foldPlaybackClock(session),
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
          playbackResumedAt: hasStarted ? Date.now() : session.playbackResumedAt || null,
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
    if (WARMUP_RESUME_EVENTS.has(message?.type)) {
      this.resumePendingWarmups();
    }
    if (followUp?.refreshSession) {
      await this.refreshChapterDataFromPage(followUp.refreshSession, { resumePlayback: true }).catch(() => {});
    }
    if (followUp?.advanceSession) {
      await this.advanceToNextChapter(followUp.advanceSession).catch((error) => {
        this.log("auto_advance_failed", followUp.advanceSession, { error: String(error) });
      });
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
      if (message.chunkId && session.currentChunkId && session.currentChunkId !== message.chunkId) {
        // Stale started event from a chunk we already navigated away from
        // (e.g. the user clicked another paragraph while it was in flight).
        return;
      }

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
        firstAudioAt: message.firstAudioAt || session.firstAudioAt || Date.now(),
        playbackResumedAt: session.playbackResumedAt || Date.now()
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
      const advancedSession =
        result.session.state === "ended" ? this.foldPlaybackClock(result.session) : result.session;
      const savedSession = {
        ...advancedSession,
        streamStatus: advancedSession.state === "ended" ? "ended" : "idle",
        bytesReceived: 0,
        bufferedAudioMs: 0
      };
      await this.saveSession(savedSession);
      if (result.session.state === "ended") {
        await this.clearChunkFocus(result.session).catch(() => {});
        return { advanceSession: savedSession };
      }
      await this.processSession(chapterId);
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
        ...(result.retryScheduled ? result.session : this.foldPlaybackClock(result.session)),
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
        ...(result.retryScheduled ? result.session : this.foldPlaybackClock(result.session)),
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
        nextPart: options.nextPart || null,
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
      nextPart: extraction.nextPart || null,
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
      stallCount: 0,
      playbackElapsedMs: 0,
      playbackResumedAt: null
    };

    await this.setActiveChapterId(chapterId);
    await this.saveSession(session);
    return this.getState(chapterId);
  }
}
