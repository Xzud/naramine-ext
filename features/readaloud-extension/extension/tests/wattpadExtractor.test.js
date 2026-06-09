import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  extractWattpadDomFromHtml,
  extractWattpadEmbeddedStoryTextFromHtml,
  extractWattpadTextFromHtmlPage
} from "../src/content/wattpadExtractor.js";

const sampleHtml = fs.readFileSync(new URL("../../../../prompts/sample.html", import.meta.url), "utf8");
const sampleMetadata = {
  title: "Code Blue - ~ Chapter 1 ~ - Page 2",
  sourceUrl: "https://www.wattpad.com/1407678433-code-blue-%7E-chapter-1-%7E/page/2"
};
const firstParagraph = "The two of us continued to drink and make conversation.";

test("extracts the current Wattpad chapter body from story paragraphs", () => {
  const result = extractWattpadTextFromHtmlPage(sampleHtml, sampleMetadata);

  assert.equal(result.ok, true);
  assert.equal(result.strategy, "dom-paragraphs");
  assert.equal(result.confidence, "high");
  assert.ok(result.paragraphCount >= 3);
  assert.ok(result.text.startsWith(firstParagraph));
  assert.equal(result.text.includes("YOU ARE READING"), false);
  assert.equal(result.text.includes("Add to List"), false);
  assert.equal(result.text.includes("Vote"), false);
  assert.equal(result.text.includes("Share via Facebook"), false);
});

test("falls back to embedded storyText when DOM paragraphs are unavailable", () => {
  const htmlWithoutParagraphMarkers = sampleHtml.replace(/<p\b([^>]*?)data-p-id=/g, "<p$1data-removed-p-id=");
  const result = extractWattpadTextFromHtmlPage(htmlWithoutParagraphMarkers, sampleMetadata);

  assert.equal(result.ok, true);
  assert.equal(result.strategy, "embedded-storyText");
  assert.equal(result.confidence, "medium");
  assert.ok(result.text.startsWith(firstParagraph));
});

test("fails safely when neither DOM paragraphs nor storyText are available", () => {
  const noParagraphs = sampleHtml.replace(/<p\b([^>]*?)data-p-id=/g, "<p$1data-removed-p-id=");
  const noStoryText = noParagraphs.replace(/"storyText":"[\s\S]*?","page":/i, '"storyText":"","page":');
  const result = extractWattpadTextFromHtmlPage(noStoryText, sampleMetadata);

  assert.equal(result.ok, false);
  assert.equal(result.error, "could_not_isolate_wattpad_chapter_text");
});

test("direct DOM strategy strips comment widgets from paragraph text", () => {
  const result = extractWattpadDomFromHtml(sampleHtml, sampleMetadata);

  assert.equal(result.ok, true);
  assert.equal(result.text.includes("num-comment"), false);
  assert.equal(result.text.includes("comment-marker"), false);
});

test("embedded storyText strategy can be exercised independently", () => {
  const result = extractWattpadEmbeddedStoryTextFromHtml(sampleHtml, sampleMetadata);

  assert.equal(result.ok, true);
  assert.equal(result.strategy, "embedded-storyText");
  assert.ok(result.text.startsWith(firstParagraph));
});
