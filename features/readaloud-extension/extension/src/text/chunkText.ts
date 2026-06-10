export type TextChunk = {
  storyId: string;
  chapterId: string;
  chunkIndex: number;
  text: string;
  textHash: string;
  chunkId: string;
  paragraphIds?: string[];
  paragraphId?: string | null;
};

export declare function stableHash(input: string): string;
export declare function chunkText(
  text: string,
  options?: {
    storyId?: string;
    chapterId?: string;
    paragraphs?: Array<{ text: string; paragraphId?: string | null; paragraphIds?: string[] } | string>;
  }
): TextChunk[];
