/**
 * OpenCode Bridge - logging without a hard dependency on `vscode`.
 *
 * The extension installs a sink that forwards to the "OpenCode Bridge"
 * Output channel. Pure modules (client, controller, managed server) call
 * these helpers, which keeps them unit-testable outside the extension host.
 *
 * Errors are always written. Debug lines are only written when the caller
 * passes `debug === true` so the Output channel does not get noisy.
 */

export interface LogSink {
  appendLine(value: string): void;
  show?(preserveFocus?: boolean): void;
}

let sink: LogSink | undefined;

/** Install the Output-channel sink (called once during activation). */
export function setLogSink(next: LogSink | undefined): void {
  sink = next;
}

/** The currently installed sink, if any. */
export function getLogSink(): LogSink | undefined {
  return sink;
}

function write(line: string): void {
  if (sink) {
    try {
      sink.appendLine(line);
      return;
    } catch {
      // Fall through to console.
    }
  }
  // eslint-disable-next-line no-console
  console.log(line);
}

function timestamp(): string {
  return new Date().toISOString();
}

/** Always-on informational line. */
export function logInfo(message: string): void {
  write(`[opencode-bridge] ${timestamp()} ${message}`);
}

/** Debug line. Written only when `debug` is true. */
export function logDebug(message: string, debug = false): void {
  if (!debug) return;
  const line = `[opencode-bridge] ${timestamp()} ${message}`;
  write(line);
  // eslint-disable-next-line no-console
  console.log(line);
}

/** Error line. Always written, never includes secrets. */
export function logError(message: string): void {
  const line = `[opencode-bridge] ${timestamp()} ERROR: ${message}`;
  write(line);
  // eslint-disable-next-line no-console
  console.error(line);
}

/** Warning line. Always written, never includes secrets. */
export function logWarn(message: string): void {
  const line = `[opencode-bridge] ${timestamp()} WARN: ${message}`;
  write(line);
  // eslint-disable-next-line no-console
  console.warn(line);
}
