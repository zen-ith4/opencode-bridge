/**
 * OpenCode Bridge - Sidebar chat view (WebviewViewProvider).
 *
 * Renders a chat UI inside a VS Code webview, drives the OpenCode SDK client,
 * streams assistant replies via the server SSE `/api/event` stream, and
 * bridges user input (send button / Enter / Shift+Enter newline) to the server.
 *
 * Security:
 *  - Strict Content-Security-Policy with a per-request nonce for inline
 *    scripts/styles; no `unsafe-eval` / `unsafe-inline` without nonce.
 *  - All messages between extension and webview go through typed postMessage
 *    payloads.
 *  - Follows VS Code theme colors via CSS variables (light/dark).
 */

import * as path from "path";
import * as vscode from "vscode";
import {
  OpencodeBridgeClient,
  BridgeEvent,
  BridgeProvider,
} from "./client.js";
import { outputChannel, logError } from "./server.js";

export interface ChatViewOptions {
  client: OpencodeBridgeClient;
  extensionPath: string;
  sessionID?: string; // resume this session while VS Code is open
  debug?: boolean;
  serverUrl?: string; // e.g. http://127.0.0.1:4096/api
  workspaceDir?: string; // first workspace folder path
  mode?: "managed" | "external"; // server connection mode
  /** Called when the user clicks the key/lock button (external mode). */
  onSetPassword?: () => Promise<void>;
  /** Called when the user clicks "Enter password" after a 401 error. */
  onEnterPassword?: () => Promise<void>;
}

type WebviewMessage =
  | { type: "init"; sessionID?: string; models: any[]; selectedModel?: { providerID: string; modelID: string } | null; serverUrl?: string; workspaceDir?: string | undefined; mode?: "managed" | "external"; providersError?: string | null }
  | { type: "status"; status: "idle" | "loading" | "error" | "thinking"; message?: string }
  | { type: "assistant-start"; messageID: string; sessionID?: string }
  | { type: "assistant-delta"; messageID: string; delta: string; text: string }
  | { type: "assistant-end"; messageID: string }
  | { type: "user-message"; id: string; text: string }
  | { type: "error"; message: string; details?: string }
  | { type: "retry" }
  | { type: "providers"; providers: BridgeProvider[] }
  | { type: "no-providers" };

export class OpenCodeChatView implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencode-bridge.chat";

  private readonly client: OpencodeBridgeClient;
  private readonly extensionPath: string;
  private readonly debug: boolean;
  private readonly serverUrl: string;
  private readonly workspaceDir: string | undefined;
  private readonly mode: "managed" | "external";
  private readonly onSetPassword?: () => Promise<void>;
  private readonly onEnterPassword?: () => Promise<void>;
  private _view?: vscode.WebviewView;
  private currentSessionID: string | undefined;
  private selectedModel: { providerID: string; modelID: string } | null = null;
  private streamingMessageID: string | undefined;
  private streamingText = "";
  private thinkingTimer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly opts: ChatViewOptions) {
    this.client = opts.client;
    this.extensionPath = opts.extensionPath;
    this.debug = opts.debug ?? false;
    this.serverUrl = opts.serverUrl ?? "";
    this.workspaceDir = opts.workspaceDir;
    this.mode = opts.mode ?? "managed";
    this.onSetPassword = opts.onSetPassword;
    this.onEnterPassword = opts.onEnterPassword;
    if (opts.sessionID) this.currentSessionID = opts.sessionID;
    this.client.setDebug(this.debug);
  }

  register(context: vscode.ExtensionContext): void {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(OpenCodeChatView.viewType, this)
    );
    context.subscriptions.push(...this.disposables);
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: false,
      localResourceRoots: [vscode.Uri.file(path.join(this.extensionPath, "media"))],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    // Handle messages from the webview.
    const msgDisposable = webviewView.webview.onDidReceiveMessage((msg: any) =>
      this.handleWebviewMessage(msg)
    );
    this.disposables.push(msgDisposable);

    // When the view becomes visible, (re)establish the SSE event stream so
    // streaming updates keep flowing while the sidebar is open.
    const onDidChange = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.ensureEventStream();
    });
    this.disposables.push(onDidChange);

    // Initial payload: tell the webview the current session + available models.
    await this.postInit();

    // Start listening to server events.
    this.ensureEventStream();
  }

  dispose(): void {
    this.stopEventStream();
    if (this.thinkingTimer) {
      clearTimeout(this.thinkingTimer);
      this.thinkingTimer = undefined;
    }
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  /** Set the selected model (called by extension.ts when globalState/setting changes). */
  setSelectedModel(model: { providerID: string; modelID: string } | null): void {
    this.selectedModel = model;
    this.postToWebview({
      type: "init",
      sessionID: this.currentSessionID,
      models: [],
      selectedModel: model ?? null,
      serverUrl: this.serverUrl,
      workspaceDir: this.workspaceDir,
      mode: this.mode,
    });
  }

  /** Update the auth header on the SDK client (e.g. after user enters a password). */
  setAuthHeader(authHeader: string | undefined): void {
    this.client.setAuthHeader(authHeader);
  }

  /** Re-query providers/models from the server (triggered by refresh button). */
  async refreshProviders(): Promise<void> {
    await this.postInit();
  }

  /** Prompt the user for a server password, store it, and retry. */
  async promptForPassword(context: vscode.ExtensionContext): Promise<string | undefined> {
    const password = await vscode.window.showInputBox({
      prompt: "OpenCode server password",
      password: true,
      placeHolder: "e.g. a-long-secret",
    });
    if (password === undefined) return undefined; // cancelled
    if (!password) {
      void vscode.window.showWarningMessage("OpenCode Bridge: Password cannot be empty.");
      return undefined;
    }
    try {
      await context.secrets.store("opencodeBridge.serverPassword", password);
      this.debugLog("Password stored in secrets");
      return password;
    } catch (err) {
      const msg = errorMessage(err);
      logError(`Failed to store password: ${msg}`);
      void vscode.window.showErrorMessage(`OpenCode Bridge: failed to store password: ${msg}`);
      return undefined;
    }
  }

  /** Called by extension.ts when "New chat" is requested. */
  async newChat(directory?: string): Promise<void> {
    try {
      this.debugLog("Creating new chat session");
      const session = await this.client.createSession({
        title: "New chat",
        directory,
        model: this.selectedModel ?? undefined,
      });
      this.currentSessionID = session.id;
      this.streamingMessageID = undefined;
      this.streamingText = "";
      this.postStatus("idle");
      await this.postInit();
      this.debugLog(`New chat ready: session=${session.id}`);
    } catch (err) {
      const msg = errorMessage(err);
      this.postStatus("error", msg);
      this.postToWebview({ type: "error", message: msg, details: String(err) });
      vscode.window.showErrorMessage(`OpenCode Bridge: ${msg}`);
    }
  }

  /** Send a user message (from the webview or from "Ask about selection"). */
  async sendMessage(text: string, context?: string): Promise<void> {
    if (!this.currentSessionID) {
      await this.newChat();
    }
    if (!this.currentSessionID) return;

    const fullText = context ? `${context}\n\n---\n\n${text}` : text;

    this.debugLog(`sendMessage: session=${this.currentSessionID} textLen=${fullText.length}`);

    // Optimistic: echo the user message immediately.
    const userID = `user_${Date.now()}`;
    this.postToWebview({ type: "user-message", id: userID, text: fullText });

    // Thinking indicator.
    this.streamingMessageID = undefined;
    this.streamingText = "";
    this.postStatus("thinking", "OpenCode is thinking…");
    this.startThinkingTimer();

    try {
      await this.client.prompt({
        sessionID: this.currentSessionID,
        text: fullText,
        model: this.selectedModel ?? undefined,
      });
      // The assistant reply streams in via the SSE event stream.
      this.debugLog("Prompt sent, waiting for SSE stream…");
    } catch (err) {
      this.stopThinkingTimer();
      const msg = errorMessage(err);
      this.postStatus("error", msg);
      this.postToWebview({ type: "error", message: msg, details: String(err) });
      vscode.window.showErrorMessage(`OpenCode Bridge: ${msg}`);
    }
  }

  /** Retry the last message (re-send). Handled by the webview resending; here we just clear error state. */
  retry(): void {
    this.stopThinkingTimer();
    this.postStatus("idle");
    this.postToWebview({ type: "retry" });
  }

  /* ------------------------------------------------------------------ */
  /* Private: webview plumbing                                          */
  /* ------------------------------------------------------------------ */

  private handleWebviewMessage(msg: any): void {
    switch (msg.type) {
      case "send":
        this.sendMessage(msg.text, msg.context).catch((err) =>
          vscode.window.showErrorMessage(String(err))
        );
        break;
      case "newChat":
        this.newChat(msg.directory).catch((err) =>
          vscode.window.showErrorMessage(String(err))
        );
        break;
      case "retry":
        this.retry();
        break;
      case "selectModel":
        this.selectedModel = msg.model
          ? { providerID: msg.model.providerID, modelID: msg.model.modelID }
          : null;
        this.debugLog(`Model selected: ${this.selectedModel ? this.selectedModel.providerID + "/" + this.selectedModel.modelID : "default"}`);
        // Persist via extension through globalState is handled by extension.ts;
        // here we just update the UI.
        this.postToWebview({
          type: "init",
          sessionID: this.currentSessionID,
          models: [],
          selectedModel: this.selectedModel ?? null,
          mode: this.mode,
        });
        break;
      case "refreshProviders":
        this.refreshProviders().catch((err) =>
          vscode.window.showErrorMessage(String(err))
        );
        break;
      case "setPassword":
        this.handleSetPasswordRequest();
        break;
      case "enterPassword":
        this.handleEnterPasswordRequest();
        break;
      default:
        console.warn("[opencode-bridge] unknown webview message:", msg.type);
    }
  }

  private async handleSetPasswordRequest(): Promise<void> {
    if (this.onSetPassword) {
      await this.onSetPassword();
    }
  }

  private async handleEnterPasswordRequest(): Promise<void> {
    if (this.onEnterPassword) {
      await this.onEnterPassword();
    }
  }

  private postToWebview(message: WebviewMessage): void {
    if (!this._view) return;
    try {
      void this._view.webview.postMessage(message);
    } catch {
      // View may be disposed.
    }
  }

  private async postInit(): Promise<void> {
    let models: any[] = [];
    let providersError: string | null = null;
    try {
      const providerModels = await this.client.getModels();
      models = providerModels.map((m) => ({
        id: m.modelID,
        label: m.name,
        providerID: m.providerID,
        modelID: m.modelID,
      }));
      this.debugLog(`Loaded ${models.length} models for dropdown`);
    } catch (err) {
      const msg = errorMessage(err);
      this.debugLog(`Failed to load models for init: ${msg}`);
      logError(`Failed to load models (GET /api/model): ${msg}`);
      providersError = msg;
      // Fall back to providers list to determine if any providers exist at all.
      try {
        const providers = await this.client.getProviders();
        if (providers.length === 0) {
          this.postToWebview({ type: "no-providers" });
        }
      } catch (provErr) {
        providersError = errorMessage(provErr);
        logError(`Failed to list providers (GET /api/provider): ${providersError}`);
        this.postToWebview({ type: "no-providers" });
      }
    }
    this.postToWebview({
      type: "init",
      sessionID: this.currentSessionID,
      models,
      selectedModel: this.selectedModel ?? null,
      serverUrl: this.serverUrl,
      workspaceDir: this.workspaceDir,
      mode: this.mode,
      providersError,
    });
  }

  private postStatus(status: "idle" | "loading" | "error" | "thinking", message?: string): void {
    this.postToWebview({ type: "status", status, message });
  }

  private debugLog(message: string): void {
    if (this.debug) {
      console.log(`[opencode-bridge chat] ${message}`);
      outputChannel().appendLine(`[opencode-bridge chat] ${new Date().toISOString()} ${message}`);
    }
  }

  private startThinkingTimer(): void {
    this.stopThinkingTimer();
    this.thinkingTimer = setTimeout(() => {
      this.postStatus("error", "No response from OpenCode within 30s. Check the Output channel for details.");
      this.postToWebview({
        type: "error",
        message: "Timeout: no assistant response received within 30 seconds.",
        details: "The server may be overloaded or the model backend may be unreachable.",
      });
      this.streamingMessageID = undefined;
      this.streamingText = "";
    }, 30_000);
  }

  private stopThinkingTimer(): void {
    if (this.thinkingTimer) {
      clearTimeout(this.thinkingTimer);
      this.thinkingTimer = undefined;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Private: SSE event stream                                          */
  /* ------------------------------------------------------------------ */

  private ensureEventStream(): void {
    this.stopEventStream();

    const abort = this.client.subscribeToEvents({
      onEvent: (event: BridgeEvent) => this.handleServerEvent(event),
      onError: (err: unknown) => {
        this.debugLog(`SSE error: ${errorMessage(err)}`);
        logError(`SSE stream error: ${errorMessage(err)}`);
        // Don't hard-fail the UI; the server may be restarting.
      },
    });

    const disposable = new vscode.Disposable(() => abort.abort());
    this.disposables.push(disposable);
  }

  private stopEventStream(): void {
    // The SSE abort disposable is pushed directly to this.disposables and
    // disposed there; the client's cancelled flag stops further dispatching.
  }

  private handleServerEvent(event: BridgeEvent): void {
    this.debugLog(`SSE event received: ${event.type}`);

    // Ignore events for other sessions when we have an active session.
    if (
      this.currentSessionID &&
      event.sessionID &&
      event.sessionID !== this.currentSessionID
    ) {
      return;
    }

    // Assistant streaming text.
    const part = OpencodeBridgeClient.extractTextDelta(event);
    if (part) {
      this.stopThinkingTimer();
      if (!this.streamingMessageID) {
        this.streamingMessageID = part.messageID;
        this.streamingText = part.text;
        this.postToWebview({
          type: "assistant-start",
          messageID: this.streamingMessageID,
          sessionID: part.sessionID,
        });
      } else {
        this.streamingText += part.text;
      }
      this.postStatus("thinking");
      this.postToWebview({
        type: "assistant-delta",
        messageID: this.streamingMessageID,
        delta: part.text,
        text: this.streamingText,
      });
      return;
    }

    // Text started - just ensure we have a bubble.
    if (event.type === "session.text.started" && !this.streamingMessageID) {
      const data = event.data as Record<string, unknown> | null;
      const msgID = data && typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined;
      if (msgID) {
        this.streamingMessageID = msgID;
        this.streamingText = "";
        this.postToWebview({
          type: "assistant-start",
          messageID: msgID,
          sessionID: event.sessionID,
        });
      }
      return;
    }

    // Text ended.
    if (event.type === "session.text.ended") {
      if (this.streamingMessageID) {
        this.postToWebview({ type: "assistant-end", messageID: this.streamingMessageID });
        this.streamingMessageID = undefined;
        this.streamingText = "";
        this.postStatus("idle");
      }
      return;
    }

    // Execution succeeded (fallback if no text.ended).
    if (event.type === "session.execution.succeeded") {
      if (this.streamingMessageID) {
        this.postToWebview({ type: "assistant-end", messageID: this.streamingMessageID });
        this.streamingMessageID = undefined;
        this.streamingText = "";
        this.postStatus("idle");
      }
      return;
    }

    // Execution failed.
    if (event.type === "session.execution.failed") {
      this.stopThinkingTimer();
      const data = event.data as Record<string, unknown> | null;
      const msg = data && typeof data.error === "object" && data.error
        ? String((data.error as Record<string, unknown>).message ?? "execution failed")
        : "OpenCode execution failed";
      this.postStatus("error", msg);
      this.postToWebview({ type: "error", message: msg, details: String(event.data) });
      this.streamingMessageID = undefined;
      this.streamingText = "";
      return;
    }

    // Session created -> remember id.
    if (event.type === "session.created") {
      const data = event.data as Record<string, unknown> | null;
      const durable = data && typeof data.durable === "object" && data.durable
        ? (data.durable as Record<string, unknown>)
        : null;
      const aggID = durable && typeof durable.aggregateID === "string" ? durable.aggregateID : undefined;
      if (aggID && aggID.startsWith("ses_")) {
        this.currentSessionID = aggID;
        this.postInit();
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Private: HTML generation                                           */
  /* ------------------------------------------------------------------ */

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const jsUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.extensionPath, "media", "webview.js"))
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.extensionPath, "media", "webview.css"))
    );

    const csp = [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      `img-src 'self' https: data:`,
      `connect-src 'self'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>OpenCode Bridge</title>
  <link rel="stylesheet" href="${cssUri}" nonce="${nonce}" />
</head>
<body>
  <div class="chat-container">
    <header class="chat-header">
      <div class="title">OpenCode Bridge</div>
      <div class="subtitle">Local <code>opencode serve</code> chat</div>
      <div class="actions">
        <input type="text" id="modelSearch" placeholder="Search models…" aria-label="Search models" />
        <select id="modelSelect" title="Model" aria-label="Model"></select>
        <span id="serverInfo" class="server-info" title=""></span>
        <button id="btnKey" title="Set server password" style="display:none">🔑</button>
        <button id="btnNewChat" title="New chat">&#128214;</button>
        <button id="btnRetry" title="Retry" style="display:none">&#x21BB;</button>
      </div>
    </header>

    <div class="messages" id="messages"></div>

    <div class="status" id="status" role="status" aria-live="polite"></div>

    <form class="composer" id="composer">
      <textarea id="input" rows="1" placeholder="Ask OpenCode... (Shift+Enter = newline)"></textarea>
      <button type="submit" id="btnSend">Send</button>
    </form>
  </div>
  <script src="${jsUri}" nonce="${nonce}"></script>
</body>
</html>`;
  }
}

/** Cryptographically-ish random nonce for CSP. */
function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}
