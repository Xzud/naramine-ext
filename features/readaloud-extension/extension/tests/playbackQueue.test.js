import test from "node:test";
import assert from "node:assert/strict";

import { PlaybackQueue } from "../src/audio/playbackQueue.js";

class MemoryStorageArea {
  constructor(initial = {}) {
    this.values = { ...initial };
  }

  async get(key) {
    return { [key]: this.values[key] };
  }

  async set(entries) {
    Object.assign(this.values, entries);
  }
}

class TestPlaybackQueue extends PlaybackQueue {
  constructor(options = {}) {
    const listeners = [];
    const runtimeApi = options.runtimeApi || {
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        }
      },
      async sendMessage(message) {
        if (message.type === "GET_PLAYBACK_STATUS") {
          return {
            playing: false,
            paused: false,
            chunkId: null,
            ended: false,
            error: null,
            streamStatus: "idle",
            bytesReceived: 0,
            bufferedSegmentCount: 0
          };
        }
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
    this.listeners = listeners;
    this.startedStreams = [];
    this.processCalls = 0;
  }

  async getCacheSnapshot() {
    return this.cacheSnapshot;
  }

  async cleanupExpiredAudioRecords() {}

  async ensureOffscreenDocument() {}

  async ensureChapterData(session) {
    session.totalChunks = session.totalChunks || 3;
  }

  async startCurrentChunkStream(chapterId) {
    this.startedStreams.push(chapterId);
    return true;
  }

  async processSession(chapterId) {
    this.processCalls += 1;
    return PlaybackQueue.prototype.processSession.call(this, chapterId);
  }
}

test("queue runtime listener ignores popup messages instead of resolving them with undefined", async () => {
  const queue = new TestPlaybackQueue();

  assert.equal(typeof queue.listeners[0], "function");
  assert.equal(queue.listeners[0]({ scope: "readaloud", type: "GET_STATE" }), undefined);
});

test("GET_STATE returns a structured idle object when no session exists", async () => {
  const queue = new TestPlaybackQueue();

  const state = await queue.getState("chapter-idle");

  assert.equal(state.chapterId, "chapter-idle");
  assert.equal(state.stateAvailable, true);
  assert.equal(state.state, "idle");
  assert.equal(state.playbackStatus, "idle");
  assert.equal(state.transportMode, "live_stream");
  assert.equal(state.transportStatus, "idle");
});

test("warmup prepares chapter metadata without starting playback", async () => {
  const queue = new TestPlaybackQueue();

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
  assert.equal(state.playRequested, false);
  assert.equal(state.state, "startup_ready");
  assert.equal(state.warmupStatus, "warm_ready");
  assert.equal(queue.startedStreams.length, 0);
});

test("play on a warmed session starts the live stream path", async () => {
  const queue = new TestPlaybackQueue();

  await queue.setActiveChapterId("chapter-play");
  await queue.saveSession({
    chapterId: "chapter-play",
    storyId: "story-play",
    title: "Warm Play",
    partId: "chapter-play",
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
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    hasStartedPlayback: false,
    playbackAttemptId: null,
    nextPlaybackAttemptSequence: 0,
    lastEvent: "session_warmup_started",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null,
    text: "Warm text",
    transportMode: "live_stream",
    streamStatus: "idle",
    bytesReceived: 0,
    bufferedAudioMs: 0,
    firstByteAt: null,
    firstAudioAt: null,
    stallCount: 0
  });

  const state = await queue.start();

  assert.equal(state.chapterId, "chapter-play");
  assert.equal(state.playRequested, true);
  assert.deepEqual(queue.startedStreams, ["chapter-play"]);
});

test("play resumes paused transport before falling back to restart", async () => {
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
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    hasStartedPlayback: true,
    playbackAttemptId: "chapter-paused:attempt:1",
    nextPlaybackAttemptSequence: 1,
    lastEvent: "session_paused",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null,
    text: "Paused text",
    transportMode: "live_stream",
    streamStatus: "paused",
    bytesReceived: 1200,
    bufferedAudioMs: 320,
    firstByteAt: 1,
    firstAudioAt: 2,
    stallCount: 0
  });

  const state = await queue.start();

  assert.equal(state.chapterId, "chapter-paused");
  assert.equal(state.playbackStatus, "playing");
  assert.equal(state.state, "awaiting_chunk_end");
  assert.equal(state.transportStatus, "playing");
  assert.deepEqual(queue.startedStreams, []);
});

test("end event advances exactly once and resumes the next chunk", async () => {
  const queue = new TestPlaybackQueue();

  await queue.saveSession({
    chapterId: "chapter-end",
    storyId: "story-end",
    title: "End Test",
    partId: "chapter-end",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    state: "awaiting_chunk_end",
    stopped: false,
    paused: false,
    playRequested: true,
    playbackStatus: "playing",
    currentChunkIndex: 0,
    currentChunkId: "chunk-0",
    totalChunks: 2,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    hasStartedPlayback: true,
    playbackAttemptId: "chapter-end:attempt:1",
    nextPlaybackAttemptSequence: 1,
    lastEvent: "playback_started",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null,
    text: "End text",
    transportMode: "live_stream",
    streamStatus: "playing",
    bytesReceived: 800,
    bufferedAudioMs: 200,
    firstByteAt: 1,
    firstAudioAt: 2,
    stallCount: 0
  });

  await queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_ENDED",
    chapterId: "chapter-end",
    chunkId: "chunk-0",
    attemptId: "chapter-end:attempt:1"
  });
  await queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_ENDED",
    chapterId: "chapter-end",
    chunkId: "chunk-0",
    attemptId: "chapter-end:attempt:1"
  });

  const session = await queue.loadSession("chapter-end");
  assert.equal(session.currentChunkIndex, 1);
  assert.equal(session.lastCompletedChunkId, "chunk-0");
  assert.deepEqual(queue.startedStreams, ["chapter-end"]);
});

test("playback errors schedule a bounded retry on the same chapter", async () => {
  const queue = new TestPlaybackQueue();

  await queue.saveSession({
    chapterId: "chapter-retry",
    storyId: "story-retry",
    title: "Retry Test",
    partId: "chapter-retry",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    state: "playback_starting",
    stopped: false,
    paused: false,
    playRequested: true,
    playbackStatus: "starting",
    currentChunkIndex: 0,
    currentChunkId: "chunk-retry-0",
    totalChunks: 2,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    hasStartedPlayback: false,
    playbackAttemptId: "chapter-retry:attempt:1",
    nextPlaybackAttemptSequence: 1,
    lastEvent: "playback_dispatch_requested",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null,
    text: "Retry text",
    transportMode: "live_stream",
    streamStatus: "connecting",
    bytesReceived: 0,
    bufferedAudioMs: 0,
    firstByteAt: null,
    firstAudioAt: null,
    stallCount: 0
  });

  await queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_ERROR",
    chapterId: "chapter-retry",
    chunkId: "chunk-retry-0",
    attemptId: "chapter-retry:attempt:1",
    error: "stream failed"
  });

  const session = await queue.loadSession("chapter-retry");
  assert.equal(session.lastRetryKind, "playback_error");
  assert.equal(session.retryCount, 1);
  assert.deepEqual(queue.startedStreams, ["chapter-retry"]);
});
