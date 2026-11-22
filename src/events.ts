/**
 * OpenCode Bridge - pure SSE / event helpers.
 *
 * Verified against a live `opencode serve` (v2.3.0) and its OpenAPI spec:
 *
 *   data: {"id":"evt_...","created":123,"type":"session.text.delta","data":{...}}
 *
 * Important: the server does NOT send an SSE `event:` line. The event type
 * lives in the JSON payload's top-level `type` field. Some proxies/SDKs may
 * add an `event:` line, so we accept both (`payload.type ?? sseEvent`).
 *
 * `session.text.delta` carries the new chunk in `data.delta` (not `text`).
 */

/** A parsed SSE event relevant to chat rendering. */
export interface BridgeEvent {
  /** Canonical event name (v2.3.0 names; v1.19.6 `session.next.*` is mapped). */
  type: string;
  /** The event's `data` object (payload.data), or the whole payload if absent. */
  data: unknown;
  /** Session this event belongs to, when the payload exposes one. */
  sessionID?: string;
  /** Server event id, used for de-duplication across reconnects. */
  id?: string;
  /** Raw parsed payload (for diagnostics). */
  raw?: unknown;
  /** Original type when `type` was normalized from a v1.19.6 alias. */
  rawType?: string;
  /** Server creation timestamp (ms) when present. */
  created?: number;
}

/**
 * v1.19.6 (user-verified) event names → v2.3.0 canonical names.
 *
 * Everything else is passed through unchanged, so a newer server keeps
 * working even if this table is incomplete.
 */
const EVENT_ALIASES: Record<string, string> = {
  "session.next.reasoning.started": "session.reasoning.started",
  "session.next.reasoning.delta": "session.reasoning.delta",
  "session.next.reasoning.ended": "session.reasoning.ended",
  "session.next.tool.input.started": "session.tool.input.started",
  "session.next.tool.input.delta": "session.tool.input.delta",
  "session.next.tool.input.ended": "session.tool.input.ended",
  "session.next.tool.called": "session.tool.called",
  "session.next.tool.progress": "session.tool.progress",
  "session.next.tool.success": "session.tool.success",
  "session.next.tool.failed": "session.tool.failed",
  "session.next.step.started": "session.step.started",
  "session.next.step.ended": "session.step.ended",
  "session.next.step.failed": "session.step.failed",
  "session.next.text.started": "session.text.started",
  "session.next.text.delta": "session.text.delta",
  "session.next.text.ended": "session.text.ended",
  "session.next.agent.switched": "session.agent.selected",
  "session.next.model.switched": "session.model.selected",
  "session.next.compaction.started": "session.compaction.started",
  "session.next.compaction.delta": "session.compaction.delta",
  "session.next.compaction.ended": "session.compaction.ended",
  "permission.v2.asked": "permission.asked",
  "permission.v2.replied": "permission.replied",
  "question.v2.asked": "form.created",
  "question.v2.replied": "form.replied",
  "question.v2.rejected": "form.cancelled",
  "session.error": "session.execution.failed",
};

/** Map a server event name to the canonical v2.3.0 name. */
export function normalizeEventType(type: string): string {
  return EVENT_ALIASES[type] ?? type;
}

/** Incremental assistant text delta. */
export interface TextDelta {
  messageID: string;
  sessionID: string;
  text: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Turn a parsed JSON payload (and optional SSE `event:` name) into a
 * BridgeEvent. Returns null for empty payloads.
 */
export function parseEventPayload(payload: unknown, sseEvent?: string): BridgeEvent | null {
  if (payload === undefined || payload === null) {
    if (!sseEvent) return null;
    return { type: sseEvent, data: null, raw: payload };
  }

  const obj = asRecord(payload);
  if (!obj) {
    // Non-JSON `data:` line (keep it visible instead of dropping it).
    return { type: sseEvent ?? "unknown", data: payload, raw: payload };
  }

  const payloadType = typeof obj.type === "string" ? obj.type : undefined;
  const rawType = payloadType ?? sseEvent ?? "unknown";
  const type = normalizeEventType(rawType);
  const data = "data" in obj ? obj.data : obj;

  let sessionID: string | undefined;
  const dataRec = asRecord(data);
  if (dataRec && typeof dataRec.sessionID === "string") {
    sessionID = dataRec.sessionID;
  }
  if (!sessionID && dataRec) {
    // form.created carries the session inside `data.form`.
    const form = asRecord(dataRec.form);
    if (form && typeof form.sessionID === "string") sessionID = form.sessionID;
  }
  if (!sessionID && dataRec) {
    // v1.19.6 question events sometimes nest under `question`.
    const question = asRecord(dataRec.question);
    if (question && typeof question.sessionID === "string") sessionID = question.sessionID;
  }
  if (!sessionID) {
    const durable = asRecord(obj.durable);
    const aggregateID = durable && typeof durable.aggregateID === "string" ? durable.aggregateID : undefined;
    if (aggregateID && aggregateID.startsWith("ses_")) sessionID = aggregateID;
  }

  const id = typeof obj.id === "string" ? obj.id : undefined;
  const created = typeof obj.created === "number" ? obj.created : undefined;
  return {
    type,
    data,
    sessionID,
    id,
    raw: payload,
    ...(rawType !== type ? { rawType } : {}),
    ...(created !== undefined ? { created } : {}),
  };
}

/**
 * Parse one SSE block (lines between blank lines). Handles `data:`,
 * `event:`, `id:` and comment lines. Multiple `data:` lines are joined
 * with newlines per the SSE spec.
 */
export function parseSseBlock(block: string): BridgeEvent | null {
  const normalized = block.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let eventName: string | undefined;
  const dataLines: string[] = [];

  for (const line of normalized.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    // `id` / `retry` are parsed from the JSON payload id; ignore here.
  }

  if (dataLines.length === 0) {
    return eventName ? { type: eventName, data: null } : null;
  }

  const text = dataLines.join("\n");
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // Keep raw text.
  }
  return parseEventPayload(payload, eventName);
}

/** Extract an incremental text delta from a `session.text.delta` event. */
export function extractTextDelta(event: BridgeEvent): TextDelta | null {
  if (event.type !== "session.text.delta") return null;
  const data = asRecord(event.data);
  if (!data) return null;

  const messageID =
    typeof data.assistantMessageID === "string"
      ? data.assistantMessageID
      : typeof data.messageID === "string"
        ? data.messageID
        : "";
  const sessionID =
    event.sessionID || (typeof data.sessionID === "string" ? data.sessionID : "");
  const text =
    typeof data.delta === "string"
      ? data.delta
      : typeof data.text === "string"
        ? data.text
        : "";

  if (!messageID || !text) return null;
  return { messageID, sessionID, text };
}

/**
 * True when an event belongs to the session the extension created itself.
 * Global events without a sessionID are allowed through (handlers ignore
 * the ones they do not care about). Events for other sessions (e.g. the
 * TUI's sessions) must be ignored.
 */
export function shouldHandleEvent(event: BridgeEvent, currentSessionID: string | undefined): boolean {
  if (!event.sessionID) return true;
  if (!currentSessionID) return false;
  return event.sessionID === currentSessionID;
}

/** Yes/no helper used by the client for retry decisions. */
export function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP\s+(401|403)\b/.test(message);
}
