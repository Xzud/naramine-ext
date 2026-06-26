# 05. TTS Streaming and Audio Playback

This guide explains how text becomes audio and how audio is played.

Relevant files:

```txt
features/readaloud-extension/extension/src/tts/LocalKokoroProvider.js
features/readaloud-extension/extension/src/tts/ModalKokoroProvider.js
features/readaloud-extension/extension/src/tts/TTSProvider.js
features/readaloud-extension/extension/src/audio/playbackQueue.js
features/readaloud-extension/extension/src/offscreen/offscreen.js
features/readaloud-extension/extension/src/offscreen/wavStreamPlayer.js
features/readaloud-extension/extension/src/db/idb.js
features/readaloud-extension/backend/app.py
features/readaloud-extension/backend/tts_local.py
features/readaloud-extension/backend/tts_modal.py
features/readaloud-extension/extension/tests/wavStreamPlayer.test.js
features/readaloud-extension/backend/test_streaming.py
```

## The Big Picture

The system has two ways to get audio for a text chunk:

```txt
Cached audio in IndexedDB
Live TTS stream from /tts/stream
```

Playback chooses cached audio when it exists. If there is no cached blob for
the chunk, playback uses live TTS streaming.

At the same time, warmup can generate and save future chunks into IndexedDB.

## TTS Request Shape

The extension provider classes build requests like this:

```js
{
  url: "http://localhost:3000/tts/stream",
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    text: chunk.text,
    voice: session.voice,
    format: "wav",
    chunk_id: chunk.chunkId,
    chapter_id: session.chapterId
  })
}
```

Important fields:

- `text`
  - The chunk text to synthesize.

- `voice`
  - Voice ID such as `af_heart`.

- `format`
  - Currently `wav`.

- `chunk_id`
  - Optional metadata for backend/logging.

- `chapter_id`
  - Optional metadata for backend/logging.

Technical term:

- **Synthesize**: Generate speech audio from text.

## Provider Classes

### `TTSProvider.js`

Base interface:

```js
createStreamRequest()
synthesize()
```

It throws if a subclass does not implement these methods.

Technical term:

- **Interface/base class**: A shared shape other classes are expected to follow.

### `LocalKokoroProvider.js`

Builds requests for local/proxy TTS.

Default base URL:

```txt
http://localhost:3000
```

Stream endpoint:

```txt
/tts/stream
```

Full synthesis endpoint:

```txt
/tts
```

### `ModalKokoroProvider.js`

Also builds proxy requests, but supports an authorization token when needed.

Important distinction:

- The frontend provider class does not by itself decide local vs Modal backend
  mode.
- The FastAPI proxy decides local vs Modal based on `TTS_MODE`.

## Backend TTS Proxy

Main file:

```txt
features/readaloud-extension/backend/app.py
```

Endpoints:

### `GET /health`

Returns:

```json
{
  "status": "ok",
  "mode": "local"
}
```

or:

```json
{
  "status": "ok",
  "mode": "modal"
}
```

### `POST /tts`

Returns a complete audio file body.

Used when code wants:

```txt
request -> wait for all bytes -> response.blob()
```

### `POST /tts/stream`

Returns a streaming response.

Used when code wants:

```txt
request -> receive bytes progressively -> start playing before all bytes arrive
```

Technical term:

- **Streaming response**: The server sends bytes over time instead of waiting
  until the whole output is ready.

## Backend Local Mode

File:

```txt
features/readaloud-extension/backend/tts_local.py
```

Talks to:

```txt
http://localhost:8880/v1/audio/speech
```

It sends a Kokoro-compatible payload:

```json
{
  "model": "kokoro",
  "voice": "af_heart",
  "input": "text",
  "response_format": "wav"
}
```

## Backend Modal Mode

File:

```txt
features/readaloud-extension/backend/tts_modal.py
```

Reads:

- `MODAL_TTS_URL`
- `MODAL_TTS_TOKEN`

Then forwards text/voice/format to the deployed Modal endpoint.

## WAV Format

The TTS backend returns WAV bytes.

WAV has two major parts:

```txt
Header metadata
PCM audio data
```

Header includes:

- RIFF marker.
- WAVE marker.
- `fmt ` section.
- `data` section.
- Sample rate.
- Channel count.
- Bits per sample.
- Byte alignment.

Technical terms:

- **RIFF/WAVE**: The container structure for WAV files.
- **Sample rate**: Number of audio samples per second, such as 24000 or 44100.
- **Channel**: Mono has 1 channel, stereo has 2.
- **Bits per sample**: How many bits represent one audio sample.
- **PCM**: Raw audio sample data inside the WAV file.

## `WavStreamPlayer`

File:

```txt
features/readaloud-extension/extension/src/offscreen/wavStreamPlayer.js
```

Main responsibilities:

- Fetch the stream.
- Read bytes progressively.
- Parse the WAV header.
- Queue PCM bytes.
- Convert PCM frames into Web Audio buffers.
- Schedule buffers gaplessly.
- Track progress, pause/resume, and end state.

## WAV Stream Flow

Method:

```js
open(request)
```

Flow:

```txt
fetch(request.url)
  -> get response.body
  -> get reader with response.body.getReader()
  -> consumeStream(reader)
```

`consumeStream(reader)` repeatedly calls:

```js
reader.read()
```

Each read returns:

```js
{
  value: Uint8Array,
  done: boolean
}
```

Technical terms:

- **Uint8Array**: A JavaScript typed array holding raw bytes.
- **Reader**: Object used to pull chunks of bytes from a stream.

## Header Parsing

Function:

```js
parseWavHeader(buffer)
```

It waits until enough bytes exist to read the header.

If bytes are incomplete:

```js
return null
```

If bytes are invalid:

```js
throw new Error(...)
```

If valid:

```js
return {
  audioFormat,
  channels,
  sampleRate,
  byteRate,
  blockAlign,
  bitsPerSample,
  dataOffset,
  dataSize,
  bytesPerSample,
  bytesPerFrame
}
```

Why this matters:

- The player cannot correctly interpret PCM data until it knows how many bytes
  form one audio frame.

## PCM Queue

`WavStreamPlayer` has an internal `ByteQueue`.

It stores PCM bytes that arrived but have not yet been scheduled into Web
Audio.

Important methods:

- `append(chunk)`
- `readAligned(maxBytes, alignment)`
- `skipAligned(maxBytes, alignment)`
- `clear()`

Technical term:

- **Alignment**: Reading only complete audio frames, not half a sample/frame.

## Start Buffer

The player does not start immediately on the first byte.

It waits until there is enough buffered audio:

```js
DEFAULT_START_BUFFER_MS = 180
```

Why:

- Starting too early can cause stalls.
- Waiting for a small buffer improves smoothness.

Prepared streams use:

```js
STREAM_READY_BUFFER_MS = 750
```

That gives lookahead chunks more buffer before they are promoted to active
playback.

## Scheduling Audio

Method:

```js
schedulePendingAudio()
```

Flow:

1. Read aligned PCM bytes.
2. Calculate frame count.
3. Create an `AudioBuffer`.
4. Decode frames into the buffer.
5. Create an `AudioBufferSourceNode`.
6. Connect it to the gain node.
7. Start it at `scheduledUntil`.
8. Advance `scheduledUntil`.

Technical terms:

- **AudioContext**: Browser Web Audio engine.
- **AudioBuffer**: In-memory decoded audio sample buffer.
- **AudioBufferSourceNode**: A Web Audio node that plays an `AudioBuffer`.
- **GainNode**: A Web Audio node that controls volume.
- **Gapless scheduling**: Scheduling each buffer at the exact time the previous
  one ends, avoiding silence between blocks.

## Offscreen Slot System

File:

```txt
features/readaloud-extension/extension/src/offscreen/offscreen.js
```

The offscreen document tracks stream slots in:

```js
const streamSlots = new Map();
```

Slot roles:

- `active`
  - Currently audible chunk.

- `prepared`
  - Lookahead chunk being buffered for later.

Why slots exist:

- Current chunk can play.
- Next chunk can buffer in parallel.
- Handoff can be smoother when current chunk ends.

## Cached-vs-Live Decision

Function:

```js
resolveStreamRequest(message, slot, cachedAudio = null)
```

Flow:

1. Try `loadCachedAudio(message.chunkId)`.
2. If a cached blob exists:
   - Create an object URL.
   - Return a `GET` request to that object URL.
3. If no cached blob exists:
   - Build a TTS stream request.

Technical terms:

- **Object URL**: A temporary browser URL pointing at a local `Blob`.
- **Cache miss**: The requested cached item does not exist.
- **Cache hit**: The requested cached item exists.

## Current Cache Behavior

Current playback behavior:

```txt
For the chunk to play:
  if IndexedDB has a WAV blob -> play cached blob
  else -> call /tts/stream and play live
```

Current warmup behavior:

```txt
In the background:
  find uncached chunk
  call TTS
  wait for response.blob()
  save blob to IndexedDB
  mark chunk ready
```

Important distinction:

- The active live stream is not currently saved into IndexedDB.
- Warmup may generate the same chunk separately for cache.

## Better Stream-Persist Architecture

The more efficient design would be:

```txt
call /tts/stream once
  -> send bytes to WavStreamPlayer immediately
  -> collect the same bytes in memory
  -> on successful stream end, create Blob
  -> save Blob to IndexedDB
  -> mark chunk ready
```

Benefits:

- One TTS request per chunk.
- No duplicate generation.
- Played chunks become reusable cache.

Risks/complexities:

- Need to store only complete chunks.
- Need to avoid marking partial failed streams as ready.
- Need memory limits for large chunks.
- Need to coordinate with prepared slots and retries.
- Need to decide how aborted paused/stopped streams are handled.

Important recommendation:

- Keep per-chunk blobs.
- Do not append the whole chapter into one giant file.

Why:

- Per-chunk blobs support resume.
- Per-chunk blobs support voice variants.
- Per-chunk blobs support deletion.
- Per-chunk blobs support partial cache progress.

## Active Playback Dispatch

File:

```txt
features/readaloud-extension/extension/src/audio/playbackQueue.js
```

Important method:

```js
startCurrentChunkStream(chapterId)
```

Responsibilities:

- Load session.
- Check pause/stop/error state.
- Check if chapter ended.
- Load current chunk record.
- Avoid duplicate dispatch for same chunk.
- Resume paused offscreen stream when possible.
- Use prepared slot if available.
- Otherwise send `START_STREAM_PLAYBACK`.
- Save session state before and after dispatch.

## Lookahead

Constant:

```js
STREAM_LOOKAHEAD_DEPTH = 2
```

Method:

```js
prefetchChunkAtOffset(chapterId, session, offset)
```

Meaning:

- Prepare chunk `currentChunkIndex + offset`.
- Do not make it audible yet.
- Used to reduce stalls between chunks.

## Pause and Resume

`WavStreamPlayer.pause()`:

- Stores played audio time.
- Marks state paused.
- Suspends `AudioContext`.

`WavStreamPlayer.resume()`:

- Resumes `AudioContext`.
- Adjusts playback timeline so elapsed time stays correct.
- Continues scheduling audio.

Important detail:

- Resume does not restart the network stream if the offscreen player still has
  the active slot.

## Error Handling

Errors can come from:

- TTS endpoint failure.
- Invalid WAV bytes.
- Network abort.
- Stale events from old attempts.
- Offscreen playback failure.

The queue uses attempt IDs to protect against stale events.

Technical term:

- **Attempt ID**: A unique ID for one playback attempt, used so late events from
  old attempts do not corrupt current state.

## Tests To Read

### `wavStreamPlayer.test.js`

Covers:

- WAV header parsing.
- Incomplete header handling.
- Invalid WAV rejection.
- Gapless scheduling.
- Pause/resume.
- Short streams.
- Mid-chunk resume offset.

### `backend/test_streaming.py`

Covers:

- `/tts/stream` returns `StreamingResponse`.
- Streamed chunks are yielded.
- Background cleanup callback is called.

### `playbackQueue.test.js`

Search for:

```txt
live stream
prepared
lookahead
warming pipeline
playback errors
pause
resume
```

These tests explain how the queue coordinates offscreen playback.

