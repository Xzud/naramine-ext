# Naramine Codebase Guides

These guides explain the readaloud extension for an entry-junior developer.
Read them in order the first time. After that, use the file names as a map
when you want to review one subsystem.

## Recommended Reading Order

1. `TECHNICAL_DETAIL.md`
   - The broad overview.
   - Start here when you want the full system in one pass.

2. `01_CODEBASE_MAP.md`
   - Where files live and what each folder owns.
   - Explains runtime JavaScript vs TypeScript companion files.

3. `02_EXTENSION_RUNTIME_AND_MESSAGES.md`
   - How popup, content script, background service worker, and offscreen
     document communicate.
   - Explains `message.type`, `payload`, `sender.tab.id`, and why the popup
     often does not know the page itself.

4. `03_WATTPAD_EXTRACTION_AND_CHUNKING.md`
   - How Wattpad pages become clean text and paragraph anchors.
   - How text becomes stable TTS chunks.

5. `04_STATE_STORAGE_AND_CACHE.md`
   - What lives in `chrome.storage.local`.
   - What lives in IndexedDB.
   - How sessions, chapters, chunks, audio blobs, recents, Sync, and settings
     relate to each other.

6. `05_TTS_STREAMING_AND_AUDIO_PLAYBACK.md`
   - How text becomes WAV audio.
   - How WAV bytes are streamed, parsed, decoded, scheduled, and played.
   - Current cache behavior compared with the better stream-persist design.

7. `06_PLAYBACK_QUEUE_FEATURES.md`
   - The main feature logic inside `PlaybackQueue`.
   - Covers play/pause/stop, warmup, prefetch, auto-advance, Sync, library,
     Continue, voice switching, and sleep timer.

8. `07_POPUP_OPTIONS_AND_VIEW_MODELS.md`
   - How the popup and options page render UI from background state.
   - Explains view models and why UI code mostly sends commands instead of
     owning business logic.

9. `08_BACKEND_AND_TESTING.md`
   - How the FastAPI backend proxies TTS.
   - How local and Modal modes differ.
   - What the tests cover and which commands verify the system.

10. `09_GLOSSARY_AND_READING_NOTES.md`
    - Plain-language definitions for common technical terms in this codebase.
    - Debugging and reading advice for junior developers.

## How To Use These Guides While Reading Code

Keep two windows open:

- One window with the relevant guide.
- One window with the source file mentioned in that guide.

When a guide names a method, search for it with:

```bash
rg -n "methodName" features/readaloud-extension
```

When a guide names a message type, search for it with:

```bash
rg -n '"MESSAGE_TYPE"' features/readaloud-extension
```

When you get lost, return to this mental model:

```txt
Wattpad page
  -> content script extracts page data
  -> background service worker routes commands
  -> PlaybackQueue owns state and decisions
  -> offscreen document plays audio
  -> backend returns WAV bytes from TTS
  -> IndexedDB stores reusable chunk audio blobs
```

## Important Vocabulary

- **Command**: A message asking another layer to do something, such as
  `PLAY`, `PAUSE`, or `READALOUD_EXTRACT_TEXT`.
- **Payload**: The data attached to a command. Example:
  `{ type: "SYNC_SET", payload: { storyId, enabled: true } }`.
- **Session**: The current saved playback state for a chapter.
- **Chapter**: A Wattpad part/page. Usually identified by Wattpad `partId`.
- **Chunk**: A smaller piece of chapter text sent to TTS.
- **Audio chunk**: The generated WAV blob for one text chunk.
- **Warmup**: Background generation of audio chunks into IndexedDB.
- **Live stream**: Immediate TTS stream used for playback right now.
- **Offscreen document**: Hidden extension page that owns audio playback.
- **IndexedDB**: Browser database used for persistent chapter/chunk/audio data.
- **`chrome.storage.local`**: Browser key-value storage used for sessions,
  user settings, Sync flags, sleep timers, and cursor records.
