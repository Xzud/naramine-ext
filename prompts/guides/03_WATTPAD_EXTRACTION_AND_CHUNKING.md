# 03. Wattpad Extraction and Chunking

This guide explains how Wattpad pages become clean text chunks that can be sent
to TTS.

Relevant files:

```txt
features/readaloud-extension/extension/src/content/content.js
features/readaloud-extension/extension/src/content/wattpadExtractor.js
features/readaloud-extension/extension/src/content/chunkFocus.js
features/readaloud-extension/extension/src/text/chunkText.js
features/readaloud-extension/extension/tests/wattpadExtractor.test.js
features/readaloud-extension/extension/tests/chunkText.test.js
features/readaloud-extension/extension/tests/contentClick.test.js
features/readaloud-extension/extension/tests/chunkFocus.test.js
```

## The Goal

Wattpad pages contain more than story text. They include:

- Buttons.
- Comments.
- Voting controls.
- Ads or wrappers.
- Navigation.
- Metadata.
- Embedded JSON payloads.

The extension needs only the readable story text plus enough metadata to resume,
highlight, prefetch, and organize downloads.

The extraction pipeline produces:

- Clean chapter text.
- Story ID.
- Chapter/part ID.
- Title.
- Source URL.
- Paragraph IDs.
- Next chapter URL.
- First chapter URL.
- Extraction confidence/status.

## Page Types

The content script recognizes three page kinds:

```js
{ kind: "chapter", ... }
{ kind: "story", ... }
{ kind: "none", ok: false }
```

### Chapter Page

Detected by `isWattpadReadingDocument(...)`.

Signals:

- URL host includes `wattpad.com`.
- Body class includes `route-storyReading`.
- Or page contains `main#parts-container-new`.
- Or page contains `article.story-part[data-part-id]`.

Meaning:

- This page contains readable chapter text.
- It can be extracted and played.

### Story Overview Page

Detected by `isWattpadStoryOverviewDocument(...)`.

Signals:

- URL host includes `wattpad.com`.
- Path matches `/story/<id>`.
- It is not a reading page.

Meaning:

- This page is a story landing page.
- It has story metadata and usually a first-part link.
- It does not directly contain the chapter text to play.

### Unsupported Page

Returned as:

```js
{ kind: "none", ok: false }
```

Meaning:

- The popup should show the guide instead of the player unless playback is
  already active.

## Chapter Extraction Strategy

Main runtime function:

```txt
extractWattpadTextFromDocument(documentRef)
```

Location:

```txt
features/readaloud-extension/extension/src/content/content.js
```

Extraction order:

1. Confirm it is a Wattpad reading document.
2. Find the article element:
   - `main#parts-container-new article.story-part[data-part-id]`
   - fallback: `article.story-part[data-part-id]`
3. Read paragraph nodes:
   - `p[data-p-id]`
4. Clone each paragraph.
5. Remove noisy elements from the clone:
   - `.component-wrapper`
   - `.comment-marker`
   - `button`
   - `svg`
6. Normalize whitespace.
7. Keep the original Wattpad paragraph ID from `data-p-id`.
8. Build a success result.
9. Attach next-part and first-part metadata.

Technical terms:

- **Selector**: A CSS-like string used to find DOM elements.
- **Clone**: A copy of an HTML element. The code clones paragraphs so it can
  remove noise without changing the real Wattpad page.
- **Whitespace normalization**: Turning weird spaces/newlines into clean single
  spaces and trimming edges.

## Fallback Extraction From Embedded HTML

File:

```txt
features/readaloud-extension/extension/src/content/wattpadExtractor.js
```

If direct DOM paragraphs are missing or invalid, the extractor can use embedded
story text from the page HTML.

Why this exists:

- Wattpad may render text in different ways.
- Sometimes the DOM is incomplete but the page source contains serialized story
  data.

Important fallback:

```txt
"storyText":"..."
```

The code:

- Finds embedded story text.
- Decodes escaped JSON string content.
- Decodes HTML entities.
- Removes HTML tags and noisy wrappers.
- Extracts paragraph text.

Technical terms:

- **HTML entity**: Text like `&amp;` or `&quot;` that represents `&` or `"`.
- **Escaped JSON string**: Text where characters like quotes and slashes may be
  represented as `\"` or `\/`.

## Validation

Extraction can fail safely.

Validation checks:

- Minimum paragraph count.
- Minimum text length.
- Avoid common UI phrases.

Examples of UI phrases:

- `you are reading`
- `add to list`
- `vote`
- `share via facebook`
- `table of contents`

Why validation matters:

- Sending page chrome to TTS would create bad audio.
- It is better to return a controlled failure than narrate UI text.

Failure result includes:

- `ok: false`
- `error`
- `strategy`
- `confidence: "low"`
- metadata when available
- warnings

## Metadata Extraction

The extractor tries to collect metadata needed by other features.

### Story ID

Found from patterns like:

- `data-story-id`
- `/story/<id>`
- embedded `storyId`

Used for:

- Library grouping.
- Sync.
- Recents.
- Continue.

### Part ID

Found from patterns like:

- `data-part-id`
- embedded `partId`
- Wattpad chapter URL.

Used as:

- `chapterId`
- `partId`

In this codebase, a Wattpad part is effectively the same thing as a playable
chapter.

### Part URL

Used for:

- Resume.
- Continue.
- Opening pages for auto-advance.

### Title

Used for:

- Popup heading.
- Library rows.
- Recents.

### Next Part

Function:

```txt
findNextPartFromHtml(...)
```

Used for:

- Next-chapter prefetch.
- Auto-advance.
- Sync next chapter behavior.

Preferred source:

- Embedded `nextPart` object.

Fallback:

- Table-of-contents links.

### First Part

Function:

```txt
findFirstPartFromHtml(...)
```

Used for:

- Sync backfill when user enables Sync mid-story.

Preferred source:

- Embedded `firstPartId`.

Fallback:

- First part-shaped link in the page.

## Story Overview Extraction

Function:

```txt
extractWattpadStoryInfoFromDocument(documentRef)
```

Location:

```txt
features/readaloud-extension/extension/src/content/content.js
```

It returns:

- `ok`
- `storyId`
- `title`
- `author`
- `coverUrl`
- `avatarUrl`
- `sourceUrl`
- `firstPart`

Used by:

- `STORY_PAGE_READY`
- Library metadata.
- Sync from story overview pages.

## Page Ready Signals

Function:

```txt
notifyPageReady(documentRef)
```

Location:

```txt
features/readaloud-extension/extension/src/content/content.js
```

For chapter pages it sends:

```js
{
  scope: "readaloud",
  type: "PAGE_READY",
  payload: {
    ...extractedChapter,
    pageDetected: true,
    pageEligible: true,
    autoplayAllowed: false,
    pageVisible: true,
    detectedAt: Date.now()
  }
}
```

For story overview pages it sends:

```js
{
  scope: "readaloud",
  type: "STORY_PAGE_READY",
  payload: storyInfo
}
```

## Avoiding Duplicate Page Ready Events

Wattpad can update content without a full page reload. The content script uses
a page signature to avoid sending duplicate `PAGE_READY` messages.

Signature uses:

- `article.story-part[data-part-id]` when available.
- Otherwise normalized URL/title.

If the signature did not change:

- It does not send another page-ready event.
- It still asks `chunkFocus` to restore highlight after mutation.

Technical term:

- **Signature**: A compact identity value used to decide whether something
  meaningful changed.

## Paragraph Click Playback

The content script makes readable paragraphs clickable.

When a paragraph is clicked:

1. Content script finds `data-p-id`.
2. It sends `PLAY_FROM_PARAGRAPH`.
3. Payload includes the paragraph ID and page extraction context.
4. Background routes to `queue.playFromParagraph(...)`.
5. Queue maps paragraph ID to a chunk.
6. Playback starts from that chunk.

This feature depends on paragraph IDs being preserved during extraction and
chunking.

## Chunking

File:

```txt
features/readaloud-extension/extension/src/text/chunkText.js
```

Main function:

```js
chunkText(text, options = {})
```

Inputs:

- full chapter `text`
- optional `storyId`
- optional `chapterId`
- optional `paragraphs`

Outputs:

- array of chunk records

Each chunk has:

```js
{
  storyId,
  chapterId,
  chunkIndex,
  text,
  textHash,
  chunkId,
  paragraphIds,
  paragraphId
}
```

## Chunk Size Rules

Constants:

```js
MAX_CHARS = 600
MAX_CHUNK_CHARS = 1000
```

Behavior:

- If a paragraph is under `MAX_CHARS`, keep it together.
- If a paragraph is too long, split by sentence.
- If a sentence is too long, split by raw character length.
- Store final chunk text with a hard cap of `MAX_CHUNK_CHARS`.

Why chunking matters:

- TTS requests should be small enough to process quickly.
- Playback can start before the full chapter is generated.
- Cached audio can be reused per chunk.
- Resume can target a chunk index.

## Stable Hashes and Chunk IDs

Function:

```js
stableHash(input)
```

It creates repeatable IDs for identical inputs.

Chunk ID shape:

```txt
chapterId:chunkIndex:textHash
```

Why stable IDs matter:

- If the same chapter text is loaded again, the same chunk gets the same ID.
- IndexedDB can reuse cached audio.
- If text changes, the hash changes and old audio should not be reused for the
  wrong text.

Technical term:

- **Hash**: A short value derived from input. Here it is not for security; it is
  for stable identity.

## Paragraph Anchors

Each Wattpad paragraph has a `data-p-id`.

Chunk records preserve:

- `paragraphIds`
- `paragraphId`

These anchors connect:

```txt
TTS chunk -> playback state -> content script highlight -> real Wattpad paragraph
```

Without anchors, the extension could still play audio, but it could not reliably
highlight the current paragraph.

## Active Chunk Highlighting

File:

```txt
features/readaloud-extension/extension/src/content/chunkFocus.js
```

Main helper:

```js
createChunkFocusController(...)
```

It provides:

- `focusChunk(...)`
- `clear(...)`
- `syncAfterMutation(...)`
- `getActiveChunkState()`

How highlighting works:

1. Background sends `READALOUD_SET_ACTIVE_CHUNK`.
2. Content script passes the payload to `chunkFocus.focusChunk(...)`.
3. `chunkFocus` finds paragraphs by `p[data-p-id]`.
4. It adds a CSS class.
5. It scrolls the first paragraph into view when requested.

Why `syncAfterMutation(...)` exists:

- Wattpad can re-render the page.
- Re-rendering can remove the highlight class.
- The controller remembers active chunk state and reapplies highlight after DOM
  changes.

## Tests To Read

Read these tests alongside the source:

- `wattpadExtractor.test.js`
  - Shows success/failure extraction cases.
  - Shows next-part fallback rules.

- `chunkText.test.js`
  - Shows paragraph and sentence splitting.
  - Shows stable chunk IDs.
  - Shows paragraph anchor preservation.

- `contentClick.test.js`
  - Shows how clicking a paragraph sends a play-from-paragraph request.

- `chunkFocus.test.js`
  - Shows highlight, scroll, restore, and clear behavior.

