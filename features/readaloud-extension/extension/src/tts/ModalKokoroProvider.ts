export declare class ModalKokoroProvider {
  constructor(endpointUrl: string, token?: string);
  synthesize(input: { text: string; voice: string; format: "wav" | "opus" | "webm" }): Promise<Blob>;
}
