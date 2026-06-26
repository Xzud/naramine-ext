# Naramine

This repository currently centers on `features/readaloud-extension/`: a Chrome Manifest V3 extension that reads Wattpad chapters aloud, caches audio per chapter and per voice, and streams Kokoro TTS through a local FastAPI proxy.

This README is written for a new developer joining the project. It explains:

- what files matter
- what each runtime layer does
- what happens when a user opens a chapter, presses Play, pauses, switches voice, or turns Sync on
- how scraping, warmup, streaming playback, caching, and Kokoro fit together

## Where the app lives

The working feature is under `features/readaloud-extension/`.

- `extension/`: the Chrome extension frontend and orchestration runtime
- `backend/`: the FastAPI proxy that exposes `/tts` and `/tts/stream`
- `docker-compose.yml`: local startup for the proxy, and optionally local Kokoro
- `README.md` and `IMPLEMENTATION.md` inside the feature folder: shorter feature notes

## Stack at a glance

- Frontend runtime: Chrome extension, Manifest V3
- UI: popup page and options page
- Page integration: content script injected into Wattpad pages
- App orchestration: service worker plus `PlaybackQueue`
- Audio playback: offscreen document plus Web Audio API
- Persistent state: `chrome.storage.local`
- Cached chapter/audio data: IndexedDB
- Backend: FastAPI
- TTS providers: local Kokoro server or Modal-hosted Kokoro

## End-to-end architecture

```text
Popup / Options UI
    -> chrome.runtime.sendMessage(scope="readaloud")
Service Worker
    -> PlaybackQueue
        -> content script for Wattpad extraction and paragraph highlighting
        -> chrome.storage.local for sessions, sync flags, sleep timer, recents
        -> IndexedDB for chapter/chunk/audio cache
        -> offscreen document for actual network audio streaming and playback
Offscreen document
    -> POST /tts/stream
FastAPI proxy on http://localhost:3000
    -> local Kokoro on http://localhost:8880
       or Modal Kokoro endpoint
Kokoro
    -> WAV bytes stream back through the same path in reverse
```

The most important architectural rule is this:

- the service worker decides what should happen
- the offscreen document owns active audio transport and playback
- the content script owns Wattpad page scraping and page highlighting
- the FastAPI proxy owns the TTS backend selection

## File-by-file guide

### Extension entry points

- `features/readaloud-extension/extension/manifest.json`
  Registers the popup, options page, service worker, content script, and offscreen document. Also grants `storage`, `offscreen`, `tabs`, `activeTab`, `alarms`, and localhost host permissions.

- `features/readaloud-extension/extension/src/background/service_worker.js`
  Thin message router. It creates one `PlaybackQueue` instance and forwards scoped messages like `PLAY`, `PAUSE`, `PAGE_READY`, `SYNC_SET`, `LIBRARY_GET`, and `SLEEP_SET` into queue methods.

- `features/readaloud-exETnsion/extension/src/popup/popup.html`
  Popup DOM shell.

- `features/readaloud-extension/extension/src/popup/popup.js`
  Popup controller. It wires buttons to runtime messages, polls state every 1.5 seconds, refreshes page context, library, sync status, and sleep timer, and renders the current view.

- `features/readaloud-extension/extension/src/popup/popupState.js`
  Pure view-model helpers for the popup. No Chrome APIs here. It converts runtime state into labels, timers, progress ratios, guide rows, and library rows.

- `features/readaloud-extension/extension/src/options/options.html`
  Options page DOM shell.

- `features/readaloud-extension/extension/src/options/options.js`
  Settings and library-management page. It edits the default voice and exposes a larger management UI for downloaded stories and chapters.

### Core app logic

- `features/readaloud-extension/extension/src/audio/playbackQueue.js`
  The application brain. This is the single most important file in the repo.

  Major responsibilities:

  - serialize state mutations with `runExclusive()`
  - load and save chapter sessions in `chrome.storage.local`
  - resolve text input from Wattpad pages with `resolvePlaybackInput()`
  - chunk and persist chapter data with `ensureChapterData()`
  - warm audio into IndexedDB with `ensureWarmingPipeline()` and `runWarmingPipeline()`
  - start or resume live playback with `start()`, `processSession()`, and `startCurrentChunkStream()`
  - react to offscreen playback events with `handleRuntimeMessageExclusive()`
  - manage story sync, backfill, next-chapter prefetch, resume, library delete, and sleep timer flows

- `features/readaloud-extension/extension/src/audio/runtimeState.js`
  Pure reducers and state mappers. It turns stored sessions into popup-friendly runtime state and contains retry/end/error transition helpers like `applyPlaybackEnded()` and `applyPlaybackError()`.

### Wattpad page integration

- `features/readaloud-extension/extension/src/content/content.js`
  Runtime Wattpad integration. It detects whether the page is a chapter or a story overview, extracts chapter text, reports `PAGE_READY` and `STORY_PAGE_READY`, handles paragraph click-to-play, and highlights the active paragraph while audio is playing.

- `features/readaloud-extension/extension/src/content/chunkFocus.js`
  Pure extracted version of the active-paragraph highlighting controller, used by tests. Runtime code currently embeds equivalent logic directly in `content.js`.

- `features/readaloud-extension/extension/src/content/wattpadExtractor.js`
  Pure extraction helper used by tests. Runtime extraction logic currently lives directly in `content.js`.

### Text shaping and storage

- `features/readaloud-extension/extension/src/text/chunkText.js`
  Converts extracted chapter text into stable chunk records. `stableHash()` makes chunk IDs repeatable for identical text. `chunkText()` prefers paragraph boundaries, then sentence splitting, then hard length limits.

- `features/readaloud-extension/extension/src/db/idb.js`
  IndexedDB layer. It stores chapter records, chunk records, audio blobs, and story metadata. It also builds the download-library overview and cleans expired audio.

- `features/readaloud-extension/extension/src/shared/constants.js`
  Global tuning constants such as chunk limits, stream lookahead depth, ready-buffer thresholds, and default IDs.

- `features/readaloud-extension/extension/src/shared/userSettings.js`
  Default voice storage and voice catalog.

- `features/readaloud-extension/extension/src/shared/syncState.js`
  Pure logic for deciding what turning Sync on should do first.

- `features/readaloud-extension/extension/src/shared/libraryState.js`
  Pure logic for turning raw chapter cache records into grouped story/chapter library rows and derived statuses like `downloaded`, `processing`, and `paused`.

### Audio transport and playback

- `features/readaloud-extension/extension/src/offscreen/offscreen.html`
  Offscreen document shell.

- `features/readaloud-extension/extension/src/offscreen/offscreen.js`
  Owns active stream playback. It can start a live stream, prepare a cached lookahead chunk, promote a prepared chunk into active playback, pause, resume, stop, and report playback status back to the service worker.

- `features/readaloud-extension/extension/src/offscreen/wavStreamPlayer.js`
  Progressive WAV player built on the Web Audio API. It parses the WAV header, buffers PCM bytes, starts playback once enough audio has arrived, emits progress events, handles pause/resume, and reports end/error states.

- `features/readaloud-extension/extension/src/tts/TTSProvider.js`
  Provider interface.

- `features/readaloud-extension/extension/src/tts/LocalKokoroProvider.js`
  Builds requests for the proxy or local Kokoro-compatible endpoint without auth headers.

- `features/readaloud-extension/extension/src/tts/ModalKokoroProvider.js`
  Builds the same request shape but supports bearer auth headers for Modal-style endpoints.

### Backend

- `features/readaloud-extension/backend/app.py`
  FastAPI proxy. Exposes `GET /health`, `POST /tts`, and `POST /tts/stream`. Chooses local or Modal client based on `TTS_MODE`.

- `features/readaloud-extension/backend/tts_local.py`
  Client for a local Kokoro server at `LOCAL_KOKORO_URL` or `http://localhost:8880`. Sends OpenAI-style `/v1/audio/speech` requests and supports streaming.

- `features/readaloud-extension/backend/tts_modal.py`
  Client for a deployed Modal endpoint, configured by `MODAL_TTS_URL` and optional `MODAL_TTS_TOKEN`.

- `features/readaloud-extension/backend/kokoro_modal_app.py`
  The Modal deployment itself. It loads Kokoro, selects a language pipeline from the voice prefix, streams a WAV header first, then yields PCM audio blocks as Kokoro generates them.

- `features/readaloud-extension/backend/test_streaming.py`
  Backend streaming tests.

### Tests and typed companions

- `features/readaloud-extension/extension/tests/*.test.js`
  Coverage for chunking, extraction, popup state, sync rules, library grouping, offscreen WAV streaming, and playback queue behavior.

- `features/readaloud-extension/extension/src/**/*.ts`
  Typed companions or declarations for some JS runtime modules. Current runtime wiring points at the `.js` files.

## The most important runtime flow: user presses Play in the popup

This is the exact call chain for the common chapter-page case.

1. In `popup.js`, the `#play` button click handler calls:
   `request(isPauseable(lastState) ? "PAUSE" : "PLAY")`

2. `request()` sends:
   `chrome.runtime.sendMessage({ scope: "readaloud", type: "PLAY", payload })`

3. `service_worker.js` receives the message in `chrome.runtime.onMessage`, then routes it through:
   `handleScopedRequest(message, sender)`

4. For `PLAY`, the service worker calls:
   `queue.start({ ...payload, tabId })`

5. `PlaybackQueue.start()` immediately serializes the operation through:
   `runExclusive(() => startExclusive(options))`

6. `startExclusive()` decides what kind of page the user is on:
   - story overview page: use `startFromStoryContext()`
   - chapter page with existing cached session: resume or restart that session
   - chapter page with no session yet: extract text fresh with `resolvePlaybackInput()`

7. If text must be read from the page, `resolvePlaybackInput()` sends:
   `READALOUD_EXTRACT_TEXT`
   to the content script in the active tab.

8. In `content.js`, the runtime message handler calls:
   `extractWattpadTextFromDocument(document)`

9. The extraction result returns to `PlaybackQueue`, which creates a session with:
   `createSessionFromInput()`

10. The queue persists chunk metadata by calling:
    `ensureChapterData(preparedSession)`
    which internally calls `chunkText()` and stores chapter/chunk records in IndexedDB.

11. The queue ensures the audio runtime exists:
    `ensureOffscreenDocument()`

12. The queue interrupts any competing warmup fetches so playback startup gets backend priority:
    `interruptWarmupFetches()`

13. The queue starts playback orchestration:
    `processSession(chapterId)`

14. `processSession()` does three things:
    - `ensureWarmingPipeline(chapterId)` to keep filling the cache
    - `ensureNextChapterPrefetch(session)` to open the next chapter in a background tab
    - `startCurrentChunkStream(chapterId)` to play the current chunk now

15. `startCurrentChunkStream()` loads the current chunk record, checks whether offscreen already has:
    - an active slot for that chunk
    - or a prepared cached slot
    - or nothing yet

16. It then dispatches one of:
    - `dispatchStartPreparedStream(...)`
    - `dispatchStreamPlayback(...)`

17. `offscreen.js` receives:
    - `START_PREPARED_STREAM`
    - or `START_STREAM_PLAYBACK`

18. `offscreen.js` creates a stream slot with `createSlot()`, resolves either:
    - a cached IndexedDB blob turned into an object URL
    - or a live HTTP request from `provider.createStreamRequest(...)`

19. `WavStreamPlayer.open()` performs the fetch. For live playback that means:
    `POST http://localhost:3000/tts/stream`

20. `backend/app.py` receives `/tts/stream` and chooses:
    - `LocalKokoroClient.stream_synthesize(...)` when `TTS_MODE=local`
    - `ModalKokoroClient.stream_synthesize(...)` when `TTS_MODE=modal`

21. The selected backend streams WAV bytes back to the offscreen document.

22. `WavStreamPlayer`:
    - parses the WAV header with `parseWavHeader()`
    - queues PCM bytes
    - starts playback when enough buffered audio exists
    - emits `onConnected`, `onFirstByte`, `onReady`, `onStarted`, `onProgress`, and `onEnded`

23. `offscreen.js` converts those player callbacks into runtime messages like:
    - `STREAM_PLAYBACK_PROGRESS`
    - `CHUNK_PLAYBACK_STARTED`
    - `CHUNK_PLAYBACK_ENDED`
    - `CHUNK_PLAYBACK_ERROR`

24. `PlaybackQueue.handleRuntimeMessageExclusive()` receives those events and updates the stored session:
    - on start: marks playback as live, records recents, focuses the active paragraph on the page
    - on progress: updates bytes received, buffered ms, and current chunk offset
    - on end: advances to the next chunk or the next chapter
    - on error/interruption: retries or fails the session

25. The popup keeps polling `GET_STATE`, so the UI updates without direct coupling to the offscreen document.

## What happens before Play: chapter warmup

Warmup usually starts when the user lands on a Wattpad chapter page, before the user presses Play.

1. `content.js` runs immediately on the page.

2. It calls `notifyPageReadyIfChanged(document)`.

3. If the page is a Wattpad chapter, `notifyPageReady()` sends:
   `PAGE_READY`
   with the extracted chapter payload.

4. `service_worker.js` routes `PAGE_READY` to:
   `queue.warmup(...)`

5. `PlaybackQueue.warmupExclusive()` either:
   - resumes an existing warm session
   - or creates a new session in `startup_ready`

6. It calls:
   - `ensureChapterData()` to persist chunk metadata
   - `maybeStartStorySync()` if sync is enabled for this story

7. `maybeStartStorySync()` triggers:
   - `ensureWarmingPipeline(session.chapterId)`
   - `ensureNextChapterPrefetch(session)`

8. `runWarmingPipeline()` loops over the next unwarmed chunk and calls:
   - `findNextChunkToWarm()`
   - `resolveWarmupGate()`
   - `fetchAudioForChunk()`
   - `saveAudioRecord()`
   - `markChunkStatus(chunkId, "ready")`

9. The warm audio blob is saved in IndexedDB under the voice-specific cache chapter ID.

Important warmup rule:

- warmup yields when playback startup is in flight
- warmup also yields when some other chapter is active and still has unwarmed chunks

That rule lives in `resolveWarmupGate()`. It prevents cache generation from starving live playback.

## How scraping works

All Wattpad scraping happens in the content script.

### Chapter extraction

Main function:

- `extractWattpadTextFromDocument(documentRef)`

Strategy order:

1. Confirm the page looks like a Wattpad reading page with `isWattpadReadingDocument()`.
2. Prefer live DOM extraction from:
   `article.story-part[data-part-id] p[data-p-id]`
3. Clean each paragraph by cloning it and removing embedded UI fragments like component wrappers, comment markers, buttons, and SVGs.
4. Build a high-confidence result with `buildSuccess(...)`.
5. If DOM extraction fails, fall back to embedded page payload extraction through `extractEmbeddedStoryTextFromHtml(...)`.

Validation:

- minimum paragraph count
- minimum text length
- reject contaminated page chrome phrases like "vote", "share via twitter", or "continue to next part"

Extra metadata scraped at the same time:

- `storyId`
- `partId`
- canonical part URL
- current chapter title
- `nextPart`
- `firstPart`

`nextPart` matters for prefetch and auto-advance. `firstPart` matters for sync backfill when the user enables sync in the middle of a story.

### Story overview extraction

Main function:

- `extractWattpadStoryInfoFromDocument(documentRef)`

It pulls:

- story ID
- story title
- author
- cover URL
- avatar URL
- first part URL

This data feeds the library grouping and Sync-from-story-page behavior.

### Why page notifications happen more than once

`content.js` attaches:

- `MutationObserver`
- `visibilitychange`
- `click`
- `popstate`
- `hashchange`

That is intentional. Wattpad pages can lazy-load or route without a full reload, so the content script re-checks the page and re-sends `PAGE_READY` or `STORY_PAGE_READY` when the page signature changes.

## How chunking works

Chunking happens in `chunkText.js`.

- `stableHash(input)` creates deterministic hashes.
- `chunkText(text, options)` produces chunk records with:
  - `chunkIndex`
  - `text`
  - `chunkId`
  - `paragraphIds`
  - `paragraphId`

Rules:

- prefer paragraph boundaries first
- split long paragraphs by sentence
- if a sentence is still too long, hard-split by character limit
- chunk IDs include chapter identity plus text hash, so identical text produces stable chunk IDs

Stable chunk IDs matter because the cache layer needs to recognize that old audio is still valid when the chapter content has not changed.

## How cached data is stored

There are two persistence layers.

### `chrome.storage.local`

Used for lightweight session and control data:

- active chapter ID
- per-chapter playback session
- sync-enabled stories
- next-chapter prefetch record
- sync backfill record
- sleep timer
- last played cursor by story
- resume target record
- user settings

### IndexedDB

Defined in `idb.js` stores:

- `chapters`: one record per cached chapter variant
- `chunks`: text chunks and chunk statuses
- `audioChunks`: audio blobs by chunk
- `stories`: scraped story metadata

Important detail:

- audio is cached per voice
- the cache key is `chapterId::voice:<voiceId>`

That is why the queue keeps both:

- `chapterId`: the logical Wattpad chapter
- `cacheChapterId`: the voice-specific cache variant

## How offscreen playback works

The service worker does not play audio itself. Manifest V3 service workers are not the right place for long-lived audio playback, so the extension uses an offscreen document.

Main offscreen functions:

- `startLiveStream(message)`
- `prepareStream(message)`
- `promotePreparedStream(message)`
- `stopAllSlots()`
- `clearActiveSlot()`

The offscreen document maintains stream slots:

- one active slot for the chunk currently being heard
- zero or more prepared slots for lookahead chunks already cached in IndexedDB

Important detail:

- prepared slots only read from the local warm cache
- they do not hit `/tts/stream`

That avoids synthesizing the same lookahead chunk twice.

## How `WavStreamPlayer` turns bytes into sound

`wavStreamPlayer.js` is the low-level streaming player.

Main steps:

1. `open(request)` starts fetch streaming.
2. `consumeStream(reader)` reads byte chunks from the response body.
3. `appendBytes(chunk)` accumulates bytes until the WAV header is complete.
4. `parseWavHeader()` extracts sample rate, bit depth, channels, and data offset.
5. PCM bytes enter `ByteQueue`.
6. `maybeStartPlayback()` waits until enough audio is buffered.
7. `schedulePendingAudio()` creates `AudioBufferSourceNode`s and schedules them into the shared `AudioContext`.
8. `emitProgress()` reports buffered ms, played ms, and stream state.
9. `finishIfDrained()` emits the end event when the stream and queue are both exhausted.

It also supports:

- start offsets for resume-from-middle playback
- pause/resume
- buffering detection
- progress reporting
- prepared mode, where audio is buffered without auto-start

## Paragraph click flow

If the user clicks directly on a paragraph in the Wattpad page:

1. `content.js` intercepts the click in `handleParagraphClick(event)`.
2. It finds `p[data-p-id]`.
3. It sends:
   `PLAY_FROM_PARAGRAPH`
   with `chapterId` and `paragraphId`.
4. `PlaybackQueue.playFromParagraphExclusive()` resolves or creates the session.
5. It ensures chapter data exists.
6. It finds the matching chunk via `findChunkForParagraph(...)`.
7. It stops current playback, focuses the chosen paragraph, and starts playback from that chunk.

This is why chunk records preserve paragraph IDs.

## Story page Play flow

If the user presses Play while on a Wattpad story overview page instead of a chapter page:

1. `startExclusive()` sees `pageContext.kind === "story"`.
2. It calls `startFromStoryContext(context)`.
3. `resolveStoryStartRecord(context)` decides where to begin:
   - resume the last played chapter for that story if one exists
   - otherwise start from chapter 1 using story metadata or the page's first-part link
4. Playback then continues through the same resume/start path as a chapter page.

## Pause, stop, and resume

### Pause

- popup sends `PAUSE`
- queue stores the current offset, marks session `paused`, records last played, and sends `PAUSE_PLAYBACK` to the offscreen document

Paused playback can resume without rebuilding the session if the offscreen slot still exists.

### Stop

- popup sends `STOP`
- queue stores the final offset, clears page highlight, marks the session `ended`, records last played, and sends `STOP_PLAYBACK`

Stop does not delete cached audio. It only ends the live playback session.

### Resume

Resume can happen from:

- Play on a paused chapter
- Continue in the library
- Play from a story overview page

The main helpers are:

- `continueStory()`
- `resumeFromStoredRecord()`
- `activateResumedChapter()`

## Voice switching

When the popup voice selector changes:

1. `popup.js` sends `PLAYBACK_SET_VOICE`.
2. `PlaybackQueue.switchVoiceExclusive()` folds the current playback clock and captures the current chunk offset.
3. It stops offscreen playback.
4. It switches `voice` and recomputes `cacheChapterId`.
5. It sets `fullWarmupRequested = true`.
6. It either:
   - resumes playback immediately in the new voice
   - or just restarts warming if playback is not active

Because caches are voice-specific, switching voice creates or reuses a different chapter variant in IndexedDB.

## Sync, prefetch, and auto-advance

Sync is the feature that keeps following the reader across a story.

### Sync toggle logic

Pure planning lives in `syncState.js`.

- `applySyncToggle(...)`: store whether sync is enabled for a story
- `planSyncStart(context)`: decide the first actions when sync turns on

From a chapter page, Sync can trigger:

- warm the current chapter
- optionally backfill chapter 1 if the reader is mid-story
- prefetch the next chapter

From a story overview page, Sync starts with chapter 1.

### Next chapter prefetch

Main functions:

- `ensureNextChapterPrefetch(session)`
- `openNextChapterPrefetch(session)`
- `processPrefetchedTab(record)`
- `warmupPrefetchedChapter(record, extraction)`

The queue opens the next part in a background tab, extracts it, stores a warm session for it, and starts warming its audio. Playback does not switch to that chapter until the current chapter actually ends.

### Auto-advance

When the last chunk of a chapter ends:

1. `CHUNK_PLAYBACK_ENDED` reaches the queue.
2. `applyPlaybackEnded()` advances the chunk index or marks the chapter ended.
3. If the chapter ended, the queue calls `advanceToNextChapter(...)`.
4. If the prefetched next chapter is ready, `activatePrefetchedChapter(...)` starts it immediately.
5. If it is still loading, the queue marks `playOnReady` and waits.
6. If no prefetch exists, it opens the next part directly.

### Backfill

Backfill is how Sync gets chapter 1 when the user turns Sync on in the middle of a story.

Main functions:

- `openSyncBackfill(...)`
- `processBackfillTab(record)`

It opens the first chapter in a background tab, extracts it, stores it like any other warm session, and optionally chains prefetch behind it.

## Sleep timer

Sleep logic lives in `PlaybackQueue` and uses `chrome.alarms`.

Supported modes:

- duration
- end of chapter
- off

Important behavior:

- duration mode pauses playback when the timer expires
- end-of-chapter mode lets the current chapter finish, then stops before auto-advance
- sync downloads are not cancelled when sleep fires

## Backend and Kokoro flow

### FastAPI proxy

`backend/app.py` is the stable API the extension talks to.

Routes:

- `GET /health`
- `POST /tts`
- `POST /tts/stream`

Mode selection:

- `TTS_MODE=local`: forward to local Kokoro
- `TTS_MODE=modal`: forward to deployed Modal endpoint

### Local Kokoro path

`tts_local.py` sends OpenAI-compatible requests to:

- `http://localhost:8880/v1/audio/speech`

It uses `httpx` and supports both full-response and streaming-response modes.

### Modal path

`tts_modal.py` forwards to the deployed Modal endpoint from:

- `MODAL_TTS_URL`
- `MODAL_TTS_TOKEN`

### Modal Kokoro deployment

`kokoro_modal_app.py` does the actual hosted inference:

- creates a Modal image with `kokoro`, `soundfile`, `numpy`, and `fastapi`
- pre-downloads Kokoro assets
- loads a `KPipeline`
- chooses language family from the voice prefix
- yields a streaming WAV header
- yields PCM blocks as Kokoro generates audio

That means the browser can start buffering and then playing before the whole sentence or chapter is synthesized.

## A few implementation details worth knowing

- The popup does not own authoritative state. It polls `GET_STATE`.
- The offscreen document is the only place that should own active stream playback.
- Warmup and playback intentionally compete for the same backend, and `resolveWarmupGate()` is the arbiter.
- `content.js` and `wattpadExtractor.js` duplicate some extraction logic because the runtime version needs page-side behavior while the test version stays pure.
- Story metadata is optional but improves library grouping, author display, and "play from story page" behavior.
- Resume and sync both depend heavily on stored cursors and chapter IDs, not only URLs.

## Local development

From the repository root:

```bash
cd features/readaloud-extension
npm test
python3 -m py_compile backend/app.py backend/tts_local.py backend/tts_modal.py
python3 -m unittest backend/test_streaming.py
```

Backend startup with the current compose defaults:

```bash
cd features/readaloud-extension
MODAL_TTS_URL=<your deployed Modal endpoint> MODAL_TTS_TOKEN=<token> docker compose up --build
```

Local Kokoro fallback:

```bash
cd features/readaloud-extension
TTS_MODE=local docker compose --profile local up --build
```

Then load `features/readaloud-extension/extension/` as an unpacked Chrome extension.

For the current Modal-oriented setup and the local Kokoro fallback, also read:

- `features/readaloud-extension/README.md`
- `features/readaloud-extension/IMPLEMENTATION.md`

## Quick mental model

If you want one sentence for each major layer:

- popup: asks for actions and renders current state
- service worker: routes actions into one state machine
- playback queue: decides what chapter/chunk should happen next
- content script: understands Wattpad pages
- IndexedDB: stores chapter text structure and cached audio blobs
- offscreen document: performs stream playback
- FastAPI proxy: presents one stable TTS API to the extension
- Kokoro: produces the actual audio bytes
