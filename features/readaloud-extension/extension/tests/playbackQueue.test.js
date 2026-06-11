import test from "node:test";
import assert from "node:assert/strict";

import { PlaybackQueue } from "../src/audio/playbackQueue.js";
import { chunkText, stableHash } from "../src/text/chunkText.js";

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
    const sentMessages = [];
    const tabMessages = [];
    const queriedTabs = options.queriedTabs || [{ id: 123 }];
    const runtimeStatus = options.runtimeStatus || {
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
    const runtimeApi = options.runtimeApi || {
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        }
      },
      async sendMessage(message) {
        sentMessages.push(message);
        if (options.onSendMessage) {
          options.onSendMessage(message);
        }
        if (message.type === "GET_PLAYBACK_STATUS") {
          return runtimeStatus;
        }
        return { ok: true };
      }
    };
    const tabsApi = options.tabsApi || {
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, message });
        return { ok: true };
      },
      async query() {
        return queriedTabs;
      }
    };
    const storageArea = options.storageArea || new MemoryStorageArea();
    super(runtimeApi, storageArea, tabsApi);
    this.cacheSnapshot = options.cacheSnapshot || {
      chunkCount: 0,
      readyAudioCount: 0,
      failedCount: 0,
      cacheType: "temporary"
    };
    this.listeners = listeners;
    this.startedStreams = [];
    this.sentMessages = sentMessages;
    this.tabMessages = tabMessages;
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

  async getChunkRecord(chapterId, chunkIndex) {
    if (chunkIndex < 0 || chunkIndex >= 3) {
      return null;
    }

    return {
      storyId: "story-test",
      chapterId,
      chunkIndex,
      text: `Chunk ${chunkIndex}`,
      textHash: `hash-${chunkIndex}`,
      chunkId: `${chapterId}:${chunkIndex}:h${chunkIndex + 1}`,
      paragraphId: `p-${chunkIndex}`,
      paragraphIds: [`p-${chunkIndex}`]
    };
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

class LegacyHighlightPlaybackQueue extends TestPlaybackQueue {
  constructor(options = {}) {
    super(options);
    this.ensureCalls = [];
    this.chunkRecords = options.chunkRecords || [
      {
        storyId: "story-legacy",
        chapterId: "chapter-legacy",
        chunkIndex: 0,
        text: "Legacy chunk 0",
        textHash: "legacy-hash-0",
        chunkId: "chapter-legacy:0:legacy-0",
        paragraphId: null,
        paragraphIds: []
      }
    ];
  }

  async ensureChapterData(session) {
    this.ensureCalls.push({
      chapterId: session.chapterId,
      state: session.state,
      playRequested: session.playRequested
    });
    session.totalChunks = this.chunkRecords.length;
    const paragraphIds = Array.isArray(session.paragraphs)
      ? session.paragraphs.map((paragraph) => paragraph.paragraphId).filter(Boolean)
      : [];

    if (paragraphIds.length) {
      this.chunkRecords = this.chunkRecords.map((record) => ({
        ...record,
        paragraphIds: record.paragraphIds?.length ? record.paragraphIds : [...paragraphIds],
        paragraphId: record.paragraphIds?.length ? record.paragraphIds[0] : paragraphIds[0] || null
      }));
    }
  }

  async getChunkRecord(chapterId, chunkIndex) {
    const record = this.chunkRecords[chunkIndex];
    if (!record) {
      return null;
    }

    return {
      ...record,
      chapterId,
      chunkIndex,
      chunkId: record.chunkId || `${chapterId}:${chunkIndex}:legacy-${chunkIndex}`
    };
  }
}

class LazyLoadPlaybackQueue extends TestPlaybackQueue {
  constructor(options = {}) {
    super(options);
    this.chunkStore = options.chunkStore || [];
    this.chapterRecord = options.chapterRecord || null;
  }

  async ensureChapterData(session) {
    return PlaybackQueue.prototype.ensureChapterData.call(this, session);
  }

  async getChunkRecord(chapterId, chunkIndex) {
    const record = this.chunkStore.find(
      (chunk) => chunk.chapterId === chapterId && chunk.chunkIndex === chunkIndex
    );

    return record || null;
  }

  async getChapterRecord(chapterId) {
    if (this.chapterRecord?.chapterId !== chapterId) {
      return null;
    }

    return this.chapterRecord;
  }

  async getChapterChunkRecords(chapterId) {
    return this.chunkStore
      .filter((chunk) => chunk.chapterId === chapterId)
      .sort((left, right) => left.chunkIndex - right.chunkIndex);
  }

  async saveChapterRecord(record) {
    this.chapterRecord = { ...record };
  }

  async saveChunkRecords(records) {
    for (const record of records) {
      const existingIndex = this.chunkStore.findIndex((chunk) => chunk.chunkId === record.chunkId);
      if (existingIndex >= 0) {
        this.chunkStore[existingIndex] = {
          ...this.chunkStore[existingIndex],
          ...record
        };
      } else {
        this.chunkStore.push({ ...record });
      }
    }

    this.chunkStore.sort((left, right) => left.chunkIndex - right.chunkIndex);
  }

  async replaceChapterChunkRecords(chapterId, chunkRecords) {
    this.chunkStore = chunkRecords
      .filter((record) => record.chapterId === chapterId)
      .map((record) => ({ ...record }));
  }
}

function buildParagraphChapter(paragraphCount, { chapterId, storyId, title }) {
  const paragraphs = Array.from({ length: paragraphCount }, (_value, index) => ({
    paragraphId: `p-${index}`,
    text: `Paragraph ${index}`
  }));
  const text = paragraphs.map((paragraph) => paragraph.text).join("\n\n");
  const chunks = chunkText(text, {
    storyId,
    chapterId,
    paragraphs
  });

  return {
    paragraphs,
    text,
    chapter: {
      chapterId,
      storyId,
      title,
      sourceUrl: `https://www.wattpad.com/${chapterId}`,
      textHash: stableHash(text),
      createdAt: 1,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000
    },
    chunks
  };
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

test("active chunk start scrolls and highlights the page chunk", async () => {
  const queue = new TestPlaybackQueue();
  queue.tabsApi.sendMessage = async (tabId, message) => {
    queue.tabMessages.push({ tabId, message });
    return { ok: true };
  };

  await queue.saveSession({
    chapterId: "chapter-scroll",
    storyId: "story-scroll",
    title: "Scroll Chapter",
    partId: "chapter-scroll",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    tabId: 99,
    state: "playback_starting",
    stopped: false,
    paused: false,
    playRequested: true,
    playbackStatus: "starting",
    currentChunkIndex: 0,
    currentChunkId: "chapter-scroll:0:h1",
    totalChunks: 3,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    hasStartedPlayback: false,
    playbackAttemptId: "chapter-scroll:attempt:1",
    nextPlaybackAttemptSequence: 1,
    lastEvent: "playback_dispatch_requested",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null,
    text: "Scroll text",
    paragraphs: [{ text: "Scroll text", paragraphId: "p-0" }],
    transportMode: "live_stream",
    streamStatus: "connecting",
    bytesReceived: 0,
    bufferedAudioMs: 0,
    firstByteAt: null,
    firstAudioAt: null,
    stallCount: 0
  });

  await queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_STARTED",
    chapterId: "chapter-scroll",
    chunkId: "chapter-scroll:0:h1",
    attemptId: "chapter-scroll:attempt:1"
  });

  assert.equal(queue.tabMessages[0].tabId, 99);
  assert.equal(queue.tabMessages[0].message.type, "READALOUD_SET_ACTIVE_CHUNK");
  assert.deepEqual(queue.tabMessages[0].message.payload.paragraphIds, ["p-0"]);
  assert.equal(queue.tabMessages[0].message.payload.clearPrevious, true);
});

test("active chunk start falls back to the active tab when the session has no tab id", async () => {
  const queue = new TestPlaybackQueue({
    queriedTabs: [{ id: 77 }]
  });

  await queue.saveSession({
    chapterId: "chapter-tab-fallback",
    storyId: "story-tab-fallback",
    title: "Fallback Chapter",
    partId: "chapter-tab-fallback",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    tabId: null,
    state: "playback_starting",
    stopped: false,
    paused: false,
    playRequested: true,
    playbackStatus: "starting",
    currentChunkIndex: 0,
    currentChunkId: "chapter-tab-fallback:0:h1",
    totalChunks: 3,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    hasStartedPlayback: false,
    playbackAttemptId: "chapter-tab-fallback:attempt:1",
    nextPlaybackAttemptSequence: 1,
    lastEvent: "playback_dispatch_requested",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null,
    text: "Tab fallback text",
    paragraphs: [{ text: "Tab fallback text", paragraphId: "p-0" }],
    transportMode: "live_stream",
    streamStatus: "connecting",
    bytesReceived: 0,
    bufferedAudioMs: 0,
    firstByteAt: null,
    firstAudioAt: null,
    stallCount: 0
  });

  await queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_STARTED",
    chapterId: "chapter-tab-fallback",
    chunkId: "chapter-tab-fallback:0:h1",
    attemptId: "chapter-tab-fallback:attempt:1"
  });

  assert.equal(queue.tabMessages[0].tabId, 77);
});

test("stop clears the active chunk highlight on the page", async () => {
  const queue = new TestPlaybackQueue();
  queue.tabsApi.sendMessage = async (tabId, message) => {
    queue.tabMessages.push({ tabId, message });
    return { ok: true };
  };

  await queue.saveSession({
    chapterId: "chapter-stop",
    storyId: "story-stop",
    title: "Stop Chapter",
    partId: "chapter-stop",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    tabId: 101,
    state: "awaiting_chunk_end",
    stopped: false,
    paused: false,
    playRequested: true,
    playbackStatus: "playing",
    currentChunkIndex: 0,
    currentChunkId: "chapter-stop:0:h1",
    totalChunks: 3,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    hasStartedPlayback: true,
    playbackAttemptId: "chapter-stop:attempt:1",
    nextPlaybackAttemptSequence: 1,
    lastEvent: "playback_started",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null,
    text: "Stop text",
    paragraphs: [{ text: "Stop text", paragraphId: "p-0" }],
    transportMode: "live_stream",
    streamStatus: "playing",
    bytesReceived: 1000,
    bufferedAudioMs: 300,
    firstByteAt: 1,
    firstAudioAt: 2,
    stallCount: 0
  });

  await queue.stop("chapter-stop");

  assert.equal(queue.tabMessages.at(-1).message.type, "READALOUD_CLEAR_ACTIVE_CHUNK");
});

test("prepared lookahead chunks do not trigger page focus changes", async () => {
  const queue = new TestPlaybackQueue();

  await queue.saveSession({
    chapterId: "chapter-prewarm",
    storyId: "story-prewarm",
    title: "Prewarm Chapter",
    partId: "chapter-prewarm",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    tabId: 77,
    state: "awaiting_chunk_end",
    stopped: false,
    paused: false,
    playRequested: true,
    playbackStatus: "playing",
    currentChunkIndex: 0,
    currentChunkId: "chapter-prewarm:0:h1",
    totalChunks: 3,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    hasStartedPlayback: true,
    playbackAttemptId: "chapter-prewarm:attempt:1",
    nextPlaybackAttemptSequence: 1,
    lastEvent: "playback_started",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null,
    text: "Prewarm text",
    paragraphs: [{ text: "Prewarm text", paragraphId: "p-0" }],
    transportMode: "live_stream",
    streamStatus: "playing",
    bytesReceived: 1000,
    bufferedAudioMs: 300,
    firstByteAt: 1,
    firstAudioAt: 2,
    stallCount: 0
  });

  await queue.handleRuntimeMessage({
    type: "STREAM_PREPARE_READY",
    chapterId: "chapter-prewarm",
    chunkId: "chapter-prewarm:1:h2"
  });

  assert.equal(queue.tabMessages.length, 0);
});

test("chunk start prefetches the next chunk", async () => {
  const queue = new TestPlaybackQueue();

  await queue.saveSession({
    chapterId: "chapter-prefetch",
    storyId: "story-prefetch",
    title: "Prefetch Chapter",
    partId: "chapter-prefetch",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    state: "awaiting_chunk_end",
    stopped: false,
    paused: false,
    playRequested: true,
    playbackStatus: "playing",
    currentChunkIndex: 0,
    currentChunkId: "chunk-prefetch-0",
    totalChunks: 3,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    hasStartedPlayback: true,
    playbackAttemptId: "chapter-prefetch:attempt:1",
    nextPlaybackAttemptSequence: 1,
    lastEvent: "playback_started",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null,
    text: "Prefetch text",
    transportMode: "live_stream",
    streamStatus: "playing",
    bytesReceived: 800,
    bufferedAudioMs: 200,
    firstByteAt: 1,
    firstAudioAt: 2,
    stallCount: 0
  });

  await queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_STARTED",
    chapterId: "chapter-prefetch",
    chunkId: "chunk-prefetch-0",
    attemptId: "chapter-prefetch:attempt:1"
  });

  const prepareMessage = queue.sentMessages.find((message) => message.type === "PREPARE_STREAM_PLAYBACK");
  assert.equal(prepareMessage.chunkId, "chapter-prefetch:1:h2");
});

test("prepared next chunk is promoted on handoff", async () => {
  const queue = new TestPlaybackQueue({
    runtimeStatus: {
      playing: false,
      paused: false,
      chunkId: null,
      ended: false,
      error: null,
      streamStatus: "idle",
      bytesReceived: 0,
      bufferedSegmentCount: 0,
      slots: [
        {
          chunkId: "chapter-handoff:1:h2",
          attemptId: "chapter-handoff:prefetch:1",
          chapterId: "chapter-handoff",
          role: "prepared",
          streamStatus: "prepared",
          bytesReceived: 1200,
          bufferedAudioMs: 900,
          firstByteAt: 1,
          firstAudioAt: 2,
          playbackStarted: false,
          paused: false,
          ready: true
        }
      ]
    }
  });

  queue.sentMessages.length = 0;

  await queue.saveSession({
    chapterId: "chapter-handoff",
    storyId: "story-handoff",
    title: "Handoff Chapter",
    partId: "chapter-handoff",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    state: "advancing",
    stopped: false,
    paused: false,
    playRequested: true,
    playbackStatus: "idle",
    currentChunkIndex: 1,
    currentChunkId: null,
    totalChunks: 3,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    hasStartedPlayback: true,
    playbackAttemptId: null,
    nextPlaybackAttemptSequence: 1,
    lastEvent: "chunk_playback_ended",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: "chapter-handoff:0:h1",
    text: "Handoff text",
    transportMode: "live_stream",
    streamStatus: "idle",
    bytesReceived: 0,
    bufferedAudioMs: 0,
    firstByteAt: null,
    firstAudioAt: null,
    stallCount: 0
  });

  await PlaybackQueue.prototype.startCurrentChunkStream.call(queue, "chapter-handoff");

  assert.equal(
    queue.sentMessages.find((message) => message.type === "START_PREPARED_STREAM")?.chunkId,
    "chapter-handoff:1:h2"
  );
  assert.equal(
    queue.sentMessages.find((message) => message.type === "PREPARE_STREAM_PLAYBACK")?.chunkId,
    "chapter-handoff:2:h3"
  );
});

test("prepare ready can trigger the second lookahead chunk", async () => {
  const queue = new TestPlaybackQueue();

  await queue.saveSession({
    chapterId: "chapter-lookahead",
    storyId: "story-lookahead",
    title: "Lookahead Chapter",
    partId: "chapter-lookahead",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    state: "awaiting_chunk_end",
    stopped: false,
    paused: false,
    playRequested: true,
    playbackStatus: "playing",
    currentChunkIndex: 0,
    currentChunkId: "chapter-lookahead:0:h1",
    totalChunks: 3,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    hasStartedPlayback: true,
    playbackAttemptId: "chapter-lookahead:attempt:1",
    nextPlaybackAttemptSequence: 1,
    lastEvent: "playback_started",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null,
    text: "Lookahead text",
    transportMode: "live_stream",
    streamStatus: "playing",
    bytesReceived: 900,
    bufferedAudioMs: 300,
    firstByteAt: 1,
    firstAudioAt: 2,
    stallCount: 0
  });

  await queue.handleRuntimeMessage({
    type: "STREAM_PREPARE_READY",
    chapterId: "chapter-lookahead",
    chunkId: "chapter-lookahead:1:h2"
  });

  assert.equal(
    queue.sentMessages.find((message) => message.type === "PREPARE_STREAM_PLAYBACK")?.chunkId,
    "chapter-lookahead:2:h3"
  );
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

test("stale chunk error events do not clear the current highlight", async () => {
  const queue = new TestPlaybackQueue();
  queue.tabsApi.sendMessage = async (tabId, message) => {
    queue.tabMessages.push({ tabId, message });
    return { ok: true };
  };

  await queue.saveSession({
    chapterId: "chapter-stale",
    storyId: "story-stale",
    title: "Stale Event Chapter",
    partId: "chapter-stale",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    tabId: 88,
    state: "awaiting_chunk_end",
    stopped: false,
    paused: false,
    playRequested: true,
    playbackStatus: "playing",
    currentChunkIndex: 1,
    currentChunkId: "chapter-stale:1:h2",
    totalChunks: 5,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    hasStartedPlayback: true,
    playbackAttemptId: "chapter-stale:attempt:2",
    nextPlaybackAttemptSequence: 2,
    lastEvent: "playback_started",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: "chapter-stale:0:h1",
    text: "Stale event text",
    paragraphs: [{ text: "Stale event text", paragraphId: "p-stale" }],
    transportMode: "live_stream",
    streamStatus: "playing",
    bytesReceived: 1024,
    bufferedAudioMs: 320,
    firstByteAt: 1,
    firstAudioAt: 2,
    stallCount: 0
  });

  await queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_STARTED",
    chapterId: "chapter-stale",
    chunkId: "chapter-stale:1:h2",
    attemptId: "chapter-stale:attempt:2"
  });

  const highlightCount = queue.tabMessages.length;
  const sessionBefore = await queue.loadSession("chapter-stale");

  for (const type of ["CHUNK_PLAYBACK_ERROR", "CHUNK_PLAYBACK_INTERRUPTED"]) {
    await queue.handleRuntimeMessage({
      type,
      chapterId: "chapter-stale",
      chunkId: "chapter-stale:0:h1",
      attemptId: "chapter-stale:attempt:1",
      error: `late ${type.toLowerCase()}`
    });
  }

  const sessionAfter = await queue.loadSession("chapter-stale");
  assert.equal(sessionAfter.currentChunkId, sessionBefore.currentChunkId);
  assert.equal(sessionAfter.state, sessionBefore.state);
  assert.equal(sessionAfter.errorMessage, null);
  assert.equal(queue.tabMessages.length, highlightCount);
  assert.equal(queue.tabMessages.at(-1).message.type, "READALOUD_SET_ACTIVE_CHUNK");
});

test("resuming legacy sessions upgrades chunk anchors before highlighting", async () => {
  const queue = new LegacyHighlightPlaybackQueue({
    chunkRecords: [
      {
        storyId: "story-legacy",
        chapterId: "chapter-legacy",
        chunkIndex: 0,
        text: "Legacy chunk 0",
        textHash: "legacy-hash-0",
        chunkId: "chapter-legacy:0:legacy-0",
        paragraphId: null,
        paragraphIds: []
      }
    ]
  });
  queue.tabsApi.sendMessage = async (tabId, message) => {
    queue.tabMessages.push({ tabId, message });
    return { ok: true };
  };

  await queue.saveSession({
    chapterId: "chapter-legacy",
    storyId: "story-legacy",
    title: "Legacy Chapter",
    partId: "chapter-legacy",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    tabId: 42,
    state: "startup_ready",
    stopped: false,
    paused: false,
    playRequested: false,
    playbackStatus: "idle",
    currentChunkIndex: 0,
    currentChunkId: null,
    totalChunks: 1,
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
    text: "Legacy chapter text",
    paragraphs: [{ text: "Legacy chapter text", paragraphId: "p-legacy" }],
    transportMode: "live_stream",
    streamStatus: "idle",
    bytesReceived: 0,
    bufferedAudioMs: 0,
    firstByteAt: null,
    firstAudioAt: null,
    stallCount: 0
  });

  await queue.warmup({
    ok: true,
    text: "Legacy chapter text",
    title: "Legacy Chapter",
    sourceUrl: "https://www.wattpad.com/legacy",
    storyId: "story-legacy",
    partId: "chapter-legacy",
    strategy: "dom-paragraphs",
    confidence: "high",
    tabId: 42,
    paragraphs: [{ text: "Legacy chapter text", paragraphId: "p-legacy" }]
  });

  await queue.start({
    ok: true,
    text: "Legacy chapter text",
    title: "Legacy Chapter",
    sourceUrl: "https://www.wattpad.com/legacy",
    storyId: "story-legacy",
    partId: "chapter-legacy",
    strategy: "dom-paragraphs",
    confidence: "high",
    tabId: 42,
    paragraphs: [{ text: "Legacy chapter text", paragraphId: "p-legacy" }]
  });

  assert.equal(queue.ensureCalls.length, 2);
  assert.equal(queue.ensureCalls[0].playRequested, false);
  assert.equal(queue.ensureCalls[1].playRequested, true);
  assert.deepEqual(queue.chunkRecords[0].paragraphIds, ["p-legacy"]);

  await queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_STARTED",
    chapterId: "chapter-legacy",
    chunkId: "chapter-legacy:0:legacy-0",
    attemptId: "chapter-legacy:attempt:1"
  });

  assert.equal(queue.tabMessages.some((entry) => entry.message.type === "READALOUD_EXTRACT_TEXT"), true);
  assert.deepEqual(
    queue.tabMessages.find((entry) => entry.message.type === "READALOUD_SET_ACTIVE_CHUNK")?.message.payload.paragraphIds,
    ["p-legacy"]
  );
});

test("near-end playback refreshes lazy-loaded chunks without dropping the active highlight", async () => {
  const initial = buildParagraphChapter(19, {
    chapterId: "chapter-lazy",
    storyId: "story-lazy",
    title: "Lazy Chapter"
  });
  const refreshed = buildParagraphChapter(22, {
    chapterId: "chapter-lazy",
    storyId: "story-lazy",
    title: "Lazy Chapter"
  });
  const queue = new LazyLoadPlaybackQueue({
    chunkStore: initial.chunks.map((chunk) => ({
      ...chunk,
      status: "pending"
    })),
    chapterRecord: initial.chapter
  });
  queue.tabsApi.sendMessage = async (tabId, message) => {
    queue.tabMessages.push({ tabId, message });

    if (message.type === "READALOUD_EXTRACT_TEXT") {
      return {
        ok: true,
        text: refreshed.text,
        title: refreshed.chapter.title,
        sourceUrl: refreshed.chapter.sourceUrl,
        storyId: refreshed.chapter.storyId,
        partId: refreshed.chapter.chapterId,
        strategy: "dom-paragraphs",
        confidence: "high",
        paragraphs: refreshed.paragraphs
      };
    }

    return { ok: true };
  };

  await queue.saveSession({
    chapterId: "chapter-lazy",
    storyId: "story-lazy",
    title: "Lazy Chapter",
    partId: "chapter-lazy",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    tabId: 222,
    state: "awaiting_chunk_end",
    stopped: false,
    paused: false,
    playRequested: true,
    playbackStatus: "playing",
    currentChunkIndex: 16,
    currentChunkId: initial.chunks[16].chunkId,
    totalChunks: initial.chunks.length,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    hasStartedPlayback: true,
    playbackAttemptId: "chapter-lazy:attempt:1",
    nextPlaybackAttemptSequence: 1,
    lastEvent: "playback_started",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: "chapter-lazy:15:h15",
    text: initial.text,
    paragraphs: initial.paragraphs,
    transportMode: "live_stream",
    streamStatus: "playing",
    bytesReceived: 1024,
    bufferedAudioMs: 320,
    firstByteAt: 1,
    firstAudioAt: 2,
    stallCount: 0
  });

  await queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_STARTED",
    chapterId: "chapter-lazy",
    chunkId: initial.chunks[16].chunkId,
    attemptId: "chapter-lazy:attempt:1"
  });

  const session = await queue.loadSession("chapter-lazy");

  assert.equal(queue.tabMessages.some((entry) => entry.message.type === "READALOUD_EXTRACT_TEXT"), true);
  assert.equal(queue.chunkStore.length, refreshed.chunks.length);
  assert.deepEqual(queue.chunkStore.slice(0, initial.chunks.length).map((chunk) => chunk.chunkId), initial.chunks.map((chunk) => chunk.chunkId));
  assert.equal(session.totalChunks, refreshed.chunks.length);
  assert.equal(session.currentChunkId, initial.chunks[16].chunkId);
  assert.deepEqual(
    queue.tabMessages.find((entry) => entry.message.type === "READALOUD_SET_ACTIVE_CHUNK")?.message.payload.paragraphIds,
    initial.chunks[16].paragraphIds
  );
});

test("near-end playback resumes after a delayed refresh extends the chapter", async () => {
  const initial = buildParagraphChapter(19, {
    chapterId: "chapter-lazy-race",
    storyId: "story-lazy-race",
    title: "Lazy Race Chapter"
  });
  const refreshed = buildParagraphChapter(22, {
    chapterId: "chapter-lazy-race",
    storyId: "story-lazy-race",
    title: "Lazy Race Chapter"
  });
  let resolveExtract;
  const refreshPromise = new Promise((resolve) => {
    resolveExtract = resolve;
  });
  const queue = new LazyLoadPlaybackQueue({
    chunkStore: initial.chunks.map((chunk) => ({
      ...chunk,
      status: "pending"
    })),
    chapterRecord: initial.chapter
  });
  queue.tabsApi.sendMessage = async (tabId, message) => {
    queue.tabMessages.push({ tabId, message });

    if (message.type === "READALOUD_EXTRACT_TEXT") {
      return refreshPromise;
    }

    return { ok: true };
  };

  await queue.saveSession({
    chapterId: "chapter-lazy-race",
    storyId: "story-lazy-race",
    title: "Lazy Race Chapter",
    partId: "chapter-lazy-race",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    tabId: 222,
    state: "awaiting_chunk_end",
    stopped: false,
    paused: false,
    playRequested: true,
    playbackStatus: "playing",
    currentChunkIndex: 18,
    currentChunkId: initial.chunks[18].chunkId,
    totalChunks: initial.chunks.length,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    hasStartedPlayback: true,
    playbackAttemptId: "chapter-lazy-race:attempt:1",
    nextPlaybackAttemptSequence: 1,
    lastEvent: "playback_started",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: "chapter-lazy-race:17:h18",
    text: initial.text,
    paragraphs: initial.paragraphs,
    transportMode: "live_stream",
    streamStatus: "playing",
    bytesReceived: 1024,
    bufferedAudioMs: 320,
    firstByteAt: 1,
    firstAudioAt: 2,
    stallCount: 0
  });

  const startedPromise = queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_STARTED",
    chapterId: "chapter-lazy-race",
    chunkId: initial.chunks[18].chunkId,
    attemptId: "chapter-lazy-race:attempt:1"
  });
  const endedPromise = queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_ENDED",
    chapterId: "chapter-lazy-race",
    chunkId: initial.chunks[18].chunkId,
    attemptId: "chapter-lazy-race:attempt:1"
  });

  resolveExtract({
    ok: true,
    text: refreshed.text,
    title: refreshed.chapter.title,
    sourceUrl: refreshed.chapter.sourceUrl,
    storyId: refreshed.chapter.storyId,
    partId: refreshed.chapter.chapterId,
    strategy: "dom-paragraphs",
    confidence: "high",
    paragraphs: refreshed.paragraphs
  });

  await Promise.all([startedPromise, endedPromise]);

  const session = await queue.loadSession("chapter-lazy-race");

  assert.equal(queue.tabMessages.some((entry) => entry.message.type === "READALOUD_EXTRACT_TEXT"), true);
  assert.equal(queue.processCalls, 1);
  assert.deepEqual(queue.startedStreams, ["chapter-lazy-race"]);
  assert.equal(queue.chunkStore.length, refreshed.chunks.length);
  assert.equal(session.totalChunks, refreshed.chunks.length);
  assert.equal(session.currentChunkIndex, 19);
  assert.equal(session.currentChunkId, null);
  assert.equal(session.state, "ended");
});

test("near-end playback ignores a refresh that finds no new content", async () => {
  const initial = buildParagraphChapter(19, {
    chapterId: "chapter-lazy-static",
    storyId: "story-lazy-static",
    title: "Lazy Static Chapter"
  });
  let resolveExtract;
  const refreshPromise = new Promise((resolve) => {
    resolveExtract = resolve;
  });
  const queue = new LazyLoadPlaybackQueue({
    chunkStore: initial.chunks.map((chunk) => ({
      ...chunk,
      status: "pending"
    })),
    chapterRecord: initial.chapter
  });
  queue.tabsApi.sendMessage = async (tabId, message) => {
    queue.tabMessages.push({ tabId, message });

    if (message.type === "READALOUD_EXTRACT_TEXT") {
      return refreshPromise;
    }

    return { ok: true };
  };

  await queue.saveSession({
    chapterId: "chapter-lazy-static",
    storyId: "story-lazy-static",
    title: "Lazy Static Chapter",
    partId: "chapter-lazy-static",
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    tabId: 223,
    state: "awaiting_chunk_end",
    stopped: false,
    paused: false,
    playRequested: true,
    playbackStatus: "playing",
    currentChunkIndex: 18,
    currentChunkId: initial.chunks[18].chunkId,
    totalChunks: initial.chunks.length,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    hasStartedPlayback: true,
    playbackAttemptId: "chapter-lazy-static:attempt:1",
    nextPlaybackAttemptSequence: 1,
    lastEvent: "playback_started",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: "chapter-lazy-static:17:h18",
    text: initial.text,
    paragraphs: initial.paragraphs,
    transportMode: "live_stream",
    streamStatus: "playing",
    bytesReceived: 1024,
    bufferedAudioMs: 320,
    firstByteAt: 1,
    firstAudioAt: 2,
    stallCount: 0
  });

  const startedPromise = queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_STARTED",
    chapterId: "chapter-lazy-static",
    chunkId: initial.chunks[18].chunkId,
    attemptId: "chapter-lazy-static:attempt:1"
  });
  const endedPromise = queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_ENDED",
    chapterId: "chapter-lazy-static",
    chunkId: initial.chunks[18].chunkId,
    attemptId: "chapter-lazy-static:attempt:1"
  });

  resolveExtract({
    ok: true,
    text: initial.text,
    title: initial.chapter.title,
    sourceUrl: initial.chapter.sourceUrl,
    storyId: initial.chapter.storyId,
    partId: initial.chapter.chapterId,
    strategy: "dom-paragraphs",
    confidence: "high",
    paragraphs: initial.paragraphs
  });

  await Promise.all([startedPromise, endedPromise]);

  const session = await queue.loadSession("chapter-lazy-static");

  assert.equal(queue.tabMessages.some((entry) => entry.message.type === "READALOUD_EXTRACT_TEXT"), true);
  assert.equal(queue.processCalls, 0);
  assert.equal(queue.startedStreams.length, 0);
  assert.equal(queue.chunkStore.length, initial.chunks.length);
  assert.equal(session.totalChunks, initial.chunks.length);
  assert.equal(session.currentChunkIndex, 19);
  assert.equal(session.currentChunkId, null);
  assert.equal(session.state, "ended");
});

test("clicking a paragraph starts playback from the matching chunk and highlights it", async () => {
  const chapter = buildParagraphChapter(8, {
    chapterId: "chapter-click",
    storyId: "story-click",
    title: "Click Chapter"
  });
  const queue = new LazyLoadPlaybackQueue({
    chunkStore: chapter.chunks.map((chunk) => ({
      ...chunk,
      status: "pending"
    })),
    chapterRecord: chapter.chapter
  });
  queue.tabsApi.sendMessage = async (tabId, message) => {
    queue.tabMessages.push({ tabId, message });

    if (message.type === "READALOUD_EXTRACT_TEXT") {
      return {
        ok: true,
        text: chapter.text,
        title: chapter.chapter.title,
        sourceUrl: chapter.chapter.sourceUrl,
        storyId: chapter.chapter.storyId,
        partId: chapter.chapter.chapterId,
        strategy: "dom-paragraphs",
        confidence: "high",
        paragraphs: chapter.paragraphs
      };
    }

    return { ok: true };
  };

  const state = await queue.playFromParagraph({
    tabId: 333,
    paragraphId: "p-5"
  });

  assert.equal(queue.sentMessages.some((message) => message.type === "STOP_PLAYBACK"), true);
  assert.equal(queue.startedStreams.at(-1), "chapter-click");
  assert.equal(state.currentChunkIndex, 5);
  assert.equal(state.currentChunkId, chapter.chunks[5].chunkId);
  assert.equal(queue.tabMessages.at(-1).message.type, "READALOUD_SET_ACTIVE_CHUNK");
  assert.deepEqual(queue.tabMessages.at(-1).message.payload.paragraphIds, chapter.chunks[5].paragraphIds);
});

test("clicking an unknown paragraph fails without starting playback", async () => {
  const chapter = buildParagraphChapter(4, {
    chapterId: "chapter-missing",
    storyId: "story-missing",
    title: "Missing Paragraph Chapter"
  });
  const queue = new LazyLoadPlaybackQueue({
    chunkStore: chapter.chunks.map((chunk) => ({
      ...chunk,
      status: "pending"
    })),
    chapterRecord: chapter.chapter
  });
  queue.tabsApi.sendMessage = async (tabId, message) => {
    queue.tabMessages.push({ tabId, message });

    if (message.type === "READALOUD_EXTRACT_TEXT") {
      return {
        ok: true,
        text: chapter.text,
        title: chapter.chapter.title,
        sourceUrl: chapter.chapter.sourceUrl,
        storyId: chapter.chapter.storyId,
        partId: chapter.chapter.chapterId,
        strategy: "dom-paragraphs",
        confidence: "high",
        paragraphs: chapter.paragraphs
      };
    }

    return { ok: true };
  };

  const state = await queue.playFromParagraph({
    tabId: 444,
    paragraphId: "p-missing"
  });

  assert.equal(queue.sentMessages.some((message) => message.type === "STOP_PLAYBACK"), false);
  assert.equal(queue.startedStreams.length, 0);
  assert.equal(state.state, "error");
  assert.match(state.errorMessage, /paragraph_not_found/);
});

function buildPlayingSession(chapterId, overrides = {}) {
  return {
    chapterId,
    storyId: `story-${chapterId}`,
    title: "Race Chapter",
    partId: chapterId,
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    state: "awaiting_chunk_end",
    stopped: false,
    paused: false,
    playRequested: true,
    playbackStatus: "playing",
    currentChunkIndex: 0,
    currentChunkId: `${chapterId}:0:h1`,
    totalChunks: 3,
    startupReadyAudioCount: 0,
    startupTargetReadyAudioCount: 0,
    startupBufferingComplete: false,
    hasStartedPlayback: true,
    playbackAttemptId: `${chapterId}:attempt:1`,
    nextPlaybackAttemptSequence: 1,
    lastEvent: "playback_started",
    errorMessage: null,
    retryCount: 0,
    lastRetryReason: null,
    lastRetryKind: null,
    lastCompletedChunkId: null,
    text: "Race text",
    transportMode: "live_stream",
    streamStatus: "playing",
    bytesReceived: 1024,
    bufferedAudioMs: 400,
    firstByteAt: 1,
    firstAudioAt: 2,
    stallCount: 0,
    ...overrides
  };
}

test("pause is not clobbered by a concurrent stream progress event", async () => {
  const queue = new TestPlaybackQueue();
  await queue.setActiveChapterId("chapter-race");
  await queue.saveSession(buildPlayingSession("chapter-race"));

  const progressPromise = queue.handleRuntimeMessage({
    type: "STREAM_PLAYBACK_PROGRESS",
    chapterId: "chapter-race",
    chunkId: "chapter-race:0:h1",
    streamStatus: "buffering",
    bytesReceived: 2048,
    bufferedAudioMs: 100
  });
  const pausePromise = queue.pause("chapter-race");
  await Promise.all([progressPromise, pausePromise]);

  const session = await queue.loadSession("chapter-race");
  assert.equal(session.paused, true);
  assert.equal(session.state, "paused");
  assert.equal(session.playbackStatus, "paused");
  assert.equal(session.streamStatus, "paused");
});

test("progress events for a paused session are ignored", async () => {
  const queue = new TestPlaybackQueue();
  await queue.saveSession(
    buildPlayingSession("chapter-paused-progress", {
      state: "paused",
      paused: true,
      playRequested: false,
      playbackStatus: "paused",
      streamStatus: "paused"
    })
  );

  await queue.handleRuntimeMessage({
    type: "STREAM_PLAYBACK_PROGRESS",
    chapterId: "chapter-paused-progress",
    chunkId: "chapter-paused-progress:0:h1",
    streamStatus: "playing",
    bytesReceived: 4096,
    bufferedAudioMs: 600
  });

  const session = await queue.loadSession("chapter-paused-progress");
  assert.equal(session.paused, true);
  assert.equal(session.streamStatus, "paused");
});

test("redundant progress events skip the session write", async () => {
  const queue = new TestPlaybackQueue();
  await queue.saveSession(buildPlayingSession("chapter-throttle"));

  let saves = 0;
  const originalSaveSession = queue.saveSession.bind(queue);
  queue.saveSession = async (session) => {
    saves += 1;
    return originalSaveSession(session);
  };

  await queue.handleRuntimeMessage({
    type: "STREAM_PLAYBACK_PROGRESS",
    chapterId: "chapter-throttle",
    chunkId: "chapter-throttle:0:h1",
    streamStatus: "playing",
    bytesReceived: 1024 + 100,
    bufferedAudioMs: 450,
    firstByteAt: 1,
    firstAudioAt: 2
  });
  assert.equal(saves, 0);

  await queue.handleRuntimeMessage({
    type: "STREAM_PLAYBACK_PROGRESS",
    chapterId: "chapter-throttle",
    chunkId: "chapter-throttle:0:h1",
    streamStatus: "buffering",
    bytesReceived: 1024 + 200,
    bufferedAudioMs: 0,
    firstByteAt: 1,
    firstAudioAt: 2
  });
  assert.equal(saves, 1);

  const session = await queue.loadSession("chapter-throttle");
  assert.equal(session.streamStatus, "buffering");
  assert.equal(session.stallCount, 1);
});

test("a started event arriving after pause does not unpause the session", async () => {
  const queue = new TestPlaybackQueue();
  await queue.saveSession(
    buildPlayingSession("chapter-late-start", {
      state: "paused",
      paused: true,
      playRequested: false,
      playbackStatus: "paused",
      streamStatus: "paused",
      hasStartedPlayback: false,
      firstAudioAt: null
    })
  );

  await queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_STARTED",
    chapterId: "chapter-late-start",
    chunkId: "chapter-late-start:0:h1",
    attemptId: "chapter-late-start:attempt:1",
    firstAudioAt: 99
  });

  const session = await queue.loadSession("chapter-late-start");
  assert.equal(session.paused, true);
  assert.equal(session.state, "paused");
  assert.equal(session.playbackStatus, "paused");
  assert.equal(session.hasStartedPlayback, true);
  assert.equal(session.firstAudioAt, 99);
});

test("play resumes a paused offscreen stream instead of treating it as in flight", async () => {
  const queue = new TestPlaybackQueue({
    runtimeStatus: {
      playing: false,
      paused: true,
      chunkId: "chapter-stuck:0:h1",
      ended: false,
      error: null,
      streamStatus: "paused",
      bytesReceived: 4096,
      bufferedSegmentCount: 0,
      slots: [
        {
          chunkId: "chapter-stuck:0:h1",
          attemptId: "chapter-stuck:attempt:1",
          chapterId: "chapter-stuck",
          role: "active",
          streamStatus: "paused",
          bytesReceived: 4096,
          bufferedAudioMs: 700,
          firstByteAt: 1,
          firstAudioAt: 2,
          playbackStarted: true,
          paused: true,
          ready: true
        }
      ]
    }
  });
  queue.resumeOffscreenPlayback = async () => ({
    ok: true,
    resumed: true,
    chunkId: "chapter-stuck:0:h1"
  });

  await queue.saveSession(
    buildPlayingSession("chapter-stuck", {
      state: "playback_starting",
      paused: false,
      playRequested: true,
      playbackStatus: "idle",
      streamStatus: "idle"
    })
  );

  const result = await PlaybackQueue.prototype.startCurrentChunkStream.call(queue, "chapter-stuck");

  assert.equal(result, true);
  assert.equal(
    queue.sentMessages.some((message) => message.type === "START_STREAM_PLAYBACK"),
    false
  );
  const session = await queue.loadSession("chapter-stuck");
  assert.equal(session.playbackStatus, "playing");
  assert.equal(session.state, "awaiting_chunk_end");
  assert.equal(session.streamStatus, "playing");
});

class WarmingPlaybackQueue extends LazyLoadPlaybackQueue {
  constructor(options = {}) {
    super(options);
    this.audioStore = [];
    this.warmedChunkIds = [];
    this.failChunkIds = options.failChunkIds || new Set();
  }

  async getAudioRecordsForChapter(chapterId) {
    return this.audioStore.filter((record) => record.chapterId === chapterId);
  }

  async saveAudioRecord(record) {
    this.audioStore.push({ ...record });
  }

  async markChunkStatus(chunkId, status) {
    const record = this.chunkStore.find((chunk) => chunk.chunkId === chunkId);
    if (record) {
      record.status = status;
    }
  }

  async fetchAudioForChunk(_session, chunk) {
    this.warmedChunkIds.push(chunk.chunkId);
    if (this.failChunkIds.has(chunk.chunkId)) {
      throw new Error("synthesis failed");
    }
    return { type: "audio/wav" };
  }
}

function buildWarmingFixture(paragraphCount, chapterId, overrides = {}) {
  const chapter = buildParagraphChapter(paragraphCount, {
    chapterId,
    storyId: `story-${chapterId}`,
    title: "Warming Chapter"
  });
  const queue = new WarmingPlaybackQueue({
    chunkStore: chapter.chunks.map((chunk) => ({ ...chunk, status: "pending" })),
    chapterRecord: chapter.chapter,
    ...overrides
  });
  return { chapter, queue };
}

test("warming pipeline buffers every remaining chunk to the audio cache in order", async () => {
  const { chapter, queue } = buildWarmingFixture(6, "chapter-warm");

  await queue.saveSession(
    buildPlayingSession("chapter-warm", {
      currentChunkId: chapter.chunks[0].chunkId,
      totalChunks: chapter.chunks.length,
      text: chapter.text
    })
  );

  await queue.ensureWarmingPipeline("chapter-warm");

  const expected = chapter.chunks.slice(1).map((chunk) => chunk.chunkId);
  assert.deepEqual(queue.warmedChunkIds, expected);
  assert.equal(queue.audioStore.length, chapter.chunks.length - 1);
  for (const chunk of queue.chunkStore.slice(1)) {
    assert.equal(chunk.status, "ready");
  }
});

test("warming pipeline picks up chunks added after the chapter grows", async () => {
  const { chapter, queue } = buildWarmingFixture(4, "chapter-warm-grow");

  await queue.saveSession(
    buildPlayingSession("chapter-warm-grow", {
      currentChunkId: chapter.chunks[0].chunkId,
      totalChunks: chapter.chunks.length,
      text: chapter.text
    })
  );

  await queue.ensureWarmingPipeline("chapter-warm-grow");
  assert.equal(queue.audioStore.length, chapter.chunks.length - 1);

  const grown = buildParagraphChapter(7, {
    chapterId: "chapter-warm-grow",
    storyId: "story-chapter-warm-grow",
    title: "Warming Chapter"
  });
  await queue.saveChunkRecords(
    grown.chunks.slice(chapter.chunks.length).map((chunk) => ({ ...chunk, status: "pending" }))
  );

  await queue.ensureWarmingPipeline("chapter-warm-grow");

  assert.equal(queue.audioStore.length, grown.chunks.length - 1);
  assert.deepEqual(
    queue.warmedChunkIds.slice(chapter.chunks.length - 1),
    grown.chunks.slice(chapter.chunks.length).map((chunk) => chunk.chunkId)
  );
});

test("warming pipeline marks failed chunks and keeps going", async () => {
  const { chapter, queue } = buildWarmingFixture(5, "chapter-warm-fail");
  queue.failChunkIds = new Set([chapter.chunks[2].chunkId]);

  await queue.saveSession(
    buildPlayingSession("chapter-warm-fail", {
      currentChunkId: chapter.chunks[0].chunkId,
      totalChunks: chapter.chunks.length,
      text: chapter.text
    })
  );

  await queue.ensureWarmingPipeline("chapter-warm-fail");

  assert.equal(queue.chunkStore[2].status, "failed");
  assert.equal(
    queue.audioStore.some((record) => record.chunkId === chapter.chunks[2].chunkId),
    false
  );
  assert.equal(queue.audioStore.length, chapter.chunks.length - 2);
  assert.equal(queue.chunkStore[3].status, "ready");
  assert.equal(queue.chunkStore[4].status, "ready");
});

test("warming pipeline does not run for stopped sessions", async () => {
  const { chapter, queue } = buildWarmingFixture(4, "chapter-warm-stopped");

  await queue.saveSession(
    buildPlayingSession("chapter-warm-stopped", {
      stopped: true,
      state: "ended",
      playRequested: false,
      totalChunks: chapter.chunks.length,
      text: chapter.text
    })
  );

  await queue.ensureWarmingPipeline("chapter-warm-stopped");

  assert.deepEqual(queue.warmedChunkIds, []);
  assert.equal(queue.audioStore.length, 0);
});

test("warming pipeline is single-flight per chapter", async () => {
  const { chapter, queue } = buildWarmingFixture(5, "chapter-warm-once");

  await queue.saveSession(
    buildPlayingSession("chapter-warm-once", {
      currentChunkId: chapter.chunks[0].chunkId,
      totalChunks: chapter.chunks.length,
      text: chapter.text
    })
  );

  await Promise.all([
    queue.ensureWarmingPipeline("chapter-warm-once"),
    queue.ensureWarmingPipeline("chapter-warm-once"),
    queue.ensureWarmingPipeline("chapter-warm-once")
  ]);

  const expected = chapter.chunks.slice(1).map((chunk) => chunk.chunkId);
  assert.deepEqual(queue.warmedChunkIds, expected);
});

test("pause folds the playback clock and resume restarts it", async () => {
  const queue = new TestPlaybackQueue();
  queue.resumeOffscreenPlayback = async () => ({ ok: true, resumed: true, chunkId: "chapter-clock:0:h1" });
  await queue.setActiveChapterId("chapter-clock");

  const startedAt = Date.now() - 5000;
  await queue.saveSession(
    buildPlayingSession("chapter-clock", {
      playbackElapsedMs: 10000,
      playbackResumedAt: startedAt
    })
  );

  await queue.pause("chapter-clock");
  const pausedSession = await queue.loadSession("chapter-clock");
  assert.equal(pausedSession.playbackResumedAt, null);
  assert.ok(pausedSession.playbackElapsedMs >= 15000);
  assert.ok(pausedSession.playbackElapsedMs < 16000);

  const pausedForState = { ...pausedSession, state: "paused" };
  await queue.saveSession(pausedForState);
  await queue.start();
  const resumedSession = await queue.loadSession("chapter-clock");
  assert.equal(typeof resumedSession.playbackResumedAt, "number");
  assert.ok(resumedSession.playbackElapsedMs >= 15000);
});

test("chunk start begins the playback clock without resetting accumulated time", async () => {
  const queue = new TestPlaybackQueue();
  await queue.saveSession(
    buildPlayingSession("chapter-clock-start", {
      playbackElapsedMs: 42000,
      playbackResumedAt: null
    })
  );

  await queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_STARTED",
    chapterId: "chapter-clock-start",
    chunkId: "chapter-clock-start:0:h1",
    attemptId: "chapter-clock-start:attempt:1"
  });

  const session = await queue.loadSession("chapter-clock-start");
  assert.equal(session.playbackElapsedMs, 42000);
  assert.equal(typeof session.playbackResumedAt, "number");
});

test("chapter end stops the playback clock", async () => {
  const queue = new TestPlaybackQueue();
  await queue.saveSession(
    buildPlayingSession("chapter-clock-end", {
      currentChunkIndex: 2,
      currentChunkId: "chapter-clock-end:2:h3",
      totalChunks: 3,
      playbackElapsedMs: 20000,
      playbackResumedAt: Date.now() - 3000
    })
  );

  await queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_ENDED",
    chapterId: "chapter-clock-end",
    chunkId: "chapter-clock-end:2:h3",
    attemptId: "chapter-clock-end:attempt:1"
  });

  const session = await queue.loadSession("chapter-clock-end");
  assert.equal(session.state, "ended");
  assert.equal(session.playbackResumedAt, null);
  assert.ok(session.playbackElapsedMs >= 23000);
});

test("clicking a paragraph mid-playback dispatches the clicked chunk through the real stream path", async () => {
  const chapterId = "chap-click-real";
  const paragraphs = Array.from({ length: 8 }, (_value, index) => ({
    paragraphId: `p-${index}`,
    text: `Paragraph ${index} with some longer content to chunk properly and reasonably.`
  }));
  const text = paragraphs.map((paragraph) => paragraph.text).join("\n\n");
  const chunks = chunkText(text, { storyId: "story", chapterId, paragraphs });

  const queue = new LazyLoadPlaybackQueue({
    chunkStore: chunks.map((chunk) => ({ ...chunk, status: "pending" })),
    chapterRecord: {
      chapterId,
      storyId: "story",
      title: "T",
      sourceUrl: "u",
      textHash: stableHash(text),
      createdAt: 1,
      expiresAt: Date.now() + 86400000
    }
  });
  queue.tabsApi.sendMessage = async (tabId, message) => {
    queue.tabMessages.push({ tabId, message });
    if (message.type === "READALOUD_EXTRACT_TEXT") {
      return {
        ok: true,
        text,
        paragraphs,
        title: "T",
        sourceUrl: "u",
        storyId: "story",
        partId: chapterId,
        strategy: "dom-paragraphs",
        confidence: "high"
      };
    }
    return { ok: true };
  };
  // Use the real dispatch path instead of the TestPlaybackQueue stubs.
  queue.startCurrentChunkStream = PlaybackQueue.prototype.startCurrentChunkStream.bind(queue);
  queue.getAudioRecordsForChapter = async () => [];
  queue.saveAudioRecord = async () => {};
  queue.markChunkStatus = async () => {};
  queue.fetchAudioForChunk = async () => ({ type: "audio/wav" });

  await queue.setActiveChapterId(chapterId);
  await queue.saveSession(
    buildPlayingSession(chapterId, {
      tabId: 123,
      text,
      paragraphs,
      currentChunkId: chunks[0].chunkId,
      totalChunks: chunks.length
    })
  );

  const laterChunk = chunks.find((chunk) => chunk.chunkIndex >= 2) || chunks.at(-1);
  const clickedParagraphId = (laterChunk.paragraphIds || [])[0];
  assert.ok(clickedParagraphId);

  const state = await queue.playFromParagraph({ chapterId, paragraphId: clickedParagraphId, tabId: 123 });

  assert.equal(queue.sentMessages.some((message) => message.type === "STOP_PLAYBACK"), true);
  const dispatched = queue.sentMessages.filter((message) => message.type === "START_STREAM_PLAYBACK");
  assert.equal(dispatched.at(-1)?.chunkId, laterChunk.chunkId);
  assert.equal(state.currentChunkId, laterChunk.chunkId);
  assert.notEqual(state.state, "error");
});

test("a stale started event from the previous chunk does not override a paragraph jump", async () => {
  const queue = new TestPlaybackQueue();
  await queue.saveSession(
    buildPlayingSession("chapter-stale-start", {
      state: "playback_starting",
      playbackStatus: "dispatching",
      currentChunkIndex: 5,
      currentChunkId: "chapter-stale-start:5:h6",
      totalChunks: 8,
      streamStatus: "connecting"
    })
  );

  await queue.handleRuntimeMessage({
    type: "CHUNK_PLAYBACK_STARTED",
    chapterId: "chapter-stale-start",
    chunkId: "chapter-stale-start:0:h1",
    attemptId: "chapter-stale-start:attempt:0"
  });

  const session = await queue.loadSession("chapter-stale-start");
  assert.equal(session.currentChunkId, "chapter-stale-start:5:h6");
  assert.equal(session.playbackStatus, "dispatching");
  assert.equal(session.streamStatus, "connecting");
});
