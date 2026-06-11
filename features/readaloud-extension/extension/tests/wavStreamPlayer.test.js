import test from "node:test";
import assert from "node:assert/strict";

import { parseWavHeader } from "../src/offscreen/wavStreamPlayer.js";

function buildWavHeader({
  channels = 1,
  sampleRate = 24000,
  bitsPerSample = 16,
  dataSize = 3200
} = {}) {
  const bytesPerSample = bitsPerSample / 8;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;
  const totalSize = 44 + dataSize;
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);

  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, totalSize - 8, true);
  view.setUint32(8, 0x57415645, false);
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, dataSize, true);

  return new Uint8Array(buffer);
}

test("parseWavHeader returns PCM stream details once the header is complete", () => {
  const header = parseWavHeader(buildWavHeader());

  assert.equal(header.channels, 1);
  assert.equal(header.sampleRate, 24000);
  assert.equal(header.bitsPerSample, 16);
  assert.equal(header.bytesPerFrame, 2);
  assert.equal(header.dataOffset, 44);
});

test("parseWavHeader waits for more bytes when the header is incomplete", () => {
  const incomplete = buildWavHeader().subarray(0, 20);
  assert.equal(parseWavHeader(incomplete), null);
});

test("parseWavHeader rejects non-WAV input", () => {
  assert.throws(() => parseWavHeader(new Uint8Array(44)), /RIFF\/WAVE/);
});

import { WavStreamPlayer } from "../src/offscreen/wavStreamPlayer.js";

class FakeAudioBuffer {
  constructor(channels, frameCount, sampleRate) {
    this.numberOfChannels = channels;
    this.length = frameCount;
    this.sampleRate = sampleRate;
    this.channelData = Array.from({ length: channels }, () => new Float32Array(frameCount));
  }

  getChannelData(channel) {
    return this.channelData[channel];
  }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = "running";
    this.destination = { connected: true };
    this.createdSources = [];
  }

  createGain() {
    return {
      connect() {},
      disconnect() {}
    };
  }

  createBuffer(channels, frameCount, sampleRate) {
    return new FakeAudioBuffer(channels, frameCount, sampleRate);
  }

  createBufferSource() {
    const source = {
      buffer: null,
      onended: null,
      startedAt: null,
      connect() {},
      disconnect() {},
      start(when) {
        source.startedAt = when;
      },
      stop() {}
    };
    this.createdSources.push(source);
    return source;
  }

  async resume() {
    this.state = "running";
  }

  async suspend() {
    this.state = "suspended";
  }

  async close() {
    this.state = "closed";
  }
}

function buildWavBytes({ sampleRate = 24000, frames = 6000 } = {}) {
  const header = buildWavHeader({ sampleRate, dataSize: frames * 2 });
  const bytes = new Uint8Array(44 + frames * 2);
  bytes.set(header, 0);
  const view = new DataView(bytes.buffer);
  for (let frame = 0; frame < frames; frame += 1) {
    view.setInt16(44 + frame * 2, 16384, true);
  }
  return bytes;
}

function stubFetchWithChunks(chunks) {
  const pending = [...chunks];
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => "audio/wav" },
    body: {
      getReader: () => ({
        async read() {
          if (pending.length === 0) {
            return { value: undefined, done: true };
          }
          return { value: pending.shift(), done: false };
        },
        releaseLock() {}
      })
    }
  });
}

test("WavStreamPlayer schedules decoded PCM gaplessly on a shared context and ends after drain", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalAudioContext = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;

  const events = [];
  const player = new WavStreamPlayer({
    onStarted: () => events.push("started"),
    onEnded: () => events.push("ended"),
    onError: (error) => events.push(`error:${error}`)
  });
  t.after(async () => {
    await player.stop();
    globalThis.fetch = originalFetch;
    globalThis.AudioContext = originalAudioContext;
  });

  const wavBytes = buildWavBytes({ frames: 6000 });
  stubFetchWithChunks([wavBytes.subarray(0, 4044), wavBytes.subarray(4044)]);

  await player.open({ url: "http://localhost/tts", method: "POST", body: "{}" });
  await player.readerPromise;

  assert.equal(events.includes("started"), true);
  assert.equal(player.playbackStarted, true);

  const context = player.audioContext;
  assert.ok(context instanceof FakeAudioContext);

  const scheduledFrames = context.createdSources.reduce((total, source) => total + source.buffer.length, 0);
  assert.equal(scheduledFrames, 6000);
  assert.ok(Math.abs(context.createdSources[0].buffer.getChannelData(0)[0] - 0.5) < 1e-6);

  for (let index = 1; index < context.createdSources.length; index += 1) {
    const previous = context.createdSources[index - 1];
    const expectedStart = previous.startedAt + previous.buffer.length / previous.buffer.sampleRate;
    assert.ok(Math.abs(context.createdSources[index].startedAt - expectedStart) < 1e-6);
  }

  for (const source of [...context.createdSources]) {
    source.onended?.();
  }
  assert.equal(events.includes("ended"), true);
  assert.notEqual(context.state, "closed");
});

test("WavStreamPlayer pause suspends and resume restarts without restarting the stream", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalAudioContext = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;

  const player = new WavStreamPlayer({});
  t.after(async () => {
    await player.stop();
    globalThis.fetch = originalFetch;
    globalThis.AudioContext = originalAudioContext;
  });

  const wavBytes = buildWavBytes({ frames: 6000 });
  stubFetchWithChunks([wavBytes]);

  await player.open({ url: "http://localhost/tts", method: "POST", body: "{}" });
  await player.readerPromise;
  assert.equal(player.playbackStarted, true);

  await player.pause();
  assert.equal(player.getStatus().paused, true);
  assert.equal(player.getStatus().streamStatus, "paused");
  assert.equal(player.audioContext.state, "suspended");

  const resumed = await player.resume();
  assert.equal(resumed, true);
  assert.equal(player.getStatus().paused, false);
  assert.equal(player.getStatus().streamStatus, "playing");
  assert.equal(player.audioContext.state, "running");
});

test("WavStreamPlayer starts and finishes streams shorter than the start buffer", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalAudioContext = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;

  const events = [];
  const player = new WavStreamPlayer({
    onStarted: () => events.push("started"),
    onEnded: () => events.push("ended")
  });
  t.after(async () => {
    await player.stop();
    globalThis.fetch = originalFetch;
    globalThis.AudioContext = originalAudioContext;
  });

  // 50ms of audio: below the 180ms start buffer, so playback must still
  // start once the stream ends instead of waiting forever.
  const wavBytes = buildWavBytes({ frames: 1200 });
  stubFetchWithChunks([wavBytes]);

  await player.open({ url: "http://localhost/tts", method: "POST", body: "{}" });
  await player.readerPromise;

  assert.equal(events.includes("started"), true);
  for (const source of [...player.audioContext?.createdSources ?? []]) {
    source.onended?.();
  }
  assert.equal(events.includes("ended"), true);
});
