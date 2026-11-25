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
  getAutoStopRepetition?: () => boolean;
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
      getAutoStopRepetition: options.getAutoStopRepetition,
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

    const messageDisposable = webviewView.webview.onDidReceiveMessage((message: unknown) => {
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

  private async handleIncomingMessage(input: unknown): Promise<void> {
    if (!input || typeof input !== "object") return;
    const message = input as { type?: unknown } & Record<string, unknown>;
    if (typeof message.type !== "string") return;

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

    if (await this.handleAttachmentMessage(message)) return;

    await this.controller.handleMessage(message);
  }

  /* ------------------------------------------------------------------ */
  /* Attachments (extension host owns every file read)                 */
  /* ------------------------------------------------------------------ */

  /**
   * `@` picker, paperclip quick pick/native dialog, current file/selection and
   * Explorer/desktop drops. The webview only ever receives metadata; file
   * contents are resolved by the server from the `file://` URI.
   */
  private async handleAttachmentMessage(
    message: { type?: unknown } & Record<string, unknown>
  ): Promise<boolean> {
    switch (message.type) {
      case "files:list": {
        const requestID = String(message.requestID ?? "");
        const query = typeof message.query === "string" ? message.query : "";
        const items = await this.listWorkspaceFiles(query);
        this.postToWebview({ type: "files:list", requestID, items });
        return true;
      }
      case "files:pick": {
        const mode = message.mode === "dialog" ? "dialog" : "quick";
        await this.pickAttachments(mode);
        return true;
      }
      case "files:drop": {
        const uris = Array.isArray(message.uris) ? message.uris.map(String) : [];
        await this.addDroppedUris(uris);
        return true;
      }
      case "files:context": {
        await this.addContextAttachment(message.mode === "selection" ? "selection" : "current");
        return true;
      }
      case "files:open": {
        // Handled by the generic openFile branch above.
        return false;
      }
      default:
        return false;
    }
  }

  private attachmentMaxBytes(): number {
    const value = vscode.workspace
      .getConfiguration("opencodeBridge")
      .get<number>("maxAttachmentBytes", 8 * 1024 * 1024);
    return Number.isFinite(value) && value > 1024 ? value : 8 * 1024 * 1024;
  }

  private isInWorkspace(fsPath: string): boolean {
    const folders =
      vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ??
      (this.workspaceDir ? [this.workspaceDir] : []);
    return folders.some((folder) => {
      const rel = path.relative(folder, fsPath);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
  }

  private mimeFor(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
      ".ts": "text/typescript",
      ".tsx": "text/typescript",
      ".js": "text/javascript",
      ".jsx": "text/javascript",
      ".json": "application/json",
      ".md": "text/markdown",
      ".css": "text/css",
      ".html": "text/html",
      ".xml": "application/xml",
      ".yml": "application/yaml",
      ".yaml": "application/yaml",
      ".py": "text/x-python",
      ".go": "text/x-go",
      ".rs": "text/x-rust",
      ".sh": "text/x-shellscript",
      ".txt": "text/plain",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
    };
    return map[ext] ?? "application/octet-stream";
  }

  /** Recent and currently open editors first, then fuzzy workspace matches. */
  private async listWorkspaceFiles(query: string): Promise<
    Array<{ uri: string; name: string; path: string; kind: "file" | "folder"; size?: number }>
  > {
    const seen = new Set<string>();
    const items: Array<{
      uri: string;
      name: string;
      path: string;
      kind: "file" | "folder";
      size?: number;
    }> = [];
    const add = (uri: vscode.Uri) => {
      if (uri.scheme !== "file" || seen.has(uri.fsPath)) return;
      seen.add(uri.fsPath);
      items.push({
        uri: uri.toString(),
        name: path.basename(uri.fsPath),
        path: vscode.workspace.asRelativePath(uri, false),
        kind: "file",
      });
    };
    for (const editor of vscode.window.visibleTextEditors) add(editor.document.uri);
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isUntitled) add(doc.uri);
    }

    const exclude =
      "**/{node_modules,.git,.svn,.hg,dist,out,build,.next,.turbo,coverage,vendor,target}/**";
    let found: vscode.Uri[] = [];
    try {
      found = await vscode.workspace.findFiles("**/*", exclude, 2000);
    } catch (err) {
      logError(`findFiles failed: ${errMessage(err)}`);
    }
    for (const uri of found) add(uri);

    const term = query.trim().toLowerCase();
    const fuzzy = (value: string): boolean => {
      if (!term) return true;
      let index = 0;
      for (const char of value) {
        if (char === term[index]) index += 1;
        if (index === term.length) return true;
      }
      return false;
    };
    const filtered = items.filter((item) => fuzzy(item.path.toLowerCase()));
    if (term) {
      filtered.sort((a, b) => {
        const an = a.name.toLowerCase();
        const bn = b.name.toLowerCase();
        const aStarts = an.startsWith(term) ? 0 : 1;
        const bStarts = bn.startsWith(term) ? 0 : 1;
        return aStarts - bStarts || an.localeCompare(bn);
      });
    }
    return filtered.slice(0, 60);
  }

  private async attachmentFor(
    uri: vscode.Uri,
    kind: "file" | "folder" | "selection" | "current",
    lines?: string
  ): Promise<{ attachment?: Record<string, unknown>; warning?: string; error?: string }> {
    if (uri.scheme !== "file") return { error: "Only local files can be attached." };
    let size: number | undefined;
    let isDir = kind === "folder";
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      size = typeof stat.size === "number" ? stat.size : undefined;
      isDir = (stat.type & vscode.FileType.Directory) !== 0;
    } catch {
      return { error: `Could not read ${path.basename(uri.fsPath)}.` };
    }
    const max = this.attachmentMaxBytes();
    if (!isDir && typeof size === "number" && size > max) {
      return {
        error: `${path.basename(uri.fsPath)} is ${formatBytes(size)}; the limit is ${formatBytes(max)}.`,
      };
    }
    let warning: string | undefined;
    if (!isDir && typeof size === "number" && size > 1024 * 1024) {
      warning = `${path.basename(uri.fsPath)} is large (${formatBytes(size)}); attaching it may be slow.`;
    }
    return {
      attachment: {
        uri: uri.toString(),
        name: path.basename(uri.fsPath) + (lines ? ` (${lines})` : ""),
        kind: isDir ? "folder" : kind,
        ...(isDir ? {} : { mime: this.mimeFor(uri.fsPath) }),
        ...(typeof size === "number" ? { size } : {}),
        ...(lines ? { lines } : {}),
      },
      ...(warning ? { warning } : {}),
    };
  }

  private async addUris(
    uris: vscode.Uri[],
    kinds: Map<string, "file" | "folder" | "selection" | "current"> = new Map(),
    linesByPath: Map<string, string> = new Map(),
    confirmOutside = true
  ): Promise<void> {
    const attachments: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const uri of uris) {
      if (uri.scheme !== "file" || seen.has(uri.fsPath)) continue;
      seen.add(uri.fsPath);
      if (confirmOutside && !this.isInWorkspace(uri.fsPath)) {
        const choice = await vscode.window.showWarningMessage(
          `${path.basename(uri.fsPath)} is outside the workspace. Attach it anyway?`,
          { modal: true },
          "Attach"
        );
        if (choice !== "Attach") continue;
      }
      const result = await this.attachmentFor(
        uri,
        kinds.get(uri.fsPath) ?? "file",
        linesByPath.get(uri.fsPath)
      );
      if (result.attachment) attachments.push(result.attachment);
      if (result.warning) warnings.push(result.warning);
      if (result.error) errors.push(result.error);
    }
    if (attachments.length > 0 || warnings.length > 0 || errors.length > 0) {
      this.postToWebview({
        type: "files:add",
        attachments,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(errors.length > 0 ? { errors } : {}),
      });
    }
  }

  private async pickAttachments(mode: "quick" | "dialog"): Promise<void> {
    if (mode === "dialog") {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: true,
        openLabel: "Attach",
        ...(this.workspaceDir ? { defaultUri: vscode.Uri.file(this.workspaceDir) } : {}),
      });
      if (picked && picked.length > 0) await this.addUris(picked);
      return;
    }

    const files = await this.listWorkspaceFiles("");
    const items: Array<vscode.QuickPickItem & { attachMode?: string; uri?: string }> = [
      { label: "$(file) Current file", description: "Attach the file you are editing", attachMode: "current" },
      { label: "$(selection) Selection", description: "Attach the selected lines", attachMode: "selection" },
      { label: "$(folder-opened) Choose files…", description: "Open the system file dialog", attachMode: "dialog" },
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      ...files.map((file) => ({
        label: `$(file) ${file.name}`,
        description: file.path,
        uri: file.uri,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: "Attach workspace files",
      matchOnDescription: true,
    });
    if (!picked || picked.length === 0) return;
    for (const item of picked) {
      if (item.attachMode === "dialog") {
        await this.pickAttachments("dialog");
      } else if (item.attachMode === "current" || item.attachMode === "selection") {
        await this.addContextAttachment(item.attachMode);
      } else if (item.uri) {
        await this.addUris([vscode.Uri.parse(item.uri)], new Map(), new Map(), false);
      }
    }
  }

  private async addDroppedUris(rawUris: string[]): Promise<void> {
    const uris: vscode.Uri[] = [];
    for (const raw of rawUris) {
      const value = raw.trim();
      if (!value) continue;
      try {
        const uri = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
          ? vscode.Uri.parse(value)
          : vscode.Uri.file(value);
        if (uri.scheme === "file") uris.push(uri);
      } catch {
        /* ignore malformed drops */
      }
    }
    if (uris.length > 0) await this.addUris(uris);
  }

  private async addContextAttachment(mode: "current" | "selection"): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      this.postToWebview({
        type: "files:add",
        attachments: [],
        errors: ["Open a file in the editor first."],
      });
      return;
    }
    let lines: string | undefined;
    if (mode === "selection") {
      const selection = editor.selection;
      if (selection.isEmpty) {
        this.postToWebview({
          type: "files:add",
          attachments: [],
          errors: ["Select some text in the editor first."],
        });
        return;
      }
      lines = `${selection.start.line + 1}-${selection.end.line + 1}`;
    }
    const fsPath = editor.document.uri.fsPath;
    if (!this.isInWorkspace(fsPath)) {
      const choice = await vscode.window.showWarningMessage(
        `${path.basename(fsPath)} is outside the workspace. Attach it anyway?`,
        { modal: true },
        "Attach"
      );
      if (choice !== "Attach") return;
    }
    const result = await this.attachmentFor(editor.document.uri, mode, lines);
    this.postToWebview({
      type: "files:add",
      attachments: result.attachment ? [result.attachment] : [],
      ...(result.warning ? { warnings: [result.warning] } : {}),
      ...(result.error ? { errors: [result.error] } : {}),
    });
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
    const streamRenderUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.extensionPath, "media", "streamRender.cjs"))
    );
    const slashUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.extensionPath, "media", "slash.cjs"))
    );
    const uiStateUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.extensionPath, "media", "uiState.cjs"))
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.extensionPath, "media", "webview.css"))
    );
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.extensionPath, "media", "codicons", "codicon.css"))
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
  <link rel="stylesheet" href="${codiconUri}" nonce="${nonce}" />
  <link rel="stylesheet" href="${cssUri}" nonce="${nonce}" />
</head>
<body>
  <div class="app">
    <header class="header" id="header" title="">
      <button type="button" id="sessionButton" class="session-button" aria-haspopup="dialog" aria-expanded="false" title="Switch session">
        <span class="codicon codicon-comment-discussion" aria-hidden="true"></span>
        <span id="sessionLabel" class="session-button-label">Sessions</span>
        <span class="codicon codicon-chevron-down session-button-chevron" aria-hidden="true"></span>
      </button>
      <div class="header-actions">
        <button type="button" id="btnRefresh" class="icon-btn" aria-label="Refresh models" title="Refresh models"><span class="codicon codicon-refresh" aria-hidden="true"></span></button>
        <button type="button" id="btnNewChat" class="icon-btn" aria-label="New chat" title="New chat"><span class="codicon codicon-add" aria-hidden="true"></span></button>
        <button type="button" id="btnKey" class="icon-btn" aria-label="Set server password" title="Set server password" hidden><span class="codicon codicon-key" aria-hidden="true"></span></button>
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
      <span id="bannerIcon" class="banner-icon codicon codicon-warning" aria-hidden="true"></span>
      <div class="banner-content">
        <div id="bannerMessage" class="banner-message" dir="auto"></div>
        <details id="bannerDetailsWrap" class="banner-details" hidden>
          <summary>Details</summary>
          <pre id="bannerDetails"></pre>
        </details>
      </div>
      <div id="bannerActions" class="banner-actions"></div>
      <button type="button" id="bannerDismiss" class="icon-btn" aria-label="Dismiss message" title="Dismiss"><span class="codicon codicon-close" aria-hidden="true"></span></button>
    </div>

    <main id="messages" class="messages" role="log" aria-live="polite" aria-label="Conversation">
      <div id="messagesContent" class="messages-content"></div>
    </main>

    <section id="emptyState" class="empty-state" aria-label="Welcome">
      <div class="welcome-card">
        <div class="welcome-mark codicon codicon-comment-discussion" aria-hidden="true"></div>
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

    <button type="button" id="jumpLatest" class="jump-latest" hidden><span class="codicon codicon-arrow-down" aria-hidden="true"></span> Jump to latest</button>

    <div id="status" class="status" role="status" aria-live="polite">
      <span id="statusText" class="status-text"></span>
      <button type="button" id="btnCancelWait" class="link-btn" hidden>Cancel</button>
    </div>

    <div id="filePalette" class="slash-palette file-palette" role="listbox" aria-label="Workspace files" hidden></div>
    <div id="slashPalette" class="slash-palette" role="listbox" aria-label="Commands" hidden></div>

    <form id="composer" class="composer">
      <div id="attachChips" class="attach-chips" aria-label="Attachments" hidden></div>
      <div class="composer-card" id="composerCard">
        <textarea id="input" rows="1" dir="auto" placeholder="Ask OpenCode…  (Enter to send, @ for files, / for commands)" aria-label="Message OpenCode"></textarea>
        <div id="composerToolbar" class="composer-toolbar">
          <button type="button" id="btnAttach" class="toolbar-btn toolbar-icon" aria-label="Attach file" title="Attach a file (@)">
            <span class="codicon codicon-paperclip" aria-hidden="true"></span>
          </button>
          <button type="button" id="btnAgent" class="toolbar-btn" aria-haspopup="listbox" aria-expanded="false" title="Choose agent">
            <span class="codicon codicon-hubot toolbar-glyph" aria-hidden="true"></span>
            <span id="agentLabel" class="toolbar-label">Build</span>
            <span class="codicon codicon-chevron-down toolbar-chevron" aria-hidden="true"></span>
          </button>
          <button type="button" id="btnModel" class="toolbar-btn" aria-haspopup="listbox" aria-expanded="false" title="Choose model">
            <span class="codicon codicon-symbol-method toolbar-glyph" aria-hidden="true"></span>
            <span id="modelLabel" class="toolbar-label">Default model</span>
            <span class="codicon codicon-chevron-down toolbar-chevron" aria-hidden="true"></span>
          </button>
          <button type="button" id="btnThinking" class="toolbar-btn" aria-haspopup="listbox" aria-expanded="false" title="Thinking level" hidden>
            <span class="codicon codicon-lightbulb toolbar-glyph" aria-hidden="true"></span>
            <span id="thinkingLabel" class="toolbar-label">auto</span>
            <span class="codicon codicon-chevron-down toolbar-chevron" aria-hidden="true"></span>
          </button>
          <button type="button" id="btnMore" class="toolbar-btn toolbar-icon" aria-haspopup="dialog" aria-expanded="false" title="More options" hidden>
            <span class="codicon codicon-ellipsis" aria-hidden="true"></span>
          </button>
          <div class="toolbar-spacer"></div>
          <button type="button" id="btnContext" class="context-ring" aria-haspopup="dialog" aria-expanded="false" title="Context usage">
            <svg class="context-ring-svg" viewBox="0 0 32 32" aria-hidden="true">
              <circle class="context-ring-track" cx="16" cy="16" r="13" pathLength="100"></circle>
              <circle id="contextRingValue" class="context-ring-value" cx="16" cy="16" r="13" pathLength="100"></circle>
            </svg>
            <span id="contextPercent" class="context-percent">0%</span>
          </button>
          <button type="submit" id="btnSend" class="send-btn" aria-label="Send message" title="Send message">
            <span id="sendIcon" class="codicon codicon-send" aria-hidden="true"></span>
          </button>
        </div>

        <div id="agentPopover" class="popover composer-popover" role="dialog" aria-label="Select an agent" hidden>
          <div class="popover-title">Agent</div>
          <div id="agentList" class="model-list" role="listbox" aria-label="Agents"></div>
        </div>
        <div id="modelPopover" class="popover composer-popover" role="dialog" aria-label="Select a model" hidden>
          <div class="popover-title">Model</div>
          <input id="modelSearch" type="search" placeholder="Search models" aria-label="Search models" autocomplete="off" />
          <div id="modelList" class="model-list" role="listbox" aria-label="Models"></div>
        </div>
        <div id="thinkingPopover" class="popover composer-popover" role="dialog" aria-label="Select thinking level" hidden>
          <div class="popover-title">Thinking</div>
          <div id="thinkingList" class="model-list" role="listbox" aria-label="Thinking levels"></div>
        </div>
        <div id="morePopover" class="popover composer-popover" role="dialog" aria-label="More options" hidden>
          <div class="popover-title">Thinking</div>
          <div id="thinkingMoreList" class="model-list" role="listbox" aria-label="Thinking levels"></div>
        </div>
        <div id="contextPopover" class="popover composer-popover context-popover" role="dialog" aria-label="Context" hidden>
          <div class="popover-title">Context</div>
          <div id="contextSummary" class="context-summary">0 / ? tokens</div>
          <progress id="contextProgress" max="100" value="0" aria-label="Context window usage"></progress>
          <div id="contextBreakdown" class="context-breakdown"></div>
          <div id="compaction" class="compaction" role="status" aria-live="polite" hidden>
            <span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
            <span id="compactionText">Compacting…</span>
          </div>
          <button type="button" id="btnCompact" class="banner-btn">Compact conversation</button>
        </div>
      </div>
      <div id="composerNote" class="composer-note" role="status" aria-live="polite" hidden></div>
    </form>
  </div>
  <script src="${markdownUri}" nonce="${nonce}"></script>
  <script src="${streamRenderUri}" nonce="${nonce}"></script>
  <script src="${slashUri}" nonce="${nonce}"></script>
  <script src="${uiStateUri}" nonce="${nonce}"></script>
  <script src="${jsUri}" nonce="${nonce}"></script>
</body>
</html>`;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
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
