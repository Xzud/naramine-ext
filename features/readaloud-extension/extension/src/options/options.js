import { buildLibraryViewModel, formatBytes } from "../popup/popupState.js";
import {
  findVoiceOption,
  loadUserSettings,
  saveUserSettings,
  VOICE_OPTIONS
} from "../shared/userSettings.js";

const CONFIRM_RESET_MS = 3500;
const LIBRARY_REFRESH_MS = 2500;

let activeTab = "library";
let lastLibrarySignature = null;
let confirmResetTimer = null;

async function request(type, payload = {}) {
  try {
    return await chrome.runtime.sendMessage({
      scope: "readaloud",
      type,
      payload
    });
  } catch (error) {
    return {
      ok: false,
      errorMessage: String(error)
    };
  }
}

function summarizeLibrary(library) {
  const stories = Array.isArray(library?.stories) ? library.stories : [];
  return {
    storyCount: stories.length,
    downloadedCount: stories.reduce((total, story) => total + (story.downloadedCount || 0), 0),
    sizeBytes: stories.reduce((total, story) => total + (story.sizeBytes || 0), 0)
  };
}

function setTab(nextTab) {
  activeTab = nextTab === "settings" ? "settings" : "library";
  const tabIds = ["library", "settings"];
  for (const tabId of tabIds) {
    const selected = tabId === activeTab;
    const tab = document.getElementById(`${tabId}Tab`);
    const panel = document.getElementById(`${tabId}Panel`);
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  }
}

function moveTabFocus(currentId, direction) {
  const order = ["library", "settings"];
  const index = order.indexOf(currentId);
  const nextIndex = (index + direction + order.length) % order.length;
  const nextId = order[nextIndex];
  document.getElementById(`${nextId}Tab`)?.focus();
  setTab(nextId);
}

function setLibraryFlash(message = "", tone = "neutral") {
  const flash = document.getElementById("libraryFlash");
  flash.textContent = message;
  flash.dataset.tone = tone;
}

function setSettingsStatus(message = "", tone = "neutral") {
  const status = document.getElementById("settingsStatus");
  status.textContent = message;
  status.dataset.tone = tone;
}

function updateLibraryStats(stats) {
  document.getElementById("storyCount").textContent = String(stats.storyCount);
  document.getElementById("downloadedCount").textContent = String(stats.downloadedCount);
  document.getElementById("storageUsed").textContent = formatBytes(stats.sizeBytes);
}

function createVoiceCard(option, selectedVoice) {
  const label = document.createElement("label");
  label.className = "voice-card";
  label.classList.toggle("selected", option.id === selectedVoice);

  const input = document.createElement("input");
  input.type = "radio";
  input.name = "defaultVoice";
  input.value = option.id;
  input.checked = option.id === selectedVoice;

  const family = document.createElement("span");
  family.className = "voice-family";
  family.textContent = option.family;

  const name = document.createElement("span");
  name.className = "voice-name";
  name.textContent = option.label;

  const description = document.createElement("span");
  description.className = "voice-description";
  description.textContent = option.description;

  label.append(input, family, name, description);
  return label;
}

function renderSettings(settings) {
  const voiceOptions = document.getElementById("voiceOptions");
  voiceOptions.replaceChildren(...VOICE_OPTIONS.map((option) => createVoiceCard(option, settings.defaultVoice)));

  const currentVoice = findVoiceOption(settings.defaultVoice);
  document.getElementById("voiceSummary").textContent = currentVoice
    ? `${currentVoice.label} (${currentVoice.id}) is the current default. New chapters will use this voice when they are first generated.`
    : `${settings.defaultVoice} is the current default voice.`;
}

function createCover(story) {
  if (story.coverUrl) {
    const image = document.createElement("img");
    image.className = "story-cover";
    image.src = story.coverUrl;
    image.alt = "";
    return image;
  }

  const fallback = document.createElement("div");
  fallback.className = "story-cover-fallback";
  fallback.textContent = (story.title || "?").trim().charAt(0).toUpperCase() || "?";
  fallback.setAttribute("aria-hidden", "true");
  return fallback;
}

function createActionButton({ label, className, action, storyId = "", chapterId = "" }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.dataset.action = action;
  if (storyId) {
    button.dataset.storyId = storyId;
  }
  if (chapterId) {
    button.dataset.chapterId = chapterId;
  }
  return button;
}

function createChapterRow(chapter) {
  const row = document.createElement("div");
  row.className = "chapter-row";

  const copy = document.createElement("div");
  copy.className = "chapter-copy";

  const title = document.createElement("p");
  title.className = "chapter-title";
  title.textContent = chapter.title;
  title.title = chapter.title;

  const meta = document.createElement("div");
  meta.className = "chapter-meta";

  const badge = document.createElement("span");
  badge.className = `status-badge status-${chapter.status}`;
  badge.textContent = chapter.statusLabel;

  const details = document.createElement("span");
  details.textContent = chapter.meta;

  meta.append(badge, details);
  copy.append(title, meta);

  const deleteButton = createActionButton({
    label: "Delete",
    className: "button-danger chapter-delete",
    action: "delete-chapter",
    chapterId: chapter.chapterId
  });
  deleteButton.setAttribute("aria-label", `Delete ${chapter.title}`);

  row.append(copy, deleteButton);
  return row;
}

function createStoryCard(story, rawStory) {
  const card = document.createElement("article");
  card.className = "story-card";

  const top = document.createElement("div");
  top.className = "story-top";

  const copy = document.createElement("div");
  copy.className = "story-copy";

  const title = document.createElement("h2");
  title.className = "story-title";
  title.textContent = story.title;

  const meta = document.createElement("p");
  meta.className = "story-meta";
  meta.textContent = [
    story.author || null,
    `${rawStory?.downloadedCount || 0} of ${rawStory?.chapterCount || story.chapters.length} chapters ready`,
    formatBytes(rawStory?.sizeBytes || 0)
  ]
    .filter(Boolean)
    .join(" · ");

  copy.append(title, meta);

  if (story.continue) {
    const progress = document.createElement("div");
    progress.className = "story-progress";
    progress.textContent = `Left off at ${story.continue.label}`;
    copy.append(progress);
  }

  top.append(createCover(story), copy);

  const actions = document.createElement("div");
  actions.className = "story-actions";
  if (story.continue) {
    actions.append(
      createActionButton({
        label: `Continue · ${story.continue.label}`,
        className: "button-primary",
        action: "continue",
        storyId: story.storyId
      })
    );
  }
  actions.append(
    createActionButton({
      label: "Delete story",
      className: "button-danger",
      action: "delete-story",
      storyId: story.storyId
    })
  );

  const chapters = document.createElement("div");
  chapters.className = "story-chapters";
  chapters.append(...story.chapters.map(createChapterRow));

  card.append(top, actions, chapters);
  return card;
}

function renderLibrary(library, { force = false } = {}) {
  const stories = Array.isArray(library?.stories) ? library.stories : [];
  const view = buildLibraryViewModel(library);
  const signature = JSON.stringify(view);
  const list = document.getElementById("libraryList");
  if (!force && signature === lastLibrarySignature) {
    return;
  }
  if (!force && list.querySelector(".button-danger.confirming")) {
    return;
  }

  lastLibrarySignature = signature;
  updateLibraryStats(summarizeLibrary(library));

  const rawStoryMap = new Map(stories.map((story) => [story.storyId, story]));
  list.replaceChildren(...view.stories.map((story) => createStoryCard(story, rawStoryMap.get(story.storyId))));
  document.getElementById("libraryEmpty").hidden = view.stories.length !== 0;
}

async function refreshLibrary(options = {}) {
  const library = await request("LIBRARY_GET");
  if (!Array.isArray(library?.stories)) {
    setLibraryFlash(library?.errorMessage || "Could not load the local library right now.", "danger");
    updateLibraryStats(summarizeLibrary(null));
    document.getElementById("libraryList").replaceChildren();
    document.getElementById("libraryEmpty").hidden = false;
    return;
  }

  renderLibrary(library, options);
}

function resetConfirmingButtons() {
  for (const button of document.querySelectorAll(".button-danger.confirming")) {
    button.classList.remove("confirming");
    button.textContent = button.dataset.defaultLabel || "Delete";
  }
}

async function handleDeleteAction(button) {
  if (!button.classList.contains("confirming")) {
    resetConfirmingButtons();
    button.classList.add("confirming");
    button.dataset.defaultLabel = button.textContent;
    button.textContent = button.dataset.action === "delete-story" ? "Delete story?" : "Delete chapter?";
    clearTimeout(confirmResetTimer);
    confirmResetTimer = setTimeout(resetConfirmingButtons, CONFIRM_RESET_MS);
    return;
  }

  clearTimeout(confirmResetTimer);
  button.disabled = true;
  const response =
    button.dataset.action === "delete-story"
      ? await request("LIBRARY_DELETE_STORY", { storyId: button.dataset.storyId })
      : await request("LIBRARY_DELETE_CHAPTER", { chapterId: button.dataset.chapterId });

  if (Array.isArray(response?.stories)) {
    renderLibrary(response, { force: true });
    setLibraryFlash(
      button.dataset.action === "delete-story" ? "Story removed from this device." : "Chapter removed from this device.",
      "success"
    );
  } else {
    setLibraryFlash(response?.errorMessage || "The delete request did not complete.", "danger");
    await refreshLibrary({ force: true });
  }
}

async function handleLibraryClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  if (button.dataset.action === "continue") {
    button.disabled = true;
    const response = await request("LIBRARY_CONTINUE", { storyId: button.dataset.storyId });
    button.disabled = false;
    if (response?.ok) {
      setLibraryFlash("Resuming your last chapter in Wattpad.", "success");
      return;
    }
    setLibraryFlash(response?.errorMessage || "Could not resume that chapter.", "danger");
    return;
  }

  await handleDeleteAction(button);
}

async function refreshSettings() {
  renderSettings(await loadUserSettings(chrome.storage.local));
}

async function handleVoiceChange(event) {
  const input = event.target.closest?.('input[name="defaultVoice"]');
  if (!input) {
    return;
  }

  try {
    const settings = await saveUserSettings(chrome.storage.local, {
      defaultVoice: input.value
    });
    renderSettings(settings);
    const currentVoice = findVoiceOption(settings.defaultVoice);
    setSettingsStatus(
      currentVoice
        ? `Saved. New chapters will use ${currentVoice.label} (${currentVoice.id}).`
        : "Saved.",
      "success"
    );
  } catch (error) {
    setSettingsStatus(`Could not save the default voice: ${error}`, "danger");
  }
}

document.getElementById("tabList")?.addEventListener("click", (event) => {
  const button = event.target.closest(".tab-button");
  if (!button) {
    return;
  }
  setTab(button.id === "settingsTab" ? "settings" : "library");
});

document.getElementById("tabList")?.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight") {
    event.preventDefault();
    moveTabFocus(activeTab, 1);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    moveTabFocus(activeTab, -1);
  } else if (event.key === "Home") {
    event.preventDefault();
    document.getElementById("libraryTab")?.focus();
    setTab("library");
  } else if (event.key === "End") {
    event.preventDefault();
    document.getElementById("settingsTab")?.focus();
    setTab("settings");
  }
});

document.getElementById("libraryList")?.addEventListener("click", (event) => {
  void handleLibraryClick(event);
});

document.getElementById("voiceOptions")?.addEventListener("change", (event) => {
  void handleVoiceChange(event);
});

setTab("library");
void refreshLibrary({ force: true });
void refreshSettings();
setInterval(() => {
  if (!document.hidden) {
    void refreshLibrary();
  }
}, LIBRARY_REFRESH_MS);
