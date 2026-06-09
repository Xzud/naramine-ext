export interface TTSProvider {
  synthesize(input: {
    text: string;
    voice: string;
    format: "wav" | "opus" | "webm";
  }): Promise<Blob>;
}
