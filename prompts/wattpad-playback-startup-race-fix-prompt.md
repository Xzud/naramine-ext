Wattpad playback startup race and buffering observability remediation plan

Goal

Fix the current Wattpad read-aloud runtime so that:

- buffered audio is clearly distinguished from active playback
- startup playback does not fail because of internal offscreen lifecycle races
- `AbortError` from `audio.play()` is treated as an interrupted startup condition unless proven to be a real unrecoverable playback failure
- the popup shows truthful progress for startup buffering, playback startup, and buffered-audio readiness
- failures remain explicit and traceable across popup, service worker, queue, and offscreen playback

This task is not about expanding site support or changing the overall architecture. Keep scope limited to the existing Wattpad-only flow under `features/readaloud-extension/`.

Current problems to address

1. Buffered chunks are easy to misread.
- The popup currently shows `Buffered chunks`, but that number represents ready audio cached for the active chapter rather than a precise “chunks remaining ahead of the current one” playback queue metric.
- This can make the runtime look healthy even when playback itself is failing.

2. Playback can fail after buffering succeeds.
- Recent state shows:
  - `Buffered chunks: 7`
  - `Playback: error`
  - `Last error: Error: AbortError: The play() request was interrupted by a call to pause()`
- That means synthesis and caching succeeded, but the offscreen audio element failed during the playback-start lifecycle.

3. Offscreen playback likely has a startup race.
- `audio.play()` is being interrupted by `pause()` or cleanup.
- This strongly suggests a lifecycle race where the extension is canceling or replacing the active audio element before playback startup has settled.

4. The queue may treat interrupted startup as a hard playback failure too early.
- `AbortError` can indicate a real browser/media problem.
- But it can also indicate that the extension itself interrupted the `play()` request.
- The runtime should distinguish these cases instead of immediately collapsing them into final `playback_failed`.

5. The popup lacks startup-stage clarity.
- The user cannot currently tell:
  - audio is buffered but playback has not started yet
  - playback startup is in progress
  - playback startup was interrupted and is retrying
  - playback is actively playing

Target behavior

- Pressing `Play` on a valid Wattpad reading page should:
  - extract chapter text
  - create chunk records
  - synthesize the startup buffer
  - begin playback only when startup conditions are satisfied
  - continue buffering future chunks while the current chunk is playing
  - advance only after the current chunk is confirmed ended

- The popup must clearly distinguish:
  - startup buffering progress
  - active playback
  - buffered audio availability
  - interrupted startup retry
  - unrecoverable playback failure

- If audio is buffered but playback cannot start, the runtime must surface that explicitly instead of implying the queue is advancing normally.

Implementation steps

1. Clarify the meaning of buffered audio in the runtime state contract.
- Preserve the existing `readyAudioCount` field if needed for compatibility.
- Add explicit naming or additional fields so the popup can distinguish:
  - total ready audio records for the chapter
  - startup buffer target
  - startup-ready count toward playback start
- Do not label chapter cache count as if it were exact forward queue depth unless it truly is.

2. Add explicit startup playback phases.
- Extend the queue lifecycle with startup-aware phases such as:
  - `startup_buffering`
  - `startup_ready`
  - `playback_starting`
  - `playing`
  - `awaiting_chunk_end`
  - `advancing`
  - `error`
- The user should be able to tell whether the system is still preparing enough audio to start or whether playback startup itself is failing.

3. Introduce a minimum startup buffer threshold.
- Do not start chunk 0 immediately on first synthesis.
- Require at least 3 ready chunks before first playback begins, unless the chapter has fewer than 3 total chunks.
- After playback has truly started, continue the normal read-ahead fill behavior.

4. Keep steady-state buffering separate from startup buffering.
- Startup buffering is a gate before first playback.
- Once the first chunk is actively playing, later chunk synthesis should continue in parallel as before.
- Do not regress the existing fix that prevents future chunk synthesis from replaying the current chunk.

5. Track playback attempts explicitly.
- Add a per-dispatch playback attempt identifier in the offscreen document and service worker session state.
- Include it in playback lifecycle events when practical.
- The goal is to let the queue ignore stale events from an earlier interrupted attempt.

6. Harden the offscreen playback startup path.
- Audit every path that can interrupt playback startup, including:
  - `clearCurrentAudio()`
  - `PAUSE_PLAYBACK`
  - `STOP_PLAYBACK`
  - replacement by a new `PLAY_CHUNK_FROM_IDB`
- Ensure the active `play()` promise is not interrupted by internal cleanup unless the extension intentionally cancels that exact attempt.

7. Distinguish interrupted startup from hard playback failure.
- Treat `AbortError` during playback startup as a first-class interrupted-startup condition.
- Preserve the exact browser error text.
- Retry safely if the interruption was caused by extension lifecycle behavior or a stale attempt.
- Escalate to final `playback_failed` only after bounded retry policy is exhausted or when the error is clearly unrecoverable.

8. Add bounded and visible retry behavior for startup interruption.
- If startup playback is interrupted, retry the same buffered chunk in a bounded way.
- Expose in state:
  - retry count
  - last retry reason
  - whether the retry is for interrupted startup vs real media failure
- Do not silently loop forever.

9. Improve popup startup diagnostics.
- Add or relabel popup fields so the user can see:
  - session state
  - playback status
  - current chunk index and total chunks
  - current chunk id
  - buffered audio count
  - startup buffer progress, for example `2 / 3 ready before playback start`
  - last event
  - last error
- If playback has not started yet because startup buffer threshold is not met, the popup must say that directly.

10. Improve popup wording around buffered chunks.
- Avoid wording that implies `Buffered chunks` means “guaranteed chunks left to play next.”
- Make the label clearly correspond to cached ready audio for the chapter or active session.
- If both chapter cache count and startup buffer progress are shown, keep them clearly separate.

11. Improve structured logs for playback startup.
- Add concise logs around:
  - startup buffer progress
  - playback dispatch requested
  - playback attempt id assigned
  - `audio.play()` requested
  - `audio.play()` resolved
  - `audio.play()` rejected
  - `pause()` called
  - audio cleared
  - playback ended
  - playback error
  - retry scheduled
- Logs should include chapter id, chunk id, and attempt id when available.

12. Update `logs.txt`.
- Document:
  - what `Buffered chunks` means
  - what startup buffer progress means
  - how to diagnose `AbortError`
  - which logs indicate startup interruption vs true playback failure
- Keep the file short and operational.

13. Preserve deterministic chunk advancement.
- `currentChunkIndex` must still advance exactly once per completed chunk.
- Startup interruption must not advance the chunk index.
- Only a confirmed end event for the active attempt may advance playback.

14. Prevent stale offscreen state from blocking redispatch.
- A stale offscreen `error` state for a prior attempt must not permanently block replay of the same chunk when the queue is intentionally retrying startup.
- Cleanup must reset offscreen state coherently before retry.

15. Add tests for startup buffering and interrupted play.
- Required queue/offscreen logic tests:
  - playback does not start until 3 startup chunks are ready, unless fewer total chunks exist
  - once startup threshold is met, chunk 0 dispatch begins
  - if `audio.play()` is interrupted by internal cleanup, the runtime records an interrupted-startup retry instead of immediate permanent failure
  - stale offscreen events from an older attempt do not poison the current attempt
  - chunk index does not advance on interrupted startup
  - chunk index still advances once on confirmed end

16. Add tests for popup state and wording.
- Required tests:
  - popup shows explicit startup buffer progress before playback begins
  - popup distinguishes buffered audio availability from active playback
  - popup does not mislabel buffered chapter cache as active playback progress
  - popup still represents unavailable state without fabricated playback metrics

17. Keep the implementation narrow.
- Do not introduce a new external state library.
- Do not redesign the entire queue or storage layer.
- Fix the startup race, startup threshold, diagnostics, and popup wording with the smallest coherent set of changes.

18. Validate manually after tests.
- On a valid Wattpad reading page:
  - press `Play`
  - confirm the popup shows startup buffering progress toward 3 ready chunks
  - confirm playback begins only after the threshold is met, or immediately if the chapter has fewer than 3 chunks total
  - confirm future chunks continue buffering while the current chunk is playing
  - confirm no internal `AbortError` occurs from self-interruption during healthy startup
  - confirm a real playback failure still surfaces clearly if the browser truly cannot play the chunk

Definition of done

- The popup no longer leaves buffered-audio meaning ambiguous.
- Startup buffering progress is visible and truthful.
- Playback does not begin until at least 3 chunks are ready, unless the chapter is shorter than that.
- `AbortError` caused by internal startup interruption is handled as a bounded retry condition rather than immediate permanent failure.
- Stale offscreen error state does not block redispatch of the same startup chunk.
- Buffered audio can continue building while the current chunk is playing.
- Chunk advancement remains deterministic and end-event driven.
- Tests cover startup buffering, interrupted play retry, popup wording, and no-regression playback advancement behavior.

Reviewer subagent checklist

Mark each item `PASS` or `FAIL`. Any `FAIL` in sections 1-6 blocks approval.

1. Buffered-audio semantics
- `PASS` if the implementation makes clear that buffered chunks represent ready synthesized audio rather than guaranteed forward playback depth.
- `PASS` if popup wording and/or state fields distinguish cached readiness from active playback progress.
- `FAIL` if `Buffered chunks` is still misleading in the same way as before.

2. Startup buffering behavior
- `PASS` if first playback waits for 3 ready chunks, unless the chapter has fewer than 3 total chunks.
- `PASS` if startup buffer progress is exposed clearly in runtime state or popup diagnostics.
- `FAIL` if playback still begins immediately after chunk 0 is synthesized during normal startup.

3. Playback startup race handling
- `PASS` if interrupted `audio.play()` startup is handled as a distinct bounded retry condition when appropriate.
- `PASS` if internal cleanup or stale state no longer causes permanent failure of a healthy buffered chunk.
- `FAIL` if `AbortError` from self-interruption still drops the session directly into unrecoverable playback failure during ordinary startup.

4. Offscreen/service-worker coordination
- `PASS` if playback attempts are tracked well enough to ignore stale or superseded playback events.
- `PASS` if stale offscreen error state does not block intended redispatch of the same startup chunk.
- `FAIL` if stale events or stale offscreen state can still poison the current playback attempt.

5. Deterministic advancement
- `PASS` if interrupted startup does not advance the chunk index.
- `PASS` if completed playback still advances exactly once per chunk end.
- `FAIL` if startup interruption can advance or corrupt `currentChunkIndex`.

6. UI trustworthiness
- `PASS` if the popup clearly distinguishes:
  - startup buffering
  - playback starting
  - actively playing
  - interrupted startup retry
  - final playback failure
- `PASS` if buffered-audio and playback-progress labels are truthful.
- `FAIL` if the popup still implies that buffered chunks mean playback is already healthy.

7. Tests
- `PASS` if automated tests cover:
  - startup threshold gating
  - interrupted `play()` retry behavior
  - stale-event/stale-state protection
  - popup wording/state for startup buffer progress
- `FAIL` if the implementation relies mostly on reasoning without regression coverage for the new startup-race behavior.

8. Scope discipline
- `PASS` if the implementation stays narrowly focused on the Wattpad playback startup race, buffering semantics, diagnostics, and popup wording.
- `FAIL` if it introduces unrelated architectural churn or feature expansion.
