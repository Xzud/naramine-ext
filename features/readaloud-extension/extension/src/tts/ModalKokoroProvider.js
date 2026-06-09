import { TTSProvider } from "./TTSProvider.js";

export class ModalKokoroProvider extends TTSProvider {
  constructor(endpointUrl, token = "") {
    super();
    this.endpointUrl = endpointUrl;
    this.token = token;
  }

  async synthesize(input) {
    const response = await fetch(this.endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      body: JSON.stringify({
        text: input.text,
        voice: input.voice,
        format: input.format
      })
    });

    if (!response.ok) {
      throw new Error(`Modal TTS failed: ${response.status}`);
    }

    return response.blob();
  }
}
