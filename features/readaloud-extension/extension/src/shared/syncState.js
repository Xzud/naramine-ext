// Pure helpers for the per-story Sync toggle. Sync follows the user as they
// read: while it is on for a story, visiting a chapter downloads its audio
// and prefetches the next chapter. Kept side-effect free so the toggle rules
// and the Sync-On kickoff plan are testable without chrome APIs.

export function isStorySyncEnabled(syncStories, storyId) {
  if (!storyId) {
    return false;
  }
  return Boolean(syncStories?.[storyId]?.enabled);
}

export function applySyncToggle(syncStories = {}, storyId, enabled, now = Date.now()) {
  if (!storyId) {
    return { ...syncStories };
  }
  if (!enabled) {
    const { [storyId]: _removed, ...rest } = syncStories;
    return rest;
  }
  return {
    ...syncStories,
    [storyId]: { enabled: true, enabledAt: now }
  };
}

// Decides which downloads turning Sync On kicks off, in order. From a chapter
// page: the chapter itself, then a chapter-1 backfill (a user landing
// mid-novel is usually sampling and will want the beginning), then the next
// chapter — the one case where three chapters sync at once. From a story
// overview page: chapter 1 only; its own next-part prefetch covers chapter 2.
export function planSyncStart(context = {}) {
  if (context.kind === "story") {
    if (!context.firstPart?.url) {
      return [];
    }
    return [
      {
        action: "backfill",
        url: context.firstPart.url,
        partId: context.firstPart.partId || null,
        chainNext: true,
        activateOnReady: true
      }
    ];
  }

  if (context.kind !== "chapter" || !context.partId) {
    return [];
  }

  const actions = [{ action: "warm-current" }];
  const firstPart = context.firstPart || null;
  const isOnFirstPart = firstPart?.partId && String(firstPart.partId) === String(context.partId);
  const firstPartIsNextPart =
    firstPart?.partId && context.nextPart?.partId && String(firstPart.partId) === String(context.nextPart.partId);
  if (firstPart?.url && !isOnFirstPart && !firstPartIsNextPart) {
    actions.push({
      action: "backfill",
      url: firstPart.url,
      partId: firstPart.partId || null,
      chainNext: false,
      activateOnReady: false
    });
  }
  if (context.nextPart?.url) {
    actions.push({ action: "prefetch-next" });
  }
  return actions;
}
