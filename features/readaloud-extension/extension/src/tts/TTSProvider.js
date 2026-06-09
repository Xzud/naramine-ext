export class TTSProvider {
  createStreamRequest() {
    throw new Error("TTSProvider.createStreamRequest must be implemented");
  }

  async synthesize() {
    throw new Error("TTSProvider.synthesize must be implemented");
  }
}
