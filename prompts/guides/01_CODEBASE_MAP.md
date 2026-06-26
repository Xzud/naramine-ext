# 01. Codebase Map

This guide explains where everything lives and how to approach the codebase.

The readaloud feature is isolated under:

```txt
features/readaloud-extension/
```

That folder contains two main pieces:

```txt
features/readaloud-extension/
  extension/   Chrome extension code
  backend/     FastAPI TTS proxy
```

## Top-Level Files

### `features/readaloud-extension/README.md`

This is the practical feature README. It explains:

- What the feature folder contains.
- How to run the extension.
- How to run the local or Modal TTS backend.
- The main validation commands.

Use it when you want to run the system.

### `features/readaloud-extension/IMPLEMENTATION.md`

This is an implementation summary from the streaming MVP. It gives the original
intent of the architecture:

- Browser extension.
- Manifest V3 service worker.
- Offscreen playback.
- IndexedDB cache.
- Streaming `/tts/stream` backend.
- Playback should not wait for a full audio file before starting.

Use it when you want to understand the design direction.

### `features/readaloud-extension/package.json`

This defines available npm scripts:

```json
{
  "test": "node --test extension/tests/*.test.js",
  "check:backend": "python3 -m py_compile backend/app.py backend/tts_local.py backend/tts_modal.py"
}
```

Important detail: the extension tests are Node tests, not browser tests.
They test pure helpers and mocked extension behavior.

## Extension Folder

Main folder:

```txt
features/readaloud-extension/extension/
```

Important files:

```txt
extension/
  manifest.json
  src/
  tests/
```

### `extension/manifest.json`

This is the Chrome extension configuration.

It declares:

- `manifest_version: 3`
- Extension name and version.
- Permissions:
  - `storage`
  - `offscreen`
  - `activeTab`
  - `tabs`
  - `alarms`
- Host permissions:
  - `http://localhost:8880/*`
  - `http://localhost:3000/*`
- Background service worker:
  - `src/background/service_worker.js`
- Popup:
  - `src/popup/popup.html`
- Options page:
  - `src/options/options.html`
- Content script:
  - `src/content/content.js`
- Offscreen page as a web accessible resource:
  - `src/offscreen/offscreen.html`

Technical term:

- **Manifest** means a JSON file that tells Chrome what the extension is allowed
  to do and which scripts/pages it loads.

## Runtime JavaScript vs TypeScript Files

You will see both `.js` and `.ts` files in some folders.

Example:

```txt
extension/src/audio/playbackQueue.js
extension/src/audio/playbackQueue.ts
```

For this extension, the manifest points at JavaScript runtime files. When you
are reading what actually runs in Chrome, start with `.js`.

Use `.ts` files only if you are specifically working on TypeScript sources or
want type information. The current runtime behavior is best understood from the
JavaScript files.

## `extension/src/` Folders

### `src/background/`

Main file:

```txt
src/background/service_worker.js
```

Owns:

- Extension-wide message routing.
- Creating one `PlaybackQueue`.
- Returning structured responses to popup/content/options messages.

It does not own most business logic. It delegates to `PlaybackQueue`.

### `src/audio/`

Main files:

```txt
src/audio/playbackQueue.js
src/audio/runtimeState.js
```

Owns:

- Main playback state machine.
- Session storage.
- Current chapter resolution.
- Warmup pipeline.
- Offscreen playback commands.
- Sync orchestration.
- Prefetch/backfill/auto-advance.
- Library deletion.
- Continue/resume.
- Sleep timer.
- Voice switching.

This is the most important subsystem. If something affects playback behavior,
it is probably here.

### `src/content/`

Main files:

```txt
src/content/content.js
src/content/wattpadExtractor.js
src/content/chunkFocus.js
```

Owns:

- Reading Wattpad DOM.
- Detecting chapter pages and story pages.
- Extracting clean text and metadata.
- Handling paragraph click playback.
- Highlighting current paragraphs during playback.

Technical term:

- **DOM** means the browser's in-memory tree of HTML elements on the page.

### `src/db/`

Main file:

```txt
src/db/idb.js
```

Owns:

- Opening IndexedDB.
- Creating object stores.
- Reading/writing chapter, chunk, audio, and story records.
- Deleting cached records.
- Cleaning expired cache entries.

Technical term:

- **Object store** is IndexedDB's version of a database table.

### `src/offscreen/`

Main files:

```txt
src/offscreen/offscreen.html
src/offscreen/offscreen.js
src/offscreen/wavStreamPlayer.js
```

Owns:

- Hidden playback page.
- Active and prepared playback slots.
- Loading cached audio blobs.
- Falling back to live TTS streams.
- Parsing WAV streams.
- Scheduling Web Audio playback.

Technical term:

- **Offscreen document** means a hidden extension page that can keep running
  while the popup is closed.

### `src/popup/`

Main files:

```txt
src/popup/popup.html
src/popup/popup.js
src/popup/popupState.js
```

Owns:

- Toolbar popup UI.
- Play/pause/stop buttons.
- Progress bars.
- Voice selector.
- Sync toggle.
- Sleep timer menu.
- Library panel.
- Guide/recents view.

The popup mostly asks the background what the state is. It does not directly
read Wattpad pages.

### `src/options/`

Main files:

```txt
src/options/options.html
src/options/options.js
```

Owns:

- Full options page.
- Default voice settings.
- Larger library view.
- Delete/continue actions.

### `src/shared/`

Main files:

```txt
src/shared/constants.js
src/shared/userSettings.js
src/shared/libraryState.js
src/shared/syncState.js
```

Owns pure/shared logic:

- Constants.
- Voice metadata and settings normalization.
- Library grouping/status calculations.
- Sync toggle and Sync-start planning.

Technical term:

- **Pure helper** means a function that calculates a result from inputs without
  reading/writing external state. Pure helpers are easier to test.

### `src/text/`

Main file:

```txt
src/text/chunkText.js
```

Owns:

- Splitting text into TTS-sized chunks.
- Creating stable chunk IDs.
- Preserving Wattpad paragraph anchors.

### `src/tts/`

Main files:

```txt
src/tts/TTSProvider.js
src/tts/LocalKokoroProvider.js
src/tts/ModalKokoroProvider.js
```

Owns:

- Building TTS request objects.
- Sending text/voice/format to the backend or local endpoint.

These classes do not play audio themselves. They only build/fetch TTS audio.

## Backend Folder

Main folder:

```txt
features/readaloud-extension/backend/
```

Important files:

```txt
backend/app.py
backend/tts_local.py
backend/tts_modal.py
backend/kokoro_modal_app.py
backend/test_streaming.py
backend/requirements.txt
backend/Dockerfile
```

### `backend/app.py`

FastAPI app with:

- `GET /health`
- `POST /tts`
- `POST /tts/stream`

`/tts` returns a completed audio response.

`/tts/stream` returns bytes progressively as a stream.

### `backend/tts_local.py`

Talks to a local Kokoro-compatible server:

```txt
http://localhost:8880/v1/audio/speech
```

### `backend/tts_modal.py`

Talks to a configured Modal endpoint:

```txt
MODAL_TTS_URL
MODAL_TTS_TOKEN
```

### `backend/test_streaming.py`

Tests that `/tts/stream` returns a real `StreamingResponse` and yields streamed
bytes.

## Test Folder

Main folder:

```txt
features/readaloud-extension/extension/tests/
```

The tests are grouped around features:

- `chunkText.test.js`
  - Text splitting and stable chunk IDs.
- `wattpadExtractor.test.js`
  - Wattpad extraction from HTML.
- `contentStoryPage.test.js`
  - Story overview page detection and metadata messages.
- `contentClick.test.js`
  - Paragraph click playback.
- `chunkFocus.test.js`
  - Highlighting and scrolling current paragraphs.
- `popupState.test.js`
  - Popup view model rules.
- `libraryState.test.js`
  - Library grouping, statuses, voice variants, sizes.
- `syncState.test.js`
  - Sync toggle and Sync-start plan rules.
- `wavStreamPlayer.test.js`
  - WAV header parsing and stream playback scheduling.
- `playbackQueue.test.js`
  - Main orchestration behavior.
- `userSettings.test.js`
  - Voice settings validation.

## How To Read The Code Without Getting Lost

Use this order:

1. Start with `manifest.json`.
   - This tells you what Chrome loads.

2. Read `service_worker.js`.
   - This tells you the command names.

3. Read `popup.js` and `content.js`.
   - This tells you who sends those commands.

4. Read `playbackQueue.js` by feature.
   - Do not try to understand the whole file in one pass.
   - Search for one method, such as `startExclusive`, `warmupExclusive`, or
     `setSyncEnabled`.

5. Read `offscreen.js` and `wavStreamPlayer.js`.
   - This explains where audio actually plays.

6. Read `idb.js`.
   - This explains what is saved.

7. Read tests for the feature you are changing.
   - Tests often explain the expected behavior more directly than production
     code.

