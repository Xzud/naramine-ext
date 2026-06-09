Wattpad playback and observability remediation plan

Goal

Fix the current Wattpad read-aloud runtime so that:

- playback advances through chapter chunks instead of replaying the same chunk or looping indefinitely
- the service worker always returns a real diagnostic state object to the popup
- the popup shows meaningful, trustworthy metrics instead of placeholder zeros
- failures are explicit and traceable across content script, service worker, and offscreen playback

This task is not about expanding site support. Keep scope limited to the existing Wattpad-only flow.

Current problems to address

1. Playback can loop the same chunk.
- The queue may replay the current chunk when buffering finishes around the same time the offscreen player ends audio.
- Advancement currently depends on the `CHUNK_PLAYBACK_ENDED` message landing before replay logic rechecks playback.

2. The popup is not trustworthy.
- The popup currently shows placeholder values like `0 / 0` and `Source: none (n/a)` when it cannot get real state.
- This hides the actual runtime failure and makes debugging harder.

3. Runtime failures are not visible end-to-end.
- Content extraction, service worker orchestration, and offscreen playback do not expose a unified state model.
- The user cannot tell whether the failure is:
  - page extraction
  - chunk generation
  - audio playback
  - service worker messaging
  - offscreen runtime lifecycle

4. The system does not have a reliable notion of "currently playing", "awaiting end event", or "advancing".
- That makes race conditions possible and makes the UI misleading.

Target behavior

- Pressing `Play` on a valid Wattpad reading page should:
  - extract chapter text
  - create chunk records
  - synthesize chunk 0
  - play chunk 0 once
  - advance to chunk 1 only after chunk 0 is confirmed ended
  - continue until all chunks are played or a clear error occurs

- The popup must show real state, including:
  - current phase
  - current chunk index
  - total chunks
  - currently playing chunk id
  - buffered chunk count
  - extraction strategy and confidence
  - last error, if any
  - whether the state is live or unavailable

- If state cannot be read, the popup must say that explicitly and not fabricate playback metrics.

Implementation steps

1. Define a single runtime state contract.
- Create a clear session state shape used by the service worker and popup.
- Include at least:
  - `chapterId`
  - `storyId`
  - `partId`
  - `title`
  - `state`
  - `playbackStatus`
  - `currentChunkIndex`
  - `currentChunkId`
  - `totalChunks`
  - `readyAudioCount`
  - `failedCount`
  - `extractionStrategy`
  - `extractionConfidence`
  - `lastEvent`
  - `errorMessage`
  - `stateAvailable`

2. Stop using placeholder UI data as if it were real state.
- The popup may render an error card if no state is returned.
- But it must not present fake playback numbers like `0 / 0` as if they were real metrics.
- Separate:
  - `no state available`
  - `state available but idle`
  - `state available but error`

3. Make `GET_STATE` always return a structured object.
- The service worker should never return `undefined` for normal popup calls.
- If the service worker is alive but has no session, it should return an explicit idle state with `stateAvailable: true`.
- If a request fails internally, it should return a structured error state instead of allowing the popup to infer one.

4. Add service worker request guards.
- Wrap each request handler branch so failures return structured error payloads.
- Do not rely only on top-level console logging.
- Preserve the last known chapter/session id if possible.

5. Make content extraction failures first-class state.
- If Wattpad extraction fails, save that as a session state with:
  - `state: "error"`
  - `lastEvent: "extraction_failed"`
  - a concrete `errorMessage`
- Do not hide extraction failure behind generic UI fallback text.

6. Introduce a strict playback lifecycle.
- The queue should have explicit phases such as:
  - `idle`
  - `preparing`
  - `buffering`
  - `playing`
  - `awaiting_chunk_end`
  - `advancing`
  - `paused`
  - `ended`
  - `error`
- Separate synthesis/buffering state from confirmed playback state.

7. Fix the replay race around chunk ending.
- Prevent `fillBuffer()` from replaying the current chunk during the gap between audio ending and session advancement.
- Possible acceptable fixes:
  - set an explicit `awaiting_chunk_end` or equivalent flag once playback has been handed to the offscreen document
  - ignore playback re-entry for the same `chunkId` while the queue is waiting for end confirmation
  - only allow replay of the same chunk after a confirmed playback error, not merely after a transient `GET_PLAYBACK_STATUS` false response

- The critical rule:
  - a completed synthesis of a future chunk must not cause chunk 0 or the current chunk to restart unless a real playback failure has occurred

8. Track the active playing chunk explicitly.
- Persist:
  - `currentChunkId`
  - `currentChunkIndex`
  - `playbackStatus`
  - `lastEvent`
- Update these only on well-defined transitions:
  - chunk scheduled for playback
  - playback confirmed started
  - playback ended
  - playback error

9. Improve offscreen playback reporting.
- The offscreen document should report more than `playing: true/false`.
- Include at least:
  - `playing`
  - `chunkId`
  - `ended`
  - `error`
- Ensure the service worker can distinguish:
  - actively playing
  - finished and waiting to advance
  - failed to play

10. Make chunk advancement deterministic.
- `currentChunkIndex` should increment exactly once per completed chunk playback.
- Advancement must happen only in response to the correct end event for the current chunk.
- Ignore stale `CHUNK_PLAYBACK_ENDED` events for older chunks.
- Ignore duplicate end events if they arrive more than once.

11. Prevent duplicate playback dispatch.
- The service worker must not send `PLAY_CHUNK_FROM_IDB` for the same `chunkId` repeatedly during normal healthy playback.
- Add a guard so replaying the same chunk requires an explicit retry condition.

12. Add a retry policy only for explicit playback failures.
- If retry is desired, it must be bounded and visible in state.
- Include:
  - retry count
  - last retry reason
- Do not silently retry on every ambiguous status read.

13. Improve popup diagnostics.
- Replace the current minimal lines with useful runtime signals.
- The popup should show:
  - state
  - current chunk index and total chunks
  - current chunk id
  - active part id
  - extraction strategy and confidence
  - buffered chunks
  - last event
  - last error

- If no state is available, show:
  - `State unavailable`
  - a direct error reason
  - no fabricated playback numbers

14. Add structured logs for debugging.
- Add concise logs at transition points:
  - extraction success/failure
  - session creation
  - chunk queued
  - chunk synthesis success/failure
  - playback dispatch
  - playback end
  - playback error
  - chunk index advancement
- Logs should be short and correlated by chapter id and chunk id.

15. Add tests for the replay race.
- Add a queue-level test or equivalent logic-level test proving:
  - when chunk 0 is playing and chunk 1 finishes synthesizing, chunk 0 is not replayed
  - chunk advancement occurs once after end event
  - duplicate end events do not double-advance

16. Add tests for popup/service-worker state behavior.
- Required tests:
  - `GET_STATE` returns a structured idle object when no session exists
  - extraction failure returns a structured error state
  - popup-safe request path can represent `state unavailable` without inventing fake metrics

17. Keep the implementation narrow.
- Do not introduce large architecture changes.
- Do not add a full event bus or external state library.
- Fix the queue transitions, state contract, and diagnostics with the smallest coherent set of changes.

18. Validate manually after tests.
- On a Wattpad reading page:
  - press `Play`
  - confirm chunk 0 starts
  - confirm chunk index advances after playback ends
  - confirm the next chunk starts without replaying the previous one
  - confirm popup fields update with real values

Definition of done

- The current chunk does not restart during normal buffering.
- The popup no longer shows fake `0 / 0` placeholder metrics when state is unavailable.
- The popup reflects real runtime state from the service worker.
- Playback either advances through chunks or surfaces a concrete error state.
- Tests cover the key replay and state-return regressions.

Reviewer subagent checklist

Mark each item `PASS` or `FAIL`. Any `FAIL` in sections 1-6 blocks approval.

1. State contract
- `PASS` if the service worker exposes a consistent structured state object for idle, active, and error cases.
- `PASS` if popup rendering relies on explicit state fields rather than invented defaults.
- `FAIL` if `GET_STATE` can still yield `undefined` or ambiguous empty values during normal operation.

2. UI trustworthiness
- `PASS` if the popup distinguishes:
  - real idle state
  - real error state
  - state unavailable
- `PASS` if the popup does not fabricate playback counts when state is unavailable.
- `FAIL` if placeholder `0 / 0` style metrics still appear as if they were real playback data.

3. Replay-race fix
- `PASS` if buffering a later chunk cannot cause the currently playing chunk to be replayed during normal playback.
- `PASS` if the same chunk is not redispatched simply because `GET_PLAYBACK_STATUS` temporarily reports not playing.
- `FAIL` if the current chunk can still restart before `currentChunkIndex` advances.

4. Deterministic advancement
- `PASS` if `currentChunkIndex` advances exactly once per completed chunk.
- `PASS` if stale or duplicate end events do not cause double-advance.
- `FAIL` if advancement is still ambiguous or dependent on timing accidents.

5. Offscreen/service-worker coordination
- `PASS` if the service worker can tell whether playback is actively playing, ended, or errored.
- `PASS` if `currentChunkId` is tracked explicitly across playback transitions.
- `FAIL` if the worker still infers too much from a bare boolean status.

6. Error surfacing
- `PASS` if extraction failures, playback failures, and service-worker request failures are all visible as structured error state.
- `FAIL` if the user still sees only a generic fallback issue message with no actionable runtime context.

7. Tests
- `PASS` if there is automated coverage for:
  - no-session `GET_STATE`
  - structured extraction failure state
  - replay-race prevention
  - deterministic single advancement
- `FAIL` if the replay fix depends only on manual testing.

8. Scope control
- `PASS` if the implementation remains focused on Wattpad playback and observability.
- `FAIL` if the change expands into unrelated feature work or architectural churn.

Approval gate

Approve only if all of the following are true:
- popup state is trustworthy
- service worker state is structured and always returned
- same-chunk replay during normal buffering is fixed
- chunk advancement is deterministic
- automated tests cover the regression

Plan verdict

PASS. This is a full scoped plan because it addresses the actual runtime failures in the current implementation: replay race conditions, missing state observability, and untrustworthy popup metrics. It stays narrow, gives a clear implementation order, and ends with a strict reviewer checklist tied to concrete runtime behavior.
