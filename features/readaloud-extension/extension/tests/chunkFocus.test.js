import test from "node:test";
import assert from "node:assert/strict";

import { createChunkFocusController } from "../src/content/chunkFocus.js";

class FakeNode {
  constructor(paragraphId, rect = { top: 900, bottom: 980 }) {
    this.dataset = { pId: paragraphId };
    this._rect = rect;
    this.scrollCalls = 0;
    this.scrollOptions = null;
    this.attributes = {};
    const classes = new Set();
    this.classList = {
      add: (...values) => values.forEach((value) => classes.add(value)),
      remove: (...values) => values.forEach((value) => classes.delete(value)),
      contains: (value) => classes.has(value),
      values: () => [...classes]
    };
  }

  getBoundingClientRect() {
    return this._rect;
  }

  scrollIntoView(options) {
    this.scrollCalls += 1;
    this.scrollOptions = options;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }
}

function createFakeDocument(nodes) {
  const styles = [];
  return {
    innerHeight: 800,
    head: {
      appendChild(style) {
        styles.push(style);
        return style;
      }
    },
    documentElement: {
      appendChild(style) {
        styles.push(style);
        return style;
      }
    },
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        id: "",
        textContent: ""
      };
    },
    getElementById(id) {
      return styles.find((style) => style.id === id) || null;
    },
    querySelectorAll(selector) {
      const match = selector.match(/p\[data-p-id="([^"]+)"\]/);
      if (!match) {
        return [];
      }
      return nodes[match[1]] ? [nodes[match[1]]] : [];
    }
  };
}

test("should_scroll_and_highlight_the_active_chunk", () => {
  const nodes = {
    "p-1": new FakeNode("p-1", { top: 1000, bottom: 1080 })
  };
  const documentRef = createFakeDocument(nodes);
  const controller = createChunkFocusController({
    documentRef,
    windowRef: { innerHeight: 800 }
  });

  const result = controller.focusChunk({
    chunkId: "chunk-1",
    paragraphIds: ["p-1"]
  });

  assert.equal(result.ok, true);
  assert.equal(nodes["p-1"].classList.contains("readaloud-active-chunk"), true);
  assert.equal(nodes["p-1"].scrollCalls, 1);
  assert.deepEqual(nodes["p-1"].scrollOptions, { block: "start", inline: "nearest" });
});

test("should_scroll_when_the_chunk_is_already_visible", () => {
  const nodes = {
    "p-1": new FakeNode("p-1", { top: 120, bottom: 240 })
  };
  const documentRef = createFakeDocument(nodes);
  const controller = createChunkFocusController({
    documentRef,
    windowRef: { innerHeight: 800 }
  });

  controller.focusChunk({
    chunkId: "chunk-1",
    paragraphIds: ["p-1"]
  });

  assert.equal(nodes["p-1"].scrollCalls, 1);
  assert.deepEqual(nodes["p-1"].scrollOptions, { block: "start", inline: "nearest" });
});

test("should_restore_the_active_highlight_after_dom_mutation", () => {
  const nodes = {
    "p-1": new FakeNode("p-1", { top: 1000, bottom: 1080 })
  };
  const documentRef = createFakeDocument(nodes);
  const controller = createChunkFocusController({
    documentRef,
    windowRef: { innerHeight: 800 }
  });

  controller.focusChunk({
    chunkId: "chunk-1",
    paragraphIds: ["p-1"]
  });
  nodes["p-1"].classList.remove("readaloud-active-chunk");
  controller.syncAfterMutation();

  assert.equal(nodes["p-1"].classList.contains("readaloud-active-chunk"), true);
});

test("should_clear_the_active_highlight_when_stopped", () => {
  const nodes = {
    "p-1": new FakeNode("p-1", { top: 1000, bottom: 1080 })
  };
  const documentRef = createFakeDocument(nodes);
  const controller = createChunkFocusController({
    documentRef,
    windowRef: { innerHeight: 800 }
  });

  controller.focusChunk({
    chunkId: "chunk-1",
    paragraphIds: ["p-1"]
  });
  controller.clear();

  assert.equal(nodes["p-1"].classList.contains("readaloud-active-chunk"), false);
});
