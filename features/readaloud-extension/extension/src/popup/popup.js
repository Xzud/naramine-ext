import { createUnavailableRuntimeState } from "../audio/runtimeState.js";
import { buildPopupViewModel, isPauseable } from "./popupState.js";

const PLAY_ICON_PATH =
  '<path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.68L9.54 5.98A1 1 0 0 0 8 6.82Z" />';
const PAUSE_ICON_PATH =
  '<path d="M8 5h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm5 1a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1Z" />';

let lastState = null;

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

async function refreshState() {
  lastState = await request("GET_STATE");
  render();
}

document.getElementById("play")?.addEventListener("click", async () => {
  lastState = await request(isPauseable(lastState) ? "PAUSE" : "PLAY");
  render();
});

document.getElementById("stop")?.addEventListener("click", async () => {
  lastState = await request("STOP");
  render();
});

render();
refreshState();
setInterval(refreshState, 1500);
// Tick the timer locally between polls; it only advances while the session
// reports a live playback clock.
setInterval(() => {
  if (lastState?.playbackResumedAt) {
    render();
  }
}, 250);
