Wattpad next-chapter auto-advance plan

Objective

Use the DOM extracted in `prompts/sample.html` to detect the next chapter for the current Wattpad reading page, then open that chapter in a new tab and continue the read-aloud stream with minimal interruption.

Context

The sample DOM already contains a table of contents for the story.
The active chapter is Chapter 1, and the next visible chapter entry is Chapter 2.
The relevant DOM evidence is the `on-navigate` link in the chapter list, which points to the next chapter URL.

Desired behavior

When playback reaches the end of the current chapter:

1. Identify the next chapter from the currently extracted Wattpad DOM.
2. Resolve its canonical chapter URL.
3. Open that URL in a new browser tab, or reuse the current tab if the product decision is to navigate in place.
4. Preserve enough playback context to resume streaming on the next chapter.
5. Continue playback automatically once the next chapter page is ready and extractable.

Important constraint

Do not guess the next chapter from text content alone if the DOM already provides a reliable chapter list.
Prefer explicit DOM links from the Wattpad table of contents or adjacent chapter navigation.

Detailed step by step plan

1. Confirm the current chapter identity.
   - Read the current `partId`, `partUrl`, and `storyId` from the extracted Wattpad page.
   - Verify that the active page is a Wattpad reading page and that the table of contents or chapter navigation is present.

2. Extract chapter navigation links from the DOM.
   - Parse the chapter list container in `prompts/sample.html`.
   - Find the currently active chapter entry.
   - Resolve the next sibling chapter link after the active chapter.
   - Prefer the first canonical `href` that belongs to the same story.

3. Normalize the next chapter URL.
   - Convert relative Wattpad links to absolute URLs.
   - Preserve only the canonical chapter URL needed to load the next page.
   - Drop transient tracking query parameters unless the app intentionally needs them.

4. Validate the next chapter candidate.
   - Ensure the URL belongs to the same story.
   - Ensure the URL is not the same as the current chapter.
   - Ensure the link points to a reading page, not an author page, story page, or share target.

5. Define the chapter transition trigger.
   - Trigger only after the current chunk stream completes or the queue reports chapter completion.
   - Avoid triggering on partial buffering, temporary stalls, or repeated end events.
   - Keep the transition idempotent so duplicate signals do not open multiple tabs.

6. Decide the tab behavior.
   - If the intended UX is "continue in a new tab", use the extension background context to open the next chapter URL.
   - If the intended UX is "continue in place", reuse the current tab and replace its location.
   - Keep the decision centralized in one orchestration path so it can be changed later without rewriting the extractor.

7. Persist stream state before navigation.
   - Save the current chapter/session state.
   - Record the current `chapterId`, `partUrl`, and playback position.
   - Mark the transition as pending so the queue can avoid duplicate handoff work.

8. Open the next chapter.
   - Request the browser to open the new chapter URL.
   - Optionally focus the new tab if this is meant to be an immediate continuation experience.
   - Avoid opening the chapter multiple times during retries or delayed state updates.

9. Warm up the next page.
   - Once the next chapter tab is loaded, let the content script extract the new DOM.
   - Let the service worker warm up the new session as soon as the page is eligible.
   - Reuse the same playback provider and chunking pipeline for the new chapter.

10. Resume streaming.
    - Start extraction and chunk generation for the new chapter.
    - Continue from the first chunk of the new chapter unless the product explicitly supports paragraph-level resume.
    - Confirm the queue resets chapter-scoped state cleanly before playback starts.

11. Handle failure cases explicitly.
    - If no next chapter exists, end playback cleanly and surface that the story is complete.
    - If the next chapter link is missing, fall back to a graceful end-of-story state.
    - If opening the tab fails, preserve the current session state and surface a recoverable error.
    - If the next chapter page cannot be extracted, stop auto-advance and surface the failure reason.

12. Add observability.
    - Log when the next chapter is discovered.
    - Log the resolved URL and the transition decision.
    - Log whether navigation happened in a new tab or the current tab.
    - Log whether the next chapter extraction and warmup succeeded.

Implementation plan

1. Add a next-chapter resolver in the Wattpad extraction layer.
   - Teach the extractor to return the next chapter URL when the DOM contains a story chapter list.
   - Prefer the immediate next chapter sibling of the active entry.
   - Return `null` when there is no next chapter.

2. Extend the playback/session state model.
   - Add a field for next chapter handoff state.
   - Add a boolean or enum for `handoffPending`, `handoffStarted`, and `handoffFailed`.
   - Keep the transition state separate from chunk playback state.

3. Add an orchestration method for chapter handoff.
   - Place the handoff logic in the service worker or playback queue, not in the content script.
   - Ensure the handoff method is only invoked once per completed chapter.

4. Add browser tab control.
   - Use `chrome.tabs.create` for the new-tab flow.
   - Optionally use `chrome.tabs.update` if the product chooses in-place navigation.
   - Keep the implementation compatible with MV3 service worker execution.

5. Rehydrate the next session on page ready.
   - When the new chapter tab reports `PAGE_READY`, extract the new chapter text.
   - Warm up the queue with the new `partId` and `partUrl`.
   - Start playback only after the new chapter is confirmed eligible.

6. Guard against duplicate handoffs.
   - Make the transition idempotent by storing the last handoff target.
   - Ignore repeated end events for the same chapter.
   - Ignore repeated tab-open requests for the same next chapter URL.

7. Add tests.
   - Add a DOM extraction test for chapter 1 resolving chapter 2.
   - Add a queue or service worker test for single-fire handoff behavior.
   - Add a failure-path test for missing next chapter links.
   - Add a browser-control test or mocked integration test for tab creation.

File coverage

These files are likely in scope:

1. `prompts/sample.html`
   - Source of the DOM pattern used to locate the next chapter link.

2. `features/readaloud-extension/extension/src/content/wattpadExtractor.js`
   - Best place to extract chapter navigation metadata from Wattpad DOM.

3. `features/readaloud-extension/extension/src/content/content.js`
   - Content script may need to pass next chapter metadata to the service worker.

4. `features/readaloud-extension/extension/src/background/service_worker.js`
   - Orchestrates chapter handoff and browser tab opening.

5. `features/readaloud-extension/extension/src/audio/playbackQueue.js`
   - Owns end-of-chapter detection and playback state transitions.

6. `features/readaloud-extension/extension/src/audio/runtimeState.js`
   - Needs any new handoff state fields.

7. `features/readaloud-extension/extension/src/db/idb.js`
   - Stores per-chapter/session metadata if handoff state is persisted.

8. `features/readaloud-extension/extension/tests/*`
   - Add or extend tests for next chapter detection and transition logic.

9. `features/readaloud-extension/extension/manifest.json`
   - Verify permissions are sufficient for tab creation and navigation behavior.

Acceptance checklist

- The current Wattpad DOM can resolve the next chapter from the table of contents.
- The resolved next chapter URL matches the visible next chapter in `prompts/sample.html`.
- The extension opens the next chapter in a new tab, or navigates in place if that is the chosen behavior.
- The current playback session is not lost during the transition.
- The new chapter is extracted and warmed up successfully.
- Playback starts again on the new chapter without manual intervention.
- No duplicate tabs are opened for the same transition.
- If there is no next chapter, playback ends cleanly.
- If the next chapter page cannot be loaded or extracted, the user sees a concrete error state.
- Tests cover success and failure paths for chapter handoff.

Success criteria

- The extension can infer the next chapter from Wattpad DOM reliably.
- The user is taken to the next chapter automatically when chapter playback completes.
- The stream continues on the new chapter without manual resumption.
- The handoff is deterministic, idempotent, and observable.
- The implementation stays narrow and does not introduce unnecessary architecture changes.

Suggested reviewer checklist

1. PASS if the next chapter is resolved from the DOM, not guessed from text.
2. PASS if the transition happens once per chapter completion.
3. PASS if the new chapter loads in a tab and playback resumes automatically.
4. PASS if failure cases are explicit and recoverable.
5. FAIL if duplicate tab opens or repeated handoffs are possible.
6. FAIL if playback state and handoff state are mixed together without clear boundaries.
