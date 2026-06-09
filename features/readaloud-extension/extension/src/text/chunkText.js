import { DEFAULT_CHAPTER_ID, DEFAULT_STORY_ID, MAX_CHARS, MAX_CHUNK_CHARS } from "../shared/constants.js";

export function stableHash(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `h${(hash >>> 0).toString(16)}`;
}

function splitParagraph(paragraph) {
  if (paragraph.length <= MAX_CHARS) {
    return [paragraph];
  }

  const sentences = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [paragraph];
  const segments = [];
  let current = "";

  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence) {
      continue;
    }

    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= MAX_CHARS) {
      current = candidate;
      continue;
    }

    if (current) {
      segments.push(current);
    }

    if (sentence.length <= MAX_CHARS) {
      current = sentence;
      continue;
    }

    let offset = 0;
    while (offset < sentence.length) {
      const next = sentence.slice(offset, offset + MAX_CHARS).trim();
      if (next) {
        segments.push(next);
      }
      offset += MAX_CHARS;
    }
    current = "";
  }

  if (current) {
    segments.push(current);
  }

  return segments;
}

export function chunkText(text, options = {}) {
  const storyId = options.storyId || DEFAULT_STORY_ID;
  const chapterId = options.chapterId || DEFAULT_CHAPTER_ID;
  const paragraphs = text
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const pieces = paragraphs.flatMap(splitParagraph);
  const chunks = [];
  let chunkIndex = 0;

  for (const piece of pieces) {
    if (!piece) {
      continue;
    }

    const normalized = piece.trim().slice(0, MAX_CHUNK_CHARS);
    const textHash = stableHash(`${storyId}:${chapterId}:${normalized}`);
    chunks.push({
      storyId,
      chapterId,
      chunkIndex,
      text: normalized,
      textHash,
      chunkId: `${chapterId}:${chunkIndex}:${textHash}`
    });
    chunkIndex += 1;
  }

  return chunks;
}
