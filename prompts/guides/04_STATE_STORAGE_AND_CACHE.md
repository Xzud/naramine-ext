# 04. State, Storage, and Cache

This guide explains where data lives and how the pieces connect.

Relevant files:

```txt
features/readaloud-extension/extension/src/audio/playbackQueue.js
features/readaloud-extension/extension/src/audio/runtimeState.js
features/readaloud-extension/extension/src/db/idb.js
features/readaloud-extension/extension/src/shared/constants.js
features/readaloud-extension/extension/src/shared/userSettings.js
features/readaloud-extension/extension/src/shared/libraryState.js
features/readaloud-extension/extension/src/shared/syncState.js
features/readaloud-extension/extension/tests/playbackQueue.test.js
features/readaloud-extension/extension/tests/libraryState.test.js
features/readaloud-extension/extension/tests/syncState.test.js
features/readaloud-extension/extension/tests/userSettings.test.js
```

## Two Storage Systems

The extension uses two browser storage systems:

```txt
chrome.storage.local
IndexedDB
```

They are used for different kinds of data.

## `chrome.storage.local`

This is key-value storage provided by Chrome extensions.

Good for:

- Small structured records.
- Current session state.
- User settings.
- Sync flags.
- Sleep timer.
- Active chapter ID.
- Resume/prefetch/backfill records.

Not ideal for:

- Large binary audio files.

Technical term:

- **Key-value store**: A simple database where you store a value under a string
  key, then read it later by the same key.

## IndexedDB

This is browser database storage.

Good for:

- Structured records.
- Indexed lookups.
- Large binary `Blob`s.
- Audio cache.

Used for:

- Chapter records.
- Text chunk records.
- Audio chunk blobs.
- Story metadata.

Technical term:

- **Index**: A lookup path in a database. Example: find all `audioChunks` by
  `chapterId`.

## Why Two Storage Systems?

Use this mental model:

```txt
chrome.storage.local = current app/session/settings state
IndexedDB = reusable content/cache/library data
```

Examples:

- "Which chunk is playing right now?"
  - `chrome.storage.local`

- "What is the saved WAV blob for chunk 14?"
  - IndexedDB

- "What is the user's default voice?"
  - `chrome.storage.local`

- "Which chunks exist for this chapter?"
  - IndexedDB

## Session State

Owned by:

```txt
features/readaloud-extension/extension/src/audio/playbackQueue.js
```

Session records are saved through `saveSession(session)`.

They are stored in `chrome.storage.local` using a session key derived from
chapter ID.

Important session fields:

```js
{
  chapterId,
  storyId,
  voice,
  cacheChapterId,
  tabId,
  text,
  paragraphs,
  title,
  sourceUrl,
  partId,
  nextPartId,
  nextPartUrl,
  state,
  playbackStatus,
  streamStatus,
  currentChunkIndex,
  currentChunkId,
  currentChunkOffsetMs,
  totalChunks,
  playRequested,
  playbackElapsedMs,
  playbackResumedAt,
  lastEvent,
  errorMessage
}
```

Technical terms:

- **State machine**: Code that moves an object through named states such as
  `idle`, `playing`, `paused`, and `ended`.
- **Session**: The saved state for one chapter's playback.

## Active Chapter ID

Methods:

```js
getActiveChapterId()
setActiveChapterId(chapterId)
resolveChapterId(chapterId)
```

Purpose:

- If a command does not provide `chapterId`, the queue can fall back to the
  active chapter.

Example:

```txt
Popup sends PAUSE with empty payload
  -> service_worker calls queue.pause(null)
  -> queue.resolveChapterId(null)
  -> active chapter ID is loaded from storage
  -> queue pauses that session
```

## Runtime State

File:

```txt
features/readaloud-extension/extension/src/audio/runtimeState.js
```

Runtime state is what the queue returns to the UI.

Why it exists:

- Session objects are internal.
- UI needs a stable, safe shape even when there is no session or there is an
  error.

Important functions:

- `createRuntimeState(...)`
- `createIdleRuntimeState(...)`
- `createUnavailableRuntimeState(...)`
- `mapSessionToRuntimeState(...)`
- `deriveWarmupStatus(...)`
- `deriveTransportStatus(...)`

Runtime state includes:

- `chapterId`
- `storyId`
- `title`
- `state`
- `playbackStatus`
- `streamStatus`
- `currentChunkIndex`
- `totalChunks`
- `readyAudioCount`
- `failedCount`
- `errorMessage`
- `warmupStatus`
- `transportStatus`

Technical term:

- **View-safe state**: Data shaped for UI rendering, even when internal data is
  missing or failed.

## Session State vs Runtime State

Session state:

- Internal.
- Saved in storage.
- Contains text, paragraph anchors, next URLs, retry details, and transport
  details.

Runtime state:

- Returned to popup/options.
- Safer and smaller.
- Includes derived statuses.

Do not assume every session field is exposed to the UI.

## IndexedDB Schema

File:

```txt
features/readaloud-extension/extension/src/db/idb.js
```

Constants:

```js
DB_NAME = "readaloud_mvp"
DB_VERSION = 2
```

Object stores:

```txt
chapters
chunks
audioChunks
stories
```

### `chapters`

Key:

```txt
chapterId
```

Indexes:

```txt
storyId
expiresAt
```

Stores metadata about a cached chapter/voice variant.

Fields include:

- `chapterId`
- `sourceChapterId`
- `storyId`
- `voice`
- `title`
- `sourceUrl`
- `textHash`
- `createdAt`
- `expiresAt`

Important detail:

- `chapterId` in this store may be a cache chapter ID, such as
  `123::voice:af_bella`.
- `sourceChapterId` points back to the original Wattpad chapter/part ID.

### `chunks`

Key:

```txt
chunkId
```

Indexes:

```txt
chapterId
[chapterId, chunkIndex]
[chapterId, status]
```

Stores text chunk records.

Fields include:

- `chunkId`
- `chapterId`
- `chunkIndex`
- `text`
- `textHash`
- `paragraphIds`
- `paragraphId`
- `status`

Status values:

- `pending`
- `ready`
- `failed`

### `audioChunks`

Key:

```txt
chunkId
```

Indexes:

```txt
chapterId
[chapterId, chunkIndex]
expiresAt
```

Stores generated audio.

Fields include:

- `chunkId`
- `chapterId`
- `chunkIndex`
- `voice`
- `blob`
- `mimeType`
- `sizeBytes`
- `createdAt`
- `expiresAt`

Technical term:

- **Blob**: Binary data object. Here it is usually a WAV file for one chunk.

### `stories`

Key:

```txt
storyId
```

Stores metadata scraped from story overview pages:

- title
- author
- cover URL
- avatar URL
- source URL
- first part ID/URL
- updated time

## Cache Chapter ID and Voice Variants

Method:

```js
buildCacheChapterId(chapterId, voice)
```

Output:

```txt
chapterId::voice:voiceId
```

Example:

```txt
12345::voice:af_heart
12345::voice:am_adam
```

Why this matters:

- Same text with different voices produces different audio.
- Cache records must not reuse the wrong voice.
- Library can show multiple voice variants for the same chapter.

## Chapter Data Creation

Method:

```js
ensureChapterData(session)
```

Location:

```txt
features/readaloud-extension/extension/src/audio/playbackQueue.js
```

Responsibilities:

1. Ensure `session.cacheChapterId` exists.
2. Hash the full session text.
3. Build chunk records with `chunkText(...)`.
4. Save/update the chapter metadata record.
5. Save/update chunk metadata.
6. Preserve existing chunks when text still matches.
7. Replace chunks if text changed.
8. Upgrade old records with paragraph anchors when possible.

This is the bridge between extracted text and IndexedDB cache structure.

## Audio Cache Write

Function:

```js
saveAudioChunk(record)
```

Location:

```txt
features/readaloud-extension/extension/src/db/idb.js
```

It stores:

```js
{
  ...record,
  sizeBytes,
  expiresAt
}
```

If `sizeBytes` is missing, it uses:

```js
record.blob?.size || 0
```

If `expiresAt` is missing, it uses:

```js
Date.now() + CACHE_TTL_MS
```

## Cache Expiry

Constant:

```js
CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
```

Meaning:

- 30 days.

Important comment in `constants.js`:

- Downloaded audio is intended to stay until user deletion.
- TTL is a safety net against unbounded growth from abandoned chapters.

Cleanup function:

```js
cleanupExpiredAudio(now = Date.now())
```

When cleanup runs:

- Before new `start(...)` flow.
- Before new `warmup(...)` flow.

## Library Overview

Function:

```js
getLibraryOverview()
```

Location:

```txt
features/readaloud-extension/extension/src/db/idb.js
```

It reads:

- all chapter records
- chunk records per chapter
- audio records per chapter

It computes:

- chunk count
- ready audio count
- failed count
- size in bytes
- voice variants

Then `PlaybackQueue.getLibrary()` passes this into:

```js
groupLibraryByStory(...)
```

Location:

```txt
features/readaloud-extension/extension/src/shared/libraryState.js
```

## Library Statuses

Function:

```js
deriveChapterStatus(...)
```

Statuses:

- `downloaded`
  - Every chunk has cached audio.

- `processing`
  - Warmup is active or pending.

- `paused`
  - Partial cache exists but no active warmup is working.

Why `paused` does not mean audio playback paused:

- In library context, `paused` means the download/cache process is incomplete
  and currently not processing.

## Recents and Last Played

Owned by:

```txt
features/readaloud-extension/extension/src/audio/playbackQueue.js
```

Important methods:

- `loadLastPlayed()`
- `recordLastPlayed(session, now)`
- `getLastPlayed(storyId)`
- `removeLastPlayed(storyId)`
- `getRecentlyPlayed(limit)`

Stored per-story cursor fields include:

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

Technical term:

- **Cursor**: A saved position that lets playback resume near the same place.

## User Settings

File:

```txt
features/readaloud-extension/extension/src/shared/userSettings.js
```

Storage key:

```txt
readaloud:userSettings
```

Main setting:

- `defaultVoice`

Important functions:

- `normalizeUserSettings(...)`
- `loadUserSettings(storageArea)`
- `saveUserSettings(storageArea, nextSettings)`
- `findVoiceOption(voiceId)`

Why normalization matters:

- It prevents unsupported voice IDs from being saved or used.
- It falls back to `DEFAULT_VOICE`.

## Sync State

File:

```txt
features/readaloud-extension/extension/src/shared/syncState.js
```

Pure helpers:

- `isStorySyncEnabled(syncStories, storyId)`
- `applySyncToggle(syncStories, storyId, enabled, now)`
- `planSyncStart(context)`

Stored data:

- A map of story IDs to `{ enabled: true, enabledAt }`.

Important rule:

- Sync is per story, not global.

## Sleep Timer State

Owned by:

```txt
features/readaloud-extension/extension/src/audio/playbackQueue.js
```

Modes:

- `off`
- `duration`
- `end_of_chapter`

Duration mode stores:

- mode
- deadline
- durationMs
- setAt

Chrome alarm:

- Used so the timer can fire even if the service worker was suspended.

Technical term:

- **Alarm**: Chrome extension scheduled wakeup event.

## Delete Flows

Library delete methods:

- `deleteDownloadedChapter(chapterId)`
- `deleteDownloadedChapterVoice(payload)`
- `deleteDownloadedStory(storyId)`

Important behavior:

- Deleting a chapter aborts warmup for that chapter.
- Deleting a story deletes all cached chapter variants for the story.
- Deleting a story also turns Sync off and removes story metadata/last-played
  record.
- Deleting the active voice variant stops playback and deletes the session.

## Storage Safety Rules

When changing storage-related code, check:

- Is this small state or large binary data?
  - Small state: `chrome.storage.local`.
  - Large audio: IndexedDB.

- Does this data belong to a source chapter or voice variant?
  - Source chapter: use `chapterId`.
  - Cached voice variant: use `cacheChapterId`.

- Can this delete active playback?
  - If yes, stop offscreen playback first.

- Can text have changed?
  - If yes, old chunks/audio may no longer match.

- Is the chunk ready only when audio exists?
  - A chunk should not be treated as fully ready without its audio blob.

