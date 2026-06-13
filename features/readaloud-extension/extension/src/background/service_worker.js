import { PlaybackQueue } from "../audio/playbackQueue.js";
import { createRuntimeState } from "../audio/runtimeState.js";

const queue = new PlaybackQueue();

function getChapterIdFromMessage(message) {
  return message?.payload?.chapterId || message?.chapterId || null;
}

async function handleScopedRequest(message, sender) {
  const tabId = sender?.tab?.id ?? null;
  switch (message.type) {
    case "PAGE_READY":
      return queue.warmup({
        ...(message.payload || {}),
        tabId
      });
    case "STORY_PAGE_READY":
      return queue.handleStoryPageReady(message.payload || {});
    case "SYNC_GET":
      return queue.getSyncStatus({ ...(message.payload || {}), tabId });
    case "SYNC_SET":
      return queue.setSyncEnabled({ ...(message.payload || {}), tabId });
    case "PLAY":
      return queue.start({
        ...(message.payload || {}),
        tabId: (message.payload || {}).tabId || tabId
      });
    case "PLAY_FROM_PARAGRAPH":
      return queue.playFromParagraph({
        ...(message.payload || {}),
        tabId: (message.payload || {}).tabId || tabId
      });
    case "PAUSE":
      return queue.pause(message.payload?.chapterId || null);
    case "STOP":
      return queue.stop(message.payload?.chapterId || null);
    case "GET_STATE":
      return queue.getState(message.payload?.chapterId || null);
    case "LIBRARY_GET":
      return queue.getLibrary();
    case "LIBRARY_DELETE_CHAPTER":
      return queue.deleteDownloadedChapter(message.payload?.chapterId || null);
    case "LIBRARY_DELETE_STORY":
      return queue.deleteDownloadedStory(message.payload?.storyId || null);
    case "LIBRARY_CONTINUE":
      return queue.continueStory(message.payload || {});
    case "SLEEP_GET":
      return queue.getSleepTimer();
    case "SLEEP_SET":
      return queue.setSleepTimer(message.payload || {});
    default:
      return queue.buildRequestFailureState(
        getChapterIdFromMessage(message),
        `Unknown message type: ${message.type || "unknown"}`,
        "unknown_request_type"
      );
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("Readaloud MVP installed");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.scope !== "readaloud") {
    return undefined;
  }

  (async () => {
    sendResponse(await handleScopedRequest(message, _sender));
  })().catch((error) => {
    console.error("Service worker request failed", error);
    queue
      .buildRequestFailureState(getChapterIdFromMessage(message), error, "service_worker_request_failed")
      .then((state) => sendResponse(state))
      .catch((nestedError) => {
        console.error("Structured failure response failed", nestedError);
        sendResponse(
          createRuntimeState({
          chapterId: getChapterIdFromMessage(message),
          storyId: null,
          partId: null,
          title: null,
          state: "error",
          playbackStatus: "error",
          currentChunkIndex: null,
          currentChunkId: null,
          totalChunks: 0,
          readyAudioCount: 0,
          failedCount: 0,
          extractionStrategy: null,
          extractionConfidence: null,
          lastEvent: "service_worker_request_failed",
          errorMessage: String(error),
          stateAvailable: true
          })
        );
      });
  });

  return true;
});
