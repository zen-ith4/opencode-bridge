/**
 * OpenCode Bridge - extension entry point.
 *
 * Activation flow:
 *  1. Read settings (hostname, port, autoStartServer, opencodePath, model, debug).
 *  2. Resolve basic-auth header (secret `opencodeBridge.serverPassword` first,
 *     then OPENCODE_SERVER_PASSWORD env var).
 *  3. Check if a server is already reachable at host/port.
 *  4. If not and autoStartServer: spawn `opencode serve --port <port>` with
 *     cwd = first workspace folder; wait up to ~10s; surface a clear error if
 *     the `opencode` binary is missing.
 *  5. Create + connect the SDK client.
 *  6. Register the sidebar chat view, commands, and Output channel.
 *  7. On deactivate, kill only the process we spawned.
 */

import * as vscode from "vscode";
import { OpenCodeChatView } from "./chatView.js";
import { OpencodeBridgeClient } from "./client.js";
import {
  buildBaseUrl,
  isServerReachable,
  isPortInUse,
  spawnOpencodeServe,
  waitForServer,
  resolveAuthHeader,
  ManagedServer,
  outputChannel,
  logError,
  logDebug,
  OUTPUT_CHANNEL_NAME,
} from "./server.js";

let chatView: OpenCodeChatView | undefined;
let managedServer: ManagedServer | undefined;
let client: OpencodeBridgeClient | undefined;
let currentSessionID: string | undefined;
let outputChan: vscode.OutputChannel | undefined;

/** Resolve settings with sane defaults. */
function getSettings() {
  const cfg = vscode.workspace.getConfiguration("opencodeBridge");
  return {
    port: cfg.get<number>("port", 4096),
    hostname: cfg.get<string>("hostname", "127.0.0.1"),
    autoStartServer: cfg.get<boolean>("autoStartServer", true),
    opencodePath: cfg.get<string>("opencodePath", "opencode"),
    model: cfg.get<string>("model", ""),
    debug: cfg.get<boolean>("debug", false),
  };
}

function firstWorkspaceFolder(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? folder.uri.fsPath : undefined;
}

async function ensureServerRunning(): Promise<void> {
  const { port, hostname, autoStartServer, opencodePath } = getSettings();

  const reachable = await isServerReachable(hostname, port);
  if (reachable.reachable) {
    logDebug(`server reachable at ${hostname}:${port}`, getSettings().debug);
    return;
  }

  logDebug(`no server at ${hostname}:${port}`, getSettings().debug);

  if (!autoStartServer) {
    throw new Error(
      `No OpenCode server is running at ${hostname}:${port} and autoStartServer is disabled. Start one manually (e.g. \`opencode serve --port ${port}\`) or enable opencodeBridge.autoStartServer.`
    );
  }

  // Avoid spawning if the port is occupied by something else (EADDRINUSE).
  const occupied = await isPortInUse(hostname, port);
  if (occupied) {
    throw new Error(
      `Port ${port} on ${hostname} is in use but not responding as an OpenCode server. Check what is listening on that port.`
    );
  }

  const cwd = firstWorkspaceFolder();
  logDebug(
    `spawning "${opencodePath} serve --port ${port}" cwd=${cwd ?? process.cwd()}`,
    getSettings().debug
  );

  const child = spawnOpencodeServe(opencodePath, port, hostname, cwd);

  managedServer = new ManagedServer({
    hostname,
    port,
    baseUrl: buildBaseUrl(hostname, port),
    spawnedProcess: child,
  });

  const ready = await waitForServer(hostname, port, 10_000);
  if (!ready) {
    managedServer.dispose();
    managedServer = undefined;
    throw new Error(
      `OpenCode server did not become reachable at ${hostname}:${port} within 10s. Check that "${opencodePath}" is installed and see the "${OUTPUT_CHANNEL_NAME}" output channel for details.`
    );
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log("[opencode-bridge] activating");
  outputChan = outputChannel();
  outputChan.appendLine("[opencode-bridge] activating");
  outputChan.show(true);

  const settings = getSettings();
  outputChan.appendLine(
    `[opencode-bridge] settings: ${settings.hostname}:${settings.port} autoStart=${settings.autoStartServer} debug=${settings.debug}`
  );

  // Resolve auth header from secret (preferred) or env var.
  const authHeader = await resolveAuthHeader(context);

  // Make sure a server is running.
  try {
    await ensureServerRunning();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChan.appendLine(`[opencode-bridge] server start failed: ${msg}`);
    void vscode.window.showErrorMessage(`OpenCode Bridge: ${msg}`);
  }

  const baseUrl = buildBaseUrl(settings.hostname, settings.port);
  client = new OpencodeBridgeClient(baseUrl, settings.debug);
  client.connect(authHeader);

  // Restore persisted model choice from globalState, fallback to setting.
  const persisted = context.globalState.get<{ providerID: string; modelID: string } | null>(
    "opencodeBridge.selectedModel",
    null
  );
  const modelFromSetting = settings.model
    ? parseModelString(settings.model)
    : null;
  const selectedModel = persisted ?? modelFromSetting;

  chatView = new OpenCodeChatView({
    client,
    extensionPath: context.extensionPath,
    sessionID: currentSessionID,
    debug: settings.debug,
    serverUrl: baseUrl,
    workspaceDir: firstWorkspaceFolder(),
  });
  if (selectedModel) {
    chatView.setSelectedModel(selectedModel);
  }
  chatView.register(context);

  // Commands.
  context.subscriptions.push(
    vscode.commands.registerCommand("opencode-bridge.openChat", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.opencode-bridge-sidebar");
    }),
    vscode.commands.registerCommand(
      "opencode-bridge.askSelection",
      async () => {
        await handleAskSelection();
      }
    ),
    vscode.commands.registerCommand("opencode-bridge.addFileContext", async () => {
      await handleAddFileContext();
    }),
    vscode.commands.registerCommand("opencode-bridge.setServerPassword", async () => {
      await handleSetServerPassword(context);
    })
  );

  // Watch for setting changes to keep model in sync.
  const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("opencodeBridge.model")) {
      const newModel = vscode.workspace
        .getConfiguration("opencodeBridge")
        .get<string>("model", "");
      const parsed = newModel ? parseModelString(newModel) : null;
      if (parsed) {
        context.globalState.update("opencodeBridge.selectedModel", parsed);
        chatView?.setSelectedModel(parsed);
        outputChan?.appendLine(`[opencode-bridge] model updated: ${parsed.providerID}/${parsed.modelID}`);
      }
    }
    if (e.affectsConfiguration("opencodeBridge.debug")) {
      const debug = vscode.workspace
        .getConfiguration("opencodeBridge")
        .get<boolean>("debug", false);
      client?.setDebug(debug);
      outputChan!.appendLine(`[opencode-bridge] debug=${debug}`);
    }
  });
  context.subscriptions.push(configWatcher);

  // Expose for testing / programmatic use.
  (globalThis as any).__opencodeBridge = {
    client,
    getSessionID: () => currentSessionID,
    setSessionID: (id: string) => {
      currentSessionID = id;
    },
  };

  console.log("[opencode-bridge] activated");
  outputChan.appendLine("[opencode-bridge] activated");
}

export function deactivate(): void {
  console.log("[opencode-bridge] deactivating");
  outputChan?.appendLine("[opencode-bridge] deactivating");
  if (managedServer) {
    managedServer.dispose();
    managedServer = undefined;
  }
  chatView?.dispose();
  chatView = undefined;
  client = undefined;
  outputChan?.hide();
}

/* ------------------------------------------------------------------ */
/* Editor integration commands                                        */
/* ------------------------------------------------------------------ */

async function handleAskSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("OpenCode Bridge: No active editor.");
    return;
  }
  const selection = editor.selection;
  const doc = editor.document;
  const selectedText = doc.getText(selection);
  if (!selectedText || !selectedText.trim()) {
    void vscode.window.showWarningMessage("OpenCode Bridge: No text selected.");
    return;
  }

  const start = selection.start;
  const end = selection.end;
  const rangeInfo = `${doc.uri.fsPath}:${start.line + 1}-${end.line + 1}`;

  const question = await vscode.window.showInputBox({
    prompt: `Ask OpenCode about the selection (${rangeInfo})`,
    placeHolder: "e.g. Explain this function and suggest improvements",
  });
  if (!question) return;

  const contextStr = `File: ${doc.uri.fsPath}\nLines: ${start.line + 1}-${end.line + 1}\nSelection:\n${selectedText}`;
  await sendToChat(`${question}\n\nContext:\n${contextStr}`);
}

async function handleAddFileContext(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("OpenCode Bridge: No active editor.");
    return;
  }
  const doc = editor.document;
  const contextStr = `File: ${doc.uri.fsPath}\n\n${doc.getText()}`;
  const question = await vscode.window.showInputBox({
    prompt: "Ask OpenCode about the current file",
    placeHolder: "e.g. Summarize this file",
  });
  if (!question) return;
  await sendToChat(`${question}\n\nContext:\n${contextStr}`);
}

/** "OpenCode: Set Server Password" - stores password in context.secrets. */
async function handleSetServerPassword(context: vscode.ExtensionContext): Promise<void> {
  const password = await vscode.window.showInputBox({
    prompt: "Enter the OpenCode server password (OPENCODE_SERVER_PASSWORD)",
    password: true,
    placeHolder: "e.g. a-long-secret",
  });
  if (password === undefined) return; // user cancelled
  if (!password) {
    void vscode.window.showWarningMessage("OpenCode Bridge: Password cannot be empty.");
    return;
  }
  try {
    await context.secrets.store("opencodeBridge.serverPassword", password);
    void vscode.window.showInformationMessage(
      "OpenCode Bridge: Server password stored securely. It will be used on next connection."
    );
    outputChan?.appendLine("[opencode-bridge] server password stored in secrets");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Failed to store password: ${msg}`);
    void vscode.window.showErrorMessage(`OpenCode Bridge: failed to store password: ${msg}`);
  }
}

async function sendToChat(text: string): Promise<void> {
  if (!chatView) {
    void vscode.window.showWarningMessage("OpenCode Bridge: Chat view not ready.");
    return;
  }
  // Reveal the sidebar.
  await vscode.commands.executeCommand(
    "workbench.view.extension.opencode-bridge-sidebar"
  );
  await chatView.sendMessage(text);
}

/** Parse a "providerID/modelID" string into components. */
function parseModelString(s: string): { providerID: string; modelID: string } | null {
  const idx = s.indexOf("/");
  if (idx <= 0 || idx === s.length - 1) return null;
  return { providerID: s.slice(0, idx), modelID: s.slice(idx + 1) };
}
