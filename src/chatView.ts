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
import { OpencodeBridgeClient, BridgeEvent } from "./client.js";

export interface ChatViewOptions {
  client: OpencodeBridgeClient;
  extensionPath: string;
  sessionID?: string; // resume this session while VS Code is open
}

type WebviewMessage =
  | { type: "init"; sessionID?: string; messages: any[] }
  | { type: "status"; status: "idle" | "loading" | "error"; message?: string }
  | { type: "assistant-start"; messageID: string; sessionID: string }
  | { type: "assistant-delta"; messageID: string; delta: string; text: string }
  | { type: "assistant-end"; messageID: string }
  | { type: "user-message"; id: string; text: string }
  | { type: "error"; message: string }
  | { type: "retry" };

export class OpenCodeChatView implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencode-bridge.chat";

  private readonly client: OpencodeBridgeClient;
  private readonly extensionPath: string;
  private _view?: vscode.WebviewView;
  private currentSessionID: string | undefined;
  private eventStreamAbort?: () => void;
  private streamingMessageID: string | undefined;
  private streamingText = "";
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly opts: ChatViewOptions) {
    this.client = opts.client;
    this.extensionPath = opts.extensionPath;
    if (opts.sessionID) this.currentSessionID = opts.sessionID;
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

    // Initial payload: tell the webview the current session + any history.
    this.postInit();

    // Start listening to server events.
    this.ensureEventStream();
  }

  dispose(): void {
    this.stopEventStream();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  /** Called by extension.ts when "New chat" is requested. */
  async newChat(directory?: string): Promise<void> {
    try {
      const session = await this.client.createSession({
        title: "New chat",
        directory,
      });
      this.currentSessionID = session.id;
      this.streamingMessageID = undefined;
      this.streamingText = "";
      this.postStatus("idle");
      this.postInit();
    } catch (err) {
      this.postStatus("error", errorMessage(err));
      void vscode.window.showErrorMessage(`OpenCode Bridge: ${errorMessage(err)}`);    }
  }

  /** Send a user message (from the webview or from "Ask about selection"). */
  async sendMessage(text: string, context?: string): Promise<void> {
    if (!this.currentSessionID) {
      await this.newChat();
    }
    if (!this.currentSessionID) return;

    const fullText = context ? `${context}\n\n---\n\n${text}` : text;

    this.postStatus("loading");
    this.streamingMessageID = undefined;
    this.streamingText = "";

    // Echo the user message immediately so the UI stays responsive.
    const userID = `user_${Date.now()}`;
    this.postToWebview({ type: "user-message", id: userID, text: fullText });

    try {
      await this.client.prompt({
        sessionID: this.currentSessionID,
        text: fullText,
      });
      // The assistant reply streams in via the SSE event stream.
    } catch (err) {
      this.postStatus("error", errorMessage(err));
      this.postToWebview({ type: "error", message: errorMessage(err) });
    }
  }

  /** Retry the last message (re-send). Handled by the webview resending; here we just clear error state. */
  retry(): void {
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
      default:
        console.warn("[opencode-bridge] unknown webview message:", msg.type);
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

  private postInit(): void {
    this.postToWebview({
      type: "init",
      sessionID: this.currentSessionID,
      messages: [], // history is fetched lazily if needed; keep simple
    });
  }

  private postStatus(status: "idle" | "loading" | "error", message?: string): void {
    this.postToWebview({ type: "status", status, message });
  }

  /* ------------------------------------------------------------------ */
  /* Private: SSE event stream                                          */
  /* ------------------------------------------------------------------ */

  private ensureEventStream(): void {
    // Only one event stream at a time.
    this.stopEventStream();

    const abort = this.client.subscribeToEvents({
      onEvent: (event: BridgeEvent) => this.handleServerEvent(event),
      onError: (err: unknown) => {
        console.warn("[opencode-bridge] SSE error:", err);
        // Don't hard-fail the UI on SSE hiccups; the server may be restarting.
      },
    });
    this.eventStreamAbort = abort.abort;
  }

  private stopEventStream(): void {
    if (this.eventStreamAbort) {
      try {
        this.eventStreamAbort();
      } catch {
        /* ignore */
      }
      this.eventStreamAbort = undefined;
    }
  }

  private handleServerEvent(event: BridgeEvent): void {
    if (!this.currentSessionID && event.sessionID && event.sessionID !== this.currentSessionID) {
      return; // events for other sessions
    }

    // Assistant streaming text.
    const part = OpencodeBridgeClient.extractTextDelta(event);
    if (part) {
      const messageID = part.messageID;
      if (!this.streamingMessageID) {
        this.streamingMessageID = messageID;
        this.streamingText = part.text ?? "";
        this.postToWebview({
          type: "assistant-start",
          messageID,
          sessionID: part.sessionID,
        });
      }
      if (part.delta) {
        this.streamingText += part.delta;
      } else if (typeof part.text === "string") {
        this.streamingText = part.text;
      }
      this.postStatus("loading");
      this.postToWebview({
        type: "assistant-delta",
        messageID: this.streamingMessageID || messageID,
        delta: part.delta ?? "",
        text: this.streamingText,
      });
      return;
    }

    // A message was finalized.
    if (event.type === "message.updated" && this.streamingMessageID) {
      const data = event.data as Record<string, unknown> | null;
      const info = data && typeof data.info === "object" ? data.info : null;
      const finished =
        info &&
        typeof (info as Record<string, unknown>).finish === "string" &&
        (info as Record<string, unknown>).finish !== "";
      if (finished) {
        this.postToWebview({ type: "assistant-end", messageID: this.streamingMessageID });
        this.streamingMessageID = undefined;
        this.streamingText = "";
        this.postStatus("idle");
      }
      return;
    }

    // Session created -> remember id.
    if (event.type === "session.created") {
      const data = event.data as Record<string, unknown> | null;
      const props =
        data && typeof data.properties === "object" && data.properties
          ? (data.properties as Record<string, unknown>)
          : null;
      const info = props && typeof props.info === "object" ? props.info : null;
      const id = info && typeof (info as Record<string, unknown>).id === "string"
        ? String((info as Record<string, unknown>).id)
        : undefined;
      if (id) {
        this.currentSessionID = id;
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
