import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveChapterStatus,
  deriveStoryTitle,
  groupLibraryByStory
} from "../src/shared/libraryState.js";
import { buildLibraryViewModel, formatBytes } from "../src/popup/popupState.js";

function buildChapter(overrides = {}) {
  return {
    chapterId: "chapter-1",
    storyId: "story-1",
    title: "My Story - Chapter 1",
    createdAt: 1000,
    chunkCount: 10,
    readyAudioCount: 10,
    failedCount: 0,
    sizeBytes: 2 * 1024 * 1024,
    ...overrides
  };
}

test("deriveChapterStatus marks fully cached chapters as downloaded", () => {
  assert.equal(deriveChapterStatus(buildChapter()), "downloaded");
});

test("deriveChapterStatus marks actively warming chapters as processing", () => {
  const chapter = buildChapter({ readyAudioCount: 4 });
  assert.equal(deriveChapterStatus(chapter, new Set(["chapter-1"])), "processing");
});

test("deriveChapterStatus marks stalled partial downloads as paused", () => {
  const chapter = buildChapter({ readyAudioCount: 4 });
  assert.equal(deriveChapterStatus(chapter, new Set(["chapter-9"])), "paused");
});

test("deriveChapterStatus treats chapters with no chunks as paused, not downloaded", () => {
  const chapter = buildChapter({ chunkCount: 0, readyAudioCount: 0 });
  assert.equal(deriveChapterStatus(chapter), "paused");
});

test("deriveStoryTitle uses the common title prefix across chapters", () => {
  const title = deriveStoryTitle(["My Story - Chapter 1", "My Story - Chapter 2"], "story-1");
  assert.equal(title, "My Story");
});

test("deriveStoryTitle falls back to the first title when the prefix is too short", () => {
  const title = deriveStoryTitle(["Alpha", "Beta"], "story-1");
  assert.equal(title, "Alpha");
});

test("deriveStoryTitle falls back to the story id when no titles exist", () => {
  assert.equal(deriveStoryTitle([], "123"), "Story 123");
});

test("groupLibraryByStory groups chapters per story with download counts and sizes", () => {
  const stories = groupLibraryByStory(
    [
      buildChapter(),
      buildChapter({ chapterId: "chapter-2", title: "My Story - Chapter 2", createdAt: 2000, readyAudioCount: 3 }),
      buildChapter({ chapterId: "other-1", storyId: "story-2", title: "Other Tale - Part 1", createdAt: 500 })
    ],
    { warmingChapterIds: ["chapter-2"], activeChapterId: "chapter-2" }
  );

  assert.equal(stories.length, 2);
  // Most recently updated story first.
  assert.equal(stories[0].storyId, "story-1");
  assert.equal(stories[0].title, "My Story");
  assert.equal(stories[0].chapterCount, 2);
  assert.equal(stories[0].downloadedCount, 1);
  assert.equal(stories[0].sizeBytes, 4 * 1024 * 1024);
  assert.deepEqual(
    stories[0].chapters.map((chapter) => chapter.status),
    ["downloaded", "processing"]
  );
  assert.equal(stories[0].chapters[1].isActive, true);
  assert.equal(stories[1].storyId, "story-2");
});

test("groupLibraryByStory prefers scraped story metadata over title heuristics", () => {
  const stories = groupLibraryByStory([buildChapter()], {
    storyMetadataById: {
      "story-1": {
        storyId: "story-1",
        title: "Scraped Story Title",
        author: "Author A",
        coverUrl: "https://img.wattpad.com/cover.jpg"
      }
    }
  });

  assert.equal(stories[0].title, "Scraped Story Title");
  assert.equal(stories[0].author, "Author A");
  assert.equal(stories[0].coverUrl, "https://img.wattpad.com/cover.jpg");
});

test("buildLibraryViewModel includes the scraped author in the story summary", () => {
  const stories = groupLibraryByStory([buildChapter()], {
    storyMetadataById: {
      "story-1": { storyId: "story-1", title: "Scraped Story Title", author: "Author A" }
    }
  });
  const view = buildLibraryViewModel({ stories });

  assert.equal(view.stories[0].title, "Scraped Story Title");
  assert.equal(view.stories[0].summary, "Author A · 1 of 1 chapter downloaded · 2.0 MB");
});

test("formatBytes renders human readable sizes", () => {
  assert.equal(formatBytes(0), "0 KB");
  assert.equal(formatBytes(512), "1 KB");
  assert.equal(formatBytes(3.5 * 1024 * 1024), "3.5 MB");
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), "2.0 GB");
});

test("buildLibraryViewModel formats statuses and meta lines", () => {
  const stories = groupLibraryByStory(
    [buildChapter(), buildChapter({ chapterId: "chapter-2", title: "My Story - Chapter 2", readyAudioCount: 5 })],
    { warmingChapterIds: ["chapter-2"] }
  );
  const view = buildLibraryViewModel({ stories });

  assert.equal(view.empty, false);
  assert.equal(view.stories[0].summary, "1 of 2 chapters downloaded · 4.0 MB");

  const [downloaded, processing] = view.stories[0].chapters;
  assert.equal(downloaded.statusLabel, "Downloaded");
  assert.equal(downloaded.meta, "2.0 MB");
  assert.equal(processing.statusLabel, "Processing");
  assert.equal(processing.meta, "50% downloaded · 2.0 MB");
});

test("buildLibraryViewModel reports an empty library", () => {
  assert.equal(buildLibraryViewModel({ stories: [] }).empty, true);
  assert.equal(buildLibraryViewModel(null).empty, true);
});
