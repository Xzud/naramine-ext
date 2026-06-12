import { CACHE_TTL_MS, DB_NAME, DB_VERSION } from "../shared/constants.js";

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withTransaction(storeNames, mode, callback) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeNames, mode);
        const stores = Object.fromEntries(storeNames.map((name) => [name, transaction.objectStore(name)]));
        let result;

        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);

        Promise.resolve(callback(stores))
          .then((value) => {
            result = value;
          })
          .catch((error) => {
            reject(error);
            transaction.abort();
          });
      })
  );
}

export function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("chapters")) {
        const chapters = db.createObjectStore("chapters", { keyPath: "chapterId" });
        chapters.createIndex("storyId", "storyId", { unique: false });
        chapters.createIndex("expiresAt", "expiresAt", { unique: false });
      }

      if (!db.objectStoreNames.contains("chunks")) {
        const chunks = db.createObjectStore("chunks", { keyPath: "chunkId" });
        chunks.createIndex("chapterId", "chapterId", { unique: false });
        chunks.createIndex("chapterId_chunkIndex", ["chapterId", "chunkIndex"], { unique: true });
        chunks.createIndex("chapterId_status", ["chapterId", "status"], { unique: false });
      }

      if (!db.objectStoreNames.contains("audioChunks")) {
        const audioChunks = db.createObjectStore("audioChunks", { keyPath: "chunkId" });
        audioChunks.createIndex("chapterId", "chapterId", { unique: false });
        audioChunks.createIndex("chapterId_chunkIndex", ["chapterId", "chunkIndex"], { unique: true });
        audioChunks.createIndex("expiresAt", "expiresAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function cleanupExpiredAudio(now = Date.now()) {
  return withTransaction(["audioChunks", "chapters", "chunks"], "readwrite", async ({ audioChunks, chapters, chunks }) => {
    const audioIndex = audioChunks.index("expiresAt");
    const chapterIndex = chapters.index("expiresAt");

    const expiredChapterIds = [];

    await iterateCursor(chapterIndex.openCursor(IDBKeyRange.upperBound(now)), (cursor) => {
      expiredChapterIds.push(cursor.value.chapterId);
      cursor.delete();
      cursor.continue();
    });

    await Promise.all([
      iterateCursor(audioIndex.openCursor(IDBKeyRange.upperBound(now)), (cursor) => {
        cursor.delete();
        cursor.continue();
      }),
      ...expiredChapterIds.map((chapterId) => deleteChapterScopedData(chunks, audioChunks, chapterId))
    ]);
  });
}

function iterateCursor(request, onCursor) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      onCursor(cursor);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function saveChapter(record) {
  return withTransaction(["chapters"], "readwrite", ({ chapters }) => promisifyRequest(chapters.put(record)));
}

export async function getChapter(chapterId) {
  return withTransaction(["chapters"], "readonly", ({ chapters }) => promisifyRequest(chapters.get(chapterId)));
}

export async function saveChunks(records) {
  return withTransaction(["chunks"], "readwrite", ({ chunks }) => Promise.all(records.map((record) => promisifyRequest(chunks.put(record)))));
}

function deleteAllFromIndex(index, key) {
  return iterateCursor(index.openCursor(IDBKeyRange.only(key)), (cursor) => {
    cursor.delete();
    cursor.continue();
  });
}

function deleteChapterScopedData(chunksStore, audioChunksStore, chapterId) {
  return Promise.all([
    deleteAllFromIndex(chunksStore.index("chapterId"), chapterId),
    deleteAllFromIndex(audioChunksStore.index("chapterId"), chapterId)
  ]);
}

export async function deleteChapterData(chapterId) {
  return withTransaction(["chapters", "chunks", "audioChunks"], "readwrite", async ({ chapters, chunks, audioChunks }) => {
    await Promise.all([
      promisifyRequest(chapters.delete(chapterId)),
      deleteChapterScopedData(chunks, audioChunks, chapterId)
    ]);
  });
}

export async function replaceChapterData(chapterId, chunkRecords) {
  return withTransaction(["chunks", "audioChunks"], "readwrite", async ({ chunks, audioChunks }) => {
    await deleteChapterScopedData(chunks, audioChunks, chapterId);
    await Promise.all(chunkRecords.map((record) => promisifyRequest(chunks.put(record))));
  });
}

export async function getChunksByChapter(chapterId) {
  return withTransaction(["chunks"], "readonly", ({ chunks }) =>
    promisifyRequest(chunks.index("chapterId").getAll(chapterId)).then((records) =>
      records.sort((left, right) => left.chunkIndex - right.chunkIndex)
    )
  );
}

export async function updateChunkStatus(chunkId, status) {
  return withTransaction(["chunks"], "readwrite", async ({ chunks }) => {
    const record = await promisifyRequest(chunks.get(chunkId));
    if (!record) {
      return null;
    }
    record.status = status;
    return promisifyRequest(chunks.put(record));
  });
}

export async function getNextPendingChunk(chapterId, minChunkIndex = 0) {
  const chunks = await getChunksByChapter(chapterId);
  return chunks.find((chunk) => chunk.chunkIndex >= minChunkIndex && chunk.status === "pending") || null;
}

export async function saveAudioChunk(record) {
  const payload = {
    ...record,
    expiresAt: record.expiresAt || Date.now() + CACHE_TTL_MS
  };
  return withTransaction(["audioChunks"], "readwrite", ({ audioChunks }) => promisifyRequest(audioChunks.put(payload)));
}

export async function getAudioChunk(chunkId) {
  return withTransaction(["audioChunks"], "readonly", ({ audioChunks }) => promisifyRequest(audioChunks.get(chunkId)));
}

export async function getAudioChunksByChapter(chapterId) {
  return withTransaction(["audioChunks"], "readonly", ({ audioChunks }) =>
    promisifyRequest(audioChunks.index("chapterId").getAll(chapterId)).then((records) =>
      records.sort((left, right) => left.chunkIndex - right.chunkIndex)
    )
  );
}

export async function countReadyAudioAhead(chapterId, currentChunkIndex) {
  const audioChunks = await getAudioChunksByChapter(chapterId);
  return audioChunks.filter((record) => record.chunkIndex >= currentChunkIndex).length;
}

export async function getChunkByIndex(chapterId, chunkIndex) {
  return withTransaction(["chunks"], "readonly", ({ chunks }) =>
    promisifyRequest(chunks.index("chapterId_chunkIndex").get([chapterId, chunkIndex]))
  );
}

export async function getAudioChunkByIndex(chapterId, chunkIndex) {
  return withTransaction(["audioChunks"], "readonly", ({ audioChunks }) =>
    promisifyRequest(audioChunks.index("chapterId_chunkIndex").get([chapterId, chunkIndex]))
  );
}

export async function getCacheStatus(chapterId) {
  const [chunks, audioChunks] = await Promise.all([getChunksByChapter(chapterId), getAudioChunksByChapter(chapterId)]);
  return {
    chunkCount: chunks.length,
    readyAudioCount: audioChunks.length,
    failedCount: chunks.filter((chunk) => chunk.status === "failed").length,
    cacheType: "temporary"
  };
}
