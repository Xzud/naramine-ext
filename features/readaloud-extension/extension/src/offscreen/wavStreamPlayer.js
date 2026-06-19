const DEFAULT_START_BUFFER_MS = 180;
const PROGRESS_EVENT_INTERVAL_MS = 500;
const MIN_SCHEDULE_BLOCK_MS = 40;
const SCHEDULE_EPSILON_S = 0.03;

// One AudioContext shared by every player. AudioBuffers carry their own sample
// rate, so chunks with different rates resample through the same context and
// chunk handoffs never pay context construction/teardown.
let sharedAudioContext = null;

function getSharedAudioContext() {
  if (!sharedAudioContext || sharedAudioContext.state === "closed") {
    const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error("AudioContext is not available in the offscreen document");
    }
    sharedAudioContext = new AudioContextCtor();
  }
  return sharedAudioContext;
}

function concatUint8Arrays(chunks, totalLength) {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function parseWavHeader(buffer) {
  if (!(buffer instanceof Uint8Array) || buffer.length < 12) {
    return null;
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
    throw new Error("Unsupported WAV stream: missing RIFF/WAVE header");
  }

  let offset = 12;
  let fmt = null;
  let dataOffset = null;
  let dataSize = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    const nextOffset = chunkDataOffset + chunkSize + (chunkSize % 2);

    if (chunkId === 0x666d7420) {
      if (nextOffset > buffer.length) {
        return null;
      }
      fmt = {
        audioFormat: view.getUint16(chunkDataOffset, true),
        channels: view.getUint16(chunkDataOffset + 2, true),
        sampleRate: view.getUint32(chunkDataOffset + 4, true),
        byteRate: view.getUint32(chunkDataOffset + 8, true),
        blockAlign: view.getUint16(chunkDataOffset + 12, true),
        bitsPerSample: view.getUint16(chunkDataOffset + 14, true)
      };
    } else if (chunkId === 0x64617461) {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
      break;
    } else if (nextOffset > buffer.length) {
      return null;
    }

    offset = nextOffset;
  }

  if (!fmt || dataOffset === null) {
    return null;
  }

  const bytesPerSample = fmt.bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0) {
    throw new Error(`Unsupported WAV stream: invalid bitsPerSample ${fmt.bitsPerSample}`);
  }

  if (![1, 3].includes(fmt.audioFormat)) {
    throw new Error(`Unsupported WAV stream: audioFormat ${fmt.audioFormat}`);
  }

  return {
    ...fmt,
    dataOffset,
    dataSize,
    bytesPerSample,
    bytesPerFrame: fmt.channels * bytesPerSample
  };
}

class ByteQueue {
  constructor() {
    this.chunks = [];
    this.offset = 0;
    this.length = 0;
  }

  append(chunk) {
    if (!(chunk instanceof Uint8Array) || chunk.length === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  clear() {
    this.chunks = [];
    this.offset = 0;
    this.length = 0;
  }

  readAligned(maxBytes, alignment) {
    if (this.length < alignment) {
      return new Uint8Array(0);
    }

    const targetLength = Math.min(this.length - (this.length % alignment), maxBytes - (maxBytes % alignment));
    if (targetLength <= 0) {
      return new Uint8Array(0);
    }

    const result = new Uint8Array(targetLength);
    let resultOffset = 0;

    while (resultOffset < targetLength && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      const available = chunk.length - this.offset;
      const take = Math.min(available, targetLength - resultOffset);
      result.set(chunk.subarray(this.offset, this.offset + take), resultOffset);
      resultOffset += take;
      this.offset += take;
      this.length -= take;
      if (this.offset >= chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }

    return result;
  }

  skipAligned(maxBytes, alignment) {
    if (this.length < alignment) {
      return 0;
    }

    const targetLength = Math.min(this.length - (this.length % alignment), maxBytes - (maxBytes % alignment));
    if (targetLength <= 0) {
      return 0;
    }

    let skipped = 0;
    while (skipped < targetLength && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      const available = chunk.length - this.offset;
      const take = Math.min(available, targetLength - skipped);
      skipped += take;
      this.offset += take;
      this.length -= take;
      if (this.offset >= chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }

    return skipped;
  }
}

export class WavStreamPlayer {
  constructor(callbacks = {}, options = {}) {
    this.callbacks = callbacks;
    this.autoStart = options.autoStart ?? true;
    this.startBufferMs = options.startBufferMs ?? DEFAULT_START_BUFFER_MS;
    this.startOffsetMs = Math.max(0, Math.round(options.startOffsetMs || 0));
    this.audioContext = null;
    this.gainNode = null;
    this.scheduledSources = new Set();
    this.scheduledUntil = 0;
    this.abortController = null;
    this.readerPromise = null;
    this.header = null;
    this.headerChunks = [];
    this.headerLength = 0;
    this.pcmQueue = new ByteQueue();
    this.playbackStarted = false;
    this.streamEnded = false;
    this.paused = false;
    this.stalled = false;
    this.readyNotified = false;
    this.bytesReceived = 0;
    this.firstByteAt = null;
    this.firstAudioAt = null;
    this.lastProgressAt = 0;
    this.streamStatus = "idle";
    this.closed = false;
    this.finished = false;
    this.progressTimer = null;
    this.skipBytesRemaining = 0;
    this.playbackTimelineStartTime = null;
    this.pauseContextTime = null;
    this.pausedAtPlayedAudioMs = null;
  }

  async open(request) {
    this.abortController = new AbortController();
    this.closed = false;
    this.streamStatus = "connecting";

    const response = await fetch(request.url, {
      method: request.method || "POST",
      headers: request.headers || {},
      body: request.body,
      signal: this.abortController.signal
    });

    if (!response.ok) {
      throw new Error(`Streaming request failed: ${response.status}`);
    }

    if (!response.body) {
      throw new Error("Streaming request returned no body");
    }

    this.streamStatus = "receiving";
    this.callbacks.onConnected?.({
      contentType: response.headers.get("content-type") || "audio/wav"
    });

    this.readerPromise = this.consumeStream(response.body.getReader());
    this.readerPromise.catch((error) => {
      if (!this.closed) {
        this.callbacks.onError?.(error);
      }
    });
  }

  async pause() {
    if (this.closed) {
      return;
    }
    this.pausedAtPlayedAudioMs = this.getPlayedAudioMs();
    this.pauseContextTime = this.audioContext?.currentTime ?? null;
    this.paused = true;
    this.streamStatus = "paused";
    if (this.audioContext && this.playbackStarted) {
      await this.audioContext.suspend().catch(() => {});
    }
    this.emitProgress(true);
  }

  async resume() {
    if (this.closed) {
      return false;
    }
    this.paused = false;
    if (this.audioContext) {
      await this.audioContext.resume().catch(() => {});
    }
    if (this.playbackStarted) {
      if (this.audioContext && this.pauseContextTime !== null && this.playbackTimelineStartTime !== null) {
        this.playbackTimelineStartTime += Math.max(0, this.audioContext.currentTime - this.pauseContextTime);
      }
      this.pauseContextTime = null;
      this.pausedAtPlayedAudioMs = null;
      this.streamStatus = "playing";
    } else {
      this.streamStatus = "receiving";
      this.maybeStartPlayback();
    }
    this.schedulePendingAudio();
    this.emitProgress(true);
    this.finishIfDrained();
    return true;
  }

  setAutoStart(autoStart) {
    this.autoStart = Boolean(autoStart);
    if (this.autoStart) {
      this.maybeStartPlayback();
    }
  }

  async stop() {
    this.closed = true;
    this.streamStatus = "stopped";
    this.stopProgressTimer();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    for (const source of this.scheduledSources) {
      source.onended = null;
      try {
        source.stop();
      } catch (_error) {
        // Source may not have started yet.
      }
      source.disconnect();
    }
    this.scheduledSources.clear();
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    // The AudioContext is shared across players; if this player paused it,
    // hand it back running so the next chunk starts without a resume dance.
    if (this.audioContext && this.paused) {
      await this.audioContext.resume().catch(() => {});
    }
    this.audioContext = null;
    this.pcmQueue.clear();
    this.headerChunks = [];
    this.headerLength = 0;
    this.skipBytesRemaining = 0;
    this.playbackTimelineStartTime = null;
    this.pauseContextTime = null;
    this.pausedAtPlayedAudioMs = null;
  }

  getStatus() {
    return {
      streamStatus: this.streamStatus,
      bytesReceived: this.bytesReceived,
      bufferedAudioMs: this.getBufferedAudioMs(),
      firstByteAt: this.firstByteAt,
      firstAudioAt: this.firstAudioAt,
      playbackStarted: this.playbackStarted,
      paused: this.paused,
      ready: this.readyNotified || this.getBufferedAudioMs() >= this.startBufferMs,
      playedAudioMs: this.getPlayedAudioMs()
    };
  }

  async consumeStream(reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          this.streamEnded = true;
          this.maybeNotifyReady();
          this.maybeStartPlayback();
          this.schedulePendingAudio();
          this.emitProgress(true);
          this.finishIfDrained();
          return;
        }

        if (!(value instanceof Uint8Array) || value.length === 0) {
          continue;
        }

        this.bytesReceived += value.length;
        if (!this.firstByteAt) {
          this.firstByteAt = Date.now();
          this.callbacks.onFirstByte?.({
            bytesReceived: this.bytesReceived
          });
        }

        this.appendBytes(value);
        this.maybeStartPlayback();
        this.schedulePendingAudio();
        this.emitProgress();
      }
    } catch (error) {
      if (this.closed) {
        return;
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  appendBytes(chunk) {
    if (!this.header) {
      this.headerChunks.push(chunk);
      this.headerLength += chunk.length;
      const headerBytes = concatUint8Arrays(this.headerChunks, this.headerLength);
      const parsedHeader = parseWavHeader(headerBytes);
      if (!parsedHeader) {
        return;
      }

      this.header = parsedHeader;
      this.skipBytesRemaining = Math.ceil(
        (this.header.sampleRate * this.header.bytesPerFrame * this.startOffsetMs) / 1000
      );
      const dataBytes = headerBytes.subarray(parsedHeader.dataOffset);
      this.headerChunks = [];
      this.headerLength = 0;
      if (dataBytes.length > 0) {
        this.pcmQueue.append(dataBytes);
      }
      this.trimLeadingOffset();
      this.maybeNotifyReady();
      return;
    }

    this.pcmQueue.append(chunk);
    this.trimLeadingOffset();
    this.maybeNotifyReady();
  }

  trimLeadingOffset() {
    if (!this.header?.bytesPerFrame || this.skipBytesRemaining <= 0) {
      return;
    }
    const skipped = this.pcmQueue.skipAligned(this.skipBytesRemaining, this.header.bytesPerFrame);
    this.skipBytesRemaining = Math.max(0, this.skipBytesRemaining - skipped);
  }

  maybeStartPlayback() {
    if (this.playbackStarted || this.paused || this.closed || !this.autoStart || !this.header) {
      return;
    }

    const minStartBytes = Math.ceil(
      (this.header.sampleRate * this.header.bytesPerFrame * this.startBufferMs) / 1000
    );

    if (this.pcmQueue.length < minStartBytes && !this.streamEnded) {
      this.maybeNotifyReady(minStartBytes);
      return;
    }

    this.audioContext = getSharedAudioContext();
    this.gainNode = this.audioContext.createGain();
    this.gainNode.connect(this.audioContext.destination);
    this.audioContext.resume().catch(() => {});
    this.playbackStarted = true;
    this.streamStatus = "playing";
    this.firstAudioAt = Date.now();
    this.scheduledUntil = this.audioContext.currentTime + SCHEDULE_EPSILON_S;
    this.playbackTimelineStartTime = this.scheduledUntil;
    this.schedulePendingAudio();
    this.startProgressTimer();
    this.callbacks.onStarted?.(this.getStatus());
    this.emitProgress(true);
  }

  maybeNotifyReady(minStartBytes = null) {
    if (this.readyNotified || !this.header || this.playbackStarted) {
      return;
    }

    const thresholdBytes =
      minStartBytes ??
      Math.ceil(
        (this.header.sampleRate * this.header.bytesPerFrame * this.startBufferMs) / 1000
      );

    if (this.pcmQueue.length < thresholdBytes && !this.streamEnded) {
      return;
    }

    this.readyNotified = true;
    if (!this.autoStart) {
      this.streamStatus = "prepared";
    }
    this.callbacks.onReady?.(this.getStatus());
  }

  schedulePendingAudio() {
    if (!this.playbackStarted || this.paused || this.closed || !this.header || !this.audioContext) {
      return;
    }

    const { bytesPerFrame, sampleRate, channels } = this.header;
    const minBytes = this.streamEnded
      ? bytesPerFrame
      : Math.ceil((sampleRate * bytesPerFrame * MIN_SCHEDULE_BLOCK_MS) / 1000);
    if (this.pcmQueue.length < minBytes) {
      return;
    }

    const pcmBytes = this.pcmQueue.readAligned(this.pcmQueue.length, bytesPerFrame);
    if (pcmBytes.length === 0) {
      return;
    }

    const frameCount = pcmBytes.length / bytesPerFrame;
    const audioBuffer = this.audioContext.createBuffer(channels, frameCount, sampleRate);
    this.decodeFramesIntoBuffer(pcmBytes, frameCount, audioBuffer);

    const now = this.audioContext.currentTime;
    if (this.scheduledUntil < now + 0.01) {
      this.scheduledUntil = now + SCHEDULE_EPSILON_S;
    }

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode);
    source.onended = () => {
      this.scheduledSources.delete(source);
      source.disconnect();
      this.updateStallState();
      this.emitProgress();
      this.finishIfDrained();
    };
    this.scheduledSources.add(source);
    source.start(this.scheduledUntil);
    this.scheduledUntil += frameCount / sampleRate;

    if (this.stalled) {
      this.stalled = false;
    }
    if (!this.paused) {
      this.streamStatus = "playing";
    }
  }

  decodeFramesIntoBuffer(pcmBytes, frameCount, audioBuffer) {
    const { audioFormat, channels, bitsPerSample } = this.header;
    const sampleCount = frameCount * channels;
    let samples = null;
    let scale = 1;

    if (audioFormat === 3 && bitsPerSample === 32) {
      samples = new Float32Array(pcmBytes.buffer, pcmBytes.byteOffset, sampleCount);
    } else if (bitsPerSample === 16) {
      samples = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, sampleCount);
      scale = 1 / 32768;
    } else if (bitsPerSample === 32) {
      samples = new Int32Array(pcmBytes.buffer, pcmBytes.byteOffset, sampleCount);
      scale = 1 / 2147483648;
    } else if (bitsPerSample === 8) {
      const channelData = [];
      for (let channel = 0; channel < channels; channel += 1) {
        channelData.push(audioBuffer.getChannelData(channel));
      }
      for (let frame = 0; frame < frameCount; frame += 1) {
        for (let channel = 0; channel < channels; channel += 1) {
          channelData[channel][frame] = (pcmBytes[frame * channels + channel] - 128) / 128;
        }
      }
      return;
    } else {
      throw new Error(`Unsupported PCM depth: ${bitsPerSample}`);
    }

    for (let channel = 0; channel < channels; channel += 1) {
      const channelData = audioBuffer.getChannelData(channel);
      for (let frame = 0; frame < frameCount; frame += 1) {
        channelData[frame] = samples[frame * channels + channel] * scale;
      }
    }
  }

  updateStallState() {
    if (!this.playbackStarted || this.paused || this.closed || this.streamEnded) {
      return;
    }

    if (this.scheduledSources.size === 0 && this.pcmQueue.length === 0) {
      this.stalled = true;
      this.streamStatus = "buffering";
    }
  }

  startProgressTimer() {
    if (this.progressTimer) {
      return;
    }
    this.progressTimer = setInterval(() => {
      if (this.closed) {
        this.stopProgressTimer();
        return;
      }
      this.updateStallState();
      this.emitProgress();
      this.finishIfDrained();
    }, PROGRESS_EVENT_INTERVAL_MS);
  }

  stopProgressTimer() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  getBufferedAudioMs() {
    if (!this.header?.bytesPerFrame || !this.header.sampleRate) {
      return 0;
    }

    const queuedFrames = this.pcmQueue.length / this.header.bytesPerFrame;
    let bufferedMs = (queuedFrames / this.header.sampleRate) * 1000;
    if (this.audioContext && this.playbackStarted) {
      bufferedMs += Math.max(0, (this.scheduledUntil - this.audioContext.currentTime) * 1000);
    }
    return Math.round(bufferedMs);
  }

  getPlayedAudioMs() {
    if (!this.playbackStarted || this.playbackTimelineStartTime === null) {
      return this.startOffsetMs;
    }

    if (this.paused && this.pausedAtPlayedAudioMs !== null) {
      return this.pausedAtPlayedAudioMs;
    }

    if (!this.audioContext) {
      return this.startOffsetMs;
    }

    const renderedUntil = Math.min(this.audioContext.currentTime, this.scheduledUntil);
    const playedMs = Math.max(0, Math.round((renderedUntil - this.playbackTimelineStartTime) * 1000));
    return this.startOffsetMs + playedMs;
  }

  emitProgress(force = false) {
    const now = Date.now();
    if (!force && now - this.lastProgressAt < PROGRESS_EVENT_INTERVAL_MS) {
      return;
    }
    this.lastProgressAt = now;
    this.callbacks.onProgress?.(this.getStatus());
  }

  finishIfDrained() {
    if (this.finished || this.closed || this.paused) {
      return;
    }
    if (!this.streamEnded || !this.playbackStarted) {
      return;
    }
    if (this.pcmQueue.length > 0 || this.scheduledSources.size > 0) {
      return;
    }

    this.finished = true;
    this.streamStatus = "ended";
    this.stopProgressTimer();
    this.callbacks.onEnded?.(this.getStatus());
    void this.stop();
  }
}
