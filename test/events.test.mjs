import test from "node:test";
import assert from "node:assert/strict";
import {
  parseEventPayload,
  parseSseBlock,
  extractTextDelta,
  shouldHandleEvent,
} from "../test-build/events.js";

const deltaPayload = {
  id: "evt_1",
  created: 1795280261391,
  type: "session.text.delta",
  data: {
    sessionID: "ses_ours",
    assistantMessageID: "msg_1",
    ordinal: 0,
    delta: "Hello",
  },
};

test("parses the real data-only SSE shape (type inside the JSON)", () => {
  const event = parseSseBlock(`data: ${JSON.stringify(deltaPayload)}`);
  assert.equal(event.type, "session.text.delta");
  assert.equal(event.id, "evt_1");
  assert.equal(event.sessionID, "ses_ours");
  assert.deepEqual(event.data, deltaPayload.data);
});

test("falls back to the SSE event: line when the payload has no type", () => {
  const event = parseSseBlock(
    `event: session.text.delta\ndata: ${JSON.stringify({ data: deltaPayload.data })}`
  );
  assert.equal(event.type, "session.text.delta");
  assert.equal(event.sessionID, "ses_ours");
});

test("payload.type wins over an SSE event: line", () => {
  const event = parseSseBlock(
    `event: wrong.type\ndata: ${JSON.stringify(deltaPayload)}`
  );
  assert.equal(event.type, "session.text.delta");
});

test("parses non-JSON data without throwing", () => {
  const event = parseSseBlock("data: not json");
  assert.equal(event.type, "unknown");
  assert.equal(event.data, "not json");
});

test("ignores comment lines and joins multiple data lines", () => {
  const event = parseSseBlock([': keep-alive', 'data: {"type":"session.idle",', 'data: "data":{}}'].join("\n"));
  assert.equal(event.type, "session.idle");
});

test("extractTextDelta reads data.delta (not data.text)", () => {
  const event = parseEventPayload(deltaPayload);
  const part = extractTextDelta(event);
  assert.deepEqual(part, {
    messageID: "msg_1",
    sessionID: "ses_ours",
    text: "Hello",
  });
});

test("extractTextDelta accepts data.text as a fallback and ignores other events", () => {
  const event = parseEventPayload({
    type: "session.text.delta",
    data: { sessionID: "ses_ours", assistantMessageID: "msg_2", text: "fallback" },
  });
  assert.equal(extractTextDelta(event).text, "fallback");

  const idle = parseEventPayload({ type: "session.idle", data: { sessionID: "ses_ours" } });
  assert.equal(extractTextDelta(idle), null);
});

test("extractTextDelta returns null for empty deltas", () => {
  const event = parseEventPayload({
    type: "session.text.delta",
    data: { sessionID: "ses_ours", assistantMessageID: "msg_1", delta: "" },
  });
  assert.equal(extractTextDelta(event), null);
});

test("session filtering only accepts our session and global events", () => {
  const ours = parseEventPayload(deltaPayload);
  const other = parseEventPayload({ ...deltaPayload, data: { ...deltaPayload.data, sessionID: "ses_other" } });
  const global = parseEventPayload({ type: "server.connected", data: {} });

  assert.equal(shouldHandleEvent(ours, "ses_ours"), true);
  assert.equal(shouldHandleEvent(other, "ses_ours"), false);
  assert.equal(shouldHandleEvent(ours, undefined), false);
  assert.equal(shouldHandleEvent(global, "ses_ours"), true);
  assert.equal(shouldHandleEvent(global, undefined), true);
});

test("sessionID can be recovered from the durable aggregateID", () => {
  const event = parseEventPayload({
    type: "session.updated",
    durable: { aggregateID: "ses_from_durable", seq: 1, version: "x" },
    data: {},
  });
  assert.equal(event.sessionID, "ses_from_durable");
});
