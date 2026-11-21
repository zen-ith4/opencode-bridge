/**
 * OpenCode Bridge - SDK wrapper around `@opencode-ai/sdk`.
 *
 * Verified against the installed package type definitions (v1 client,
 * `createOpencodeClient({ baseUrl, headers })`) and against a live
 * `opencode serve` instance.
 *
 * Important wiring notes (empirically verified):
 *  - The SDK's generated paths are relative (e.g. `/session`,
 *    `/session/{id}/message`, `/event`). The real server routes live under
 *    `/api`, so baseUrl must be `http://host:port/api`.
 *  - Responses are hey-api wrapped: `{ data, request, response }`, and the
 *    actual payload sits one level deeper (`create` -> `data.data.id`).
 *  - Basic auth: header `Authorization: Basic opencode:<password>`.
 *  - Streaming: `client.event.subscribe({ url: "/event", onSseEvent })`
 *    yields `{ id, type, data }` events (e.g. `message.part.updated` with
 *    `{ part, delta }`).
 *
 * This wrapper never calls any LLM API itself; it only talks to the local
 * OpenCode HTTP server.
 */

import { createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient, SessionPromptData } from "@opencode-ai/sdk";

/** A session known to the OpenCode server. */
export interface BridgeSession {
  id: string;
  title: string;
  directory?: string;
  createdAt?: number;
}

/** Incremental assistant text delta from the SSE stream. */
export interface StreamPart {
  messageID: string;
  sessionID: string;
  partID?: string;
  text?: string;       // accumulated text for this part so far
  delta?: string;      // newly arrived text chunk
  type?: string;
}

/** A parsed SSE event relevant to chat rendering. */
export interface BridgeEvent {
  type: string; // e.g. "message.part.updated", "message.updated", "session.created"
  data: unknown;
  sessionID?: string;
}

interface PromptOptions {
  sessionID: string;
  text: string;
  model?: { providerID: string; modelID: string };
}

/**
 * Thin wrapper. All methods are wrapped in try/catch and translate failures
 * into user-friendly Error messages.
 */
export class OpencodeBridgeClient {
  private client: OpencodeClient | null = null;
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /** Create (or reconnect) the SDK client with an optional Basic auth header. */
  connect(authHeader?: string): void {
    const headers: Record<string, string> = {};
    if (authHeader) headers.Authorization = authHeader;
    this.client = createOpencodeClient({
      baseUrl: this.baseUrl,
      headers,
    });
  }

  /** Ensure a client exists. */
  private requireClient(): OpencodeClient {
    if (!this.client) {
      throw new Error(
        "OpenCode client is not connected. Call connect() first (server must be reachable)."
      );
    }
    return this.client;
  }

  /** Unwrap hey-api's double-wrapped create-session response. */
  private unwrapSession(resp: unknown): BridgeSession | null {
    const outer = (resp as { data?: unknown })?.data;
    // hey-api wraps create as { data: { data: { id, ... } }, request, response }.
    const inner =
      outer && typeof outer === "object" && "data" in outer && typeof (outer as Record<string, unknown>).data === "object"
        ? (outer as Record<string, unknown>).data
        : outer;
    const info = inner && typeof inner === "object" && "id" in inner ? inner : null;
    if (!info) return null;
    const obj = info as Record<string, unknown>;
    return {
      id: String(obj.id ?? ""),
      title: String(obj.title ?? ""),
      directory: typeof obj.directory === "string" ? obj.directory : undefined,
      createdAt:
        typeof obj.time === "object" && obj.time &&
        typeof (obj.time as Record<string, unknown>).created === "number"
          ? ((obj.time as Record<string, unknown>).created as number)
          : undefined,
    };
  }

  /** Create a new chat session on the server. */
  async createSession(opts: {
    title?: string;
    directory?: string;
  }): Promise<BridgeSession> {
    const client = this.requireClient();
    try {
      const resp = await client.session.create({
        body: {
          title: opts.title ?? "New chat",
          ...(opts.directory ? { directory: opts.directory } : {}),
        },
      });
      const session = this.unwrapSession(resp);
      if (!session || !session.id) {
        throw new Error("Server did not return a session id.");
      }
      return session;
    } catch (err) {
      throw new Error(
        `Failed to create OpenCode session: ${errorMessage(err)}`
      );
    }
  }

  /**
   * Send a user prompt to an existing session. Non-blocking with respect to
   * the UI: this returns once the server accepts the message. The assistant's
   * streamed reply arrives via subscribeToEvents().
   */
  async prompt(opts: PromptOptions): Promise<{ messageID: string }> {
    const client = this.requireClient();
    try {
      const parts = [{ type: "text" as const, text: opts.text }];
      const body: NonNullable<SessionPromptData["body"]> = { parts };
      if (opts.model) {
        body.model = opts.model;
      }
      const resp = await client.session.prompt({
        path: { id: opts.sessionID },
        body,
      });
      // hey-api wraps as { data: { info, parts }, request, response } on success.
      const payload = (resp as { data?: { info?: { id?: string } } })?.data;
      const messageID =
        payload && payload.info && typeof payload.info === "object"
          ? String((payload.info as Record<string, unknown>).id ?? "")
          : "";
      return { messageID };
    } catch (err) {
      throw new Error(`Failed to send prompt to OpenCode: ${errorMessage(err)}`);
    }
  }

  /**
   * Subscribe to the server's SSE event stream. Calls `onEvent` for every
   * parsed event. Returns an AbortController-like object with `abort()` to
   * close the stream.
   *
   * NOTE: `client.event.subscribe` returns `{ stream: AsyncGenerator }` and
   * invokes `onSseEvent` per event. We drive the generator here so callers
   * get a clean async-iterable of BridgeEvent.
   */
  subscribeToEvents(opts: {
    onEvent: (event: BridgeEvent) => void;
    onError?: (error: unknown) => void;
  }): { abort: () => void } {
    const client = this.requireClient();
    let cancelled = false;

    const controller = new AbortController();

    // Kick off the SSE subscription in the background (fire-and-forget the
    // generator; errors surface via onSseError/onError). The SDK prepends the
    // baseUrl and sets url: "/event" internally, so we only pass callbacks.
    void client.event.subscribe({
      onSseEvent: (raw: { data: unknown; event?: string; id?: string }) => {
        if (cancelled) return;
        const event: BridgeEvent = {
          type: raw.event ?? "unknown",
          data: raw.data ?? null,
        };
        // Best-effort session id extraction for filtering by caller.
        const data = raw.data as Record<string, unknown> | null;
        if (data && typeof data.sessionID === "string") {
          event.sessionID = data.sessionID;
        } else if (
          data &&
          typeof data.properties === "object" &&
          data.properties !== null &&
          typeof (data.properties as Record<string, unknown>).sessionID === "string"
        ) {
          event.sessionID = String(
            (data.properties as Record<string, unknown>).sessionID
          );
        }
        opts.onEvent(event);
      },
      onSseError: (err: unknown) => {
        if (cancelled) return;
        opts.onError?.(err);
      },
    });

    return {
      abort: () => {
        cancelled = true;
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
        // The SDK's SSE client doesn't expose a close handle; the stream will
        // end when the underlying connection drops. We mark cancelled so no
        // further events are dispatched.
      },
    };
  }

  /** Fetch the message history for a session (used to restore a chat). */
  async getMessages(sessionID: string): Promise<Array<{ id: string; role: string; text?: string }>> {
    const client = this.requireClient();
    try {
      const resp = await client.session.messages({
        path: { id: sessionID },
      });
      const data = (resp as { data?: unknown })?.data;
      const messages: Array<{ id: string; role: string; text?: string }> = [];
      if (Array.isArray(data)) {
        for (const m of data) {
          const obj = m as Record<string, unknown>;
          const role = String(obj.role ?? "user");
          const text =
            obj.type === "user" && typeof obj.payload === "object" && obj.payload
              ? String((obj.payload as Record<string, unknown>).text ?? "")
              : typeof obj.text === "string"
                ? obj.text
                : undefined;
          messages.push({ id: String(obj.id ?? ""), role, text });
        }
      }
      return messages;
    } catch (err) {
      // History is optional; never fail the chat because of it.
      console.warn(`[opencode-bridge] failed to load messages: ${errorMessage(err)}`);
      return [];
    }
  }

  /** Extract an incremental text delta from a `message.part.updated` event. */
  static extractTextDelta(event: BridgeEvent): StreamPart | null {
    if (event.type !== "message.part.updated") return null;
    const data = event.data as Record<string, unknown> | null;
    if (!data) return null;
    const part = data.part as Record<string, unknown> | null;
    if (!part || part.type !== "text") return null;
    const messageID = String(part.messageID ?? "");
    const sessionID = event.sessionID || String(part.sessionID ?? "");
    const partID = typeof part.id === "string" ? part.id : undefined;
    const delta = typeof data.delta === "string" ? data.delta : undefined;
    const text = typeof part.text === "string" ? part.text : undefined;
    return { messageID, sessionID, partID, text, delta, type: part.type };
  }

  /** Test-only: replace the underlying SDK client (for mocking). */
  setClientForTesting(client: OpencodeClient): void {
    this.client = client;
  }
}

/** Turn an unknown error into a user-friendly string. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
