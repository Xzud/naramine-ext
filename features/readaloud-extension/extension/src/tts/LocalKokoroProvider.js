import { TTSProvider } from "./TTSProvider.js";

export class LocalKokoroProvider extends TTSProvider {
  constructor(baseUrl = "http://localhost:8880") {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async synthesize(input) {
    const response = await fetch(`${this.baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "kokoro",
        voice: input.voice,
        input: input.text,
        response_format: input.format === "webm" ? "wav" : input.format
      })
    });

    if (!response.ok) {
      throw new Error(`Kokoro failed: ${response.status}`);
    }

    return response.blob();
  }
}
