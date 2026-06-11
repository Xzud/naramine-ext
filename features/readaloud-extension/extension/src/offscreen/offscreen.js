import { DEFAULT_CHAPTER_ID, STREAM_READY_BUFFER_MS } from "../shared/constants.js";
import { getAudioChunk } from "../db/idb.js";
import { LocalKokoroProvider } from "../tts/LocalKokoroProvider.js";
import { ModalKokoroProvider } from "../tts/ModalKokoroProvider.js";
import { WavStreamPlayer } from "./wavStreamPlayer.js";

let activeChunkId = null;
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

const streamSlots = new Map();

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

function emitRuntimeMessage(type, extra = {}, { chunkId = activeChunkId, attemptId = currentAttemptId } = {}) {
  try {
    const result = chrome.runtime.sendMessage({
      type,
      chapterId: currentChapterId,
      chunkId,
      attemptId,
      ...extra
    });
    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch (_error) {
    // The service worker may be restarting; events are re-derived from status polls.
  }
}

function syncActivePlayback(slot, status, overrides = {}) {
  if (!slot) {
    return;
  }

  activeChunkId = slot.chunkId;
  currentAttemptId = slot.attemptId;
  currentChapterId = slot.chapterId || DEFAULT_CHAPTER_ID;

  const streamStatus = status?.streamStatus || "idle";
  const paused = Boolean(status?.paused);
  const playing = !paused && ["playing", "receiving"].includes(streamStatus);

  setPlaybackState({
    playing,
    paused,
    chunkId: slot.chunkId,
    attemptId: slot.attemptId,
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

function createSlotSnapshot(slot) {
  const status = slot.player?.getStatus?.() || {};
  return {
    chunkId: slot.chunkId,
    attemptId: slot.attemptId,
    chapterId: slot.chapterId,
    role: slot.role,
    ...status
  };
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

async function loadCachedAudio(chunkId) {
  try {
    const record = await getAudioChunk(chunkId);
    return record?.blob ? record : null;
  } catch (_error) {
    return null;
  }
}

function releaseSlotResources(slot) {
  if (slot?.objectUrl) {
    URL.revokeObjectURL(slot.objectUrl);
    slot.objectUrl = null;
  }
}

// Warm chunks play from the IndexedDB cache through the same streaming code
// path (a blob object URL streams via fetch); only uncached chunks hit the
// TTS endpoint live.
async function resolveStreamRequest(message, slot, cachedAudio = null) {
  const cached = cachedAudio || (await loadCachedAudio(message.chunkId));
  if (cached?.blob) {
    slot.objectUrl = URL.createObjectURL(cached.blob);
    return { url: slot.objectUrl, method: "GET", headers: {} };
  }
  return buildRequest(message);
}

function createSlotCallbacks(slot) {
  return {
    onConnected: () => {
      if (slot.role !== "active") {
        return;
      }
      syncActivePlayback(slot, slot.player.getStatus(), { streamStatus: "connecting" });
      emitRuntimeMessage("STREAM_PLAYBACK_PROGRESS", {
        streamStatus: playbackState.streamStatus,
        bytesReceived: playbackState.bytesReceived,
        bufferedAudioMs: playbackState.bufferedAudioMs,
        firstByteAt: playbackState.firstByteAt,
        firstAudioAt: playbackState.firstAudioAt
      });
    },
    onFirstByte: () => {
      if (slot.role !== "active") {
        return;
      }
      syncActivePlayback(slot, slot.player.getStatus());
      emitRuntimeMessage("STREAM_PLAYBACK_PROGRESS", {
        streamStatus: playbackState.streamStatus,
        bytesReceived: playbackState.bytesReceived,
        bufferedAudioMs: playbackState.bufferedAudioMs,
        firstByteAt: playbackState.firstByteAt,
        firstAudioAt: playbackState.firstAudioAt
      });
    },
    onReady: (status) => {
      if (slot.role === "active") {
        syncActivePlayback(slot, status, { streamStatus: status?.streamStatus || "receiving" });
        emitRuntimeMessage("STREAM_PLAYBACK_PROGRESS", {
          streamStatus: playbackState.streamStatus,
          bytesReceived: playbackState.bytesReceived,
          bufferedAudioMs: playbackState.bufferedAudioMs,
          firstByteAt: playbackState.firstByteAt,
          firstAudioAt: playbackState.firstAudioAt
        });
        return;
      }

      emitRuntimeMessage(
        "STREAM_PREPARE_READY",
        {
          streamStatus: status?.streamStatus || "prepared",
          bytesReceived: status?.bytesReceived || 0,
          bufferedAudioMs: status?.bufferedAudioMs || 0,
          firstByteAt: status?.firstByteAt || null,
          firstAudioAt: status?.firstAudioAt || null
        },
        { chunkId: slot.chunkId, attemptId: slot.attemptId }
      );
    },
    onStarted: (status) => {
      if (slot.role !== "active") {
        return;
      }

      syncActivePlayback(slot, status, { streamStatus: "playing" });
      emitRuntimeMessage("CHUNK_PLAYBACK_STARTED", {
        bytesReceived: playbackState.bytesReceived,
        bufferedAudioMs: playbackState.bufferedAudioMs,
        firstByteAt: playbackState.firstByteAt,
        firstAudioAt: playbackState.firstAudioAt
      });
    },
    onProgress: (status) => {
      if (slot.role !== "active") {
        return;
      }
      syncActivePlayback(slot, status);
      emitRuntimeMessage("STREAM_PLAYBACK_PROGRESS", {
        streamStatus: playbackState.streamStatus,
        bytesReceived: playbackState.bytesReceived,
        bufferedAudioMs: playbackState.bufferedAudioMs,
        firstByteAt: playbackState.firstByteAt,
        firstAudioAt: playbackState.firstAudioAt
      });
    },
    onEnded: async (status) => {
      streamSlots.delete(slot.chunkId);
      releaseSlotResources(slot);

      if (slot.role !== "active") {
        emitRuntimeMessage(
          "STREAM_PREPARE_ENDED",
          {
            streamStatus: status?.streamStatus || "ended",
            bytesReceived: status?.bytesReceived || 0,
            bufferedAudioMs: status?.bufferedAudioMs || 0
          },
          { chunkId: slot.chunkId, attemptId: slot.attemptId }
        );
        return;
      }

      syncActivePlayback(slot, status, { ended: true, streamStatus: "ended" });
      emitRuntimeMessage("CHUNK_PLAYBACK_ENDED");
      activeChunkId = null;
      currentAttemptId = null;
      setPlaybackState({
        playing: false,
        paused: false,
        chunkId: null,
        attemptId: null,
        ended: true,
        error: null,
        streamStatus: "ended",
        bufferedSegmentCount: 0,
        bytesReceived: 0,
        bufferedAudioMs: 0,
        firstByteAt: null,
        firstAudioAt: null
      });
    },
    onError: async (error) => {
      streamSlots.delete(slot.chunkId);
      releaseSlotResources(slot);

      if (slot.role !== "active") {
        emitRuntimeMessage(
          "STREAM_PREPARE_ERROR",
          { error: String(error) },
          { chunkId: slot.chunkId, attemptId: slot.attemptId }
        );
        return;
      }

      syncActivePlayback(slot, slot.player?.getStatus?.() || null, {
        playing: false,
        paused: false,
        ended: false,
        error: String(error),
        streamStatus: "error"
      });
      emitRuntimeMessage("CHUNK_PLAYBACK_ERROR", {
        error: String(error)
      });
      activeChunkId = null;
      currentAttemptId = null;
    }
  };
}

async function stopSlot(slot) {
  if (!slot) {
    return;
  }

  await slot.player.stop();
  releaseSlotResources(slot);
  streamSlots.delete(slot.chunkId);
}

async function stopAllSlots() {
  const slots = [...streamSlots.values()];
  streamSlots.clear();
  activeChunkId = null;
  currentAttemptId = null;
  setPlaybackState({
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
    firstAudioAt: null
  });

  for (const slot of slots) {
    await slot.player.stop().catch(() => {});
    releaseSlotResources(slot);
  }
}

async function clearActiveSlot() {
  const slot = activeChunkId ? streamSlots.get(activeChunkId) : null;
  if (!slot) {
    return;
  }

  if (slot.role !== "active") {
    return;
  }

  await stopSlot(slot);
  activeChunkId = null;
  currentAttemptId = null;
  setPlaybackState({
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
    firstAudioAt: null
  });
}

function createSlot(message, role, cachedAudio = null) {
  const slot = {
    chunkId: message.chunkId,
    attemptId: message.attemptId || `${message.chunkId}:attempt:unknown`,
    chapterId: message.chapterId || DEFAULT_CHAPTER_ID,
    role,
    player: null,
    objectUrl: null
  };
  const callbacks = createSlotCallbacks(slot);
  const player = new WavStreamPlayer(callbacks, {
    autoStart: role === "active",
    startBufferMs: role === "prepared" ? STREAM_READY_BUFFER_MS : undefined
  });
  slot.player = player;
  streamSlots.set(slot.chunkId, slot);
  // Connect without blocking the message response: the queue holds its
  // session lock while dispatching, so awaiting TTS headers here would delay
  // pause/stop commands. Connect failures flow through the per-slot error
  // path instead of rejecting the handler (which would stop all playback).
  (async () => {
    const request = await resolveStreamRequest(message, slot, cachedAudio);
    await player.open(request);
  })().catch((error) => {
    if (!player.closed) {
      void callbacks.onError(error);
    }
  });
  return slot;
}

async function prepareStream(message) {
  const existing = streamSlots.get(message.chunkId);
  if (existing) {
    return {
      ok: true,
      chunkId: existing.chunkId,
      role: existing.role,
      playback: playbackState
    };
  }

  // Prepared slots only load from the warm cache. Streaming lookahead from
  // the TTS endpoint here would duplicate the warming pipeline's synthesis
  // of the same chunk; on a cache miss the chunk simply starts as a live
  // stream (or from cache) when playback reaches it.
  const cachedAudio = await loadCachedAudio(message.chunkId);
  if (!cachedAudio) {
    return {
      ok: false,
      error: "not_cached",
      chunkId: message.chunkId,
      playback: playbackState
    };
  }

  createSlot(message, "prepared", cachedAudio);
  return {
    ok: true,
    chunkId: message.chunkId,
    role: "prepared",
    playback: playbackState
  };
}

async function promotePreparedStream(message) {
  const slot = streamSlots.get(message.chunkId);
  if (!slot) {
    return {
      ok: false,
      error: `No prepared stream found for ${message.chunkId}`
    };
  }

  slot.role = "active";
  slot.attemptId = message.attemptId || slot.attemptId;
  activeChunkId = slot.chunkId;
  currentAttemptId = slot.attemptId;
  currentChapterId = message.chapterId || slot.chapterId || DEFAULT_CHAPTER_ID;
  slot.player.setAutoStart(true);
  syncActivePlayback(slot, slot.player.getStatus(), {
    streamStatus: slot.player.getStatus().streamStatus || "receiving"
  });
  emitRuntimeMessage("STREAM_PLAYBACK_PROGRESS", {
    streamStatus: playbackState.streamStatus,
    bytesReceived: playbackState.bytesReceived,
    bufferedAudioMs: playbackState.bufferedAudioMs,
    firstByteAt: playbackState.firstByteAt,
    firstAudioAt: playbackState.firstAudioAt
  });
  return {
    ok: true,
    chunkId: slot.chunkId,
    role: "active",
    playback: playbackState
  };
}

async function startLiveStream(message) {
  const existing = streamSlots.get(message.chunkId);
  if (existing?.role === "prepared") {
    return promotePreparedStream(message);
  }

  if (existing?.role === "active") {
    syncActivePlayback(existing, existing.player.getStatus());
    return {
      ok: true,
      chunkId: existing.chunkId,
      role: "active",
      playback: playbackState
    };
  }

  if (activeChunkId && activeChunkId !== message.chunkId) {
    await clearActiveSlot();
  }

  const slot = createSlot(message, "active");
  activeChunkId = slot.chunkId;
  currentAttemptId = slot.attemptId;
  currentChapterId = slot.chapterId;
  setPlaybackState({
    chunkId: slot.chunkId,
    attemptId: slot.attemptId,
    streamStatus: "connecting"
  });
  return {
    ok: true,
    chunkId: slot.chunkId,
    role: "active",
    playback: playbackState
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "START_STREAM_PLAYBACK") {
      const response = await startLiveStream(message);
      sendResponse(response);
      return;
    }

    if (message?.type === "PREPARE_STREAM_PLAYBACK") {
      const response = await prepareStream(message);
      sendResponse(response);
      return;
    }

    if (message?.type === "START_PREPARED_STREAM") {
      const response = await promotePreparedStream(message);
      sendResponse(response);
      return;
    }

    if (message?.type === "PAUSE_PLAYBACK") {
      const slot = activeChunkId ? streamSlots.get(activeChunkId) : null;
      if (slot?.player) {
        await slot.player.pause();
        syncActivePlayback(slot, slot.player.getStatus());
      }
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "STOP_PLAYBACK") {
      await stopAllSlots();
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "RESUME_PLAYBACK") {
      const slot = activeChunkId ? streamSlots.get(activeChunkId) : null;
      if (slot?.player) {
        const resumed = await slot.player.resume();
        syncActivePlayback(slot, slot.player.getStatus());
        sendResponse({ ok: true, resumed, chunkId: activeChunkId, playback: playbackState });
        return;
      }
      sendResponse({ ok: true, resumed: false, chunkId: null, playback: playbackState });
      return;
    }

    if (message?.type === "GET_PLAYBACK_STATUS") {
      const slot = activeChunkId ? streamSlots.get(activeChunkId) : null;
      if (slot?.player) {
        syncActivePlayback(slot, slot.player.getStatus());
      }
      sendResponse({
        ...playbackState,
        activeChunkId,
        attemptId: currentAttemptId,
        slots: [...streamSlots.values()].map(createSlotSnapshot)
      });
    }
  })().catch(async (error) => {
    setPlaybackState({
      playing: false,
      paused: false,
      error: String(error),
      streamStatus: "error"
    });
    emitRuntimeMessage("CHUNK_PLAYBACK_ERROR", { error: String(error) });
    await stopAllSlots();
    sendResponse({ ok: false, error: String(error) });
  });

  return true;
});
