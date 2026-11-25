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
  model?: ModelRef | null;
  agent?: string;
  updated?: number;
  created?: number;
}

/** A provider returned by /api/provider. */
export interface BridgeProvider {
  id: string;
  name: string;
  activation: string;
}

/** One reasoning-effort / thinking variant of a model (`Model.Variant`). */
export interface ModelVariant {
  id: string;
  settings?: Record<string, unknown>;
}

export interface ModelCost {
  input: number;
  output: number;
  cache?: { read: number; write: number };
}

/** A model returned by /api/model (verified v2.3.0 `Model.Info`). */
export interface BridgeModel {
  id: string;
  modelID: string;
  providerID: string;
  type: string;
  name: string;
  /** Context/output limits. */
  limit?: { context: number; input?: number; output: number };
  /** Reasoning variants (empty or absent when the model has none). */
  variants?: ModelVariant[];
  /** Cost per million tokens. */
  cost?: ModelCost[];
}

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface ToolContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** A tool call restored from history (`Session.Message.Assistant.Tool`). */
export interface MessageToolPart {
  type: "tool";
  id: string;
  name: string;
  status: "streaming" | "running" | "completed" | "error";
  input: Record<string, unknown> | string;
  content?: ToolContent[];
  metadata?: Record<string, unknown>;
  error?: string;
  executed?: boolean;
  created?: number;
  completed?: number;
}

export interface MessageReasoningPart {
  type: "reasoning";
  text: string;
  created?: number;
  completed?: number;
}

export interface MessageTextPart {
  type: "text";
  text: string;
}

export type MessagePart = MessageTextPart | MessageReasoningPart | MessageToolPart;

/**
 * A user attachment as shown in the composer/history. The extension host owns
 * reading metadata; the webview only ever sees this descriptor.
 */
export interface BridgeAttachment {
  /** Absolute `file://` URI understood by the server. */
  uri: string;
  name: string;
  /** `file` for a workspace/desktop file, `folder` for a directory. */
  kind?: "file" | "folder" | "selection" | "current";
  mime?: string;
  size?: number;
  /** Human-readable line range, e.g. `12-20` (collected from the editor). */
  lines?: string;
}

/** `PromptInput.FileAttachment` (uri + optional inline/uri source). */
export interface PromptFileInput {
  uri: string;
  name?: string;
  description?: string;
  source?: { type: "inline" } | { type: "uri"; uri: string };
}

/** A user or assistant message restored from GET /api/session/{id}/message. */
export interface BridgeMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  created?: number;
  /** Structured assistant content (text/reasoning/tool); text-only for users. */
  parts?: MessagePart[];
  agent?: string;
  model?: ModelRef;
  /** Files the assistant changed (assistant messages only). */
  files?: string[];
  /** Attachments the user sent with this message. */
  attachments?: BridgeAttachment[];
  cost?: number;
  tokens?: TokenUsage;
}

export interface ModelRef {
  providerID: string;
  modelID: string;
  variant?: string;
}

export interface BridgeAgent {
  id: string;
  name: string;
  description?: string;
  mode: "primary" | "subagent" | "all" | string;
  hidden: boolean;
  model?: ModelRef;
}

export interface BridgeCommand {
  name: string;
  description?: string;
  template?: string;
  agent?: string;
  model?: ModelRef;
  subtask?: boolean;
}

export interface BridgeSkill {
  id: string;
  name: string;
  description?: string;
  path: string;
}

export interface BridgeSessionSummary {
  id: string;
  title: string;
  directory?: string;
  updated?: number;
  created?: number;
  agent?: string;
  model?: ModelRef;
  busy?: boolean;
}

export interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: Record<string, unknown>;
  message?: string;
}

export type PermissionDecision = "once" | "always" | "reject";

export interface FormOption {
  value: string;
  label: string;
  description?: string;
}

export interface FormField {
  key: string;
  title?: string;
  description?: string;
  type: string;
  required?: boolean;
  hidden?: boolean;
  placeholder?: string;
  default?: unknown;
  options?: FormOption[];
  custom?: boolean;
  when?: Array<{ key: string; op: "eq" | "neq"; value: unknown }>;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
}

/** A pending form (the v2.3.0 replacement for `question.v2.asked`). */
export interface FormInfo {
  id: string;
  sessionID: string;
  title: string;
  fields: FormField[];
  metadata?: Record<string, unknown>;
}

export interface FileDiffInfo {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified" | string;
}

interface PromptOptions {
  sessionID: string;
  text: string;
  model?: ModelRef;
  files?: PromptFileInput[];
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

/** Tokens for one step (`TokenUsage.Info`). */
export function parseTokens(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const cache = (obj.cache && typeof obj.cache === "object" ? obj.cache : {}) as Record<
    string,
    unknown
  >;
  return {
    input: Number(obj.input ?? 0) || 0,
    output: Number(obj.output ?? 0) || 0,
    reasoning: Number(obj.reasoning ?? 0) || 0,
    cache: { read: Number(cache.read ?? 0) || 0, write: Number(cache.write ?? 0) || 0 },
  };
}

const FILE_TOOL_INPUT_KEYS = ["path", "filePath", "file_path", "filename", "target"];

/**
 * File paths touched by a tool call. `session.tool.success` in v2.3.0 does
 * NOT reliably include `outputPaths`; for write/edit tools the absolute or
 * workspace-relative path is in `input.path`. Both are supported.
 */
export function toolFilePaths(tool: {
  name: string;
  input: Record<string, unknown> | string;
  metadata?: Record<string, unknown>;
}): string[] {
  const paths = new Set<string>();
  if (typeof tool.input === "object" && tool.input) {
    for (const key of FILE_TOOL_INPUT_KEYS) {
      const value = tool.input[key];
      if (typeof value === "string" && value.trim()) paths.add(value.trim());
    }
  }
  const metadata = tool.metadata;
  if (metadata) {
    if (Array.isArray(metadata.outputPaths)) {
      for (const p of metadata.outputPaths) if (typeof p === "string" && p) paths.add(p);
    }
    if (Array.isArray(metadata.files)) {
      for (const p of metadata.files) if (typeof p === "string" && p) paths.add(p);
    }
  }
  return [...paths];
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
  ): Promise<unknown> {
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
  ): Promise<unknown> {
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

  /** Build the `Model.Ref` body shape verified in the v2.3.0 spec. */
  private modelBody(model: ModelRef): Record<string, unknown> {
    return {
      id: model.modelID,
      providerID: model.providerID,
      ...(model.variant ? { variant: model.variant } : {}),
    };
  }

  /** Create a new chat session on the server (`POST /api/session`). */
  async createSession(opts: {
    title?: string;
    directory?: string;
    model?: ModelRef;
    agent?: string;
  }): Promise<BridgeSession> {
    this.requireClient();
    try {
      this.debugLog(
        `Creating session: title=${opts.title ?? "New chat"} agent=${opts.agent ?? "default"}`
      );
      const resp = await this.fetchJSON("/session", {
        method: "POST",
        body: {
          title: opts.title ?? "New chat",
          ...(opts.directory ? { location: { directory: opts.directory } } : {}),
          ...(opts.agent ? { agent: opts.agent } : {}),
          ...(opts.model ? { model: this.modelBody(opts.model) } : {}),
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
      // v2.3.0 prompt body is { text, files?, agents?, skills?, metadata?,
      // delivery?, resume? } — model/variant are NOT accepted here. The
      // controller switches the session model first (POST /session/{id}/model).
      this.debugLog(`Sending prompt to session ${opts.sessionID} (${opts.text.length} chars)`);
      const body: Record<string, unknown> = { text: opts.text };
      if (opts.files && opts.files.length > 0) body.files = opts.files;
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

  /**
   * Same server, but outside the `/api` prefix. The legacy (v1) and
   * experimental routes (`/session/{id}/abort`,
   * `/experimental/session/{id}/background`) live at the server root.
   */
  private rootUrl(): string {
    return this.baseUrl.replace(/\/api\/?$/, "");
  }

  private async fetchRootJSON(
    path: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (this.authHeader) headers.Authorization = this.authHeader;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    this.debugLog(`fetch ${options.method ?? "GET"} (root) ${path}`);
    const res = await fetch(this.rootUrl() + path, {
      method: options.method ?? "GET",
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${snippet(text) || res.statusText}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) return res.json();
    return await res.text();
  }

  /**
   * Interrupt the active execution for a session (Stop button). This also
   * kills a shell command that the current turn is waiting on. When the v2
   * `/api/session/{id}/interrupt` route is rejected (older or newer servers
   * differ), fall back to the legacy `/session/{id}/abort` route before
   * giving up, so a failed stop is never silently swallowed.
   */
  async interrupt(sessionID: string): Promise<void> {
    this.requireClient();
    const id = encodeURIComponent(sessionID);
    try {
      await this.fetchJSON(`/session/${id}/interrupt`, { method: "POST", body: {} });
      this.debugLog(`Session ${sessionID} interrupted`);
      return;
    } catch (err) {
      this.debugLog(`interrupt failed (${errorMessage(err)}); trying legacy abort`);
      if (isAuthError(err)) {
        throw new Error(`Failed to stop OpenCode: ${errorMessage(err)}`);
      }
      try {
        await this.fetchRootJSON(`/session/${id}/abort`, { method: "POST" });
        this.debugLog(`Session ${sessionID} aborted via legacy route`);
        return;
      } catch (fallbackErr) {
        this.debugLog(`legacy abort failed: ${errorMessage(fallbackErr)}`);
        throw new Error(
          `Failed to stop OpenCode: ${errorMessage(err)} (fallback: ${errorMessage(fallbackErr)})`
        );
      }
    }
  }

  /**
   * Ask the server to detach blocking work and keep it running in the
   * background (`POST /experimental/session/{id}/background`). The server
   * documents this as detaching synchronous subagents; it answers `true`
   * when something was detached and `false` when there was nothing to move.
   */
  async backgroundSession(sessionID: string): Promise<boolean> {
    this.requireClient();
    try {
      const result = await this.fetchRootJSON(
        `/experimental/session/${encodeURIComponent(sessionID)}/background`,
        { method: "POST" }
      );
      this.debugLog(`Session ${sessionID} background -> ${JSON.stringify(result)}`);
      if (typeof result === "boolean") return result;
      if (result && typeof result === "object" && "data" in result) {
        return (result as Record<string, unknown>).data === true;
      }
      return String(result).trim() === "true";
    } catch (err) {
      this.debugLog(`background failed: ${errorMessage(err)}`);
      throw new Error(`Failed to move work to the background: ${errorMessage(err)}`);
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
          const limit = obj.limit as Record<string, unknown> | undefined;
          const modelsCost = Array.isArray(obj.cost) ? (obj.cost as ModelCost[]) : undefined;
          const variants = Array.isArray(obj.variants)
            ? obj.variants
                .map((v) =>
                  typeof v === "string"
                    ? { id: v }
                    : v && typeof v === "object" && typeof (v as Record<string, unknown>).id === "string"
                      ? {
                          id: String((v as Record<string, unknown>).id),
                          settings:
                            (v as Record<string, unknown>).settings &&
                            typeof (v as Record<string, unknown>).settings === "object"
                              ? ((v as Record<string, unknown>).settings as Record<string, unknown>)
                              : undefined,
                        }
                      : null
                )
                .filter((v): v is { id: string; settings?: Record<string, unknown> } => v !== null)
            : undefined;
          models.push({
            id: String(obj.id ?? ""),
            modelID: String(obj.modelID ?? obj.id ?? ""),
            providerID: String(obj.providerID ?? ""),
            type: String(obj.type ?? "chat"),
            name: String(obj.name ?? obj.modelID ?? obj.id ?? ""),
            ...(limit
              ? {
                  limit: {
                    context: Number(limit.context ?? 0),
                    ...(typeof limit.input === "number" ? { input: Number(limit.input) } : {}),
                    output: Number(limit.output ?? 0),
                  },
                }
              : {}),
            ...(variants ? { variants } : {}),
            ...(modelsCost ? { cost: modelsCost } : {}),
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
        body: { model: this.modelBody(model) },
      });
      this.debugLog(
        `Session model set to ${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}`
      );
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
          const payload =
            obj.payload && typeof obj.payload === "object"
              ? (obj.payload as Record<string, unknown>)
              : obj;
          const attachments: BridgeAttachment[] = [];
          const rawFiles = Array.isArray(payload.files) ? payload.files : [];
          for (const raw of rawFiles) {
            const file = raw as Record<string, unknown>;
            const source =
              file.source && typeof file.source === "object"
                ? (file.source as Record<string, unknown>)
                : {};
            const uri = typeof source.uri === "string" ? source.uri : "";
            const name =
              typeof file.name === "string" && file.name
                ? file.name
                : uri.split("/").pop() || "attachment";
            if (!uri && !name) continue;
            attachments.push({
              uri,
              name,
              ...(typeof file.mime === "string" ? { mime: file.mime } : {}),
            });
          }
          messages.push({
            id: String(obj.id ?? ""),
            role: "user",
            text: String(obj.text ?? payload.text ?? ""),
            created,
            ...(attachments.length > 0 ? { attachments } : {}),
          });
          continue;
        }

        if (type === "assistant") {
          const rawParts = Array.isArray(obj.content) ? obj.content : [];
          const parts: MessagePart[] = [];
          const texts: string[] = [];
          const files = new Set<string>();
          for (const part of rawParts) {
            const p = part as Record<string, unknown>;
            if (p.type === "text" && typeof p.text === "string") {
              if (p.text) {
                texts.push(p.text);
                parts.push({ type: "text", text: p.text });
              }
              continue;
            }
            if (p.type === "reasoning" && typeof p.text === "string") {
              const time = p.time as Record<string, unknown> | undefined;
              parts.push({
                type: "reasoning",
                text: p.text,
                created: time ? Number(time.created ?? 0) || undefined : undefined,
                completed: time ? Number(time.completed ?? 0) || undefined : undefined,
              });
              continue;
            }
            if (p.type === "tool") {
              const state = (p.state && typeof p.state === "object" ? p.state : {}) as Record<string, unknown>;
              const status = String(state.status ?? "completed");
              const content = Array.isArray(state.content)
                ? (state.content as Array<Record<string, unknown>>).map((c) => ({
                    ...c,
                    type: String(c.type ?? "text"),
                    text: typeof c.text === "string" ? c.text : undefined,
                  }))
                : undefined;
              const errorObj = state.error as Record<string, unknown> | undefined;
              const error =
                errorObj && typeof errorObj.message === "string" ? errorObj.message : undefined;
              const time = p.time as Record<string, unknown> | undefined;
              const input =
                state.input && typeof state.input === "object"
                  ? (state.input as Record<string, unknown>)
                  : typeof state.input === "string"
                    ? state.input
                    : {};
              const tool: MessageToolPart = {
                type: "tool",
                id: String(p.id ?? ""),
                name: String(p.name ?? ""),
                status: (["streaming", "running", "completed", "error"].includes(status)
                  ? status
                  : "completed") as MessageToolPart["status"],
                input,
                ...(content ? { content } : {}),
                ...(state.metadata && typeof state.metadata === "object"
                  ? { metadata: state.metadata as Record<string, unknown> }
                  : {}),
                ...(error ? { error } : {}),
                ...(p.executed === true ? { executed: true } : {}),
                created: time ? Number(time.created ?? 0) || undefined : undefined,
                completed: time ? Number(time.completed ?? 0) || undefined : undefined,
              };
              parts.push(tool);
              for (const f of toolFilePaths(tool)) files.add(f);
              continue;
            }
          }
          const snapshot = obj.snapshot as Record<string, unknown> | undefined;
          if (snapshot && Array.isArray(snapshot.files)) {
            for (const f of snapshot.files) if (typeof f === "string") files.add(f);
          }
          const modelObj = obj.model as Record<string, unknown> | undefined;
          const model =
            modelObj && typeof modelObj.providerID === "string"
              ? {
                  providerID: String(modelObj.providerID),
                  modelID: String(modelObj.id ?? ""),
                  ...(typeof modelObj.variant === "string" ? { variant: modelObj.variant } : {}),
                }
              : undefined;
          if (parts.length > 0) {
            messages.push({
              id: String(obj.id ?? ""),
              role: "assistant",
              text: texts.join("\n\n"),
              created,
              parts,
              ...(typeof obj.agent === "string" ? { agent: obj.agent } : {}),
              ...(model ? { model } : {}),
              ...(files.size > 0 ? { files: [...files] } : {}),
              ...(typeof obj.cost === "number" ? { cost: obj.cost } : {}),
              ...(obj.tokens && typeof obj.tokens === "object"
                ? { tokens: parseTokens(obj.tokens) }
                : {}),
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

  /* ------------------------------------------------------------------ */
  /* Agents / commands / skills / sessions                              */
  /* ------------------------------------------------------------------ */

  private withDirectory(path: string, directory?: string): string {
    if (!directory) return path;
    return `${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`;
  }

  /** GET /api/agent — primary/subagent agents. */
  async getAgents(directory?: string): Promise<BridgeAgent[]> {
    this.requireClient();
    try {
      const resp = await this.fetchWithRetry(this.withDirectory("/agent", directory), {
        method: "GET",
      });
      const arr = this.extractDataArray(resp) ?? [];
      const agents: BridgeAgent[] = [];
      for (const raw of arr) {
        const obj = raw as Record<string, unknown>;
        const modelObj = obj.model as Record<string, unknown> | undefined;
        agents.push({
          id: String(obj.id ?? ""),
          name: String(obj.name ?? obj.id ?? ""),
          description: typeof obj.description === "string" ? obj.description : undefined,
          mode: String(obj.mode ?? "primary"),
          hidden: obj.hidden === true,
          ...(modelObj && typeof modelObj.providerID === "string"
            ? {
                model: {
                  providerID: String(modelObj.providerID),
                  modelID: String(modelObj.id ?? ""),
                  ...(typeof modelObj.variant === "string" ? { variant: modelObj.variant } : {}),
                },
              }
            : {}),
        });
      }
      this.debugLog(`Found ${agents.length} agents`);
      return agents;
    } catch (err) {
      throw new Error(`Failed to list agents (GET /api/agent): ${errorMessage(err)}`);
    }
  }

  /** POST /api/session/{id}/agent — switch the session's agent. */
  async setSessionAgent(sessionID: string, agent: string): Promise<void> {
    this.requireClient();
    try {
      await this.fetchJSON(`/session/${encodeURIComponent(sessionID)}/agent`, {
        method: "POST",
        body: { agent },
      });
      this.debugLog(`Session ${sessionID} agent set to ${agent}`);
    } catch (err) {
      throw new Error(`Failed to switch agent: ${errorMessage(err)}`);
    }
  }

  /** GET /api/command — custom commands (name + description). */
  async getCommands(directory?: string): Promise<BridgeCommand[]> {
    this.requireClient();
    try {
      const resp = await this.fetchWithRetry(this.withDirectory("/command", directory), {
        method: "GET",
      });
      const arr = this.extractDataArray(resp) ?? [];
      return arr
        .map((raw) => {
          const obj = raw as Record<string, unknown>;
          return { name: String(obj.name ?? ""), description: String(obj.description ?? "") };
        })
        .filter((c) => c.name);
    } catch (err) {
      // Commands are optional; the palette still works with built-ins.
      this.debugLog(`getCommands failed: ${errorMessage(err)}`);
      return [];
    }
  }

  /** GET /api/skill — available skills for the palette. */
  async getSkills(directory?: string): Promise<BridgeSkill[]> {
    this.requireClient();
    try {
      const resp = await this.fetchWithRetry(this.withDirectory("/skill", directory), {
        method: "GET",
      });
      const arr = this.extractDataArray(resp) ?? [];
      return arr
        .map((raw) => {
          const obj = raw as Record<string, unknown>;
          return {
            id: String(obj.id ?? ""),
            name: String(obj.name ?? obj.id ?? ""),
            description: typeof obj.description === "string" ? obj.description : undefined,
            path: String(obj.path ?? ""),
          };
        })
        .filter((s) => s.name);
    } catch (err) {
      this.debugLog(`getSkills failed: ${errorMessage(err)}`);
      return [];
    }
  }

  /** GET /api/session — newest first, cursor pagination, search. */
  async listSessions(opts: {
    limit?: number;
    order?: "asc" | "desc";
    search?: string;
    directory?: string;
    cursor?: string;
  } = {}): Promise<{ sessions: BridgeSessionSummary[]; next?: string }> {
    this.requireClient();
    const params = new URLSearchParams();
    params.set("limit", String(opts.limit ?? 30));
    params.set("order", opts.order ?? "desc");
    if (opts.search) params.set("search", opts.search);
    if (opts.directory) params.set("directory", opts.directory);
    if (opts.cursor) params.set("cursor", opts.cursor);
    try {
      const resp = await this.fetchWithRetry(`/session?${params.toString()}`, { method: "GET" });
      const arr = this.extractDataArray(resp) ?? [];
      const cursor =
        resp && typeof resp === "object"
          ? ((resp as Record<string, unknown>).cursor as Record<string, unknown> | undefined)
          : undefined;
      const next =
        cursor && typeof cursor.next === "string" ? cursor.next : undefined;
      const sessions = arr.map((raw) => {
        const obj = raw as Record<string, unknown>;
        const time = (obj.time && typeof obj.time === "object" ? obj.time : {}) as Record<
          string,
          unknown
        >;
        const loc = (obj.location && typeof obj.location === "object" ? obj.location : {}) as Record<
          string,
          unknown
        >;
        const modelObj = (obj.model && typeof obj.model === "object" ? obj.model : undefined) as
          | Record<string, unknown>
          | undefined;
        return {
          id: String(obj.id ?? ""),
          title: String(obj.title ?? "Untitled"),
          ...(typeof loc.directory === "string" ? { directory: loc.directory } : {}),
          ...(typeof time.updated === "number" ? { updated: time.updated } : {}),
          ...(typeof time.created === "number" ? { created: time.created } : {}),
          ...(typeof obj.agent === "string" ? { agent: obj.agent } : {}),
          ...(modelObj && typeof modelObj.providerID === "string"
            ? {
                model: {
                  providerID: String(modelObj.providerID),
                  modelID: String(modelObj.id ?? ""),
                  ...(typeof modelObj.variant === "string" ? { variant: modelObj.variant } : {}),
                },
              }
            : {}),
          busy: typeof time.busy === "number" && (time.idle === undefined || time.busy > Number(time.idle ?? 0)),
        };
      });
      return { sessions, next };
    } catch (err) {
      throw new Error(`Failed to list sessions: ${errorMessage(err)}`);
    }
  }

  /** GET /api/session/active — map of session id -> {type:"running"}. */
  async getActiveSessions(): Promise<string[]> {
    this.requireClient();
    try {
      const resp = await this.fetchJSON("/session/active", { method: "GET" });
      const data =
        resp && typeof resp === "object"
          ? ((resp as Record<string, unknown>).data as Record<string, unknown> | undefined)
          : undefined;
      return data ? Object.keys(data).filter((id) => id.startsWith("ses")) : [];
    } catch (err) {
      this.debugLog(`getActiveSessions failed: ${errorMessage(err)}`);
      return [];
    }
  }

  /** GET /api/session/{id} — one session (agent/model/status). */
  async getSession(sessionID: string): Promise<BridgeSessionSummary | null> {
    this.requireClient();
    try {
      const resp = await this.fetchJSON(`/session/${encodeURIComponent(sessionID)}`, {
        method: "GET",
      });
      const data =
        resp && typeof resp === "object"
          ? ((resp as Record<string, unknown>).data as Record<string, unknown> | undefined)
          : undefined;
      if (!data) return null;
      const time = (data.time && typeof data.time === "object" ? data.time : {}) as Record<
        string,
        unknown
      >;
      const loc = (data.location && typeof data.location === "object" ? data.location : {}) as Record<
        string,
        unknown
      >;
      const modelObj = (data.model && typeof data.model === "object" ? data.model : undefined) as
        | Record<string, unknown>
        | undefined;
      return {
        id: String(data.id ?? sessionID),
        title: String(data.title ?? "Untitled"),
        ...(typeof loc.directory === "string" ? { directory: loc.directory } : {}),
        ...(typeof time.updated === "number" ? { updated: time.updated } : {}),
        ...(typeof time.created === "number" ? { created: time.created } : {}),
        ...(typeof data.agent === "string" ? { agent: data.agent } : {}),
        ...(modelObj && typeof modelObj.providerID === "string"
          ? {
              model: {
                providerID: String(modelObj.providerID),
                modelID: String(modelObj.id ?? ""),
                ...(typeof modelObj.variant === "string" ? { variant: modelObj.variant } : {}),
              },
            }
          : {}),
      };
    } catch (err) {
      this.debugLog(`getSession failed: ${errorMessage(err)}`);
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Permissions / forms / compaction / revert / diff                   */
  /* ------------------------------------------------------------------ */

  /** GET /api/session/{id}/permission — pending permission requests. */
  async getPermissions(sessionID: string): Promise<PermissionRequest[]> {
    this.requireClient();
    const data = await this.fetchJSON(
      `/session/${encodeURIComponent(sessionID)}/permission`,
      { method: "GET" }
    );
    const arr = this.extractDataArray(data) ?? [];
    return arr.map((raw) => {
      const obj = raw as Record<string, unknown>;
      return {
        id: String(obj.id ?? ""),
        sessionID: String(obj.sessionID ?? sessionID),
        action: String(obj.action ?? ""),
        resources: Array.isArray(obj.resources)
          ? obj.resources.filter((r): r is string => typeof r === "string")
          : [],
        save: Array.isArray(obj.save)
          ? obj.save.filter((r): r is string => typeof r === "string")
          : undefined,
        metadata:
          obj.metadata && typeof obj.metadata === "object"
            ? (obj.metadata as Record<string, unknown>)
            : undefined,
        source:
          obj.source && typeof obj.source === "object"
            ? (obj.source as Record<string, unknown>)
            : undefined,
        message: typeof obj.message === "string" ? obj.message : undefined,
      };
    });
  }

  /** POST /api/session/{id}/permission/{requestID}/reply. */
  async replyPermission(
    sessionID: string,
    requestID: string,
    decision: PermissionDecision,
    message?: string
  ): Promise<void> {
    this.requireClient();
    await this.fetchJSON(
      `/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`,
      { method: "POST", body: message ? { decision, message } : { decision } }
    );
    this.debugLog(`Permission ${requestID} replied: ${decision}`);
  }

  /** GET /api/session/{id}/form — pending question forms. */
  async getForms(sessionID: string): Promise<FormInfo[]> {
    this.requireClient();
    try {
      const resp = await this.fetchJSON(`/session/${encodeURIComponent(sessionID)}/form`, {
        method: "GET",
      });
      const arr = this.extractDataArray(resp) ?? [];
      return arr.map((raw) => {
        const obj = raw as Record<string, unknown>;
        return {
          id: String(obj.id ?? ""),
          sessionID: String(obj.sessionID ?? sessionID),
          title: String(obj.title ?? "Question"),
          fields: Array.isArray(obj.fields) ? (obj.fields as FormField[]) : [],
          metadata:
            obj.metadata && typeof obj.metadata === "object"
              ? (obj.metadata as Record<string, unknown>)
              : undefined,
        };
      });
    } catch (err) {
      // Older servers expose /question instead of /form. The live event
      // stream still shows questions, so a miss here is not fatal.
      this.debugLog(`getForms failed: ${errorMessage(err)}`);
      return [];
    }
  }

  /** POST /api/session/{id}/form/{formID}/reply `{answer}`. */
  async replyForm(
    sessionID: string,
    formID: string,
    answer: Record<string, unknown>
  ): Promise<void> {
    this.requireClient();
    await this.fetchJSON(
      `/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`,
      { method: "POST", body: { answer } }
    );
    this.debugLog(`Form ${formID} replied`);
  }

  /** POST /api/session/{id}/compact. */
  async compact(sessionID: string): Promise<void> {
    this.requireClient();
    await this.fetchJSON(`/session/${encodeURIComponent(sessionID)}/compact`, {
      method: "POST",
      body: {},
    });
    this.debugLog(`Compaction requested for ${sessionID}`);
  }

  /** POST /api/session/{id}/revert/stage. */
  async stageRevert(sessionID: string, messageID: string, files?: boolean): Promise<void> {
    this.requireClient();
    await this.fetchJSON(`/session/${encodeURIComponent(sessionID)}/revert/stage`, {
      method: "POST",
      body: files === undefined ? { messageID } : { messageID, files },
    });
  }

  /** POST /api/session/{id}/revert/commit. */
  async commitRevert(sessionID: string): Promise<void> {
    this.requireClient();
    await this.fetchJSON(`/session/${encodeURIComponent(sessionID)}/revert/commit`, {
      method: "POST",
      body: {},
    });
  }

  /** DELETE /api/session/{id}/revert (clear a staged revert). */
  async clearRevert(sessionID: string): Promise<void> {
    this.requireClient();
    await this.fetchJSON(`/session/${encodeURIComponent(sessionID)}/revert`, {
      method: "DELETE",
    });
  }

  /** GET /api/session/{id}/diff — per-file patches for a turn. */
  async getDiff(sessionID: string, from?: string, to?: string): Promise<FileDiffInfo[]> {
    this.requireClient();
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    const resp = await this.fetchJSON(
      `/session/${encodeURIComponent(sessionID)}/diff${qs ? `?${qs}` : ""}`,
      { method: "GET" }
    );
    const arr = this.extractDataArray(resp) ?? [];
    return arr.map((raw) => {
      const obj = raw as Record<string, unknown>;
      return {
        file: String(obj.file ?? ""),
        patch: String(obj.patch ?? ""),
        additions: Number(obj.additions ?? 0) || 0,
        deletions: Number(obj.deletions ?? 0) || 0,
        status: String(obj.status ?? "modified"),
      };
    });
  }

  /** POST /api/session/{id}/command — run a custom command by name. */
  async runCommand(sessionID: string, name: string, text: string): Promise<void> {
    this.requireClient();
    await this.fetchJSON(`/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: { name, text },
    });
    this.debugLog(`Command /${name} sent to ${sessionID}`);
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
