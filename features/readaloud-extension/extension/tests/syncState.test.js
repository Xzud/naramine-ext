import test from "node:test";
import assert from "node:assert/strict";

import { applySyncToggle, isStorySyncEnabled, planSyncStart } from "../src/shared/syncState.js";

test("isStorySyncEnabled reads the per-story flag", () => {
  const syncStories = { "story-1": { enabled: true, enabledAt: 1 } };
  assert.equal(isStorySyncEnabled(syncStories, "story-1"), true);
  assert.equal(isStorySyncEnabled(syncStories, "story-2"), false);
  assert.equal(isStorySyncEnabled(syncStories, null), false);
  assert.equal(isStorySyncEnabled(undefined, "story-1"), false);
});

test("applySyncToggle adds and removes stories without mutating the input", () => {
  const initial = { "story-1": { enabled: true, enabledAt: 1 } };
  const enabled = applySyncToggle(initial, "story-2", true, 5);
  assert.deepEqual(Object.keys(enabled).sort(), ["story-1", "story-2"]);
  assert.deepEqual(enabled["story-2"], { enabled: true, enabledAt: 5 });

  const disabled = applySyncToggle(enabled, "story-1", false);
  assert.deepEqual(Object.keys(disabled), ["story-2"]);
  assert.deepEqual(Object.keys(initial), ["story-1"]);
});

test("planSyncStart from a mid-novel chapter downloads it, backfills chapter 1, and prefetches the next", () => {
  const plan = planSyncStart({
    kind: "chapter",
    partId: "222",
    firstPart: { partId: "111", url: "https://www.wattpad.com/111-ch1" },
    nextPart: { partId: "333", url: "https://www.wattpad.com/333-ch3" }
  });

  assert.deepEqual(
    plan.map((step) => step.action),
    ["warm-current", "backfill", "prefetch-next"]
  );
  assert.equal(plan[1].url, "https://www.wattpad.com/111-ch1");
  assert.equal(plan[1].chainNext, false);
  assert.equal(plan[1].activateOnReady, false);
});

test("planSyncStart from chapter 1 skips the backfill", () => {
  const plan = planSyncStart({
    kind: "chapter",
    partId: "111",
    firstPart: { partId: "111", url: "https://www.wattpad.com/111-ch1" },
    nextPart: { partId: "222", url: "https://www.wattpad.com/222-ch2" }
  });

  assert.deepEqual(
    plan.map((step) => step.action),
    ["warm-current", "prefetch-next"]
  );
});

test("planSyncStart skips a backfill that duplicates the next-part prefetch", () => {
  const plan = planSyncStart({
    kind: "chapter",
    partId: "222",
    firstPart: { partId: "333", url: "https://www.wattpad.com/333-ch3" },
    nextPart: { partId: "333", url: "https://www.wattpad.com/333-ch3" }
  });

  assert.deepEqual(
    plan.map((step) => step.action),
    ["warm-current", "prefetch-next"]
  );
});

test("planSyncStart from a story page backfills chapter 1 with chaining and activation", () => {
  const plan = planSyncStart({
    kind: "story",
    storyId: "42",
    firstPart: { partId: "111", url: "https://www.wattpad.com/111-ch1" }
  });

  assert.deepEqual(plan, [
    {
      action: "backfill",
      url: "https://www.wattpad.com/111-ch1",
      partId: "111",
      chainNext: true,
      activateOnReady: true
    }
  ]);
});

test("planSyncStart returns nothing without a usable page context", () => {
  assert.deepEqual(planSyncStart({ kind: "story", storyId: "42", firstPart: null }), []);
  assert.deepEqual(planSyncStart({ kind: "chapter", partId: null }), []);
  assert.deepEqual(planSyncStart({ kind: "none" }), []);
  assert.deepEqual(planSyncStart(), []);
});
