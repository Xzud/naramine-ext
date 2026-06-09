import test from "node:test";
import assert from "node:assert/strict";

import { createUnavailableRuntimeState } from "../src/audio/runtimeState.js";
import { buildPopupViewModel } from "../src/popup/popupState.js";

test("popup-safe unavailable state does not invent playback metrics", () => {
  const view = buildPopupViewModel(createUnavailableRuntimeState("The service worker could not be reached."));

  assert.equal(view.availability, "State unavailable");
  assert.equal(view.progress, "Current chunk: unavailable");
  assert.equal(view.chunk, "Chunk ID: unavailable");
  assert.equal(view.warmup, "Warmup: unavailable");
  assert.equal(view.transport, "Transport: unavailable");
  assert.match(view.error, /could not be reached/i);
});

test("popup shows live stream startup metrics before first audio", () => {
  const view = buildPopupViewModel({
    stateAvailable: true,
    state: "playback_starting",
    warmupStatus: "starting",
    transportStatus: "starting",
    playRequested: true,
    playbackStatus: "starting",
    streamStatus: "buffering",
    currentChunkIndex: 0,
    totalChunks: 9,
    currentChunkId: "chunk-0",
    chapterReadyAudioCount: 0,
    readyAudioCount: 0,
    bufferedAudioMs: 180,
    bytesReceived: 24000,
    firstByteAt: 123,
    firstAudioAt: null,
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    cacheType: "temporary",
    partId: "1407678433",
    lastEvent: "stream_dispatch_accepted",
    errorMessage: null
  });

  assert.equal(view.state, "Session state: preparing playback start");
  assert.equal(view.startup, "Startup stream buffer: 180 ms buffered");
  assert.equal(view.transport, "Transport: starting");
  assert.equal(view.playback, "Playback: starting stream playback");
  assert.equal(view.buffer, "Live stream buffer: 180 ms, 24000 bytes");
});

test("popup distinguishes passive warmup from play-requested streaming", () => {
  const view = buildPopupViewModel({
    stateAvailable: true,
    state: "startup_ready",
    warmupStatus: "warm_ready",
    transportStatus: "idle",
    playRequested: false,
    playbackStatus: "idle",
    streamStatus: "idle",
    currentChunkIndex: 0,
    totalChunks: 9,
    currentChunkId: null,
    chapterReadyAudioCount: 0,
    readyAudioCount: 0,
    bufferedAudioMs: 0,
    bytesReceived: 0,
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    cacheType: "temporary",
    partId: "1407678433",
    lastEvent: "chapter_ready_for_streaming",
    errorMessage: null
  });

  assert.equal(view.state, "Session state: warm buffer ready");
  assert.equal(view.playback, "Playback: ready when you press play");
  assert.equal(view.startup, "Startup stream buffer: waiting for play");
});

test("popup shows active streamed playback once transport is live", () => {
  const view = buildPopupViewModel({
    stateAvailable: true,
    state: "awaiting_chunk_end",
    warmupStatus: "ready",
    transportStatus: "playing",
    playRequested: true,
    playbackStatus: "playing",
    streamStatus: "playing",
    currentChunkIndex: 1,
    totalChunks: 4,
    currentChunkId: "chunk-2",
    chapterReadyAudioCount: 0,
    readyAudioCount: 0,
    bufferedAudioMs: 220,
    bytesReceived: 56000,
    firstByteAt: 10,
    firstAudioAt: 20,
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    cacheType: "temporary",
    partId: "1407678433",
    lastEvent: "playback_started",
    errorMessage: null
  });

  assert.equal(view.state, "Session state: ready for playback");
  assert.equal(view.startup, "Startup stream buffer: live (220 ms buffered)");
  assert.equal(view.transport, "Transport: playing");
  assert.equal(view.playback, "Playback: playing");
});
