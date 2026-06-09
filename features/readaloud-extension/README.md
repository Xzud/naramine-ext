# Readaloud MVP

This feature folder implements the prompt in [prompts/streaming-mvp-prompt.md](/home/paul/Personal/Coding/naramine-ext/prompts/streaming-mvp-prompt.md) without touching any shared app structure.

## Layout

- `extension/`: Chrome Manifest V3 MVP with popup, service worker orchestration, offscreen playback, IndexedDB cache, chunker, and provider abstraction.
- `backend/`: FastAPI proxy with `/health` and `/tts`, swappable between local Kokoro and Modal.
- `docker-compose.yml`: runs the backend on `http://localhost:3000`.

## MVP behavior

1. Popup starts playback from hardcoded text.
2. Text is chunked with stable IDs and saved in IndexedDB.
3. The service worker orchestrates chapter and chunk state but does not synthesize the active audio chunk itself.
4. Playback happens inside an offscreen document that fetches `POST /tts/stream` and consumes WAV bytes progressively.
5. The active playback path no longer waits on full audio blobs or IndexedDB before starting.
6. IndexedDB remains chapter metadata storage and optional legacy cache storage, not the startup critical path.

## Validation

- `npm test`
- `python3 -m py_compile backend/app.py backend/tts_local.py backend/tts_modal.py`
- `python3 -m unittest backend/test_streaming.py`

## Manual run

1. Start Kokoro and the proxy backend together from this folder:
   `docker compose up --build`
2. Verify the services if needed:
   `curl http://localhost:8880/health`
   `curl http://localhost:3000/health`
3. Load `features/readaloud-extension/extension/` as an unpacked Chrome extension.
4. Open the popup and press `Play`.
