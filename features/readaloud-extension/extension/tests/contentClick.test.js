import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function buildParagraph(paragraphId, text) {
  return {
    dataset: { pId: paragraphId },
    cloneNode() {
      return {
        querySelectorAll() {
          return [];
        },
        textContent: text
      };
    }
  };
}

test("clicking a chunked paragraph sends a play-from-paragraph request", async () => {
  const messages = [];
  const listeners = {};
  const articleParagraphs = [
    buildParagraph("p-1", "Paragraph one ".repeat(20)),
    buildParagraph("p-2", "Paragraph two ".repeat(20)),
    buildParagraph("p-3", "Paragraph three ".repeat(20))
  ];
  const article = {
    dataset: {
      partId: "chapter-click",
      partUrl: "https://www.wattpad.com/chapter-click"
    },
    querySelectorAll(selector) {
      return selector === "p[data-p-id]" ? articleParagraphs : [];
    }
  };
  const documentRef = {
    title: "Click Chapter",
    location: {
      href: "https://www.wattpad.com/story/123-chapter-click",
      hostname: "www.wattpad.com"
    },
    visibilityState: "visible",
    body: {
      classList: {
        contains(value) {
          return value === "route-storyReading";
        }
      }
    },
    head: {
      appendChild() {}
    },
    documentElement: {
      outerHTML: '<article data-story-id="123" data-part-id="chapter-click"></article>',
      appendChild() {}
    },
    getElementById() {
      return null;
    },
    createElement() {
      return {
        textContent: "",
        appendChild() {}
      };
    },
    querySelector(selector) {
      if (selector.includes("article.story-part[data-part-id]")) {
        return article;
      }

      return null;
    },
    addEventListener(type, listener) {
      listeners[type] = listener;
    }
  };
  const windowRef = {
    addEventListener() {},
    getSelection() {
      return { isCollapsed: true };
    }
  };
  const sandbox = {
    chrome: {
      runtime: {
        onMessage: {
          addListener() {}
        },
        sendMessage(message) {
          messages.push(message);
          return Promise.resolve({ ok: true });
        }
      }
    },
    console,
    document: documentRef,
    window: windowRef,
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
      }

      observe() {}
    },
    setTimeout,
    clearTimeout,
    CSS: {
      escape(value) {
        return String(value);
      }
    }
  };

  const source = readFileSync(new URL("../src/content/content.js", import.meta.url), "utf8");
  vm.runInNewContext(source, sandbox, { filename: "content.js" });

  const clickEvent = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: {
      closest(selector) {
        if (selector === "p[data-p-id]") {
          return articleParagraphs[1];
        }

        return null;
      }
    },
    preventDefault() {},
    stopPropagation() {}
  };

  listeners.click(clickEvent);

  assert.equal(messages.some((message) => message.type === "PAGE_READY"), true);
  const playMessage = messages.find((message) => message.type === "PLAY_FROM_PARAGRAPH");
  assert.ok(playMessage);
  assert.equal(playMessage.scope, "readaloud");
  assert.equal(playMessage.payload.chapterId, "chapter-click");
  assert.equal(playMessage.payload.paragraphId, "p-2");
});

test("same-chapter Wattpad pagination does not re-emit page ready", async () => {
  const messages = [];
  const listeners = {};
  const observers = [];
  const article = {
    dataset: {
      partId: "chapter-click",
      partUrl: "https://www.wattpad.com/chapter-click"
    },
    querySelectorAll() {
      return [];
    }
  };
  const documentRef = {
    title: "Click Chapter",
    location: {
      href: "https://www.wattpad.com/1407678433-code-blue-%7E-chapter-1-%7E/page/2",
      hostname: "www.wattpad.com"
    },
    visibilityState: "visible",
    body: {
      classList: {
        contains(value) {
          return value === "route-storyReading";
        }
      }
    },
    head: {
      appendChild() {}
    },
    documentElement: {
      outerHTML: '<article data-story-id="123" data-part-id="chapter-click"></article>',
      appendChild() {}
    },
    getElementById() {
      return null;
    },
    createElement() {
      return {
        textContent: "",
        appendChild() {}
      };
    },
    querySelector(selector) {
      if (selector.includes("article.story-part[data-part-id]")) {
        return article;
      }

      return null;
    },
    addEventListener(type, listener) {
      listeners[type] = listener;
    }
  };
  const sandbox = {
    chrome: {
      runtime: {
        onMessage: {
          addListener() {}
        },
        sendMessage(message) {
          messages.push(message);
          return Promise.resolve({ ok: true });
        }
      }
    },
    console,
    document: documentRef,
    window: {
      addEventListener() {},
      getSelection() {
        return { isCollapsed: true };
      }
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }

      observe() {}
    },
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
    CSS: {
      escape(value) {
        return String(value);
      }
    }
  };

  const source = readFileSync(new URL("../src/content/content.js", import.meta.url), "utf8");
  vm.runInNewContext(source, sandbox, { filename: "content.js" });

  assert.equal(messages.filter((message) => message.type === "PAGE_READY").length, 1);

  documentRef.location.href = "https://www.wattpad.com/1407678433-code-blue-%7E-chapter-1-%7E/page/3";
  observers.at(-1).callback();

  assert.equal(messages.filter((message) => message.type === "PAGE_READY").length, 1);
});
