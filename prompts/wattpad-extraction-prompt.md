Wattpad-only chapter extraction plan

Goal

Support Wattpad reading pages only, with a simple extractor that starts at the actual chapter text, skips non-story UI, and fails safely if Wattpad changes.

Do not generalize to other sites yet. Do not keep a generic "read whole page" path in scope for this task.

Target behavior

- When the user is on a Wattpad reading page and presses `Play`, the extension should read only the current chapter or part body.
- It should not read the page header, story metadata, TOC, comments UI, share buttons, vote buttons, or signup prompts.
- If extraction is unreliable, it should stop with a clear extraction failure instead of reading junk or falling back to sample text.

Known Wattpad structure from `prompts/sample.html`

- Reading page marker: `body.route-storyReading`
- Main reading container: `main#parts-container-new`
- Current part container: `article.story-part[data-part-id][data-part-url]`
- Paragraph nodes: `p[data-p-id]`
- Embedded serialized fallback text: `storyText`
- Useful IDs:
  - `storyId`
  - `partId`
  - `partUrl`

Implementation steps

1. Create a Wattpad-only extractor module.
- Add a dedicated module under the content layer, for example `src/content/wattpadExtractor.js`.
- Keep it pure and self-contained.
- Input: live page `document`.
- Output: structured extraction result.

2. Define a strict extraction result shape.
- Return:
  - `ok`
  - `text`
  - `title`
  - `sourceUrl`
  - `strategy`
  - `storyId`
  - `partId`
  - `partUrl`
  - `paragraphCount`
  - `confidence`
  - `error`
  - `warnings`

3. Add a Wattpad page guard.
- Only proceed if the page is clearly a Wattpad reading page.
- Require:
  - hostname contains `wattpad.com`
  - and one of:
    - `body.route-storyReading`
    - `main#parts-container-new`
    - `article.story-part[data-part-id]`
- If this check fails, return a structured `not_wattpad_reading_page` result.
- Do not extract from non-Wattpad pages for this task.

4. Implement the primary DOM strategy.
- Locate the current chapter or article:
  - `main#parts-container-new article.story-part[data-part-id]`
  - fallback: `article.story-part[data-part-id]`
- Inside that article, collect only `p[data-p-id]`.
- For each paragraph:
  - clone the node
  - remove nested noise nodes:
    - `.component-wrapper`
    - `.comment-marker`
    - `button`
    - `svg`
  - use cleaned `textContent`
  - normalize whitespace
  - trim
  - discard empty results
- Join kept paragraphs with `\n\n`.

5. Extract chapter metadata from the DOM strategy.
- `partId` from `article.dataset.partId`
- `partUrl` from `article.dataset.partUrl`
- `title` from `document.title`
- `sourceUrl` from `location.href`
- `storyId` from nearby page data if easy to obtain, otherwise defer to fallback parsing or URL parsing

6. Add strict acceptance rules for the DOM strategy.
- Accept only if all are true:
  - `paragraphCount >= 3`
  - total text length is meaningfully chapter-like, for example `>= 300`
  - text does not prominently contain obvious UI phrases
- Reject if output looks contaminated by page chrome.

7. Implement the embedded `storyText` fallback.
- If DOM strategy fails, parse Wattpad's embedded page data and extract `storyText`.
- `sample.html` shows `storyText` containing paragraph HTML.
- Steps:
  - locate the serialized page data block
  - extract the `storyText` string
  - decode HTML entities
  - parse it into a detached DOM container
  - collect paragraph text from the parsed content
  - normalize and join as above
- Use the same acceptance rules.
- Mark strategy `embedded-storyText`.

8. Extract metadata from embedded page data if available.
- Pull:
  - `storyId`
  - `partId`
  - `partUrl`
  - chapter or page title
- Prefer embedded IDs over URL inference when present.

9. Add a final safe failure path.
- If neither DOM nor embedded extraction passes validation:
  - return `ok: false`
  - `confidence: low`
  - `error: could_not_isolate_wattpad_chapter_text`
- Do not fall back to `document.body.innerText`.
- Do not fall back to hardcoded sample text.

10. Update the content script to use the Wattpad extractor only.
- Replace the current `READALOUD_EXTRACT_TEXT` behavior.
- It should now:
  - verify Wattpad reading page
  - run DOM strategy
  - fallback to embedded strategy
  - return the structured result

11. Update the play flow to require successful Wattpad extraction.
- On `PLAY`, request extraction from the active tab.
- If `ok: true`, use the extracted chapter text as the session text.
- Use `partId` as the chapter or session ID when available.
- If `ok: false`, set an extraction error state and do not start playback.

12. Remove automatic use of hardcoded chapter text for Wattpad pages.
- Hardcoded text may stay for isolated development testing only if explicitly invoked.
- It must not silently replace failed Wattpad extraction.

13. Keep session identity stable.
- For Wattpad:
  - `chapterId = partId`
  - `storyId = extracted storyId if available`
- If `storyId` is missing, use a stable URL-derived fallback.
- This keeps chunk caching tied to the actual current part.

14. Add minimal diagnostics to help debugging.
- Make the extraction result visible in the popup state or logs:
  - strategy used
  - paragraph count
  - part ID
  - confidence
  - extraction error
- This should be enough to tell whether breakage is selector-related or page-state-related.

15. Add focused tests using Wattpad fixtures only.
- Use `prompts/sample.html` as the primary fixture.
- Required tests:
  - DOM strategy extracts only story paragraphs
  - extraction starts at the first story paragraph, not `YOU ARE READING`
  - comment-marker UI is excluded
  - embedded `storyText` fallback works when `p[data-p-id]` nodes are removed from the fixture copy
  - failure result is returned when both extraction strategies are unavailable

16. Keep the first version intentionally small.
- First release should include only:
  - Wattpad page detection
  - DOM paragraph extraction
  - embedded `storyText` fallback
  - strict validation
  - safe failure
- Do not add mutation observers, auto-retry loops, or multi-site extraction yet.

Reviewer subagent checklist

Mark each item `PASS` or `FAIL`. Any `FAIL` in sections 1-5 blocks approval.

1. Wattpad-only scope
- `PASS` if the implementation is explicitly limited to Wattpad reading pages.
- `PASS` if non-Wattpad extraction is not part of this change.
- `FAIL` if the implementation drifts into a generic scraper or keeps `document.body.innerText` as a normal fallback.

2. Page detection
- `PASS` if extraction runs only when the page is clearly a Wattpad reading page.
- `PASS` if non-reading Wattpad pages fail cleanly.
- `FAIL` if the extractor tries to read arbitrary Wattpad pages without reading-page checks.

3. Primary DOM extraction
- `PASS` if the primary strategy targets `article.story-part[data-part-id]`.
- `PASS` if it reads only `p[data-p-id]` descendants for the chapter body.
- `PASS` if nested comment UI and component wrappers are removed before text extraction.
- `FAIL` if the extracted text includes obvious page chrome or chapter-adjacent UI.

4. Start-of-chapter correctness
- `PASS` if extracted text starts with the first actual story paragraph from the current part.
- `FAIL` if it starts with labels like `YOU ARE READING`, story description, title block, table of contents, or other pre-body UI.

5. Fallback behavior
- `PASS` if `storyText` fallback exists and works when DOM paragraph nodes are unavailable.
- `PASS` if both strategies use the same validation rules.
- `PASS` if total failure returns a structured error and does not start playback.
- `FAIL` if the extension falls back to sample text or full body text.

6. Playback integration
- `PASS` if pressing `Play` on a Wattpad reading page uses extracted chapter text.
- `PASS` if session or chapter identity is based on `partId` when available.
- `FAIL` if playback still defaults to hardcoded text on Wattpad pages.

7. Validation quality
- `PASS` if there are minimum thresholds for paragraph count and chapter text length.
- `PASS` if clearly irrelevant UI phrases are excluded or used as rejection signals.
- `FAIL` if any non-empty text is accepted as valid chapter content.

8. Tests
- `PASS` if `prompts/sample.html` is used as a fixture.
- `PASS` if there is a passing test for the primary DOM path.
- `PASS` if there is a passing test for the embedded fallback path.
- `PASS` if there is a failure-path test when both extraction strategies are unavailable.
- `FAIL` if reviewer must rely on manual inspection only.

9. Simplicity
- `PASS` if the implementation consists of:
  - Wattpad page check
  - DOM extraction
  - embedded fallback
  - strict validation
  - playback integration
- `FAIL` if the implementation introduces unnecessary complexity before the basic flow works.

Approval gate

Approve only if all of the following are true:
- Wattpad reading pages extract only current chapter body text
- extraction starts at the first real paragraph
- `storyText` fallback is present
- failed extraction does not play junk or sample text
- tests prove both the primary and fallback paths

Plan verdict

PASS. This is a solid implementation guide with a simple working setup because it focuses only on Wattpad, uses the two strongest sources already visible in `sample.html`, keeps the change isolated, and gives the reviewer a strict checklist that will reject brittle or fake implementations.
