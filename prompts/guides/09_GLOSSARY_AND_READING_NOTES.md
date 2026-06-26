# 09. Glossary and Reading Notes

This guide defines common terms used in the readaloud extension and gives
practical advice for reading/debugging the codebase.

## Core JavaScript Terms

### `async` function

An `async` function returns a Promise.

Example:

```js
async function getState() {
  return await request("GET_STATE");
}
```

Why this codebase uses it:

- Chrome APIs return promises.
- `fetch(...)` is async.
- IndexedDB wrappers return promises.
- Playback events happen over time.

### Promise

A Promise represents work that will finish later.

It can:

- resolve successfully
- reject with an error

Example:

```js
chrome.runtime.sendMessage(...).catch(() => {})
```

This means:

- Send a message.
- If it fails, ignore the failure.

### `await`

`await` pauses the current async function until a Promise finishes.

Example:

```js
const state = await queue.getState();
```

This does not freeze the whole browser. It only waits inside that async
function.

### Optional chaining

Example:

```js
sender?.tab?.id
```

Meaning:

- If `sender` exists, read `tab`.
- If `tab` exists, read `id`.
- If any part is missing, return `undefined` instead of throwing.

Used when data may or may not be present.

### Nullish coalescing

Example:

```js
sender?.tab?.id ?? null
```

Meaning:

- Use `sender.tab.id` if it is not `null` or `undefined`.
- Otherwise use `null`.

### Spread syntax

Example:

```js
{
  ...(message.payload || {}),
  tabId
}
```

Meaning:

- Copy fields from `message.payload`.
- Add or overwrite `tabId`.

Used heavily when passing payload data through the background router.

### Destructuring

Example:

```js
const { action, chapterId, storyId } = button.dataset;
```

Meaning:

- Pull properties out of an object into variables.

### Callback

A callback is a function passed into another function to run later.

Examples in this codebase:

- `chrome.runtime.onMessage.addListener(...)`
- `this.callbacks.onStarted?.(...)`
- `source.onended = () => {}`

### Event listener

An event listener waits for something to happen.

Examples:

- A user clicks a button.
- A Chrome message arrives.
- A tab finishes loading.
- An audio source ends.

## Browser Extension Terms

### Manifest

File:

```txt
features/readaloud-extension/extension/manifest.json
```

The manifest tells Chrome:

- What the extension is called.
- Which permissions it needs.
- Which files to load.
- Which content scripts to inject.
- Which popup and options page to use.

### Permission

A permission allows the extension to use a Chrome capability.

Examples:

- `storage`
  - Use `chrome.storage.local`.

- `offscreen`
  - Create an offscreen document.

- `tabs`
  - Query, create, update, and listen to tabs.

- `alarms`
  - Schedule wakeups for sleep timer.

### Host permission

A host permission allows network/page access for specific URLs.

Current host permissions:

```txt
http://localhost:8880/*
http://localhost:3000/*
```

These allow the extension to talk to local TTS services.

### Service worker

File:

```txt
features/readaloud-extension/extension/src/background/service_worker.js
```

A background script that wakes up for events.

Important limitation:

- Chrome can suspend it when idle.

That is why actual audio playback happens in the offscreen document.

### Content script

File:

```txt
features/readaloud-extension/extension/src/content/content.js
```

A script injected into web pages.

It can:

- Read the page DOM.
- Detect Wattpad pages.
- Extract story text.
- Highlight paragraphs.

It should not:

- Own global playback state.
- Store audio cache.

### Popup

Files:

```txt
features/readaloud-extension/extension/src/popup/popup.html
features/readaloud-extension/extension/src/popup/popup.js
```

The small toolbar UI.

Important limitation:

- It closes when user clicks away.
- It should not own long-running state.

### Options page

Files:

```txt
features/readaloud-extension/extension/src/options/options.html
features/readaloud-extension/extension/src/options/options.js
```

A full tab page for settings and library management.

### Offscreen document

Files:

```txt
features/readaloud-extension/extension/src/offscreen/offscreen.html
features/readaloud-extension/extension/src/offscreen/offscreen.js
```

A hidden extension page used for audio playback.

It exists because:

- Popup is temporary.
- Service worker is suspendable.
- Audio playback needs a document-like environment.

## Messaging Terms

### Message

An object sent between extension environments.

Example:

```js
{
  scope: "readaloud",
  type: "PLAY",
  payload: {}
}
```

### Message type

The command name.

Examples:

- `PLAY`
- `PAUSE`
- `PAGE_READY`
- `READALOUD_EXTRACT_TEXT`
- `START_STREAM_PLAYBACK`

### Payload

The data attached to the message.

Example:

```js
{
  type: "SYNC_SET",
  payload: {
    storyId: "123",
    enabled: true
  }
}
```

### Sender

Chrome metadata about who sent the message.

The code often uses:

```js
sender?.tab?.id
```

This tells the queue which tab a content script message came from.

### Request/response

Many messages expect a response.

Example:

```txt
popup sends GET_STATE
background returns runtime state
```

### Event

Some messages are notifications that something happened.

Example:

```txt
offscreen sends CHUNK_PLAYBACK_ENDED
```

The background handles the event and updates state.

## Data Terms

### Story

A Wattpad story/novel.

Usually identified by:

```txt
storyId
```

Used for:

- Library grouping.
- Sync.
- Last played.
- Story metadata.

### Chapter / Part

A Wattpad chapter page is often called a `part`.

In the code:

- Wattpad `partId` often becomes extension `chapterId`.

### Paragraph

A Wattpad paragraph element.

Usually has:

```html
<p data-p-id="...">
```

The `data-p-id` is important for highlighting.

### Chunk

A chunk is a smaller piece of chapter text.

Why chunks exist:

- TTS requests need manageable input sizes.
- Playback can start without processing the whole chapter.
- Cache can store audio piece by piece.
- Resume can target a chunk index.

### Chunk ID

Shape:

```txt
chapterId:chunkIndex:textHash
```

Used as:

- IndexedDB key for text chunk.
- IndexedDB key for audio chunk.
- Playback identifier.

### Text hash

A short repeatable identity for text.

This code uses it so identical chunk text gets the same chunk ID.

It is not a security hash.

### Session

The current saved playback state for one chapter.

Contains:

- current chunk index
- current chunk ID
- voice
- title
- playback state
- stream state
- elapsed time
- next chapter URL
- page metadata

### Cursor

A saved playback position.

Used by:

- Continue.
- Recents.
- Resume from pause.

Cursor fields include:

- story ID
- chapter ID
- chunk index
- chunk offset
- voice
- updated time

## Storage Terms

### `chrome.storage.local`

Extension key-value storage.

Used for:

- sessions
- active chapter ID
- settings
- Sync flags
- sleep timer
- last played cursors
- prefetch/backfill/resume records

### IndexedDB

Browser database.

Used for:

- chapter records
- chunk records
- audio blobs
- story metadata

### Object store

IndexedDB's version of a table.

Current stores:

- `chapters`
- `chunks`
- `audioChunks`
- `stories`

### Index

A lookup path in IndexedDB.

Example:

```txt
audioChunks.index("chapterId")
```

This lets code find all audio chunks for one chapter.

### Blob

A binary data object.

In this codebase, audio blobs are usually WAV data for one chunk.

### Cache

Saved generated audio that can be reused later.

Current cache unit:

```txt
one WAV blob per text chunk
```

## Audio Terms

### TTS

Text-to-speech.

Text goes in. Spoken audio comes out.

### WAV

Audio container format.

Contains:

- header
- PCM audio data

### Header

Metadata at the start of a WAV file.

It tells the player how to interpret the audio bytes.

### PCM

Raw audio samples.

After the WAV header, the `data` section contains PCM frames.

### Frame

One time slice of audio samples across all channels.

For mono audio:

```txt
one frame = one sample
```

For stereo audio:

```txt
one frame = left sample + right sample
```

### Buffer

A temporary collection of audio bytes or decoded samples.

### AudioContext

Browser Web Audio engine.

Used to schedule and play decoded audio.

### AudioBuffer

Decoded audio samples ready for Web Audio playback.

### AudioBufferSourceNode

Web Audio node that plays an `AudioBuffer`.

### Gapless playback

Playing audio blocks back-to-back without silence between them.

`WavStreamPlayer` tracks `scheduledUntil` to do this.

## Playback Terms

### Live stream

Audio received progressively from `/tts/stream` for immediate playback.

### Warmup

Background generation of audio blobs into IndexedDB.

### Prepared stream

A future chunk that is already buffering but is not currently audible.

### Active stream

The stream currently responsible for audible playback.

### Attempt ID

A unique value for a playback attempt.

It prevents late events from old attempts corrupting new state.

### Stale event

An event that arrives after the queue has moved on.

Example:

```txt
Chunk 3 error event arrives after user jumped to chunk 8
```

The queue should ignore it.

### Race condition

A bug caused by async operations finishing in an unexpected order.

Example:

```txt
Pause and progress update both write session state
Progress update accidentally unpauses playback
```

`runExclusive(...)` reduces this risk.

## Feature Terms

### Sync

Per-story behavior that keeps chapters warming/downloading as the user reads.

### Backfill

When Sync is enabled mid-story, the queue can open chapter 1 and warm it.

### Prefetch

Opening/preparing future work before it is needed.

Examples:

- Next audio chunk lookahead.
- Next Wattpad chapter tab.

### Auto-advance

Moving to the next chapter when current chapter ends.

### Library

UI showing cached/downloaded story audio grouped by story.

### Voice variant

Cached audio for a specific voice.

Same chapter with different voice gets a different cache ID.

### Sleep timer

Feature that pauses/stops later:

- after duration
- at end of chapter

## Debugging Advice

### When a button does nothing

Trace:

```txt
popup/options click handler
  -> request(type, payload)
  -> service_worker route
  -> PlaybackQueue method
  -> returned state
  -> UI render
```

Search:

```bash
rg -n '"MESSAGE_TYPE"' features/readaloud-extension
```

### When page text is wrong

Trace:

```txt
content.js
  -> extractWattpadTextFromDocument
  -> wattpadExtractor fallback helpers
  -> validation warnings
  -> chunkText
```

Read:

- `wattpadExtractor.test.js`
- `chunkText.test.js`

### When audio does not play

Trace:

```txt
PlaybackQueue.startCurrentChunkStream
  -> dispatchStreamPlayback
  -> offscreen.js
  -> resolveStreamRequest
  -> WavStreamPlayer.open
  -> backend /tts/stream
```

Check:

- Is backend running?
- Does `/health` work?
- Is the chunk cached?
- Did offscreen emit an error?
- Is the session paused/stopped/error?

### When cached audio is missing

Trace:

```txt
ensureWarmingPipeline
  -> runWarmingPipeline
  -> fetchAudioForChunk
  -> saveAudioRecord
  -> saveAudioChunk
  -> markChunkStatus("ready")
```

Check:

- Was warmup allowed by gate?
- Was warmup aborted for active playback?
- Did fetch fail?
- Is the voice cache ID correct?

### When Sync behaves unexpectedly

Trace:

```txt
SYNC_GET / SYNC_SET
  -> resolveSyncContext
  -> applySyncToggle
  -> planSyncStart
  -> executeSyncPlan
```

Read:

- `syncState.test.js`
- Sync tests in `playbackQueue.test.js`

## Reading Strategy For Large Files

For `playbackQueue.js`, never try to memorize everything.

Use feature searches:

```bash
rg -n "async start|async pause|async stop" features/readaloud-extension/extension/src/audio/playbackQueue.js
rg -n "warmup|Warming" features/readaloud-extension/extension/src/audio/playbackQueue.js
rg -n "Sync|sync" features/readaloud-extension/extension/src/audio/playbackQueue.js
rg -n "Sleep|sleep" features/readaloud-extension/extension/src/audio/playbackQueue.js
rg -n "Library|library|deleteDownloaded" features/readaloud-extension/extension/src/audio/playbackQueue.js
```

Then read only that method and the helpers it calls.

## Best Mental Model

Use this when you feel lost:

```txt
content.js understands the Wattpad page
popup.js and options.js understand the UI
service_worker.js understands routing
playbackQueue.js understands product behavior
offscreen.js understands audio playback commands
wavStreamPlayer.js understands WAV streaming
idb.js understands persistent cache records
backend/app.py understands TTS proxying
```

