# 02. Extension Runtime and Messages

This guide explains how the Chrome extension pieces talk to each other.

The most important idea:

```txt
The popup does not directly read the page.
The background service worker does not directly read the page DOM.
The content script reads the page DOM.
The offscreen document plays audio.
PlaybackQueue coordinates the whole system.
```

## The Four Runtime Environments

The extension runs code in four different environments.

### 1. Popup

Files:

```txt
features/readaloud-extension/extension/src/popup/popup.html
features/readaloud-extension/extension/src/popup/popup.js
features/readaloud-extension/extension/src/popup/popupState.js
```

What it can do:

- Render the extension UI.
- Handle button clicks.
- Send messages to the background service worker.

What it cannot reliably do:

- Read the Wattpad page DOM.
- Keep playing audio after the popup closes.
- Own long-running playback state.

Important helper:

```js
async function request(type, payload = {}) {
  return await chrome.runtime.sendMessage({
    scope: "readaloud",
    type,
    payload
  });
}
```

Technical terms:

- **Popup**: The small extension window opened from the toolbar icon.
- **Request helper**: A local function that standardizes messages sent to the
  background.
- **Payload**: The data object sent with a message.

### 2. Content Script

Files:

```txt
features/readaloud-extension/extension/src/content/content.js
features/readaloud-extension/extension/src/content/wattpadExtractor.js
features/readaloud-extension/extension/src/content/chunkFocus.js
```

What it can do:

- Read the active web page DOM.
- Detect Wattpad reading pages.
- Extract text and metadata.
- Highlight paragraphs.
- Send `PAGE_READY` when the page is usable.

What it should not do:

- Own playback state.
- Talk directly to the TTS backend.
- Store audio blobs.

Technical terms:

- **Content script**: Extension JavaScript injected into web pages.
- **DOM**: Browser's live representation of HTML elements.
- **Page context**: A small object that says whether the page is a chapter,
  story overview, or unsupported page.

### 3. Background Service Worker

File:

```txt
features/readaloud-extension/extension/src/background/service_worker.js
```

What it does:

- Listens for messages.
- Ignores messages outside `scope: "readaloud"`.
- Creates one `PlaybackQueue`.
- Routes each message type to a queue method.
- Catches failures and returns structured error state.

Technical terms:

- **Service worker**: Chrome's background script for Manifest V3.
- **Manifest V3**: Current Chrome extension architecture where the background
  script is event-driven and can be suspended when idle.
- **Router**: Code that receives a message and calls the matching handler.

### 4. Offscreen Document

Files:

```txt
features/readaloud-extension/extension/src/offscreen/offscreen.html
features/readaloud-extension/extension/src/offscreen/offscreen.js
features/readaloud-extension/extension/src/offscreen/wavStreamPlayer.js
```

What it does:

- Owns actual audio playback.
- Keeps playback alive outside the popup.
- Checks IndexedDB for cached chunk audio.
- Falls back to live TTS streaming.
- Sends playback progress events back to the background.

Technical terms:

- **Offscreen document**: A hidden extension page that can use browser APIs
  unavailable or unreliable in the service worker.
- **Playback slot**: A record in offscreen code representing one active or
  prepared audio stream.

## Message Shape

Most readaloud extension messages look like this:

```js
{
  scope: "readaloud",
  type: "PLAY",
  payload: {
    chapterId: "123"
  }
}
```

Fields:

- `scope`
  - Used so the service worker ignores unrelated extension messages.

- `type`
  - The command name.
  - Examples: `PLAY`, `PAUSE`, `PAGE_READY`.

- `payload`
  - Optional object with command-specific data.
  - Often empty from the popup.

Important detail:

```js
payload = {}
```

This default means if caller does not provide a payload, the message still
contains an object. This avoids crashes when the background spreads it:

```js
{ ...(message.payload || {}), tabId }
```

## Why Popup Payload Is Often Empty

You asked earlier why `popup.js` does not always provide `chapterId` or page
data. That is intentional.

The popup sends:

```js
request("PLAY")
```

That becomes:

```js
{
  scope: "readaloud",
  type: "PLAY",
  payload: {}
}
```

The popup does not know what Wattpad page is open. Instead:

1. Background receives `PLAY`.
2. Background passes the request to `PlaybackQueue`.
3. `PlaybackQueue` asks the active tab's content script for page context.
4. Content script answers with chapter/story information.
5. Queue decides what to play.

This keeps responsibilities clean:

- Popup owns UI.
- Content script owns page reading.
- Queue owns playback decision-making.

## Sender Metadata

Chrome passes a second argument to message listeners:

```js
(message, sender, sendResponse) => {}
```

The code uses:

```js
const tabId = sender?.tab?.id ?? null;
```

Meaning:

- If the message came from a tab, use that tab's ID.
- If not, use `null`.

Why this matters:

- Content script messages include a real tab ID.
- Popup messages often do not.
- Queue can use the tab ID to ask the correct page for context.

Technical term:

- **Optional chaining**: `sender?.tab?.id` means "read this nested property only
  if each previous value exists."
- **Nullish coalescing**: `?? null` means "use `null` only if the left side is
  `null` or `undefined`."

## Background Message Routing

File:

```txt
features/readaloud-extension/extension/src/background/service_worker.js
```

The main router is:

```js
async function handleScopedRequest(message, sender) {
  const tabId = sender?.tab?.id ?? null;
  switch (message.type) {
    // cases...
  }
}
```

Important routes:

| Message type | Queue method | Meaning |
| --- | --- | --- |
| `PAGE_READY` | `queue.warmup(...)` | Chapter page is detected and can be prepared |
| `STORY_PAGE_READY` | `queue.handleStoryPageReady(...)` | Story overview metadata is available |
| `PAGE_CONTEXT_GET` | `queue.getPageContextStatus(...)` | Popup wants to know what kind of page is active |
| `PLAY` | `queue.start(...)` | User wants playback |
| `PLAY_FROM_PARAGRAPH` | `queue.playFromParagraph(...)` | User clicked a paragraph |
| `PAUSE` | `queue.pause(...)` | User wants pause |
| `STOP` | `queue.stop(...)` | User wants stop |
| `PLAYBACK_SET_VOICE` | `queue.switchVoice(...)` | User changed voice |
| `GET_STATE` | `queue.getState(...)` | Popup wants current state |
| `LIBRARY_GET` | `queue.getLibrary()` | UI wants downloads/cache library |
| `SYNC_GET` | `queue.getSyncStatus(...)` | UI wants Sync toggle status |
| `SYNC_SET` | `queue.setSyncEnabled(...)` | User toggled Sync |
| `SLEEP_GET` | `queue.getSleepTimer()` | UI wants sleep timer state |
| `SLEEP_SET` | `queue.setSleepTimer(...)` | User changed sleep timer |

## Content Script Messages

File:

```txt
features/readaloud-extension/extension/src/content/content.js
```

The content script sends:

### `PAGE_READY`

Sent when a Wattpad reading page is visible.

Payload includes:

- Extracted chapter text.
- Chapter/part ID.
- Story ID.
- Title.
- Source URL.
- Paragraph metadata.
- Next part metadata.
- First part metadata.
- Detection flags.

Background handles it with:

```txt
PAGE_READY -> queue.warmup(...)
```

Meaning:

- The page is ready.
- The queue can prepare metadata and optionally generate cached audio.
- It does not necessarily start playback.

### `STORY_PAGE_READY`

Sent when a Wattpad story overview page is visible.

Payload includes:

- Story ID.
- Title.
- Author.
- Cover URL.
- Avatar URL.
- First part URL.

Background handles it with:

```txt
STORY_PAGE_READY -> queue.handleStoryPageReady(...)
```

Meaning:

- Save story metadata.
- If Sync is already on for this story, start the Sync plan.

## Page Commands Sent To Content Script

`PlaybackQueue` can ask the content script questions.

File:

```txt
features/readaloud-extension/extension/src/audio/playbackQueue.js
```

Helper:

```js
sendPageCommand(tabId, message)
```

Commands:

### `READALOUD_GET_PAGE_CONTEXT`

Ask:

```txt
What kind of page is this?
```

Answer:

```js
{ kind: "chapter", ...chapterData }
{ kind: "story", ...storyData }
{ kind: "none", ok: false }
```

Used by:

- Popup view selection.
- `PLAY`.
- Sync toggle resolution.

### `READALOUD_EXTRACT_TEXT`

Ask:

```txt
Give me the current chapter text and metadata.
```

Used by:

- Playback start.
- Warmup.
- Prefetch/backfill/resume flows.

### `READALOUD_SET_ACTIVE_CHUNK`

Ask:

```txt
Highlight and maybe scroll to the paragraph(s) for this chunk.
```

Used when:

- A chunk starts playing.
- User jumps to a paragraph.

### `READALOUD_CLEAR_ACTIVE_CHUNK`

Ask:

```txt
Remove active playback highlight.
```

Used when:

- Playback stops.
- Session ends/cleans up.

## Offscreen Playback Messages

`PlaybackQueue` sends commands to the offscreen document through
`chrome.runtime.sendMessage`.

Main commands:

### `START_STREAM_PLAYBACK`

Start audible playback for one chunk.

Payload includes:

- `chunkId`
- `chapterId`
- `attemptId`
- TTS request details
- optional start offset

### `PREPARE_STREAM_PLAYBACK`

Start buffering a future chunk without making it active yet.

Used for lookahead. The goal is to reduce gaps between chunks.

### `START_PREPARED_STREAM`

Promote a prepared slot into active playback.

Used when the next chunk was already prepared.

### `PAUSE_PLAYBACK`, `RESUME_PLAYBACK`, `STOP_PLAYBACK`

Transport controls for the offscreen audio player.

### `GET_PLAYBACK_STATUS`

Ask offscreen what it is doing now.

Used when the queue needs to decide whether to resume, stop, or dispatch a new
stream.

## Runtime Events From Offscreen

The offscreen document sends events back to the background.

Important events:

| Event | Meaning |
| --- | --- |
| `STREAM_PLAYBACK_PROGRESS` | Bytes/buffer/time changed |
| `CHUNK_PLAYBACK_STARTED` | Audible playback started for a chunk |
| `CHUNK_PLAYBACK_ENDED` | Chunk finished |
| `STREAM_PLAYBACK_ERROR` | Stream failed |
| `STREAM_PREPARE_READY` | Prepared lookahead stream has enough data |

The queue ignores stale events when possible. For example, if an old chunk
sends a late error after the user jumped to a new paragraph, the queue should
not destroy the current active state.

## End-To-End Message Example: Play Button

```txt
User clicks Play
  -> popup.js request("PLAY")
  -> service_worker.js handleScopedRequest(...)
  -> PlaybackQueue.start(...)
  -> PlaybackQueue asks active tab for page context
  -> content.js returns chapter/story context
  -> PlaybackQueue resolves session and chunk
  -> PlaybackQueue sends START_STREAM_PLAYBACK
  -> offscreen.js starts cached or live playback
  -> offscreen.js sends progress/start/end events
  -> PlaybackQueue updates session
  -> popup polls GET_STATE and re-renders
```

## End-To-End Message Example: Page Ready

```txt
Wattpad chapter loads
  -> content.js detects the reading page
  -> content.js extracts text and metadata
  -> content.js sends PAGE_READY with payload
  -> service_worker.js routes to queue.warmup(...)
  -> PlaybackQueue creates/updates session and chunk records
  -> Warmup may start generating audio blobs
  -> popup later reads state with GET_STATE
```

## Why This Message Design Is Useful

Each runtime environment has limits:

- Popup disappears when closed.
- Service worker can be suspended.
- Content script can read page DOM but should not own global playback.
- Offscreen can play audio but should not decide product behavior.

Messages let each environment do only what it is good at.

