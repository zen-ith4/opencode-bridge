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
  /** e.g. "session.text.delta", "session.execution.succeeded". */
  type: string;
  /** The event's `data` object (payload.data), or the whole payload if absent. */
  data: unknown;
  /** Session this event belongs to, when the payload exposes one. */
  sessionID?: string;
  /** Server event id, used for de-duplication across reconnects. */
  id?: string;
  /** Raw parsed payload (for diagnostics). */
  raw?: unknown;
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
  const type = payloadType ?? sseEvent ?? "unknown";
  const data = "data" in obj ? obj.data : obj;

  let sessionID: string | undefined;
  const dataRec = asRecord(data);
  if (dataRec && typeof dataRec.sessionID === "string") {
    sessionID = dataRec.sessionID;
  }
  if (!sessionID) {
    const durable = asRecord(obj.durable);
    const aggregateID = durable && typeof durable.aggregateID === "string" ? durable.aggregateID : undefined;
    if (aggregateID && aggregateID.startsWith("ses_")) sessionID = aggregateID;
  }

  const id = typeof obj.id === "string" ? obj.id : undefined;
  return { type, data, sessionID, id, raw: payload };
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
