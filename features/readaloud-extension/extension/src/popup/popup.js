import { createUnavailableRuntimeState } from "../audio/runtimeState.js";
import {
  buildGuideViewModel,
  buildLibraryViewModel,
  buildPopupViewModel,
  formatTimer,
  isPauseable,
  selectPrimaryView
} from "./popupState.js";

const WATTPAD_HOME_URL = "https://www.wattpad.com/";

const PLAY_ICON_PATH =
  '<path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.68L9.54 5.98A1 1 0 0 0 8 6.82Z" />';
const PAUSE_ICON_PATH =
  '<path d="M8 5h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm5 1a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1Z" />';
const TRASH_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3h4a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7H5a1 1 0 0 1 0-2h4V4a1 1 0 0 1 1-1Zm-2 4v12h8V7H8Zm3 2a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Zm4 1a1 1 0 1 0-2 0v6a1 1 0 1 0 2 0v-6Z" /></svg>';
const CONFIRM_RESET_MS = 3500;

let lastState = null;
let lastLibrarySignature = null;
let lastGuideSignature = null;
let libraryOpen = false;
let confirmResetTimer = null;
let syncStatus = null;
let sleepStatus = null;
// What the active tab is ({ kind: "chapter" | "story" | "none", ... }). Drives
// whether the popup shows the player or the "open a story" guide.
let pageContext = null;

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

function openSettingsPage() {
  if (chrome.runtime?.openOptionsPage) {
    void chrome.runtime.openOptionsPage();
    return;
  }

  const fallbackUrl = chrome.runtime?.getURL?.("src/options/options.html");
  if (!fallbackUrl) {
    return;
  }
  if (chrome.tabs?.create) {
    void chrome.tabs.create({ url: fallbackUrl });
  } else {
    window.open(fallbackUrl, "_blank");
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

  if (story.continue) {
    group.append(createContinueButton(story));
  }

  for (const chapter of story.chapters) {
    group.append(renderChapter(chapter));
  }
  return group;
}

const CONTINUE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.68L9.54 5.98A1 1 0 0 0 8 6.82Z" /></svg>';

function createContinueButton(story) {
  const button = document.createElement("button");
  button.className = "continue-button";
  button.dataset.continueStoryId = story.storyId;
  button.title = `Continue ${story.continue.label}`;

  const label = document.createElement("span");
  label.className = "continue-label";
  label.textContent = `Continue · ${story.continue.label}`;

  button.innerHTML = CONTINUE_ICON;
  button.append(label);
  return button;
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

// Single place that maps the current page/playback/library state onto exactly
// one visible view, so the three <main>s never fight over `hidden`.
function applyView() {
  const view = selectPrimaryView({ pageContext, state: lastState, libraryOpen });
  document.getElementById("playerView").hidden = view !== "player";
  document.getElementById("guideView").hidden = view !== "guide";
  document.getElementById("libraryView").hidden = view !== "library";
}

function setLibraryOpen(open) {
  libraryOpen = open;
  applyView();
  if (open) {
    lastLibrarySignature = null;
    void refreshLibrary({ force: true });
  }
}

const RECENT_PLAY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true">${PLAY_ICON_PATH}</svg>`;

function createRecentItem(recent) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "recent-item";
  button.dataset.continueStoryId = recent.storyId;
  button.title = `Continue ${recent.title}`;

  const icon = document.createElement("span");
  icon.className = "recent-play";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = RECENT_PLAY_ICON;

  const text = document.createElement("div");
  text.className = "recent-text";

  const title = document.createElement("span");
  title.className = "recent-title";
  title.textContent = recent.title;

  const meta = document.createElement("span");
  meta.className = "recent-meta";
  meta.textContent = recent.meta;

  text.append(title, meta);
  button.append(icon, text);
  return button;
}

function renderGuide(recents) {
  const view = buildGuideViewModel(recents);
  document.getElementById("guideRecents").hidden = !view.hasRecents;

  const signature = JSON.stringify(view);
  if (signature === lastGuideSignature) {
    return;
  }
  lastGuideSignature = signature;
  document.getElementById("recentList").replaceChildren(...view.recents.map(createRecentItem));
}

async function refreshGuide() {
  renderGuide(await request("RECENTS_GET"));
}

async function refreshPageContext() {
  const next = await request("PAGE_CONTEXT_GET");
  // Only adopt a well-formed response; a transport failure leaves the last
  // known context in place rather than bouncing the view.
  if (next && typeof next.kind === "string") {
    pageContext = next;
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
  await refreshPageContext();
  applyView();

  const view = selectPrimaryView({ pageContext, state: lastState, libraryOpen });
  if (view === "library") {
    await refreshLibrary();
    return;
  }
  if (view === "guide") {
    await refreshGuide();
    return;
  }
  // Player view: the first sync probe can miss (service worker waking, content
  // script just loaded); keep retrying on the poll until the story under the
  // toggle resolves, then stop re-probing the page.
  if (!syncStatus?.ok) {
    await refreshSync();
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

async function refreshSync() {
  syncStatus = await request("SYNC_GET");
  renderSyncToggle();
}

function renderSleep() {
  const button = document.getElementById("sleepToggle");
  const label = document.getElementById("sleepLabel");
  if (!button || !label) {
    return;
  }
  const mode = sleepStatus?.mode || "off";
  button.classList.toggle("active", mode !== "off");
  button.setAttribute("aria-label", mode === "off" ? "Sleep timer" : "Sleep timer (on)");

  if (mode === "duration" && sleepStatus?.deadline) {
    label.hidden = false;
    label.textContent = formatTimer(Math.max(0, sleepStatus.deadline - Date.now()));
  } else if (mode === "end_of_chapter") {
    label.hidden = false;
    label.textContent = "Chapter";
  } else {
    label.hidden = true;
    label.textContent = "";
  }

  for (const option of document.querySelectorAll(".sleep-option")) {
    const optionMode = option.dataset.duration ? "duration" : option.dataset.mode;
    const matches =
      optionMode === mode &&
      (mode !== "duration" || Number(option.dataset.duration) === sleepStatus?.durationMs);
    option.classList.toggle("selected", Boolean(matches));
  }
}

// SLEEP_GET only reads stored state (no page round-trip), so polling it on the
// regular refresh is cheap and keeps the countdown and "fired" state current.
async function refreshSleep() {
  sleepStatus = await request("SLEEP_GET");
  renderSleep();
}

function setSleepMenuOpen(open) {
  const menu = document.getElementById("sleepMenu");
  const button = document.getElementById("sleepToggle");
  if (!menu || !button) {
    return;
  }
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
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

document.getElementById("sleepToggle")?.addEventListener("click", (event) => {
  event.stopPropagation();
  setSleepMenuOpen(document.getElementById("sleepMenu")?.hidden !== false);
});

document.getElementById("sleepMenu")?.addEventListener("click", async (event) => {
  const option = event.target.closest?.(".sleep-option");
  if (!option) {
    return;
  }
  const payload = option.dataset.duration
    ? { mode: "duration", durationMs: Number(option.dataset.duration) }
    : { mode: option.dataset.mode || "off" };
  const response = await request("SLEEP_SET", payload);
  if (response && typeof response.mode === "string") {
    sleepStatus = response;
  }
  setSleepMenuOpen(false);
  renderSleep();
});

// Close the sleep menu when clicking elsewhere in the popup.
document.addEventListener("click", (event) => {
  if (event.target.closest?.("#sleepMenu") || event.target.closest?.("#sleepToggle")) {
    return;
  }
  setSleepMenuOpen(false);
});

document.getElementById("openLibrary")?.addEventListener("click", () => setLibraryOpen(true));
document.getElementById("closeLibrary")?.addEventListener("click", () => setLibraryOpen(false));
document.getElementById("guideLibrary")?.addEventListener("click", () => setLibraryOpen(true));
for (const button of document.querySelectorAll("[data-open-settings]")) {
  button.addEventListener("click", openSettingsPage);
}

document.getElementById("browseWattpad")?.addEventListener("click", () => {
  if (chrome.tabs?.create) {
    void chrome.tabs.create({ url: WATTPAD_HOME_URL });
  } else {
    window.open(WATTPAD_HOME_URL, "_blank");
  }
});

document.getElementById("recentList")?.addEventListener("click", (event) => {
  const item = event.target.closest?.(".recent-item");
  if (item) {
    void handleContinueClick(item);
  }
});

async function handleContinueClick(button) {
  button.disabled = true;
  const response = await request("LIBRARY_CONTINUE", { storyId: button.dataset.continueStoryId });
  if (response?.ok) {
    // Drop back to the player so the resumed chapter's progress is visible.
    setLibraryOpen(false);
    await refreshState();
    return;
  }
  button.disabled = false;
}

document.getElementById("libraryList")?.addEventListener("click", (event) => {
  const continueButton = event.target.closest?.(".continue-button");
  if (continueButton) {
    event.preventDefault();
    event.stopPropagation();
    void handleContinueClick(continueButton);
    return;
  }

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
void refreshSleep();
setInterval(refreshState, 1500);
setInterval(refreshSleep, 1500);
// Tick the timers locally between polls: the playback clock while audio is
// live, and the sleep countdown while a duration timer is running.
setInterval(() => {
  if (lastState?.playbackResumedAt) {
    render();
  }
  if (sleepStatus?.mode === "duration") {
    renderSleep();
  }
}, 250);
