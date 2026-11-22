import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { slashQuery, filterSlashItems } = require("../media/slash.cjs");

const CANDIDATES = [
  { kind: "builtin", name: "new", description: "Start a new chat" },
  { kind: "builtin", name: "sessions", description: "Switch session" },
  { kind: "builtin", name: "models", description: "Choose a model" },
  { kind: "builtin", name: "compact", description: "Compact the conversation" },
  { kind: "command", name: "review", description: "Review changes" },
  { kind: "command", name: "release", description: "Cut a release" },
  { kind: "skill", name: "deploy", description: "Deploy the app" },
];

test("slashQuery only accepts a single bare /name token", () => {
  assert.equal(slashQuery("/"), "");
  assert.equal(slashQuery("/comp"), "comp");
  assert.equal(slashQuery("/COMP"), "comp");
  assert.equal(slashQuery("/my-cmd_2"), "my-cmd_2");
  assert.equal(slashQuery("hello"), null);
  assert.equal(slashQuery("/two words"), null);
  assert.equal(slashQuery("/name/extra"), null);
  assert.equal(slashQuery(" /name"), null);
  assert.equal(slashQuery(""), null);
});

test("filterSlashItems keeps everything for an empty query", () => {
  assert.deepEqual(
    filterSlashItems(CANDIDATES, "").map((item) => item.name),
    CANDIDATES.map((item) => item.name)
  );
  assert.deepEqual(filterSlashItems(undefined, ""), []);
  assert.deepEqual(filterSlashItems([null, { name: 1 }, CANDIDATES[0]], ""), [CANDIDATES[0]]);
});

test("filterSlashItems matches names case-insensitively", () => {
  assert.deepEqual(
    filterSlashItems(CANDIDATES, "comp").map((item) => item.name),
    ["compact"]
  );
  assert.deepEqual(
    filterSlashItems(CANDIDATES, "MOD").map((item) => item.name),
    ["models"]
  );
});

test("filterSlashItems also matches descriptions", () => {
  assert.deepEqual(
    filterSlashItems(CANDIDATES, "changes").map((item) => item.name),
    ["review"]
  );
  assert.deepEqual(
    filterSlashItems(CANDIDATES, "session").map((item) => item.name),
    ["sessions"]
  );
  assert.deepEqual(
    filterSlashItems(CANDIDATES, "deploy").map((item) => item.name),
    ["deploy"]
  );
});

test("filterSlashItems returns no matches instead of throwing", () => {
  assert.deepEqual(filterSlashItems(CANDIDATES, "zzz"), []);
});
