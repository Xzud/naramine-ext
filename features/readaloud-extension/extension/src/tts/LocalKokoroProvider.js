import { TTSProvider } from "./TTSProvider.js";

export class LocalKokoroProvider extends TTSProvider {
  constructor(baseUrl = "http://localhost:3000") {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  buildPayload(input) {
    return {
      text: input.text,
      voice: input.voice,
      format: input.format,
      chunk_id: input.chunkId,
      chapter_id: input.chapterId
    };
  }

  createStreamRequest(input) {
    return {
      url: `${this.baseUrl}/tts/stream`,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(this.buildPayload(input))
    };
  }

  async synthesize(input) {
    const response = await fetch(`${this.baseUrl}/tts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: input.text,
        voice: input.voice,
        format: input.format
      })
    });

    if (!response.ok) {
      throw new Error(`Kokoro failed: ${response.status}`);
    }

    return response.blob();
  }
}
