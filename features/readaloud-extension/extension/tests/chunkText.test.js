import test from "node:test";
import assert from "node:assert/strict";

import { chunkText, stableHash } from "../src/text/chunkText.js";

test("should_split_on_paragraphs_and_keep_stable_chunk_ids_when_text_matches", () => {
  const text = `Alpha paragraph with enough words to stand alone.

Beta paragraph follows with its own boundary.`;

  const first = chunkText(text, { storyId: "story", chapterId: "chapter" });
  const second = chunkText(text, { storyId: "story", chapterId: "chapter" });

  assert.equal(first.length, 2);
  assert.deepEqual(
    first.map((chunk) => chunk.chunkId),
    second.map((chunk) => chunk.chunkId)
  );
});

test("should_fallback_to_sentence_boundaries_when_paragraph_exceeds_max_chars", () => {
  const sentence = "A".repeat(320) + ".";
  const text = `${sentence} ${sentence} ${sentence}`;
  const chunks = chunkText(text, { storyId: "story", chapterId: "chapter" });

  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 1000));
});

test("should_generate_stable_hash_for_identical_values", () => {
  assert.equal(stableHash("same"), stableHash("same"));
  assert.notEqual(stableHash("same"), stableHash("different"));
});

test("should_preserve_paragraph_anchors_when_source_paragraphs_are_provided", () => {
  const chunks = chunkText("ignored", {
    storyId: "story",
    chapterId: "chapter",
    paragraphs: [
      { text: "First chunk paragraph", paragraphId: "p-1" },
      { text: "Second chunk paragraph", paragraphId: "p-2" }
    ]
  });

  assert.equal(chunks.length, 2);
  assert.deepEqual(
    chunks.map((chunk) => chunk.paragraphId),
    ["p-1", "p-2"]
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.paragraphIds),
    [["p-1"], ["p-2"]]
  );
});
