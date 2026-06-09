MVP goal

Build a browser extension that:

Takes hardcoded text first.
Splits it into chunks.
Sends chunks to Kokoro.
Receives WAV audio.
Converts or requests audio as Opus/WebM.
Saves chunks in IndexedDB.
Plays chunk 1 while chunks 2–N are generated/buffered.
Deletes or expires cached chunks later.

For MVP, I would do local Docker first, then add Modal.com as a second provider.

Kokoro-FastAPI is a useful starting point because it is already a Dockerized FastAPI wrapper for Kokoro and exposes OpenAI-compatible speech endpoints. Modal is also suitable later because it supports web-exposed functions for non-Python clients.

Recommended MVP architecture
Browser Extension
  ├─ Content script
  │   └─ extracts text / uses hardcoded text for MVP
  │
  ├─ Extension UI popup
  │   └─ Play, pause, stop, cache status
  │
  ├─ Service worker
  │   └─ orchestration, queue, API calls, IndexedDB writes
  │
  ├─ Offscreen audio document
  │   └─ actual audio playback
  │
  └─ IndexedDB
      └─ stores generated audio chunks temporarily

TTS Provider
  ├─ Local Docker Kokoro-FastAPI
  └─ Optional Modal.com Kokoro endpoint

Chrome Manifest V3 service workers cannot reliably act like normal DOM pages, so audio playback is better handled through an offscreen document. Chrome’s offscreen documents exist specifically for extension cases that need DOM/window APIs not available in service workers.

Phase 1 — Hardcoded text MVP

Start with no scraping and no chapter switching.

Features
Hardcoded text
→ split into chunks
→ generate audio chunks
→ save chunks to IndexedDB
→ play from IndexedDB
Chunking rule

Use simple chunking first:

const MAX_CHARS = 600;

Rules:

Prefer paragraph boundaries.
Fall back to sentence boundaries.
Avoid chunks longer than 800–1,000 characters.
Keep chunk IDs stable using a hash.

Example chunk model:

type TextChunk = {
  storyId: string;
  chapterId: string;
  chunkIndex: number;
  text: string;
  textHash: string;
};
Phase 2 — IndexedDB schema

Use three object stores.

db: "readaloud_mvp"

stores:
  chapters
  chunks
  audioChunks
chapters
type ChapterRecord = {
  chapterId: string;
  storyId: string;
  title: string;
  sourceUrl?: string;
  textHash: string;
  createdAt: number;
  expiresAt?: number;
};
chunks
type ChunkRecord = {
  chunkId: string;
  chapterId: string;
  chunkIndex: number;
  text: string;
  textHash: string;
  status: "pending" | "generating" | "ready" | "failed";
};
audioChunks
type AudioChunkRecord = {
  chunkId: string;
  chapterId: string;
  chunkIndex: number;
  mimeType: "audio/wav" | "audio/webm;codecs=opus";
  audioBlob: Blob;
  durationMs?: number;
  createdAt: number;
  expiresAt: number;
};

For the MVP, set:

expiresAt = Date.now() + 24 * 60 * 60 * 1000;

This keeps the feature positioned as temporary playback cache, not a permanent audiobook library.

Phase 3 — Local Docker Kokoro first

This is the best first implementation because it avoids Modal complexity while you prove the queue/playback design.

Use Kokoro-FastAPI

Run a local Docker Kokoro server:

docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest

Or GPU, depending on your machine:

docker run --gpus all -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-gpu:latest

Then your extension calls something like:

POST http://localhost:8880/v1/audio/speech

Kokoro-FastAPI is designed to be Dockerized and OpenAI-compatible, which makes it convenient to swap providers later.

TTS provider interface

Create a provider abstraction immediately:

export interface TTSProvider {
  synthesize(input: {
    text: string;
    voice: string;
    format: "wav" | "opus" | "webm";
  }): Promise<Blob>;
}

Local implementation:

export class LocalKokoroProvider implements TTSProvider {
  constructor(private baseUrl = "http://localhost:8880") {}

  async synthesize(input: {
    text: string;
    voice: string;
    format: "wav" | "opus" | "webm";
  }): Promise<Blob> {
    const response = await fetch(`${this.baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "kokoro",
        voice: input.voice,
        input: input.text,
        response_format: input.format === "webm" ? "wav" : input.format,
      }),
    });

    if (!response.ok) {
      throw new Error(`Kokoro failed: ${response.status}`);
    }

    return await response.blob();
  }
}

For MVP, accept WAV first. Add Opus/WebM conversion after playback works.

Phase 4 — Queue and read-ahead buffering

You want two loops:

Generator loop: creates audio chunks ahead.
Playback loop: plays ready chunks in order.
Buffer settings
const MIN_READY_CHUNKS = 2;
const TARGET_READY_CHUNKS = 5;
const MAX_READY_CHUNKS = 8;

Meaning:

Start playback once chunk 0 is ready.
Keep 3–8 chunks generated ahead.
Do not generate the whole chapter immediately.
Pause generation if buffer is too full.
Flow
User hits Play
→ check IndexedDB for chunk 0
→ if missing, generate chunk 0
→ play chunk 0
→ while chunk 0 plays, generate chunks 1–5
→ while chunk 1 plays, generate chunks 6–10
Pseudocode
async function startPlayback(chapterId: string) {
  await ensureChunksExist(chapterId);

  generationLoop(chapterId);
  playbackLoop(chapterId);
}

async function generationLoop(chapterId: string) {
  while (!stopped) {
    const readyCount = await countReadyAudioAhead(chapterId, currentChunkIndex);

    if (readyCount >= TARGET_READY_CHUNKS) {
      await sleep(500);
      continue;
    }

    const nextChunk = await getNextPendingChunk(chapterId);

    if (!nextChunk) {
      await sleep(500);
      continue;
    }

    await markGenerating(nextChunk.chunkId);

    try {
      const audioBlob = await ttsProvider.synthesize({
        text: nextChunk.text,
        voice: "af_heart",
        format: "wav",
      });

      await saveAudioChunk({
        chunkId: nextChunk.chunkId,
        chapterId,
        chunkIndex: nextChunk.chunkIndex,
        mimeType: "audio/wav",
        audioBlob,
        createdAt: Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      });

      await markReady(nextChunk.chunkId);
    } catch (err) {
      await markFailed(nextChunk.chunkId);
    }
  }
}

async function playbackLoop(chapterId: string) {
  while (!stopped) {
    const audio = await waitForAudioChunk(chapterId, currentChunkIndex);

    await offscreenPlayer.play(audio.audioBlob, audio.mimeType);

    currentChunkIndex++;
  }
}
Phase 5 — Playback in extension

Do not put playback directly in the service worker.

Use:

service_worker.ts
→ sends message to offscreen.html
→ offscreen.ts creates Audio element
→ plays Blob URL
Offscreen player API
// service_worker.ts
await chrome.runtime.sendMessage({
  type: "PLAY_AUDIO_CHUNK",
  chunkId,
  blobUrl,
});

But since Blob URLs may not transfer cleanly between contexts, better:

service worker asks offscreen doc to load from IndexedDB by chunkId

So:

await chrome.runtime.sendMessage({
  type: "PLAY_CHUNK_FROM_IDB",
  chunkId,
});

Then offscreen.ts:

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type !== "PLAY_CHUNK_FROM_IDB") return;

  const record = await getAudioChunk(msg.chunkId);
  const url = URL.createObjectURL(record.audioBlob);

  const audio = new Audio(url);

  audio.onended = () => {
    URL.revokeObjectURL(url);
    chrome.runtime.sendMessage({
      type: "CHUNK_PLAYBACK_ENDED",
      chunkId: msg.chunkId,
    });
  };

  await audio.play();
});
Phase 6 — WAV now, Opus/WebM later

For MVP, do WAV end-to-end first.

Why:

Easier debugging.
Browser can play it.
No encoding pipeline complexity.

Then add Opus/WebM.

Option A — Request compressed output from backend

Best if Kokoro-FastAPI supports your desired response_format.

response_format: "opus"

or:

response_format: "mp3"

Then store returned blob.

Option B — Convert on backend with FFmpeg

Better than doing it in the extension.

Kokoro generates WAV
→ backend ffmpeg converts WAV to WebM/Opus
→ extension stores WebM/Opus

Example command:

ffmpeg -i input.wav -c:a libopus -b:a 32k output.webm
Option C — Convert in browser

Possible, but I would avoid for MVP. Browser-side encoding adds complexity, CPU usage, and extension compatibility issues.

Phase 7 — Modal.com implementation

Add Modal after local Docker works.

Use the same provider interface:

const provider =
  mode === "local"
    ? new LocalKokoroProvider()
    : new ModalKokoroProvider();

Modal can expose functions over the web for non-Python clients, so your extension can call a Modal web endpoint directly or through your own backend.

Option 1 — Extension → Modal directly
Extension
→ Modal web endpoint
→ Kokoro generates WAV/Opus
→ response returns audio
→ extension stores in IndexedDB

Pros:

Fewer moving parts.
Fast MVP.

Cons:

You expose an endpoint to the client.
Need auth/rate limiting.
Harder to hide abuse controls.
Option 2 — Extension → Your backend → Modal
Extension
→ your backend
→ Modal function
→ your backend returns audio
→ extension stores in IndexedDB

Pros:

Better auth.
Better logging.
Better abuse prevention.
Easier to switch providers.

Cons:

More work.

For MVP, I’d do:

Local Docker first
→ then backend proxy
→ then Modal behind backend

Not direct extension-to-Modal unless this is only an internal prototype.

Modal provider shape
export class ModalKokoroProvider implements TTSProvider {
  constructor(private endpointUrl: string, private token: string) {}

  async synthesize(input: {
    text: string;
    voice: string;
    format: "wav" | "opus" | "webm";
  }): Promise<Blob> {
    const response = await fetch(this.endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        text: input.text,
        voice: input.voice,
        format: input.format,
      }),
    });

    if (!response.ok) {
      throw new Error(`Modal TTS failed: ${response.status}`);
    }

    return await response.blob();
  }
}
Phase 8 — Minimal backend API

Even for local Docker, you may want a small backend proxy:

POST /tts
GET /health
POST /tts

Request:

{
  "text": "Hello world",
  "voice": "af_heart",
  "format": "wav"
}

Response:

Content-Type: audio/wav

or:

Content-Type: audio/webm; codecs=opus

This lets the extension call one API regardless of local Docker or Modal.

Extension → Backend /tts → Local Kokoro
Extension → Backend /tts → Modal Kokoro
Phase 9 — MVP folder structure
readaloud-extension/
  extension/
    manifest.json
    src/
      popup/
        popup.html
        popup.ts
      content/
        content.ts
      background/
        service_worker.ts
      offscreen/
        offscreen.html
        offscreen.ts
      db/
        idb.ts
      tts/
        TTSProvider.ts
        LocalKokoroProvider.ts
        ModalKokoroProvider.ts
      audio/
        playbackQueue.ts
      text/
        chunkText.ts

  backend/
    app.py
    tts_local.py
    tts_modal.py
    Dockerfile

  docker-compose.yml
Phase 10 — Browser extension permissions

Start minimal:

{
  "manifest_version": 3,
  "name": "Readaloud MVP",
  "version": "0.1.0",
  "permissions": [
    "storage",
    "offscreen",
    "activeTab"
  ],
  "host_permissions": [
    "http://localhost:8880/*",
    "http://localhost:3000/*"
  ],
  "background": {
    "service_worker": "src/background/service_worker.js"
  },
  "action": {
    "default_popup": "src/popup/popup.html"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/content/content.js"]
    }
  ]
}

For early MVP, you can even skip content scripts and use hardcoded text in the popup/background.

Phase 11 — Playback states

Implement these states:

type PlayerState =
  | "idle"
  | "preparing"
  | "generating"
  | "playing"
  | "paused"
  | "buffering"
  | "ended"
  | "error";

UI should show:

Generating 3 / 20 chunks
Playing chunk 1 / 20
Buffered: 5 chunks
Cache: temporary
Phase 12 — MVP milestones
Milestone 1: Local text → local Kokoro → play WAV

Success criteria:

Click Play
→ hardcoded text is chunked
→ chunk 0 sent to local Kokoro
→ WAV returned
→ audio plays
Milestone 2: IndexedDB cache

Success criteria:

Click Play once
→ chunks generated and stored

Click Play again
→ audio loads from IndexedDB
→ no TTS request for existing chunks
Milestone 3: Read-ahead generation

Success criteria:

Chunk 0 plays
→ chunks 1–5 generate in background
→ playback continues without gaps
Milestone 4: Offscreen playback

Success criteria:

Popup can close
→ audio continues playing
→ service worker coordinates state
→ offscreen document handles Audio element
Milestone 5: Backend abstraction

Success criteria:

Switch provider config:
local | modal

No extension playback code changes.
Milestone 6: Modal TTS

Success criteria:

Extension/backend sends chunk to Modal
→ Modal returns audio
→ IndexedDB stores it
→ playback works same as local Docker
Milestone 7: WebM/Opus

Success criteria:

Audio stored as audio/webm;codecs=opus
→ smaller IndexedDB usage
→ playback still smooth
What I would build first

Build in this exact order:

1. Hardcoded text chunker
2. Local Docker Kokoro endpoint
3. WAV playback without IndexedDB
4. IndexedDB save/load
5. Playback queue
6. Read-ahead generation
7. Offscreen document playback
8. Backend proxy
9. Modal provider
10. Opus/WebM conversion

Do not start with:

chapter extraction
auto-next
translation
MP3 export
full audiobook saving

Those can wait until the audio pipeline is stable.

MVP risk controls

Even during MVP, bake in these defaults:

Cache type: temporary
Default expiry: 24 hours
Export: disabled
Full book generation: disabled
Background crawling: disabled
Translation: disabled for third-party sites

Use this product language:

“Continuous read-aloud with temporary buffering.”

Avoid this language:

“Convert any online story into an audiobook.”

Final recommendation

For your MVP, I’d implement:

Browser extension
→ local Docker Kokoro-FastAPI
→ WAV chunks
→ IndexedDB temporary cache
→ offscreen document playback
→ read-ahead buffer of 3–8 chunks

Then add:

Backend proxy
→ Modal Kokoro provider
→ optional WebM/Opus conversion

This gives you the exact UX you want — playback starts quickly while future chunks generate — without prematurely building the legally riskiest parts.