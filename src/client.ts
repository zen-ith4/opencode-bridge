/**
 * OpenCode Bridge - SDK wrapper around `@opencode-ai/sdk`.
 *
 * Verified against the installed package type definitions (v1 client,
 * `createOpencodeClient({ baseUrl, headers })`) and against a live
 * `opencode serve` instance (v2.3.0).
 *
 * Important wiring notes (empirically verified against the OpenAPI spec):
 *  - All server routes live under `/api`, so baseUrl must be
 *    `http://host:port/api`.
 *  - `createOpencodeClient({ baseUrl, headers })` from `@opencode-ai/sdk` is
 *    used as required. Its `session.create()` and `event.subscribe()` work
 *    through the SDK.
 *  - The SDK's `session.prompt()` targets `POST /session/{id}/message`, but
 *    the server exposes `POST /api/session/{sessionID}/prompt`. For prompt,
 *    providers, models, and session model we use raw `fetch` with the
 *    auth header, since the SDK's generated paths don't match this server
 *    version.
 *  - Prompt request body is `{ text, model? }` (NOT `{ parts: [] }`).
 *  - SSE: `client.event.subscribe({ onSseEvent })` → `/api/event`, yields
 *    `{ id, type, data }` events: session.text.started / delta / ended,
 *    session.execution.started / succeeded / failed, session.created.
 *
 * This wrapper never calls any LLM API itself; it only talks to the local
 * OpenCode HTTP server.
 */

import { createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { logDebug } from "./server.js";

/** A session known to the OpenCode server. */
export interface BridgeSession {
  id: string;
  title: string;
  directory?: string;
  model?: { providerID: string; modelID: string } | null;
}

/** A provider returned by /api/provider. */
export interface BridgeProvider {
  id: string;
  name: string;
  activation: string;
}

/** A model returned by /api/model. */
export interface BridgeModel {
  id: string;
  modelID: string;
  providerID: string;
  type: string;
  name: string;
}

/** Incremental assistant text delta from the SSE stream. */
export interface StreamPart {
  messageID: string;
  sessionID: string;
  text: string; // newly arrived text chunk
}

/** A parsed SSE event relevant to chat rendering. */
export interface BridgeEvent {
  type: string; // e.g. "session.text.delta", "session.execution.succeeded"
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
  private authHeader: string | undefined;
  private debug = false;

  constructor(baseUrl: string, debug = false) {
    this.baseUrl = baseUrl;
    this.debug = debug;
  }

  /** Enable/disable debug logging. */
  setDebug(debug: boolean): void {
    this.debug = debug;
  }

  private debugLog(message: string): void {
    logDebug(message, this.debug);
  }

  /** Create (or reconnect) the SDK client with an optional Basic auth header. */
  connect(authHeader?: string): void {
    this.authHeader = authHeader;
    const headers: Record<string, string> = {};
    if (authHeader) headers.Authorization = authHeader;
    this.client = createOpencodeClient({
      baseUrl: this.baseUrl,
      headers,
    });
    this.debugLog(`SDK client connected to ${this.baseUrl}`);
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

  /** Raw fetch to the OpenCode server, with auth header and JSON handling. */
  private async fetchJSON(
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
  ): Promise<any> {
    const url = this.baseUrl + path; // baseUrl already includes /api
    const headers: Record<string, string> = {};
    if (this.authHeader) headers.Authorization = this.authHeader;
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        headers[k] = String(v);
      }
    }
    let body = options.body;
    if (body !== undefined && typeof body === "object" && !(body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    const fetchOptions: RequestInit = {
      method: options.method ?? "GET",
      headers,
    };
    if (body !== undefined) fetchOptions.body = body as unknown as string;

    this.debugLog(`fetch ${options.method ?? "GET"} ${path}`);
    const res = await fetch(url, fetchOptions);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return res.json();
    }
    return await res.text();
  }

  /** Fetch with exponential backoff retry. Retries for up to maxMs total. */
  private async fetchWithRetry(
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
    maxMs = 10_000
  ): Promise<any> {
    const deadline = Date.now() + maxMs;
    let lastErr: unknown = null;
    let delay = 500;
    while (Date.now() < deadline) {
      try {
        return await this.fetchJSON(path, options);
      } catch (err) {
        lastErr = err;
        this.debugLog(`fetchWithRetry ${path} failed (${errorMessage(err)}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 2000);
      }
    }
    throw lastErr;
  }

  /** Unwrap hey-api's double-wrapped create-session response. */
  private unwrapSession(resp: unknown): BridgeSession | null {
    const outer = (resp as { data?: unknown })?.data;
    const inner =
      outer && typeof outer === "object" && "data" in outer
        ? (outer as Record<string, unknown>).data
        : outer;
    const info = inner && typeof inner === "object" && "id" in inner ? inner : null;
    if (!info) return null;
    const obj = info as Record<string, unknown>;
    const model = obj.model
      ? {
          providerID: String((obj.model as Record<string, unknown>).providerID ?? ""),
          modelID: String((obj.model as Record<string, unknown>).id ?? ""),
        }
      : null;
    return {
      id: String(obj.id ?? ""),
      title: String(obj.title ?? ""),
      directory: typeof obj.directory === "string" ? obj.directory : undefined,
      model,
    };
  }

  /** Create a new chat session on the server. */
  async createSession(opts: {
    title?: string;
    directory?: string;
    model?: { providerID: string; modelID: string };
  }): Promise<BridgeSession> {
    const client = this.requireClient();
    try {
      this.debugLog(`Creating session: title=${opts.title ?? "New chat"} directory=${opts.directory ?? "-"}`);
      const resp = await client.session.create({
        body: {
          title: opts.title ?? "New chat",
          ...(opts.directory ? { directory: opts.directory } : {}),
          ...(opts.model ? { model: { id: opts.model.modelID, providerID: opts.model.providerID } } : {}),
        },
      });
      const session = this.unwrapSession(resp);
      if (!session || !session.id) {
        throw new Error("Server did not return a session id.");
      }
      this.debugLog(`Session created: id=${session.id}`);
      return session;
    } catch (err) {
      this.debugLog(`createSession failed: ${errorMessage(err)}`);
      throw new Error(`Failed to create OpenCode session: ${errorMessage(err)}`);
    }
  }

  /**
   * Send a user prompt to an existing session. Uses the server's
   * `POST /api/session/{id}/prompt` endpoint with body `{ text, model? }`.
   * Non-blocking with respect to the UI: returns once the server accepts
   * the message. The assistant's streamed reply arrives via
   * subscribeToEvents().
   */
  async prompt(opts: PromptOptions): Promise<{ messageID: string }> {
    this.requireClient(); // ensure connected
    try {
      this.debugLog(`Sending prompt to session ${opts.sessionID}: ${opts.text.slice(0, 80)}...`);
      const body: Record<string, unknown> = { text: opts.text };
      if (opts.model) {
        // The server's Model.Ref schema uses { id, providerID } for model
        // references in prompt/session bodies.
        body.model = { id: opts.model.modelID, providerID: opts.model.providerID };
      }
      const resp = await this.fetchJSON(`/session/${encodeURIComponent(opts.sessionID)}/prompt`, {
        method: "POST",
        body,
      });
      // Response: { data: { id, sessionID, type, payload, delivery }, ... }
      const payload = resp && typeof resp === "object" && "data" in resp ? (resp as Record<string, unknown>).data : null;
      const messageID = payload && typeof payload === "object" && "id" in payload
        ? String((payload as Record<string, unknown>).id ?? "")
        : "";
      this.debugLog(`Prompt accepted: messageID=${messageID}`);
      return { messageID };
    } catch (err) {
      this.debugLog(`prompt failed: ${errorMessage(err)}`);
      throw new Error(`Failed to send prompt to OpenCode: ${errorMessage(err)}`);
    }
  }

  /** List providers from /api/provider. */
  async getProviders(): Promise<BridgeProvider[]> {
    this.requireClient();
    try {
      this.debugLog("Fetching providers from /api/provider");
      const resp = await this.fetchWithRetry("/provider", { method: "GET" });
      // Real server response (single-wrapped): { location, data: [...] }
      // hey-api SDK-wrapped responses (double-wrapped): { data: { data: [...] }, ... }
      const arr = this.extractDataArray(resp);
      const providers: BridgeProvider[] = [];
      if (Array.isArray(arr)) {
        for (const p of arr) {
          const obj = p as Record<string, unknown>;
          providers.push({
            id: String(obj.id ?? ""),
            name: String(obj.name ?? obj.id ?? ""),
            activation: String(obj.activation ?? "unknown"),
          });
        }
      }
      this.debugLog(`Found ${providers.length} providers`);
      return providers;
    } catch (err) {
      const msg = errorMessage(err);
      this.debugLog(`getProviders failed: ${msg}`);
      throw new Error(`Failed to list providers (GET /api/provider): ${msg}`);
    }
  }

  /** List models from /api/model. */
  async getModels(): Promise<BridgeModel[]> {
    this.requireClient();
    try {
      this.debugLog("Fetching models from /api/model");
      const resp = await this.fetchWithRetry("/model", { method: "GET" });
      // Real server response (single-wrapped): { location, data: [...] }
      // hey-api SDK-wrapped responses (double-wrapped): { data: { data: [...] }, ... }
      const arr = this.extractDataArray(resp);
      const models: BridgeModel[] = [];
      if (Array.isArray(arr)) {
        for (const m of arr) {
          const obj = m as Record<string, unknown>;
          models.push({
            id: String(obj.id ?? ""),
            modelID: String(obj.modelID ?? obj.id ?? ""),
            providerID: String(obj.providerID ?? ""),
            type: String(obj.type ?? "chat"),
            name: String(obj.name ?? obj.modelID ?? obj.id ?? ""),
          });
        }
      }
      this.debugLog(`Found ${models.length} models`);
      return models;
    } catch (err) {
      const msg = errorMessage(err);
      this.debugLog(`getModels failed: ${msg}`);
      throw new Error(`Failed to list models (GET /api/model): ${msg}`);
    }
  }

  /**
   * Extract the data array from a server response, handling both:
   *  - Real server single-wrap: { location, data: [...] }
   *  - hey-api SDK double-wrap: { data: { data: [...] }, request, response }
   */
  private extractDataArray(resp: unknown): unknown[] | null {
    if (!resp || typeof resp !== "object") return null;
    const obj = resp as Record<string, unknown>;
    const data = obj.data;
    if (Array.isArray(data)) return data;
    // hey-api double-wrap: { data: { data: [...] } }
    if (data && typeof data === "object" && "data" in data && Array.isArray((data as Record<string, unknown>).data)) {
      return (data as Record<string, unknown>).data as unknown[];
    }
    return null;
  }

  /** Get the default model from /api/model/default. */
  async getDefaultModel(): Promise<{ providerID: string; modelID: string } | null> {
    this.requireClient();
    try {
      this.debugLog("Fetching default model from /api/model/default");
      const resp = await this.fetchJSON("/model/default", { method: "GET" });
      if (resp && typeof resp === "object") {
        const obj = resp as Record<string, unknown>;
        const providerID = String(obj.providerID ?? "");
        const modelID = String(obj.id ?? obj.modelID ?? "");
        if (providerID && modelID) {
          this.debugLog(`Default model: ${providerID}/${modelID}`);
          return { providerID, modelID };
        }
      }
      this.debugLog("No default model found");
      return null;
    } catch (err) {
      this.debugLog(`getDefaultModel failed: ${errorMessage(err)}`);
      return null;
    }
  }

  /** Set the model for a session via POST /api/session/{id}/model. */
  async setSessionModel(sessionID: string, model: { providerID: string; modelID: string }): Promise<void> {
    this.requireClient();
    try {
      this.debugLog(`Setting session ${sessionID} model to ${model.providerID}/${model.modelID}`);
      await this.fetchJSON(`/session/${encodeURIComponent(sessionID)}/model`, {
        method: "POST",
        body: { id: model.modelID, providerID: model.providerID },
      });
      this.debugLog(`Session model set`);
    } catch (err) {
      this.debugLog(`setSessionModel failed: ${errorMessage(err)}`);
      throw new Error(`Failed to set session model: ${errorMessage(err)}`);
    }
  }

  /**
   * Subscribe to the server's SSE event stream via the SDK's
   * `client.event.subscribe()`. Calls `onEvent` for every parsed event.
   * Returns an object with `abort()` to stop dispatching.
   */
  subscribeToEvents(opts: {
    onEvent: (event: BridgeEvent) => void;
    onError?: (error: unknown) => void;
  }): { abort: () => void } {
    const client = this.requireClient();
    let cancelled = false;

    this.debugLog("Subscribing to SSE /api/event");

    void client.event.subscribe({
      onSseEvent: (raw: { data: unknown; event?: string; id?: string }) => {
        if (cancelled) return;
        const event: BridgeEvent = {
          type: raw.event ?? "unknown",
          data: raw.data ?? null,
        };
        const data = raw.data as Record<string, unknown> | null;
        if (data && typeof data.sessionID === "string") {
          event.sessionID = data.sessionID;
        }
        this.debugLog(`SSE event: ${event.type}`);
        opts.onEvent(event);
      },
      onSseError: (err: unknown) => {
        if (cancelled) return;
        this.debugLog(`SSE error: ${errorMessage(err)}`);
        opts.onError?.(err);
      },
    });

    return {
      abort: () => {
        cancelled = true;
        this.debugLog("SSE subscription aborted");
      },
    };
  }

  /** Fetch the message history for a session (used to restore a chat). */
  async getMessages(sessionID: string): Promise<Array<{ id: string; role: string; text?: string }>> {
    this.requireClient();
    try {
      this.debugLog(`Fetching message history for session ${sessionID}`);
      const cli = this.requireClient();
      const resp = await cli.session.messages({
        path: { id: sessionID },
      });
      const data = (resp as { data?: unknown })?.data;
      const messages: Array<{ id: string; role: string; text?: string }> = [];
      if (data && typeof data === "object" && "data" in data) {
        const arr = (data as Record<string, unknown>).data as unknown[];
        if (Array.isArray(arr)) {
          for (const m of arr) {
            const obj = m as Record<string, unknown>;
            const type = String(obj.type ?? "user");
            let role = "user";
            let text: string | undefined;
            if (type === "user") {
              role = "user";
              text = obj.text ? String(obj.text) : undefined;
            } else if (type.startsWith("assistant")) {
              role = "assistant";
              const parts = obj.parts as unknown[] | undefined;
              if (Array.isArray(parts)) {
                for (const part of parts) {
                  const p = part as Record<string, unknown>;
                  if (p.type === "text" && typeof p.text === "string") {
                    text = p.text;
                    break;
                  }
                }
              }
            }
            messages.push({ id: String(obj.id ?? ""), role, text });
          }
        }
      }
      this.debugLog(`Loaded ${messages.length} messages`);
      return messages;
    } catch (err) {
      this.debugLog(`getMessages failed: ${errorMessage(err)}`);
      console.warn(`[opencode-bridge] failed to load messages: ${errorMessage(err)}`);
      return [];
    }
  }

  /** Extract an incremental text delta from a `session.text.delta` event. */
  static extractTextDelta(event: BridgeEvent): StreamPart | null {
    if (event.type !== "session.text.delta") return null;
    const data = event.data as Record<string, unknown> | null;
    if (!data) return null;
    const assistantMessageID =
      typeof data.assistantMessageID === "string"
        ? data.assistantMessageID
        : typeof data.messageID === "string"
          ? data.messageID
          : "";
    const sessionID = event.sessionID || (typeof data.sessionID === "string" ? data.sessionID : "");
    const text = typeof data.text === "string" ? data.text : "";
    if (!assistantMessageID || !text) return null;
    return { messageID: assistantMessageID, sessionID, text };
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
