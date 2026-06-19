# Naramine Vision Implementation Audit

Date: 2026-06-20

Scope audited: the current repository only. The repo currently contains one product surface under `features/readaloud-extension/` plus prompt/design notes under `prompts/`. There is no separate website, dashboard app, auth service, billing service, or policy/docs app in this repository.

Important codebase note: the live implementation is in the compiled `.js` files. Several `.ts` files are stubs or declarations only.

## Executive Summary

Current state: this repo implements a Wattpad-first Chrome extension MVP with a local/offscreen audio player, IndexedDB-backed chapter/audio cache, chapter sync/prefetch logic, a local library, and a thin TTS proxy backend.

It does not yet implement the full Naramine product vision.

What is clearly implemented now:

- A Chrome extension called `Naramine`.
- Wattpad chapter extraction and Wattpad story metadata extraction.
- Client-side scraping in the browser.
- A popup with play/pause, stop, sync toggle, sleep timer, guide view, and local library view.
- Offscreen streaming playback that starts before a full chapter download completes.
- IndexedDB storage for chapter metadata, chunk metadata, audio chunks, and story metadata.
- Chapter warmup/prefetch behavior, including the chapter-N / chapter-1 / chapter-N+1 kickoff flow.
- A thin FastAPI backend proxy with local Kokoro and Modal modes.
- Automated tests for the extractor, sync rules, popup state, queue behavior, chunking, and WAV streaming logic.

What is not implemented yet:

- Multi-platform support beyond Wattpad.
- Login, account system, free/paid tiers, subscription handling, quotas, credits, or Paddle.
- Website, homepage sample audio, dashboard, settings page, or author opt-out flow.
- Media Session / OS controls, seek bar, playback speed, skip buttons, chapter label switching, or quota footer.
- Language detection and supported-language gating.
- Legal/policy surfaces.

What is partially implemented but not yet aligned with the vision:

- Local library exists, but playback is still tied to opening the Wattpad chapter page, so true offline replay from the library is not yet achieved.
- Sync rules are advanced, but there is no quota model and no locked-chapter detection UI.
- The extension behaves like a Wattpad product, not a general Naramine product.
- The extension currently injects a content script on `<all_urls>`, which is broader than the vision’s minimum-permission stance.
- Finished chapter tabs are closed automatically during auto-advance cleanup, which conflicts with the vision’s “tabs are never closed automatically” rule.
- Cached audio has a 30-day cleanup TTL safety net, which conflicts with the “play already cached forever” product promise.

## Evidence Base

Primary evidence files:

- `features/readaloud-extension/extension/manifest.json`
- `features/readaloud-extension/extension/src/background/service_worker.js`
- `features/readaloud-extension/extension/src/audio/playbackQueue.js`
- `features/readaloud-extension/extension/src/offscreen/offscreen.js`
- `features/readaloud-extension/extension/src/offscreen/wavStreamPlayer.js`
- `features/readaloud-extension/extension/src/content/content.js`
- `features/readaloud-extension/extension/src/content/wattpadExtractor.js`
- `features/readaloud-extension/extension/src/db/idb.js`
- `features/readaloud-extension/extension/src/popup/popup.html`
- `features/readaloud-extension/extension/src/popup/popup.js`
- `features/readaloud-extension/extension/src/popup/popupState.js`
- `features/readaloud-extension/extension/src/shared/syncState.js`
- `features/readaloud-extension/extension/src/shared/libraryState.js`
- `features/readaloud-extension/backend/app.py`
- `features/readaloud-extension/backend/tts_local.py`
- `features/readaloud-extension/backend/tts_modal.py`
- `features/readaloud-extension/backend/kokoro_modal_app.py`
- `features/readaloud-extension/README.md`
- `features/readaloud-extension/IMPLEMENTATION.md`
- `features/readaloud-extension/extension/tests/*.test.js`

## Section-by-Section Audit Against The Consolidated Vision

## 1. What Naramine Is

Status: Partial

Implemented:

- The repo does implement an audio companion extension layered on top of an existing reading platform.
- The extension reads chapter text from the page the user opened.
- The text is converted to speech and played in an extension-driven player.
- Audio is cached locally in IndexedDB.

Not yet implemented or not aligned:

- The implementation is Wattpad-specific, not yet a general Naramine product for the four V1 platforms.
- The repo has no homepage sample audio experience.
- The repo has no surrounding product website or signup funnel.
- The current implementation still requires the reader to open the Wattpad chapter page to start or resume playback, so “replay offline from the local library” is not yet fully realized.

Notes:

- The popup copy explicitly says “Naramine narrates Wattpad chapters as you read.”
- `PlaybackQueue.start()` blocks replay of an existing cached chapter when the user is not currently viewing that chapter’s Wattpad page.

## 2. Core Principles

### Client-side reading

Status: Implemented for Wattpad

- Chapter extraction happens in the content script from the user’s live page DOM and HTML.
- The backend does not fetch Wattpad URLs itself.

### Content-blind backend

Status: Partially implemented

- The backend is effectively stateless and does not persist chapter text, titles, URLs, or audio.
- This is stronger than the vision’s “content-blind backend” rule in one sense.
- However, the backend also does not yet implement the vision’s allowed usage-record layer for volume, timing, platform, and status.

### Local-only library

Status: Implemented, with caveats

- Chapters, chunks, audio blobs, and story metadata are stored locally in IndexedDB.
- Session state, sync flags, recents, sleep timer state, and active chapter are stored in `chrome.storage.local`.
- There is no cross-device sync and no server-side audio library.

Caveat:

- Cached audio is subject to cleanup by a 30-day TTL safety net in `shared/constants.js` and `idb.js`.
- That means the code does not currently guarantee “already cached forever.”

### No discovery

Status: Implemented

- There is no recommendation, ranking, search, catalog, or hosted library feature in this repo.
- The guide only links out to Wattpad and shows recent local reads.

### Never narrate locked content

Status: Partial

- The extractor only narrates text it can actually read from the page.
- If the page does not expose usable chapter text, extraction fails.

Missing:

- There is no explicit locked/paywalled chapter detection model.
- There is no explicit “locked chapter” state or block icon UI.
- There is no platform-specific premium/locked-state parser.

### Author respect / opt-out

Status: Missing

- No author opt-out list, no local check before scrape, no verification flow, no public opt-out page.

## 3. Supported Platforms (V1)

Status: Mostly missing

Implemented:

- Wattpad only.

Missing:

- HoneyFeed parser.
- RoyalRoad parser.
- ScribbleHub parser.
- Remote-updatable parser config system.
- Any evidence of AO3/FanFiction deferral logic.

Evidence:

- Content extraction code only implements Wattpad selectors, Wattpad URL patterns, Wattpad UI copy, and Wattpad tests.
- The guide button is “Browse Wattpad.”

## 4. User Tiers

Status: Missing

Missing entirely:

- Logged-out vs free vs paid account states.
- Google or email auth.
- Free one-chapter trial logic.
- Paid subscription state.
- Instant demotion on payment lapse.
- Backend enforcement of account or tier state.

Current reality:

- The extension is locally usable without any account system.
- There is no gate that blocks anonymous usage of the extension.

## 5. Marketing / Adoption Funnel

Status: Missing

Missing entirely:

- Marketing site.
- Homepage sample audio player.
- Signup flow.
- Google/email auth UI.
- Install funnel.
- Upgrade funnel tied to free chapter usage.
- Paddle checkout.

Repo reality:

- This repo is an extension/backend MVP only.

## 6. Permissions

Status: Not aligned

Implemented:

- The manifest requests `storage`, `offscreen`, `activeTab`, `tabs`, and `alarms`.
- It has localhost host permissions for the local proxy / TTS surfaces.

Not aligned with the vision:

- The content script is declared on `<all_urls>`, which is broader than “supported platform domains only.”
- The extension uses `tabs`, which is broader than the vision’s stated minimum set.
- The manifest does not yet express the final platform-restricted host permission model.
- The design does not use the `scripting` permission for targeted injection; instead it uses a globally declared content script.

## 7. The Extension

### 7.1 Dropdown panel

Status: Partial

Implemented:

- A popup exists and acts as a remote control for offscreen playback.
- Sync toggle exists.
- Sleep timer exists.
- Library view exists.
- Guide view exists for unsupported/non-reading contexts.
- Controls are button-based and include ARIA labels.

Missing from the spec:

- Supported-platform icon list for first run.
- Four-platform messaging.
- Current-page chapter label above the player.
- Prev chapter button.
- Next chapter button.
- Skip back 30s.
- Skip forward 30s.
- Playback speed control.
- Seek bar with draggable caret.
- Buffering indicator in a real seek/timeline control.
- Time remaining and total duration display.
- Per-chapter sync state surface in the player itself.
- Quota footer.

Current popup behavior:

- Player view: play/pause, stop, timer, two progress fills, sync toggle, sleep timer, library button.
- Guide view: Wattpad-only guidance plus a “Browse Wattpad” button and recent reads.
- Library view: grouped stories, per-chapter rows, delete actions, continue actions.

### 7.2 Player behavior

Status: Partial

Implemented:

- One active chapter/session model is present through `activeChapterId`.
- Playback continues outside the popup via an offscreen document.
- Start-while-syncing is implemented through live stream startup plus background warmup.
- Next chunks can be prepared while playback is still running.
- Auto-advance to the next chapter exists.
- Playback progress is persisted and mapped to UI state.

Missing or misaligned:

- No Media Session API or OS media hub support.
- No hardware media key support.
- No chapter/novel/author header in the player matching the full vision.
- No seek support.
- No “silent loading while seeking into not-yet-downloaded audio” behavior because there is no seeking.
- No total duration / remaining duration handling.
- No explicit caught-up / sync-off / monthly-limit stop reasons shown at chapter end.
- No disabled-control model that exactly matches “nothing to play.”

Important mismatch:

- The code intentionally blocks starting/restarting a cached chapter unless the current active tab is the matching Wattpad chapter page. That is stricter than the vision and prevents a true “play cached chapters forever/offline from the library” experience.

### 7.3 Sleep timer

Status: Partially implemented

Implemented:

- End-of-chapter mode.
- Duration mode using `chrome.alarms`.
- Timer state persistence.
- Pause without closing tabs.
- Suppression of auto-advance when end-of-chapter sleep mode fires.
- Sync/warmup can continue in the background after the timer pauses playback.

Missing:

- 5-minute option.
- 10-minute option.
- Custom duration option.

## 8. Sync & Playback Model

### 8.1 What “Sync” means

Status: Mostly implemented

Implemented:

- Chapter text is parsed client-side.
- Text is chunked locally.
- Audio is fetched chunk-by-chunk from a TTS provider.
- Chunks and audio are stored locally.
- Warming pipelines fill in remaining audio after playback startup.

Partial / mismatch:

- There is no language detection gate before TTS.
- There is no quota or credit gate before TTS.
- The implementation can refresh a chapter’s extracted text when the DOM grows near chapter end, to handle lazy-loaded content. That is useful, but it differs from the simpler “never re-download unless the user deletes the novel” rule in the vision.

### 8.2 Sync triggers and ordering

Status: Strongly implemented for Wattpad

Implemented:

- Sync On from a story page kicks off chapter 1 backfill and chains next-chapter work.
- Sync On from a mid-novel chapter follows the intended sequence: current chapter, chapter 1 backfill, next chapter.
- Current chapter warmup plus next chapter prefetch logic are explicit.
- Same-story sync enablement is stored per story.
- Ongoing visits while sync is enabled continue the frontier.

Missing:

- Free-tier single-chapter exception.
- Any quota-aware branching.
- Any per-platform generalization beyond Wattpad.

### 8.3 Tabs and playback focus

Status: Partial and partly conflicting

Implemented:

- Auto-advance activates the next chapter tab.
- If the next chapter tab does not exist, the code opens it.
- Playback is offscreen, so closing the popup does not stop playback.

Missing:

- “Current-page chapter label” control for switching playback to the current page.

Conflicting with the vision:

- The code closes finished chapter tabs during cleanup.
- The vision explicitly says tabs are never closed automatically.

### 8.4 Concurrency and identity

Status: Mostly implemented for Wattpad

Implemented:

- Story IDs and part IDs are numeric IDs extracted from Wattpad URLs/page data.
- Duplicate prefetch/backfill runs are guarded.
- Warmup is single-flight per chapter.
- The current-chapter-first rule is enforced through warmup gating.
- The next chapter does not run ahead while the current chapter still has warmable chunks.

### 8.5 Cursor

Status: Implemented for the specified entry cases, with a broader playback-model caveat

Implemented:

- The queue stores a per-story playback cursor, not just a chapter bookmark: chapter id, chunk index, in-chunk offset, and accumulated chapter position.
- The popup library offers Continue.
- Enter novel page + Play: the queue resolves the story cursor and resumes that chapter/position; when no cursor exists yet, it falls back to chapter 1.
- Enter current chapter + Play: if the current page matches the saved cursor chapter, playback resumes from the saved position.
- Enter different chapter + Play: playback starts that chapter from the beginning instead of forcing the older story cursor position onto it.
- Resume can reuse an already-open chapter tab or open the chapter page and continue from the stored position.
- When an already-open local session is further ahead than the last persisted cursor record, resume prefers the newer local session state.

Caveat:

- This satisfies the cursor semantics described in §8.5 itself.
- It does not remove the repo’s broader page-coupled playback limitation: if the needed chapter tab is not already open, resume may still open/focus the live Wattpad page, so this should not be read as “offline replay from the library is fully solved.”

### 8.6 Language detection

Status: Missing

Missing:

- Client-side language detection.
- Low-confidence detection handling.
- Unsupported-language blocking.
- Per-language voice selection behavior tied to sync time.

Current reality:

- The extension uses a single default voice, `af_heart`.

### 8.7 Locked / unavailable next chapters

Status: Partial

Implemented:

- The extractor can resolve the next chapter when a `nextPart` or TOC link exists.
- Missing next chapter naturally results in no next-part data.

Missing:

- Explicit distinction between locked and nonexistent.
- Locked-chapter icon/tooltip.
- Recheck model that classifies locked vs unlocked vs missing as separate states.

## 9. Website & Dashboard

Status: Mostly missing

Implemented locally in the extension:

- A local library view in the popup.
- Story grouping with cover and author when metadata is available.
- Continue actions based on local progress.
- Delete chapter and delete story actions.

Missing from the vision:

- Website app.
- Dashboard outside the extension.
- Extension-to-website messaging layer.
- Install prompt UX.
- Navigate button from dashboard to chapter page.
- Account settings screens.
- Email change, password change, password reset, account deletion.
- Language/voice settings accordion.
- FAQ / education about library mortality.

Mismatch:

- The vision says the dashboard should order novels by last played. The popup library groups by local chapter timestamps, not a true dashboard-style last-played ordering.

## 10. Plans & Billing

Status: Missing

Missing entirely:

- Free plan logic.
- Paid plan logic.
- $6/month billing.
- 100 chapter credits.
- 10,000-word credit metering.
- Negative-balance rule.
- Quota reset windows.
- Upgrade prompts.
- Support refund/credit-back flow.
- Paddle webhooks and merchant-of-record setup.

Related code that exists but is not enough:

- The backend has optional bearer-token protection for the Modal endpoint.
- That token is infrastructure protection, not product billing/auth/quota.

## 11. Backend & Infrastructure

Status: Partial

Implemented:

- FastAPI backend with `/health`, `/tts`, and `/tts/stream`.
- Local Kokoro mode and Modal mode.
- Modal service app in `kokoro_modal_app.py`.
- Streaming audio proxying.
- No content persistence.

Not yet implemented:

- Product auth.
- Subscription state.
- Quota enforcement.
- Rate limiting.
- Usage logging by user/platform/status.
- Aggregate stats pipeline.
- Any durable backend storage at all.

Partial mismatch with the vision:

- The vision’s active serving format is Opus/WebM. The current extension playback path always requests WAV.
- Backend request models allow `wav|opus|webm`, but the offscreen/player path is built around WAV stream parsing and playback.

## 12. Author Opt-Out (V1)

Status: Missing

Missing entirely:

- Public opt-out page.
- Ownership verification flow.
- Distributed opt-out list.
- Local extension check against opt-out list.
- Author-respect message when narration is blocked.

## 13. Legal & Policy Surfaces (V1)

Status: Missing

Missing entirely:

- DMCA / takedown process surfaces.
- Terms of Service.
- Privacy Policy.
- Repeat-infringer policy.
- Author opt-out public page.

## 14. V2 Candidates

Status: Not implemented

No V2 candidate in the vision appears to be implemented here:

- Author opt-in / revenue share.
- Listener-to-author engagement prompt.
- Voice cloning / own-voice.
- Audio export.
- AO3 / FanFiction support.
- Library export/import.
- Firefox / Safari support.

## 15. Enumerated Exceptions

### Flow 2 three-chapter burst

Status: Implemented

- The sync kickoff helpers and queue logic implement the current chapter + chapter 1 + next chapter burst when sync is turned on mid-novel.

### Free-tier single-chapter sync

Status: Missing

- No user tiers or quota logic exist, so this exception is not implemented.

## Additional Current Features Not Explicitly Called Out In The Vision

These are implemented and worth preserving because they are useful:

- Click-to-play from a specific paragraph on the Wattpad page.
- Active-paragraph highlighting and scroll-follow behavior on the page.
- Retry logic for interrupted/failed playback starts.
- Prepared-stream lookahead in the offscreen player.
- Lazy-load chapter growth handling near chapter end.
- Local recent-reads guide in the popup.

## Biggest Gaps To Close Before The Repo Matches The V1 Vision

Priority 1:

- Generalize from Wattpad-only to the four V1 platforms.
- Build auth, tiering, billing, and quota enforcement.
- Add a real website surface: homepage, sample audio, signup, dashboard, settings.

Priority 2:

- Decouple cached playback from needing the live Wattpad page, so offline replay is real.
- Replace broad `<all_urls>` injection with platform-scoped permissions and content script matching.
- Stop auto-closing chapter tabs if the vision’s tab model is authoritative.

Priority 3:

- Add player controls required by the vision: previous/next chapter, skip 30s, speed, seek bar, total/remaining time, chapter label switching, Media Session.
- Add language detection and per-language voice settings.
- Add locked-chapter detection and author opt-out enforcement.

Priority 4:

- Add legal/policy surfaces.
- Add usage logging and aggregate stats that remain content-blind.
- Decide whether the 30-day TTL is acceptable or whether “cached forever until deleted” must become literal.

## Bottom Line

This repository is a solid Wattpad-centric extension MVP with sophisticated playback and sync internals. It already proves the core technical loop: scrape in-browser, chunk text, stream TTS quickly, warm the rest, cache locally, and manage chapter progression.

It is not yet the full Naramine V1 product described in the consolidated vision. The largest remaining work is not audio plumbing; it is productization: multi-platform support, account and billing systems, quota logic, website/dashboard/settings surfaces, permissions tightening, and several user-facing behavior changes needed to fully match the vision.
