import { createUnavailableRuntimeState } from "../audio/runtimeState.js";
import { buildLibraryViewModel, buildPopupViewModel, isPauseable } from "./popupState.js";

const PLAY_ICON_PATH =
  '<path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.68L9.54 5.98A1 1 0 0 0 8 6.82Z" />';
const PAUSE_ICON_PATH =
  '<path d="M8 5h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm5 1a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1Z" />';
const TRASH_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3h4a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7H5a1 1 0 0 1 0-2h4V4a1 1 0 0 1 1-1Zm-2 4v12h8V7H8Zm3 2a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Zm4 1a1 1 0 1 0-2 0v6a1 1 0 1 0 2 0v-6Z" /></svg>';
const CONFIRM_RESET_MS = 3500;

let lastState = null;
let lastLibrarySignature = null;
let libraryOpen = false;
let confirmResetTimer = null;
let syncStatus = null;

async function request(type, payload = {}) {
  try {
    return await chrome.runtime.sendMessage({
      scope: "readaloud",
      type,
      payload
    });
  } catch (error) {
    return createUnavailableRuntimeState(String(error));
  }
}

function render() {
  const view = buildPopupViewModel(lastState, Date.now());

  document.getElementById("title").textContent = view.title;

  const playButton = document.getElementById("play");
  playButton.setAttribute("aria-label", view.pauseable ? "Pause" : "Play");
  document.getElementById("playIcon").innerHTML = view.pauseable ? PAUSE_ICON_PATH : PLAY_ICON_PATH;

  const timer = document.getElementById("timer");
  timer.textContent = view.timerLabel;
  timer.classList.toggle("idle", !view.timerRunning);

  document.getElementById("warmedFill").style.width = `${view.warmedRatio * 100}%`;
  document.getElementById("playedFill").style.width = `${view.chapterRatio * 100}%`;

  const error = document.getElementById("error");
  error.hidden = !view.errorMessage;
  error.textContent = view.errorMessage || "";
}

function createDeleteButton(label, dataset) {
  const button = document.createElement("button");
  button.className = "delete-button";
  button.innerHTML = TRASH_ICON;
  button.setAttribute("aria-label", label);
  button.title = label;
  Object.assign(button.dataset, dataset);
  return button;
}

function renderChapter(chapter) {
  const row = document.createElement("div");
  row.className = "chapter";

  const info = document.createElement("div");
  info.className = "chapter-info";

  const title = document.createElement("span");
  title.className = "chapter-title";
  title.textContent = chapter.title;
  title.title = chapter.title;

  const meta = document.createElement("span");
  meta.className = "chapter-meta";

  const badge = document.createElement("span");
  badge.className = `status-badge status-${chapter.status}`;
  badge.textContent = chapter.statusLabel;

  const details = document.createElement("span");
  details.textContent = chapter.meta;

  meta.append(badge, details);
  info.append(title, meta);
  row.append(info, createDeleteButton(`Delete audio for ${chapter.title}`, { chapterId: chapter.chapterId }));
  return row;
}

function renderStory(story, openStoryIds) {
  const group = document.createElement("details");
  group.className = "story";
  group.dataset.storyId = story.storyId;
  group.open = openStoryIds.has(story.storyId);

  const summary = document.createElement("summary");
  summary.innerHTML =
    '<svg class="story-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.3 6.3a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 1 1-1.4-1.4L13.58 12 9.3 7.7a1 1 0 0 1 0-1.4Z" /></svg>';

  if (story.coverUrl) {
    const cover = document.createElement("img");
    cover.className = "story-cover";
    cover.src = story.coverUrl;
    cover.alt = "";
    summary.append(cover);
  }

  const heading = document.createElement("div");
  heading.className = "story-heading";

  const title = document.createElement("span");
  title.className = "story-title";
  title.textContent = story.title;
  title.title = story.title;

  const storySummary = document.createElement("span");
  storySummary.className = "story-summary";
  storySummary.textContent = story.summary;

  heading.append(title, storySummary);
  summary.append(heading, createDeleteButton(`Delete all audio for ${story.title}`, { storyId: story.storyId }));
  group.append(summary);

  for (const chapter of story.chapters) {
    group.append(renderChapter(chapter));
  }
  return group;
}

function getOpenStoryIds(listElement) {
  return new Set(
    [...listElement.querySelectorAll("details.story[open]")].map((element) => element.dataset.storyId)
  );
}

function renderLibrary(library, { force = false } = {}) {
  const view = buildLibraryViewModel(library);
  const signature = JSON.stringify(view);
  if (!force && signature === lastLibrarySignature) {
    return;
  }
  // Skip the refresh while a delete confirmation is pending so the poll does
  // not wipe the "Delete?" button out from under the user's second click.
  const list = document.getElementById("libraryList");
  if (!force && list.querySelector(".delete-button.confirming")) {
    return;
  }
  lastLibrarySignature = signature;

  const openStoryIds = getOpenStoryIds(list);
  if (openStoryIds.size === 0 && view.stories.length === 1) {
    openStoryIds.add(view.stories[0].storyId);
  }

  list.replaceChildren(...view.stories.map((story) => renderStory(story, openStoryIds)));
  document.getElementById("libraryEmpty").hidden = !view.empty;
}

async function refreshLibrary(options = {}) {
  const library = await request("LIBRARY_GET");
  if (Array.isArray(library?.stories)) {
    renderLibrary(library, options);
  }
}

function setLibraryOpen(open) {
  libraryOpen = open;
  document.getElementById("playerView").hidden = open;
  document.getElementById("libraryView").hidden = !open;
  if (open) {
    lastLibrarySignature = null;
    void refreshLibrary({ force: true });
  }
}

function resetConfirmingButtons() {
  for (const button of document.querySelectorAll(".delete-button.confirming")) {
    button.classList.remove("confirming");
    button.innerHTML = TRASH_ICON;
  }
}

async function handleDeleteClick(button) {
  if (!button.classList.contains("confirming")) {
    resetConfirmingButtons();
    button.classList.add("confirming");
    button.textContent = "Delete?";
    clearTimeout(confirmResetTimer);
    confirmResetTimer = setTimeout(resetConfirmingButtons, CONFIRM_RESET_MS);
    return;
  }

  clearTimeout(confirmResetTimer);
  button.disabled = true;
  const { chapterId, storyId } = button.dataset;
  const library = chapterId
    ? await request("LIBRARY_DELETE_CHAPTER", { chapterId })
    : await request("LIBRARY_DELETE_STORY", { storyId });
  if (Array.isArray(library?.stories)) {
    renderLibrary(library, { force: true });
  } else {
    await refreshLibrary({ force: true });
  }
}

async function refreshState() {
  lastState = await request("GET_STATE");
  render();
  if (libraryOpen) {
    await refreshLibrary();
  }
}

function renderSyncToggle() {
  const button = document.getElementById("syncToggle");
  if (!button) {
    return;
  }
  const available = Boolean(syncStatus?.ok && syncStatus.storyId);
  button.hidden = !available;
  if (!available) {
    return;
  }
  const enabled = Boolean(syncStatus.enabled);
  button.classList.toggle("on", enabled);
  button.setAttribute("aria-pressed", String(enabled));
  document.getElementById("syncLabel").textContent = enabled ? "Sync on" : "Sync off";
}

// The page (and therefore the story under the toggle) cannot change while
// the popup stays open, so one fetch at open plus updates on click suffice.
async function refreshSync() {
  syncStatus = await request("SYNC_GET");
  renderSyncToggle();
}

document.getElementById("play")?.addEventListener("click", async () => {
  lastState = await request(isPauseable(lastState) ? "PAUSE" : "PLAY");
  render();
});

document.getElementById("stop")?.addEventListener("click", async () => {
  lastState = await request("STOP");
  render();
});

document.getElementById("syncToggle")?.addEventListener("click", async () => {
  if (!syncStatus?.storyId) {
    return;
  }
  const button = document.getElementById("syncToggle");
  button.disabled = true;
  const response = await request("SYNC_SET", {
    storyId: syncStatus.storyId,
    enabled: !syncStatus.enabled
  });
  if (response?.ok) {
    syncStatus = response;
  }
  button.disabled = false;
  renderSyncToggle();
});

document.getElementById("openLibrary")?.addEventListener("click", () => setLibraryOpen(true));
document.getElementById("closeLibrary")?.addEventListener("click", () => setLibraryOpen(false));

document.getElementById("libraryList")?.addEventListener("click", (event) => {
  const button = event.target.closest?.(".delete-button");
  if (!button) {
    return;
  }
  // Keep the click from toggling the surrounding <details> group.
  event.preventDefault();
  event.stopPropagation();
  void handleDeleteClick(button);
});

render();
refreshState();
void refreshSync();
setInterval(refreshState, 1500);
// Tick the timer locally between polls; it only advances while the session
// reports a live playback clock.
setInterval(() => {
  if (lastState?.playbackResumedAt) {
    render();
  }
}, 250);
