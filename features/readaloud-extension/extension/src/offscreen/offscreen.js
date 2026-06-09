import { DEFAULT_CHAPTER_ID } from "../shared/constants.js";
import { LocalKokoroProvider } from "../tts/LocalKokoroProvider.js";
import { ModalKokoroProvider } from "../tts/ModalKokoroProvider.js";
import { WavStreamPlayer } from "./wavStreamPlayer.js";

let currentPlayer = null;
let currentChunkId = null;
let currentAttemptId = null;
let currentChapterId = DEFAULT_CHAPTER_ID;
let playbackState = {
  playing: false,
  paused: false,
  chunkId: null,
  attemptId: null,
  ended: false,
  error: null,
  streamStatus: "idle",
  bufferedSegmentCount: 0,
  bytesReceived: 0,
  bufferedAudioMs: 0,
  firstByteAt: null,
  firstAudioAt: null,
  transportMode: "live_stream"
};

function getProvider(providerMode = "local") {
  if (providerMode === "modal" || providerMode === "proxy-local") {
    return new ModalKokoroProvider("http://localhost:3000");
  }

  return new LocalKokoroProvider("http://localhost:3000");
}

function setPlaybackState(overrides = {}) {
  playbackState = {
    ...playbackState,
    ...overrides,
    transportMode: "live_stream"
  };
}

function emitRuntimeMessage(type, extra = {}) {
  chrome.runtime.sendMessage({
    type,
    chapterId: currentChapterId,
    chunkId: currentChunkId,
    attemptId: currentAttemptId,
    ...extra
  });
}

function syncFromPlayer(status, overrides = {}) {
  const streamStatus = status?.streamStatus || "idle";
  const paused = Boolean(status?.paused);
  const playing = !paused && ["playing", "receiving"].includes(streamStatus);

  setPlaybackState({
    playing,
    paused,
    chunkId: currentChunkId,
    attemptId: currentAttemptId,
    ended: streamStatus === "ended",
    error: null,
    streamStatus,
    bufferedSegmentCount: 0,
    bytesReceived: status?.bytesReceived || 0,
    bufferedAudioMs: status?.bufferedAudioMs || 0,
    firstByteAt: status?.firstByteAt || null,
    firstAudioAt: status?.firstAudioAt || null,
    ...overrides
  });
}

async function clearCurrentPlayer({ clearChunkId = false } = {}) {
  const player = currentPlayer;
  currentPlayer = null;
  if (player) {
    await player.stop();
  }

  setPlaybackState({
    playing: false,
    paused: false,
    chunkId: clearChunkId ? null : currentChunkId,
    attemptId: clearChunkId ? null : currentAttemptId,
    ended: false,
    error: null,
    streamStatus: "idle",
    bufferedSegmentCount: 0,
    bytesReceived: 0,
    bufferedAudioMs: 0,
    firstByteAt: null,
    firstAudioAt: null
  });

  if (clearChunkId) {
    currentChunkId = null;
    currentAttemptId = null;
  }
}

function buildRequest(message) {
  if (message.request) {
    return message.request;
  }

  const provider = getProvider(message.providerMode || "local");
  return provider.createStreamRequest({
    text: message.text,
    voice: message.voice,
    format: "wav",
    chunkId: message.chunkId,
    chapterId: message.chapterId || DEFAULT_CHAPTER_ID
  });
}

async function startLiveStream(message) {
  await clearCurrentPlayer({ clearChunkId: true });
  currentChunkId = message.chunkId;
  currentAttemptId = message.attemptId || `${message.chunkId}:attempt:unknown`;
  currentChapterId = message.chapterId || DEFAULT_CHAPTER_ID;

  setPlaybackState({
    chunkId: currentChunkId,
    attemptId: currentAttemptId,
    streamStatus: "connecting"
  });

  const player = new WavStreamPlayer({
    onConnected: () => {
      syncFromPlayer(player.getStatus(), { streamStatus: "connecting" });
      emitRuntimeMessage("STREAM_PLAYBACK_PROGRESS", playbackState);
    },
    onFirstByte: () => {
      syncFromPlayer(player.getStatus());
      emitRuntimeMessage("STREAM_PLAYBACK_PROGRESS", playbackState);
    },
    onStarted: (status) => {
      syncFromPlayer(status, { streamStatus: "playing" });
      emitRuntimeMessage("CHUNK_PLAYBACK_STARTED", {
        bytesReceived: playbackState.bytesReceived,
        bufferedAudioMs: playbackState.bufferedAudioMs,
        firstByteAt: playbackState.firstByteAt,
        firstAudioAt: playbackState.firstAudioAt
      });
    },
    onProgress: (status) => {
      syncFromPlayer(status);
      emitRuntimeMessage("STREAM_PLAYBACK_PROGRESS", {
        streamStatus: playbackState.streamStatus,
        bytesReceived: playbackState.bytesReceived,
        bufferedAudioMs: playbackState.bufferedAudioMs,
        firstByteAt: playbackState.firstByteAt,
        firstAudioAt: playbackState.firstAudioAt
      });
    },
    onEnded: async (status) => {
      syncFromPlayer(status, { ended: true, streamStatus: "ended" });
      emitRuntimeMessage("CHUNK_PLAYBACK_ENDED");
      await clearCurrentPlayer({ clearChunkId: true });
    },
    onError: async (error) => {
      syncFromPlayer(currentPlayer?.getStatus?.() || null, {
        playing: false,
        paused: false,
        ended: false,
        error: String(error),
        streamStatus: "error"
      });
      emitRuntimeMessage("CHUNK_PLAYBACK_ERROR", {
        error: String(error)
      });
      await clearCurrentPlayer({ clearChunkId: true });
    }
  });

  currentPlayer = player;
  await player.open(buildRequest(message));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "START_STREAM_PLAYBACK") {
      sendResponse({ ok: true, chunkId: message.chunkId, playback: playbackState });
      void startLiveStream(message).catch(async (error) => {
        setPlaybackState({
          playing: false,
          paused: false,
          error: String(error),
          streamStatus: "error"
        });
        emitRuntimeMessage("CHUNK_PLAYBACK_ERROR", { error: String(error) });
        await clearCurrentPlayer({ clearChunkId: true });
      });
      return;
    }

    if (message?.type === "PAUSE_PLAYBACK") {
      if (currentPlayer) {
        await currentPlayer.pause();
        syncFromPlayer(currentPlayer.getStatus());
      }
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "STOP_PLAYBACK") {
      await clearCurrentPlayer({ clearChunkId: true });
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "RESUME_PLAYBACK") {
      if (currentPlayer) {
        const resumed = await currentPlayer.resume();
        syncFromPlayer(currentPlayer.getStatus());
        sendResponse({ ok: true, resumed, chunkId: currentChunkId, playback: playbackState });
        return;
      }
      sendResponse({ ok: true, resumed: false, chunkId: null, playback: playbackState });
      return;
    }

    if (message?.type === "GET_PLAYBACK_STATUS") {
      if (currentPlayer) {
        syncFromPlayer(currentPlayer.getStatus());
      }
      sendResponse(playbackState);
    }
  })().catch(async (error) => {
    setPlaybackState({
      playing: false,
      paused: false,
      error: String(error),
      streamStatus: "error"
    });
    emitRuntimeMessage("CHUNK_PLAYBACK_ERROR", { error: String(error) });
    await clearCurrentPlayer({ clearChunkId: true });
    sendResponse({ ok: false, error: String(error) });
  });

  return true;
});
