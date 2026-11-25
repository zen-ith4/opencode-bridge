/**
 * Classify provider/transport failures coming from OpenCode events so the
 * UI can explain what happened in plain language instead of dumping a raw
 * stack trace.
 *
 * The wording distinguishes the provider/network from the extension itself:
 * an ECONNRESET from OpenCode's own upstream model call is *not* an
 * extension bug, and users should not be told to report one.
 */

export type FailureKind =
  | "connection"
  | "auth"
  | "rate-limit"
  | "model"
  | "extension"
  | "unknown";

export interface FailureInfo {
  kind: FailureKind;
  /** One plain sentence, suitable for a banner headline. */
  summary: string;
  /** The original provider/server message, kept for Details/logs. */
  details: string;
  /** Whether retrying later can plausibly succeed. */
  retryable: boolean;
  /** Short label used in logs. */
  label: string;
}

const CONNECTION_PATTERN =
  /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR_[A-Z_]+)\b|fetch failed|socket (?:closed|hang up|hangup)|connection (?:reset|lost|refused|closed|terminated)|network error|other side closed|unexpected end of (?:stream|response)|premature close|stream (?:closed|ended) unexpectedly/i;

const AUTH_PATTERN =
  /\bHTTP\s*(?:401|403)\b|\b(?:401|403)\b|unauthori[sz]ed|forbidden|authentication (?:required|failed)|invalid (?:api[- ]?key|token|credential)|api[- ]?key|oauth|access token|permission denied by provider/i;

const RATE_LIMIT_PATTERN =
  /\bHTTP\s*429\b|\b429\b|rate[ _-]?limit|too many requests|quota (?:exceeded|exhausted)|overloaded|capacity (?:exceeded|reached)/i;

const MODEL_PATTERN =
  /\bHTTP\s*(?:400|404|422|500|502|503|529)\b|\bmodel (?:not found|unavailable|does not|is not|failed|error)|invalid model|unknown model|context (?:length|window)|maximum context|does not support|unsupported (?:model|parameter)|bad request|provider (?:error|failed)|upstream (?:error|failed)/i;

const EXTENSION_PATTERN =
  /\b(?:TypeError|ReferenceError|RangeError)\b|cannot read propert|is not a function|is not iterable|undefined is not|null is not/i;

function textOf(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message || String(value);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    const nested = obj.data;
    if (nested && typeof nested === "object") {
      const inner = nested as Record<string, unknown>;
      if (typeof inner.message === "string") return inner.message;
    }
    if (typeof obj.name === "string") return obj.name;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** Classify a raw failure message from an OpenCode event or client call. */
export function classifyFailure(raw: unknown): FailureInfo {
  const details = textOf(raw) || "OpenCode reported an error without details.";

  if (CONNECTION_PATTERN.test(details)) {
    return {
      kind: "connection",
      label: "connection",
      summary:
        "OpenCode lost its connection to the model provider; this is not an extension error.",
      details,
      retryable: true,
    };
  }

  if (AUTH_PATTERN.test(details)) {
    return {
      kind: "auth",
      label: "authentication",
      summary: "The model provider rejected the request because authentication failed.",
      details,
      retryable: false,
    };
  }

  if (RATE_LIMIT_PATTERN.test(details)) {
    return {
      kind: "rate-limit",
      label: "rate limit",
      summary: "The model provider rate-limited the request; wait a moment and retry.",
      details,
      retryable: true,
    };
  }

  if (MODEL_PATTERN.test(details)) {
    return {
      kind: "model",
      label: "model error",
      summary: "The model provider returned an error for this request.",
      details,
      retryable: true,
    };
  }

  if (EXTENSION_PATTERN.test(details)) {
    return {
      kind: "extension",
      label: "extension error",
      summary: "OpenCode Bridge hit an internal error while handling the response.",
      details,
      retryable: true,
    };
  }

  return {
    kind: "unknown",
    label: "unknown error",
    summary: "OpenCode could not complete the request.",
    details,
    retryable: true,
  };
}

/** True when the failure came from the provider/transport, not from us. */
export function isProviderFailure(kind: FailureKind): boolean {
  return kind === "connection" || kind === "auth" || kind === "rate-limit";
}

/**
 * A user (or another client) interrupted the turn. OpenCode reports this as
 * `session.step.failed` with `{ "type": "aborted", "message": "Step interrupted" }`
 * followed by `session.execution.interrupted` (reason `user`). Those must never
 * surface as a provider error: the partial answer is kept and marked Stopped.
 */
export function isAbortLikeError(raw: unknown): boolean {
  if (raw == null) return false;
  let fields = "";
  if (typeof raw === "string") {
    fields = raw;
  } else if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["name", "message", "type", "reason", "code", "description"]) {
      if (typeof obj[key] === "string") parts.push(String(obj[key]));
    }
    try {
      parts.push(JSON.stringify(raw));
    } catch {
      parts.push(String(raw));
    }
    fields = parts.join(" ");
  } else {
    fields = String(raw);
  }
  return /\babort(?:ed|ing)?\b|abortsignal|messageabortederror|interrupted|cancell?ed|operation was aborted|user abort/i.test(
    fields
  );
}
