import test from "node:test";
import assert from "node:assert/strict";

import {
  findVoiceOption,
  loadUserSettings,
  normalizeUserSettings,
  saveUserSettings,
  USER_SETTINGS_KEY
} from "../src/shared/userSettings.js";

class MemoryStorageArea {
  constructor(initial = {}) {
    this.values = { ...initial };
  }

  async get(key) {
    return { [key]: this.values[key] };
  }

  async set(entries) {
    Object.assign(this.values, entries);
  }
}

test("normalizeUserSettings falls back to the extension default voice", () => {
  assert.equal(normalizeUserSettings({}).defaultVoice, "af_heart");
  assert.equal(normalizeUserSettings({ defaultVoice: "unknown" }).defaultVoice, "af_heart");
});

test("loadUserSettings returns the persisted supported voice", async () => {
  const storage = new MemoryStorageArea({
    [USER_SETTINGS_KEY]: {
      defaultVoice: "bm_lewis"
    }
  });

  const settings = await loadUserSettings(storage);

  assert.equal(settings.defaultVoice, "bm_lewis");
});

test("saveUserSettings stores only normalized supported voices", async () => {
  const storage = new MemoryStorageArea();

  const saved = await saveUserSettings(storage, { defaultVoice: "am_adam" });
  const fallback = await saveUserSettings(storage, { defaultVoice: "not-real" });

  assert.equal(saved.defaultVoice, "am_adam");
  assert.equal(storage.values[USER_SETTINGS_KEY].defaultVoice, "af_heart");
  assert.equal(fallback.defaultVoice, "af_heart");
});

test("findVoiceOption exposes metadata for known voices", () => {
  assert.equal(findVoiceOption("af_heart")?.label, "Heart");
  assert.equal(findVoiceOption("missing"), null);
});
