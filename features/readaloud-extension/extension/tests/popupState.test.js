import test from "node:test";
import assert from "node:assert/strict";

import { createUnavailableRuntimeState } from "../src/audio/runtimeState.js";
import {
  buildGuideViewModel,
  buildPopupViewModel,
  computeElapsedMs,
  formatTimer,
  getChapterRatio,
  getWarmedRatio,
  isPauseable,
  isPlaybackActive,
  selectPrimaryView
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

  assert.equal(view.title, "Naramine");
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

test("off-page play block surfaces as a hint without marking an error or pause control", () => {
  const view = buildPopupViewModel(
    buildState({
      state: "startup_ready",
      playbackStatus: "idle",
      playBlockedOffPage: true,
      errorMessage: "Open this chapter in Wattpad to play."
    }),
    1000
  );

  assert.equal(view.errorMessage, "Open this chapter in Wattpad to play.");
  assert.equal(view.pauseable, false);
});

test("selectPrimaryView shows the library whenever it is open", () => {
  assert.equal(
    selectPrimaryView({ pageContext: { kind: "none" }, state: null, libraryOpen: true }),
    "library"
  );
});

test("selectPrimaryView shows the player on supported pages", () => {
  for (const kind of ["chapter", "story"]) {
    assert.equal(
      selectPrimaryView({ pageContext: { kind }, state: null, libraryOpen: false }),
      "player"
    );
  }
});

test("selectPrimaryView shows the guide on unsupported pages when nothing is playing", () => {
  assert.equal(
    selectPrimaryView({ pageContext: { kind: "none" }, state: buildState({ state: "idle", playbackStatus: "idle", stateAvailable: true }), libraryOpen: false }),
    "guide"
  );
  assert.equal(
    selectPrimaryView({ pageContext: null, state: null, libraryOpen: false }),
    "guide"
  );
});

test("selectPrimaryView keeps the player on an unsupported page while audio is active", () => {
  const playing = selectPrimaryView({
    pageContext: { kind: "none" },
    state: buildState({ state: "awaiting_chunk_end", playbackStatus: "playing" }),
    libraryOpen: false
  });
  assert.equal(playing, "player");

  const paused = selectPrimaryView({
    pageContext: { kind: "none" },
    state: buildState({ state: "paused", playbackStatus: "paused" }),
    libraryOpen: false
  });
  assert.equal(paused, "player");
});

test("isPlaybackActive is false for idle, ended, and error sessions", () => {
  assert.equal(isPlaybackActive(buildState({ state: "idle", playbackStatus: "idle" })), false);
  assert.equal(isPlaybackActive(buildState({ state: "ended", playbackStatus: "ended" })), false);
  assert.equal(isPlaybackActive(buildState({ state: "error", playbackStatus: "error" })), false);
  assert.equal(isPlaybackActive(null), false);
  assert.equal(isPlaybackActive(createUnavailableRuntimeState("nope")), false);
});

test("buildGuideViewModel maps recents to titles with progress and drops malformed rows", () => {
  const view = buildGuideViewModel({
    recents: [
      { storyId: "s1", chapterId: "c1", chapterTitle: "Chapter One", chunkIndex: 5, totalChunks: 10 },
      { storyId: "s2", chapterId: "c2", chapterTitle: "Chapter Two", chunkIndex: 0, totalChunks: 0 },
      { storyId: null, chapterId: "c3", chapterTitle: "No story" }
    ]
  });

  assert.equal(view.hasRecents, true);
  assert.equal(view.recents.length, 2);
  assert.deepEqual(view.recents[0], {
    storyId: "s1",
    chapterId: "c1",
    title: "Chapter One",
    meta: "50% in"
  });
  assert.equal(view.recents[1].meta, "Resume");
});

test("buildGuideViewModel reports empty when there are no usable recents", () => {
  assert.equal(buildGuideViewModel({ recents: [] }).hasRecents, false);
  assert.equal(buildGuideViewModel(null).hasRecents, false);
  assert.equal(buildGuideViewModel({ recents: [{ storyId: "s" }] }).hasRecents, false);
});
