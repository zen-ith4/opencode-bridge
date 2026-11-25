import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ui = require("../media/uiState.cjs");

test("Esc closes an overlay before it stops generation", () => {
  assert.equal(ui.escapeAction({ overlayOpen: true, generating: true }), "close-overlay");
  assert.equal(ui.escapeAction({ overlayOpen: true, generating: false }), "close-overlay");
  assert.equal(ui.escapeAction({ overlayOpen: false, generating: true }), "stop");
  assert.equal(ui.escapeAction({ overlayOpen: false, generating: false }), "none");
});

test("toolbar collapses below 340px and hides labels below 260px", () => {
  assert.deepEqual(ui.toolbarMode(480), { compact: false, tiny: false });
  assert.deepEqual(ui.toolbarMode(340), { compact: false, tiny: false });
  assert.deepEqual(ui.toolbarMode(339), { compact: true, tiny: false });
  assert.deepEqual(ui.toolbarMode(260), { compact: true, tiny: false });
  assert.deepEqual(ui.toolbarMode(259), { compact: true, tiny: true });
});

test("attachment chips dedupe by URI and preserve order", () => {
  const first = { uri: "file:///a.ts", name: "a.ts" };
  const second = { uri: "file:///b.ts", name: "b.ts" };
  const rest = ui.dedupeAttachments([first], [second, first, { name: "no-uri" }]);
  assert.deepEqual(
    rest.map((att) => att.uri),
    ["file:///a.ts", "file:///b.ts"]
  );
});

test("scroll follow stays pinned through growth but yields to user scroll", () => {
  const frames = [];
  let scrolls = 0;
  const follow = ui.createScrollFollow({
    threshold: 24,
    requestFrame: (callback) => frames.push(callback),
    scrollToBottom: () => {
      scrolls += 1;
    },
  });

  // Content growth while stuck schedules exactly one scroll per frame.
  assert.equal(follow.onContentResize(), true);
  assert.equal(follow.onContentResize(), false);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(scrolls, 1);

  // The user scrolls up: growth no longer scrolls them away from their place.
  assert.equal(follow.onUserScroll(500), false);
  assert.equal(follow.onContentResize(), false);
  assert.equal(frames.length, 0);

  // Back near the bottom re-pins, and growth follows again.
  assert.equal(follow.onUserScroll(10), true);
  assert.equal(follow.onContentResize(), true);
});

test("a mocked ResizeObserver scrolls only while the user is at the bottom", () => {
  class MockResizeObserver {
    constructor(callback) {
      this.callback = callback;
      MockResizeObserver.instances.push(this);
    }
    observe() {}
    disconnect() {}
  }
  MockResizeObserver.instances = [];

  const frames = [];
  let scrolls = 0;
  const follow = ui.createScrollFollow({
    requestFrame: (callback) => frames.push(callback),
    scrollToBottom: () => {
      scrolls += 1;
    },
  });
  const observer = new MockResizeObserver(() => follow.onContentResize());
  observer.observe();

  observer.callback();
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(scrolls, 1);

  follow.onUserScroll(300);
  observer.callback();
  assert.equal(frames.length, 0);
  assert.equal(scrolls, 1);
});

test("sending pins the follow state even after a user scrolled up", () => {
  const frames = [];
  const follow = ui.createScrollFollow({
    requestFrame: (callback) => frames.push(callback),
    scrollToBottom: () => {},
  });
  follow.onUserScroll(900);
  assert.equal(follow.isStuck(), false);
  follow.pin();
  assert.equal(follow.isStuck(), true);
  assert.equal(frames.length, 1);
});
