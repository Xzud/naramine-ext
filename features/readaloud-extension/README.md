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

## Manual run (Modal TTS, default)

Kokoro now runs on Modal.com; the local proxy forwards `/tts/stream` to it.

1. One-time Modal setup from `backend/` (already done if the app is deployed):
   `modal secret create kokoro-tts-token TTS_TOKEN=<random token>`
   `modal deploy kokoro_modal_app.py`
   The deploy output prints the `tts_stream` endpoint URL.
2. Start the proxy with the Modal endpoint (or put these in a `.env` next to
   `docker-compose.yml`; the token value is stashed in
   `backend/.modal-tts-token.env`, which stays untracked):
   `MODAL_TTS_URL=<tts_stream URL> MODAL_TTS_TOKEN=<token> docker compose up --build`
3. Verify the services if needed:
   `curl http://localhost:3000/health` (should report `"mode": "modal"`)
   `curl <health endpoint URL>` (the deployed `health` endpoint)
4. Load `features/readaloud-extension/extension/` as an unpacked Chrome extension.
5. Open the popup and press `Play`.

## Manual run (local Kokoro fallback)

1. Start the local Kokoro container and the proxy in local mode:
   `TTS_MODE=local docker compose --profile local up --build`
2. Verify with `curl http://localhost:8880/health` and `curl http://localhost:3000/health`.
