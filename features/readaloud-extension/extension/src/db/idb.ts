export type ChapterRecord = {
  chapterId: string;
  sourceChapterId?: string;
  storyId: string;
  voice?: string;
  title: string;
  sourceUrl?: string;
  textHash: string;
  createdAt: number;
  expiresAt?: number;
};

export type ChunkRecord = {
  chunkId: string;
  chapterId: string;
  voice?: string;
  chunkIndex: number;
  text: string;
  textHash: string;
  status: "pending" | "generating" | "ready" | "failed";
};

export type AudioChunkRecord = {
  chunkId: string;
  chapterId: string;
  voice?: string;
  chunkIndex: number;
  mimeType: "audio/wav" | "audio/webm;codecs=opus";
  audioBlob: Blob;
  durationMs?: number;
  createdAt: number;
  expiresAt: number;
};
