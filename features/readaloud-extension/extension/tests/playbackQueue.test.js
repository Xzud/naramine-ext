import test from "node:test";
import assert from "node:assert/strict";

import { PlaybackQueue } from "../src/audio/playbackQueue.js";
import { STARTUP_READY_CHUNKS } from "../src/shared/constants.js";

class MemoryStorageArea {
  constructor(initial = {}) {
    this.values = { ...initial };
  }

  async get(key) {
    return {
      [key]: this.values[key]
    };
  }

  async set(entries) {
    Object.assign(this.values, entries);
  }
}

class TestPlaybackQueue extends PlaybackQueue {
  constructor(options = {}) {
    const runtimeApi = options.runtimeApi || {
      onMessage: {
        addListener() {}
      },
      async sendMessage() {
        return { ok: true };
      }
    };
    const storageArea = options.storageArea || new MemoryStorageArea();
    super(runtimeApi, storageArea);
    this.cacheSnapshot = options.cacheSnapshot || {
      chunkCount: 0,
      readyAudioCount: 0,
      failedCount: 0,
      cacheType: "temporary"
    };
    this.audioChunksByIndex = options.audioChunksByIndex || new Map();
    this.nextPendingChunks = options.nextPendingChunks || [];
    this.readyAudioCounts = options.readyAudioCounts || [];
    this.dispatchCalls = [];
    this.savedAudioChunks = [];
    this.chunkStatuses = [];
    this.processCalls = 0;
    this.initialTotalChunks = options.initialTotalChunks || 0;
  }

  async getCacheSnapshot() {
    return this.cacheSnapshot;
  }

  async getAudioChunkRecord(chapterId, chunkIndex) {
    return this.audioChunksByIndex.get(`${chapterId}:${chunkIndex}`) || null;
  }

  async queryOffscreenPlaybackStatus() {
    return { playing: false, chunkId: null, ended: false, error: null };
  }

  async getReadyAudioCount() {
    if (this.readyAudioCounts.length > 0) {
      return this.readyAudioCounts.shift();
    }
    return this.savedAudioChunks.length;
  }

  async getNextPendingChunkRecord() {
    return this.nextPendingChunks.shift() || null;
  }

  getProvider() {
    return {
      synthesize: async () => new Blob(["audio"])
    };
  }

  async dispatchChunkPlayback(chunkId) {
    this.dispatchCalls.push(chunkId);
    return { ok: true, chunkId };
  }

  async saveChunkAudio(record) {
    this.savedAudioChunks.push(record);
  }

  async setChunkStatus(chunkId, status) {
    this.chunkStatuses.push({ chunkId, status });
  }

  async cleanupExpiredAudioRecords() {}

  async ensureOffscreenDocument() {}

  async ensureChapterData(session) {
    session.totalChunks =
      this.initialTotalChunks ||
      this.cacheSnapshot.chunkCount ||
      this.audioChunksByIndex.size ||
      this.nextPendingChunks.length ||
      session.totalChunks;
  }

  async processSession() {
    this.processCalls += 1;
  }
}

test("queue runtime listener ignores popup messages instead of resolving them with undefined", async () => {
  const listeners = [];
  const runtimeApi = {
    onMessage: {
      addListener(listener) {
        listeners.push(listener);
      }
    },
    async sendMessage() {
      return { ok: true };
    }
  };

  new TestPlaybackQueue({ runtimeApi });

  assert.equal(typeof listeners[0], "function");
  assert.equal(listeners[0]({ scope: "readaloud", type: "GET_STATE" }), undefined);
});

test("GET_STATE returns a structured idle object when no session exists", async () => {
  const queue = new TestPlaybackQueue({
    cacheSnapshot: {
      chunkCount: 0,
      readyAudioCount: 0,
      failedCount: 0,
      cacheType: "temporary"
    }
  });

  const state = await queue.getState("chapter-idle");

  assert.equal(state.chapterId, "chapter-idle");
  assert.equal(state.stateAvailable, true);
  assert.equal(state.state, "idle");
  assert.equal(state.playbackStatus, "idle");
  assert.equal(state.currentChunkId, null);
  assert.equal(state.lastEvent, "idle");
  assert.equal(state.startupTargetReadyAudioCount, 0);
  assert.equal(state.warmupStatus, "idle");
  assert.equal(state.transportStatus, "idle");
});

test("warmup starts buffering on page detection without dispatching playback", async () => {
  const queue = new TestPlaybackQueue({
    initialTotalChunks: 3,
    nextPendingChunks: [
      { chunkId: "warm-0", chapterId: "chapter-warmup", chunkIndex: 0, text: "Chunk 0" },
      { chunkId: "warm-1", chapterId: "chapter-warmup", chunkIndex: 1, text: "Chunk 1" },
      { chunkId: "warm-2", chapterId: "chapter-warmup", chunkIndex: 2, text: "Chunk 2" }
    ]
  });
  queue.processSession = async (chapterId) => PlaybackQueue.prototype.processSession.call(queue, chapterId);

  const state = await queue.warmup({
    ok: true,
    text: "Warm chapter text",
    title: "Warm Chapter",
    sourceUrl: "https://www.wattpad.com/123",
    storyId: "story-warmup",
    partId: "chapter-warmup",
    strategy: "dom-paragraphs",
    confidence: "high"
  });

  assert.equal(state.chapterId, "chapter-warmup");
  assert.equal(state.playbackStatus, "idle");
  assert.equal(state.playRequested, false);
  assert.equal(state.startupReadyAudioCount, STARTUP_READY_CHUNKS);
  assert.equal(state.warmupStatus, "warm_ready");
  assert.equal(state.transportStatus, "idle");
  assert.equal((await queue.loadSession("chapter-warmup")).warmupStatus, "warm_ready");
  assert.equal((await queue.loadSession("chapter-warmup")).transportStatus, "idle");
  assert.equal(queue.savedAudioChunks.length, 3);
  assert.deepEqual(queue.dispatchCalls, []);
});

test("play uses warmed session immediately instead of restarting extraction", async () => {
  const queue = new TestPlaybackQueue({
    audioChunksByIndex: new Map([
      [
        "chapter-warm-play:0",
        {
          chunkId: "chunk-warm-play-0",
          chapterId: "chapter-warm-play",
          chunkIndex: 0
        }
      ]
    ]),
    readyAudioCounts: [STARTUP_READY_CHUNKS, STARTUP_READY_CHUNKS]
  });
  queue.processSession = async (chapterId) => PlaybackQueue.prototype.processSession.call(queue, chapterId);

  await queue.setActiveChapterId("chapter-warm-play");
  await queue.saveSession({
    chapterId: "chapter-warm-play",
    storyId: "story-warm-play",
    title: "Warm Play",
    partId: "chapter-warm-play",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    state: "startup_ready",
    stopped: false,
    paused: false,
    playRequested: false,
    playbackStatus: "idle",
    currentChunkIndex: 0,
    currentChunkId: null,
    totalChunks: 4,
    startupReadyAudioCount: STARTUP_READY_CHUNKS,
    startupTargetReadyAudioCount: STARTUP_READY_CHUNKS,
    startupBufferingComplete: true,
    hasStartedPlayback: false,
    playbackAttemptId: null,
    nextPlaybackAttemptSequence: 0,
    lastEvent: "startup_buffer_ready",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null,
    text: "Warm text"
  });

  const state = await queue.start();

  assert.equal(state.chapterId, "chapter-warm-play");
  assert.deepEqual(queue.dispatchCalls, ["chunk-warm-play-0"]);
  assert.equal(state.playbackStatus, "playing");
  assert.equal(state.playRequested, true);
  assert.equal(state.warmupStatus, "ready");
  assert.equal(state.transportStatus, "playing");
});

test("play resumes paused transport before falling back to redispatch", async () => {
  const queue = new TestPlaybackQueue();
  queue.resumeOffscreenPlayback = async () => ({
    ok: true,
    resumed: true,
    chunkId: "chunk-paused-0"
  });

  await queue.setActiveChapterId("chapter-paused");
  await queue.saveSession({
    chapterId: "chapter-paused",
    storyId: "story-paused",
    title: "Paused Chapter",
    partId: "chapter-paused",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    state: "paused",
    stopped: false,
    paused: true,
    playRequested: false,
    playbackStatus: "paused",
    currentChunkIndex: 0,
    currentChunkId: "chunk-paused-0",
    totalChunks: 3,
    startupReadyAudioCount: STARTUP_READY_CHUNKS,
    startupTargetReadyAudioCount: STARTUP_READY_CHUNKS,
    startupBufferingComplete: true,
    hasStartedPlayback: true,
    playbackAttemptId: "chapter-paused:attempt:1",
    nextPlaybackAttemptSequence: 1,
    lastEvent: "session_paused",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null,
    text: "Paused text"
  });

  const state = await queue.start();

  assert.equal(state.chapterId, "chapter-paused");
  assert.equal(state.playbackStatus, "playing");
  assert.equal(state.state, "awaiting_chunk_end");
  assert.equal(state.playRequested, true);
  assert.equal(state.transportStatus, "playing");
  assert.equal((await queue.loadSession("chapter-paused")).warmupStatus, "ready");
  assert.equal((await queue.loadSession("chapter-paused")).transportStatus, "playing");
  assert.deepEqual(queue.dispatchCalls, []);
});

test("play after stop reuses warmed chapter cache instead of requiring re-extraction", async () => {
  const queue = new TestPlaybackQueue({
    audioChunksByIndex: new Map([
      [
        "chapter-stopped:0",
        {
          chunkId: "chunk-stopped-0",
          chapterId: "chapter-stopped",
          chunkIndex: 0
        }
      ]
    ]),
    readyAudioCounts: [STARTUP_READY_CHUNKS, STARTUP_READY_CHUNKS]
  });
  queue.processSession = async (chapterId) => PlaybackQueue.prototype.processSession.call(queue, chapterId);

  await queue.setActiveChapterId("chapter-stopped");
  await queue.saveSession({
    chapterId: "chapter-stopped",
    storyId: "story-stopped",
    title: "Stopped Chapter",
    partId: "chapter-stopped",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    state: "ended",
    stopped: true,
    paused: false,
    playRequested: false,
    playbackStatus: "ended",
    currentChunkIndex: 2,
    currentChunkId: null,
    totalChunks: 4,
    startupReadyAudioCount: STARTUP_READY_CHUNKS,
    startupTargetReadyAudioCount: STARTUP_READY_CHUNKS,
    startupBufferingComplete: true,
    hasStartedPlayback: true,
    playbackAttemptId: null,
    nextPlaybackAttemptSequence: 2,
    lastEvent: "session_stopped",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: "chunk-stopped-1",
    text: "Stopped text"
  });

  const state = await queue.start();

  assert.equal(state.chapterId, "chapter-stopped");
  assert.equal(state.currentChunkIndex, 0);
  assert.equal(state.playRequested, true);
  assert.equal(state.playbackStatus, "playing");
  assert.deepEqual(queue.dispatchCalls, ["chunk-stopped-0"]);
});

test("warmup for a new chapter replaces the active session focus deterministically", async () => {
  const queue = new TestPlaybackQueue({
    initialTotalChunks: 3,
    nextPendingChunks: [
      { chunkId: "chapter-b-0", chapterId: "chapter-b", chunkIndex: 0, text: "Chunk 0" },
      { chunkId: "chapter-b-1", chapterId: "chapter-b", chunkIndex: 1, text: "Chunk 1" },
      { chunkId: "chapter-b-2", chapterId: "chapter-b", chunkIndex: 2, text: "Chunk 2" }
    ]
  });
  queue.processSession = async (chapterId) => PlaybackQueue.prototype.processSession.call(queue, chapterId);

  await queue.saveSession({
    chapterId: "chapter-a",
    storyId: "story-a",
    title: "Chapter A",
    partId: "chapter-a",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    state: "startup_ready",
    stopped: false,
    paused: false,
    playRequested: false,
    playbackStatus: "idle",
    currentChunkIndex: 0,
    currentChunkId: null,
    totalChunks: 3,
    startupReadyAudioCount: STARTUP_READY_CHUNKS,
    startupTargetReadyAudioCount: STARTUP_READY_CHUNKS,
    startupBufferingComplete: true,
    hasStartedPlayback: false,
    playbackAttemptId: null,
    nextPlaybackAttemptSequence: 0,
    lastEvent: "startup_buffer_ready",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null,
    text: "Chapter A text"
  });

  const state = await queue.warmup({
    ok: true,
    text: "Chapter B text",
    title: "Chapter B",
    sourceUrl: "https://www.wattpad.com/456",
    storyId: "story-b",
    partId: "chapter-b",
    strategy: "dom-paragraphs",
    confidence: "high"
  });

  const activeChapterId = await queue.getActiveChapterId();
  const chapterASession = await queue.loadSession("chapter-a");
  const chapterBSession = await queue.loadSession("chapter-b");

  assert.equal(state.chapterId, "chapter-b");
  assert.equal(activeChapterId, "chapter-b");
  assert.equal(chapterASession.partId, "chapter-a");
  assert.equal(chapterBSession.partId, "chapter-b");
  assert.equal(chapterBSession.playRequested, false);
});

test("extraction failure returns a structured error state", async () => {
  const queue = new TestPlaybackQueue();

  const state = await queue.saveExtractionError({
    chapterId: "part-42",
    storyId: "story-7",
    partId: "part-42",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "low",
    errorMessage: "Could not isolate Wattpad chapter text."
  });

  assert.equal(state.chapterId, "part-42");
  assert.equal(state.stateAvailable, true);
  assert.equal(state.state, "error");
  assert.equal(state.playbackStatus, "error");
  assert.equal(state.lastEvent, "extraction_failed");
  assert.equal(state.errorMessage, "Could not isolate Wattpad chapter text.");
  assert.equal(state.extractionStrategy, "dom-paragraphs");
});

test("playing chunk is not redispatched when a later chunk finishes synthesizing, and duplicate end events do not double-advance", async () => {
  const queue = new TestPlaybackQueue({
    audioChunksByIndex: new Map([
      [
        "chapter-race:0",
        {
          chunkId: "chunk-0",
          chapterId: "chapter-race",
          chunkIndex: 0
        }
      ]
    ]),
    nextPendingChunks: [
      {
        chunkId: "chunk-1",
        chapterId: "chapter-race",
        chunkIndex: 1,
        text: "Chunk one text"
      }
    ],
    readyAudioCounts: [1, 2]
  });

  await queue.saveSession({
    chapterId: "chapter-race",
    storyId: "story-race",
    title: "Race Test",
    partId: "chapter-race",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    state: "awaiting_chunk_end",
    stopped: false,
    paused: false,
    playbackStatus: "playing",
    currentChunkIndex: 0,
    currentChunkId: "chunk-0",
    totalChunks: 2,
    startupReadyAudioCount: 2,
    startupTargetReadyAudioCount: 2,
    startupBufferingComplete: true,
    hasStartedPlayback: true,
    playbackAttemptId: "chapter-race:attempt:1",
    nextPlaybackAttemptSequence: 1,
    lastEvent: "playback_started",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null
  });

  await queue.fillBuffer("chapter-race");
  const sessionBeforeEnd = await queue.loadSession("chapter-race");

  assert.equal(queue.savedAudioChunks.length, 1);
  assert.deepEqual(queue.chunkStatuses, [
    { chunkId: "chunk-1", status: "generating" },
    { chunkId: "chunk-1", status: "ready" }
  ]);
  assert.equal(queue.dispatchCalls.length, 0);
  assert.equal(sessionBeforeEnd.currentChunkId, "chunk-0");
  assert.equal(sessionBeforeEnd.currentChunkIndex, 0);

  await queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_ENDED",
    chapterId: "chapter-race",
    chunkId: "chunk-0"
  });
  await queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_ENDED",
    chapterId: "chapter-race",
    chunkId: "chunk-0"
  });

  const sessionAfterEnd = await queue.loadSession("chapter-race");

  assert.equal(sessionAfterEnd.currentChunkIndex, 1);
  assert.equal(sessionAfterEnd.currentChunkId, null);
  assert.equal(sessionAfterEnd.lastEvent, "chunk_playback_ended");
  assert.equal(queue.processCalls, 1);
});

test("retry after playback error redispatches the same chunk instead of getting stuck on stale offscreen error state", async () => {
  const queue = new TestPlaybackQueue({
    audioChunksByIndex: new Map([
      [
        "chapter-retry:0",
        {
          chunkId: "chunk-retry-0",
          chapterId: "chapter-retry",
          chunkIndex: 0
        }
      ]
    ])
  });

  let stopCalls = 0;
  queue.queryOffscreenPlaybackStatus = async () => ({
    playing: false,
    chunkId: "chunk-retry-0",
    ended: false,
    error: "Audio element failed to play"
  });
  queue.stopOffscreenPlayback = async () => {
    stopCalls += 1;
  };

  await queue.saveSession({
    chapterId: "chapter-retry",
    storyId: "story-retry",
    title: "Retry Test",
    partId: "chapter-retry",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    state: "buffering",
    stopped: false,
    paused: false,
    playbackStatus: "idle",
    currentChunkIndex: 0,
    currentChunkId: null,
    totalChunks: 2,
    startupReadyAudioCount: 2,
    startupTargetReadyAudioCount: 2,
    startupBufferingComplete: true,
    hasStartedPlayback: true,
    playbackAttemptId: null,
    nextPlaybackAttemptSequence: 1,
    lastEvent: "playback_retry_scheduled",
    errorMessage: "Audio element failed to play",
    retryCount: 1,
    lastRetryReason: "Audio element failed to play",
    lastRetryKind: "playback_error",
    lastCompletedChunkId: null
  });

  const started = await queue.playCurrentChunkIfReady("chapter-retry");
  const sessionAfterRetry = await queue.loadSession("chapter-retry");

  assert.equal(started, true);
  assert.equal(stopCalls, 1);
  assert.deepEqual(queue.dispatchCalls, ["chunk-retry-0"]);
  assert.equal(sessionAfterRetry.currentChunkId, "chunk-retry-0");
  assert.equal(sessionAfterRetry.playbackStatus, "playing");
});

test("startup playback waits until three ready chunks are available before dispatching", async () => {
  const queue = new TestPlaybackQueue({
    audioChunksByIndex: new Map([
      [
        "chapter-startup:0",
        {
          chunkId: "chunk-startup-0",
          chapterId: "chapter-startup",
          chunkIndex: 0
        }
      ]
    ]),
    readyAudioCounts: [STARTUP_READY_CHUNKS - 1, STARTUP_READY_CHUNKS]
  });

  await queue.saveSession({
    chapterId: "chapter-startup",
    storyId: "story-startup",
    title: "Startup Test",
    partId: "chapter-startup",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    state: "startup_buffering",
    stopped: false,
    paused: false,
    playbackStatus: "idle",
    currentChunkIndex: 0,
    currentChunkId: null,
    totalChunks: 6,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: STARTUP_READY_CHUNKS,
    startupBufferingComplete: false,
    hasStartedPlayback: false,
    playbackAttemptId: null,
    nextPlaybackAttemptSequence: 0,
    lastEvent: "startup_buffer_progress",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null
  });

  const beforeThreshold = await queue.playCurrentChunkIfReady("chapter-startup");
  const pausedSession = { ...(await queue.loadSession("chapter-startup")) };
  const dispatchesBeforeThreshold = queue.dispatchCalls.length;
  const afterThreshold = await queue.playCurrentChunkIfReady("chapter-startup");
  const startedSession = { ...(await queue.loadSession("chapter-startup")) };

  assert.equal(beforeThreshold, false);
  assert.equal(dispatchesBeforeThreshold, 0);
  assert.equal(pausedSession.state, "startup_buffering");
  assert.equal(pausedSession.startupReadyAudioCount, STARTUP_READY_CHUNKS - 1);

  assert.equal(afterThreshold, true);
  assert.deepEqual(queue.dispatchCalls, ["chunk-startup-0"]);
  assert.equal(startedSession.state, "awaiting_chunk_end");
  assert.equal(startedSession.startupBufferingComplete, true);
});

test("startup playback begins once all chapter chunks are ready when the chapter has fewer than three chunks", async () => {
  const queue = new TestPlaybackQueue({
    audioChunksByIndex: new Map([
      [
        "chapter-short:0",
        {
          chunkId: "chunk-short-0",
          chapterId: "chapter-short",
          chunkIndex: 0
        }
      ]
    ]),
    readyAudioCounts: [1, 2]
  });

  await queue.saveSession({
    chapterId: "chapter-short",
    storyId: "story-short",
    title: "Short Chapter",
    partId: "chapter-short",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    state: "startup_buffering",
    stopped: false,
    paused: false,
    playbackStatus: "idle",
    currentChunkIndex: 0,
    currentChunkId: null,
    totalChunks: 2,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 2,
    startupBufferingComplete: false,
    hasStartedPlayback: false,
    playbackAttemptId: null,
    nextPlaybackAttemptSequence: 0,
    lastEvent: "startup_buffer_progress",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null
  });

  const beforeAllReady = await queue.playCurrentChunkIfReady("chapter-short");
  const sessionBeforeAllReady = { ...(await queue.loadSession("chapter-short")) };
  const afterAllReady = await queue.playCurrentChunkIfReady("chapter-short");
  const sessionAfterAllReady = { ...(await queue.loadSession("chapter-short")) };

  assert.equal(beforeAllReady, false);
  assert.equal(sessionBeforeAllReady.startupTargetReadyAudioCount, 2);
  assert.equal(sessionBeforeAllReady.startupReadyAudioCount, 1);

  assert.equal(afterAllReady, true);
  assert.deepEqual(queue.dispatchCalls, ["chunk-short-0"]);
  assert.equal(sessionAfterAllReady.state, "awaiting_chunk_end");
});

test("interrupted startup retries the same chunk without advancing the chunk index", async () => {
  const queue = new TestPlaybackQueue({
    audioChunksByIndex: new Map([
      [
        "chapter-interrupt:0",
        {
          chunkId: "chunk-interrupt-0",
          chapterId: "chapter-interrupt",
          chunkIndex: 0
        }
      ]
    ]),
    readyAudioCounts: [
      STARTUP_READY_CHUNKS,
      STARTUP_READY_CHUNKS,
      STARTUP_READY_CHUNKS,
      STARTUP_READY_CHUNKS
    ]
  });

  const attemptIds = [];
  queue.dispatchChunkPlayback = async (chunkId, _chapterId, attemptId) => {
    attemptIds.push(attemptId);
    if (attemptIds.length === 1) {
      throw new Error("AbortError: The play() request was interrupted by a call to pause().");
    }
    return { ok: true, chunkId };
  };
  queue.processSession = async (chapterId) => PlaybackQueue.prototype.processSession.call(queue, chapterId);

  await queue.saveSession({
    chapterId: "chapter-interrupt",
    storyId: "story-interrupt",
    title: "Interrupted Startup",
    partId: "chapter-interrupt",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    state: "startup_ready",
    stopped: false,
    paused: false,
    playRequested: true,
    playbackStatus: "idle",
    currentChunkIndex: 0,
    currentChunkId: null,
    totalChunks: 4,
    startupReadyAudioCount: STARTUP_READY_CHUNKS,
    startupTargetReadyAudioCount: STARTUP_READY_CHUNKS,
    startupBufferingComplete: true,
    hasStartedPlayback: false,
    playbackAttemptId: null,
    nextPlaybackAttemptSequence: 0,
    lastEvent: "startup_buffer_ready",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null
  });

  const started = await queue.playCurrentChunkIfReady("chapter-interrupt");
  const retriedSession = await queue.loadSession("chapter-interrupt");

  assert.equal(started, false);
  assert.equal(attemptIds.length, 2);
  assert.equal(retriedSession.currentChunkIndex, 0);
  assert.equal(retriedSession.playbackStatus, "playing");
  assert.equal(retriedSession.lastRetryKind, "interrupted_startup");
  assert.equal(retriedSession.lastEvent, "playback_started");
});

test("stale started events from an older playback attempt do not poison the active attempt", async () => {
  const queue = new TestPlaybackQueue();

  await queue.saveSession({
    chapterId: "chapter-stale",
    storyId: "story-stale",
    title: "Stale Attempt",
    partId: "chapter-stale",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    state: "playback_starting",
    stopped: false,
    paused: false,
    playbackStatus: "starting",
    currentChunkIndex: 0,
    currentChunkId: "chunk-stale-0",
    totalChunks: 3,
    startupReadyAudioCount: STARTUP_READY_CHUNKS,
    startupTargetReadyAudioCount: STARTUP_READY_CHUNKS,
    startupBufferingComplete: true,
    hasStartedPlayback: false,
    playbackAttemptId: "chapter-stale:attempt:2",
    nextPlaybackAttemptSequence: 2,
    lastEvent: "playback_dispatch_requested",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null
  });

  await queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_STARTED",
    chapterId: "chapter-stale",
    chunkId: "chunk-stale-0",
    attemptId: "chapter-stale:attempt:1"
  });

  const session = await queue.loadSession("chapter-stale");
  assert.equal(session.playbackStatus, "starting");
  assert.equal(session.playbackAttemptId, "chapter-stale:attempt:2");
  assert.equal(session.hasStartedPlayback, false);
});
