import test from "node:test";
import assert from "node:assert/strict";

import { createUnavailableRuntimeState } from "../src/audio/runtimeState.js";
import {
  buildPopupViewModel,
  computeElapsedMs,
  formatTimer,
  getChapterRatio,
  getWarmedRatio,
  isPauseable
} from "../src/popup/popupState.js";

function buildState(overrides = {}) {
  return {
    stateAvailable: true,
    state: "awaiting_chunk_end",
    playbackStatus: "playing",
    title: "Chapter One",
    currentChunkIndex: 2,
    totalChunks: 10,
    readyAudioCount: 6,
    playbackElapsedMs: 65000,
    playbackResumedAt: null,
    errorMessage: null,
    ...overrides
  };
}

test("formatTimer renders minutes and seconds, with hours when needed", () => {
  assert.equal(formatTimer(0), "0:00");
  assert.equal(formatTimer(9000), "0:09");
  assert.equal(formatTimer(65000), "1:05");
  assert.equal(formatTimer(3723000), "1:02:03");
});

test("elapsed time only advances while the playback clock is running", () => {
  const paused = buildState({ playbackElapsedMs: 30000, playbackResumedAt: null });
  assert.equal(computeElapsedMs(paused, 1000000), 30000);

  const playing = buildState({ playbackElapsedMs: 30000, playbackResumedAt: 995000 });
  assert.equal(computeElapsedMs(playing, 1000000), 35000);
});

test("view model shows a frozen timer while paused", () => {
  const view = buildPopupViewModel(
    buildState({
      state: "paused",
      playbackStatus: "paused",
      playbackElapsedMs: 125000,
      playbackResumedAt: null
    }),
    1000000
  );

  assert.equal(view.timerLabel, "2:05");
  assert.equal(view.timerRunning, false);
  assert.equal(view.pauseable, false);
});

test("view model shows a running timer and pause control during playback", () => {
  const view = buildPopupViewModel(
    buildState({ playbackElapsedMs: 60000, playbackResumedAt: 998000 }),
    1000000
  );

  assert.equal(view.timerLabel, "1:02");
  assert.equal(view.timerRunning, true);
  assert.equal(view.pauseable, true);
});

test("bar ratios reflect played and warmed chunks against the total", () => {
  const state = buildState({ currentChunkIndex: 4, totalChunks: 10, readyAudioCount: 7 });
  assert.equal(getChapterRatio(state), 0.5);
  assert.equal(getWarmedRatio(state), 0.7);

  const overWarmed = buildState({ totalChunks: 4, readyAudioCount: 9 });
  assert.equal(getWarmedRatio(overWarmed), 1);
});

test("unavailable state renders a safe empty player", () => {
  const view = buildPopupViewModel(createUnavailableRuntimeState("Service worker unreachable."), 1000);

  assert.equal(view.title, "Read Aloud");
  assert.equal(view.timerLabel, "0:00");
  assert.equal(view.timerRunning, false);
  assert.equal(view.warmedRatio, 0);
  assert.equal(view.chapterRatio, 0);
  assert.match(view.errorMessage, /unreachable/i);
  assert.equal(isPauseable(createUnavailableRuntimeState("x")), false);
});

test("errors surface in the view model only when the session failed", () => {
  const healthy = buildPopupViewModel(buildState(), 1000);
  assert.equal(healthy.errorMessage, null);

  const failed = buildPopupViewModel(
    buildState({ state: "error", playbackStatus: "error", errorMessage: "TTS exploded" }),
    1000
  );
  assert.equal(failed.errorMessage, "TTS exploded");
});
