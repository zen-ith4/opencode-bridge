/**
 * OpenCode Bridge - SDK wrapper around `@opencode-ai/sdk`.
 *
 * Verified against the installed package type definitions and a live
 * `opencode serve` (v2.3.0) / its OpenAPI document:
 *  - All server routes live under `/api`, so baseUrl is
 *    `http://host:port/api`.
 *  - `createOpencodeClient({ baseUrl, headers })` is used for session
 *    creation (`client.session.create()`).
 *  - The server exposes raw routes that differ from this SDK version
 *    (`/api/session/{id}/prompt`, `/api/session/{id}/interrupt`,
 *    `/api/session/{id}/message`, `/api/event`), so those use raw `fetch`
 *    with the same auth header.
 *  - Prompt body is `{ text, model?: { id, providerID } }`.
 *  - SSE payloads look like
 *      data: {"id":"evt_...","type":"session.text.delta","data":{...}}
 *    with the type INSIDE the JSON (no SSE `event:` line). Text chunks are
 *    in `data.delta`.
 *
 * This wrapper never calls any LLM API itself.
 */

import { createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { logDebug } from "./log.js";
import {
  BridgeEvent,
  isAuthError,
  parseSseBlock,
} from "./events.js";

export type { BridgeEvent, TextDelta } from "./events.js";
export { extractTextDelta, shouldHandleEvent } from "./events.js";

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

/** A message restored from GET /api/session/{id}/message. */
export interface BridgeMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  created?: number;
}

export interface ModelRef {
  providerID: string;
  modelID: string;
}

interface PromptOptions {
  sessionID: string;
  text: string;
  model?: ModelRef;
}

/** Truncate a server response snippet for error messages. */
function snippet(text: string, max = 300): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Thin wrapper. All methods translate failures into user-friendly Error
 * messages that include the HTTP status and a short response snippet.
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

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setDebug(debug: boolean): void {
    this.debug = debug;
  }

  private debugLog(message: string): void {
    logDebug(message, this.debug);
  }

  private makeSdkClient(): OpencodeClient {
    const headers: Record<string, string> = {};
    if (this.authHeader) headers.Authorization = this.authHeader;
    return createOpencodeClient({ baseUrl: this.baseUrl, headers });
  }

  /** Create (or reconnect) the SDK client with an optional Basic auth header. */
  connect(authHeader?: string): void {
    this.authHeader = authHeader;
    this.client = this.makeSdkClient();
    this.debugLog(`SDK client connected to ${this.baseUrl}`);
  }

  /** Point the client at another base URL (used after a managed restart). */
  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
    if (this.client) this.client = this.makeSdkClient();
    this.debugLog(`Base URL updated to ${baseUrl}`);
  }

  /** Update the auth header used for subsequent requests. */
  setAuthHeader(authHeader: string | undefined): void {
    this.authHeader = authHeader;
    if (this.client) this.client = this.makeSdkClient();
    this.debugLog(`Auth header updated (${authHeader ? "set" : "cleared"})`);
  }

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
      for (const [k, v] of Object.entries(options.headers)) headers[k] = String(v);
    }
    let body = options.body;
    if (body !== undefined && typeof body === "object" && !(body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    const fetchOptions: RequestInit = { method: options.method ?? "GET", headers };
    if (body !== undefined) fetchOptions.body = body as unknown as string;

    this.debugLog(`fetch ${options.method ?? "GET"} ${path}`);
    const res = await fetch(url, fetchOptions);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${snippet(text) || res.statusText}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) return res.json();
    return await res.text();
  }

  /**
   * Retry with exponential backoff for up to maxMs. Retries only network
   * errors and 502/503. NEVER retries 401/403 (those need the user action).
   */
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
        const msg = errorMessage(err);
        if (isAuthError(err)) {
          this.debugLog(`fetchWithRetry ${path} auth failure (${msg}), not retrying`);
          throw err;
        }
        const statusMatch = /^HTTP (\d{3})/.exec(msg);
        const status = statusMatch ? Number(statusMatch[1]) : 0;
        const retryable = status === 0 || status === 502 || status === 503;
        if (!retryable) {
          this.debugLog(`fetchWithRetry ${path} non-retryable error (${msg})`);
          throw err;
        }
        lastErr = err;
        this.debugLog(`fetchWithRetry ${path} failed (${msg}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 2_000);
      }
    }
    throw lastErr ?? new Error(`Request to ${path} timed out`);
  }

  /** Unwrap session create responses (single or double wrapped). */
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
    model?: ModelRef;
  }): Promise<BridgeSession> {
    const client = this.requireClient();
    try {
      this.debugLog(`Creating session: title=${opts.title ?? "New chat"}`);
      const resp = await client.session.create({
        body: {
          title: opts.title ?? "New chat",
          ...(opts.directory ? { directory: opts.directory } : {}),
          ...(opts.model
            ? { model: { id: opts.model.modelID, providerID: opts.model.providerID } }
            : {}),
        },
      });
      const session = this.unwrapSession(resp);
      if (!session || !session.id) throw new Error("Server did not return a session id.");
      this.debugLog(`Session created: id=${session.id}`);
      return session;
    } catch (err) {
      this.debugLog(`createSession failed: ${errorMessage(err)}`);
      throw new Error(`Failed to create OpenCode session: ${errorMessage(err)}`);
    }
  }

  /**
   * Send a user prompt via `POST /api/session/{id}/prompt`.
   * Returns once the server accepts the message; the reply streams in via
   * `streamEvents()`.
   */
  async prompt(opts: PromptOptions): Promise<{ messageID: string }> {
    this.requireClient();
    try {
      this.debugLog(`Sending prompt to session ${opts.sessionID} (${opts.text.length} chars)`);
      const body: Record<string, unknown> = { text: opts.text };
      if (opts.model) body.model = { id: opts.model.modelID, providerID: opts.model.providerID };
      const resp = await this.fetchJSON(`/session/${encodeURIComponent(opts.sessionID)}/prompt`, {
        method: "POST",
        body,
      });
      const payload =
        resp && typeof resp === "object" && "data" in resp
          ? (resp as Record<string, unknown>).data
          : null;
      const messageID =
        payload && typeof payload === "object" && "id" in payload
          ? String((payload as Record<string, unknown>).id ?? "")
          : "";
      this.debugLog(`Prompt accepted: messageID=${messageID}`);
      return { messageID };
    } catch (err) {
      this.debugLog(`prompt failed: ${errorMessage(err)}`);
      throw new Error(`Failed to send prompt to OpenCode: ${errorMessage(err)}`);
    }
  }

  /** Interrupt the active execution for a session (Stop button). */
  async interrupt(sessionID: string): Promise<void> {
    this.requireClient();
    try {
      await this.fetchJSON(`/session/${encodeURIComponent(sessionID)}/interrupt`, {
        method: "POST",
        body: {},
      });
      this.debugLog(`Session ${sessionID} interrupted`);
    } catch (err) {
      this.debugLog(`interrupt failed: ${errorMessage(err)}`);
      throw new Error(`Failed to stop OpenCode: ${errorMessage(err)}`);
    }
  }

  /** List providers from /api/provider. */
  async getProviders(): Promise<BridgeProvider[]> {
    this.requireClient();
    try {
      this.debugLog("Fetching providers from /api/provider");
      const resp = await this.fetchWithRetry("/provider", { method: "GET" });
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
      throw new Error(`Failed to list providers (GET /api/provider): ${errorMessage(err)}`);
    }
  }

  /** List models from /api/model. */
  async getModels(): Promise<BridgeModel[]> {
    this.requireClient();
    try {
      this.debugLog("Fetching models from /api/model");
      const resp = await this.fetchWithRetry("/model", { method: "GET" });
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
      throw new Error(`Failed to list models (GET /api/model): ${errorMessage(err)}`);
    }
  }

  /**
   * Extract the data array from a server response, handling both:
   *  - Real server single-wrap: { location, data: [...] }
   *  - hey-api SDK double-wrap: { data: { data: [...] } }
   */
  private extractDataArray(resp: unknown): unknown[] | null {
    if (!resp || typeof resp !== "object") return null;
    const obj = resp as Record<string, unknown>;
    const data = obj.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object" && "data" in data) {
      const inner = (data as Record<string, unknown>).data;
      if (Array.isArray(inner)) return inner;
    }
    return null;
  }

  /** Get the default model from /api/model/default. */
  async getDefaultModel(): Promise<ModelRef | null> {
    this.requireClient();
    try {
      const resp = await this.fetchJSON("/model/default", { method: "GET" });
      if (resp && typeof resp === "object") {
        const obj = resp as Record<string, unknown>;
        const providerID = String(obj.providerID ?? "");
        const modelID = String(obj.id ?? obj.modelID ?? "");
        if (providerID && modelID) return { providerID, modelID };
      }
      return null;
    } catch (err) {
      this.debugLog(`getDefaultModel failed: ${errorMessage(err)}`);
      return null;
    }
  }

  /** Set the model for a session via POST /api/session/{id}/model. */
  async setSessionModel(sessionID: string, model: ModelRef): Promise<void> {
    this.requireClient();
    try {
      await this.fetchJSON(`/session/${encodeURIComponent(sessionID)}/model`, {
        method: "POST",
        body: { id: model.modelID, providerID: model.providerID },
      });
      this.debugLog(`Session model set to ${model.providerID}/${model.modelID}`);
    } catch (err) {
      throw new Error(`Failed to set session model: ${errorMessage(err)}`);
    }
  }

  /**
   * Fetch the message history for a session
   * (`GET /api/session/{id}/message?order=asc`).
   */
  async getMessages(sessionID: string): Promise<BridgeMessage[]> {
    this.requireClient();
    try {
      this.debugLog(`Fetching message history for session ${sessionID}`);
      const resp = await this.fetchJSON(
        `/session/${encodeURIComponent(sessionID)}/message?order=asc`,
        { method: "GET" }
      );
      const arr = this.extractDataArray(resp);
      const messages: BridgeMessage[] = [];
      if (!Array.isArray(arr)) return messages;

      for (const item of arr) {
        const obj = item as Record<string, unknown>;
        const type = String(obj.type ?? "");
        const created =
          obj.time && typeof obj.time === "object"
            ? Number((obj.time as Record<string, unknown>).created ?? 0) || undefined
            : undefined;

        if (type === "user") {
          messages.push({ id: String(obj.id ?? ""), role: "user", text: String(obj.text ?? ""), created });
          continue;
        }

        if (type === "assistant") {
          const parts = Array.isArray(obj.content) ? obj.content : [];
          const texts: string[] = [];
          for (const part of parts) {
            const p = part as Record<string, unknown>;
            if (p.type === "text" && typeof p.text === "string" && p.text) texts.push(p.text);
          }
          if (texts.length > 0) {
            messages.push({
              id: String(obj.id ?? ""),
              role: "assistant",
              text: texts.join("\n\n"),
              created,
            });
          }
        }
      }
      this.debugLog(`Loaded ${messages.length} messages`);
      return messages;
    } catch (err) {
      this.debugLog(`getMessages failed: ${errorMessage(err)}`);
      throw new Error(`Failed to load message history: ${errorMessage(err)}`);
    }
  }

  /**
   * Open ONE SSE connection to `/api/event` and dispatch parsed events until
   * the stream ends or the signal aborts. Reconnection is the caller's job
   * (see ChatController), which keeps exactly one subscription alive.
   *
   * Returns when the stream ends. Throws on HTTP/network errors (AbortError
   * when aborted by the caller).
   */
  async streamEvents(opts: {
    signal: AbortSignal;
    onEvent: (event: BridgeEvent) => void;
  }): Promise<void> {
    this.requireClient();
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (this.authHeader) headers.Authorization = this.authHeader;

    this.debugLog("Opening SSE /api/event");
    const res = await fetch(`${this.baseUrl}/event`, {
      method: "GET",
      headers,
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`SSE HTTP ${res.status}: ${snippet(text) || res.statusText}`);
    }
    if (!res.body) throw new Error("SSE response has no body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseSseBlock(block);
          if (event) opts.onEvent(event);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
      this.debugLog("SSE /api/event closed");
    }
  }

  /** Test-only: replace the underlying SDK client (for mocking). */
  setClientForTesting(client: OpencodeClient): void {
    this.client = client;
  }
}
