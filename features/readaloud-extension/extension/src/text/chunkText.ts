export type TextChunk = {
  storyId: string;
  chapterId: string;
  chunkIndex: number;
  text: string;
  textHash: string;
  chunkId: string;
};

export declare function stableHash(input: string): string;
export declare function chunkText(
  text: string,
  options?: { storyId?: string; chapterId?: string }
): TextChunk[];
