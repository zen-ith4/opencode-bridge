/**
 * OpenCode Bridge - chat controller.
 *
 * All chat behaviour lives here and it deliberately has **no** `vscode`
 * import: `chatView.ts` is a thin adapter that forwards webview messages in
 * and `postMessage` payloads out. That makes the "does Send actually prompt?"
 * path testable with plain Node (see `test/chatController.test.mjs`).
 */

import type { BridgeEvent, TextDelta } from "./events.js";
import { extractTextDelta, shouldHandleEvent } from "./events.js";
import { classifyFailure, isAbortLikeError, isProviderFailure } from "./errors.js";
import type { FailureInfo } from "./errors.js";
import { detectRepetition, describeRepetition } from "./repetition.js";
import type { RepetitionHit } from "./repetition.js";
import { logDebug, logError, logWarn } from "./log.js";
import type {
  BridgeAgent,
  BridgeAttachment,
  BridgeCommand,
  BridgeMessage,
  BridgeModel,
  BridgeSessionSummary,
  BridgeSkill,
  FileDiffInfo,
  FormInfo,
  PermissionDecision,
  PermissionRequest,
  PromptFileInput,
  TokenUsage,
} from "./client.js";

export interface ModelRef {
  providerID: string;
  modelID: string;
  variant?: string;
}

export type BridgeModelLike = BridgeModel;
export type BridgeProviderLike = { id: string; name: string };
export type BridgeMessageLike = BridgeMessage;

/** The subset of OpencodeBridgeClient the controller depends on. */
export interface ChatClientLike {
  createSession(opts: {
    title?: string;
    directory?: string;
    model?: ModelRef;
    agent?: string;
  }): Promise<{ id: string }>;
  prompt(opts: {
    sessionID: string;
    text: string;
    model?: ModelRef;
    files?: PromptFileInput[];
  }): Promise<{ messageID: string }>;
  getProviders(): Promise<BridgeProviderLike[]>;
  getModels(): Promise<BridgeModelLike[]>;
  getMessages(sessionID: string): Promise<BridgeMessageLike[]>;
  interrupt(sessionID: string): Promise<void>;
  /** Optional: detach blocking work (subagents) and keep it running. */
  backgroundSession?(sessionID: string): Promise<boolean>;
  streamEvents(opts: {
    signal: AbortSignal;
    onEvent: (event: BridgeEvent) => void;
  }): Promise<void>;
  setAuthHeader?(authHeader: string | undefined): void;
  setBaseUrl?(baseUrl: string): void;
  /** Optional so the existing unit-test fake keeps working. */
  getAgents?(directory?: string): Promise<BridgeAgent[]>;
  setSessionAgent?(sessionID: string, agent: string): Promise<void>;
  getCommands?(directory?: string): Promise<BridgeCommand[]>;
  getSkills?(directory?: string): Promise<BridgeSkill[]>;
  listSessions?(opts?: {
    limit?: number;
    order?: "asc" | "desc";
    search?: string;
    directory?: string;
    cursor?: string;
  }): Promise<{ sessions: BridgeSessionSummary[]; next?: string }>;
  getActiveSessions?(): Promise<string[]>;
  getSession?(sessionID: string): Promise<BridgeSessionSummary | null>;
  setSessionModel?(sessionID: string, model: ModelRef): Promise<void>;
  getPermissions?(sessionID: string): Promise<PermissionRequest[]>;
  replyPermission?(
    sessionID: string,
    requestID: string,
    decision: PermissionDecision,
    message?: string
  ): Promise<void>;
  getForms?(sessionID: string): Promise<FormInfo[]>;
  replyForm?(
    sessionID: string,
    formID: string,
    answer: Record<string, unknown>
  ): Promise<void>;
  compact?(sessionID: string): Promise<void>;
  stageRevert?(sessionID: string, messageID: string, files?: boolean): Promise<void>;
  commitRevert?(sessionID: string): Promise<void>;
  clearRevert?(sessionID: string): Promise<void>;
  getDiff?(sessionID: string, from?: string, to?: string): Promise<FileDiffInfo[]>;
  runCommand?(sessionID: string, name: string, text: string): Promise<void>;
}

export type PermissionsMode = "ask" | "readOnlyAuto";

interface StreamingTool {
  id: string;
  name: string;
  input: Record<string, unknown> | string;
  status: "pending" | "running" | "done" | "failed" | "stopped";
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  metadata?: Record<string, unknown>;
  error?: string;
  created: number;
}

interface StreamingState {
  messageID?: string;
  text: string;
  reasoning: { text: string; startedAt: number; endedAt?: number; ordinal: number } | null;
  tools: Map<string, StreamingTool>;
  files: Map<string, string>;
  agent?: string;
  model?: ModelRef;
  cost?: number;
  tokens?: TokenUsage;
  startedAt: number;
}

function emptyStream(): StreamingState {
  return {
    text: "",
    reasoning: null,
    tools: new Map(),
    files: new Map(),
    startedAt: Date.now(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** Validate attachment descriptors posted by the webview. */
function parseAttachments(value: unknown): BridgeAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: BridgeAttachment[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const obj = asRecord(raw);
    if (!obj) continue;
    const uri = stringValue(obj.uri);
    const name = stringValue(obj.name) ?? (uri ? uri.split("/").pop() : undefined);
    if (!uri || !name) continue;
    if (seen.has(uri)) continue;
    seen.add(uri);
    out.push({
      uri,
      name,
      ...(obj.kind === "file" ||
      obj.kind === "folder" ||
      obj.kind === "selection" ||
      obj.kind === "current"
        ? { kind: obj.kind }
        : {}),
      ...(typeof obj.mime === "string" ? { mime: obj.mime } : {}),
      ...(typeof obj.size === "number" ? { size: obj.size } : {}),
      ...(typeof obj.lines === "string" ? { lines: obj.lines } : {}),
    });
  }
  return out;
}

/** Map UI attachments onto the server's `PromptInput.FileAttachment` shape. */
function promptFiles(attachments: BridgeAttachment[]): PromptFileInput[] {
  return attachments.map((attachment) => ({
    uri: attachment.uri,
    name: attachment.name,
    ...(attachment.lines
      ? { description: `${attachment.name} (lines ${attachment.lines})` }
      : {}),
    source: { type: "inline" as const },
  }));
}

function toolContent(value: unknown): Array<{ type: string; text?: string; [k: string]: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.map((c) => {
    const obj = asRecord(c) ?? {};
    return {
      ...obj,
      type: stringValue(obj.type) ?? "text",
      ...(typeof obj.text === "string" ? { text: obj.text } : {}),
    };
  });
}

function toolEventID(data: Record<string, unknown> | null): string {
  return stringValue(data?.id) ?? stringValue(data?.callID) ?? "";
}

function toolEventName(data: Record<string, unknown> | null): string {
  return stringValue(data?.name) ?? stringValue(data?.tool) ?? "tool";
}

function parseToolInput(value: unknown): Record<string, unknown> | string {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return asRecord(parsed) ?? value;
    } catch {
      return value;
    }
  }
  return asRecord(value) ?? {};
}

function structuredError(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  const obj = asRecord(value);
  if (!obj) return String(value);
  const nestedData = asRecord(obj.data);
  const nestedError = asRecord(obj.error);
  const candidates = [
    obj.message,
    nestedData?.message,
    nestedError?.message,
    obj.detail,
    obj.reason,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  if (typeof obj.name === "string") return obj.name;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Looks up the display title for a tool call from its input. */
export function toolTitle(tool: {
  name: string;
  input: Record<string, unknown> | string;
}): string {
  const name = tool.name.toLowerCase();
  if (typeof tool.input === "string") return tool.input.slice(0, 120);
  const input = tool.input;
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  if (name === "shell" || name === "bash") {
    const cmd = pick("command", "cmd");
    if (cmd) return cmd;
  }
  if (name === "read" || name === "write" || name === "edit" || name === "patch") {
    const p = pick("path", "filePath", "file_path", "filename");
    if (p) return p;
  }
  if (name === "grep" || name === "glob") {
    const p = pick("pattern", "query");
    const path = pick("path", "include");
    if (p) return path ? `${p} in ${path}` : p;
  }
  if (name === "webfetch" || name === "fetch") {
    const u = pick("url");
    if (u) return u;
  }
  if (name === "websearch" || name === "search") {
    const q = pick("query", "q");
    if (q) return q;
  }
  if (name === "task" || name === "subagent") {
    const d = pick("description", "prompt");
    if (d) return d;
  }
  if (name === "todowrite" || name === "todo") {
    return "Update todos";
  }
  return pick("description", "title", "path", "command", "query", "url") ?? "";
}

/** Normalize a tool name into a UI kind. */
export function toolKind(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("todo")) return "todo";
  if (n.includes("read")) return "read";
  if (n.includes("edit") || n.includes("patch")) return "edit";
  if (n.includes("write")) return "write";
  if (n.includes("bash") || n.includes("shell") || n.includes("terminal")) return "bash";
  if (n.includes("grep") || n.includes("glob") || n.includes("search")) {
    return n.includes("web") ? "web" : "search";
  }
  if (n.includes("web") || n.includes("fetch")) return "web";
  if (n.includes("task") || n.includes("subagent")) return "subagent";
  return "tool";
}

const SAFE_READ_ACTIONS = /^(read|grep|glob|list|search|find|webfetch|websearch)$/i;

/** Agents offered in the header: primary (or "all"), never hidden. */
function primaryAgents(agents: BridgeAgent[]): BridgeAgent[] {
  return agents.filter((a) => !a.hidden && (a.mode === "primary" || a.mode === "all"));
}

/**
 * Context estimate: current context = input + cache.read from the latest
 * step. Verified against v2.3.0 `session.step.ended.tokens`; the server's
 * cumulative `session.tokens` is NOT used because it sums every step.
 */
export function contextUsedFromTokens(tokens: TokenUsage | undefined): number {
  if (!tokens) return 0;
  const input = typeof tokens.input === "number" ? tokens.input : 0;
  const cacheRead =
    tokens.cache && typeof tokens.cache.read === "number" ? tokens.cache.read : 0;
  return Math.max(0, input + cacheRead);
}

export function formatModelRef(model: ModelRef | null | undefined): string {
  if (!model) return "server default";
  const base = `${model.providerID}/${model.modelID}`;
  return model.variant ? `${base}#${model.variant}` : base;
}

export interface BannerAction {
  id: string;
  label: string;
}

export interface ChatBanner {
  kind: "error" | "warning" | "info" | "auth";
  message: string;
  details?: string;
  actions?: BannerAction[];
  /** "init" banners are replaced by the next successful init. */
  source?: "init" | "runtime";
}

export type PostFn = (message: unknown) => void;

export interface ChatControllerOptions {
  client: ChatClientLike;
  post: PostFn;
  mode: "managed" | "external";
  serverUrl: string;
  workspaceDir?: string;
  debug?: boolean;
  sessionID?: string;
  /** Configurable "still waiting" timeout (seconds). Default 120. */
  getResponseTimeoutSeconds?: () => number;
  /** Automatically interrupt a detected repetition loop. Default false. */
  getAutoStopRepetition?: () => boolean;
  persistModel?: (model: ModelRef | null) => void;
  persistSession?: (sessionID: string) => void;
  getPermissionsMode?: () => PermissionsMode;
  /** Notified when a file card should be opened (chatView implements this). */
  onOpenFile?: (path: string) => void;
  onSetPassword?: () => Promise<void>;
  onEnterPassword?: () => Promise<void>;
  onOpenLogs?: () => void;
}

const DEFAULT_RESPONSE_TIMEOUT_SECONDS = 120;
const MAX_SEEN_EVENT_IDS = 500;
const MAX_UNKNOWN_EVENT_LOGS = 8;
const CONTINUE_PROMPT =
  "Continue from where you stopped. Do not repeat text you already wrote; start exactly at the cut-off point.";

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isAuthFailure(message: string): boolean {
  return /HTTP\s+(401|403)\b/.test(message) || /authentication required/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ChatController {
  private readonly opts: ChatControllerOptions;
  private readonly client: ChatClientLike;

  private currentSessionID: string | undefined;
  private selectedModel: ModelRef | null = null;
  private models: Array<{
    id: string;
    label: string;
    providerID: string;
    modelID: string;
    contextLimit?: number;
    variants: string[];
    cost?: Array<{ input: number; output: number; cache?: { read: number; write: number } }>;
  }> = [];

  private agents: BridgeAgent[] = [];
  private currentAgent: string | undefined;
  private commands: BridgeCommand[] = [];
  private skills: BridgeSkill[] = [];
  private sessions: BridgeSessionSummary[] = [];
  private activeSessions = new Set<string>();
  private sessionsCursor: string | undefined;

  private permissions = new Map<string, PermissionRequest>();
  private forms = new Map<string, FormInfo>();

  private contextUsed = 0;
  private contextLimit = 0;
  private contextCost = 0;
  private contextBreakdown: TokenUsage | undefined;
  private compaction: { reason: string; text: string; running: boolean } | null = null;

  private generating = false;
  private stream: StreamingState = emptyStream();
  private lastPrompt: string | undefined;
  private lastAttachments: BridgeAttachment[] = [];
  private undoStack: string[] = [];
  private userSeq = 0;

  private banner: ChatBanner | undefined;

  /** Last status payload posted; keeps "thinking" from flooding the webview. */
  private lastStatusKey = "";
  /** Repetition detection runs at most once per this many new characters. */
  private lastRepetitionCheck = 0;
  private repetitionNotified = false;
  private repetitionDismissed = false;
  /** Set once a provider failure is reported for the current generation. */
  private failureReported = false;
  /**
   * Sessions the user (this client) stopped, with the stop timestamp. Cleared
   * when the next prompt starts. Late abort-style events for these sessions
   * are neutral "Stopped", never a provider error banner.
   */
  private stoppedSessions = new Map<string, number>();

  private responseTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  private eventAbort: AbortController | undefined;
  private eventGeneration = 0;
  private seenEventIDs = new Set<string>();
  private unknownEventLogs = 0;

  constructor(options: ChatControllerOptions) {
    this.opts = options;
    this.client = options.client;
    this.currentSessionID = options.sessionID;
  }

  /* ------------------------------------------------------------------ */
  /* State accessors (used by extension + tests)                        */
  /* ------------------------------------------------------------------ */

  getSessionID(): string | undefined {
    return this.currentSessionID;
  }

  getSelectedModel(): ModelRef | null {
    return this.selectedModel;
  }

  isGenerating(): boolean {
    return this.generating;
  }

  getBanner(): ChatBanner | undefined {
    return this.banner;
  }

  /* ------------------------------------------------------------------ */
  /* Webview -> extension                                               */
  /* ------------------------------------------------------------------ */

  async handleMessage(input: unknown): Promise<void> {
    if (!input || typeof input !== "object") return;
    const message = input as { type?: unknown } & Record<string, unknown>;
    if (typeof message.type !== "string") return;
    try {
      switch (message.type) {
        case "ready":
          await this.postInit();
          this.ensureEventStream();
          break;
        case "send":
          await this.sendMessage(
            String(message.text ?? ""),
            typeof message.context === "string" ? message.context : undefined,
            parseAttachments(message.attachments)
          );
          break;
        case "continue":
          await this.continueGeneration();
          break;
        case "newChat":
          await this.newChat(typeof message.directory === "string" ? message.directory : undefined);
          break;
        case "stop":
          await this.stop();
          break;
        case "background":
          await this.backgroundRunning();
          break;
        case "retry":
          await this.retry();
          break;
        case "selectModel":
          await this.selectModel((message.model ?? null) as ModelRef | null);
          break;
        case "selectAgent":
          await this.selectAgent(String(message.agent ?? ""));
          break;
        case "cycleAgent":
          await this.cycleAgent(typeof message.step === "number" ? message.step : 1);
          break;
        case "selectVariant":
          await this.selectVariant(
            (message.model ?? this.selectedModel) as ModelRef | null,
            typeof message.variant === "string" ? message.variant : undefined
          );
          break;
        case "listSessions":
          await this.loadSessions({
            search: typeof message.search === "string" ? message.search : undefined,
            cursor: typeof message.cursor === "string" ? message.cursor : undefined,
            append: message.append === true,
          });
          break;
        case "switchSession":
          await this.switchSession(String(message.sessionID ?? ""));
          break;
        case "replyPermission":
          await this.replyPermission(
            String(message.requestID ?? ""),
            message.decision === "always" || message.decision === "reject"
              ? message.decision
              : "once",
            typeof message.message === "string" ? message.message : undefined
          );
          break;
        case "replyForm":
          await this.replyForm(
            String(message.formID ?? ""),
            asRecord(message.answer) ?? {}
          );
          break;
        case "compact":
          await this.compact();
          break;
        case "undo":
          await this.undo();
          break;
        case "redo":
          await this.redo();
          break;
        case "runCommand":
          await this.runCommand(
            String(message.name ?? ""),
            String(message.args ?? message.text ?? "")
          );
          break;
        case "openFile":
          if (typeof message.path === "string") this.opts.onOpenFile?.(message.path);
          break;
        case "refreshProviders":
          await this.postInit();
          break;
        case "bannerAction":
          await this.handleBannerAction(String(message.action ?? ""));
          break;
        case "dismissBanner":
          this.clearBanner();
          break;
        case "setPassword":
          await this.opts.onSetPassword?.();
          break;
        case "enterPassword":
          await this.opts.onEnterPassword?.();
          break;
        case "openLogs":
          this.opts.onOpenLogs?.();
          break;
        case "saveScroll":
          break; // reserved
        default:
          this.debugLog(`unknown webview message: ${message.type}`);
      }
    } catch (err) {
      const msg = errMessage(err);
      logError(`Webview message "${message.type}" failed: ${msg}`);
      this.post({ type: "prompt-failed", message: msg });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Init / models / history                                            */
  /* ------------------------------------------------------------------ */

  async postInit(): Promise<void> {
    let providersError: string | null = null;
    let noProviders = false;
    let history: BridgeMessageLike[] = [];

    const [modelsResult, providersResult, agentsResult, commandsResult, skillsResult] =
      await Promise.allSettled([
        this.client.getModels(),
        this.client.getProviders(),
        this.client.getAgents
          ? this.client.getAgents(this.opts.workspaceDir)
          : Promise.resolve([] as BridgeAgent[]),
        this.client.getCommands
          ? this.client.getCommands(this.opts.workspaceDir)
          : Promise.resolve([] as BridgeCommand[]),
        this.client.getSkills
          ? this.client.getSkills(this.opts.workspaceDir)
          : Promise.resolve([] as BridgeSkill[]),
      ]);

    if (providersResult.status === "fulfilled") {
      if (providersResult.value.length === 0) noProviders = true;
    } else {
      providersError = errMessage(providersResult.reason);
      logError(`Failed to load providers: ${providersError}`);
    }

    if (modelsResult.status === "fulfilled") {
      this.models = modelsResult.value.map((m) => ({
        id: m.modelID || m.id,
        label: m.name || m.modelID || m.id,
        providerID: m.providerID,
        modelID: m.modelID || m.id,
        ...(m.limit ? { contextLimit: m.limit.context } : {}),
        variants: Array.isArray(m.variants) ? m.variants.map((v) => v.id) : [],
        ...(m.cost ? { cost: m.cost } : {}),
      }));
      this.recomputeContextLimit();
    } else {
      const message = errMessage(modelsResult.reason);
      if (!providersError) providersError = message;
      logError(`Failed to load models: ${message}`);
    }

    this.agents =
      agentsResult.status === "fulfilled" ? primaryAgents(agentsResult.value) : [];
    this.commands = commandsResult.status === "fulfilled" ? commandsResult.value : [];
    this.skills = skillsResult.status === "fulfilled" ? skillsResult.value : [];
    if (!this.currentAgent) {
      const preferred = this.agents.find((a) => a.id === "build") ?? this.agents[0];
      if (preferred) this.currentAgent = preferred.id;
    }
    if (agentsResult.status === "rejected") {
      logError(`Failed to load agents: ${errMessage(agentsResult.reason)}`);
    }

    if (this.currentSessionID) {
      try {
        history = await this.client.getMessages(this.currentSessionID);
        this.applyHistoryContext(history);
      } catch (err) {
        // Do not surface as "no providers"; just log. The chat stays usable.
        logError(`Failed to restore session history: ${errMessage(err)}`);
      }
      const session = await this.client.getSession?.(this.currentSessionID).catch(() => null);
      if (session?.agent) this.currentAgent = session.agent;
      if (session?.model) {
        this.selectedModel = session.model;
        this.opts.persistModel?.(session.model);
      }
      await this.loadPendingRequests();
    }

    this.updateInitBanner(providersError, noProviders);
    await this.loadSessions();

    this.post({
      type: "init",
      sessionID: this.currentSessionID,
      models: this.models,
      selectedModel: this.selectedModel,
      agents: this.agents,
      agent: this.currentAgent ?? null,
      commands: this.commands,
      skills: this.skills,
      serverUrl: this.opts.serverUrl,
      workspaceDir: this.opts.workspaceDir,
      mode: this.opts.mode,
      noProviders,
      providersError,
      history,
      banner: this.banner ?? null,
      generating: this.generating,
    });
    this.postContext();
    this.postSessions();
  }

  private applyHistoryContext(history: BridgeMessageLike[]): void {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const tokens = history[i].tokens;
      if (!tokens) continue;
      this.setContextFromTokens(tokens, history[i].cost ?? this.contextCost);
      return;
    }
  }

  /**
   * Only claim "no providers" when GET /api/provider actually succeeded and
   * returned zero entries. Any other failure shows the real error once.
   */
  private updateInitBanner(providersError: string | null, noProviders: boolean): void {
    if (providersError) {
      if (isAuthFailure(providersError)) {
        this.banner = {
          kind: "auth",
          message: "Authentication required by the OpenCode server.",
          details: providersError,
          source: "init",
          actions: [
            { id: "enter-password", label: "Enter password" },
            { id: "refresh", label: "Retry" },
            { id: "open-logs", label: "Open logs" },
          ],
        };
      } else {
        this.banner = {
          kind: "error",
          message: "Could not load models from the OpenCode server.",
          details: providersError,
          source: "init",
          actions: [
            { id: "refresh", label: "Retry" },
            { id: "open-logs", label: "Open logs" },
          ],
        };
      }
      return;
    }

    if (noProviders) {
      this.banner = {
        kind: "warning",
        message:
          "No model providers are connected to OpenCode. Add a provider in OpenCode, then refresh.",
        source: "init",
        actions: [
          { id: "refresh", label: "Refresh" },
          { id: "open-logs", label: "Open logs" },
        ],
      };
      return;
    }

    if (this.banner?.source === "init") this.banner = undefined;
  }

  /* ------------------------------------------------------------------ */
  /* Context meter / session list                                       */
  /* ------------------------------------------------------------------ */

  private recomputeContextLimit(): void {
    if (!this.selectedModel) {
      this.contextLimit = 0;
      return;
    }
    const entry = this.models.find(
      (m) =>
        m.providerID === this.selectedModel?.providerID &&
        m.modelID === this.selectedModel.modelID
    );
    this.contextLimit = entry?.contextLimit ?? 0;
  }

  private setContextFromTokens(tokens: TokenUsage | undefined, cost?: number): void {
    if (!tokens) return;
    this.contextBreakdown = tokens;
    this.contextUsed = contextUsedFromTokens(tokens);
    if (typeof cost === "number") this.contextCost = cost;
    this.recomputeContextLimit();
    this.postContext();
  }

  private postContext(): void {
    const limit = this.contextLimit || 0;
    const used = this.contextUsed || 0;
    const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    this.post({
      type: "context",
      used,
      limit,
      percent,
      breakdown: this.contextBreakdown ?? null,
      cost: this.contextCost,
      compaction: this.compaction,
    });
  }

  private postSessions(): void {
    this.post({
      type: "sessions",
      sessions: this.sessions.map((s) => ({
        ...s,
        busy: this.activeSessions.has(s.id) || this.generating && s.id === this.currentSessionID,
      })),
      cursor: this.sessionsCursor ?? null,
      currentSessionID: this.currentSessionID ?? null,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Sending / sessions                                                 */
  /* ------------------------------------------------------------------ */

  async sendMessage(
    text: string,
    context?: string,
    attachments: BridgeAttachment[] = []
  ): Promise<void> {
    const typed = text.trim();
    if (!typed && attachments.length === 0) return;
    if (this.generating) {
      this.postStatus("thinking", "Still generating — press Stop first.", true);
      return;
    }

    const fullText = context ? `${context}\n\n---\n\n${typed}` : typed;

    try {
      if (!this.currentSessionID) await this.createSession();
      if (!this.currentSessionID) return;

      // A new prompt always starts from a clean stop/failure slate.
      this.stoppedSessions.delete(this.currentSessionID);
      this.failureReported = false;

      const userID = `user_${Date.now()}_${++this.userSeq}`;
      this.lastPrompt = fullText;
      this.lastAttachments = attachments;
      this.post({
        type: "user-message",
        id: userID,
        text: fullText,
        created: Date.now(),
        ...(attachments.length > 0 ? { attachments } : {}),
      });

      this.generating = true;
      this.stream = emptyStream();
      this.stream.agent = this.currentAgent;
      this.stream.model = this.selectedModel ?? undefined;
      this.resetStatusCache();
      this.resetRepetitionGuard();
      this.postStatus("thinking", "OpenCode is thinking…", true);

      if (this.selectedModel && this.client.setSessionModel) {
        try {
          await this.client.setSessionModel(this.currentSessionID, this.selectedModel);
        } catch (err) {
          logError(`Failed to apply session model before prompt: ${errMessage(err)}`);
        }
      }

      await this.client.prompt({
        sessionID: this.currentSessionID,
        text: fullText,
        model: this.selectedModel ?? undefined,
        ...(attachments.length > 0 ? { files: promptFiles(attachments) } : {}),
      });
      this.startResponseTimer();
      this.debugLog("Prompt accepted; waiting for SSE events");
    } catch (err) {
      const message = errMessage(err);
      logError(`Failed to send prompt: ${message}`);
      this.finishStreaming();
      this.post({ type: "prompt-failed", message, details: message });
      this.showBanner({
        kind: "error",
        message: "Could not send your message to OpenCode.",
        details: message,
        source: "runtime",
        actions: [
          { id: "retry-prompt", label: "Retry" },
          { id: "open-logs", label: "Open logs" },
        ],
      });
    }
  }

  async newChat(directory?: string): Promise<void> {
    this.finishStreaming();
    this.resetRepetitionGuard();
    this.permissions.clear();
    this.forms.clear();
    this.contextUsed = 0;
    this.contextBreakdown = undefined;
    this.compaction = null;
    try {
      const session = await this.createSession(directory);
      if (!session) return;
      this.post({
        type: "init",
        sessionID: this.currentSessionID,
        models: this.models,
        selectedModel: this.selectedModel,
        agents: this.agents,
        agent: this.currentAgent ?? null,
        commands: this.commands,
        skills: this.skills,
        serverUrl: this.opts.serverUrl,
        workspaceDir: this.opts.workspaceDir,
        mode: this.opts.mode,
        noProviders: false,
        providersError: null,
        history: [],
        banner: this.banner ?? null,
        generating: false,
      });
      this.postContext();
      void this.loadSessions();
      this.postStatus("idle", "", false);
    } catch (err) {
      const message = errMessage(err);
      logError(`Failed to create chat: ${message}`);
      this.showBanner({
        kind: "error",
        message: "Could not create a new OpenCode session.",
        details: message,
        source: "runtime",
        actions: [{ id: "open-logs", label: "Open logs" }],
      });
    }
  }

  private async createSession(directory?: string): Promise<{ id: string } | undefined> {
    const session = await this.client.createSession({
      title: "New chat",
      directory: directory ?? this.opts.workspaceDir,
      model: this.selectedModel ?? undefined,
      agent: this.currentAgent,
    });
    if (!session?.id) throw new Error("Server did not return a session id.");
    this.currentSessionID = session.id;
    this.opts.persistSession?.(session.id);
    this.debugLog(`Session ready: ${session.id}`);
    return session;
  }

  /** True while a tool call (for example a shell command) is still running. */
  private hasRunningTools(): boolean {
    for (const tool of this.stream.tools.values()) {
      if (tool.status === "running" || tool.status === "pending") return true;
    }
    return false;
  }

  async stop(): Promise<void> {
    // A shell command can outlive the visible "generating" state, so a
    // running tool is a reason to stop even when the turn looks finished.
    if (!this.generating && !this.hasRunningTools()) return;
    const sessionID = this.currentSessionID;
    if (sessionID) this.rememberStopped(sessionID);
    // Mark the partial answer neutral immediately; do not wait for the
    // server's abort events (they arrive as step.failed afterwards).
    this.markRunningToolsStopped();
    this.finishStreaming("Stopped", { stopped: true });
    if (sessionID) await this.interruptSession(sessionID);
    void this.loadSessions();
  }

  /**
   * Interrupt the server-side run. A failure is reported honestly: the UI
   * already says "Stopped", but the command may still be running, so the user
   * gets a banner with a retry instead of a silent log line.
   */
  private async interruptSession(sessionID: string): Promise<boolean> {
    try {
      await this.client.interrupt(sessionID);
      if (this.banner?.actions?.some((a) => a.id === "retry-stop")) this.clearBanner();
      return true;
    } catch (err) {
      const message = errMessage(err);
      logError(`Failed to interrupt session: ${message}`);
      this.showBanner({
        kind: "error",
        message:
          "OpenCode did not confirm the stop. A running command may still be going.",
        details: message,
        source: "runtime",
        actions: [
          { id: "retry-stop", label: "Try stopping again" },
          { id: "open-logs", label: "Open logs" },
        ],
      });
      return false;
    }
  }

  /**
   * "Run in background": ask the server to detach the work the turn is
   * blocked on. The server only reports whether something was detached, so
   * the answer is relayed as-is instead of claiming a shell was moved.
   */
  async backgroundRunning(): Promise<void> {
    const sessionID = this.currentSessionID;
    if (!sessionID || (!this.generating && !this.hasRunningTools())) {
      this.post({ type: "note", kind: "info", text: "Nothing is running to move to the background." });
      return;
    }
    if (!this.client.backgroundSession) {
      this.post({
        type: "note",
        kind: "warning",
        text: "This OpenCode server cannot move work to the background. Use Stop to end it.",
      });
      return;
    }
    try {
      const moved = await this.client.backgroundSession(sessionID);
      this.post({
        type: "note",
        kind: moved ? "info" : "warning",
        text: moved
          ? "Moved the blocking work to the background. The chat keeps going."
          : "OpenCode had nothing to detach (it only moves subagents, not plain shell commands). Use Stop to end the command.",
      });
    } catch (err) {
      const message = errMessage(err);
      logError(`Failed to background session: ${message}`);
      this.post({ type: "note", kind: "error", text: message });
    }
  }

  /** Remember a user-initiated stop until the next prompt in that session. */
  private rememberStopped(sessionID: string): void {
    this.stoppedSessions.set(sessionID, Date.now());
    while (this.stoppedSessions.size > 50) {
      const oldest = this.stoppedSessions.keys().next().value;
      if (!oldest) break;
      this.stoppedSessions.delete(oldest);
    }
  }

  /** A stop from this client (or any abort-shaped event) for the session. */
  private isStopLike(raw: unknown, sessionID?: string): boolean {
    const sid = sessionID ?? this.currentSessionID;
    return (!!sid && this.stoppedSessions.has(sid)) || isAbortLikeError(raw);
  }

  /** Flip running/pending tool rows to "stopped" (no error styling). */
  private markRunningToolsStopped(): void {
    for (const tool of this.stream.tools.values()) {
      if (tool.status !== "running" && tool.status !== "pending") continue;
      tool.status = "stopped";
      this.post({
        type: "tool-update",
        messageID: this.stream.messageID,
        tool: this.serializeTool(tool),
      });
    }
  }

  /**
   * End the turn as a neutral "Stopped": keep partial text, no banner and no
   * prompt-failed bubble. Used for our Stop button, abort-style failures and
   * `session.execution.interrupted` (which may come from another client).
   */
  private neutralStop(sessionID?: string, note = "Stopped"): void {
    const sid = sessionID ?? this.currentSessionID;
    if (sid) this.rememberStopped(sid);
    this.markRunningToolsStopped();
    this.finishStreaming(note, { stopped: true });
    void this.loadSessions();
  }

  async retry(): Promise<void> {
    if (this.generating) return;
    if (!this.currentSessionID || !this.lastPrompt) {
      this.showBanner({
        kind: "warning",
        message: "Nothing to retry yet.",
        source: "runtime",
      });
      return;
    }
    this.generating = true;
    this.stream = emptyStream();
    this.stream.agent = this.currentAgent;
    this.stream.model = this.selectedModel ?? undefined;
    this.stoppedSessions.delete(this.currentSessionID);
    this.failureReported = false;
    this.resetStatusCache();
    this.resetRepetitionGuard();
    this.postStatus("thinking", "Retrying…", true);
    try {
      await this.client.prompt({
        sessionID: this.currentSessionID,
        text: this.lastPrompt,
        model: this.selectedModel ?? undefined,
        ...(this.lastAttachments.length > 0
          ? { files: promptFiles(this.lastAttachments) }
          : {}),
      });
      this.startResponseTimer();
    } catch (err) {
      const message = errMessage(err);
      logError(`Retry failed: ${message}`);
      this.finishStreaming();
      this.post({ type: "prompt-failed", message, details: message });
      this.showBanner({
        kind: "error",
        message: "Retry failed.",
        details: message,
        source: "runtime",
        actions: [
          { id: "retry-prompt", label: "Retry again" },
          { id: "open-logs", label: "Open logs" },
        ],
      });
    }
  }

  /**
   * Model selection updates only the selection (type "model-selected").
   * It must NOT post an empty "init" that wipes the model list.
   */
  async selectModel(model: ModelRef | null, variant?: string): Promise<void> {
    const next =
      model && typeof model.providerID === "string" && typeof model.modelID === "string"
        ? {
            providerID: model.providerID,
            modelID: model.modelID,
            ...(variant ?? model.variant ? { variant: variant ?? model.variant } : {}),
          }
        : null;
    this.selectedModel = next;
    this.opts.persistModel?.(next);
    this.recomputeContextLimit();
    this.debugLog(
      `Model selected: ${next ? formatModelRef(next) : "server default"}`
    );
    this.post({ type: "model-selected", selectedModel: next });
    this.postContext();
    if (next && this.currentSessionID && this.client.setSessionModel) {
      try {
        await this.client.setSessionModel(this.currentSessionID, next);
      } catch (err) {
        logError(`Failed to switch session model: ${errMessage(err)}`);
      }
    }
  }

  /** Called by extension.ts when the setting/globalState model changes. */
  setSelectedModel(model: ModelRef | null): void {
    this.selectedModel = model;
    this.recomputeContextLimit();
    this.post({ type: "model-selected", selectedModel: model });
    this.postContext();
  }

  /** Select a primary agent (header dropdown / palette). */
  async selectAgent(agent: string): Promise<void> {
    if (!agent) return;
    if (!this.agents.some((a) => a.id === agent)) return;
    this.currentAgent = agent;
    if (this.currentSessionID && this.client.setSessionAgent) {
      try {
        await this.client.setSessionAgent(this.currentSessionID, agent);
      } catch (err) {
        logError(`Failed to switch agent: ${errMessage(err)}`);
      }
    }
    this.post({ type: "agent-selected", agent });
  }

  /** Shift+Tab / Ctrl+. cycles through primary agents. */
  async cycleAgent(step = 1): Promise<void> {
    if (this.agents.length === 0) return;
    const index = this.agents.findIndex((a) => a.id === this.currentAgent);
    const next = this.agents[(index + step + this.agents.length) % this.agents.length];
    if (next) await this.selectAgent(next.id);
  }

  /** Apply a reasoning/thinking variant to the selected model. */
  async selectVariant(
    model: ModelRef | null | undefined,
    variant: string | undefined
  ): Promise<void> {
    if (!model) return;
    const next: ModelRef = { providerID: model.providerID, modelID: model.modelID };
    if (variant) next.variant = variant;
    await this.selectModel(next);
  }

  /* ------------------------------------------------------------------ */
  /* Sessions                                                           */
  /* ------------------------------------------------------------------ */

  async loadSessions(opts: {
    search?: string;
    cursor?: string;
    append?: boolean;
  } = {}): Promise<void> {
    if (!this.client.listSessions) return;
    try {
      const result = await this.client.listSessions({
        limit: 30,
        order: "desc",
        search: opts.search,
        directory: this.opts.workspaceDir,
        cursor: opts.cursor,
      });
      this.sessions = opts.append ? [...this.sessions, ...result.sessions] : result.sessions;
      this.sessionsCursor = result.next;
      if (this.client.getActiveSessions) {
        try {
          this.activeSessions = new Set(await this.client.getActiveSessions());
        } catch {
          /* non-fatal */
        }
      }
      this.postSessions();
    } catch (err) {
      logError(`Failed to list sessions: ${errMessage(err)}`);
    }
  }

  async switchSession(sessionID: string): Promise<void> {
    if (!sessionID || sessionID === this.currentSessionID) return;
    this.finishStreaming();
    this.resetRepetitionGuard();
    this.permissions.clear();
    this.forms.clear();
    this.currentSessionID = sessionID;
    this.opts.persistSession?.(sessionID);
    this.stream = emptyStream();
    this.contextUsed = 0;
    this.contextBreakdown = undefined;
    let history: BridgeMessageLike[] = [];
    try {
      history = await this.client.getMessages(sessionID);
      this.applyHistoryContext(history);
    } catch (err) {
      logError(`Failed to load session history: ${errMessage(err)}`);
    }
    const session = await this.client.getSession?.(sessionID).catch(() => null);
    if (session?.agent) this.currentAgent = session.agent;
    if (session?.model) {
      this.selectedModel = session.model;
      this.opts.persistModel?.(session.model);
      this.recomputeContextLimit();
    }
    this.post({
      type: "session-selected",
      sessionID,
      history,
      agent: this.currentAgent ?? null,
      selectedModel: this.selectedModel,
    });
    await this.loadPendingRequests();
    this.postContext();
    this.postSessions();
  }

  /* ------------------------------------------------------------------ */
  /* Permissions / forms                                                */
  /* ------------------------------------------------------------------ */

  private async loadPendingRequests(): Promise<void> {
    const sessionID = this.currentSessionID;
    if (!sessionID) return;
    if (this.client.getPermissions) {
      try {
        for (const request of await this.client.getPermissions(sessionID)) {
          this.permissions.set(request.id, request);
          this.post({ type: "permission-request", request });
        }
      } catch (err) {
        logError(`Failed to load pending permissions: ${errMessage(err)}`);
      }
    }
    if (this.client.getForms) {
      try {
        for (const form of await this.client.getForms(sessionID)) {
          this.forms.set(form.id, form);
          this.post({ type: "question-request", form });
        }
      } catch (err) {
        logError(`Failed to load pending forms: ${errMessage(err)}`);
      }
    }
  }

  async replyPermission(
    requestID: string,
    decision: PermissionDecision,
    message?: string
  ): Promise<void> {
    const sessionID = this.currentSessionID;
    if (!sessionID || !requestID) return;
    try {
      await this.client.replyPermission?.(sessionID, requestID, decision, message);
      this.permissions.delete(requestID);
      this.post({ type: "permission-resolved", requestID, decision });
    } catch (err) {
      logError(`Failed to reply to permission: ${errMessage(err)}`);
      this.post({ type: "permission-error", requestID, message: errMessage(err) });
    }
  }

  async replyForm(formID: string, answer: Record<string, unknown>): Promise<void> {
    const sessionID = this.currentSessionID;
    if (!sessionID || !formID) return;
    try {
      await this.client.replyForm?.(sessionID, formID, answer);
      this.forms.delete(formID);
      this.post({ type: "question-resolved", formID });
    } catch (err) {
      logError(`Failed to reply to form: ${errMessage(err)}`);
      this.post({ type: "question-error", formID, message: errMessage(err) });
    }
  }

  private maybeAutoApprove(request: PermissionRequest): boolean {
    const mode = this.opts.getPermissionsMode?.() ?? "ask";
    if (mode !== "readOnlyAuto") return false;
    // Only read-only actions are auto-approved, and only "once" — "always"
    // is always an explicit user click. Edits/shell are never auto-approved.
    return SAFE_READ_ACTIONS.test(request.action);
  }

  /* ------------------------------------------------------------------ */
  /* Compaction / undo / commands                                       */
  /* ------------------------------------------------------------------ */

  async compact(): Promise<void> {
    const sessionID = this.currentSessionID;
    if (!sessionID) return;
    this.compaction = { reason: "manual", text: "", running: true };
    this.post({ type: "compaction", compaction: this.compaction });
    try {
      await this.client.compact?.(sessionID);
    } catch (err) {
      this.compaction = null;
      this.post({ type: "compaction", compaction: null });
      this.showBanner({
        kind: "error",
        message: "Could not compact this session.",
        details: errMessage(err),
        source: "runtime",
      });
    }
  }

  /** Undo the last user turn using stage + commit revert. */
  async undo(): Promise<void> {
    const sessionID = this.currentSessionID;
    if (!sessionID) return;
    try {
      const history = await this.client.getMessages(sessionID);
      let lastUser: BridgeMessageLike | undefined;
      for (let i = history.length - 1; i >= 0; i -= 1) {
        if (history[i].role === "user") {
          lastUser = history[i];
          break;
        }
      }
      if (!lastUser) {
        this.showBanner({ kind: "info", message: "Nothing to undo.", source: "runtime" });
        return;
      }
      this.undoStack.push(lastUser.text);
      await this.client.stageRevert?.(sessionID, lastUser.id, true);
      await this.client.commitRevert?.(sessionID);
      const next = await this.client.getMessages(sessionID);
      this.applyHistoryContext(next);
      this.post({ type: "history", history: next });
      this.postContext();
    } catch (err) {
      logError(`Undo failed: ${errMessage(err)}`);
      this.showBanner({
        kind: "error",
        message: "Could not undo the last turn.",
        details: errMessage(err),
        source: "runtime",
      });
    }
  }

  /** Redo is implemented by re-sending the last undone prompt (no server redo). */
  async redo(): Promise<void> {
    const text = this.undoStack.pop();
    if (!text) {
      this.showBanner({ kind: "info", message: "Nothing to redo.", source: "runtime" });
      return;
    }
    await this.sendMessage(text);
  }

  /** Run a custom command with the verified `POST /session/{id}/command` route. */
  async runCommand(name: string, args: string): Promise<void> {
    if (!name) return;
    try {
      if (!this.currentSessionID) await this.createSession();
      if (!this.currentSessionID) return;
      this.generating = true;
      this.stream = emptyStream();
      this.resetStatusCache();
      this.resetRepetitionGuard();
      this.postStatus("thinking", `Running /${name}…`, true);
      if (this.client.runCommand) {
        await this.client.runCommand(this.currentSessionID, name, args);
      } else {
        // Fallback for clients that only expose prompt(): send the command
        // as a plain message. Verified servers use the route above.
        await this.client.prompt({
          sessionID: this.currentSessionID,
          text: args ? `/${name} ${args}` : `/${name}`,
        });
      }
      this.startResponseTimer();
    } catch (err) {
      this.finishStreaming();
      this.showBanner({
        kind: "error",
        message: `Could not run /${name}.`,
        details: errMessage(err),
        source: "runtime",
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Server info / auth                                                 */
  /* ------------------------------------------------------------------ */

  setAuthHeader(authHeader: string | undefined): void {
    this.client.setAuthHeader?.(authHeader);
    // Recreate the SSE stream with the new credentials.
    this.restartEventStream();
  }

  setServerUrl(serverUrl: string): void {
    this.opts.serverUrl = serverUrl;
    this.client.setBaseUrl?.(serverUrl);
    this.post({
      type: "server-info",
      serverUrl,
      mode: this.opts.mode,
      workspaceDir: this.opts.workspaceDir,
    });
  }

  async onServerRestarted(serverUrl: string, authHeader: string | undefined, attempt: number): Promise<void> {
    this.opts.serverUrl = serverUrl;
    this.client.setBaseUrl?.(serverUrl);
    this.client.setAuthHeader?.(authHeader);
    this.restartEventStream();
    this.showBanner({
      kind: "info",
      message: `The local OpenCode server restarted (attempt ${attempt}).`,
      source: "runtime",
    });
    await this.postInit();
  }

  /* ------------------------------------------------------------------ */
  /* Banner                                                             */
  /* ------------------------------------------------------------------ */

  showBanner(banner: ChatBanner): void {
    this.banner = banner;
    this.post({ type: "banner", banner });
  }

  clearBanner(): void {
    this.banner = undefined;
    this.post({ type: "banner", banner: null });
  }

  private async handleBannerAction(action: string): Promise<void> {
    switch (action) {
      case "refresh":
        await this.postInit();
        break;
      case "retry-prompt":
        await this.retry();
        break;
      case "enter-password":
        await this.opts.onEnterPassword?.();
        break;
      case "open-logs":
        this.opts.onOpenLogs?.();
        break;
      case "cancel-wait":
        await this.stop();
        break;
      case "stop":
        await this.stop();
        break;
      case "retry-stop":
        if (this.currentSessionID) await this.interruptSession(this.currentSessionID);
        break;
      case "stop-retry-model":
        await this.stop();
        this.clearBanner();
        this.post({ type: "open-model-picker" });
        break;
      case "switch-model":
        this.post({ type: "open-model-picker" });
        break;
      case "dismiss-repetition":
        this.repetitionDismissed = true;
        this.clearBanner();
        break;
      case "dismiss":
        this.clearBanner();
        break;
      default:
        this.debugLog(`unknown banner action: ${action}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Response timeout ("still waiting", never a hard failure)           */
  /* ------------------------------------------------------------------ */

  private responseTimeoutSeconds(): number {
    const raw = this.opts.getResponseTimeoutSeconds?.() ?? DEFAULT_RESPONSE_TIMEOUT_SECONDS;
    const seconds = Number.isFinite(raw) ? raw : DEFAULT_RESPONSE_TIMEOUT_SECONDS;
    return Math.min(3_600, Math.max(0.05, seconds));
  }

  private startResponseTimer(): void {
    this.stopResponseTimer();
    const seconds = this.responseTimeoutSeconds();
    this.responseTimer = setTimeout(() => {
      this.responseTimer = undefined;
      if (!this.generating || this.disposed) return;
      this.postStatus(
        "waiting",
        `Still waiting for OpenCode… (no events for ${Math.round(seconds)}s)`,
        true,
        true
      );
    }, seconds * 1_000);
  }

  private stopResponseTimer(): void {
    if (this.responseTimer) {
      clearTimeout(this.responseTimer);
      this.responseTimer = undefined;
    }
  }

  private noteActivity(): void {
    if (this.generating) this.startResponseTimer();
  }

  /* ------------------------------------------------------------------ */
  /* Status (deduplicated) / runaway output                             */
  /* ------------------------------------------------------------------ */

  private resetStatusCache(): void {
    this.lastStatusKey = "";
  }

  /**
   * Post a status only when it actually changes. `session.text.delta` used
   * to send an identical "thinking" status for every chunk.
   */
  private postStatus(
    status: string,
    message: string,
    generating: boolean,
    canCancel = false
  ): void {
    const key = `${status}\u0001${message}\u0001${generating ? "1" : "0"}\u0001${
      canCancel ? "1" : "0"
    }`;
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.post({ type: "status", status, message, generating, canCancel });
  }

  private resetRepetitionGuard(): void {
    this.lastRepetitionCheck = 0;
    this.repetitionNotified = false;
    this.repetitionDismissed = false;
    this.failureReported = false;
  }

  /**
   * Check the streamed tail for degenerate loops. Runs on the tail only and
   * at most once per ~128 new characters, so a 250k-character stream costs
   * a handful of tiny regex/slice operations.
   */
  private maybeCheckRepetition(): void {
    if (!this.generating || this.repetitionNotified || this.repetitionDismissed) return;
    const text = this.stream.text;
    if (text.length < 160) return;
    if (text.length - this.lastRepetitionCheck < 128) return;
    this.lastRepetitionCheck = text.length;

    const hit = detectRepetition(text);
    if (!hit) return;

    this.repetitionNotified = true;
    const autoStop = this.opts.getAutoStopRepetition?.() === true;
    this.debugLog(
      `repetition detected: ${hit.kind} ${hit.length} chars${
        autoStop ? " (auto-stopping)" : ""
      }`
    );
    this.showRepetitionBanner(hit, autoStop);
    if (autoStop) {
      void this.stop().then(() => this.showRepetitionBanner(hit, true));
    }
  }

  private modelLabel(): string {
    const model = this.stream.model ?? this.selectedModel;
    return model ? formatModelRef(model) : "The selected model";
  }

  private showRepetitionBanner(hit: RepetitionHit, autoStopped: boolean): void {
    this.showBanner({
      kind: "warning",
      message: `${this.modelLabel()}: The model seems stuck in a repetition loop.`,
      details:
        `${describeRepetition(hit)}.` +
        (autoStopped
          ? "\nStopped automatically because opencodeBridge.autoStopRepetition is enabled."
          : ""),
      source: "runtime",
      actions: autoStopped
        ? [
            { id: "switch-model", label: "Switch model" },
            { id: "dismiss-repetition", label: "Dismiss" },
          ]
        : [
            { id: "stop", label: "Stop" },
            { id: "stop-retry-model", label: "Stop and retry with a different model" },
            { id: "dismiss-repetition", label: "Dismiss" },
          ],
    });
  }

  /**
   * Continue an interrupted/failed answer. The partial assistant text is
   * still in the server-side message history, so a plain follow-up is enough.
   */
  async continueGeneration(): Promise<void> {
    if (this.generating) return;
    await this.sendMessage(CONTINUE_PROMPT);
  }

  /* ------------------------------------------------------------------ */
  /* Provider failure banners                                           */
  /* ------------------------------------------------------------------ */

  private failureActions(info: FailureInfo): BannerAction[] {
    const actions: BannerAction[] = [];
    if (info.kind === "auth") actions.push({ id: "enter-password", label: "Enter password" });
    if (info.retryable) actions.push({ id: "retry-prompt", label: "Retry" });
    actions.push({ id: "switch-model", label: "Switch model" });
    actions.push({ id: "open-logs", label: "Open logs" });
    return actions;
  }

  private failureDetails(info: FailureInfo, model?: ModelRef): string {
    const ref = model ?? this.stream.model ?? this.selectedModel;
    const provider = ref?.providerID ?? "unknown provider";
    const label = ref ? formatModelRef(ref) : "The selected model";
    return `Model: ${label}\nProvider: ${provider}\n\n${info.details}`;
  }

  /**
   * Show a model/provider-aware banner for execution/step failures, keep the
   * partial text, and mark the assistant message as incomplete.
   */
  private showExecutionFailure(raw: unknown, markIncomplete: boolean): void {
    // An abort is a user-visible "Stopped", not a provider failure. This also
    // covers interrupts initiated by another client.
    if (this.isStopLike(raw)) {
      const sid = this.currentSessionID;
      this.neutralStop(sid);
      return;
    }
    // OpenCode can report the same terminal failure as both step.failed and
    // execution.failed; only the first should produce a banner.
    if (this.failureReported) return;
    this.failureReported = true;
    const info = classifyFailure(raw);
    // Capture the assistant message's model before finishStreaming resets it.
    const failedModel = this.stream.model ?? this.selectedModel ?? undefined;
    const modelLabel = failedModel ? formatModelRef(failedModel) : "The selected model";
    const details = this.failureDetails(info, failedModel);
    if (markIncomplete) {
      this.finishStreaming(undefined, { incomplete: true, reason: info.summary });
    } else {
      this.finishStreaming();
    }
    logError(`OpenCode ${info.label} (${modelLabel}): ${info.details}`);
    this.post({
      type: "prompt-failed",
      message: `${modelLabel}: ${info.summary}`,
      details: info.details,
    });
    this.showBanner({
      kind:
        info.kind === "auth" ? "auth" : info.kind === "rate-limit" ? "warning" : "error",
      message: `${modelLabel}: ${info.summary}`,
      details,
      source: "runtime",
      actions: this.failureActions(info),
    });
  }

  /**
   * Tool failures are normally shown inline in the tool card. Only surface a
   * top banner when the tool failure is really a provider/transport failure.
   */
  private showToolFailure(raw: unknown, toolName: string): void {
    const info = classifyFailure(raw);
    if (!isProviderFailure(info.kind)) return;
    const modelLabel = this.modelLabel();
    this.showBanner({
      kind: info.kind === "auth" ? "auth" : "error",
      message: `${modelLabel}: tool "${toolName}" failed. ${info.summary}`,
      details: this.failureDetails(info),
      source: "runtime",
      actions: this.failureActions(info),
    });
  }

  private finishStreaming(
    message?: string,
    options?: { incomplete?: boolean; reason?: string; stopped?: boolean }
  ): void {
    this.stopResponseTimer();
    const messageID = this.stream.messageID;
    if (messageID) {
      this.post({
        type: "assistant-end",
        messageID,
        ...(options?.incomplete ? { incomplete: true } : {}),
        ...(options?.reason ? { reason: options.reason } : {}),
        ...(options?.stopped ? { stopped: true } : {}),
      });
    }
    const files = [...this.stream.files.values()];
    if (files.length > 0) {
      this.post({
        type: "files-changed",
        messageID,
        files,
        agent: this.stream.agent ?? this.currentAgent,
        model: this.stream.model ?? this.selectedModel,
      });
    }
    if (this.stream.tokens) {
      this.setContextFromTokens(this.stream.tokens, this.stream.cost);
    }
    this.stream = emptyStream();
    this.generating = false;
    this.postStatus("idle", message ?? "", false);
  }

  /* ------------------------------------------------------------------ */
  /* SSE lifecycle                                                      */
  /* ------------------------------------------------------------------ */

  /** Ensure exactly one live SSE subscription (restarts any previous one). */
  ensureEventStream(): void {
    if (this.disposed) return;
    this.restartEventStream();
  }

  private restartEventStream(): void {
    if (this.disposed) return;
    this.stopEventStream();
    const generation = this.eventGeneration;
    void this.runEventStream(generation);
  }

  /** Abort the live stream and invalidate its generation. */
  stopEventStream(): void {
    this.eventGeneration += 1;
    if (this.eventAbort) {
      try {
        this.eventAbort.abort();
      } catch {
        /* ignore */
      }
      this.eventAbort = undefined;
    }
  }

  private async runEventStream(generation: number): Promise<void> {
    let backoff = 1_000;
    while (!this.disposed && generation === this.eventGeneration) {
      const controller = new AbortController();
      this.eventAbort = controller;
      let sawEvent = false;
      try {
        await this.client.streamEvents({
          signal: controller.signal,
          onEvent: (event) => {
            if (this.disposed || generation !== this.eventGeneration) return;
            sawEvent = true;
            this.handleServerEvent(event);
          },
        });
        if (generation !== this.eventGeneration || this.disposed) return;
        this.debugLog("SSE stream ended; will reconnect");
      } catch (err) {
        if (controller.signal.aborted || generation !== this.eventGeneration) return;
        logError(`SSE stream error: ${errMessage(err)}`);
      } finally {
        if (this.eventAbort === controller) this.eventAbort = undefined;
      }

      if (generation !== this.eventGeneration || this.disposed) return;
      if (sawEvent) backoff = 1_000;
      this.post({ type: "connection", state: "reconnecting" });
      await delay(backoff);
      backoff = Math.min(backoff * 2, 10_000);
    }
  }

  /**
   * Handle one server event. Exposed (public) for tests. Only events for the
   * session the extension created are processed; `session.created` is
   * intentionally ignored (another client's session must not hijack ours).
   */
  handleServerEvent(event: BridgeEvent): void {
    if (!event || typeof event.type !== "string") return;

    if (event.id) {
      if (this.seenEventIDs.has(event.id)) return;
      this.seenEventIDs.add(event.id);
      if (this.seenEventIDs.size > MAX_SEEN_EVENT_IDS) {
        const first = this.seenEventIDs.values().next().value;
        if (first) this.seenEventIDs.delete(first);
      }
    }

    if (!shouldHandleEvent(event, this.currentSessionID)) {
      this.debugLog(`ignoring ${event.type} for another session (${event.sessionID ?? "unknown"})`);
      return;
    }

    // Any event for our session keeps the "still waiting" timer fresh.
    this.noteActivity();

    const data = asRecord(event.data);

    switch (event.type) {
      /* ---------------------------------------------------------- */
      /* Reasoning (thinking)                                        */
      /* ---------------------------------------------------------- */
      case "session.reasoning.started": {
        const messageID = stringValue(data?.assistantMessageID);
        const ordinal = numberOrUndefined(data?.ordinal) ?? 0;
        this.ensureAssistant(messageID, event.sessionID);
        if (!this.stream.reasoning) {
          this.stream.reasoning = { text: "", startedAt: Date.now(), ordinal };
          this.post({
            type: "reasoning-start",
            messageID: this.stream.messageID,
            ordinal,
            startedAt: this.stream.reasoning.startedAt,
          });
        }
        return;
      }

      case "session.reasoning.delta": {
        const delta = stringValue(data?.delta) ?? stringValue(data?.text) ?? "";
        if (!delta) return;
        this.ensureAssistant(stringValue(data?.assistantMessageID), event.sessionID);
        if (!this.stream.reasoning) {
          this.stream.reasoning = {
            text: "",
            startedAt: event.created ?? Date.now(),
            ordinal: numberOrUndefined(data?.ordinal) ?? 0,
          };
          this.post({
            type: "reasoning-start",
            messageID: this.stream.messageID,
            ordinal: this.stream.reasoning.ordinal,
            startedAt: this.stream.reasoning.startedAt,
          });
        }
        this.stream.reasoning.text += delta;
        this.post({
          type: "reasoning-delta",
          messageID: this.stream.messageID,
          delta,
          text: this.stream.reasoning.text,
        });
        return;
      }

      case "session.reasoning.ended": {
        const full = stringValue(data?.text);
        if (!this.stream.reasoning) {
          this.stream.reasoning = {
            text: full ?? "",
            startedAt: event.created ?? Date.now(),
            ordinal: numberOrUndefined(data?.ordinal) ?? 0,
          };
          this.post({
            type: "reasoning-start",
            messageID: this.stream.messageID,
            ordinal: this.stream.reasoning.ordinal,
            startedAt: this.stream.reasoning.startedAt,
          });
          if (full) {
            this.post({ type: "reasoning-delta", messageID: this.stream.messageID, delta: full, text: full });
          }
        } else if (full) {
          this.stream.reasoning.text = full;
        }
        this.stream.reasoning.endedAt = Date.now();
        this.post({
          type: "reasoning-end",
          messageID: this.stream.messageID,
          text: this.stream.reasoning.text,
          elapsedMs: Math.max(0, this.stream.reasoning.endedAt - this.stream.reasoning.startedAt),
        });
        return;
      }

      /* ---------------------------------------------------------- */
      /* Text                                                        */
      /* ---------------------------------------------------------- */
      case "session.text.started": {
        this.ensureAssistant(stringValue(data?.assistantMessageID), event.sessionID);
        this.postStatus("thinking", "", true);
        return;
      }

      case "session.text.delta": {
        const part: TextDelta | null = extractTextDelta(event);
        if (!part) return;
        this.ensureAssistant(part.messageID, part.sessionID);
        this.stream.text += part.text;
        // Post only the new chunk. The webview accumulates. Sending the full
        // accumulated text here made every delta O(n) and the stream O(n^2).
        this.post({
          type: "assistant-delta",
          messageID: this.stream.messageID,
          delta: part.text,
        });
        this.postStatus("thinking", "", true);
        this.maybeCheckRepetition();
        return;
      }

      case "session.text.ended": {
        const fullText = stringValue(data?.text) ?? "";
        const messageID = stringValue(data?.assistantMessageID);
        this.ensureAssistant(messageID, event.sessionID);
        if (fullText && fullText !== this.stream.text) {
          // Correct the stream if a delta was missed (e.g. during reconnect).
          // `resync` tells the webview to replace, not append.
          this.stream.text = fullText;
          this.post({
            type: "assistant-delta",
            messageID: this.stream.messageID,
            delta: "",
            text: fullText,
            resync: true,
          });
        }
        // Do not mark idle here: v2.3.0 emits step.ended and execution.*
        // after the last text part. Finish on session.idle/execution.succeeded.
        return;
      }

      /* ---------------------------------------------------------- */
      /* Tool calls                                                  */
      /* ---------------------------------------------------------- */
      case "session.tool.input.started": {
        const id = toolEventID(data);
        if (!id) return;
        this.ensureAssistant(stringValue(data?.assistantMessageID), event.sessionID);
        const name = toolEventName(data);
        const tool: StreamingTool = {
          id,
          name,
          input: {},
          status: "pending",
          created: Date.now(),
        };
        this.stream.tools.set(id, tool);
        this.post({
          type: "tool-start",
          messageID: this.stream.messageID,
          tool: this.serializeTool(tool),
        });
        return;
      }

      case "session.tool.input.delta":
      case "session.tool.input.ended": {
        const id = toolEventID(data);
        if (!id) return;
        const tool = this.stream.tools.get(id);
        if (!tool) return;
        const raw = stringValue(data?.delta) ?? stringValue(data?.text);
        if (raw !== undefined) {
          const parsed = parseToolInput(raw);
          tool.input = parsed;
          this.post({
            type: "tool-update",
            messageID: this.stream.messageID,
            tool: this.serializeTool(tool),
          });
        }
        return;
      }

      case "session.tool.called": {
        const id = toolEventID(data);
        if (!id) return;
        this.ensureAssistant(stringValue(data?.assistantMessageID), event.sessionID);
        const calledName = stringValue(data?.name) ?? stringValue(data?.tool);
        let tool = this.stream.tools.get(id);
        if (!tool) {
          tool = {
            id,
            name: calledName ?? "tool",
            input: {},
            status: "pending",
            created: Date.now(),
          };
          this.stream.tools.set(id, tool);
        }
        if (calledName) tool.name = calledName;
        tool.input = parseToolInput(data?.input);
        tool.status = "running";
        this.collectToolFiles(tool);
        this.post({
          type: "tool-update",
          messageID: this.stream.messageID,
          tool: this.serializeTool(tool),
        });
        return;
      }

      case "session.tool.progress": {
        const id = toolEventID(data);
        if (!id) return;
        const tool = this.stream.tools.get(id);
        if (!tool) return;
        tool.status = "running";
        if (data?.metadata && typeof data.metadata === "object") {
          tool.metadata = data.metadata as Record<string, unknown>;
        }
        this.post({
          type: "tool-update",
          messageID: this.stream.messageID,
          tool: this.serializeTool(tool),
        });
        return;
      }

      case "session.tool.success": {
        const id = toolEventID(data);
        if (!id) return;
        this.ensureAssistant(stringValue(data?.assistantMessageID), event.sessionID);
        let tool = this.stream.tools.get(id);
        if (!tool) {
          tool = {
            id,
            name: toolEventName(data),
            input: {},
            status: "running",
            created: Date.now(),
          };
          this.stream.tools.set(id, tool);
        }
        tool.status = "done";
        tool.content = toolContent(data?.content);
        if (data?.metadata && typeof data.metadata === "object") {
          tool.metadata = data.metadata as Record<string, unknown>;
        }
        if (data?.outputPaths) {
          tool.metadata = { ...(tool.metadata ?? {}), outputPaths: stringArray(data.outputPaths) };
        }
        if (data?.structured && typeof data.structured === "object") {
          tool.metadata = { ...(tool.metadata ?? {}), structured: data.structured };
        }
        this.collectToolFiles(tool);
        this.post({
          type: "tool-update",
          messageID: this.stream.messageID,
          tool: this.serializeTool(tool),
        });
        return;
      }

      case "session.tool.failed": {
        const id = toolEventID(data);
        if (!id) return;
        this.ensureAssistant(stringValue(data?.assistantMessageID), event.sessionID);
        let tool = this.stream.tools.get(id);
        if (!tool) {
          tool = {
            id,
            name: toolEventName(data),
            input: {},
            status: "running",
            created: Date.now(),
          };
          this.stream.tools.set(id, tool);
        }
        tool.status = "failed";
        tool.content = toolContent(data?.content);
        tool.error = structuredError(data?.error) || "Tool failed";
        if (this.isStopLike(data?.error ?? tool.error, event.sessionID)) {
          tool.status = "stopped";
          tool.error = undefined;
        }
        this.post({
          type: "tool-update",
          messageID: this.stream.messageID,
          tool: this.serializeTool(tool),
        });
        if (tool.status !== "stopped") this.showToolFailure(tool.error, tool.name);
        return;
      }

      /* ---------------------------------------------------------- */
      /* Steps / usage / status                                      */
      /* ---------------------------------------------------------- */
      case "session.step.started": {
        const agent = stringValue(data?.agent);
        if (agent) {
          this.currentAgent = agent;
        }
        const model = this.parseModelRef(data?.model);
        if (model) this.stream.model = model;
        this.post({ type: "agent-selected", agent: this.currentAgent ?? null });
        return;
      }

      case "session.step.ended":
      case "session.step.failed": {
        const tokens = (data?.tokens ?? null) as TokenUsage | null;
        if (tokens && typeof tokens === "object") {
          this.stream.tokens = tokens;
          this.setContextFromTokens(tokens, numberOrUndefined(data?.cost));
        }
        const files = stringArray(data?.files);
        for (const file of files) this.stream.files.set(file, file);
        if (files.length > 0) {
          this.post({
            type: "files-changed",
            messageID: this.stream.messageID,
            files: [...this.stream.files.values()],
          });
        }
        if (event.type === "session.step.failed") {
          const rawError = data?.error ?? "The model step failed";
          if (this.isStopLike(rawError, event.sessionID)) {
            this.neutralStop(event.sessionID);
          } else {
            this.showExecutionFailure(rawError, true);
          }
        }
        return;
      }

      case "session.usage.updated":
      case "session.usage.recorded": {
        const cost = numberOrUndefined(data?.cost);
        if (typeof cost === "number") this.contextCost = cost;
        this.postContext();
        return;
      }

      case "session.execution.started": {
        if (!this.generating) {
          this.generating = true;
          this.postStatus("thinking", "", true);
        }
        this.startResponseTimer();
        this.postSessions();
        return;
      }

      case "session.status": {
        const status = asRecord(data?.status);
        const type = stringValue(status?.type) ?? "busy";
        if (type === "busy") {
          if (!this.generating) {
            this.generating = true;
            this.postStatus("thinking", "", true);
          }
          this.postSessions();
        } else if (type === "retry") {
          const message = stringValue(status?.message) ?? "Retrying…";
          this.postStatus("waiting", message, true);
        } else {
          this.finishStreaming();
          void this.loadSessions();
        }
        return;
      }

      case "session.execution.succeeded":
      case "session.idle":
        this.finishStreaming();
        void this.loadSessions();
        return;

      case "session.execution.interrupted":
        // May originate from our Stop button or another client. Either way it
        // is a neutral stop, never an error.
        this.neutralStop(event.sessionID);
        return;

      case "session.execution.failed": {
        const errorObj = data?.error ?? data;
        if (this.isStopLike(errorObj, event.sessionID)) {
          this.neutralStop(event.sessionID);
          return;
        }
        this.showExecutionFailure(errorObj, true);
        return;
      }

      /* ---------------------------------------------------------- */
      /* Permissions / forms                                         */
      /* ---------------------------------------------------------- */
      case "permission.asked": {
        const request = this.parsePermissionRequest(data);
        if (!request) return;
        if (this.maybeAutoApprove(request)) {
          this.debugLog(
            `auto-approving read-only permission ${request.id} (${request.action}) once`
          );
          void this.replyPermission(request.id, "once");
          return;
        }
        this.permissions.set(request.id, request);
        this.post({ type: "permission-request", request });
        return;
      }

      case "permission.replied": {
        const requestID = stringValue(data?.requestID) ?? stringValue(data?.id) ?? "";
        if (!requestID) return;
        this.permissions.delete(requestID);
        this.post({
          type: "permission-resolved",
          requestID,
          decision: stringValue(data?.reply) ?? stringValue(data?.decision) ?? "",
        });
        return;
      }

      case "form.created": {
        const form = this.parseForm(data);
        if (!form) return;
        this.forms.set(form.id, form);
        this.post({ type: "question-request", form });
        return;
      }

      case "form.replied":
      case "form.cancelled": {
        const id =
          stringValue(data?.id) ??
          stringValue(asRecord(data?.form)?.id) ??
          stringValue(data?.formID) ??
          "";
        if (!id) return;
        this.forms.delete(id);
        this.post({ type: "question-resolved", formID: id });
        return;
      }

      /* ---------------------------------------------------------- */
      /* Agent / model / compaction / revert                         */
      /* ---------------------------------------------------------- */
      case "session.agent.selected": {
        const agent = stringValue(data?.agent);
        if (agent) {
          this.currentAgent = agent;
          this.post({ type: "agent-selected", agent });
        }
        return;
      }

      case "session.model.selected": {
        const model = this.parseModelRef(data?.model);
        if (model) {
          this.selectedModel = model;
          this.opts.persistModel?.(model);
          this.recomputeContextLimit();
          this.post({ type: "model-selected", selectedModel: model });
          this.postContext();
        }
        return;
      }

      case "session.compaction.started": {
        this.compaction = {
          reason: stringValue(data?.reason) ?? "manual",
          text: "",
          running: true,
        };
        this.post({ type: "compaction", compaction: this.compaction });
        return;
      }

      case "session.compaction.delta": {
        if (!this.compaction) this.compaction = { reason: "manual", text: "", running: true };
        this.compaction.text += stringValue(data?.text) ?? stringValue(data?.delta) ?? "";
        this.post({ type: "compaction", compaction: this.compaction });
        return;
      }

      case "session.compaction.ended":
      case "session.compaction.failed": {
        this.compaction = {
          reason: stringValue(data?.reason) ?? this.compaction?.reason ?? "manual",
          text: stringValue(data?.text) ?? this.compaction?.text ?? "",
          running: false,
        };
        this.post({ type: "compaction", compaction: this.compaction });
        void this.loadSessions();
        return;
      }

      case "session.revert.staged":
      case "session.revert.committed":
      case "session.revert.cleared": {
        if (this.currentSessionID) {
          void this.client.getMessages(this.currentSessionID).then((history) => {
            this.applyHistoryContext(history);
            this.post({ type: "history", history });
            this.postContext();
          });
        }
        return;
      }

      case "session.created":
        // Never adopt another client's session id. Ignored on purpose.
        this.debugLog("ignoring session.created (only our own createSession id is trusted)");
        return;

      default:
        if (this.unknownEventLogs < MAX_UNKNOWN_EVENT_LOGS) {
          this.unknownEventLogs += 1;
          this.debugLog(`unhandled SSE event: ${event.type}`);
        }
    }
  }

  private ensureAssistant(messageID: string | undefined, sessionID?: string): void {
    if (this.stream.messageID) return;
    if (!messageID) return;
    this.stream.messageID = messageID;
    this.stream.startedAt = Date.now();
    this.stream.agent = this.stream.agent ?? this.currentAgent;
    this.stream.model = this.stream.model ?? this.selectedModel ?? undefined;
    this.post({
      type: "assistant-start",
      messageID,
      sessionID,
      agent: this.stream.agent,
      model: this.stream.model,
    });
  }

  private parseModelRef(value: unknown): ModelRef | undefined {
    const obj = asRecord(value);
    if (!obj) return undefined;
    const providerID = stringValue(obj.providerID);
    const modelID = stringValue(obj.id) ?? stringValue(obj.modelID);
    if (!providerID || !modelID) return undefined;
    return {
      providerID,
      modelID,
      ...(stringValue(obj.variant) ? { variant: stringValue(obj.variant) } : {}),
    };
  }

  private serializeTool(tool: StreamingTool): Record<string, unknown> {
    return {
      id: tool.id,
      name: tool.name,
      title: toolTitle(tool),
      kind: toolKind(tool.name),
      status: tool.status,
      input: tool.input,
      content: tool.content ?? [],
      metadata: tool.metadata ?? {},
      error: tool.error,
      files: this.toolFiles(tool),
      created: tool.created,
    };
  }

  private toolFiles(tool: StreamingTool): string[] {
    const files = new Set<string>();
    if (typeof tool.input === "object" && tool.input) {
      for (const key of ["path", "filePath", "file_path", "filename"]) {
        const value = tool.input[key];
        if (typeof value === "string" && value.trim()) files.add(value.trim());
      }
    }
    const metadata = tool.metadata;
    if (metadata) {
      for (const key of ["outputPaths", "files"]) {
        for (const value of stringArray(metadata[key])) files.add(value);
      }
    }
    return [...files];
  }

  private collectToolFiles(tool: StreamingTool): void {
    const kind = toolKind(tool.name);
    if (kind !== "write" && kind !== "edit") return;
    for (const file of this.toolFiles(tool)) this.stream.files.set(file, file);
  }

  private parsePermissionRequest(data: Record<string, unknown> | null): PermissionRequest | null {
    if (!data) return null;
    const id = stringValue(data.id);
    const sessionID = stringValue(data.sessionID);
    if (!id || !sessionID) return null;
    return {
      id,
      sessionID,
      action: stringValue(data.action) ?? "unknown",
      resources: stringArray(data.resources),
      ...(Array.isArray(data.save) ? { save: stringArray(data.save) } : {}),
      ...(asRecord(data.metadata) ? { metadata: asRecord(data.metadata)! } : {}),
      ...(asRecord(data.source) ? { source: asRecord(data.source)! } : {}),
      ...(stringValue(data.message) ? { message: stringValue(data.message) } : {}),
    };
  }

  /** Normalize v2.3.0 `form.created` and v1.19.6 `question.v2.asked`. */
  private parseForm(data: Record<string, unknown> | null): FormInfo | null {
    if (!data) return null;
    const raw = asRecord(data.form) ?? asRecord(data.question) ?? data;
    const id = stringValue(raw.id);
    const sessionID = stringValue(raw.sessionID) ?? stringValue(data.sessionID);
    if (!id || !sessionID) return null;
    let fields = Array.isArray(raw.fields) ? (raw.fields as FormInfo["fields"]) : [];
    if (fields.length === 0 && Array.isArray(data.options)) {
      fields = [
        {
          key: "answer",
          title: stringValue(raw.question) ?? stringValue(raw.title) ?? "Question",
          type: "string",
          options: (data.options as Array<Record<string, unknown>>).map((o) => ({
            value: String(o.value ?? o.label ?? o),
            label: String(o.label ?? o.value ?? o),
          })),
          custom: true,
        },
      ];
    }
    return {
      id,
      sessionID,
      title: stringValue(raw.title) ?? stringValue(raw.question) ?? "Question",
      fields,
      ...(asRecord(raw.metadata) ? { metadata: asRecord(raw.metadata)! } : {}),
    };
  }

  private structuredErrorMessage(value: unknown): string {
    if (!value) return "OpenCode execution failed";
    if (typeof value === "string") return value;
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const nestedData = asRecord(obj.data);
      const nestedError = asRecord(obj.error);
      const candidates = [
        obj.message,
        nestedData?.message,
        nestedError?.message,
        obj.detail,
        obj.reason,
      ];
      for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) return candidate;
      }
      if (typeof obj.name === "string") return obj.name;
      try {
        return JSON.stringify(value);
      } catch {
        return "OpenCode execution failed";
      }
    }
    return String(value);
  }

  /* ------------------------------------------------------------------ */
  /* Disposal                                                           */
  /* ------------------------------------------------------------------ */

  dispose(): void {
    this.disposed = true;
    this.stopResponseTimer();
    this.stopEventStream();
  }

  private post(message: unknown): void {
    try {
      this.opts.post(message);
    } catch (err) {
      logWarn(`Failed to post message to webview: ${errMessage(err)}`);
    }
  }

  private debugLog(message: string): void {
    logDebug(`[chat] ${message}`, this.opts.debug ?? false);
  }
}
