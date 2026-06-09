const SCRIPT_BUFFER_SIZE = 4096;
const DEFAULT_START_BUFFER_MS = 180;
const PROGRESS_EVENT_INTERVAL_MS = 250;

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
}

export class WavStreamPlayer {
  constructor(callbacks = {}, options = {}) {
    this.callbacks = callbacks;
    this.autoStart = options.autoStart ?? true;
    this.startBufferMs = options.startBufferMs ?? DEFAULT_START_BUFFER_MS;
    this.audioContext = null;
    this.processor = null;
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
    this.paused = true;
    this.streamStatus = "paused";
    if (this.audioContext) {
      await this.audioContext.suspend();
    }
    this.emitProgress(true);
  }

  async resume() {
    this.paused = false;
    if (this.audioContext) {
      await this.audioContext.resume();
    }
    if (this.playbackStarted) {
      this.streamStatus = "playing";
    } else {
      this.streamStatus = "receiving";
      this.maybeStartPlayback();
    }
    this.emitProgress(true);
    return this.playbackStarted;
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
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.audioContext) {
      await this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.pcmQueue.clear();
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
      ready: this.readyNotified || this.getBufferedAudioMs() >= this.startBufferMs
    };
  }

  async consumeStream(reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          this.streamEnded = true;
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
      const dataBytes = headerBytes.subarray(parsedHeader.dataOffset);
      this.headerChunks = [];
      this.headerLength = 0;
      this.ensureAudioContext();
      if (dataBytes.length > 0) {
        this.pcmQueue.append(dataBytes);
      }
      this.maybeNotifyReady();
      return;
    }

    this.pcmQueue.append(chunk);
    this.maybeNotifyReady();
  }

  ensureAudioContext() {
    if (this.audioContext || !this.header) {
      return;
    }

    const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error("AudioContext is not available in the offscreen document");
    }

    this.audioContext = new AudioContextCtor({
      sampleRate: this.header.sampleRate
    });
    this.processor = this.audioContext.createScriptProcessor(
      SCRIPT_BUFFER_SIZE,
      0,
      this.header.channels
    );
    this.processor.onaudioprocess = (event) => {
      this.handleAudioProcess(event);
    };
  }

  maybeStartPlayback() {
    if (
      this.playbackStarted ||
      this.paused ||
      !this.autoStart ||
      !this.header ||
      !this.audioContext ||
      !this.processor
    ) {
      return;
    }

    const minStartBytes = Math.ceil(
      (this.header.sampleRate * this.header.bytesPerFrame * this.startBufferMs) / 1000
    );

    if (this.pcmQueue.length < minStartBytes) {
      this.maybeNotifyReady(minStartBytes);
      return;
    }

    this.processor.connect(this.audioContext.destination);
    this.audioContext.resume().catch(() => {});
    this.playbackStarted = true;
    this.streamStatus = "playing";
    this.firstAudioAt = Date.now();
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

    if (this.pcmQueue.length < thresholdBytes) {
      return;
    }

    this.readyNotified = true;
    if (!this.autoStart) {
      this.streamStatus = "prepared";
    }
    this.callbacks.onReady?.(this.getStatus());
  }

  handleAudioProcess(event) {
    if (!this.header) {
      return;
    }

    const output = event.outputBuffer;
    const frameCount = output.length;
    const bytesNeeded = frameCount * this.header.bytesPerFrame;
    const pcmBytes = this.pcmQueue.readAligned(bytesNeeded, this.header.bytesPerFrame);
    const framesRead = Math.floor(pcmBytes.length / this.header.bytesPerFrame);

    for (let channel = 0; channel < output.numberOfChannels; channel += 1) {
      const channelData = output.getChannelData(channel);
      channelData.fill(0);
    }

    if (framesRead > 0) {
      this.decodeFramesIntoOutput(pcmBytes, framesRead, output);
      if (this.stalled) {
        this.stalled = false;
        this.streamStatus = this.paused ? "paused" : "playing";
      }
    } else if (!this.streamEnded) {
      this.stalled = true;
      this.streamStatus = "buffering";
    }

    this.emitProgress();
    this.finishIfDrained();
  }

  decodeFramesIntoOutput(pcmBytes, framesRead, output) {
    if (!this.header) {
      return;
    }

    const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
    const { audioFormat, channels, bitsPerSample, bytesPerSample } = this.header;

    for (let frame = 0; frame < framesRead; frame += 1) {
      const frameOffset = frame * channels * bytesPerSample;
      for (let channel = 0; channel < channels; channel += 1) {
        const sampleOffset = frameOffset + channel * bytesPerSample;
        let sample = 0;

        if (audioFormat === 3 && bitsPerSample === 32) {
          sample = view.getFloat32(sampleOffset, true);
        } else if (bitsPerSample === 16) {
          sample = view.getInt16(sampleOffset, true) / 32768;
        } else if (bitsPerSample === 8) {
          sample = (view.getUint8(sampleOffset) - 128) / 128;
        } else if (bitsPerSample === 32) {
          sample = view.getInt32(sampleOffset, true) / 2147483648;
        } else {
          throw new Error(`Unsupported PCM depth: ${bitsPerSample}`);
        }

        output.getChannelData(channel)[frame] = sample;
      }
    }
  }

  getBufferedAudioMs() {
    if (!this.header?.bytesPerFrame || !this.header.sampleRate) {
      return 0;
    }

    const bufferedFrames = this.pcmQueue.length / this.header.bytesPerFrame;
    return Math.round((bufferedFrames / this.header.sampleRate) * 1000);
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
    if (!this.streamEnded || this.pcmQueue.length > 0 || !this.playbackStarted) {
      return;
    }

    this.streamStatus = "ended";
    this.callbacks.onEnded?.(this.getStatus());
    void this.stop();
  }
}
