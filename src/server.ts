/**
 * OpenCode Bridge - server lifecycle management.
 *
 * Responsibilities:
 *  - Check whether an OpenCode HTTP server (`opencode serve`) is already
 *    reachable at the configured host/port (GET /api/info).
 *  - If not (and autoStartServer is enabled), spawn `opencode serve --port <port>`
 *    with cwd set to the first workspace folder, wait for it to respond (~10s).
 *  - Report a clear error when the `opencode` binary is not found in PATH.
 *  - Keep track of the child process the extension spawned so it can be killed
 *    on deactivate (only OUR process is ever killed).
 *  - Resolve optional basic auth from the OPENCODE_SERVER_PASSWORD env var or
 *    the context.secrets entry `opencodeBridge.serverPassword`.
 *  - Write diagnostics to the "OpenCode Bridge" Output channel.
 */

import * as cp from "child_process";
import * as net from "net";
import * as vscode from "vscode";

export interface ServerInfo {
  hostname: string;
  port: number;
  baseUrl: string; // e.g. http://127.0.0.1:4096/api
  authHeader?: string; // "Basic <base64>" or undefined
  spawnedProcess?: cp.ChildProcess;
}

/** Result of trying to reach a running server. */
export interface Reachability {
  reachable: boolean;
  statusCode?: number;
  error?: string;
}

/** How long (ms) to wait for a spawned server to become reachable. */
const SERVER_READY_TIMEOUT_MS = 10_000;
/** Poll interval while waiting for the server. */
const POLL_INTERVAL_MS = 250;
/** Path used to probe whether a server is up. `/api/info` returns server info. */
const PROBE_PATH = "/api/info";

/** The Output channel name used for all OpenCode Bridge diagnostics. */
export const OUTPUT_CHANNEL_NAME = "OpenCode Bridge";

let _outputChannel: vscode.OutputChannel | undefined;

/** Get (lazily creating) the Output channel. */
export function outputChannel(): vscode.OutputChannel {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  }
  return _outputChannel;
}

/** Write a debug line to the Output channel (and console if debug is on). */
export function logDebug(message: string, debug = false): void {
  const line = `[opencode-bridge] ${new Date().toISOString()} ${message}`;
  outputChannel().appendLine(line);
  if (debug) console.log(line);
}

/** Write an error line to the Output channel (and console). */
export function logError(message: string): void {
  const line = `[opencode-bridge] ${new Date().toISOString()} ERROR: ${message}`;
  outputChannel().appendLine(line);
  console.error(line);
}

/**
 * Build the base URL (including the /api prefix the server routes use)
 * from host and port.
 */
export function buildBaseUrl(hostname: string, port: number): string {
  return `http://${hostname}:${port}/api`;
}

/** Basic auth header from the OPENCODE_SERVER_PASSWORD env var. */
function envAuthHeader(): string | undefined {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return undefined;
  return "Basic " + Buffer.from("opencode:" + password).toString("base64");
}

/**
 * Fetch a path against the server and report reachability. Uses a short
 * timeout so the probe fails fast when nothing is listening.
 * Any HTTP response (including 401) means a server is reachable.
 */
async function probe(hostname: string, port: number): Promise<Reachability> {
  const url = `http://${hostname}:${port}${PROBE_PATH}`;
  const controller = new AbortController();
  let settled = false;

  const timeoutId = setTimeout(() => {
    if (!settled) {
      settled = true;
      controller.abort();
    }
  }, 4000);

  try {
    const headers: Record<string, string> = {};
    const ah = envAuthHeader();
    if (ah) headers.Authorization = ah;
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    settled = true;
    clearTimeout(timeoutId);
    return { reachable: true, statusCode: res.status };
  } catch (err) {
    settled = true;
    clearTimeout(timeoutId);
    return {
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Check whether a server is already running at host/port.
 */
export async function isServerReachable(hostname: string, port: number): Promise<Reachability> {
  return probe(hostname, port);
}

/**
 * Wait until the server responds, up to timeoutMs. Resolves true as soon
 * as it is reachable; false on timeout.
 */
export async function waitForServer(
  hostname: string,
  port: number,
  timeoutMs = SERVER_READY_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await isServerReachable(hostname, port);
    if (ok.reachable) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Test whether a TCP port is currently occupied (to avoid spawning a server
 * that would immediately fail with EADDRINUSE).
 */
export function isPortInUse(hostname: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    sock.once("connect", () => {
      settled = true;
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
    sock.setTimeout(1500, () => {
      if (!settled) {
        settled = true;
        sock.destroy();
        resolve(false);
      }
    });
    sock.connect(port, hostname);
  });
}

/**
 * Spawn `opencode serve --port <port>` with cwd = first workspace folder.
 * Returns the ChildProcess. The caller is responsible for disposing it on
 * deactivate. Throws a clear error if the binary is missing (ENOENT).
 */
export function spawnOpencodeServe(
  opencodePath: string,
  port: number,
  hostname: string,
  cwd?: string
): cp.ChildProcess {
  const args = ["serve", "--hostname", hostname, "--port", String(port)];
  const options: cp.SpawnOptions = {};
  if (cwd) options.cwd = cwd;
  options.stdio = ["ignore", "pipe", "pipe"];

  let child: cp.ChildProcess;
  try {
    child = cp.spawn(opencodePath, args, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to spawn "${opencodePath}": ${message}. Make sure the OpenCode CLI is installed and on PATH (or set opencodeBridge.opencodePath).`
    );
  }

  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      outputChannel().appendLine(`[opencode serve] ${text}`);
      console.log(`[opencode serve] ${text}`);
    }
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      outputChannel().appendLine(`[opencode serve stderr] ${text}`);
      console.error(`[opencode serve stderr] ${text}`);
    }
  });

  return child;
}

/**
 * Resolve the basic-auth header from settings secret + env var fallback.
 * The secret takes precedence when set.
 */
export async function resolveAuthHeader(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  // 1) Secret stored via context.secrets (per-machine, not in settings.json).
  try {
    const secret = await context.secrets.get("opencodeBridge.serverPassword");
    if (secret) {
      return "Basic " + Buffer.from("opencode:" + secret).toString("base64");
    }
  } catch {
    // secrets API may not be available in some contexts; fall through.
  }
  // 2) Environment variable (useful for CI / manual launch).
  return envAuthHeader();
}

/**
 * ManagedServer tracks a server instance: whether we spawned it (so we can
 * kill it on deactivate) and the resolved base URL / auth header.
 */
export class ManagedServer {
  public readonly info: ServerInfo;
  private disposed = false;

  constructor(info: ServerInfo) {
    this.info = info;
  }

  /** Kill only the process we spawned ourselves, if still running. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const proc = this.info.spawnedProcess;
    if (proc && !proc.killed) {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }
}
