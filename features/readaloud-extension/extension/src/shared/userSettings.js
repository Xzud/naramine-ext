import { DEFAULT_VOICE } from "./constants.js";

export const USER_SETTINGS_KEY = "readaloud:userSettings";

export const VOICE_OPTIONS = [
  {
    id: "af_heart",
    label: "Heart",
    family: "Ava F",
    description: "Warm, soft, and easy for long listening sessions."
  },
  {
    id: "af_bella",
    label: "Bella",
    family: "Ava F",
    description: "Clean and bright, with a lighter presentation."
  },
  {
    id: "af_nicole",
    label: "Nicole",
    family: "Ava F",
    description: "A crisp, intimate voice for quieter chapters."
  },
  {
    id: "am_adam",
    label: "Adam",
    family: "Aiden M",
    description: "Calm and grounded, with a neutral delivery."
  },
  {
    id: "am_michael",
    label: "Michael",
    family: "Aiden M",
    description: "Deeper and steadier for a more measured tone."
  },
  {
    id: "bm_lewis",
    label: "Lewis",
    family: "Ben M",
    description: "Dryer, storyteller-like phrasing for narration."
  }
];

const VOICE_IDS = new Set(VOICE_OPTIONS.map((option) => option.id));

export function normalizeUserSettings(settings = {}) {
  return {
    defaultVoice:
      typeof settings.defaultVoice === "string" && VOICE_IDS.has(settings.defaultVoice)
        ? settings.defaultVoice
        : DEFAULT_VOICE
  };
}

export async function loadUserSettings(storageArea) {
  const values = await storageArea.get(USER_SETTINGS_KEY);
  return normalizeUserSettings(values?.[USER_SETTINGS_KEY] || {});
}

export async function saveUserSettings(storageArea, nextSettings = {}) {
  const current = await loadUserSettings(storageArea);
  const normalized = normalizeUserSettings({
    ...current,
    ...nextSettings
  });
  await storageArea.set({
    [USER_SETTINGS_KEY]: normalized
  });
  return normalized;
}

export function findVoiceOption(voiceId) {
  return VOICE_OPTIONS.find((option) => option.id === voiceId) || null;
}
