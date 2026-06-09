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

function extractParagraphTextsFromHtml(value) {
  const paragraphs = [];
  const pattern = /<p\b[^>]*data-p-id="[^"]+"[^>]*>([\s\S]*?)<\/p>/gi;

  for (const match of value.matchAll(pattern)) {
    const text = normalizeWhitespace(decodeHtmlEntities(stripNoiseHtml(match[1])));
    if (text) {
      paragraphs.push(text);
    }
  }

  return paragraphs;
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
  const patterns = [/data-part-id="(\d+)"/i, /"partId":"?(\d+)"?/i, /\/(\d+)-[^/]+$/i];
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

  const titleMatch = value.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    return decodeHtmlEntities(titleMatch[1].trim());
  }

  return fallbackTitle || "";
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
  const text = paragraphs.join("\n\n");
  const validation = validateExtractedText(text, paragraphs.length);

  if (!validation.ok) {
    return buildFailure("could_not_isolate_wattpad_chapter_text", metadata, strategy, validation.warnings);
  }

  return {
    ok: true,
    text,
    title: metadata.title || "",
    sourceUrl: metadata.sourceUrl || "",
    strategy,
    storyId: metadata.storyId || null,
    partId: metadata.partId || null,
    partUrl: metadata.partUrl || metadata.sourceUrl || "",
    paragraphCount: paragraphs.length,
    confidence,
    error: null,
    warnings: []
  };
}

export function isWattpadReadingPageFromHtml(value, sourceUrl = "") {
  const loweredUrl = sourceUrl.toLowerCase();
  const matchesHost = !sourceUrl || loweredUrl.includes("wattpad.com");
  if (!matchesHost) {
    return false;
  }

  return (
    /<body\b[^>]*class="[^"]*\broute-storyReading\b[^"]*"/i.test(value) ||
    /<main\b[^>]*id="parts-container-new"/i.test(value) ||
    /<article\b[^>]*class="[^"]*\bstory-part\b[^"]*"[^>]*data-part-id="/i.test(value)
  );
}

export function extractWattpadDomFromHtml(value, metadata = {}) {
  const articleMatch = value.match(
    /<article\b(?=[^>]*class="[^"]*\bstory-part\b[^"]*")(?=[^>]*data-part-id="([^"]+)")[^>]*?(?:data-part-url="([^"]+)")?[^>]*>([\s\S]*?)<\/article>/i
  );

  if (!articleMatch) {
    return buildFailure("dom_strategy_missing_story_part", metadata, "dom-paragraphs");
  }

  const articleHtml = articleMatch[0];
  const paragraphs = extractParagraphTextsFromHtml(articleHtml);
  const nextMetadata = {
    sourceUrl: metadata.sourceUrl || "",
    title: metadata.title || findTitle(value, metadata.title),
    storyId: metadata.storyId || findStoryId(value, metadata.sourceUrl),
    partId: metadata.partId || articleMatch[1] || findPartId(value, metadata.sourceUrl),
    partUrl: metadata.partUrl || decodeHtmlEntities(articleMatch[2] || "") || findPartUrl(value, metadata.sourceUrl)
  };

  return buildSuccess(paragraphs, nextMetadata, "dom-paragraphs", "high");
}

export function extractWattpadEmbeddedStoryTextFromHtml(value, metadata = {}) {
  const storyTextMatch = value.match(/"storyText":"([\s\S]*?)","page":/i);
  if (!storyTextMatch) {
    return buildFailure("embedded_story_text_missing", metadata, "embedded-storyText");
  }

  const storyTextHtml = decodeHtmlEntities(decodeEscapedJsonString(storyTextMatch[1]));
  const paragraphs = extractParagraphTextsFromHtml(storyTextHtml);
  const nextMetadata = {
    sourceUrl: metadata.sourceUrl || "",
    title: metadata.title || findTitle(value, metadata.title),
    storyId: metadata.storyId || findStoryId(value, metadata.sourceUrl),
    partId: metadata.partId || findPartId(value, metadata.sourceUrl),
    partUrl: metadata.partUrl || findPartUrl(value, metadata.sourceUrl)
  };

  return buildSuccess(paragraphs, nextMetadata, "embedded-storyText", "medium");
}

export function extractWattpadTextFromHtmlPage(value, metadata = {}) {
  if (!isWattpadReadingPageFromHtml(value, metadata.sourceUrl || "")) {
    return buildFailure("not_wattpad_reading_page", metadata);
  }

  const domResult = extractWattpadDomFromHtml(value, metadata);
  if (domResult.ok) {
    return domResult;
  }

  const embeddedResult = extractWattpadEmbeddedStoryTextFromHtml(value, metadata);
  if (embeddedResult.ok) {
    return embeddedResult;
  }

  return buildFailure("could_not_isolate_wattpad_chapter_text", metadata, "none", [
    ...domResult.warnings,
    ...embeddedResult.warnings
  ]);
}

export function isWattpadReadingDocument(documentRef) {
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

export function extractWattpadTextFromDocument(documentRef) {
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
    const paragraphTexts = Array.from(article.querySelectorAll("p[data-p-id]"))
      .map((paragraph) => {
        const clone = paragraph.cloneNode(true);
        for (const node of clone.querySelectorAll(".component-wrapper, .comment-marker, button, svg")) {
          node.remove();
        }
        return normalizeWhitespace(clone.textContent || "");
      })
      .filter(Boolean);

    const domResult = buildSuccess(
      paragraphTexts,
      {
        ...metadata,
        storyId: findStoryId(documentRef.documentElement.outerHTML, metadata.sourceUrl),
        partId: article.dataset.partId || findPartId(documentRef.documentElement.outerHTML, metadata.sourceUrl),
        partUrl: article.dataset.partUrl || findPartUrl(documentRef.documentElement.outerHTML, metadata.sourceUrl)
      },
      "dom-paragraphs",
      "high"
    );

    if (domResult.ok) {
      return domResult;
    }
  }

  return extractWattpadEmbeddedStoryTextFromHtml(documentRef.documentElement.outerHTML, metadata);
}
