export declare class LocalKokoroProvider {
  constructor(baseUrl?: string);
  createStreamRequest(input: {
    text: string;
    voice: string;
    format: "wav" | "opus" | "webm";
  }): {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  };
  synthesize(input: { text: string; voice: string; format: "wav" | "opus" | "webm" }): Promise<Blob>;
}
