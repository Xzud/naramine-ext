Wattpad eager buffering, background warmup, and transport-state remediation plan

Goal

Reshape the current Wattpad read-aloud flow so that:

- the extension recognizes a valid active Wattpad reading page as early as possible
- `queue.start()` is no longer effectively delayed until the user presses `Play`
- chapter extraction and chunk preparation can begin before playback is requested
- Kokoro synthesis begins in the background and builds a startup buffer ahead of user playback
- pressing `Play` consumes already-buffered audio whenever possible instead of restarting the pipeline from scratch
- playback continues while future chunks keep buffering in parallel
- pause, resume, stop, and retry behavior become transport-correct and predictable
- runtime state becomes trustworthy enough for both UI and debugging

This task is still scoped to the existing Wattpad-only extension under `features/readaloud-extension/`. Do not redesign the whole product or introduce a new state library.

Desired user flow

1. User opens a Wattpad reading page.
- The content/runtime layer recognizes that the active tab is a valid Wattpad reading document.
- The extension informs the service worker that a warmable reading session exists.

2. The queue warms automatically.
- The service worker initializes or refreshes a chapter session without waiting for the popup `Play` click.
- It extracts chapter text, creates chunk metadata, and starts background synthesis toward the startup buffer threshold.

3. Buffering continues in the background.
- The queue sends early chunks to Kokoro for synthesis and stores returned audio blobs in IndexedDB.
- The queue does not autoplay merely because warmup started.
- The queue remains in a non-playing warm/prebuffer state until the user explicitly presses `Play`.

4. User presses `Play`.
- If the startup buffer threshold is already satisfied, playback begins immediately from the buffered first chunk.
- If the startup buffer threshold is not yet satisfied, the UI should indicate that playback is waiting on startup buffering rather than restarting extraction.

5. Playback continues while buffering continues.
- While chunk 0 or later chunks are playing, the queue keeps synthesizing future chunks toward the steady-state target.
- Chunk advancement remains end-event driven and deterministic.

6. User presses `Pause`.
- The currently-playing audio pauses at the media layer.
- Resume should continue from the paused media position when possible instead of forcing a redispatch/restart path.

7. User presses `Stop`.
- Playback transport and queue state are both torn down coherently.
- Warmed cache may remain reusable for the active chapter if desired, but stopped playback must not leave ambiguous active transport state behind.

Current architectural mismatch

The current flow is too user-triggered at the wrong layer:

- `PLAY` currently drives extraction, session creation, chunk preparation, buffering, and transport startup all through `queue.start()`.
- That makes the first user interaction pay for extraction and startup buffering latency.
- It also blends together three distinct concerns:
  - page recognition / readiness
  - background prebuffering
  - explicit user playback intent

The current pause path is also incomplete:

- the queue sets a session-level paused state
- the offscreen player pauses the current `Audio` element
- but resume does not use the existing offscreen `RESUME_PLAYBACK` path
- instead, the queue re-enters `processSession()`

That means the system is only partially transport-aware and can restart queue logic when what the user really wants is a transport resume.

Target state model

Separate session readiness from playback intent.

The runtime should distinguish at least these concepts:

- page detected
- extraction ready
- chunk metadata prepared
- startup buffer warming
- startup buffer ready
- play requested
- playback starting
- playing
- paused
- buffering while playing
- ended
- error

Suggested session fields

Keep existing compatible fields where practical, but extend the model with explicit readiness and intent state:

- `pageDetected`
- `pageEligible`
- `warmupStatus`
  - `idle`
  - `detecting`
  - `extracting`
  - `prepared`
  - `warming`
  - `warm_ready`
  - `error`
- `playRequested`
- `autoplayAllowed`
  - should remain `false` for this flow
- `transportStatus`
  - `idle`
  - `starting`
  - `playing`
  - `paused`
  - `stopped`
  - `ended`
  - `error`
- `startupReadyAudioCount`
- `startupTargetReadyAudioCount`
- `startupBufferingComplete`
- `readyAudioCount`
- `currentChunkIndex`
- `currentChunkId`
- `playbackAttemptId`
- `lastEvent`
- `errorMessage`

Core design decision

Split the current `start()` semantics into two different intents.

1. Warmup intent
- Triggered automatically when a valid Wattpad reading page is detected in the active tab.
- Extracts text, ensures chapter data exists, creates or refreshes the session, and fills the startup buffer.
- Must not autoplay.

2. Playback intent
- Triggered when the user presses `Play`.
- If startup buffer is already ready, dispatch playback immediately.
- If warmup is still in progress, mark user intent and begin playback as soon as startup buffer conditions are satisfied.

Implementation strategy

1. Introduce explicit active-page warmup messages from content script to service worker.
- The content script already knows how to identify a Wattpad reading document.
- Add a lightweight signal when:
  - the page is a Wattpad reading page
  - the tab becomes active or relevant
  - the reading article/part id changes
- The signal should not send full extracted text every time unless necessary.
- Preferred message semantics:
  - `READALOUD_PAGE_READY`
  - includes `storyId`, `partId`, `sourceUrl`, `title`, and a cheap “page eligible” result

2. Add a warmup entrypoint in the queue.
- Create a queue path dedicated to prebuffering, for example:
  - `warmup(options)`
  - or `start({ intent: "warmup" })`
- This path should:
  - resolve active chapter identity
  - extract chapter text if needed
  - seed chapter/chunk data if missing or stale
  - start synthesizing toward the startup threshold
  - stop short of autoplaying

3. Make warmup idempotent.
- Repeated page-ready messages must not constantly recreate the same session.
- If the active chapter session already exists and matches the same `partId` and text hash:
  - keep the existing warmed state
  - continue buffering only if more audio is still needed
- If the chapter changed:
  - replace chapter/chunk data deterministically
  - reset session transport state safely

4. Preserve explicit user intent to play.
- Add a persisted `playRequested` or equivalent flag.
- Pressing `Play` should not mean “start extraction.”
- It should mean “start transport as soon as readiness conditions are met.”
- If warmup already produced enough ready chunks, playback should start immediately.

5. Separate warmup state from playback state in the queue.
- Do not overload `state: "preparing"` or `state: "buffering"` to mean every kind of non-playing work.
- Distinguish:
  - warmup buffering before any user play request
  - startup buffering after user play request but before transport begins
  - steady-state buffering while transport is already playing

6. Change `processSession()` so it respects user intent.
- Current logic starts trying playback as soon as startup conditions are met.
- After this fix:
  - if `playRequested` is false, `processSession()` may fill buffers but must not dispatch transport
  - if `playRequested` is true, `processSession()` may dispatch transport once startup threshold is satisfied

7. Keep startup threshold behavior.
- Preserve the current startup rule:
  - require 3 ready chunks before first playback
  - unless the chapter has fewer than 3 total chunks
- This is still correct and should now serve warmup as well as play startup.

8. Promote a true transport resume path.
- When the user pauses:
  - keep session and transport aligned
  - preserve the current playing chunk and media position
- When the user resumes:
  - prefer the offscreen `RESUME_PLAYBACK` path if the paused audio element is still valid
  - fall back to queue redispatch only if the paused transport no longer exists

9. Make stop semantics explicit.
- `Stop` should clear transport intent:
  - `playRequested = false`
  - transport state reset
- Decide whether warm cache should remain:
  - recommended: keep ready audio blobs for reuse during the same active chapter unless chapter content changed or TTL expired
- Stopping should not necessarily force full re-extraction next time.

10. Keep buffering while playing.
- Once playback has started, continue filling future chunks toward `TARGET_READY_CHUNKS`.
- Preserve the existing fix that prevents future synthesis completion from redispatching the current chunk.

11. Make stale-attempt handling and offscreen coordination stronger.
- Keep attempt ids.
- Continue ignoring stale `CHUNK_PLAYBACK_STARTED` / `ENDED` / `ERROR` events from older attempts.
- Add explicit handling for:
  - paused transport
  - resumed transport
  - stopped transport
- Ensure queue intent and offscreen transport cannot silently diverge for long.

12. Improve popup truthfulness.
- The popup should show separate concepts:
  - page detected / session live
  - warmup progress
  - startup buffer progress
  - transport status
  - whether `Play` is waiting on remaining warmup
  - ready audio cache count
- Avoid implying that a healthy cache count means transport is healthy.

13. Improve logging.
- Add concise logs for:
  - page detected
  - warmup started
  - warmup reused existing session
  - warmup skipped because chapter already warm
  - play intent recorded
  - resume requested
  - transport resumed from paused audio
  - transport fallback redispatch after pause when resume was impossible
  - stop cleared transport intent

Behavioral requirements

1. Opening a Wattpad reading page should warm the queue automatically.
- No popup interaction required for extraction and initial synthesis.

2. Warmup must not autoplay.
- Background buffering is allowed.
- Audible playback still requires explicit user action.

3. Pressing `Play` on a warmed chapter should feel immediate.
- If chunk 0 and the startup threshold are already satisfied, start transport with minimal delay.

4. Pressing `Play` before warmup finishes should not restart the pipeline.
- It should set play intent and continue the same warmup session until startup is ready.

5. Pressing `Pause` should perform a real pause.
- Pressing play again should preferentially resume rather than reconstructing playback from scratch.

6. Pressing `Stop` should stop transport cleanly without poisoning warmed chapter cache.

7. Chunk advancement must remain deterministic.
- No double-advance.
- No replay of the current chunk from future-buffer completion.
- No chunk-index movement on interrupted startup or paused transport.

Issues and incompleteness to fix

1. Warmup currently begins too late.
- Root issue:
  - extraction and buffering are triggered by `PLAY`
- Fix:
  - shift extraction and startup synthesis into automatic page-detected warmup

2. Page recognition is not yet part of the queue lifecycle.
- Root issue:
  - content script can detect Wattpad reading pages, but queue/session orchestration does not begin from that signal
- Fix:
  - add explicit page-ready handoff from content script to service worker

3. Playback intent and readiness are coupled.
- Root issue:
  - `start()` means both “prepare” and “play now”
- Fix:
  - split warmup intent from playback intent

4. Pause/resume is transport-incomplete.
- Root issue:
  - pause exists at media layer, but resume bypasses the dedicated transport resume path
- Fix:
  - implement resume-first transport behavior before falling back to redispatch

5. State semantics are overloaded.
- Root issue:
  - `state` and `playbackStatus` are doing too much overlapping work
- Fix:
  - define separate readiness/warmup vs transport/playback concepts

6. Failure handling is too coarse during synthesis.
- Root issue:
  - one synthesis failure can poison the whole session
- Fix:
  - at minimum, classify failure origin explicitly
  - optionally allow bounded per-chunk retry before collapsing the whole session

7. Offscreen and queue can diverge conceptually.
- Root issue:
  - queue may think “resume” while offscreen only knows paused audio
- Fix:
  - reconcile transport state explicitly through pause/resume/stop events

8. UI does not yet explain warmup vs play-waiting.
- Root issue:
  - buffered counts alone are not enough
- Fix:
  - expose play intent plus warmup readiness separately

Recommended implementation order

1. Define the revised session/runtime contract.
- Decide field names and the meaning of warmup vs transport state.

2. Add content-script page-ready signaling.
- Trigger only for valid Wattpad reading documents.
- Avoid noisy duplicate messages where possible.

3. Add queue warmup entrypoint and idempotent session reuse.
- No autoplay in this path.

4. Refactor `processSession()` around `playRequested`.
- Warm without transport until user intent exists.

5. Refactor play/pause/resume/stop transport commands.
- Ensure play after pause prefers true resume.

6. Update popup state model and wording.
- Show warmup truthfully.

7. Add logs and tests.

Tests to add

Queue/session tests

- warmup on detected Wattpad page creates a prepared session without dispatching playback
- warmup synthesizes toward startup threshold while `playRequested` is false
- pressing `Play` after warmup dispatches immediately when startup threshold is already met
- pressing `Play` before startup threshold is met sets play intent and later starts automatically once threshold is reached
- pressing `Pause` keeps current chunk index stable and marks transport paused
- pressing `Play` after pause prefers offscreen resume instead of redispatch when paused audio still exists
- pressing `Stop` clears transport intent and stops offscreen audio without forcing full chapter re-extraction on the next play
- changing to a different Wattpad part invalidates or replaces the old session deterministically

Popup/view-model tests

- popup distinguishes warmup state from active playback
- popup shows startup buffer progress separately from chapter cache count
- popup shows play requested but waiting on warmup when applicable
- popup does not fabricate active playback metrics when only warmup is happening

Integration/manual checks

- open a Wattpad reading page and confirm warmup begins before opening the popup
- open popup and confirm ready counts rise while transport remains idle
- press `Play` after warmup and confirm near-immediate chunk 0 playback
- press `Play` during warmup and confirm no extraction restart, only continued startup buffering
- press `Pause` and confirm playback resumes from the paused chunk rather than restarting it
- press `Stop` and confirm transport ends cleanly while cache remains coherent

Definition of done

- Active Wattpad reading-page detection automatically starts session warmup.
- `queue.start()` semantics are split or extended so extraction/buffering can happen before explicit playback.
- Background synthesis fills the startup buffer without autoplay.
- Pressing `Play` uses the already-buffered audio when ready.
- Buffering continues while audio is playing.
- Pause/resume behavior is transport-correct and no longer queue-only.
- UI distinguishes warmup, play-waiting, active playback, and cache readiness.
- Existing startup-race protections and deterministic chunk advancement remain intact.
- Tests cover warmup-before-play, play-intent gating, pause/resume, stop semantics, and chapter change behavior.

Reviewer checklist

Mark each item `PASS` or `FAIL`.

1. Early warmup
- `PASS` if a valid active Wattpad reading page can start queue warmup without waiting for popup `Play`
- `FAIL` if extraction/buffering still only begins on explicit `PLAY`

2. No unwanted autoplay
- `PASS` if automatic warmup does not audibly start playback on its own
- `FAIL` if background warmup can trigger transport without user intent

3. Buffered play responsiveness
- `PASS` if pressing `Play` after warmup uses existing buffered audio instead of restarting extraction
- `FAIL` if play still redoes the whole pipeline despite a warm session

4. Transport correctness
- `PASS` if pause/resume is mediated as a true transport action when possible
- `FAIL` if resume always re-enters queue logic and restarts chunk playback unnecessarily

5. State clarity
- `PASS` if runtime state clearly separates warmup/readiness from transport/playback
- `FAIL` if `state` and `playbackStatus` remain ambiguous enough to hide what phase the system is truly in

6. No regression in playback determinism
- `PASS` if chunk advancement still occurs exactly once per real end event
- `FAIL` if the redesign reintroduces duplicate dispatch or replay races
