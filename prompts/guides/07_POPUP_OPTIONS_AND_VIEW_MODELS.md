# 07. Popup, Options, and View Models

This guide explains how the extension UI is connected to the rest of the
system.

Relevant files:

```txt
features/readaloud-extension/extension/src/popup/popup.html
features/readaloud-extension/extension/src/popup/popup.js
features/readaloud-extension/extension/src/popup/popupState.js
features/readaloud-extension/extension/src/options/options.html
features/readaloud-extension/extension/src/options/options.js
features/readaloud-extension/extension/src/shared/userSettings.js
features/readaloud-extension/extension/tests/popupState.test.js
features/readaloud-extension/extension/tests/libraryState.test.js
features/readaloud-extension/extension/tests/userSettings.test.js
```

## UI Layer Rule

The UI layer should mostly:

```txt
render state
send commands
handle user interaction
```

It should not own:

- Page extraction.
- TTS requests.
- Playback state machine.
- IndexedDB cache rules.

Those belong to content script, queue, offscreen document, and storage helpers.

## Popup Files

### `popup.html`

Defines the toolbar popup UI and CSS.

Contains:

- Player view.
- Guide view.
- Library view.
- Transport buttons.
- Sleep timer menu.
- Sync toggle.
- Voice selector.
- Progress bars.

The CSS is embedded in the HTML file.

### `popup.js`

Owns runtime UI behavior:

- Sends messages to background.
- Polls/refreshes state.
- Handles button clicks.
- Renders library rows.
- Renders guide/recents.
- Updates sleep timer display.
- Updates Sync toggle display.

Important helper:

```js
request(type, payload = {})
```

This is the popup's only way to talk to the background.

### `popupState.js`

Pure view-model helpers.

Important functions:

- `isPauseable(state)`
- `computeElapsedMs(state, now)`
- `formatTimer(elapsedMs)`
- `getWarmedRatio(state)`
- `getChapterRatio(state)`
- `buildLibraryViewModel(library)`
- `selectPrimaryView(...)`
- `buildGuideViewModel(recents)`
- `buildPopupViewModel(state, now)`

Technical term:

- **View model**: A UI-friendly object created from lower-level data.

Example:

Raw runtime state may contain many fields. The popup view model reduces it to:

```js
{
  title,
  pauseable,
  timerLabel,
  warmedRatio,
  chapterRatio,
  errorMessage,
  currentVoiceId,
  currentVoiceLabel
}
```

## Popup Top-Level Views

Function:

```js
selectPrimaryView({ pageContext, state, libraryOpen })
```

Possible views:

- `player`
- `guide`
- `library`

Rules:

- If library is open, show library.
- If current page is a supported Wattpad chapter/story page, show player.
- If playback is active, show player even on unsupported pages.
- Otherwise show guide.

Why:

- User should not lose controls while audio is active.
- Unsupported pages should not show fake playable state.

## Popup Refresh Flow

Main function:

```js
refreshState()
```

Flow:

1. Request `GET_STATE`.
2. Render player view from runtime state.
3. Request `PAGE_CONTEXT_GET`.
4. Decide primary view.
5. If library view, refresh library.
6. If guide view, refresh recents.
7. If player view, refresh Sync status if needed.

Important detail:

- Popup does not directly know if the active tab is a chapter.
- It asks background, and background asks content script.

## Transport Buttons

Play button:

```js
request(isPauseable(lastState) ? "PAUSE" : "PLAY")
```

Meaning:

- Same button sends `PLAY` or `PAUSE`.
- Decision is based on current runtime state.

Stop button:

```js
request("STOP")
```

Voice selector:

```js
request("PLAYBACK_SET_VOICE", { voiceId: select.value })
```

## Sleep Timer UI

Popup messages:

- `SLEEP_GET`
- `SLEEP_SET`

Sleep menu payloads:

Duration:

```js
{ mode: "duration", durationMs: Number(option.dataset.duration) }
```

End of chapter:

```js
{ mode: "end_of_chapter" }
```

Off:

```js
{ mode: "off" }
```

Popup displays:

- Countdown for duration mode.
- `Chapter` for end-of-chapter mode.
- Nothing when off.

## Sync Toggle UI

Popup messages:

- `SYNC_GET`
- `SYNC_SET`

Flow:

1. Popup asks `SYNC_GET`.
2. Background resolves current story.
3. Popup shows toggle only if story context exists.
4. User clicks toggle.
5. Popup sends:

```js
{
  storyId: syncStatus.storyId,
  enabled: !syncStatus.enabled
}
```

## Library UI in Popup

Popup message:

```txt
LIBRARY_GET
```

Returns grouped stories from queue.

Popup turns this into a view model:

```js
buildLibraryViewModel(library)
```

Then renders:

- Story title.
- Story cover.
- Summary.
- Continue button.
- Chapter rows.
- Status badges.
- Voice chips.
- Delete buttons.

Delete behavior:

- First click asks for confirmation by changing button appearance/text.
- Second click sends delete message.
- Confirmation resets after `CONFIRM_RESET_MS`.

## Guide View

Shown when:

- Current tab is unsupported.
- Nothing is playing.
- Library is not open.

Uses:

```txt
RECENTS_GET
```

Then:

```js
buildGuideViewModel(recents)
```

Guide recents come from last-played cursor records.

## Options Page

Files:

```txt
features/readaloud-extension/extension/src/options/options.html
features/readaloud-extension/extension/src/options/options.js
```

Options page provides a larger UI for:

- Library.
- Default voice settings.

It uses the same background message pattern:

```js
chrome.runtime.sendMessage({
  scope: "readaloud",
  type,
  payload
})
```

## Options Library

Options page can:

- Load library with `LIBRARY_GET`.
- Delete story with `LIBRARY_DELETE_STORY`.
- Delete chapter voice with `LIBRARY_DELETE_CHAPTER_VOICE`.
- Continue story with `LIBRARY_CONTINUE`.

It uses `buildLibraryViewModel(...)` from popup state helpers, so popup and
options page share the same library formatting rules.

## Default Voice Settings

Files:

```txt
features/readaloud-extension/extension/src/shared/userSettings.js
features/readaloud-extension/extension/src/options/options.js
```

Voice list:

```js
VOICE_OPTIONS
```

Stored setting:

```js
defaultVoice
```

Options page:

1. Loads settings with `loadUserSettings(chrome.storage.local)`.
2. Renders voice cards.
3. Saves changes with `saveUserSettings(...)`.

Important detail:

- Changing default voice affects new chapters.
- Already existing sessions/voice variants may keep their own voice until the
  user switches voice.

## View Model Design

Why use view-model helpers?

- They keep UI rendering simpler.
- They make behavior testable without Chrome APIs.
- They centralize formatting decisions.

Example:

`formatBytes(bytes)` is used by library UI. It converts raw bytes into:

- `KB`
- `MB`
- `GB`

The UI does not need to know this logic.

## Error and Unavailable States

`buildPopupViewModel(...)` decides when to show an error/message.

Message is shown when:

- state is unavailable.
- play is blocked off-page.
- session state is error.
- playback status is error.

Important nuance:

- Off-page block is not treated exactly like a failure.
- It is an actionable hint to open the chapter page.

## Tests To Read

### `popupState.test.js`

Covers:

- Timer formatting.
- Running/paused elapsed time.
- Pause button rules.
- Progress ratios.
- Error visibility.
- Off-page block display.
- Primary view selection.
- Guide recents formatting.

### `libraryState.test.js`

Covers:

- Library statuses.
- Story title heuristics.
- Scraped story metadata.
- Last played/Continue.
- Human-readable sizes.
- Voice variants.

### `userSettings.test.js`

Covers:

- Default voice fallback.
- Supported voice persistence.
- Invalid voice normalization.
- Voice metadata lookup.

## How To Debug UI

Use this order:

1. Check what message the UI sends.
2. Check background route in `service_worker.js`.
3. Check queue method result.
4. Check view-model helper.
5. Check render function.

Example:

```txt
Sync toggle not showing
  -> popup refreshSync()
  -> request("SYNC_GET")
  -> service_worker route
  -> queue.getSyncStatus()
  -> queue.resolveSyncContext()
  -> popup renderSyncToggle()
```

