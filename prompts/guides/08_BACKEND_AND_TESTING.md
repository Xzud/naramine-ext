# 08. Backend and Testing

This guide explains the backend and how the project is tested.

Relevant files:

```txt
features/readaloud-extension/backend/app.py
features/readaloud-extension/backend/tts_local.py
features/readaloud-extension/backend/tts_modal.py
features/readaloud-extension/backend/kokoro_modal_app.py
features/readaloud-extension/backend/test_streaming.py
features/readaloud-extension/backend/requirements.txt
features/readaloud-extension/backend/Dockerfile
features/readaloud-extension/docker-compose.yml
features/readaloud-extension/package.json
features/readaloud-extension/extension/tests/
```

## Backend Purpose

The backend is a local proxy between the browser extension and a TTS provider.

The extension talks to:

```txt
http://localhost:3000
```

The backend then talks to either:

```txt
local Kokoro
```

or:

```txt
Modal-hosted Kokoro
```

Why use a proxy?

- Keep extension code stable while backend provider changes.
- Support local and Modal modes.
- Centralize auth/token handling for Modal.
- Provide a consistent `/tts/stream` endpoint.

## FastAPI App

File:

```txt
features/readaloud-extension/backend/app.py
```

Creates:

```python
app = FastAPI(title="Readaloud MVP Backend", version="0.2.0")
```

Technical terms:

- **FastAPI**: Python web framework.
- **Endpoint**: A URL path handled by backend code.
- **Pydantic model**: A class that validates request data.

## Request Body

Class:

```python
class TTSBody(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    voice: str = Field(default="af_heart", min_length=1)
    format: str = Field(default="wav", pattern="^(wav|opus|webm)$")
```

Meaning:

- `text` is required and must be 1-1000 characters.
- `voice` defaults to `af_heart`.
- `format` defaults to `wav`.
- Accepted formats are `wav`, `opus`, or `webm`.

Important current behavior:

- The extension currently requests `wav`.
- The `WavStreamPlayer` expects WAV.

## Backend Mode

Function:

```python
def get_mode() -> str:
    return os.getenv("TTS_MODE", "local").strip().lower() or "local"
```

Mode:

- `local`
- `modal`

If `TTS_MODE` is missing, backend defaults to local.

## Endpoints

### `GET /health`

Returns:

```python
{"status": "ok", "mode": get_mode()}
```

Use it to verify backend is running and which mode it is in.

### `POST /tts`

Returns a complete audio response.

Flow:

1. Validate JSON body.
2. Call `synthesize_audio(...)`.
3. Return `Response(content=content, media_type=content_type)`.

This endpoint waits until all audio bytes are ready.

### `POST /tts/stream`

Returns a streaming audio response.

Flow:

1. Validate JSON body.
2. Choose Modal or local stream client.
3. Get an async byte iterator.
4. Return `StreamingResponse(...)`.
5. Attach background cleanup task.

Technical terms:

- **Async iterator**: Object that yields values over time using async code.
- **StreamingResponse**: FastAPI response that sends chunks progressively.
- **BackgroundTask**: Cleanup work FastAPI runs after the response finishes.

## Local TTS Client

File:

```txt
features/readaloud-extension/backend/tts_local.py
```

Class:

```python
LocalKokoroClient
```

Default base URL:

```txt
http://localhost:8880
```

Endpoint:

```txt
/v1/audio/speech
```

Payload:

```python
{
    "model": "kokoro",
    "voice": request.voice,
    "input": request.text,
    "response_format": response_format,
}
```

Methods:

- `synthesize(...)`
  - Returns full bytes.

- `stream_synthesize(...)`
  - Returns async byte stream.

## Modal TTS Client

File:

```txt
features/readaloud-extension/backend/tts_modal.py
```

Class:

```python
ModalKokoroClient
```

Reads:

- `MODAL_TTS_URL`
- `MODAL_TTS_TOKEN`

Methods:

- `synthesize(...)`
- `stream_synthesize(...)`

If `MODAL_TTS_URL` is missing, it raises:

```txt
MODAL_TTS_URL is not configured
```

## Docker Compose

File:

```txt
features/readaloud-extension/docker-compose.yml
```

Purpose:

- Run backend proxy.
- Optionally run local Kokoro service depending on profile/config.

Use the feature README for exact manual run steps because environment values
matter.

## Backend Validation Commands

From:

```txt
features/readaloud-extension/
```

Run:

```bash
npm run check:backend
```

This compiles Python files:

```bash
python3 -m py_compile backend/app.py backend/tts_local.py backend/tts_modal.py
```

Run backend streaming unit test:

```bash
python3 -m unittest backend/test_streaming.py
```

## Extension Tests

From:

```txt
features/readaloud-extension/
```

Run:

```bash
npm test
```

This runs:

```bash
node --test extension/tests/*.test.js
```

Technical term:

- **Unit test**: A test focused on a small piece of behavior.

## Test Coverage By File

### `chunkText.test.js`

Tests:

- Paragraph splitting.
- Sentence fallback.
- Stable hashes.
- Paragraph anchor preservation.

Read with:

```txt
extension/src/text/chunkText.js
```

### `wattpadExtractor.test.js`

Tests:

- DOM extraction.
- Embedded story text fallback.
- Safe failure.
- Noise stripping.
- Next chapter resolution.

Read with:

```txt
extension/src/content/wattpadExtractor.js
```

### `contentStoryPage.test.js`

Tests:

- Story overview page metadata message.
- Page context response for story overview.

Read with:

```txt
extension/src/content/content.js
```

### `contentClick.test.js`

Tests:

- Clicking a paragraph sends play-from-paragraph.
- Same-chapter Wattpad pagination does not re-emit page ready.

Read with:

```txt
extension/src/content/content.js
```

### `chunkFocus.test.js`

Tests:

- Scroll and highlight.
- Restore highlight after DOM mutation.
- Clear highlight on stop.

Read with:

```txt
extension/src/content/chunkFocus.js
```

### `popupState.test.js`

Tests:

- Timer display.
- Pause button behavior.
- Progress ratios.
- Error display.
- Primary popup view selection.
- Guide recents.

Read with:

```txt
extension/src/popup/popupState.js
```

### `libraryState.test.js`

Tests:

- Downloaded/processing/paused status.
- Story title heuristic.
- Scraped metadata preference.
- Continue labels.
- Voice variants.
- Byte formatting.

Read with:

```txt
extension/src/shared/libraryState.js
extension/src/popup/popupState.js
```

### `syncState.test.js`

Tests:

- Per-story Sync flag.
- Toggle add/remove behavior.
- Sync startup plan from chapter page.
- Sync startup plan from story page.

Read with:

```txt
extension/src/shared/syncState.js
```

### `userSettings.test.js`

Tests:

- Default voice fallback.
- Supported voice loading/saving.
- Voice metadata lookup.

Read with:

```txt
extension/src/shared/userSettings.js
```

### `wavStreamPlayer.test.js`

Tests:

- WAV header parsing.
- Invalid WAV rejection.
- Gapless scheduling.
- Pause/resume.
- Short streams.
- Resume from offset.

Read with:

```txt
extension/src/offscreen/wavStreamPlayer.js
```

### `playbackQueue.test.js`

Tests the main orchestration layer.

It covers:

- Structured idle state.
- Warmup.
- Live stream path.
- Highlight commands.
- Prepared lookahead.
- Chunk handoff.
- Retry behavior.
- Race conditions.
- Warming pipeline.
- Next-chapter prefetch.
- Sync.
- Library metadata.
- Off-page playback block.
- Recents and Continue.
- Voice switching.
- Sleep timer.
- Page context.

Read it in sections using `rg`.

Example:

```bash
rg -n "sleep|sync|warming pipeline|switchVoice|continue" extension/tests/playbackQueue.test.js
```

## How To Add A New Test

General process:

1. Identify the smallest helper or subsystem involved.
2. Look for an existing nearby test file.
3. Add a test that describes behavior in plain language.
4. Mock Chrome APIs only at the boundary.
5. Prefer testing pure helpers directly when possible.

Examples:

- New library grouping rule:
  - Add to `libraryState.test.js`.

- New sync planning rule:
  - Add to `syncState.test.js`.

- New queue behavior:
  - Add to `playbackQueue.test.js`.

- New WAV parsing behavior:
  - Add to `wavStreamPlayer.test.js`.

## What To Run After Changes

Documentation-only change:

```bash
find prompts/guides -maxdepth 1 -type f -print
```

Extension behavior change:

```bash
npm test
```

Backend Python change:

```bash
npm run check:backend
python3 -m unittest backend/test_streaming.py
```

Full feature confidence:

```bash
npm test
npm run check:backend
python3 -m unittest backend/test_streaming.py
```

Run these from:

```txt
features/readaloud-extension/
```
