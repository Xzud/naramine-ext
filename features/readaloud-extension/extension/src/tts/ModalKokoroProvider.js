import { TTSProvider } from "./TTSProvider.js";

export class ModalKokoroProvider extends TTSProvider {
  constructor(baseUrl, token = "") {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  buildHeaders() {
    return {
      "Content-Type": "application/json",
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
    };
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
      headers: this.buildHeaders(),
      body: JSON.stringify(this.buildPayload(input))
    };
  }

  async synthesize(input) {
    const response = await fetch(`${this.baseUrl}/tts`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(this.buildPayload(input))
    });

    if (!response.ok) {
      throw new Error(`Modal TTS failed: ${response.status}`);
    }

    return response.blob();
  }
}
