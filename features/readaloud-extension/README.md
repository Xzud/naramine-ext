# Readaloud MVP

This feature folder implements the prompt in [prompts/streaming-mvp-prompt.md](/home/paul/Personal/Coding/naramine-ext/prompts/streaming-mvp-prompt.md) without touching any shared app structure.

## Layout

- `extension/`: Chrome Manifest V3 MVP with popup, service worker orchestration, offscreen playback, IndexedDB cache, chunker, and provider abstraction.
- `backend/`: FastAPI proxy with `/health` and `/tts`, swappable between local Kokoro and Modal.
- `docker-compose.yml`: runs the backend on `http://localhost:3000`.

## MVP behavior

1. Popup starts playback from hardcoded text.
2. Text is chunked with stable IDs and saved in IndexedDB.
3. Chunk 0 is synthesized to WAV via local Kokoro by default.
4. Playback happens inside an offscreen document.
5. Future chunks are generated and buffered in the background.
6. Audio chunks expire after 24 hours.

## Validation

- `npm test`
- `python3 -m py_compile backend/app.py backend/tts_local.py backend/tts_modal.py`

## Manual run

1. Start Kokoro locally:
   `docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest`
2. Optionally start the proxy backend from this folder:
   `docker compose up --build`
3. Load `features/readaloud-extension/extension/` as an unpacked Chrome extension.
4. Open the popup and press `Play`.
