Wattpad lazy-load highlighting plan

Goal

Add a paragraph-level read-aloud mode for Wattpad that works with lazy-loaded chapter content and guides the reader visually while Kokoro is reading.

The system should:

- read only the currently loaded Wattpad paragraphs first
- highlight the paragraph currently being read
- optionally keep the active paragraph in view
- stop cleanly at the end of currently loaded text
- tell the user to scroll to load more
- resume from the next unseen loaded paragraph after more content appears

Do not attempt sentence-level karaoke highlighting. Do not attempt full generic site support. Keep scope limited to Wattpad reading pages.

Why this approach

Wattpad lazy-loads additional text as the reader scrolls. That makes “extract the whole chapter once” unreliable unless the extension also forces full-page scrolling and waits for new content. A paragraph-level model fits Wattpad better because:

- the DOM already exposes stable paragraph markers via `p[data-p-id]`
- highlighting can track real reading progress in the page
- the extension can work with only the currently loaded text
- the system can pause at the lazy-load boundary instead of pretending the chapter is complete

Target behavior

- On a Wattpad reading page, pressing `Play` should:
  - extract currently loaded story paragraphs only
  - build an ordered playback queue from those paragraphs
  - synthesize and play paragraph audio one paragraph at a time, or in small grouped units that preserve paragraph mapping
  - highlight the active paragraph while it is playing

- When the player reaches the last loaded paragraph:
  - it must not loop
  - it must not falsely report the chapter is fully complete unless the loaded DOM truly contains the full part
  - it should enter a clear waiting state such as `waiting_for_more_content`
  - the popup should tell the user to scroll Wattpad to load more

- After the user scrolls and Wattpad loads more paragraphs:
  - the extension should detect newly loaded unseen paragraph ids
  - append them to the playback plan
  - resume playback from the next unread paragraph

Scope constraints

- Wattpad only
- paragraph-level highlighting only
- no sentence timing
- no generic multi-site reader engine
- no large architecture rewrite

Implementation steps

1. Change the extraction model from “single full text blob” to “ordered paragraph records”.
- Instead of returning only one `text` string, return an ordered list of paragraph records.
- Each record should include at least:
  - `paragraphId`
  - `text`
  - `partId`
  - `storyId`
  - `sequenceIndex`
- The extractor may still also return concatenated text if useful, but paragraph records become the source of truth.

2. Use Wattpad paragraph ids as the primary alignment key.
- `p[data-p-id]` is the best anchor for playback-to-DOM synchronization.
- Preserve those ids in extraction results, queue planning, and runtime state.

3. Extract only currently loaded paragraphs.
- Do not try to fake completeness.
- If Wattpad has only loaded part of the current page, extract only those paragraphs that are currently in the DOM.
- Mark the extraction result with whether the end of loaded content appears to be a lazy-load boundary or a true end of part.

4. Define a paragraph playback unit.
- The simplest working setup is one audio request per paragraph.
- If that is too slow or expensive, allow grouping of a small number of adjacent paragraphs but preserve paragraph mapping inside each unit.
- For the first implementation, prefer one paragraph per playback unit because it makes highlighting and advancement much simpler.

5. Add a paragraph playback plan store.
- Persist an ordered plan for the current Wattpad part:
  - `paragraphId`
  - `text`
  - `status`
  - `audioReady`
  - `played`
  - `sequenceIndex`
- Suggested statuses:
  - `pending`
  - `generating`
  - `ready`
  - `playing`
  - `played`
  - `failed`

6. Track the active paragraph explicitly in runtime state.
- The service worker state should include:
  - `currentParagraphId`
  - `currentParagraphIndex`
  - `loadedParagraphCount`
  - `playedParagraphCount`
  - `waitingForMoreContent`
  - `lastVisibleParagraphId`
- This is more meaningful than chunk-only state for Wattpad.

7. Add content-script highlight controls.
- Implement a content-script message contract such as:
  - `READALOUD_HIGHLIGHT_PARAGRAPH`
  - `READALOUD_CLEAR_HIGHLIGHT`
  - `READALOUD_SCROLL_TO_PARAGRAPH`
- The content script should:
  - locate the paragraph by `data-p-id`
  - add a highlight class
  - remove highlight from the previous paragraph

8. Keep highlighting visually simple and robust.
- Add one highlight style only.
- It should be visible but not destructive to Wattpad layout.
- Avoid heavy DOM wrapping or text splitting.
- Use a class toggle on the paragraph element.

9. Decide whether to auto-scroll in the first version.
- Recommended:
  - support optional `scrollIntoView` for the active paragraph
  - keep it conservative, such as `block: "center"` or nearest visible behavior
- Do not aggressively fight the user’s scroll position in the first release.

10. Update playback dispatch so highlight changes happen on playback start.
- When a paragraph begins playback:
  - update service worker state
  - send highlight message to content script
  - optionally send scroll message
- When playback ends:
  - mark paragraph as played
  - advance to next paragraph

11. Fix playback advancement semantics around paragraphs.
- Advancement must happen once per paragraph.
- Do not replay the same paragraph during normal buffering.
- Ignore stale or duplicate playback-ended events.
- The active paragraph id must move forward monotonically unless the user explicitly restarts.

12. Detect lazy-load boundary explicitly.
- When the current paragraph reaches the last currently loaded paragraph:
  - check whether more unseen paragraphs are now present in the DOM
  - if yes, append them and continue
  - if not, transition to `waiting_for_more_content`

13. Add a content refresh mechanism.
- The service worker should be able to ask the content script for currently loaded paragraph records again.
- It should compare paragraph ids against already-known ids.
- Only append genuinely new paragraph ids.

14. Add a resume-from-scroll flow.
- When in `waiting_for_more_content`:
  - the popup should clearly tell the user to scroll the Wattpad page
  - a `Refresh` or automatic recheck should detect newly loaded paragraphs
  - playback should resume from the next unread paragraph, not restart from paragraph 0

15. Distinguish full completion from partial loaded completion.
- Do not mark the part `ended` merely because all currently loaded paragraphs were played.
- Use:
  - `waiting_for_more_content` when loaded text has been exhausted but more may exist
  - `ended` only when the current Wattpad part truly appears complete

16. Define a practical full-part completion heuristic.
- Because Wattpad is lazy-loaded, “end of part” must be inferred conservatively.
- Acceptable first-version heuristics:
  - visible presence of a next-part or end-of-part element
  - no new paragraphs after refresh and a visible end-of-part footer
- If uncertain, prefer `waiting_for_more_content` over falsely claiming completion.

17. Improve popup diagnostics around paragraph reading.
- The popup should show:
  - state
  - current paragraph index
  - loaded paragraph count
  - current paragraph id
  - played paragraph count
  - waiting-for-more-content status
  - extraction strategy
  - last error
- Do not show meaningless chunk metrics if paragraph mode is the actual runtime model.

18. Keep chunking logic subordinate to paragraph identity.
- If paragraph text is still chunked internally for TTS size reasons, maintain a strict mapping:
  - paragraph id -> one or more audio subunits
- The highlight should remain tied to paragraph identity, not arbitrary chunk identity.
- For the simplest first version, avoid multi-paragraph chunks.

19. Add content-script re-scan support without full page reload.
- The extension should be able to refresh currently loaded Wattpad paragraphs from the content script at runtime.
- This should not require reloading the extension or the page.

20. Add tests for paragraph extraction and highlighting messages.
- Required automated coverage:
  - extractor returns ordered paragraph records with `paragraphId`
  - extracted records exclude non-story UI
  - playback state can represent `waiting_for_more_content`
  - highlight message targets the correct paragraph id
  - newly loaded unseen paragraph ids append correctly

21. Add tests for advancement and lazy-load resume.
- Required automated coverage:
  - playback advances paragraph-by-paragraph without replaying the same paragraph
  - duplicate end events do not double-advance
  - loaded-text exhaustion enters `waiting_for_more_content`
  - refresh with new paragraph ids resumes from the correct next unread paragraph

22. Validate manually on Wattpad.
- Manual acceptance run:
  - open a Wattpad reading page
  - press `Play`
  - confirm current paragraph is highlighted
  - confirm highlight moves forward as playback advances
  - confirm playback pauses at end of loaded text with a “scroll to load more” style state
  - scroll to trigger more Wattpad content loading
  - confirm refresh or auto-recheck discovers new paragraphs
  - confirm playback resumes from the first unread newly loaded paragraph

23. Keep the first release intentionally narrow.
- First release should include:
  - currently loaded paragraph extraction
  - paragraph-level playback state
  - active paragraph highlighting
  - waiting-for-more-content state
  - refresh/resume after more paragraphs load
- Do not add:
  - sentence syncing
  - full auto-scroll orchestration across the entire chapter
  - multi-site support
  - aggressive DOM mutation handling beyond what is needed for refresh and resume

Definition of done

- The extension reads currently loaded Wattpad story paragraphs only.
- The active paragraph is visibly highlighted during playback.
- Playback advances forward paragraph-by-paragraph.
- When loaded text runs out, the player enters a clear waiting state instead of looping or falsely ending.
- After more text is loaded by user scrolling, the extension can resume from the next unread paragraph.
- Popup metrics reflect paragraph-reading reality instead of irrelevant placeholders.

Reviewer subagent checklist

Mark each item `PASS` or `FAIL`. Any `FAIL` in sections 1-7 blocks approval.

1. Wattpad-only scope
- `PASS` if the implementation is explicitly limited to Wattpad reading pages.
- `PASS` if the feature is paragraph-level and does not drift into sentence-level karaoke behavior.
- `FAIL` if the implementation expands into generic site support or unrelated architecture work.

2. Extraction model
- `PASS` if extraction returns ordered paragraph records with stable `paragraphId` values from Wattpad.
- `PASS` if non-story UI is excluded from those records.
- `FAIL` if the system still relies only on one large anonymous text blob for playback identity.

3. Highlighting behavior
- `PASS` if the currently playing paragraph is visibly highlighted in the page.
- `PASS` if the previous paragraph highlight is cleared when playback advances.
- `FAIL` if highlighting is missing, unstable, or not tied to the actual active paragraph id.

4. Advancement semantics
- `PASS` if playback advances paragraph-by-paragraph without replaying the same paragraph during normal operation.
- `PASS` if duplicate or stale playback-end events do not double-advance.
- `FAIL` if the same paragraph can still loop under normal buffering conditions.

5. Lazy-load boundary handling
- `PASS` if exhausting currently loaded paragraphs produces a clear `waiting_for_more_content` style state.
- `PASS` if the implementation does not falsely mark the part fully ended when more Wattpad text may still load.
- `FAIL` if the reader loops, stalls ambiguously, or falsely claims completion at the lazy-load boundary.

6. Resume-after-scroll behavior
- `PASS` if newly loaded unseen paragraphs are detected and appended after the user scrolls.
- `PASS` if playback resumes from the next unread paragraph rather than restarting from the beginning.
- `FAIL` if new content loading requires a full reset or loses progress.

7. Popup trustworthiness
- `PASS` if popup metrics reflect paragraph-level runtime state:
  - current paragraph
  - loaded count
  - waiting-for-more-content
  - last error
- `FAIL` if the popup still shows misleading placeholder values or chunk-only metrics that no longer explain real behavior.

8. Tests
- `PASS` if automated tests cover paragraph extraction, advancement, lazy-load waiting state, and resume-after-scroll behavior.
- `FAIL` if the implementation depends mostly on manual testing.

9. Scope control
- `PASS` if the implementation remains narrow and pragmatic for a first Wattpad lazy-load compatible release.
- `FAIL` if it introduces unnecessary complexity such as sentence-level synchronization or generic DOM instrumentation.

Approval gate

Approve only if all of the following are true:
- paragraph highlighting works on Wattpad
- playback advances by paragraph without looping
- lazy-load exhaustion enters a clear waiting state
- scroll-loaded new paragraphs can be appended and resumed
- popup state is trustworthy
- automated tests cover the core regression paths

Plan verdict

PASS. This is a solid scoped plan because it aligns the product with Wattpad’s actual lazy-loading behavior instead of pretending the full chapter is always available. It keeps the implementation practical by using paragraph ids as the synchronization unit, adds a clear user-guidance highlight, and defines strict reviewer criteria tied to real runtime behavior.
