# 06. PlaybackQueue Feature Guide

This guide explains the major features inside `PlaybackQueue`.

Main file:

```txt
features/readaloud-extension/extension/src/audio/playbackQueue.js
```

This file is large because it is the central coordinator. Read it by feature,
not top-to-bottom.

## What PlaybackQueue Owns

`PlaybackQueue` owns:

- Session state.
- Active chapter ID.
- Page extraction resolution.
- Chapter/chunk metadata setup.
- Playback dispatch.
- Offscreen playback status handling.
- Warmup/cache generation.
- Next chunk lookahead.
- Next chapter prefetch.
- Auto-advance.
- Sync.
- Backfill.
- Library.
- Continue/resume.
- Voice switching.
- Sleep timer.
- Runtime error state.

It does not directly render UI and it does not directly parse Wattpad DOM.

## Why `runExclusive(...)` Exists

Method:

```js
runExclusive(task)
```

Purpose:

- Serialize session mutations.
- Prevent race conditions.

Technical term:

- **Race condition**: A bug where two async operations update the same state in
  an unpredictable order.

Example problem:

```txt
User clicks Pause
Progress event arrives at the same time
Both load old session
Both write a new session
Progress write could accidentally undo Pause
```

`runExclusive` prevents many of these by chaining tasks.

## Starting Playback

Methods:

```js
start(options = {})
startExclusive(options = {})
resolvePlaybackInput(options = {})
```

Start flow:

```txt
PLAY message
  -> queue.start(...)
  -> runExclusive(...)
  -> startExclusive(...)
  -> resolve page/chapter/context
  -> create or resume session
  -> ensure chapter data
  -> save session
  -> ensure offscreen document
  -> processSession(...)
```

Key decisions:

- If `options.chapterId` exists, use it.
- Otherwise ask active tab for page context.
- If active page is a story overview, start from story context.
- If active page is a chapter, use that chapter's `partId`.
- Otherwise use active chapter/session when valid.

## Resolving Playback Input

Method:

```js
resolvePlaybackInput(options = {})
```

It can receive data three ways:

1. Full extraction already provided in `options`.
2. Manual text in `options.text`.
3. Active tab extraction through content script.

It returns either:

```js
{ ok: true, ...playbackInput }
```

or:

```js
{ ok: false, errorMessage, ...metadata }
```

This method is the bridge between page extraction and playback state.

## Warmup

Methods:

```js
warmup(options = {})
warmupExclusive(options = {})
ensureWarmingPipeline(chapterId)
runWarmingPipeline(chapterId)
```

Warmup means:

```txt
Prepare/cache audio without necessarily playing it now.
```

When warmup happens:

- Content script sends `PAGE_READY`.
- Sync is enabled.
- Voice switching starts a new variant.
- Prefetch/backfill opens another chapter.
- Playback itself starts and future chunks need caching.

Warmup pipeline:

1. Load session.
2. Check if session is warmable.
3. Find next uncached chunk.
4. Check warmup gate.
5. Fetch audio for chunk.
6. Save audio blob.
7. Mark chunk `ready`.
8. Continue until no more work or it yields.

## Warmup Gate

Method:

```js
resolveWarmupGate(chapterId)
```

Purpose:

- Active playback startup gets priority.
- Active chapter warmup gets priority over next chapter warmup.

Why:

- TTS backend is a limited resource.
- Starting audible playback should not wait behind background downloads.

Possible result:

- `"proceed"`
- `"yield"`

If warmup yields:

- Chapter ID is added to `pendingWarmups`.
- It can resume later.

## Interrupting Warmup

Method:

```js
interruptWarmupFetches(...)
```

Purpose:

- Abort in-flight warmup TTS requests when user playback needs the backend.

If a warmup fetch is aborted:

- The chunk remains pending.
- It can retry later.

Technical term:

- **AbortController**: Browser API used to cancel an in-flight `fetch`.

## Processing a Session

Method:

```js
processSession(chapterId)
```

Responsibilities:

- Start warmup.
- Start next-chapter prefetch.
- Ensure offscreen document exists.
- Start the current chunk stream.

This method is called after state says playback should happen.

## Starting Current Chunk Stream

Method:

```js
startCurrentChunkStream(chapterId)
```

Important checks:

- No session? Stop.
- Paused/stopped/error? Stop.
- Current index is past total chunks? Mark ended.
- No chunk record? Stop.
- Same chunk already dispatching? Do nothing.
- Paused offscreen stream exists? Resume it.
- Prepared slot exists? Promote it.
- Otherwise dispatch a new live stream.

This is one of the most important methods for playback behavior.

## Handling Runtime Events

Methods:

```js
handleRuntimeMessage(message)
handleRuntimeMessageExclusive(message)
```

Events come from offscreen playback.

Important event handling:

- Progress events update bytes/buffer/time.
- Started events mark playback as active.
- End events advance to next chunk.
- Error events retry or fail.
- Prepared-ready events can start more lookahead.

The queue protects against stale events using:

- `chunkId`
- `attemptId`
- current session state

## Chunk Advance

When `CHUNK_PLAYBACK_ENDED` arrives:

1. Queue verifies the event belongs to current chunk/attempt.
2. It advances `currentChunkIndex`.
3. It updates playback clock.
4. It records last played progress.
5. It checks sleep timer.
6. It starts the next chunk or ends the chapter.

## Next Chunk Lookahead

Methods:

```js
prefetchChunkAtOffset(chapterId, session, offset)
dispatchPrepareStreamPlayback(payload)
dispatchStartPreparedStream(payload)
```

Purpose:

- Prepare near-future chunks so playback handoff is smoother.

Lookahead depth:

```js
STREAM_LOOKAHEAD_DEPTH = 2
```

How it works:

```txt
current chunk starts
  -> prepare chunk +1
chunk +1 is ready
  -> maybe prepare chunk +2
current chunk ends
  -> promote prepared chunk +1 if possible
```

## Next Chapter Prefetch

Methods:

```js
ensureNextChapterPrefetch(session)
openNextChapterPrefetch(session, options)
handlePrefetchTabUpdated(tabId, changeInfo)
processPrefetchedTab(record)
activatePrefetchedChapter(record)
```

Purpose:

- Open the next Wattpad chapter in a background tab.
- Extract it.
- Create session/chunk data.
- Warm its audio.
- Activate it when current chapter ends.

Why a real tab is opened:

- The extension extracts from the Wattpad page.
- Playback is designed to follow real Wattpad page visits.

Single-flight protection:

- `nextChapterPrefetchTask`.
- Stored prefetch record.

Technical term:

- **Single-flight**: Preventing duplicate concurrent work for the same task.

## Auto-Advance

At chapter end, the queue decides whether to move to the next chapter.

If next chapter was prefetched:

- Activate prefetched tab.
- Set next chapter active.
- Start playback.
- Clean up finished chapter/tab as appropriate.

If no prefetched tab exists but `nextPartUrl` exists:

- Open next chapter and play when ready.

If no next part exists:

- End playback.

Sleep timer can block auto-advance.

## Sync

Files:

```txt
features/readaloud-extension/extension/src/audio/playbackQueue.js
features/readaloud-extension/extension/src/shared/syncState.js
```

Methods:

```js
getSyncStatus(payload)
setSyncEnabled(payload)
startSyncFromContext(context)
executeSyncPlan(context)
maybeStartStorySync(session)
```

Sync means:

```txt
For this story, keep downloading/warming as the user reads.
```

Turning Sync on from a chapter page:

1. Warm current chapter.
2. Backfill chapter 1 if needed.
3. Prefetch next chapter.

Turning Sync on from a story page:

1. Open/warm chapter 1.
2. Chain chapter 2 when ready.

When Sync is already on:

- Visiting a chapter warms that chapter.
- Next chapter prefetch starts.

## Backfill

Methods:

```js
openSyncBackfill(...)
handleBackfillTabUpdated(...)
processBackfillTab(...)
```

Backfill exists because users may enable Sync from the middle of a story.

Example:

```txt
User is on chapter 25
User turns Sync on
Queue warms chapter 25
Queue also opens chapter 1 in background and warms it
```

## Library

Methods:

```js
getLibrary()
deleteDownloadedChapter(...)
deleteDownloadedChapterVoice(...)
deleteDownloadedStory(...)
```

Library uses:

- IndexedDB overview records.
- Active chapter ID.
- Story metadata.
- Last played records.
- Current active voice.
- Active/pending warmup IDs.

Story deletion also:

- Turns Sync off.
- Deletes story metadata.
- Removes last-played cursor.

## Continue / Resume

Methods:

```js
continueStory(payload)
resumeFromStoredRecord(record, options)
openResumeTarget(lastPlayed)
activateResumedChapter(...)
```

Continue uses last-played cursor records.

If the chapter tab/session already exists:

- Reuse it.
- Resume from stored chunk and offset.

If not:

- Open the saved Wattpad chapter URL.
- Wait for page extraction.
- Resume after the page is ready.

## Voice Switching

Method:

```js
switchVoice(payload)
```

What changes:

- `session.voice`
- `session.cacheChapterId`

What stays:

- Current chapter.
- Current cursor/progress where possible.

Why cache ID changes:

- Different voice means different audio.
- Cache must be separate per voice.

After switching:

- Existing cache for that voice may be used.
- Warmup starts for missing chunks in that voice.
- Playback may resume if it was active.

## Sleep Timer

Methods:

```js
getSleepTimer(now)
setSleepTimer(payload, now)
handleSleepAlarm(alarm)
```

Modes:

- `off`
- `duration`
- `end_of_chapter`

Duration:

- Save deadline.
- Schedule Chrome alarm.
- Pause/stop behavior is triggered when elapsed.

End of chapter:

- Let current chapter finish.
- Pause instead of auto-advancing.

## Off-Page Playback Block

Methods:

```js
isViewingChapterPage(chapterId)
buildOffPagePlaybackBlock(chapterId, session)
```

Behavior:

- Playback should normally happen while the reader is viewing the matching
  Wattpad chapter page.
- If user tries to play a chapter while off-page, queue can return a state with
  `playBlockedOffPage`.

Why:

- The product follows the page.
- Highlighting and organic page visit behavior depend on the real chapter page.

## Lazy-Loaded Chapter Growth

Wattpad can add more paragraphs after initial extraction.

The queue has tests around:

- Near-end playback refresh.
- Delayed refresh extends chapter.
- Refresh that finds no new content.

Purpose:

- Avoid ending early when the page lazy-loads more chapter text.
- Preserve active highlight during refresh.

## How To Read `PlaybackQueue`

Do not read the file from top to bottom on your first pass.

Use this order:

1. `constructor`
   - Understand event listeners.

2. Storage helpers:
   - `loadSession`
   - `saveSession`
   - `getActiveChapterId`
   - `setActiveChapterId`

3. Input/session setup:
   - `resolvePlaybackInput`
   - `createSessionFromInput`
   - `ensureChapterData`

4. Play flow:
   - `start`
   - `startExclusive`
   - `processSession`
   - `startCurrentChunkStream`

5. Event flow:
   - `handleRuntimeMessage`
   - `handleRuntimeMessageExclusive`

6. Cache flow:
   - `ensureWarmingPipeline`
   - `runWarmingPipeline`

7. Feature flows:
   - Sync
   - library
   - continue
   - sleep timer
   - voice switching

## Tests To Read

`playbackQueue.test.js` is large but valuable. Use search:

```bash
rg -n "warming pipeline|sync|sleep|switchVoice|continue|prefetch|auto" features/readaloud-extension/extension/tests/playbackQueue.test.js
```

Read the test names first. They describe the behavior expected from the queue.

