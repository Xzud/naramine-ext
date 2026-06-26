# Naramine Readaloud Extension Technical Detail

This document explains how the current readaloud extension is connected end to
end: popup commands, Wattpad page extraction, background orchestration, TTS
streaming, IndexedDB caching, playback, library state, Sync, and sleep timer.

Runtime entry points are JavaScript files under
`features/readaloud-extension/extension/src/`. Some TypeScript companion files
exist in the same folders, but the Chrome extension manifest points at the
JavaScript files.

This file is the broad overview. For slower, more specific explanations, read
the companion guides in this folder:

- `README.md`
- `01_CODEBASE_MAP.md`
- `02_EXTENSION_RUNTIME_AND_MESSAGES.md`
- `03_WATTPAD_EXTRACTION_AND_CHUNKING.md`
- `04_STATE_STORAGE_AND_CACHE.md`
- `05_TTS_STREAMING_AND_AUDIO_PLAYBACK.md`
- `06_PLAYBACK_QUEUE_FEATURES.md`
- `07_POPUP_OPTIONS_AND_VIEW_MODELS.md`
- `08_BACKEND_AND_TESTING.md`
- `09_GLOSSARY_AND_READING_NOTES.md`

## High-Level Architecture

Naramine is a Chrome Manifest V3 extension backed by a local FastAPI proxy.

Main components:

- `features/readaloud-extension/extension/manifest.json`
  - Declares the Chrome extension.
  - Uses `src/background/service_worker.js` as the Manifest V3 service worker.
  - Uses `src/popup/popup.html` as the extension popup.
  - Injects `src/content/content.js` into pages.
  - Exposes `src/offscreen/offscreen.html` so background audio can keep playing
    outside the popup.

- `features/readaloud-extension/extension/src/popup/popup.js`
  - UI controller for play, pause, stop, voice switching, library, Sync, sleep
    timer, and guide/recents.
  - Sends typed messages to the background service worker.

- `features/readaloud-extension/extension/src/content/content.js`
  - Runs in browser pages.
  - Detects Wattpad chapter pages and story overview pages.
  - Extracts chapter text, story metadata, paragraph IDs, next-part URLs, and
    first-part URLs.
  - Sends page-ready messages to the background.
  - Handles paragraph click playback and active paragraph highlighting.

- `features/readaloud-extension/extension/src/background/service_worker.js`
  - Receives extension messages.
  - Routes each message type to `PlaybackQueue`.
  - Adds the sender tab ID when available.

- `features/readaloud-extension/extension/src/audio/playbackQueue.js`
  - Main orchestration layer.
  - Owns session state, active chapter state, extraction resolution, playback
    dispatch, warmup/cache generation, Sync, prefetch, library deletion,
    continue/resume, sleep timer, and offscreen playback messages.

- `features/readaloud-extension/extension/src/offscreen/offscreen.js`
  - Runs in an offscreen document.
  - Owns live audio playback slots.
  - Checks IndexedDB for cached chunk audio before calling TTS.
  - Uses `WavStreamPlayer` to play WAV streams progressively.

- `features/readaloud-extension/extension/src/offscreen/wavStreamPlayer.js`
  - Fetches WAV streams.
  - Parses WAV headers.
  - Converts streamed PCM frames into Web Audio `AudioBuffer`s.
  - Schedules audio playback through `AudioContext`.

- `features/readaloud-extension/extension/src/db/idb.js`
  - IndexedDB storage layer.
  - Stores chapter records, text chunk records, audio chunk blobs, and story
    metadata.

- `features/readaloud-extension/backend/app.py`
  - FastAPI proxy used by the extension.
  - Provides `/tts` for full-response synthesis.
  - Provides `/tts/stream` for streaming synthesis.

## Technical Terms

- **Manifest V3 service worker**
  - Chrome extension background script.
  - It can be suspended by Chrome when idle, so persistent playback is moved to
    an offscreen document.
  - File: `extension/src/background/service_worker.js`.

- **Popup**
  - The small UI opened from the extension toolbar.
  - It cannot directly read Wattpad page DOM. It sends messages to the
    background.
  - File: `extension/src/popup/popup.js`.

- **Content script**
  - JavaScript injected into web pages.
  - It can read the Wattpad DOM and respond to extraction/page-context requests.
  - File: `extension/src/content/content.js`.

- **Offscreen document**
  - A hidden extension page used for audio playback that must outlive the popup.
  - File: `extension/src/offscreen/offscreen.html`.
  - Main logic: `extension/src/offscreen/offscreen.js`.

- **TTS**
  - Text-to-speech.
  - In this system, the extension sends text and voice to a backend endpoint,
    which returns WAV audio.

- **WAV**
  - An audio container format.
  - It starts with a RIFF/WAVE header that describes format details like sample
    rate, channels, and bits per sample.
  - After the header, the `data` section contains PCM audio frames.

- **PCM**
  - Raw audio samples.
  - `WavStreamPlayer` parses WAV, reads PCM frames, writes them into
    `AudioBuffer`s, and schedules those buffers in Web Audio.

- **Blob**
  - Browser object representing binary data.
  - Cached generated audio is stored as per-chunk WAV `Blob`s in IndexedDB.

- **IndexedDB**
  - Browser database used by the extension.
  - Stores structured records and audio blobs.
  - Storage file: `extension/src/db/idb.js`.

- **Chapter**
  - A Wattpad reading page/part.
  - Usually identified by `partId`; the code uses that as `chapterId`.

- **Chunk**
  - A smaller unit of chapter text.
  - Chunks are generated by `chunkText()` so TTS requests stay manageable.
  - File: `extension/src/text/chunkText.js`.

- **Session**
  - Current playback state for one chapter.
  - Stored in `chrome.storage.local` through `PlaybackQueue`.
  - Includes active chunk index, voice, title, stream status, cache ID, elapsed
    time, and page metadata.

- **Cache chapter ID**
  - The key used for cached audio records.
  - Voice variants use IDs like `chapterId::voice:voiceId`, so the same chapter
    can have multiple cached voices.

- **Warmup**
  - Background generation of audio blobs for chunks.
  - Warmup downloads chunk audio into IndexedDB so later playback can reuse it.

- **Live stream**
  - Immediate playback request to `/tts/stream`.
  - The player starts as soon as enough WAV bytes have arrived.

- **Prefetch**
  - Opening or preparing future chapter/chunk work before it is needed.
  - Used for next-chapter auto-advance and Sync.

- **Backfill**
  - Sync behavior that fetches the first chapter of a story when Sync is enabled
    from the middle of a story.

## Message Flow

The extension uses `chrome.runtime.sendMessage()` and
`chrome.tabs.sendMessage()` to connect popup, content script, background, and
offscreen document.

### Popup to Background

File: `features/readaloud-extension/extension/src/popup/popup.js`

The popup has a helper:

```js
async function request(type, payload = {}) {
  return await chrome.runtime.sendMessage({
    scope: "readaloud",
    type,
    payload
  });
}
```

Important detail: many popup calls send an empty payload:

```js
request("PLAY")
request("GET_STATE")
request("PAUSE")
request("STOP")
```

The popup often does not know the current page or chapter directly. The
background/queue resolves that using the active tab, page context, and stored
active session.

Popup message examples:

- `PLAY`
  - Starts or resumes playback.
- `PAUSE`
  - Pauses current playback session.
- `STOP`
  - Stops current playback session.
- `GET_STATE`
  - Returns current runtime state for rendering.
- `PAGE_CONTEXT_GET`
  - Lets popup decide whether to show player, guide, or library.
- `SYNC_GET` and `SYNC_SET`
  - Reads or updates per-story Sync state.
- `PLAYBACK_SET_VOICE`
  - Switches the current voice.
- `LIBRARY_GET`
  - Loads grouped downloaded/cached audio.
- `LIBRARY_DELETE_STORY`, `LIBRARY_DELETE_CHAPTER`,
  `LIBRARY_DELETE_CHAPTER_VOICE`
  - Deletes cached audio at different scopes.
- `LIBRARY_CONTINUE`
  - Resumes a story from last played progress.
- `SLEEP_GET` and `SLEEP_SET`
  - Reads or updates sleep timer.

### Content Script to Background

File: `features/readaloud-extension/extension/src/content/content.js`

The content script sends messages when it detects Wattpad pages:

- `PAGE_READY`
  - Sent for Wattpad chapter pages.
  - Payload includes extracted text, paragraph metadata, story ID, part ID,
    next-part metadata, first-part metadata, title, source URL, and detection
    flags.
  - Background routes this to `queue.warmup(...)`.

- `STORY_PAGE_READY`
  - Sent for Wattpad story overview pages.
  - Payload includes story metadata such as story ID, title, author, cover URL,
    avatar URL, source URL, and first-part URL.
  - Background routes this to `queue.handleStoryPageReady(...)`.

### Background Routing

File: `features/readaloud-extension/extension/src/background/service_worker.js`

`handleScopedRequest(message, sender)` receives messages where
`message.scope === "readaloud"`.

The background service worker adds:

```js
const tabId = sender?.tab?.id ?? null;
```

This matters because messages from content scripts include the real page tab ID.
Popup messages often do not include page details, so `PlaybackQueue` may query
the active tab directly.

Examples:

- `PAGE_READY`
  - Calls `queue.warmup({ ...message.payload, tabId })`.
- `PLAY`
  - Calls `queue.start({ ...message.payload, tabId })`.
- `PAGE_CONTEXT_GET`
  - Calls `queue.getPageContextStatus({ ...message.payload, tabId })`.
- `PAUSE`
  - Calls `queue.pause(message.payload?.chapterId || null)`.

### Background to Content Script

File: `features/readaloud-extension/extension/src/audio/playbackQueue.js`

The queue uses `sendPageCommand(tabId, message)` to call the content script.

Important page commands:

- `READALOUD_EXTRACT_TEXT`
  - Content script returns full chapter extraction.
- `READALOUD_GET_PAGE_CONTEXT`
  - Content script returns `{ kind: "chapter" | "story" | "none", ... }`.
- `READALOUD_SET_ACTIVE_CHUNK`
  - Content script highlights/scolls the active paragraph(s).
- `READALOUD_CLEAR_ACTIVE_CHUNK`
  - Content script clears highlight.

### Background to Offscreen Document

File: `features/readaloud-extension/extension/src/audio/playbackQueue.js`

The queue sends playback commands to the offscreen document:

- `START_STREAM_PLAYBACK`
  - Start active playback for a chunk.
- `PREPARE_STREAM_PLAYBACK`
  - Prepare/look ahead for an upcoming chunk.
- `START_PREPARED_STREAM`
  - Promote a prepared chunk stream to active playback.
- `PAUSE_PLAYBACK`
  - Pause offscreen audio.
- `RESUME_PLAYBACK`
  - Resume offscreen audio.
- `STOP_PLAYBACK`
  - Stop audio and release resources.
- `GET_PLAYBACK_STATUS`
  - Query active/prepared slot state.

### Offscreen to Background

Files:

- `features/readaloud-extension/extension/src/offscreen/offscreen.js`
- `features/readaloud-extension/extension/src/audio/playbackQueue.js`

The offscreen player sends runtime events back:

- `STREAM_PLAYBACK_PROGRESS`
  - Updates stream status, bytes received, buffered audio, and played time.
- `CHUNK_PLAYBACK_STARTED`
  - Marks playback as started and records progress.
- `CHUNK_PLAYBACK_ENDED`
  - Advances the session to the next chunk.
- `STREAM_PLAYBACK_ERROR`
  - Lets the queue retry or mark an error.
- `STREAM_PREPARE_READY`
  - Marks a prepared/lookahead chunk as ready.

## Page Detection and Extraction

Main files:

- `features/readaloud-extension/extension/src/content/content.js`
- `features/readaloud-extension/extension/src/content/wattpadExtractor.js`

The content script detects two Wattpad page types:

- Chapter reading page
  - `kind: "chapter"`
  - Detected by Wattpad reading-page signals like `route-storyReading`,
    `main#parts-container-new`, or `article.story-part[data-part-id]`.

- Story overview page
  - `kind: "story"`
  - Detected by `/story/<id>` URL pattern when it is not a reading page.

Chapter extraction prefers DOM paragraphs:

- Finds `article.story-part[data-part-id]`.
- Reads `p[data-p-id]`.
- Removes page chrome like comments, component wrappers, buttons, and SVGs.
- Keeps paragraph IDs so playback can later highlight the right paragraphs.
- Builds a text body joined by blank lines.

Fallback extraction:

- If DOM paragraphs are not enough, it looks for Wattpad embedded story text in
  the HTML payload.

Validation:

- Rejects extraction with too few paragraphs.
- Rejects text that is too short.
- Rejects likely contaminated text containing common UI phrases.

Story metadata extraction:

- Reads story ID, title, author, cover URL, avatar URL, source URL.
- Finds the first part URL so Sync can start from chapter 1.

Next-part extraction:

- Reads Wattpad's embedded `nextPart` payload when available.
- Falls back to table-of-contents links.
- Used for next-chapter prefetch and auto-advance.

## Text Chunking

File: `features/readaloud-extension/extension/src/text/chunkText.js`

The extension does not send a whole chapter to TTS at once. It splits chapter
text into chunks.

Constants:

- `MAX_CHARS = 600`
  - Preferred paragraph/sentence segment size.
- `MAX_CHUNK_CHARS = 1000`
  - Hard maximum stored chunk text size.

Chunking behavior:

- Source paragraphs are normalized.
- Long paragraphs are split by sentence.
- Very long sentences are cut into max-size pieces.
- Each chunk receives:
  - `storyId`
  - `chapterId`
  - `chunkIndex`
  - `text`
  - `textHash`
  - `chunkId`
  - `paragraphIds`
  - `paragraphId`

Chunk IDs are stable for the same story/chapter/text:

```txt
chapterId:chunkIndex:textHash
```

That lets the cache know whether existing audio still matches current text.

## IndexedDB Storage Model

File: `features/readaloud-extension/extension/src/db/idb.js`

Database:

- `DB_NAME = "readaloud_mvp"`
- `DB_VERSION = 2`

Object stores:

- `chapters`
  - Key: `chapterId`
  - Stores chapter/cache metadata.
  - Indexed by `storyId` and `expiresAt`.

- `chunks`
  - Key: `chunkId`
  - Stores text chunk metadata.
  - Indexed by `chapterId`, `[chapterId, chunkIndex]`, and
    `[chapterId, status]`.

- `audioChunks`
  - Key: `chunkId`
  - Stores generated audio blobs.
  - Indexed by `chapterId`, `[chapterId, chunkIndex]`, and `expiresAt`.

- `stories`
  - Key: `storyId`
  - Stores story overview metadata.

Important records:

- Chapter records include:
  - `chapterId`
  - `sourceChapterId`
  - `storyId`
  - `voice`
  - `title`
  - `sourceUrl`
  - `textHash`
  - `createdAt`
  - `expiresAt`

- Chunk records include:
  - text and paragraph anchor metadata
  - `status: "pending" | "ready" | "failed"`

- Audio chunk records include:
  - `chunkId`
  - `chapterId`
  - `chunkIndex`
  - `voice`
  - `blob`
  - `mimeType`
  - `sizeBytes`
  - `createdAt`
  - `expiresAt`

Retention:

- `CACHE_TTL_MS` is 30 days.
- Comment in `constants.js` says downloaded audio is intended to stay until
  user deletion, with TTL as a safety net against abandoned growth.
- Expired cleanup runs before new `start()` and new `warmup()` flows.

Deletion:

- `deleteChapterData()` removes a chapter, its chunks, and its audio blobs.
- `deleteStoryMetadata()` removes story overview metadata.
- Library delete actions call these through `PlaybackQueue`.

## TTS Providers and Backend

Extension provider files:

- `features/readaloud-extension/extension/src/tts/LocalKokoroProvider.js`
- `features/readaloud-extension/extension/src/tts/ModalKokoroProvider.js`
- `features/readaloud-extension/extension/src/tts/TTSProvider.js`

Backend files:

- `features/readaloud-extension/backend/app.py`
- `features/readaloud-extension/backend/tts_local.py`
- `features/readaloud-extension/backend/tts_modal.py`
- `features/readaloud-extension/backend/kokoro_modal_app.py`

The extension creates stream requests like:

```json
{
  "text": "chunk text here",
  "voice": "af_heart",
  "format": "wav",
  "chunk_id": "optional chunk id",
  "chapter_id": "optional chapter id"
}
```

Provider/backend mode clarification:

- Most extension playback requests go to the local proxy at
  `http://localhost:3000`.
- The backend decides whether that proxy forwards to local Kokoro or Modal by
  reading `TTS_MODE`.
- `providerMode: "direct-local"` bypasses the proxy and sends requests to
  `http://localhost:8880`.

Local provider class:

- Can build requests for `http://localhost:3000/tts/stream` by default.
- Can also be constructed for direct local mode through `http://localhost:8880`.

Modal provider:

- Builds proxy requests to `http://localhost:3000/tts/stream`.
- The FastAPI backend forwards to Modal when `TTS_MODE=modal`.

Backend endpoints:

- `/health`
  - Returns mode and status.

- `/tts`
  - Returns completed audio bytes in one response.
  - Used by non-stream/full-response synthesis paths.

- `/tts/stream`
  - Returns a streaming HTTP response.
  - Used by active playback and prepared stream playback.
  - Media type is usually `audio/wav`.
  - Adds `Cache-Control: no-store`.

Backend local mode:

- `tts_local.py` forwards to local Kokoro-compatible
  `/v1/audio/speech`.

Backend Modal mode:

- `tts_modal.py` forwards to the configured Modal endpoint using
  `MODAL_TTS_URL` and optional bearer token.

## Current Playback Flow

Main file:

- `features/readaloud-extension/extension/src/audio/playbackQueue.js`

Start sequence:

1. User presses Play in popup.
2. Popup sends `PLAY`.
3. Background routes to `queue.start(...)`.
4. `PlaybackQueue.startExclusive(...)` resolves the current page context.
5. If no `chapterId` was provided, it asks the active tab's content script for
   `READALOUD_GET_PAGE_CONTEXT`.
6. If the current page is a story overview, playback starts from the story's
   first/last relevant chapter record.
7. If the current page is a chapter, it uses the page `partId` as the active
   chapter.
8. It extracts or receives chapter text.
9. It creates/updates the session.
10. It ensures chapter/chunk metadata exists in IndexedDB.
11. It ensures the offscreen document exists.
12. It dispatches the current chunk to offscreen playback.

The queue updates session state through `chrome.storage.local`.

Important session fields:

- `chapterId`
- `storyId`
- `voice`
- `cacheChapterId`
- `tabId`
- `text`
- `paragraphs`
- `title`
- `sourceUrl`
- `partId`
- `nextPartId`
- `nextPartUrl`
- `state`
- `playbackStatus`
- `streamStatus`
- `currentChunkIndex`
- `currentChunkId`
- `totalChunks`
- `readyAudioCount`
- `playbackElapsedMs`
- `playbackResumedAt`
- `lastEvent`
- `errorMessage`

Runtime states are converted for the popup by:

- `features/readaloud-extension/extension/src/audio/runtimeState.js`

Popup display state is derived by:

- `features/readaloud-extension/extension/src/popup/popupState.js`

## Current Streaming and Cache Behavior

This is the key behavior discussed during review.

The current system has two related but separate paths:

- Active playback path
  - Plays the chunk now.
  - Uses the offscreen `WavStreamPlayer`.
  - Prefers cached audio if available.
  - Falls back to live `/tts/stream` if the chunk is not cached.

- Warmup/cache path
  - Generates future chunk audio in the background.
  - Fetches a full `Blob` response for one chunk at a time.
  - Saves the blob into IndexedDB.
  - Marks the chunk `ready`.

Current behavior is hybrid:

1. For a chunk about to play, offscreen checks IndexedDB by `chunkId`.
2. If an audio blob is found, it creates an object URL and plays the cached blob.
3. If no blob is found, it builds a live TTS stream request and plays that.
4. Separately, `PlaybackQueue.runWarmingPipeline(...)` keeps fetching uncached
   chunks and saving them into IndexedDB.

Important distinction:

- The current live playback stream is not automatically captured and saved as
  the cache blob.
- Warmup can make a separate TTS request for the same chunk to populate the
  cache.
- This is simpler to reason about but can duplicate TTS generation.

Relevant files:

- Active playback dispatch:
  - `features/readaloud-extension/extension/src/audio/playbackQueue.js`
  - Methods: `processSession(...)`, `startCurrentChunkStream(...)`,
    `dispatchStreamPlayback(...)`.

- Cached/live request decision:
  - `features/readaloud-extension/extension/src/offscreen/offscreen.js`
  - Methods: `loadCachedAudio(...)`, `resolveStreamRequest(...)`.

- Warmup saving:
  - `features/readaloud-extension/extension/src/audio/playbackQueue.js`
  - Methods: `ensureWarmingPipeline(...)`, `runWarmingPipeline(...)`,
    `fetchAudioForChunk(...)`, `saveAudioRecord(...)`.

- IndexedDB write:
  - `features/readaloud-extension/extension/src/db/idb.js`
  - Function: `saveAudioChunk(...)`.

## How WAV Streaming Works

Main file:

- `features/readaloud-extension/extension/src/offscreen/wavStreamPlayer.js`

The TTS server returns WAV bytes. The extension does not convert another audio
format to WAV.

Streaming steps:

1. `WavStreamPlayer.open(request)` calls `fetch(...)`.
2. It checks `response.body`.
3. It gets a stream reader with `response.body.getReader()`.
4. `consumeStream(reader)` repeatedly calls `reader.read()`.
5. Each received `Uint8Array` is appended to the player.
6. Before playback can start, `parseWavHeader(...)` finds:
   - RIFF header
   - WAVE marker
   - `fmt ` chunk
   - `data` chunk
7. After the data section begins, bytes are treated as PCM frames.
8. `schedulePendingAudio()` reads aligned PCM frames from the internal queue.
9. It creates a Web Audio `AudioBuffer`.
10. `decodeFramesIntoBuffer(...)` writes samples into the `AudioBuffer`.
11. The player creates an `AudioBufferSourceNode`.
12. The source is scheduled on the shared `AudioContext`.

Why the header matters:

- WAV audio needs format metadata before raw samples can be interpreted.
- The player needs sample rate, channel count, bits per sample, and byte
  alignment.

Why buffering matters:

- Playback does not need the full chunk before starting.
- It waits until enough audio is buffered, then schedules small blocks while
  more bytes arrive.

## Current vs Better Stream-Persist Architecture

Current architecture:

- Playback stream asks TTS for a chunk so it can play immediately.
- Warmup can separately ask TTS for the same chunk so it can save a blob.
- Playback prefers cache when present but does not persist the exact live stream
  it just played.

Better architecture for avoiding duplicate TTS:

1. Request each chunk once.
2. Stream the WAV response to playback immediately.
3. Also collect the exact same bytes while they arrive.
4. When the stream finishes successfully, create a WAV `Blob` from the collected
   bytes.
5. Save that completed blob to IndexedDB.
6. Mark the chunk `ready` only after the full blob is persisted.
7. If the stream fails midway, do not mark it cached/ready.

The better design should still keep per-chunk storage instead of appending a
single giant chapter file. Per-chunk storage preserves resume, seek, voice
variants, invalidation, deletion, and partial chapter caching.

Why the current design may exist:

- Separating playback and cache simplifies correctness.
- Full-response `Blob` saving is easier than stream teeing.
- Partial stream failure handling is simpler.
- Offscreen playback can treat cached and live sources uniformly.

Tradeoff:

- Current design is simpler but may duplicate TTS work.
- Stream-persist design is more efficient but needs careful handling of partial
  streams, finalization, cache status, retries, and memory growth.

## Warmup Pipeline

Main file:

- `features/readaloud-extension/extension/src/audio/playbackQueue.js`

Warmup is the background process that fills the audio cache.

Core methods:

- `ensureWarmingPipeline(chapterId)`
  - Starts one warmup pipeline per chapter.
  - Reuses an existing active pipeline if one already exists.

- `runWarmingPipeline(chapterId)`
  - Loads the session.
  - Finds the next uncached chunk.
  - Checks whether playback startup should take priority.
  - Calls TTS for the chunk.
  - Saves the returned blob to IndexedDB.
  - Marks the chunk `ready`.

- `findNextChunkToWarm(...)`
  - Scans chunk records and cached audio IDs.
  - Selects the next pending chunk not already cached.

- `resolveWarmupGate(...)`
  - Prevents warmup from competing with active playback startup.
  - Gives the active chapter priority over background/prefetched chapters.

- `interruptWarmupFetches(...)`
  - Aborts in-flight warmup fetches when a user playback request needs the TTS
    backend immediately.

Warmup floor:

- If a session has never started playback, warmup can start from the beginning.
- If playback has started, warmup generally works ahead of the current playhead.
- If full warmup is requested, it can warm from the start.

## Offscreen Playback Slots

Main file:

- `features/readaloud-extension/extension/src/offscreen/offscreen.js`

The offscreen document manages stream slots.

Slot roles:

- `active`
  - The chunk currently responsible for audible playback.

- `prepared`
  - A lookahead chunk that has started buffering but is not yet audible.

The queue uses prepared slots for smoother handoff:

- Current chunk plays through active slot.
- Next chunk can be prepared in advance.
- If the prepared slot is ready when needed, the queue promotes it.
- If promotion fails, it starts a normal stream request.

Cached audio path:

1. Offscreen receives a playback command for `chunkId`.
2. It calls `getAudioChunk(chunkId)`.
3. If a blob exists, it creates `URL.createObjectURL(blob)`.
4. It fetches that object URL through the same `WavStreamPlayer` logic.
5. It revokes object URLs when slots are released.

Live TTS path:

1. If cache miss, offscreen builds a TTS stream request.
2. It fetches `/tts/stream`.
3. `WavStreamPlayer` consumes response bytes progressively.

## Chapter Progress and Highlighting

Files:

- `features/readaloud-extension/extension/src/audio/playbackQueue.js`
- `features/readaloud-extension/extension/src/content/chunkFocus.js`
- `features/readaloud-extension/extension/src/content/content.js`

Each chunk stores paragraph IDs from Wattpad. During playback, the queue asks
the content script to highlight the active chunk:

- Message: `READALOUD_SET_ACTIVE_CHUNK`
- Payload includes:
  - `chapterId`
  - `chunkId`
  - `paragraphIds`
  - `scroll`
  - `highlight`

`chunkFocus.js`:

- Adds a style tag for active paragraph styling.
- Finds `p[data-p-id="<id>"]`.
- Adds a CSS class.
- Scrolls to the active paragraph when requested.
- Re-applies highlight after DOM mutations.

Paragraph click playback:

- Content script can send `PLAY_FROM_PARAGRAPH`.
- Background routes to `queue.playFromParagraph(...)`.
- Queue maps paragraph ID to chunk ID/index.
- Playback starts from that chunk.

## Library Feature

Files:

- `features/readaloud-extension/extension/src/audio/playbackQueue.js`
- `features/readaloud-extension/extension/src/db/idb.js`
- `features/readaloud-extension/extension/src/shared/libraryState.js`
- `features/readaloud-extension/extension/src/popup/popup.js`
- `features/readaloud-extension/extension/src/options/options.js`

Purpose:

- Show downloaded/cached audio grouped by story.
- Show progress, cache size, status, and voice variants.
- Allow deletion of story/chapter/voice cache data.
- Allow continuing from last played position.

Data source:

- `getLibraryOverview()` reads `chapters`, `chunks`, and `audioChunks` from
  IndexedDB.
- It computes chunk counts, ready audio counts, failed counts, size, and voice
  variants.

Grouping:

- `groupLibraryByStory(...)` groups chapters by `storyId`.
- Uses stored story metadata when available.
- Falls back to title heuristics when metadata is missing.

Statuses:

- `downloaded`
  - Every chunk has cached audio.
- `processing`
  - A warmup pipeline is active or pending.
- `paused`
  - Partial download exists but no active pipeline is working it.

Deletion:

- Story deletion:
  - Deletes all cached chapter variants for that story.
  - Turns Sync off for the story.
  - Deletes story metadata.
  - Removes last-played record.

- Chapter deletion:
  - Stops active playback if needed.
  - Deletes session and chapter-scoped IndexedDB records.

- Voice deletion:
  - Deletes only the selected voice variant cache.
  - Stops playback if the active voice variant is being deleted.

## Recents and Continue

Main file:

- `features/readaloud-extension/extension/src/audio/playbackQueue.js`

The queue records per-story last played progress.

Stored cursor fields include:

- `storyId`
- `chapterId`
- `chapterTitle`
- `partUrl`
- `voice`
- `chunkIndex`
- `chunkOffsetMs`
- `chapterOffsetMs`
- `totalChunks`
- `updatedAt`

Recents:

- `getRecentlyPlayed(...)` returns the latest story/chapter cursors.
- Popup guide displays these when the active page is unsupported.

Continue:

- `continueStory(...)` gets the last-played record.
- If an existing tab/session can be reused, it activates that.
- Otherwise it opens the Wattpad chapter URL and resumes through the normal
  page-ready/extraction flow.

## Sync Feature

Files:

- `features/readaloud-extension/extension/src/audio/playbackQueue.js`
- `features/readaloud-extension/extension/src/shared/syncState.js`
- `features/readaloud-extension/extension/src/popup/popup.js`

Sync is per story.

Stored state:

- Key: `SYNC_STORIES_KEY` in `chrome.storage.local`.
- Value tracks enabled stories by `storyId`.

Popup behavior:

- `SYNC_GET` asks which story the toggle applies to.
- `SYNC_SET` enables or disables Sync for that story.

Context resolution:

- Prefer live page context.
- Fall back to the active session's story ID when the page cannot answer.

When Sync turns on:

- From a chapter page:
  - Warm the current chapter.
  - Backfill chapter 1 if the user is not already on chapter 1.
  - Prefetch the next chapter.

- From a story overview page:
  - Open/warm chapter 1.
  - Optionally chain next chapter from chapter 1.

When Sync is already on:

- Visiting a chapter warms that chapter.
- The next chapter is prefetched.
- The warmup gate keeps focused/active work ahead of background work.

Backfill:

- Opens a background tab for chapter 1.
- Extracts and warms that page.
- Avoids duplicate backfill records.

## Next-Chapter Prefetch and Auto-Advance

Main file:

- `features/readaloud-extension/extension/src/audio/playbackQueue.js`

Prefetch uses `nextPartUrl` and `nextPartId` extracted from Wattpad.

Flow:

1. Current session knows the next chapter URL.
2. Queue calls `ensureNextChapterPrefetch(session)`.
3. It opens the next chapter in a background tab.
4. When the tab finishes loading, the queue extracts text with retry.
5. It creates session/chunk data for the next chapter.
6. It starts warmup.
7. At chapter end, auto-advance can activate the prefetched tab and start
   playback.

Single-flight behavior:

- `nextChapterPrefetchTask` prevents duplicate immediate prefetch tasks.
- A stored prefetch record prevents repeated tab openings for the same next
  chapter.

## Voice Settings and Voice Switching

Files:

- `features/readaloud-extension/extension/src/shared/userSettings.js`
- `features/readaloud-extension/extension/src/audio/playbackQueue.js`
- `features/readaloud-extension/extension/src/popup/popup.js`
- `features/readaloud-extension/extension/src/options/options.js`

Available voices are defined in `VOICE_OPTIONS`.

Default voice:

- Stored under `USER_SETTINGS_KEY`.
- Loaded through `loadUserSettings(...)`.
- Normalized against known voice IDs.

Voice switch behavior:

- Popup sends `PLAYBACK_SET_VOICE` with `voiceId`.
- Queue resolves current chapter.
- Session `voice` changes.
- `cacheChapterId` changes to `chapterId::voice:voiceId`.
- Existing cache for that voice can be reused.
- If playback was active, the queue can resume/restart with the new voice.
- Warmup starts for the new voice variant.

Why cache ID includes voice:

- Different voices produce different audio.
- Same chunk text with a different voice must not reuse the wrong audio.

## Sleep Timer

Files:

- `features/readaloud-extension/extension/src/audio/playbackQueue.js`
- `features/readaloud-extension/extension/src/popup/popup.js`

Modes:

- `off`
- `duration`
- `end_of_chapter`

Duration mode:

- Stores a deadline.
- Schedules a Chrome alarm.
- Alarm can wake the service worker even while offscreen audio is running.
- When the alarm fires, playback stops or pauses according to queue handling.

End-of-chapter mode:

- Stores the mode without a deadline.
- When the current chapter ends, the queue stops instead of continuing.

Popup:

- Polls `SLEEP_GET`.
- Sends `SLEEP_SET`.
- Renders remaining time or chapter mode.

## Popup Views

Files:

- `features/readaloud-extension/extension/src/popup/popup.js`
- `features/readaloud-extension/extension/src/popup/popupState.js`
- `features/readaloud-extension/extension/src/popup/popup.html`

Top-level popup views:

- Player
  - Shown when active tab is a supported Wattpad page or playback is active.

- Guide
  - Shown on unsupported pages.
  - Includes recent reads.

- Library
  - Shows downloaded/cache state grouped by story.

`selectPrimaryView(...)` decides between these using:

- page context
- runtime state
- library open state

Player display derives:

- title
- pause/play button state
- elapsed timer
- warmed ratio
- chapter progress ratio
- error/off-page message
- current voice

## Options Page

File:

- `features/readaloud-extension/extension/src/options/options.js`

The options page shares some behavior with the popup:

- Reads settings.
- Saves default voice.
- Shows library.
- Deletes story/chapter/voice cached data.
- Continues a story.

It sends the same `scope: "readaloud"` messages to the background.

## Runtime State and Error Handling

Files:

- `features/readaloud-extension/extension/src/audio/runtimeState.js`
- `features/readaloud-extension/extension/src/audio/playbackQueue.js`
- `features/readaloud-extension/extension/src/background/service_worker.js`

Runtime state is the structured response returned to popup/options.

It includes:

- chapter/story identifiers
- title
- playback state
- stream status
- current chunk info
- cache counts
- extraction strategy/confidence
- last event
- error message
- state availability

If a background request fails:

- `service_worker.js` catches the error.
- It asks `PlaybackQueue` to build a structured failure state.
- If even that fails, it returns a minimal `createRuntimeState(...)` error.

This keeps the popup from crashing on service worker or queue failures.

## Data Ownership Summary

Popup owns:

- UI events.
- Rendering.
- Calling background commands.

Content script owns:

- Wattpad DOM reading.
- Page context.
- Paragraph click handling.
- Active paragraph highlighting.

Background service worker owns:

- Message routing.
- `PlaybackQueue` instance.

PlaybackQueue owns:

- Session state.
- Active chapter ID.
- Chapter/chunk metadata creation.
- Playback dispatch.
- Cache warmup.
- Prefetch/backfill.
- Sync.
- Library deletion.
- Recents/continue.
- Sleep timer.

Offscreen document owns:

- Actual audio playback.
- Cached-vs-live stream request selection.
- WAV stream consumption.
- Playback status events.

IndexedDB owns:

- Persistent chapter metadata.
- Persistent text chunk metadata.
- Persistent cached audio blobs.
- Persistent story metadata.

Backend owns:

- Forwarding text/voice requests to Kokoro or Modal.
- Returning WAV bytes as full responses or streams.

## End-to-End First Play Example

Scenario: user opens a Wattpad chapter and presses Play.

1. Content script detects the chapter and sends `PAGE_READY`.
2. Background calls `queue.warmup(...)`.
3. Queue extracts/resolves playback input and creates chapter/chunk records.
4. Queue saves a warm session.
5. Warmup may start generating cached audio chunks.
6. User presses Play in popup.
7. Popup sends `PLAY`.
8. Background calls `queue.start(...)`.
9. Queue resolves active tab context and chapter ID.
10. Queue creates or updates the session with `playRequested: true`.
11. Queue ensures offscreen document exists.
12. Queue calls `startCurrentChunkStream(...)`.
13. Offscreen receives `START_STREAM_PLAYBACK`.
14. Offscreen checks IndexedDB for the chunk blob.
15. If cached, it plays the blob through an object URL.
16. If not cached, it requests `/tts/stream`.
17. `WavStreamPlayer` parses WAV bytes and schedules audio.
18. Offscreen sends progress/start/end messages.
19. Queue updates session and advances chunks.
20. Warmup continues filling future chunk blobs when allowed.

## End-to-End Cached Replay Example

Scenario: user replays a chapter that was already warmed/downloaded.

1. Queue loads existing session/chapter/chunk metadata.
2. Current chunk is dispatched to offscreen.
3. Offscreen calls `getAudioChunk(chunkId)`.
4. IndexedDB returns the cached WAV blob.
5. Offscreen creates an object URL.
6. `WavStreamPlayer` fetches the object URL and plays it like a stream.
7. No live TTS request is needed for that cached chunk.

## Important Current Limitations

- The live stream path does not persist the exact streamed bytes into
  IndexedDB.
- Warmup can duplicate generation for chunks that were already streamed live.
- The service worker can be suspended, so long-lived audio work must stay in
  the offscreen document.
- Content extraction depends on Wattpad DOM/HTML structure, which can change.
- Cache is per voice variant, so switching voices may require new audio
  generation even for the same text.
- Full stream-persist caching would require extra logic for collecting bytes,
  finalizing blobs, marking ready only on successful completion, and handling
  partial failures.

## Key File Map

- `features/readaloud-extension/README.md`
  - Feature overview and manual run instructions.

- `features/readaloud-extension/extension/manifest.json`
  - Chrome extension wiring.

- `features/readaloud-extension/extension/src/background/service_worker.js`
  - Message router and queue entrypoint.

- `features/readaloud-extension/extension/src/audio/playbackQueue.js`
  - Main orchestration and state machine.

- `features/readaloud-extension/extension/src/audio/runtimeState.js`
  - Session-to-popup state conversion.

- `features/readaloud-extension/extension/src/content/content.js`
  - Runtime content script, page detection, extraction, page messaging.

- `features/readaloud-extension/extension/src/content/wattpadExtractor.js`
  - Extractor helpers and HTML fallback logic.

- `features/readaloud-extension/extension/src/content/chunkFocus.js`
  - Active paragraph highlight/scroll controller.

- `features/readaloud-extension/extension/src/db/idb.js`
  - IndexedDB schema and persistence helpers.

- `features/readaloud-extension/extension/src/offscreen/offscreen.js`
  - Offscreen playback command handling and cache/live selection.

- `features/readaloud-extension/extension/src/offscreen/wavStreamPlayer.js`
  - Progressive WAV stream playback through Web Audio.

- `features/readaloud-extension/extension/src/popup/popup.js`
  - Popup UI event handling and background requests.

- `features/readaloud-extension/extension/src/popup/popupState.js`
  - Popup view-model helpers.

- `features/readaloud-extension/extension/src/options/options.js`
  - Options page settings/library UI.

- `features/readaloud-extension/extension/src/shared/constants.js`
  - Shared constants such as cache TTL, chunk sizes, default voice, stream
    lookahead.

- `features/readaloud-extension/extension/src/shared/userSettings.js`
  - Voice options and persisted user settings.

- `features/readaloud-extension/extension/src/shared/libraryState.js`
  - Pure library grouping/status logic.

- `features/readaloud-extension/extension/src/shared/syncState.js`
  - Pure Sync toggle and Sync kickoff planning logic.

- `features/readaloud-extension/extension/src/text/chunkText.js`
  - Text splitting and stable chunk ID generation.

- `features/readaloud-extension/extension/src/tts/LocalKokoroProvider.js`
  - Local/proxy TTS request builder.

- `features/readaloud-extension/extension/src/tts/ModalKokoroProvider.js`
  - Modal/proxy TTS request builder.

- `features/readaloud-extension/backend/app.py`
  - FastAPI `/tts` and `/tts/stream` endpoints.

- `features/readaloud-extension/backend/tts_local.py`
  - Local Kokoro proxy client.

- `features/readaloud-extension/backend/tts_modal.py`
  - Modal TTS proxy client.

- `features/readaloud-extension/backend/test_streaming.py`
  - Backend streaming tests.

## Review Checklist for Future Changes

When reviewing changes to this system, check:

- Does the popup send only typed commands and avoid page DOM assumptions?
- Does the content script remain the only layer reading Wattpad DOM?
- Does `PlaybackQueue` remain the only owner of session state transitions?
- Are `chapterId`, `partId`, `storyId`, and `cacheChapterId` used
  consistently?
- Does a voice change use a separate cache key?
- Are chunks marked `ready` only when complete audio exists?
- Does active playback avoid blocking on full-chapter downloads?
- Does warmup yield to active playback startup?
- Are failed/partial streams excluded from the ready cache?
- Are IndexedDB deletes scoped correctly to story, chapter, or voice variant?
- Does Sync avoid opening duplicate tabs for the same work?
- Does offscreen playback release object URLs and audio resources?
- Do sleep timer alarms still work if the service worker was suspended?
