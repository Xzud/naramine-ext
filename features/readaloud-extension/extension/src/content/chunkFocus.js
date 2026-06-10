const DEFAULT_ACTIVE_CHUNK_CLASS = "readaloud-active-chunk";
const DEFAULT_ACTIVE_CHUNK_STYLE_ID = "readaloud-active-chunk-style";

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

export function createChunkFocusController({
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
