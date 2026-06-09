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
