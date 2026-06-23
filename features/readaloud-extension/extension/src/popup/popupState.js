import { findVoiceOption } from "../shared/userSettings.js";

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
  const voiceCount = Math.max(0, chapter.voiceCount || chapter.voices?.length || 0);
  const voiceSummary = voiceCount > 0 ? `${voiceCount} voice${voiceCount === 1 ? "" : "s"}` : null;
  if (chapter.status === "downloaded") {
    return [voiceSummary, size].filter(Boolean).join(" · ") || size;
  }
  const percent = chapter.chunkCount > 0 ? Math.floor((chapter.readyAudioCount / chapter.chunkCount) * 100) : 0;
  return [`${Math.min(99, percent)}% downloaded`, voiceSummary, size].filter(Boolean).join(" · ");
}

function buildContinueLabel(lastPlayed) {
  const title = lastPlayed.chapterTitle || "your last chapter";
  if (lastPlayed.totalChunks > 0) {
    const percent = Math.min(99, Math.floor((lastPlayed.chunkIndex / lastPlayed.totalChunks) * 100));
    return `${title} · ${percent}%`;
  }
  return title;
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
      continue: story.lastPlayed
        ? {
            chapterId: story.lastPlayed.chapterId,
            label: buildContinueLabel(story.lastPlayed)
          }
        : null,
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
        meta: buildChapterMeta(chapter),
        voices: (Array.isArray(chapter.variants) ? chapter.variants : []).map((variant) => {
          const option = findVoiceOption(variant.voiceId);
          return {
            voiceId: variant.voiceId || "",
            label: option?.label || variant.voiceId || "Unknown",
            family: option?.family || "",
            variantChapterId: variant.variantChapterId || chapter.chapterId,
            isActive: Boolean(variant.isActive),
            isDownloaded: Boolean(variant.isDownloaded)
          };
        })
      }))
    }))
  };
}

// True while audio is actively playing or paused (not idle/ended/error). Used
// to keep the player visible even on an unsupported tab so transport controls
// for the in-progress chapter are never stranded.
export function isPlaybackActive(state) {
  if (!state?.stateAvailable) {
    return false;
  }
  if (state.state === "paused" || state.playbackStatus === "paused") {
    return true;
  }
  return PAUSEABLE_PLAYBACK_STATUSES.has(state.playbackStatus);
}

// Decides which of the three top-level views the popup shows. The player only
// appears when the active tab is a supported page (a Wattpad chapter or story
// overview) or when something is already playing; otherwise the guide explains
// how to start and offers a way back into recent reads.
export function selectPrimaryView({ pageContext, state, libraryOpen } = {}) {
  if (libraryOpen) {
    return "library";
  }
  const kind = pageContext?.kind;
  const supported = kind === "chapter" || kind === "story";
  if (supported || isPlaybackActive(state)) {
    return "player";
  }
  return "guide";
}

const GUIDE_RECENTS_LIMIT = 5;

// Shapes the "continue where you left off" rows for the guide from the recents
// map the background persists: a chapter title plus a short progress readout.
export function buildGuideViewModel(recents) {
  const items = Array.isArray(recents?.recents)
    ? recents.recents
    : Array.isArray(recents)
      ? recents
      : [];
  const mapped = items
    .filter((item) => item && item.storyId && item.chapterId)
    .slice(0, GUIDE_RECENTS_LIMIT)
    .map((item) => {
      const percent =
        item.totalChunks > 0
          ? Math.min(99, Math.floor((item.chunkIndex / item.totalChunks) * 100))
          : null;
      return {
        storyId: item.storyId,
        chapterId: item.chapterId,
        title: item.chapterTitle || "Your last chapter",
        meta: percent === null ? "Resume" : `${percent}% in`
      };
    });
  return {
    hasRecents: mapped.length > 0,
    recents: mapped
  };
}

export function buildPopupViewModel(state, now = Date.now()) {
  const available = Boolean(state?.stateAvailable);
  // The off-page block is an actionable hint, not a failure, but it surfaces
  // through the same message slot so the reader knows why nothing played.
  const showMessage =
    !available ||
    Boolean(state?.playBlockedOffPage) ||
    state.state === "error" ||
    state.playbackStatus === "error";

  return {
    title: (available && state.title) || "Naramine",
    pauseable: isPauseable(state),
    timerLabel: formatTimer(computeElapsedMs(state, now)),
    timerRunning: Boolean(available && state.playbackResumedAt),
    warmedRatio: getWarmedRatio(state),
    chapterRatio: getChapterRatio(state),
    errorMessage: showMessage ? state?.errorMessage || state?.unavailableReason || null : null,
    currentVoiceId: available ? state?.voice || null : null,
    currentVoiceLabel: available ? findVoiceOption(state?.voice)?.label || state?.voice || null : null
  };
}
