const MIN_PARAGRAPH_COUNT = 3;
const MIN_TEXT_LENGTH = 300;
const UI_PHRASES = [
  "you are reading",
  "add to list",
  "vote",
  "share via facebook",
  "share via twitter",
  "share via pinterest",
  "share via tumblr",
  "start from the beginning",
  "continue to next part",
  "table of contents",
  "sign up for free to keep reading"
];

const DEFAULT_ACTIVE_CHUNK_CLASS = "readaloud-active-chunk";
const DEFAULT_ACTIVE_CHUNK_STYLE_ID = "readaloud-active-chunk-style";
const CLICKABLE_PARAGRAPH_STYLE_ID = "readaloud-clickable-paragraph-style";

function cssEscape(value) {
  if (globalThis.CSS?.escape) {
    return globalThis.CSS.escape(value);
  }

  return String(value).replace(/["\\]/g, "\\$&");
}

function getParagraphNodes(documentRef, paragraphIds = []) {
  const ids = paragraphIds.filter(Boolean);
  if (!ids.length) {
    return [];
  }

  const nodes = [];
  for (const paragraphId of ids) {
    const selector = `p[data-p-id="${cssEscape(paragraphId)}"]`;
    nodes.push(...documentRef.querySelectorAll(selector));
  }
  return nodes;
}

function ensureClickableParagraphStyles(documentRef) {
  if (documentRef.getElementById?.(CLICKABLE_PARAGRAPH_STYLE_ID)) {
    return;
  }

  const style = documentRef.createElement("style");
  style.id = CLICKABLE_PARAGRAPH_STYLE_ID;
  style.textContent = `
    article.story-part[data-part-id] p[data-p-id] {
      cursor: pointer;
    }
  `;
  documentRef.head?.appendChild(style) || documentRef.documentElement?.appendChild(style);
}

function normalizeWattpadPageHref(href = "") {
  if (!href) {
    return "";
  }

  try {
    const url = new URL(href, "https://www.wattpad.com");
    url.pathname = url.pathname.replace(/\/page\/\d+\/?$/i, "");
    return `${url.origin}${url.pathname}${url.search}${url.hash}`;
  } catch (_error) {
    return String(href).replace(/\/page\/\d+\/?($|[?#])/i, "$1");
  }
}

function createChunkFocusController({
  documentRef,
  windowRef = globalThis.window,
  activeChunkClass = DEFAULT_ACTIVE_CHUNK_CLASS,
  activeChunkStyleId = DEFAULT_ACTIVE_CHUNK_STYLE_ID
} = {}) {
  let activeChunkState = null;

  function ensureActiveChunkStyles() {
    if (documentRef.getElementById?.(activeChunkStyleId)) {
      return;
    }

    const style = documentRef.createElement("style");
    style.id = activeChunkStyleId;
    style.textContent = `
      .${activeChunkClass} {
        background: rgba(255, 244, 205, 0.78) !important;
        color: #f97316 !important;
        border-left: 5px solid #f97316 !important;
        box-shadow: inset 0 0 0 1px rgba(249, 115, 22, 0.28), 0 0 0 1px rgba(249, 115, 22, 0.08);
        scroll-margin-top: 30vh;
      }
      .${activeChunkClass} * {
        color: #f97316 !important;
      }
    `;
    documentRef.head?.appendChild(style) || documentRef.documentElement?.appendChild(style);
  }

  function clearActiveChunkHighlight() {
    if (!activeChunkState) {
      return;
    }

    for (const node of getParagraphNodes(documentRef, activeChunkState.paragraphIds)) {
      node.classList.remove(activeChunkClass);
      node.removeAttribute?.("data-readaloud-active-chunk");
    }

    activeChunkState = null;
  }

  function applyActiveChunkHighlight(chunkState, { scroll = true } = {}) {
    if (!chunkState?.chunkId) {
      return { ok: false, reason: "missing_chunk" };
    }

    ensureActiveChunkStyles();

    if (activeChunkState?.chunkId && activeChunkState.chunkId !== chunkState.chunkId) {
      clearActiveChunkHighlight();
    }

    const nextParagraphIds = Array.isArray(chunkState.paragraphIds)
      ? chunkState.paragraphIds.filter(Boolean)
      : [];
    const nodes = getParagraphNodes(documentRef, nextParagraphIds);
    if (!nodes.length) {
      activeChunkState = {
        chunkId: chunkState.chunkId,
        paragraphIds: nextParagraphIds
      };
      return { ok: false, reason: "no_anchor_found" };
    }

    activeChunkState = {
      chunkId: chunkState.chunkId,
      paragraphIds: nextParagraphIds
    };

    for (const node of nodes) {
      node.classList.add(activeChunkClass);
      node.dataset.readaloudActiveChunk = "true";
    }

    if (scroll && windowRef) {
      const scrollTarget = nodes[0];
      scrollTarget.scrollIntoView({ block: "start", inline: "nearest" });
    }

    return { ok: true };
  }

  function syncAfterMutation() {
    if (!activeChunkState) {
      return;
    }

    applyActiveChunkHighlight(activeChunkState, { scroll: false });
  }

  return {
    focusChunk: applyActiveChunkHighlight,
    clear: clearActiveChunkHighlight,
    syncAfterMutation,
    getActiveChunkState: () => activeChunkState
  };
}

function getReadingChapterId(documentRef) {
  const article =
    documentRef.querySelector("main#parts-container-new article.story-part[data-part-id]") ||
    documentRef.querySelector("article.story-part[data-part-id]");

  return article?.dataset?.partId || findPartId(documentRef.documentElement?.outerHTML || "", documentRef.location?.href || "");
}

function isParagraphClickModifier(event) {
  return Boolean(event?.metaKey || event?.ctrlKey || event?.altKey || event?.shiftKey);
}

function handleParagraphClick(event) {
  if (!event || event.button !== 0 || isParagraphClickModifier(event)) {
    return;
  }

  if (event.target?.closest?.("a, button, input, textarea, select, label")) {
    return;
  }

  const paragraph = event.target?.closest?.("p[data-p-id]");
  if (!paragraph?.dataset?.pId) {
    return;
  }

  const selection = window.getSelection?.();
  if (selection && !selection.isCollapsed) {
    return;
  }

  const chapterId = getReadingChapterId(document);
  if (!chapterId) {
    return;
  }

  event.preventDefault?.();
  event.stopPropagation?.();
  chrome.runtime
    .sendMessage({
      scope: "readaloud",
      type: "PLAY_FROM_PARAGRAPH",
      payload: {
        chapterId,
        paragraphId: paragraph.dataset.pId
      }
    })
    .catch(() => {
      // Best-effort request; the playback queue will fail cleanly if unavailable.
    });
}

function normalizeWhitespace(value) {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function stripNoiseHtml(value) {
  return value
    .replace(/<div\b[^>]*class="[^"]*\bcomponent-wrapper\b[^"]*"[\s\S]*?<\/div>/gi, " ")
    .replace(/<button\b[\s\S]*?<\/button>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeEscapedJsonString(value) {
  return value
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

function findStoryId(value, fallbackUrl = "") {
  const patterns = [/data-story-id="(\d+)"/i, /\/story\/(\d+)(?:[-/"]|$)/i, /storyid:\s*(\d+)/i, /"storyId":"?(\d+)"?/i];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      return match[1];
    }
  }

  const urlMatch = fallbackUrl.match(/\/story\/(\d+)/i);
  return urlMatch ? urlMatch[1] : null;
}

function findPartId(value, fallbackUrl = "") {
  const patterns = [/data-part-id="(\d+)"/i, /"partId":"?(\d+)"?/i, /\/(\d+)-/i];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      return match[1];
    }
  }

  const urlMatch = fallbackUrl.match(/\/(\d+)-/i);
  return urlMatch ? urlMatch[1] : null;
}

function findPartUrl(value, fallbackUrl = "") {
  const dataMatch = value.match(/data-part-url="([^"]+)"/i);
  if (dataMatch) {
    return decodeHtmlEntities(dataMatch[1]);
  }

  const urlMatch = value.match(/"url":"(https:\/\/www\.wattpad\.com\/[^"]+)"/i);
  if (urlMatch) {
    return decodeEscapedJsonString(urlMatch[1]);
  }

  return fallbackUrl || null;
}

function findTitle(value, fallbackTitle = "") {
  const pageTitleMatch = value.match(/"title":"([^"]+)"/i);
  if (pageTitleMatch) {
    return decodeEscapedJsonString(pageTitleMatch[1]);
  }

  return fallbackTitle || "";
}

function buildFailure(error, metadata = {}, strategy = "none", warnings = []) {
  return {
    ok: false,
    text: "",
    title: metadata.title || "",
    sourceUrl: metadata.sourceUrl || "",
    strategy,
    storyId: metadata.storyId || null,
    partId: metadata.partId || null,
    partUrl: metadata.partUrl || metadata.sourceUrl || "",
    paragraphCount: 0,
    confidence: "low",
    error,
    warnings
  };
}

function validateExtractedText(text, paragraphCount) {
  const warnings = [];

  if (paragraphCount < MIN_PARAGRAPH_COUNT) {
    warnings.push(`Too few chapter paragraphs: ${paragraphCount}`);
  }

  if (text.length < MIN_TEXT_LENGTH) {
    warnings.push(`Chapter text too short: ${text.length}`);
  }

  const lowered = text.toLowerCase();
  const contaminatedPhrase = UI_PHRASES.find((phrase) => lowered.includes(phrase));
  if (contaminatedPhrase) {
    warnings.push(`Chapter text contains page chrome: ${contaminatedPhrase}`);
  }

  return {
    ok: warnings.length === 0,
    warnings
  };
}

function buildSuccess(paragraphs, metadata, strategy, confidence) {
  const normalizedParagraphs = paragraphs
    .map((paragraph, index) => {
      if (typeof paragraph === "string") {
        const text = paragraph.trim();
        if (!text) {
          return null;
        }
        return {
          paragraphId: null,
          text,
          order: index
        };
      }

      const text = (paragraph?.text || "").trim();
      if (!text) {
        return null;
      }

      return {
        paragraphId: paragraph.paragraphId || paragraph.id || null,
        text,
        order: index
      };
    })
    .filter(Boolean);

  const text = normalizedParagraphs.map((paragraph) => paragraph.text).join("\n\n");
  const validation = validateExtractedText(text, normalizedParagraphs.length);

  if (!validation.ok) {
    return buildFailure("could_not_isolate_wattpad_chapter_text", metadata, strategy, validation.warnings);
  }

  return {
    ok: true,
    text,
    paragraphs: normalizedParagraphs,
    title: metadata.title || "",
    sourceUrl: metadata.sourceUrl || "",
    strategy,
    storyId: metadata.storyId || null,
    partId: metadata.partId || null,
    partUrl: metadata.partUrl || metadata.sourceUrl || "",
    paragraphCount: normalizedParagraphs.length,
    confidence,
    error: null,
    warnings: []
  };
}

function extractEmbeddedStoryTextFromHtml(value, metadata) {
  const storyTextMatch = value.match(/"storyText":"([\s\S]*?)","page":/i);
  if (!storyTextMatch) {
    return buildFailure("embedded_story_text_missing", metadata, "embedded-storyText");
  }

  const paragraphs = [];
  const storyTextHtml = decodeHtmlEntities(decodeEscapedJsonString(storyTextMatch[1]));
  const pattern = /<p\b[^>]*data-p-id="[^"]+"[^>]*>([\s\S]*?)<\/p>/gi;
  for (const match of storyTextHtml.matchAll(pattern)) {
    const text = normalizeWhitespace(decodeHtmlEntities(stripNoiseHtml(match[1])));
    if (text) {
      const paragraphIdMatch = match[0].match(/data-p-id="([^"]+)"/i);
      paragraphs.push({
        paragraphId: paragraphIdMatch?.[1] || null,
        text
      });
    }
  }

  return buildSuccess(
    paragraphs,
    {
      ...metadata,
      title: metadata.title || findTitle(value, metadata.title),
      storyId: metadata.storyId || findStoryId(value, metadata.sourceUrl),
      partId: metadata.partId || findPartId(value, metadata.sourceUrl),
      partUrl: metadata.partUrl || findPartUrl(value, metadata.sourceUrl)
    },
    "embedded-storyText",
    "medium"
  );
}

function findNextPartFromHtml(value, currentPartId = null) {
  // Wattpad embeds a "nextPart" object in the page payload; it is the most
  // reliable source. Only the id/title/url fields near the object start are
  // read so trailing nested objects cannot confuse the match.
  const embeddedMatch = value.match(/"nextPart":\{([\s\S]{0,800})/i);
  if (embeddedMatch) {
    const body = embeddedMatch[1];
    const id = body.match(/"id":\s*"?(\d+)"?/i)?.[1] || null;
    const urlMatch = body.match(/"url":"((?:[^"\\]|\\.)*)"/i);
    const titleMatch = body.match(/"title":"((?:[^"\\]|\\.)*)"/i);
    const url = urlMatch ? decodeEscapedJsonString(urlMatch[1]) : null;
    if (id && url && url.includes(`/${id}-`) && (!currentPartId || id !== String(currentPartId))) {
      return {
        partId: id,
        url,
        title: titleMatch ? decodeEscapedJsonString(titleMatch[1]) : ""
      };
    }
  }

  // Fall back to the table-of-contents links: find the entry for the current
  // part and take the next part-shaped href after it.
  if (currentPartId) {
    const links = [];
    for (const match of value.matchAll(/<a\b[^>]*href="(\/(\d+)-[^"]*)"[^>]*>/gi)) {
      links.push({ href: match[1], partId: match[2] });
    }
    const activeIndex = links.findIndex((link) => link.partId === String(currentPartId));
    if (activeIndex >= 0) {
      const next = links.slice(activeIndex + 1).find((link) => link.partId !== String(currentPartId));
      if (next) {
        return {
          partId: next.partId,
          url: `https://www.wattpad.com${decodeHtmlEntities(next.href)}`,
          title: ""
        };
      }
    }
  }

  return null;
}

function isWattpadReadingDocument(documentRef) {
  const hostname = documentRef.location?.hostname || "";
  if (!hostname.includes("wattpad.com")) {
    return false;
  }

  return Boolean(
    documentRef.body?.classList?.contains("route-storyReading") ||
      documentRef.querySelector("main#parts-container-new") ||
      documentRef.querySelector("article.story-part[data-part-id]")
  );
}

const chunkFocus = createChunkFocusController({
  documentRef: document,
  windowRef: window
});

ensureClickableParagraphStyles(document);

function extractWattpadTextFromDocument(documentRef) {
  const metadata = {
    title: documentRef.title || "",
    sourceUrl: documentRef.location?.href || ""
  };

  if (!isWattpadReadingDocument(documentRef)) {
    return buildFailure("not_wattpad_reading_page", metadata);
  }

  const article =
    documentRef.querySelector("main#parts-container-new article.story-part[data-part-id]") ||
    documentRef.querySelector("article.story-part[data-part-id]");

  if (article) {
    const paragraphs = Array.from(article.querySelectorAll("p[data-p-id]"))
      .map((paragraph) => {
        const clone = paragraph.cloneNode(true);
        for (const node of clone.querySelectorAll(".component-wrapper, .comment-marker, button, svg")) {
          node.remove();
        }
        return {
          paragraphId: paragraph.dataset.pId || null,
          text: normalizeWhitespace(clone.textContent || "")
        };
      })
      .filter((paragraph) => Boolean(paragraph.text));

    const domResult = buildSuccess(
      paragraphs,
      {
        ...metadata,
        title: metadata.title || findTitle(documentRef.documentElement.outerHTML, metadata.title),
        storyId: findStoryId(documentRef.documentElement.outerHTML, metadata.sourceUrl),
        partId: article.dataset.partId || findPartId(documentRef.documentElement.outerHTML, metadata.sourceUrl),
        partUrl: article.dataset.partUrl || findPartUrl(documentRef.documentElement.outerHTML, metadata.sourceUrl)
      },
      "dom-paragraphs",
      "high"
    );

    if (domResult.ok) {
      domResult.nextPart = findNextPartFromHtml(documentRef.documentElement.outerHTML, domResult.partId);
      return domResult;
    }
  }

  const embeddedResult = extractEmbeddedStoryTextFromHtml(documentRef.documentElement.outerHTML, metadata);
  if (embeddedResult.ok) {
    embeddedResult.nextPart = findNextPartFromHtml(documentRef.documentElement.outerHTML, embeddedResult.partId);
  }
  return embeddedResult;
}

function notifyPageReady(documentRef) {
  if (!isWattpadReadingDocument(documentRef) || documentRef.visibilityState !== "visible") {
    return;
  }

  chrome.runtime
    .sendMessage({
      scope: "readaloud",
      type: "PAGE_READY",
      payload: {
        ...extractWattpadTextFromDocument(documentRef),
        pageDetected: true,
        pageEligible: true,
        autoplayAllowed: false,
        pageVisible: true,
        detectedAt: Date.now()
      }
    })
    .catch(() => {
      // Best-effort warmup signal; popup-driven flows can still recover.
    });
}

function getPageSignature(documentRef) {
  const article = documentRef.querySelector("article.story-part[data-part-id]");
  const partId = article?.dataset?.partId || "";

  if (partId) {
    return JSON.stringify({
      partId
    });
  }

  return JSON.stringify({
    href: normalizeWattpadPageHref(documentRef.location?.href || ""),
    title: documentRef.title || ""
  });
}

let lastPageSignature = null;

function notifyPageReadyIfChanged(documentRef) {
  const nextSignature = getPageSignature(documentRef);
  if (nextSignature === lastPageSignature) {
    chunkFocus.syncAfterMutation();
    return;
  }

  chunkFocus.clear();
  lastPageSignature = nextSignature;
  notifyPageReady(documentRef);
}

let notifyTimer = null;

function schedulePageReadyCheck() {
  if (notifyTimer) {
    clearTimeout(notifyTimer);
  }

  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    notifyPageReadyIfChanged(document);
  }, 150);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "READALOUD_EXTRACT_TEXT") {
    if (message?.type === "READALOUD_SET_ACTIVE_CHUNK") {
      const result = chunkFocus.focusChunk(message.payload || {}, {
        scroll: message.payload?.scroll !== false
      });
      sendResponse(result);
      return true;
    }

    if (message?.type === "READALOUD_CLEAR_ACTIVE_CHUNK") {
      chunkFocus.clear();
      sendResponse({ ok: true });
      return true;
    }

    return undefined;
  }

  sendResponse(extractWattpadTextFromDocument(document));
  return true;
});

notifyPageReadyIfChanged(document);
document.addEventListener("visibilitychange", () => {
  schedulePageReadyCheck();
});
document.addEventListener("click", handleParagraphClick, true);
window.addEventListener("popstate", schedulePageReadyCheck);
window.addEventListener("hashchange", schedulePageReadyCheck);

const observer = new MutationObserver(() => {
  schedulePageReadyCheck();
});

if (document.body) {
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}
