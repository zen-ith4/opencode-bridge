/**
 * OpenCode Bridge - extension entry point.
 *
 * Two server connection modes:
 *  - "managed" (default): the extension starts its OWN private `opencode
 *    serve` child on a free port with a random password (passed only via
 *    OPENCODE_SERVER_PASSWORD). It restarts the child with backoff if it
 *    dies, and shows a visible error when it cannot.
 *  - "external": connect to an existing server at hostname:port. Password
 *    lookup: secret store -> OPENCODE_SERVER_PASSWORD -> prompt. 401/403 is
 *    never retried silently; the user is asked for a password once, then a
 *    visible "Enter password" banner is shown.
 */

import * as vscode from "vscode";
import { OpenCodeChatView } from "./chatView.js";
import { OpencodeBridgeClient } from "./client.js";
import type { ChatBanner } from "./chatController.js";
import {
  buildBaseUrl,
  probeServer,
  ManagedServer,
  ServerMode,
  authHeaderFromPassword,
  resolveAuthHeader,
  outputChannel,
  showLogs,
  logError,
  logInfo,
  logDebug,
  logWarn,
  OUTPUT_CHANNEL_NAME,
} from "./server.js";

let chatView: OpenCodeChatView | undefined;
let managedServer: ManagedServer | undefined;
let client: OpencodeBridgeClient | undefined;
let currentMode: ServerMode = "managed";

const SELECTED_MODEL_KEY = "opencodeBridge.selectedModel";
const CURRENT_SESSION_KEY = "opencodeBridge.currentSessionID";

interface Settings {
  port: number;
  hostname: string;
  autoStartServer: boolean;
  opencodePath: string;
  model: string;
  serverMode: ServerMode;
  debug: boolean;
  responseTimeoutSeconds: number;
}

function getSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration("opencodeBridge");
  return {
    port: cfg.get<number>("port", 4096),
    hostname: cfg.get<string>("hostname", "127.0.0.1"),
    autoStartServer: cfg.get<boolean>("autoStartServer", true),
    opencodePath: cfg.get<string>("opencodePath", "opencode"),
    model: cfg.get<string>("model", ""),
    serverMode: cfg.get<string>("serverMode", "managed") as ServerMode,
    debug: cfg.get<boolean>("debug", false),
    responseTimeoutSeconds: cfg.get<number>("responseTimeoutSeconds", 120),
  };
}

function firstWorkspaceFolder(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? folder.uri.fsPath : undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel();
  logInfo("activating");

  const settings = getSettings();
  currentMode = settings.serverMode === "external" ? "external" : "managed";
  logDebug(
    `settings: mode=${currentMode} ${settings.hostname}:${settings.port} ` +
      `timeout=${settings.responseTimeoutSeconds}s debug=${settings.debug}`,
    true
  );

  let baseUrl = buildBaseUrl(settings.hostname, settings.port);
  let authHeader: string | undefined;
  let startupBanner: ChatBanner | undefined;

  if (currentMode === "managed") {
    managedServer = new ManagedServer({
      opencodePath: settings.opencodePath,
      hostname: "127.0.0.1",
      cwd: firstWorkspaceFolder(),
      maxRestarts: 3,
      logger: (message) => logInfo(message),
      errorLogger: (message) => logError(message),
      onRestart: async (info, attempt) => {
        logInfo(`managed server restarted on ${info.baseUrl}`);
        if (chatView) {
          await chatView.onServerRestarted(info.baseUrl, info.authHeader, attempt);
        } else if (client) {
          client.setBaseUrl(info.baseUrl);
          client.setAuthHeader(info.authHeader);
        }
      },
      onFatal: (error) => {
        const message =
          "The local OpenCode server stopped and could not be restarted after 3 attempts.";
        logError(`${message} ${error.message}`);
        chatView?.showBanner({
          kind: "error",
          message,
          details: error.message,
          source: "runtime",
          actions: [{ id: "open-logs", label: "Open logs" }],
        });
        void vscode.window.showErrorMessage(`OpenCode Bridge: ${message}`);
      },
    });

    try {
      const info = await managedServer.start();
      baseUrl = info.baseUrl;
      authHeader = info.authHeader;
      logInfo(`managed server ready on ${baseUrl}`);

      // The generated password must actually be enforced.
      const probe = await probeServer(baseUrl, authHeader);
      if (!probe.reachable) {
        startupBanner = {
          kind: "error",
          message: "The local OpenCode server started but is not reachable.",
          details: probe.error,
          source: "runtime",
          actions: [{ id: "open-logs", label: "Open logs" }],
        };
      } else if (probe.statusCode === 401 || probe.statusCode === 403) {
        startupBanner = {
          kind: "auth",
          message: "The local OpenCode server rejected the generated password.",
          details: `HTTP ${probe.statusCode} from ${baseUrl}/info`,
          source: "runtime",
          actions: [
            { id: "open-logs", label: "Open logs" },
            { id: "refresh", label: "Retry" },
          ],
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`managed server start failed: ${message}`);
      startupBanner = {
        kind: "error",
        message: "Could not start the local OpenCode server.",
        details: message,
        source: "runtime",
        actions: [
          { id: "open-logs", label: "Open logs" },
          { id: "refresh", label: "Retry" },
        ],
      };
      void vscode.window.showErrorMessage(`OpenCode Bridge: ${message}`);
      managedServer.dispose();
      managedServer = undefined;
    }
  } else {
    const external = await initializeExternalServer(context);
    baseUrl = external.baseUrl;
    authHeader = external.authHeader;
    if (external.banner) startupBanner = external.banner;
  }

  client = new OpencodeBridgeClient(baseUrl, settings.debug);
  client.connect(authHeader);

  // Restore model + current session (so the chat survives view reloads).
  const persistedModel = context.globalState.get<{ providerID: string; modelID: string } | null>(
    SELECTED_MODEL_KEY,
    null
  );
  const modelFromSetting = settings.model ? parseModelString(settings.model) : null;
  const selectedModel = persistedModel ?? modelFromSetting;
  const savedSession = context.globalState.get<string | undefined>(CURRENT_SESSION_KEY, undefined);

  chatView = new OpenCodeChatView({
    client,
    extensionPath: context.extensionPath,
    sessionID: savedSession,
    debug: settings.debug,
    serverUrl: baseUrl,
    workspaceDir: firstWorkspaceFolder(),
    mode: currentMode,
    getResponseTimeoutSeconds: () => getSettings().responseTimeoutSeconds,
    persistModel: (model) => {
      void context.globalState.update(SELECTED_MODEL_KEY, model);
    },
    persistSession: (sessionID) => {
      void context.globalState.update(CURRENT_SESSION_KEY, sessionID);
    },
    onSetPassword: () => promptAndApplyPassword(context),
    onEnterPassword: () => promptAndApplyPassword(context),
    onOpenLogs: () => showLogs(),
  });

  if (selectedModel) chatView.setSelectedModel(selectedModel);
  if (startupBanner) chatView.showBanner(startupBanner);
  chatView.register(context);

  registerCommands(context);
  registerConfigWatcher(context);

  // Exposed for debugging / tests (never contains the server password).
  (globalThis as any).__opencodeBridge = {
    client,
    getMode: () => currentMode,
    getSessionID: () => chatView?.getSessionID(),
    isGenerating: () => chatView?.isGenerating() ?? false,
  };

  logInfo("activated");
}

export function deactivate(): void {
  logInfo("deactivating");
  if (managedServer) {
    managedServer.dispose();
    managedServer = undefined;
  }
  chatView?.dispose();
  chatView = undefined;
  client = undefined;
}

/* ------------------------------------------------------------------ */
/* External mode / auth                                               */
/* ------------------------------------------------------------------ */

interface ExternalInitResult {
  baseUrl: string;
  authHeader?: string;
  banner?: ChatBanner;
}

async function initializeExternalServer(
  context: vscode.ExtensionContext
): Promise<ExternalInitResult> {
  const { hostname, port } = getSettings();
  const baseUrl = buildBaseUrl(hostname, port);
  let authHeader = await resolveAuthHeader(context);

  let probe = await probeServer(baseUrl, authHeader);
  if (!probe.reachable) {
    const message = `No OpenCode server reachable at ${hostname}:${port}. Start one manually (opencode serve --port ${port}) or switch opencodeBridge.serverMode to "managed".`;
    logError(message);
    return {
      baseUrl,
      authHeader,
      banner: {
        kind: "error",
        message: "No OpenCode server is reachable.",
        details: message,
        source: "runtime",
        actions: [
          { id: "refresh", label: "Retry" },
          { id: "open-logs", label: "Open logs" },
        ],
      },
    };
  }

  if (probe.statusCode === 401 || probe.statusCode === 403) {
    const password = await promptForPassword(context);
    if (password) {
      authHeader = authHeaderFromPassword(password);
      probe = await probeServer(baseUrl, authHeader);
    }
  }

  if (!probe.reachable) {
    const message = `Lost connection to ${hostname}:${port}.`;
    logError(message);
    return {
      baseUrl,
      authHeader,
      banner: {
        kind: "error",
        message: "Lost connection to the OpenCode server.",
        details: message,
        source: "runtime",
        actions: [{ id: "open-logs", label: "Open logs" }],
      },
    };
  }

  if (probe.statusCode === 401 || probe.statusCode === 403) {
    logWarn(`external server requires authentication (HTTP ${probe.statusCode})`);
    return {
      baseUrl,
      authHeader,
      banner: {
        kind: "auth",
        message: "Authentication required by the OpenCode server.",
        details: `HTTP ${probe.statusCode} from ${baseUrl}/info. Set the password or start the server without one.`,
        source: "runtime",
        actions: [
          { id: "enter-password", label: "Enter password" },
          { id: "refresh", label: "Retry" },
          { id: "open-logs", label: "Open logs" },
        ],
      },
    };
  }

  logInfo(`external server reachable at ${baseUrl} (HTTP ${probe.statusCode})`);
  return { baseUrl, authHeader };
}

async function promptForPassword(context: vscode.ExtensionContext): Promise<string | undefined> {
  const password = await vscode.window.showInputBox({
    prompt: "OpenCode server password",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "Basic-auth password (username is always \"opencode\")",
  });
  if (password === undefined) return undefined;
  if (!password) {
    void vscode.window.showWarningMessage("OpenCode Bridge: Password cannot be empty.");
    return undefined;
  }
  try {
    await context.secrets.store("opencodeBridge.serverPassword", password);
    logInfo("server password stored in the secret store");
    return password;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`failed to store password: ${message}`);
    void vscode.window.showErrorMessage(`OpenCode Bridge: failed to store password: ${message}`);
    return undefined;
  }
}

/** Prompt, store, reconnect the client + SSE stream, then refresh models. */
async function promptAndApplyPassword(context: vscode.ExtensionContext): Promise<void> {
  const password = await promptForPassword(context);
  if (!password) return;
  const authHeader = authHeaderFromPassword(password);
  if (chatView) {
    chatView.setAuthHeader(authHeader); // also restarts the SSE stream
    chatView.clearBanner();
    await chatView.refreshProviders();
  } else {
    client?.setAuthHeader(authHeader);
  }
}

/* ------------------------------------------------------------------ */
/* Commands / config                                                  */
/* ------------------------------------------------------------------ */

function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("opencode-bridge.openChat", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.opencode-bridge-sidebar");
    }),
    vscode.commands.registerCommand("opencode-bridge.askSelection", async () => {
      await handleAskSelection();
    }),
    vscode.commands.registerCommand("opencode-bridge.addFileContext", async () => {
      await handleAddFileContext();
    }),
    vscode.commands.registerCommand("opencode-bridge.setServerPassword", async () => {
      await promptAndApplyPassword(context);
    }),
    vscode.commands.registerCommand("opencode-bridge.clearServerPassword", async () => {
      await handleClearServerPassword(context);
    }),
    vscode.commands.registerCommand("opencode-bridge.showLogs", () => {
      showLogs();
    })
  );
}

async function handleClearServerPassword(context: vscode.ExtensionContext): Promise<void> {
  try {
    await context.secrets.delete("opencodeBridge.serverPassword");
    logInfo("server password cleared from the secret store");
    const authHeader = await resolveAuthHeader(context); // env fallback
    if (chatView) {
      chatView.setAuthHeader(authHeader);
      chatView.clearBanner();
      await chatView.refreshProviders();
    } else {
      client?.setAuthHeader(authHeader);
    }
    void vscode.window.showInformationMessage("OpenCode Bridge: Server password cleared.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`failed to clear password: ${message}`);
    void vscode.window.showErrorMessage(`OpenCode Bridge: failed to clear password: ${message}`);
  }
}

function registerConfigWatcher(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("opencodeBridge.model")) {
        const value = vscode.workspace.getConfiguration("opencodeBridge").get<string>("model", "");
        const parsed = value ? parseModelString(value) : null;
        if (parsed) {
          void context.globalState.update(SELECTED_MODEL_KEY, parsed);
          chatView?.setSelectedModel(parsed);
          logInfo(`model updated from settings: ${parsed.providerID}/${parsed.modelID}`);
        }
      }
      if (event.affectsConfiguration("opencodeBridge.debug")) {
        const debug = vscode.workspace.getConfiguration("opencodeBridge").get<boolean>("debug", false);
        client?.setDebug(debug);
        logInfo(`debug=${debug}`);
      }
      if (event.affectsConfiguration("opencodeBridge.serverMode")) {
        void vscode.window.showInformationMessage(
          "OpenCode Bridge: serverMode changed. Reload the window to apply the new mode."
        );
      }
    })
  );
}

/* ------------------------------------------------------------------ */
/* Editor integration                                                 */
/* ------------------------------------------------------------------ */

async function handleAskSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("OpenCode Bridge: No active editor.");
    return;
  }
  const { selection, document: doc } = editor;
  const selectedText = doc.getText(selection);
  if (!selectedText.trim()) {
    void vscode.window.showWarningMessage("OpenCode Bridge: No text selected.");
    return;
  }

  const range = `${doc.uri.fsPath}:${selection.start.line + 1}-${selection.end.line + 1}`;
  const question = await vscode.window.showInputBox({
    prompt: `Ask OpenCode about the selection (${range})`,
    placeHolder: "e.g. Explain this function and suggest improvements",
  });
  if (!question) return;

  const context = `File: ${doc.uri.fsPath}\nLines: ${
    selection.start.line + 1
  }-${selection.end.line + 1}\nSelection:\n${selectedText}`;
  await sendToChat(question, context);
}

async function handleAddFileContext(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("OpenCode Bridge: No active editor.");
    return;
  }
  const doc = editor.document;
  const question = await vscode.window.showInputBox({
    prompt: "Ask OpenCode about the current file",
    placeHolder: "e.g. Summarize this file",
  });
  if (!question) return;
  await sendToChat(question, `File: ${doc.uri.fsPath}\n\n${doc.getText()}`);
}

async function sendToChat(text: string, context?: string): Promise<void> {
  if (!chatView) {
    void vscode.window.showWarningMessage("OpenCode Bridge: Chat view is not ready yet.");
    return;
  }
  await vscode.commands.executeCommand("workbench.view.extension.opencode-bridge-sidebar");
  await chatView.sendMessage(text, context);
}

function parseModelString(value: string): { providerID: string; modelID: string } | null {
  const index = value.indexOf("/");
  if (index <= 0 || index === value.length - 1) return null;
  return { providerID: value.slice(0, index), modelID: value.slice(index + 1) };
}

/** Keeps the exported channel name referenced (used in error messages). */
void OUTPUT_CHANNEL_NAME;
