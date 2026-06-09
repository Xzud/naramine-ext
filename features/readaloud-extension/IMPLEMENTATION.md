# Streaming MVP Implementation

Target folder: `features/readaloud-extension/`

Implementation choices follow the current streaming refactor directly:

- Separate feature folder to minimize merge conflicts.
- Browser extension with popup, content script, MV3 service worker, offscreen document, IndexedDB, chunker, and provider abstraction.
- Local Docker Kokoro first, Modal-compatible backend/provider second.
- WAV end-to-end for MVP, but now as a live byte stream over the backend proxy.
- Offscreen owns the active network transport and progressive playback.
- IndexedDB is no longer on the first-playback critical path.

## Reviewer Checklist

- Confirm the feature is fully isolated under `features/readaloud-extension/` and does not modify unrelated code.
- Confirm the extension manifest is MV3, includes `storage`, `offscreen`, and `activeTab`, and grants localhost host permissions for Kokoro and backend proxy calls.
- Confirm popup, service worker, offscreen document, IndexedDB layer, chunker, and TTS providers exist in the prompt-specified structure.
- Confirm the runtime flow is hardcoded text -> chunks -> backend `/tts/stream` -> offscreen playback, with playback starting before the full audio response completes.
- Confirm the service worker orchestrates playback but does not fetch and materialize the active chunk audio itself.
- Confirm chunk IDs remain stable for identical text inputs and the chunker prefers paragraph boundaries before sentence fallback.
- Confirm audio cache entries are temporary and receive a 24-hour expiry timestamp.
- Confirm playback is not handled directly in the service worker and instead delegates to the offscreen document via runtime messaging.
- Confirm WAV is the active MVP format while provider abstractions still leave room for Modal and future WebM/Opus support.
- Confirm the backend exposes `GET /health`, `POST /tts`, and `POST /tts/stream`, and can switch between local and modal provider modes without changing extension playback code.
- Confirm the popup exposes the MVP states and shows generation/playback/buffer/cache status in product language aligned with "Continuous read-aloud with temporary buffering."
- Confirm tests or validation cover chunking/stable-ID behavior, queue streaming orchestration, popup transport semantics, WAV stream parsing, and backend syntax correctness.
