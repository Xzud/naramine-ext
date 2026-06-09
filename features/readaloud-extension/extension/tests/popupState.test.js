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
  assert.equal(view.progress.includes("0 / 0"), false);
});

test("popup shows startup buffer progress separately from ready audio cache", () => {
  const view = buildPopupViewModel({
    stateAvailable: true,
    state: "startup_buffering",
    warmupStatus: "warming",
    transportStatus: "idle",
    playRequested: false,
    playbackStatus: "idle",
    currentChunkIndex: 0,
    totalChunks: 9,
    currentChunkId: null,
    chapterReadyAudioCount: 2,
    readyAudioCount: 2,
    startupReadyAudioCount: 2,
    startupTargetReadyAudioCount: 3,
    startupBufferingComplete: false,
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    cacheType: "temporary",
    partId: "1407678433",
    lastEvent: "startup_buffer_progress",
    errorMessage: null
  });

  assert.equal(view.state, "Session state: warming chapter in background");
  assert.equal(view.startup, "Startup buffer: 2 / 3 ready before playback start");
  assert.equal(view.warmup, "Warmup: warming");
  assert.equal(view.transport, "Transport: idle");
  assert.equal(view.buffer, "Ready audio cache: 2");
  assert.equal(view.playback, "Playback: warming in background");
});

test("popup distinguishes play-requested startup wait from passive warmup", () => {
  const view = buildPopupViewModel({
    stateAvailable: true,
    state: "startup_buffering",
    warmupStatus: "starting",
    transportStatus: "queued",
    playRequested: true,
    playbackStatus: "idle",
    currentChunkIndex: 0,
    totalChunks: 9,
    currentChunkId: null,
    chapterReadyAudioCount: 2,
    readyAudioCount: 2,
    startupReadyAudioCount: 2,
    startupTargetReadyAudioCount: 3,
    startupBufferingComplete: false,
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    cacheType: "temporary",
    partId: "1407678433",
    lastEvent: "startup_buffer_progress",
    errorMessage: null
  });

  assert.equal(view.state, "Session state: preparing playback start");
  assert.equal(view.warmup, "Warmup: starting");
  assert.equal(view.transport, "Transport: queued");
  assert.equal(view.playback, "Playback: waiting for startup buffer");
});

test("popup makes interrupted startup retry explicit", () => {
  const view = buildPopupViewModel({
    stateAvailable: true,
    state: "startup_ready",
    warmupStatus: "starting",
    transportStatus: "queued",
    playRequested: true,
    playbackStatus: "idle",
    currentChunkIndex: 0,
    totalChunks: 4,
    currentChunkId: null,
    chapterReadyAudioCount: 3,
    readyAudioCount: 3,
    startupReadyAudioCount: 3,
    startupTargetReadyAudioCount: 3,
    startupBufferingComplete: true,
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    cacheType: "temporary",
    partId: "1407678433",
    lastEvent: "playback_start_interrupted_retry_scheduled",
    errorMessage: "AbortError"
  });

  assert.equal(view.playback, "Playback: retrying interrupted startup");
  assert.equal(view.transport, "Transport: queued");
});

test("popup shows a clearer playing session state once transport is active", () => {
  const view = buildPopupViewModel({
    stateAvailable: true,
    state: "awaiting_chunk_end",
    warmupStatus: "ready",
    transportStatus: "playing",
    playRequested: true,
    playbackStatus: "playing",
    currentChunkIndex: 1,
    totalChunks: 4,
    currentChunkId: "chunk-2",
    chapterReadyAudioCount: 4,
    readyAudioCount: 4,
    startupReadyAudioCount: 3,
    startupTargetReadyAudioCount: 3,
    startupBufferingComplete: true,
    extractionStrategy: "dom-paragraphs",
    extractionConfidence: "high",
    cacheType: "temporary",
    partId: "1407678433",
    lastEvent: "playback_started",
    errorMessage: null
  });

  assert.equal(view.state, "Session state: ready for playback");
  assert.equal(view.warmup, "Warmup: ready");
  assert.equal(view.transport, "Transport: playing");
  assert.equal(view.playback, "Playback: playing");
});
