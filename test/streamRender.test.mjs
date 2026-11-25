import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const StreamRender = require("../media/streamRender.cjs");
const md = require("../media/markdown.cjs");

test("splitStableBlocks only splits on blank lines outside fenced code", () => {
  const text = ["# Title", "", "Paragraph one.", "", "```js", "a", "", "b", "```", "", "Tail"].join(
    "\n"
  );
  const split = StreamRender.splitStableBlocks(text);
  assert.equal(split.stable, "# Title\n\nParagraph one.\n\n```js\na\n\nb\n```\n\n");
  assert.equal(split.open, "Tail");

  const noBoundary = StreamRender.splitStableBlocks("one line\nstill open");
  assert.equal(noBoundary.stable, "");
  assert.equal(noBoundary.open, "one line\nstill open");
});

test("a fenced block is not cut at its internal blank line", () => {
  const split = StreamRender.splitStableBlocks("```\na\n\nb\n```\n\nnext");
  assert.equal(split.stable, "```\na\n\nb\n```\n\n");
  assert.equal(split.open, "next");
});

test("the accumulator caps live rendering and exposes only a tail", () => {
  const acc = StreamRender.createAccumulator({ cap: 1000, tailChars: 200 });
  acc.append("x".repeat(1500));
  const snap = acc.snapshot();
  assert.equal(snap.capped, true);
  assert.equal(snap.enteredCap, true);
  assert.equal(snap.length, 1500);
  assert.equal(snap.tail.length, 200);
  acc.commit(snap);
  assert.equal(acc.isCapped(), true);
});

test("the render scheduler coalesces many schedule calls into one frame", () => {
  const frames = [];
  let flushes = 0;
  const scheduler = StreamRender.createRenderScheduler({
    flush: () => {
      flushes += 1;
    },
    requestFrame: (callback) => frames.push(callback),
  });
  for (let i = 0; i < 10000; i += 1) scheduler.schedule();
  assert.equal(frames.length, 1);
  assert.equal(flushes, 0);
  frames.shift()();
  assert.equal(flushes, 1);
  scheduler.flushNow();
  assert.equal(flushes, 2);
});

test("50,000 deltas (~250k chars) stay within the render and time budget", () => {
  const acc = StreamRender.createAccumulator();
  const frames = [];
  let flushes = 0;
  let stableAppends = 0;
  let openRenders = 0;
  let openCharsRendered = 0;

  const scheduler = StreamRender.createRenderScheduler({
    requestFrame: (callback) => frames.push(callback),
    flush: (force) => {
      flushes += 1;
      const snap = acc.snapshot();
      if (snap.capped) {
        // The real webview only updates a bounded plain-text tail here.
        assert.ok(snap.tail.length <= StreamRender.DEFAULT_TAIL_CHARS);
        acc.commit(snap);
        return;
      }
      if (snap.stableDelta) {
        stableAppends += 1;
        md.renderMarkdown(snap.stableDelta);
      }
      if (snap.stableDelta || snap.openChanged || force) {
        openRenders += 1;
        openCharsRendered += snap.open.length;
        md.renderMarkdown(snap.open);
      }
      acc.commit(snap);
    },
  });

  const started = Date.now();
  const chunk = "abcde";
  for (let i = 0; i < 50000; i += 1) {
    acc.append(chunk);
    scheduler.schedule();
    if (i % 300 === 299) acc.append("\n\n");
    if (i % 50 === 49) {
      const frame = frames.shift();
      if (frame) frame();
    }
  }
  while (frames.length > 0) frames.shift()();
  const elapsed = Date.now() - started;

  const totalChars = acc.length();
  assert.ok(totalChars >= 250000, `expected ~250k chars, got ${totalChars}`);
  assert.ok(flushes < 2000, `renders must be coalesced, got ${flushes}`);
  assert.ok(flushes < 50000 / 10, "far fewer renders than deltas");
  assert.ok(stableAppends <= 200, `completed blocks should render once, got ${stableAppends}`);
  assert.ok(openRenders <= flushes);
  assert.ok(
    openCharsRendered < totalChars * 40,
    `open-block rendering should stay roughly linear (${openCharsRendered} chars)`
  );
  assert.ok(elapsed < 5000, `50k-delta render simulation took ${elapsed}ms (budget 5000ms)`);
});
