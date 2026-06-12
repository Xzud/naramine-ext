// Pure helpers that turn raw chapter overview records (from idb.js) into the
// per-novel download library shown in the popup. Kept side-effect free so the
// grouping and status rules are testable without IndexedDB or chrome APIs.

const MIN_STORY_TITLE_LENGTH = 3;

// downloaded: every chunk has cached audio. processing: the warming pipeline
// is actively synthesizing this chapter. paused: a partial download that is
// not being worked on (interrupted warmup, closed tab, failed chunks).
export function deriveChapterStatus(chapter, warmingChapterIds = new Set()) {
  if (chapter.chunkCount > 0 && chapter.readyAudioCount >= chapter.chunkCount) {
    return "downloaded";
  }
  if (warmingChapterIds.has(chapter.chapterId)) {
    return "processing";
  }
  return "paused";
}

// Wattpad only exposes per-chapter titles, which usually share the story name
// as a prefix ("Story Name - Chapter 3"). The longest common prefix across a
// story's chapters is the best label we have; fall back to the first title.
export function deriveStoryTitle(titles, storyId) {
  const cleaned = titles.filter(Boolean);
  if (!cleaned.length) {
    return storyId ? `Story ${storyId}` : "Unknown story";
  }

  let prefix = cleaned[0];
  for (const title of cleaned.slice(1)) {
    while (prefix && !title.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  prefix = prefix.replace(/[\s\-–—:|,]+$/u, "").trim();
  return prefix.length >= MIN_STORY_TITLE_LENGTH ? prefix : cleaned[0];
}

export function groupLibraryByStory(chapters, { warmingChapterIds = [], activeChapterId = null } = {}) {
  const warmingSet = new Set(warmingChapterIds);
  const byStory = new Map();

  for (const chapter of chapters || []) {
    const storyId = chapter.storyId || "unknown-story";
    if (!byStory.has(storyId)) {
      byStory.set(storyId, []);
    }
    byStory.get(storyId).push({
      ...chapter,
      status: deriveChapterStatus(chapter, warmingSet),
      isActive: Boolean(activeChapterId) && chapter.chapterId === activeChapterId
    });
  }

  return [...byStory.entries()]
    .map(([storyId, storyChapters]) => {
      const sorted = [...storyChapters].sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
      return {
        storyId,
        title: deriveStoryTitle(
          sorted.map((chapter) => chapter.title),
          storyId
        ),
        chapters: sorted,
        chapterCount: sorted.length,
        downloadedCount: sorted.filter((chapter) => chapter.status === "downloaded").length,
        sizeBytes: sorted.reduce((total, chapter) => total + (chapter.sizeBytes || 0), 0),
        lastUpdatedAt: sorted.reduce((latest, chapter) => Math.max(latest, chapter.createdAt || 0), 0)
      };
    })
    .sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt);
}
