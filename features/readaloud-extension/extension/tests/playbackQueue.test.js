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
