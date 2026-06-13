const PAUSEABLE_PLAYBACK_STATUSES = new Set(["dispatching", "starting", "playing", "awaiting_chunk_end"]);

export function isPauseable(state) {
  if (!state?.stateAvailable) {
    return false;
  }

  return PAUSEABLE_PLAYBACK_STATUSES.has(state.playbackStatus);
}

export function computeElapsedMs(state, now = Date.now()) {
  if (!state?.stateAvailable) {
    return 0;
  }

  const base = state.playbackElapsedMs || 0;
  if (state.playbackResumedAt) {
    return base + Math.max(0, now - state.playbackResumedAt);
  }
  return base;
}

export function formatTimer(elapsedMs) {
  const totalSeconds = Math.floor(Math.max(0, elapsedMs || 0) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
  }
  return `${minutes}:${seconds}`;
}

export function getWarmedRatio(state) {
  if (!state?.stateAvailable || !state.totalChunks) {
    return 0;
  }

  return Math.min(state.readyAudioCount || 0, state.totalChunks) / state.totalChunks;
}

export function getChapterRatio(state) {
  if (!state?.stateAvailable || !state.totalChunks || typeof state.currentChunkIndex !== "number") {
    return 0;
  }

  if (state.state === "idle") {
    return 0;
  }

  return Math.min(state.currentChunkIndex + 1, state.totalChunks) / state.totalChunks;
}

const LIBRARY_STATUS_LABELS = {
  downloaded: "Downloaded",
  processing: "Processing",
  paused: "Paused"
};

export function formatBytes(bytes) {
  const safeBytes = Math.max(0, bytes || 0);
  if (safeBytes === 0) {
    return "0 KB";
  }
  const megabytes = safeBytes / (1024 * 1024);
  if (megabytes >= 1024) {
    return `${(megabytes / 1024).toFixed(1)} GB`;
  }
  if (megabytes >= 1) {
    return `${megabytes.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(safeBytes / 1024))} KB`;
}

function buildChapterMeta(chapter) {
  const size = formatBytes(chapter.sizeBytes);
  if (chapter.status === "downloaded") {
    return size;
  }
  const percent = chapter.chunkCount > 0 ? Math.floor((chapter.readyAudioCount / chapter.chunkCount) * 100) : 0;
  return `${Math.min(99, percent)}% downloaded · ${size}`;
}

export function buildLibraryViewModel(library) {
  const stories = Array.isArray(library?.stories) ? library.stories : [];
  return {
    empty: stories.length === 0,
    stories: stories.map((story) => ({
      storyId: story.storyId,
      title: story.title || "Unknown story",
      author: story.author || "",
      coverUrl: story.coverUrl || "",
      summary: [
        story.author || null,
        `${story.downloadedCount} of ${story.chapterCount} chapter${story.chapterCount === 1 ? "" : "s"} downloaded · ${formatBytes(story.sizeBytes)}`
      ]
        .filter(Boolean)
        .join(" · "),
      chapters: story.chapters.map((chapter) => ({
        chapterId: chapter.chapterId,
        title: chapter.title || "Untitled chapter",
        status: chapter.status,
        statusLabel: LIBRARY_STATUS_LABELS[chapter.status] || chapter.status,
        isActive: Boolean(chapter.isActive),
        meta: buildChapterMeta(chapter)
      }))
    }))
  };
}

export function buildPopupViewModel(state, now = Date.now()) {
  const available = Boolean(state?.stateAvailable);

  return {
    title: (available && state.title) || "Read Aloud",
    pauseable: isPauseable(state),
    timerLabel: formatTimer(computeElapsedMs(state, now)),
    timerRunning: Boolean(available && state.playbackResumedAt),
    warmedRatio: getWarmedRatio(state),
    chapterRatio: getChapterRatio(state),
    errorMessage:
      available && state.state !== "error" && state.playbackStatus !== "error"
        ? null
        : state?.errorMessage || state?.unavailableReason || null
  };
}
