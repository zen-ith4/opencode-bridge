import test from "node:test";
import assert from "node:assert/strict";
import { detectRepetition, describeRepetition } from "../test-build/repetition.js";

test("detects a single-character runaway such as the reported 茫 loop", () => {
  const hit = detectRepetition("The story ends here.\n" + "茫".repeat(260));
  assert.ok(hit);
  assert.equal(hit.kind, "char-run");
  assert.equal(hit.pattern, "茫");
  assert.ok(hit.repeats > 200);
  assert.match(describeRepetition(hit), /茫/);
});

test("does not flag exactly 200 repeated characters (threshold is >200)", () => {
  assert.equal(detectRepetition("茫".repeat(200)), null);
  assert.ok(detectRepetition("茫".repeat(201)));
});

test("detects a repeated short pattern", () => {
  const hit = detectRepetition("prefix " + "ab".repeat(200));
  assert.ok(hit);
  assert.equal(hit.kind, "pattern");
  assert.equal(hit.pattern, "ab");
  assert.ok(hit.repeats >= 8);
});

test("normal Persian and English prose is not a loop", () => {
  const persian =
    "در روزگاران قدیم، پادشاهی بود که سه دختر داشت. " +
    "هر شب به باغ قصر می‌رفت و به ستاره‌ها نگاه می‌کرد. " +
    "روزی مسافری از راه دور آمد و از او کمک خواست. ".repeat(8);
  assert.equal(detectRepetition(persian), null);

  const english =
    "The old king walked through the garden every evening and watched the stars. " +
    "One day a traveller arrived from a distant land and asked for help. ".repeat(8);
  assert.equal(detectRepetition(english), null);
});

test("short legitimate repeats such as Markdown rules and code lines do not trigger", () => {
  const markdown = [
    "Before",
    "",
    "----",
    "",
    "```js",
    "----",
    "----",
    "----",
    "```",
    "",
    "After",
  ].join("\n");
  assert.equal(detectRepetition(markdown), null);
});

test("a long table with varying rows does not trigger", () => {
  const rows = ["| id | name | value |", "| --- | --- | --- |"];
  for (let i = 0; i < 120; i += 1) {
    rows.push(`| ${i} | item ${i} | value ${i * 3} |`);
  }
  assert.equal(detectRepetition(rows.join("\n")), null);
});

test("only the trailing window is inspected", () => {
  const middleLoop =
    "A".repeat(50) + "茫".repeat(300) + "\n" + "Normal ending text follows here. ".repeat(40);
  assert.equal(detectRepetition(middleLoop), null);

  const tailLoop = "A long normal story. ".repeat(40) + "*".repeat(220);
  assert.ok(detectRepetition(tailLoop));
});
