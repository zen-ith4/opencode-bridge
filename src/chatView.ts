/**
 * OpenCode Bridge - Sidebar chat view (WebviewViewProvider).
 *
 * Thin adapter over `ChatController`:
 *  - builds the strict-CSP HTML shell (no inline styles/handlers),
 *  - forwards webview messages to the controller,
 *  - forwards controller messages to the webview.
 *
 * Security:
 *  - strict Content-Security-Policy with a nonce for the two local scripts
 *    and the linked stylesheet plus `webview.cspSource` for those files,
 *  - no `unsafe-eval` / `unsafe-inline`,
 *  - links are opened in the browser by the extension after scheme checks.
 */

import * as path from "path";
import * as vscode from "vscode";
import { OpencodeBridgeClient } from "./client.js";
import {
  ChatController,
  ChatBanner,
  ModelRef,
} from "./chatController.js";
import { logError } from "./log.js";

export interface ChatViewOptions {
  client: OpencodeBridgeClient;
  extensionPath: string;
  sessionID?: string;
  debug?: boolean;
  serverUrl?: string;
  workspaceDir?: string;
  mode?: "managed" | "external";
  getResponseTimeoutSeconds?: () => number;
  getPermissionsMode?: () => "ask" | "readOnlyAuto";
  persistModel?: (model: ModelRef | null) => void;
  persistSession?: (sessionID: string) => void;
  onSetPassword?: () => Promise<void>;
  onEnterPassword?: () => Promise<void>;
  onOpenLogs?: () => void;
}

export class OpenCodeChatView implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencode-bridge.chat";

  private readonly controller: ChatController;
  private readonly client: OpencodeBridgeClient;
  private readonly extensionPath: string;
  private readonly workspaceDir?: string;
  private _view?: vscode.WebviewView;
  private viewDisposables: vscode.Disposable[] = [];

  constructor(options: ChatViewOptions) {
    this.extensionPath = options.extensionPath;
    this.client = options.client;
    this.workspaceDir = options.workspaceDir;
    this.controller = new ChatController({
      client: options.client,
      post: (message) => this.postToWebview(message),
      mode: options.mode ?? "managed",
      serverUrl: options.serverUrl ?? "",
      workspaceDir: options.workspaceDir,
      debug: options.debug ?? false,
      sessionID: options.sessionID,
      getResponseTimeoutSeconds: options.getResponseTimeoutSeconds,
      getPermissionsMode: options.getPermissionsMode,
      persistModel: options.persistModel,
      persistSession: options.persistSession,
      onOpenFile: (file) => void this.openFile(file),
      onSetPassword: options.onSetPassword,
      onEnterPassword: options.onEnterPassword,
      onOpenLogs: options.onOpenLogs,
    });
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(OpenCodeChatView.viewType, this, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      this
    );
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

    const messageDisposable = webviewView.webview.onDidReceiveMessage((message: any) => {
      void this.handleIncomingMessage(message);
    });
    this.viewDisposables.push(messageDisposable);

    const visibilityDisposable = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        // Restarting always aborts the previous subscription first, so there
        // is exactly one live SSE connection.
        this.controller.ensureEventStream();
      }
    });
    this.viewDisposables.push(visibilityDisposable);

    // The webview sends {"type":"ready"} once acquireVsCodeApi() is in place;
    // that is what triggers the init payload (models + history + banner) and
    // the single SSE subscription (see ChatController.handleMessage).
  }

  private async handleIncomingMessage(message: any): Promise<void> {
    if (!message || typeof message.type !== "string") return;

    if (message.type === "openLink") {
      const url = String(message.url ?? "");
      if (/^(https?:\/\/|mailto:)/i.test(url)) {
        try {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        } catch (err) {
          logError(`Failed to open link: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }

    if (message.type === "openFile") {
      await this.openFile(String(message.path ?? ""));
      return;
    }

    if (message.type === "openDiff") {
      await this.openDiff(
        String(message.path ?? ""),
        typeof message.from === "string" ? message.from : undefined
      );
      return;
    }

    await this.controller.handleMessage(message);
  }

  /** Resolve a workspace-relative path and open it in the editor. */
  private async openFile(filePath: string): Promise<void> {
    if (!filePath) return;
    try {
      const uri = this.resolveUri(filePath);
      if (!uri) return;
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (err) {
      logError(`Failed to open file ${filePath}: ${errMessage(err)}`);
      void vscode.window.showWarningMessage(`OpenCode Bridge: could not open ${filePath}`);
    }
  }

  /**
   * Show the server's unified patch for a file in a diff-language editor.
   * The v2.3.0 spec has no endpoint for snapshot file contents, so a true
   * side-by-side vscode.diff is not possible; the patch endpoint is verified.
   */
  private async openDiff(filePath: string, from?: string): Promise<void> {
    const sessionID = this.controller.getSessionID();
    if (!sessionID) {
      await this.openFile(filePath);
      return;
    }
    try {
      const diffs = await this.client.getDiff(sessionID, from);
      const match =
        diffs.find((d) => d.file === filePath || d.file.endsWith(`/${filePath}`)) ?? diffs[0];
      if (!match) {
        await this.openFile(filePath);
        return;
      }
      const header = `# ${match.file} (${match.status}, +${match.additions} -${match.deletions})\n\n`;
      const document = await vscode.workspace.openTextDocument({
        content: header + match.patch,
        language: "diff",
      });
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (err) {
      logError(`Failed to show diff for ${filePath}: ${errMessage(err)}`);
      await this.openFile(filePath);
    }
  }

  private resolveUri(filePath: string): vscode.Uri | undefined {
    if (/^[a-zA-Z]+:\/\//.test(filePath)) return vscode.Uri.parse(filePath);
    if (filePath.startsWith("/")) return vscode.Uri.file(filePath);
    const base =
      this.workspaceDir ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!base) return undefined;
    return vscode.Uri.file(path.join(base, filePath));
  }

  /* ------------------------------------------------------------------ */
  /* Public API used by extension.ts                                    */
  /* ------------------------------------------------------------------ */

  setSelectedModel(model: ModelRef | null): void {
    this.controller.setSelectedModel(model);
  }

  setAuthHeader(authHeader: string | undefined): void {
    this.controller.setAuthHeader(authHeader);
  }

  async refreshProviders(): Promise<void> {
    await this.controller.postInit();
  }

  async postInit(): Promise<void> {
    await this.controller.postInit();
  }

  async newChat(directory?: string): Promise<void> {
    await this.controller.newChat(directory);
  }

  async sendMessage(text: string, context?: string): Promise<void> {
    await this.controller.sendMessage(text, context);
  }

  showBanner(banner: ChatBanner): void {
    this.controller.showBanner(banner);
  }

  clearBanner(): void {
    this.controller.clearBanner();
  }

  async onServerRestarted(baseUrl: string, authHeader: string | undefined, attempt: number): Promise<void> {
    await this.controller.onServerRestarted(baseUrl, authHeader, attempt);
  }

  getSessionID(): string | undefined {
    return this.controller.getSessionID();
  }

  isGenerating(): boolean {
    return this.controller.isGenerating();
  }

  dispose(): void {
    this.controller.dispose();
    for (const d of this.viewDisposables) d.dispose();
    this.viewDisposables = [];
    this._view = undefined;
  }

  /* ------------------------------------------------------------------ */
  /* Plumbing                                                           */
  /* ------------------------------------------------------------------ */

  private postToWebview(message: unknown): void {
    if (!this._view) return;
    try {
      void this._view.webview.postMessage(message);
    } catch {
      // View may be disposed.
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const cspSource = webview.cspSource;
    const jsUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.extensionPath, "media", "webview.js"))
    );
    const markdownUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.extensionPath, "media", "markdown.cjs"))
    );
    const slashUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.extensionPath, "media", "slash.cjs"))
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.extensionPath, "media", "webview.css"))
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${cspSource} https: data:`,
      `font-src ${cspSource}`,
      `script-src 'nonce-${nonce}' ${cspSource}`,
      `style-src 'nonce-${nonce}' ${cspSource}`,
      `connect-src 'none'`,
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
  <div class="app">
    <header class="header" id="header" title="">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">◍</span>
        <span class="brand-name">OpenCode</span>
      </div>
      <div class="header-actions">
        <button type="button" id="agentButton" class="model-button compact" aria-haspopup="listbox" aria-expanded="false" title="Choose agent">
          <span id="agentLabel">Agent</span>
          <span class="chevron" aria-hidden="true">▾</span>
        </button>
        <button type="button" id="sessionButton" class="model-button compact" aria-haspopup="dialog" aria-expanded="false" title="Switch session">
          <span id="sessionLabel">Sessions</span>
          <span class="chevron" aria-hidden="true">▾</span>
        </button>
        <button type="button" id="modelButton" class="model-button" aria-haspopup="listbox" aria-expanded="false" title="Choose model">
          <span id="modelLabel">Default model</span>
          <span class="chevron" aria-hidden="true">▾</span>
        </button>
        <button type="button" id="variantButton" class="model-button compact" aria-haspopup="listbox" aria-expanded="false" title="Thinking effort variant" hidden>
          <span id="variantLabel">Variant</span>
          <span class="chevron" aria-hidden="true">▾</span>
        </button>
        <button type="button" id="btnRefresh" class="icon-btn" aria-label="Refresh models" title="Refresh models">↻</button>
        <button type="button" id="btnNewChat" class="icon-btn" aria-label="New chat" title="New chat">＋</button>
        <button type="button" id="btnKey" class="icon-btn" aria-label="Set server password" title="Set server password" hidden>🔑</button>
        <button type="button" id="btnStop" class="icon-btn stop" aria-label="Stop generating" title="Stop generating" hidden>■</button>
      </div>
      <div id="modelPopover" class="popover" role="dialog" aria-label="Select a model" hidden>
        <input id="modelSearch" type="search" placeholder="Search models" aria-label="Search models" autocomplete="off" />
        <div id="modelList" class="model-list" role="listbox" aria-label="Models"></div>
      </div>
      <div id="agentPopover" class="popover" role="dialog" aria-label="Select an agent" hidden>
        <div id="agentList" class="model-list" role="listbox" aria-label="Agents"></div>
      </div>
      <div id="variantPopover" class="popover" role="dialog" aria-label="Select thinking effort" hidden>
        <div id="variantList" class="model-list" role="listbox" aria-label="Variants"></div>
      </div>
      <div id="sessionPanel" class="popover session-panel" role="dialog" aria-label="Sessions" hidden>
        <input id="sessionSearch" type="search" placeholder="Search sessions" aria-label="Search sessions" autocomplete="off" />
        <div id="sessionList" class="session-list" role="listbox" aria-label="Sessions"></div>
        <div class="session-actions">
          <button type="button" id="sessionMore" class="banner-btn">Load more</button>
          <button type="button" id="sessionNew" class="banner-btn primary">New chat</button>
        </div>
      </div>
    </header>

    <div id="banner" class="banner" role="alert" hidden>
      <span id="bannerIcon" class="banner-icon" aria-hidden="true">⚠</span>
      <div class="banner-content">
        <div id="bannerMessage" class="banner-message" dir="auto"></div>
        <details id="bannerDetailsWrap" class="banner-details" hidden>
          <summary>Details</summary>
          <pre id="bannerDetails"></pre>
        </details>
      </div>
      <div id="bannerActions" class="banner-actions"></div>
      <button type="button" id="bannerDismiss" class="icon-btn" aria-label="Dismiss message" title="Dismiss">✕</button>
    </div>

    <main id="messages" class="messages" role="log" aria-live="polite" aria-label="Conversation"></main>

    <section id="emptyState" class="empty-state" aria-label="Welcome">
      <div class="welcome-card">
        <div class="welcome-mark" aria-hidden="true">◍</div>
        <h1 class="welcome-title">OpenCode Bridge</h1>
        <p class="welcome-sub">Chat with your local OpenCode server. No API keys are handled here.</p>
        <p class="welcome-model">Model: <span id="welcomeModel">server default</span></p>
        <div class="suggestions">
          <button type="button" class="chip" data-suggestion="Explain the selected code in this file.">Explain the selected code</button>
          <button type="button" class="chip" data-suggestion="Find bugs in this file and suggest fixes.">Find bugs in this file</button>
          <button type="button" class="chip" data-suggestion="Write tests for this function.">Write tests for this function</button>
        </div>
      </div>
    </section>

    <button type="button" id="jumpLatest" class="jump-latest" hidden>↓ Jump to latest</button>

    <div id="status" class="status" role="status" aria-live="polite">
      <span id="statusText" class="status-text"></span>
      <button type="button" id="btnCancelWait" class="link-btn" hidden>Cancel</button>
    </div>

    <div id="contextBar" class="context-bar" hidden>
      <progress id="contextProgress" max="100" value="0" aria-label="Context window usage"></progress>
      <span id="contextText" class="context-text">0 / 0</span>
      <button type="button" id="btnCompact" class="link-btn" title="Compact the conversation">Compact</button>
    </div>
    <div id="compaction" class="compaction" role="status" aria-live="polite" hidden>
      <span class="spinner" aria-hidden="true">◌</span>
      <span id="compactionText">Compacting…</span>
    </div>

    <div id="slashPalette" class="slash-palette" role="listbox" aria-label="Commands" hidden></div>

    <form id="composer" class="composer">
      <textarea id="input" rows="1" dir="auto" placeholder="Ask OpenCode…  (Enter to send, Shift+Enter for newline, / for commands)" aria-label="Message OpenCode"></textarea>
      <button type="submit" id="btnSend" class="send-btn" aria-label="Send message">Send</button>
    </form>
  </div>
  <script src="${markdownUri}" nonce="${nonce}"></script>
  <script src="${slashUri}" nonce="${nonce}"></script>
  <script src="${jsUri}" nonce="${nonce}"></script>
</body>
</html>`;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Cryptographically-random nonce for CSP. */
function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
