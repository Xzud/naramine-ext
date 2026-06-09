# Streaming MVP Implementation

Target folder: `features/readaloud-extension/`

Implementation choices follow the prompt directly:

- Separate feature folder to minimize merge conflicts.
- Browser extension with popup, content script, MV3 service worker, offscreen document, IndexedDB, chunker, and provider abstraction.
- Local Docker Kokoro first, Modal-compatible backend/provider second.
- WAV end-to-end for MVP.
- Temporary buffering language and 24-hour cache expiry.
- Read-ahead buffering with `MIN_READY_CHUNKS = 2`, `TARGET_READY_CHUNKS = 5`, `MAX_READY_CHUNKS = 8`.

## Reviewer Checklist

- Confirm the feature is fully isolated under `features/readaloud-extension/` and does not modify unrelated code.
- Confirm the extension manifest is MV3, includes `storage`, `offscreen`, and `activeTab`, and grants localhost host permissions for Kokoro and backend proxy calls.
- Confirm popup, service worker, offscreen document, IndexedDB layer, chunker, and TTS providers exist in the prompt-specified structure.
- Confirm the runtime flow is hardcoded text -> chunks -> TTS -> IndexedDB -> offscreen playback, with chunk 0 playable before later chunks finish.
- Confirm the generation loop and playback loop are separate and the generation loop honors the read-ahead buffer thresholds from the prompt.
- Confirm chunk IDs remain stable for identical text inputs and the chunker prefers paragraph boundaries before sentence fallback.
- Confirm audio cache entries are temporary and receive a 24-hour expiry timestamp.
- Confirm playback is not handled directly in the service worker and instead delegates to the offscreen document via runtime messaging.
- Confirm WAV is the active MVP format while provider abstractions still leave room for Modal and future WebM/Opus support.
- Confirm the backend exposes `GET /health` and `POST /tts`, and can switch between local and modal provider modes without changing extension playback code.
- Confirm the popup exposes the MVP states and shows generation/playback/buffer/cache status in product language aligned with "Continuous read-aloud with temporary buffering."
- Confirm tests or validation cover at least the chunking/stable-ID behavior and backend syntax correctness.
