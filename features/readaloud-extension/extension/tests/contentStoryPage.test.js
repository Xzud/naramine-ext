import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const STORY_HTML = [
  "<html><head></head><body>",
  '<div data-story-info=\'{"firstPartId":111222,"avatar":"https://img.wattpad.com/avatar.jpg"}\'></div>',
  '<a href="/111222-the-great-story-chapter-1">The Great Story - Chapter 1</a>',
  "</body></html>"
].join("");

function buildStoryDocument() {
  const listeners = {};
  return {
    listeners,
    documentRef: {
      title: "The Great Story - Wattpad",
      location: {
        href: "https://www.wattpad.com/story/123456-the-great-story",
        hostname: "www.wattpad.com",
        pathname: "/story/123456-the-great-story"
      },
      visibilityState: "visible",
      body: {
        classList: {
          contains() {
            return false;
          }
        }
      },
      head: {
        appendChild() {}
      },
      documentElement: {
        outerHTML: STORY_HTML,
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
        if (selector === 'meta[property="og:title"]') {
          return { getAttribute: () => "The Great Story - Wattpad" };
        }
        if (selector === 'meta[property="og:image"]') {
          return { getAttribute: () => "https://img.wattpad.com/cover.jpg" };
        }
        if (selector === 'a[href^="/user/"]') {
          return { textContent: " authorperson " };
        }
        return null;
      },
      addEventListener(type, listener) {
        listeners[type] = listener;
      }
    }
  };
}

function loadContentScript(documentRef) {
  const messages = [];
  const runtimeListeners = [];
  const sandbox = {
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            runtimeListeners.push(listener);
          }
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
  return { messages, runtimeListeners };
}

test("visiting a story overview page emits scraped metadata", async () => {
  const { documentRef } = buildStoryDocument();
  const { messages } = loadContentScript(documentRef);

  const storyMessage = messages.find((message) => message.type === "STORY_PAGE_READY");
  assert.ok(storyMessage);
  assert.equal(storyMessage.scope, "readaloud");
  assert.equal(storyMessage.payload.storyId, "123456");
  assert.equal(storyMessage.payload.title, "The Great Story");
  assert.equal(storyMessage.payload.author, "authorperson");
  assert.equal(storyMessage.payload.coverUrl, "https://img.wattpad.com/cover.jpg");
  assert.equal(storyMessage.payload.avatarUrl, "https://img.wattpad.com/avatar.jpg");
  assert.equal(storyMessage.payload.firstPart.partId, "111222");
  assert.equal(storyMessage.payload.firstPart.url, "https://www.wattpad.com/111222-the-great-story-chapter-1");
  assert.equal(messages.some((message) => message.type === "PAGE_READY"), false);
});

test("page context request reports the story overview", async () => {
  const { documentRef } = buildStoryDocument();
  const { runtimeListeners } = loadContentScript(documentRef);

  let response = null;
  runtimeListeners[0]({ type: "READALOUD_GET_PAGE_CONTEXT" }, null, (value) => {
    response = value;
  });

  assert.equal(response.kind, "story");
  assert.equal(response.ok, true);
  assert.equal(response.storyId, "123456");
  assert.equal(response.firstPart.partId, "111222");
});
