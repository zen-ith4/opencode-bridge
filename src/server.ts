/**
 * OpenCode Bridge - `vscode` adapter for the pure lifecycle modules.
 *
 * Provides the "OpenCode Bridge" Output channel, secret storage and the
 * re-exports used by the extension. The process management itself lives in
 * `managedServer.ts` (no `vscode` import) so it can be tested with Node.
 */

import * as vscode from "vscode";
import { setLogSink } from "./log.js";
import { authHeaderFromPassword } from "./managedServer.js";

export * from "./managedServer.js";
export { logDebug, logError, logInfo, logWarn } from "./log.js";

/** The Output channel name used for all OpenCode Bridge diagnostics. */
export const OUTPUT_CHANNEL_NAME = "OpenCode Bridge";

let _outputChannel: vscode.OutputChannel | undefined;

/** Get (lazily creating) the Output channel and install it as the log sink. */
export function outputChannel(): vscode.OutputChannel {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    setLogSink(_outputChannel);
  }
  return _outputChannel;
}

/** Show the Output channel (command "OpenCode: Show Logs"). */
export function showLogs(): void {
  outputChannel().show(true);
}

/** Basic auth header from the OPENCODE_SERVER_PASSWORD env var. */
function envAuthHeader(): string | undefined {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return undefined;
  return authHeaderFromPassword(password);
}

/** Read OPENCODE_SERVER_PASSWORD from process env (no secrets API needed). */
export function envAuthHeaderFromProcess(): string | undefined {
  return envAuthHeader();
}

/**
 * Resolve the basic-auth header from the secret store + env fallback.
 * The secret takes precedence when set. Never logs the password.
 */
export async function resolveAuthHeader(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  try {
    const secret = await context.secrets.get("opencodeBridge.serverPassword");
    if (secret) return authHeaderFromPassword(secret);
  } catch {
    // Secrets API may be unavailable; fall through to env.
  }
  return envAuthHeader();
}
