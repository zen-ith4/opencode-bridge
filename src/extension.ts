/**
 * OpenCode Bridge - extension entry point.
 *
 * Activation flow:
 *  1. Read settings (hostname, port, autoStartServer, opencodePath, model).
 *  2. Resolve basic-auth header (secret first, then OPENCODE_SERVER_PASSWORD env).
 *  3. Check if a server is already reachable at host/port.
 *  4. If not and autoStartServer: spawn `opencode serve --port <port>` with
 *     cwd = first workspace folder; wait up to ~10s; surface a clear error if
 *     the `opencode` binary is missing.
 *  5. Create + connect the SDK client.
 *  6. Register the sidebar chat view and commands.
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
} from "./server.js";

let chatView: OpenCodeChatView | undefined;
let managedServer: ManagedServer | undefined;
let client: OpencodeBridgeClient | undefined;
let currentSessionID: string | undefined;

/** Resolve settings with sane defaults. */
function getSettings() {
  const cfg = vscode.workspace.getConfiguration("opencodeBridge");
  return {
    port: cfg.get<number>("port", 4096),
    hostname: cfg.get<string>("hostname", "127.0.0.1"),
    autoStartServer: cfg.get<boolean>("autoStartServer", true),
    opencodePath: cfg.get<string>("opencodePath", "opencode"),
    model: cfg.get<string>("model", ""),
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
    console.log(
      `[opencode-bridge] server reachable at ${hostname}:${port}`
    );
    return;
  }

  console.log(`[opencode-bridge] no server at ${hostname}:${port}`);

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
  console.log(
    `[opencode-bridge] spawning "${opencodePath} serve --port ${port}" cwd=${cwd ?? process.cwd()}`
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
    // Give it one more moment, then surface a clear error.
    managedServer.dispose();
    managedServer = undefined;
    throw new Error(
      `OpenCode server did not become reachable at ${hostname}:${port} within 10s. Check that "${opencodePath}" is installed and see the output log for details.`
    );
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log("[opencode-bridge] activating");

  const settings = getSettings();

  // Resolve auth header from secret (preferred) or env var.
  const authHeader = await resolveAuthHeader(context);

  // Make sure a server is running.
  try {
    await ensureServerRunning();
  } catch (err) {
    // Surface a clear error but still register commands so the user can try again.
    void vscode.window.showErrorMessage(
      `OpenCode Bridge: ${errorMessage(err)}`
    );
  }

  const baseUrl = buildBaseUrl(settings.hostname, settings.port);
  client = new OpencodeBridgeClient(baseUrl);
  client.connect(authHeader);

  chatView = new OpenCodeChatView({
    client,
    extensionPath: context.extensionPath,
    sessionID: currentSessionID,
  });
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
    })
  );

  // Expose for testing / programmatic use.
  (globalThis as any).__opencodeBridge = { client, getSessionID: () => currentSessionID };

  console.log("[opencode-bridge] activated");
}

export function deactivate(): void {
  console.log("[opencode-bridge] deactivating");
  if (managedServer) {
    managedServer.dispose();
    managedServer = undefined;
  }
  chatView?.dispose();
  chatView = undefined;
  client = undefined;
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
    void vscode.window.showWarningMessage(
      "OpenCode Bridge: No text selected."
    );
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

  const context = `File: ${doc.uri.fsPath}\nLines: ${start.line + 1}-${end.line + 1}\nSelection:\n${selectedText}`;
  await sendToChat(`${question}\n\nContext:\n${context}`);
}

async function handleAddFileContext(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("OpenCode Bridge: No active editor.");
    return;
  }
  const doc = editor.document;
  const context = `File: ${doc.uri.fsPath}\n\n${doc.getText()}`;
  const question = await vscode.window.showInputBox({
    prompt: "Ask OpenCode about the current file",
    placeHolder: "e.g. Summarize this file",
  });
  if (!question) return;
  await sendToChat(`${question}\n\nContext:\n${context}`);
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

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}
