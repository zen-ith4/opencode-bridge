/**
 * OpenCode Bridge - managed `opencode serve` lifecycle (no `vscode` import).
 *
 * Managed mode:
 *  - Pick a free port (bind to port 0, read it, close, then pass it).
 *  - Generate a random password and pass it to the child ONLY through the
 *    `OPENCODE_SERVER_PASSWORD` env var (overriding any inherited value).
 *  - Wait for readiness, then keep the child alive: if it dies unexpectedly,
 *    restart it with exponential backoff (max 3 attempts by default).
 *  - Kill only the process this class spawned.
 *
 * This module is intentionally free of `vscode` imports so it can be unit
 * and integration tested with plain Node.
 */

import * as cp from "child_process";
import * as crypto from "crypto";
import * as net from "net";
import { logInfo, logError } from "./log.js";

export type ServerMode = "managed" | "external";

export interface ServerInfo {
  mode: ServerMode;
  hostname: string;
  port: number;
  /** e.g. http://127.0.0.1:4096/api */
  baseUrl: string;
  /** "Basic <base64>" or undefined */
  authHeader?: string;
  spawnedProcess?: cp.ChildProcess;
  /** Random password for managed mode; never logged. */
  password?: string;
}

/** Result of trying to reach a running server. */
export interface Reachability {
  reachable: boolean;
  statusCode?: number;
  error?: string;
}

/** How long (ms) to wait for a spawned server to become reachable. */
export const SERVER_READY_TIMEOUT_MS = 10_000;
/** Poll interval while waiting for the server. */
const POLL_INTERVAL_MS = 250;
/** Probe timeout per request. */
const PROBE_TIMEOUT_MS = 4_000;

/** Build the base URL including the `/api` prefix the server routes use. */
export function buildBaseUrl(hostname: string, port: number): string {
  return `http://${hostname}:${port}/api`;
}

/** Basic auth header from a password. Username is always "opencode". */
export function authHeaderFromPassword(password: string): string {
  return "Basic " + Buffer.from("opencode:" + password).toString("base64");
}

/** Generate a random server password (hex, 24 bytes = 48 chars). */
export function generateRandomPassword(): string {
  return crypto.randomBytes(24).toString("hex");
}

/** Find a free TCP port by binding to port 0, reading it, then closing. */
export async function findFreePort(hostname = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, hostname, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Probe `<baseUrl>/info` (baseUrl already contains `/api`). A 401/403 means
 * the server is up but requires auth. NEVER treats a 404 as "connected".
 */
export async function probeServer(
  baseUrl: string,
  authHeader?: string,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<Reachability> {
  const url = baseUrl.replace(/\/+$/, "") + "/info";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (authHeader) headers.Authorization = authHeader;
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    return { reachable: true, statusCode: res.status };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Check whether a server is running at host/port. */
export async function isServerReachable(
  hostname: string,
  port: number,
  authHeader?: string
): Promise<Reachability> {
  return probeServer(buildBaseUrl(hostname, port), authHeader);
}

/** Wait until the server responds (any status), up to timeoutMs. */
export async function waitForServer(
  hostname: string,
  port: number,
  authHeader?: string,
  timeoutMs = SERVER_READY_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await isServerReachable(hostname, port, authHeader);
    if (ok.reachable) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

/** Test whether a TCP port is currently occupied. */
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

export interface SpawnServeOptions {
  opencodePath: string;
  port: number;
  hostname: string;
  cwd?: string;
  password?: string;
  /** Optional logger; defaults to the shared Output-channel logger. */
  logger?: (message: string) => void;
}

/**
 * Spawn `opencode serve --hostname <h> --port <p>`.
 *
 * The password is passed ONLY as `OPENCODE_SERVER_PASSWORD`; any inherited
 * `OPENCODE_PASSWORD` is removed (req: keep only OPENCODE_SERVER_PASSWORD).
 *
 * Resolves once the process has actually spawned, rejects with a clear
 * message when the binary is missing (ENOENT).
 */
export function spawnOpencodeServe(opts: SpawnServeOptions): Promise<cp.ChildProcess> {
  const log = opts.logger ?? ((m: string) => logInfo(m));
  const args = ["serve", "--hostname", opts.hostname, "--port", String(opts.port)];

  // Copy the env but make auth explicit: never leak an inherited
  // OPENCODE_PASSWORD, and always set/clear OPENCODE_SERVER_PASSWORD.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.OPENCODE_PASSWORD;
  if (opts.password) {
    env.OPENCODE_SERVER_PASSWORD = opts.password;
  } else {
    delete env.OPENCODE_SERVER_PASSWORD;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(opts.opencodePath, args, {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reject(
        new Error(
          `Failed to start "${opts.opencodePath}": ${message}. Make sure the OpenCode CLI is installed and on PATH (or set opencodeBridge.opencodePath).`
        )
      );
      return;
    }

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Failed to start "${opts.opencodePath}": ${err.message}. Make sure the OpenCode CLI is installed and on PATH (or set opencodeBridge.opencodePath).`
        )
      );
    });

    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          log(`[opencode serve] ${text}`);
          // eslint-disable-next-line no-console
          console.log(`[opencode serve] ${text}`);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          log(`[opencode serve stderr] ${text}`);
          // eslint-disable-next-line no-console
          console.error(`[opencode serve stderr] ${text}`);
        }
      });
      resolve(child);
    });
  });
}

export interface ManagedServerOptions {
  opencodePath: string;
  hostname?: string;
  cwd?: string;
  /** Maximum automatic restarts after unexpected exits (default 3). */
  maxRestarts?: number;
  logger?: (message: string) => void;
  errorLogger?: (message: string) => void;
  /** Called after a successful restart with the new port/password. */
  onRestart?: (info: ServerInfo, attempt: number) => void | Promise<void>;
  /** Called after the last restart attempt fails. */
  onFatal?: (error: Error) => void | Promise<void>;
}

/**
 * Owns one private `opencode serve` child. Restarts it with backoff on
 * unexpected exit, and never touches processes it did not spawn.
 */
export class ManagedServer {
  public info!: ServerInfo;
  private readonly options: ManagedServerOptions;
  private disposed = false;
  private restarts = 0;
  private restartTimer?: NodeJS.Timeout;
  private starting = false;

  constructor(options: ManagedServerOptions) {
    this.options = options;
  }

  private get maxRestarts(): number {
    return this.options.maxRestarts ?? 3;
  }

  private log(message: string): void {
    (this.options.logger ?? logInfo)(message);
  }

  private logError(message: string): void {
    (this.options.errorLogger ?? logError)(message);
  }

  /** Start the child and wait for readiness. */
  async start(): Promise<ServerInfo> {
    if (this.starting) throw new Error("Managed server is already starting.");
    this.starting = true;
    try {
      const info = await this.spawnOnce();
      this.info = info;
      this.watchExit(info.spawnedProcess);
      return info;
    } finally {
      this.starting = false;
    }
  }

  private async spawnOnce(): Promise<ServerInfo> {
    const hostname = this.options.hostname ?? "127.0.0.1";
    const port = await findFreePort(hostname);
    const password = generateRandomPassword();
    const authHeader = authHeaderFromPassword(password);
    const baseUrl = buildBaseUrl(hostname, port);

    this.log(`managed mode: spawning opencode serve on ${baseUrl} (cwd=${this.options.cwd ?? process.cwd()})`);
    const child = await spawnOpencodeServe({
      opencodePath: this.options.opencodePath,
      port,
      hostname,
      cwd: this.options.cwd,
      password,
      logger: this.options.logger,
    });

    const ready = await waitForServer(hostname, port, authHeader, SERVER_READY_TIMEOUT_MS);
    if (!ready) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      throw new Error(
        `OpenCode server (managed mode) did not become reachable on ${baseUrl} within ${
          SERVER_READY_TIMEOUT_MS / 1000
        }s. Check that "${this.options.opencodePath}" is installed and see the "OpenCode Bridge" output channel for details.`
      );
    }

    // The password must actually be enforced: with auth => 200, without => 401.
    // A server that is listening but still initializing answers 5xx, so keep
    // polling briefly instead of accepting a half-started server.
    const probeDeadline = Date.now() + SERVER_READY_TIMEOUT_MS;
    let authed = await probeServer(baseUrl, authHeader);
    while (
      Date.now() < probeDeadline &&
      authed.reachable &&
      typeof authed.statusCode === "number" &&
      authed.statusCode >= 500
    ) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      authed = await probeServer(baseUrl, authHeader);
    }
    if (!authed.reachable || (authed.statusCode ?? 0) >= 500) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      throw new Error(
        `OpenCode server (managed mode) did not become ready on ${baseUrl} ` +
          `(HTTP ${authed.statusCode ?? "unreachable"}). See the "OpenCode Bridge" output channel.`
      );
    }
    if (authed.statusCode === 401 || authed.statusCode === 403) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      throw new Error(
        `OpenCode server (managed mode) rejected the generated password (HTTP ${authed.statusCode}). ` +
          `This can happen if the installed server ignores OPENCODE_SERVER_PASSWORD.`
      );
    }

    return {
      mode: "managed",
      hostname,
      port,
      baseUrl,
      authHeader,
      spawnedProcess: child,
      password,
    };
  }

  private watchExit(proc: cp.ChildProcess | undefined): void {
    if (!proc) return;
    proc.once("exit", (code, signal) => {
      if (this.disposed) return;
      this.logError(
        `managed server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}); scheduling restart`
      );
      void this.scheduleRestart();
    });
  }

  private async scheduleRestart(): Promise<void> {
    if (this.disposed) return;

    if (this.restarts >= this.maxRestarts) {
      const error = new Error(
        `The managed OpenCode server stopped and could not be restarted after ${this.maxRestarts} attempt(s). ` +
          `Open the "OpenCode Bridge" output channel for the server log.`
      );
      this.logError(error.message);
      await this.options.onFatal?.(error);
      return;
    }

    this.restarts += 1;
    const attempt = this.restarts;
    const delay = Math.min(500 * Math.pow(2, attempt - 1), 5_000);
    this.log(`managed mode: restarting in ${delay}ms (attempt ${attempt}/${this.maxRestarts})`);

    this.restartTimer = setTimeout(() => {
      void (async () => {
        if (this.disposed) return;
        try {
          const info = await this.spawnOnce();
          this.info = info;
          this.watchExit(info.spawnedProcess);
          this.log(`managed mode: restarted on ${info.baseUrl}`);
          await this.options.onRestart?.(info, attempt);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logError(`managed mode: restart attempt ${attempt} failed: ${message}`);
          await this.scheduleRestart();
        }
      })();
    }, delay);
  }

  /** Kill only the process this instance spawned. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const proc = this.info?.spawnedProcess;
    if (proc && !proc.killed) {
      try {
        proc.removeAllListeners("exit");
        proc.kill("SIGTERM");
        const killTimer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 2_000);
        killTimer.unref?.();
      } catch {
        /* ignore */
      }
    }
  }

  /** Whether the managed child is still alive. */
  isAlive(): boolean {
    const proc = this.info?.spawnedProcess;
    return !!proc && !proc.killed && proc.exitCode === null;
  }
}
