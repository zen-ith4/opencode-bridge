/**
 * OpenCode Bridge - chat controller.
 *
 * All chat behaviour lives here and it deliberately has **no** `vscode`
 * import: `chatView.ts` is a thin adapter that forwards webview messages in
 * and `postMessage` payloads out. That makes the "does Send actually prompt?"
 * path testable with plain Node (see `test/chatController.test.mjs`).
 */

import type { BridgeEvent, TextDelta } from "./events.js";
import { extractTextDelta, shouldHandleEvent } from "./events.js";
import { logDebug, logError, logWarn } from "./log.js";

export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface BridgeModelLike {
  id: string;
  modelID: string;
  providerID: string;
  type?: string;
  name: string;
}

export interface BridgeProviderLike {
  id: string;
  name: string;
}

export interface BridgeMessageLike {
  id: string;
  role: "user" | "assistant";
  text: string;
  created?: number;
}

/** The subset of OpencodeBridgeClient the controller depends on. */
export interface ChatClientLike {
  createSession(opts: {
    title?: string;
    directory?: string;
    model?: ModelRef;
  }): Promise<{ id: string }>;
  prompt(opts: {
    sessionID: string;
    text: string;
    model?: ModelRef;
  }): Promise<{ messageID: string }>;
  getProviders(): Promise<BridgeProviderLike[]>;
  getModels(): Promise<BridgeModelLike[]>;
  getMessages(sessionID: string): Promise<BridgeMessageLike[]>;
  interrupt(sessionID: string): Promise<void>;
  streamEvents(opts: {
    signal: AbortSignal;
    onEvent: (event: BridgeEvent) => void;
  }): Promise<void>;
  setAuthHeader?(authHeader: string | undefined): void;
  setBaseUrl?(baseUrl: string): void;
}

export interface BannerAction {
  id: string;
  label: string;
}

export interface ChatBanner {
  kind: "error" | "warning" | "info" | "auth";
  message: string;
  details?: string;
  actions?: BannerAction[];
  /** "init" banners are replaced by the next successful init. */
  source?: "init" | "runtime";
}

export type PostFn = (message: unknown) => void;

export interface ChatControllerOptions {
  client: ChatClientLike;
  post: PostFn;
  mode: "managed" | "external";
  serverUrl: string;
  workspaceDir?: string;
  debug?: boolean;
  sessionID?: string;
  /** Configurable "still waiting" timeout (seconds). Default 120. */
  getResponseTimeoutSeconds?: () => number;
  persistModel?: (model: ModelRef | null) => void;
  persistSession?: (sessionID: string) => void;
  onSetPassword?: () => Promise<void>;
  onEnterPassword?: () => Promise<void>;
  onOpenLogs?: () => void;
}

const DEFAULT_RESPONSE_TIMEOUT_SECONDS = 120;
const MAX_SEEN_EVENT_IDS = 500;
const MAX_UNKNOWN_EVENT_LOGS = 8;

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isAuthFailure(message: string): boolean {
  return /HTTP\s+(401|403)\b/.test(message) || /authentication required/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ChatController {
  private readonly opts: ChatControllerOptions;
  private readonly client: ChatClientLike;

  private currentSessionID: string | undefined;
  private selectedModel: ModelRef | null = null;
  private models: Array<{ id: string; label: string; providerID: string; modelID: string }> = [];

  private generating = false;
  private streamingMessageID: string | undefined;
  private streamingText = "";
  private lastPrompt: string | undefined;
  private userSeq = 0;

  private banner: ChatBanner | undefined;

  private responseTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  private eventAbort: AbortController | undefined;
  private eventGeneration = 0;
  private seenEventIDs = new Set<string>();
  private unknownEventLogs = 0;

  constructor(options: ChatControllerOptions) {
    this.opts = options;
    this.client = options.client;
    this.currentSessionID = options.sessionID;
  }

  /* ------------------------------------------------------------------ */
  /* State accessors (used by extension + tests)                        */
  /* ------------------------------------------------------------------ */

  getSessionID(): string | undefined {
    return this.currentSessionID;
  }

  getSelectedModel(): ModelRef | null {
    return this.selectedModel;
  }

  isGenerating(): boolean {
    return this.generating;
  }

  getBanner(): ChatBanner | undefined {
    return this.banner;
  }

  /* ------------------------------------------------------------------ */
  /* Webview -> extension                                               */
  /* ------------------------------------------------------------------ */

  async handleMessage(message: any): Promise<void> {
    if (!message || typeof message.type !== "string") return;
    try {
      switch (message.type) {
        case "ready":
          await this.postInit();
          this.ensureEventStream();
          break;
        case "send":
          await this.sendMessage(String(message.text ?? ""), message.context);
          break;
        case "newChat":
          await this.newChat(typeof message.directory === "string" ? message.directory : undefined);
          break;
        case "stop":
          await this.stop();
          break;
        case "retry":
          await this.retry();
          break;
        case "selectModel":
          this.selectModel(message.model ?? null);
          break;
        case "refreshProviders":
          await this.postInit();
          break;
        case "bannerAction":
          await this.handleBannerAction(String(message.action ?? ""));
          break;
        case "dismissBanner":
          this.clearBanner();
          break;
        case "setPassword":
          await this.opts.onSetPassword?.();
          break;
        case "enterPassword":
          await this.opts.onEnterPassword?.();
          break;
        case "openLogs":
          this.opts.onOpenLogs?.();
          break;
        case "saveScroll":
          break; // reserved
        default:
          this.debugLog(`unknown webview message: ${message.type}`);
      }
    } catch (err) {
      const msg = errMessage(err);
      logError(`Webview message "${message.type}" failed: ${msg}`);
      this.post({ type: "prompt-failed", message: msg });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Init / models / history                                            */
  /* ------------------------------------------------------------------ */

  async postInit(): Promise<void> {
    let providersError: string | null = null;
    let noProviders = false;
    let history: BridgeMessageLike[] = [];

    const [modelsResult, providersResult] = await Promise.allSettled([
      this.client.getModels(),
      this.client.getProviders(),
    ]);

    if (providersResult.status === "fulfilled") {
      if (providersResult.value.length === 0) noProviders = true;
    } else {
      providersError = errMessage(providersResult.reason);
      logError(`Failed to load providers: ${providersError}`);
    }

    if (modelsResult.status === "fulfilled") {
      this.models = modelsResult.value.map((m) => ({
        id: m.modelID || m.id,
        label: m.name || m.modelID || m.id,
        providerID: m.providerID,
        modelID: m.modelID || m.id,
      }));
    } else {
      const message = errMessage(modelsResult.reason);
      if (!providersError) providersError = message;
      logError(`Failed to load models: ${message}`);
    }

    if (this.currentSessionID) {
      try {
        history = await this.client.getMessages(this.currentSessionID);
      } catch (err) {
        // Do not surface as "no providers"; just log. The chat stays usable.
        logError(`Failed to restore session history: ${errMessage(err)}`);
      }
    }

    this.updateInitBanner(providersError, noProviders);

    this.post({
      type: "init",
      sessionID: this.currentSessionID,
      models: this.models,
      selectedModel: this.selectedModel,
      serverUrl: this.opts.serverUrl,
      workspaceDir: this.opts.workspaceDir,
      mode: this.opts.mode,
      noProviders,
      providersError,
      history,
      banner: this.banner ?? null,
      generating: this.generating,
    });
  }

  /**
   * Only claim "no providers" when GET /api/provider actually succeeded and
   * returned zero entries. Any other failure shows the real error once.
   */
  private updateInitBanner(providersError: string | null, noProviders: boolean): void {
    if (providersError) {
      if (isAuthFailure(providersError)) {
        this.banner = {
          kind: "auth",
          message: "Authentication required by the OpenCode server.",
          details: providersError,
          source: "init",
          actions: [
            { id: "enter-password", label: "Enter password" },
            { id: "refresh", label: "Retry" },
            { id: "open-logs", label: "Open logs" },
          ],
        };
      } else {
        this.banner = {
          kind: "error",
          message: "Could not load models from the OpenCode server.",
          details: providersError,
          source: "init",
          actions: [
            { id: "refresh", label: "Retry" },
            { id: "open-logs", label: "Open logs" },
          ],
        };
      }
      return;
    }

    if (noProviders) {
      this.banner = {
        kind: "warning",
        message:
          "No model providers are connected to OpenCode. Add a provider in OpenCode, then refresh.",
        source: "init",
        actions: [
          { id: "refresh", label: "Refresh" },
          { id: "open-logs", label: "Open logs" },
        ],
      };
      return;
    }

    if (this.banner?.source === "init") this.banner = undefined;
  }

  /* ------------------------------------------------------------------ */
  /* Sending / sessions                                                 */
  /* ------------------------------------------------------------------ */

  async sendMessage(text: string, context?: string): Promise<void> {
    const typed = text.trim();
    if (!typed) return;
    if (this.generating) {
      this.post({
        type: "status",
        status: "thinking",
        message: "Still generating — press Stop first.",
        generating: true,
      });
      return;
    }

    const fullText = context ? `${context}\n\n---\n\n${typed}` : typed;

    try {
      if (!this.currentSessionID) await this.createSession();
      if (!this.currentSessionID) return;

      const userID = `user_${Date.now()}_${++this.userSeq}`;
      this.lastPrompt = fullText;
      this.post({ type: "user-message", id: userID, text: fullText, created: Date.now() });

      this.generating = true;
      this.streamingMessageID = undefined;
      this.streamingText = "";
      this.post({ type: "status", status: "thinking", message: "OpenCode is thinking…", generating: true });

      await this.client.prompt({
        sessionID: this.currentSessionID,
        text: fullText,
        model: this.selectedModel ?? undefined,
      });
      this.startResponseTimer();
      this.debugLog("Prompt accepted; waiting for SSE events");
    } catch (err) {
      const message = errMessage(err);
      logError(`Failed to send prompt: ${message}`);
      this.finishStreaming();
      this.post({ type: "prompt-failed", message, details: message });
      this.showBanner({
        kind: "error",
        message: "Could not send your message to OpenCode.",
        details: message,
        source: "runtime",
        actions: [
          { id: "retry-prompt", label: "Retry" },
          { id: "open-logs", label: "Open logs" },
        ],
      });
    }
  }

  async newChat(directory?: string): Promise<void> {
    this.finishStreaming();
    try {
      const session = await this.createSession(directory);
      if (!session) return;
      this.post({
        type: "init",
        sessionID: this.currentSessionID,
        models: this.models,
        selectedModel: this.selectedModel,
        serverUrl: this.opts.serverUrl,
        workspaceDir: this.opts.workspaceDir,
        mode: this.opts.mode,
        noProviders: false,
        providersError: null,
        history: [],
        banner: this.banner ?? null,
        generating: false,
      });
      this.post({ type: "status", status: "idle", message: "", generating: false });
    } catch (err) {
      const message = errMessage(err);
      logError(`Failed to create chat: ${message}`);
      this.showBanner({
        kind: "error",
        message: "Could not create a new OpenCode session.",
        details: message,
        source: "runtime",
        actions: [{ id: "open-logs", label: "Open logs" }],
      });
    }
  }

  private async createSession(directory?: string): Promise<{ id: string } | undefined> {
    const session = await this.client.createSession({
      title: "New chat",
      directory,
      model: this.selectedModel ?? undefined,
    });
    if (!session?.id) throw new Error("Server did not return a session id.");
    this.currentSessionID = session.id;
    this.opts.persistSession?.(session.id);
    this.debugLog(`Session ready: ${session.id}`);
    return session;
  }

  async stop(): Promise<void> {
    if (!this.generating) return;
    const sessionID = this.currentSessionID;
    if (sessionID) {
      try {
        await this.client.interrupt(sessionID);
      } catch (err) {
        logError(`Failed to interrupt session: ${errMessage(err)}`);
      }
    }
    this.finishStreaming("Stopped");
  }

  async retry(): Promise<void> {
    if (this.generating) return;
    if (!this.currentSessionID || !this.lastPrompt) {
      this.showBanner({
        kind: "warning",
        message: "Nothing to retry yet.",
        source: "runtime",
      });
      return;
    }
    this.generating = true;
    this.streamingMessageID = undefined;
    this.streamingText = "";
    this.post({ type: "status", status: "thinking", message: "Retrying…", generating: true });
    try {
      await this.client.prompt({
        sessionID: this.currentSessionID,
        text: this.lastPrompt,
        model: this.selectedModel ?? undefined,
      });
      this.startResponseTimer();
    } catch (err) {
      const message = errMessage(err);
      logError(`Retry failed: ${message}`);
      this.finishStreaming();
      this.post({ type: "prompt-failed", message, details: message });
      this.showBanner({
        kind: "error",
        message: "Retry failed.",
        details: message,
        source: "runtime",
        actions: [
          { id: "retry-prompt", label: "Retry again" },
          { id: "open-logs", label: "Open logs" },
        ],
      });
    }
  }

  /**
   * Model selection updates only the selection (type "model-selected").
   * It must NOT post an empty "init" that wipes the model list.
   */
  selectModel(model: ModelRef | null): void {
    const next =
      model && typeof model.providerID === "string" && typeof model.modelID === "string"
        ? { providerID: model.providerID, modelID: model.modelID }
        : null;
    this.selectedModel = next;
    this.opts.persistModel?.(next);
    this.debugLog(
      `Model selected: ${next ? `${next.providerID}/${next.modelID}` : "server default"}`
    );
    this.post({ type: "model-selected", selectedModel: next });
  }

  /** Called by extension.ts when the setting/globalState model changes. */
  setSelectedModel(model: ModelRef | null): void {
    this.selectedModel = model;
    this.post({ type: "model-selected", selectedModel: model });
  }

  /* ------------------------------------------------------------------ */
  /* Server info / auth                                                 */
  /* ------------------------------------------------------------------ */

  setAuthHeader(authHeader: string | undefined): void {
    this.client.setAuthHeader?.(authHeader);
    // Recreate the SSE stream with the new credentials.
    this.restartEventStream();
  }

  setServerUrl(serverUrl: string): void {
    this.opts.serverUrl = serverUrl;
    this.client.setBaseUrl?.(serverUrl);
    this.post({
      type: "server-info",
      serverUrl,
      mode: this.opts.mode,
      workspaceDir: this.opts.workspaceDir,
    });
  }

  async onServerRestarted(serverUrl: string, authHeader: string | undefined, attempt: number): Promise<void> {
    this.opts.serverUrl = serverUrl;
    this.client.setBaseUrl?.(serverUrl);
    this.client.setAuthHeader?.(authHeader);
    this.restartEventStream();
    this.showBanner({
      kind: "info",
      message: `The local OpenCode server restarted (attempt ${attempt}).`,
      source: "runtime",
    });
    await this.postInit();
  }

  /* ------------------------------------------------------------------ */
  /* Banner                                                             */
  /* ------------------------------------------------------------------ */

  showBanner(banner: ChatBanner): void {
    this.banner = banner;
    this.post({ type: "banner", banner });
  }

  clearBanner(): void {
    this.banner = undefined;
    this.post({ type: "banner", banner: null });
  }

  private async handleBannerAction(action: string): Promise<void> {
    switch (action) {
      case "refresh":
        await this.postInit();
        break;
      case "retry-prompt":
        await this.retry();
        break;
      case "enter-password":
        await this.opts.onEnterPassword?.();
        break;
      case "open-logs":
        this.opts.onOpenLogs?.();
        break;
      case "cancel-wait":
        await this.stop();
        break;
      case "dismiss":
        this.clearBanner();
        break;
      default:
        this.debugLog(`unknown banner action: ${action}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Response timeout ("still waiting", never a hard failure)           */
  /* ------------------------------------------------------------------ */

  private responseTimeoutSeconds(): number {
    const raw = this.opts.getResponseTimeoutSeconds?.() ?? DEFAULT_RESPONSE_TIMEOUT_SECONDS;
    const seconds = Number.isFinite(raw) ? raw : DEFAULT_RESPONSE_TIMEOUT_SECONDS;
    return Math.min(3_600, Math.max(0.05, seconds));
  }

  private startResponseTimer(): void {
    this.stopResponseTimer();
    const seconds = this.responseTimeoutSeconds();
    this.responseTimer = setTimeout(() => {
      this.responseTimer = undefined;
      if (!this.generating || this.disposed) return;
      this.post({
        type: "status",
        status: "waiting",
        message: `Still waiting for OpenCode… (no events for ${Math.round(seconds)}s)`,
        generating: true,
        canCancel: true,
      });
    }, seconds * 1_000);
  }

  private stopResponseTimer(): void {
    if (this.responseTimer) {
      clearTimeout(this.responseTimer);
      this.responseTimer = undefined;
    }
  }

  private noteActivity(): void {
    if (this.generating) this.startResponseTimer();
  }

  private finishStreaming(message?: string): void {
    this.stopResponseTimer();
    if (this.streamingMessageID) {
      this.post({ type: "assistant-end", messageID: this.streamingMessageID });
    }
    this.streamingMessageID = undefined;
    this.streamingText = "";
    this.generating = false;
    this.post({
      type: "status",
      status: "idle",
      message: message ?? "",
      generating: false,
      canCancel: false,
    });
  }

  /* ------------------------------------------------------------------ */
  /* SSE lifecycle                                                      */
  /* ------------------------------------------------------------------ */

  /** Ensure exactly one live SSE subscription (restarts any previous one). */
  ensureEventStream(): void {
    if (this.disposed) return;
    this.restartEventStream();
  }

  private restartEventStream(): void {
    if (this.disposed) return;
    this.stopEventStream();
    const generation = this.eventGeneration;
    void this.runEventStream(generation);
  }

  /** Abort the live stream and invalidate its generation. */
  stopEventStream(): void {
    this.eventGeneration += 1;
    if (this.eventAbort) {
      try {
        this.eventAbort.abort();
      } catch {
        /* ignore */
      }
      this.eventAbort = undefined;
    }
  }

  private async runEventStream(generation: number): Promise<void> {
    let backoff = 1_000;
    while (!this.disposed && generation === this.eventGeneration) {
      const controller = new AbortController();
      this.eventAbort = controller;
      let sawEvent = false;
      try {
        await this.client.streamEvents({
          signal: controller.signal,
          onEvent: (event) => {
            if (this.disposed || generation !== this.eventGeneration) return;
            sawEvent = true;
            this.handleServerEvent(event);
          },
        });
        if (generation !== this.eventGeneration || this.disposed) return;
        this.debugLog("SSE stream ended; will reconnect");
      } catch (err) {
        if (controller.signal.aborted || generation !== this.eventGeneration) return;
        logError(`SSE stream error: ${errMessage(err)}`);
      } finally {
        if (this.eventAbort === controller) this.eventAbort = undefined;
      }

      if (generation !== this.eventGeneration || this.disposed) return;
      if (sawEvent) backoff = 1_000;
      this.post({ type: "connection", state: "reconnecting" });
      await delay(backoff);
      backoff = Math.min(backoff * 2, 10_000);
    }
  }

  /**
   * Handle one server event. Exposed (public) for tests. Only events for the
   * session the extension created are processed; `session.created` is
   * intentionally ignored (another client's session must not hijack ours).
   */
  handleServerEvent(event: BridgeEvent): void {
    if (!event || typeof event.type !== "string") return;

    if (event.id) {
      if (this.seenEventIDs.has(event.id)) return;
      this.seenEventIDs.add(event.id);
      if (this.seenEventIDs.size > MAX_SEEN_EVENT_IDS) {
        const first = this.seenEventIDs.values().next().value;
        if (first) this.seenEventIDs.delete(first);
      }
    }

    if (!shouldHandleEvent(event, this.currentSessionID)) {
      this.debugLog(`ignoring ${event.type} for another session (${event.sessionID ?? "unknown"})`);
      return;
    }

    // Any event for our session keeps the "still waiting" timer fresh.
    this.noteActivity();

    switch (event.type) {
      case "session.text.started": {
        const data = event.data as Record<string, unknown> | null;
        const messageID =
          data && typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined;
        if (!this.streamingMessageID && messageID) {
          this.streamingMessageID = messageID;
          this.streamingText = "";
          this.post({ type: "assistant-start", messageID, sessionID: event.sessionID });
          this.post({ type: "status", status: "thinking", message: "", generating: true });
        }
        return;
      }

      case "session.text.delta": {
        const part: TextDelta | null = extractTextDelta(event);
        if (!part) return;
        if (!this.streamingMessageID) {
          this.streamingMessageID = part.messageID;
          this.streamingText = "";
          this.post({ type: "assistant-start", messageID: part.messageID, sessionID: part.sessionID });
        }
        this.streamingText += part.text;
        this.post({
          type: "assistant-delta",
          messageID: this.streamingMessageID,
          delta: part.text,
          text: this.streamingText,
        });
        this.post({ type: "status", status: "thinking", message: "", generating: true });
        return;
      }

      case "session.text.ended": {
        const data = event.data as Record<string, unknown> | null;
        const fullText = data && typeof data.text === "string" ? data.text : "";
        const messageID =
          data && typeof data.assistantMessageID === "string"
            ? data.assistantMessageID
            : this.streamingMessageID;

        if (messageID && !this.streamingMessageID) {
          this.streamingMessageID = messageID;
          this.streamingText = fullText;
          this.post({ type: "assistant-start", messageID, sessionID: event.sessionID });
          this.post({ type: "assistant-delta", messageID, delta: fullText, text: fullText });
        } else if (messageID && !this.streamingText && fullText) {
          this.streamingText = fullText;
          this.post({ type: "assistant-delta", messageID, delta: fullText, text: fullText });
        }

        this.finishStreaming();
        return;
      }

      case "session.execution.started": {
        if (!this.generating) {
          this.generating = true;
          this.post({ type: "status", status: "thinking", message: "", generating: true });
        }
        this.startResponseTimer();
        return;
      }

      case "session.execution.succeeded":
      case "session.execution.interrupted":
      case "session.idle":
        this.finishStreaming();
        return;

      case "session.execution.failed": {
        const data = event.data as Record<string, unknown> | null;
        const errorObj = data && data.error ? data.error : data;
        const message = this.structuredErrorMessage(errorObj);
        logError(`OpenCode execution failed: ${message}`);
        this.finishStreaming();
        this.post({ type: "prompt-failed", message, details: message });
        this.showBanner({
          kind: "error",
          message: "OpenCode could not complete the request.",
          details: message,
          source: "runtime",
          actions: [
            { id: "retry-prompt", label: "Retry" },
            { id: "open-logs", label: "Open logs" },
          ],
        });
        return;
      }

      case "session.created":
        // Never adopt another client's session id. Ignored on purpose.
        this.debugLog("ignoring session.created (only our own createSession id is trusted)");
        return;

      default:
        if (this.unknownEventLogs < MAX_UNKNOWN_EVENT_LOGS) {
          this.unknownEventLogs += 1;
          this.debugLog(`unhandled SSE event: ${event.type}`);
        }
    }
  }

  private structuredErrorMessage(value: unknown): string {
    if (!value) return "OpenCode execution failed";
    if (typeof value === "string") return value;
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (typeof obj.message === "string") return obj.message;
      if (typeof obj.name === "string") return obj.name;
      try {
        return JSON.stringify(value);
      } catch {
        return "OpenCode execution failed";
      }
    }
    return String(value);
  }

  /* ------------------------------------------------------------------ */
  /* Disposal                                                           */
  /* ------------------------------------------------------------------ */

  dispose(): void {
    this.disposed = true;
    this.stopResponseTimer();
    this.stopEventStream();
  }

  private post(message: unknown): void {
    try {
      this.opts.post(message);
    } catch (err) {
      logWarn(`Failed to post message to webview: ${errMessage(err)}`);
    }
  }

  private debugLog(message: string): void {
    logDebug(`[chat] ${message}`, this.opts.debug ?? false);
  }
}
