import { DEFAULT_CHAPTER_ID } from "../shared/constants.js";
import { getAudioChunk } from "../db/idb.js";

let currentAudio = null;
let currentUrl = "";
let currentChunkId = null;
let currentAttemptId = null;
let currentChapterId = DEFAULT_CHAPTER_ID;
let interruptedAttemptIds = new Set();
let playbackState = {
  playing: false,
  paused: false,
  chunkId: null,
  attemptId: null,
  ended: false,
  error: null
};

function getAudioErrorDetails(audioRef) {
  const code = audioRef?.error?.code ?? null;
  const codeName =
    code === MediaError.MEDIA_ERR_ABORTED
      ? "MEDIA_ERR_ABORTED"
      : code === MediaError.MEDIA_ERR_NETWORK
        ? "MEDIA_ERR_NETWORK"
        : code === MediaError.MEDIA_ERR_DECODE
          ? "MEDIA_ERR_DECODE"
          : code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
            ? "MEDIA_ERR_SRC_NOT_SUPPORTED"
            : "unknown";

  return `Audio element failed to play (${codeName}, readyState=${audioRef?.readyState ?? "n/a"}, networkState=${audioRef?.networkState ?? "n/a"})`;
}

function setPlaybackState(overrides = {}) {
  playbackState = {
    ...playbackState,
    ...overrides
  };
}

function clearCurrentAudio(options = {}) {
  const { clearChunkId = false, markInterrupted = false, reason = "clear" } = options;
  if (currentAudio) {
    if (markInterrupted && currentAttemptId) {
      interruptedAttemptIds.add(currentAttemptId);
      console.log(`[offscreen] audio_cleared chunk=${currentChunkId || "-"} attempt=${currentAttemptId} reason=${reason}`);
    }
    currentAudio.pause();
    currentAudio.src = "";
    currentAudio = null;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = "";
  }
  if (clearChunkId) {
    currentChunkId = null;
    currentAttemptId = null;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "PLAY_CHUNK_FROM_IDB") {
      const record = await getAudioChunk(message.chunkId);
      if (!record) {
        throw new Error(`Missing audio chunk ${message.chunkId}`);
      }

      clearCurrentAudio({ clearChunkId: true, markInterrupted: true, reason: "replace_playback" });
      currentChunkId = message.chunkId;
      currentAttemptId = message.attemptId || `${message.chunkId}:attempt:unknown`;
      currentChapterId = record.chapterId || message.chapterId || DEFAULT_CHAPTER_ID;
      setPlaybackState({
        playing: false,
        paused: false,
        chunkId: message.chunkId,
        attemptId: currentAttemptId,
        ended: false,
        error: null
      });
      currentUrl = URL.createObjectURL(record.audioBlob);
      currentAudio = new Audio(currentUrl);
      currentAudio.onended = () => {
        setPlaybackState({
          playing: false,
          paused: false,
          chunkId: message.chunkId,
          attemptId: currentAttemptId,
          ended: true,
          error: null
        });
        clearCurrentAudio();
        chrome.runtime.sendMessage({
          type: "CHUNK_PLAYBACK_ENDED",
          chapterId: currentChapterId,
          chunkId: message.chunkId,
          attemptId: currentAttemptId
        });
      };
      currentAudio.onerror = () => {
        const errorMessage = getAudioErrorDetails(currentAudio);
        setPlaybackState({
          playing: false,
          paused: false,
          chunkId: message.chunkId,
          attemptId: currentAttemptId,
          ended: false,
          error: errorMessage
        });
        clearCurrentAudio({ clearChunkId: true });
        chrome.runtime.sendMessage({
          type: "CHUNK_PLAYBACK_ERROR",
          chapterId: currentChapterId,
          chunkId: message.chunkId,
          attemptId: message.attemptId || null,
          error: errorMessage
        });
      };
      console.log(`[offscreen] audio_play_requested chunk=${message.chunkId} attempt=${currentAttemptId}`);
      await currentAudio.play();
      if (interruptedAttemptIds.has(currentAttemptId)) {
        interruptedAttemptIds.delete(currentAttemptId);
      }
      setPlaybackState({
        playing: true,
        paused: false,
        chunkId: message.chunkId,
        attemptId: currentAttemptId,
        ended: false,
        error: null
      });
      console.log(`[offscreen] audio_play_resolved chunk=${message.chunkId} attempt=${currentAttemptId}`);
      chrome.runtime.sendMessage({
        type: "CHUNK_PLAYBACK_STARTED",
        chapterId: currentChapterId,
        chunkId: message.chunkId,
        attemptId: currentAttemptId
      });
      sendResponse({ ok: true, chunkId: message.chunkId, playback: playbackState });
      return;
    }

    if (message?.type === "PAUSE_PLAYBACK") {
      if (currentAudio) {
        console.log(`[offscreen] audio_pause_requested chunk=${currentChunkId || "-"} attempt=${currentAttemptId || "-"}`);
        currentAudio.pause();
        setPlaybackState({
          playing: false,
          paused: true,
          chunkId: currentChunkId,
          attemptId: currentAttemptId,
          ended: false,
          error: null
        });
      }
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "STOP_PLAYBACK") {
      clearCurrentAudio({ clearChunkId: true, markInterrupted: true, reason: "stop_playback" });
      setPlaybackState({
        playing: false,
        paused: false,
        chunkId: null,
        attemptId: null,
        ended: false,
        error: null
      });
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "RESUME_PLAYBACK") {
      if (currentAudio) {
        await currentAudio.play();
        setPlaybackState({
          playing: true,
          paused: false,
          chunkId: currentChunkId,
          attemptId: currentAttemptId,
          ended: false,
          error: null
        });
        sendResponse({ ok: true, resumed: true, chunkId: currentChunkId, playback: playbackState });
        return;
      }
      sendResponse({ ok: true, resumed: false, chunkId: null, playback: playbackState });
      return;
    }

    if (message?.type === "GET_PLAYBACK_STATUS") {
      sendResponse(playbackState);
      return;
    }
  })().catch((error) => {
    const attemptId = currentAttemptId;
    const interrupted = String(error).includes("AbortError") && attemptId && interruptedAttemptIds.has(attemptId);
    if (attemptId) {
      interruptedAttemptIds.delete(attemptId);
    }
    setPlaybackState({
      playing: false,
      paused: false,
      chunkId: currentChunkId,
      attemptId,
      ended: false,
      error: String(error)
    });
    chrome.runtime.sendMessage({
      type: interrupted ? "CHUNK_PLAYBACK_INTERRUPTED" : "CHUNK_PLAYBACK_ERROR",
      chapterId: currentChapterId || DEFAULT_CHAPTER_ID,
      chunkId: currentChunkId,
      attemptId,
      error: String(error)
    });
    console.log(
      `[offscreen] audio_play_rejected chunk=${currentChunkId || "-"} attempt=${attemptId || "-"} interrupted=${interrupted} error=${String(error)}`
    );
    sendResponse({ ok: false, error: String(error) });
  });

  return true;
});
