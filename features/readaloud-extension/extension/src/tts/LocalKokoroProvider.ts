export declare class LocalKokoroProvider {
  constructor(baseUrl?: string);
  synthesize(input: { text: string; voice: string; format: "wav" | "opus" | "webm" }): Promise<Blob>;
}
