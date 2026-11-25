import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ChatController,
  contextUsedFromTokens,
  toolKind,
  toolTitle,
} from "../test-build/chatController.js";
import { parseEventPayload } from "../test-build/events.js";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeClient {
  constructor() {
    this.providers = [{ id: "test-provider", name: "Test Provider" }];
    this.models = [
      { id: "model-a", modelID: "model-a", providerID: "test-provider", name: "Model A" },
    ];
    this.history = [];
    this.providersError = null;
    this.modelsError = null;
    this.historyError = null;

    this.creates = 0;
    this.prompts = [];
    this.interrupts = [];
    this.messagesCalls = [];
    this.persistedModels = [];

    this.opens = 0;
    this.live = new Set();
    this.signals = [];
    this.onEvent = null;

    this.authHeader = undefined;
    this.baseUrl = undefined;

    this.agents = [{ id: "build", name: "Build", mode: "primary", hidden: false }];
    this.commands = [];
    this.skills = [];
    this.sessionSummaries = [];
    this.sessionCursor = undefined;
    this.activeSessions = [];
    this.sessionDetails = {};
    this.pendingPermissions = [];
    this.pendingForms = [];
    this.sessionAgents = [];
    this.sessionModels = [];
    this.permissionReplies = [];
    this.formReplies = [];
    this.compactions = [];
    this.listSessionCalls = [];
  }

  async createSession(opts) {
    this.creates += 1;
    this.createOptions = opts;
    return { id: "ses_ours" };
  }

  async prompt(opts) {
    if (this.promptError) throw new Error(this.promptError);
    this.prompts.push(opts);
    return { messageID: "msg_user" };
  }

  async getProviders() {
    if (this.providersError) throw new Error(this.providersError);
    return this.providers;
  }

  async getModels() {
    if (this.modelsError) throw new Error(this.modelsError);
    return this.models;
  }

  async getMessages(sessionID) {
    this.messagesCalls.push(sessionID);
    if (this.historyError) throw new Error(this.historyError);
    return this.history;
  }

  async interrupt(sessionID) {
    this.interrupts.push(sessionID);
  }

  async streamEvents({ signal, onEvent }) {
    this.opens += 1;
    this.signals.push(signal);
    this.live.add(signal);
    this.onEvent = onEvent;
    try {
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      this.live.delete(signal);
    }
  }

  emit(payload, sseEvent) {
    const event = parseEventPayload(payload, sseEvent);
    this.onEvent?.(event);
  }

  setAuthHeader(header) {
    this.authHeader = header;
  }

  setBaseUrl(url) {
    this.baseUrl = url;
  }

  async getAgents(directory) {
    this.agentsDirectory = directory;
    return this.agents;
  }

  async getCommands(directory) {
    this.commandsDirectory = directory;
    return this.commands;
  }

  async getSkills(directory) {
    this.skillsDirectory = directory;
    return this.skills;
  }

  async listSessions(opts) {
    this.listSessionCalls.push(opts);
    return { sessions: this.sessionSummaries, next: this.sessionCursor };
  }

  async getActiveSessions() {
    return this.activeSessions;
  }

  async getSession(sessionID) {
    return this.sessionDetails[sessionID] ?? null;
  }

  async getPermissions(sessionID) {
    this.pendingPermissionsSession = sessionID;
    return this.pendingPermissions;
  }

  async getForms(sessionID) {
    this.pendingFormsSession = sessionID;
    return this.pendingForms;
  }

  async replyPermission(sessionID, requestID, decision, message) {
    this.permissionReplies.push({ sessionID, requestID, decision, message });
  }

  async replyForm(sessionID, formID, answer) {
    this.formReplies.push({ sessionID, formID, answer });
  }

  async setSessionAgent(sessionID, agent) {
    this.sessionAgents.push([sessionID, agent]);
  }

  async setSessionModel(sessionID, model) {
    this.sessionModels.push([sessionID, model]);
  }

  async compact(sessionID) {
    this.compactions.push(sessionID);
  }
}

function makeController(overrides = {}) {
  const client = overrides.client ?? new FakeClient();
  const posts = [];
  const controller = new ChatController({
    client,
    post: (message) => posts.push(message),
    mode: "managed",
    serverUrl: "http://127.0.0.1:1234/api",
    workspaceDir: "/tmp/workspace",
    debug: true,
    ...overrides.options,
  });
  return { client, posts, controller };
}

function byType(posts, type) {
  return posts.filter((message) => message.type === type);
}

test("P0: a webview send message creates a session, echoes the user message and prompts", async () => {
  const { client, posts, controller } = makeController();
  try {
    await controller.handleMessage({ type: "ready" });
    assert.equal(client.opens, 1, "ready must open exactly one SSE subscription");

    posts.length = 0;
    await controller.handleMessage({ type: "send", text: "hello world" });

    assert.equal(client.creates, 1, "first send must create a session");
    assert.equal(client.prompts.length, 1, "prompt must be sent to the server");
    assert.equal(client.prompts[0].text, "hello world");
    assert.equal(client.prompts[0].sessionID, "ses_ours");

    const userMessages = byType(posts, "user-message");
    assert.equal(userMessages.length, 1);
    assert.equal(userMessages[0].text, "hello world");
    assert.ok(userMessages[0].id);

    assert.ok(
      byType(posts, "status").some((message) => message.status === "thinking"),
      "a thinking status must be posted"
    );
    assert.equal(byType(posts, "prompt-failed").length, 0);
  } finally {
    controller.dispose();
  }
});

test("P0: a send with an existing session does not create a second session", async () => {
  const { client, posts, controller } = makeController({
    options: { sessionID: "ses_existing" },
  });
  try {
    await controller.handleMessage({ type: "send", text: "again" });
    assert.equal(client.creates, 0);
    assert.equal(client.prompts.length, 1);
    assert.equal(client.prompts[0].sessionID, "ses_existing");
    assert.equal(byType(posts, "user-message")[0].text, "again");
  } finally {
    controller.dispose();
  }
});

test("init only says no-providers when GET /api/provider succeeded with zero providers", async () => {
  {
    const { client, posts, controller } = makeController();
    client.providers = [];
    client.models = [];
    await controller.handleMessage({ type: "ready" });
    const init = byType(posts, "init").at(-1);
    assert.equal(init.noProviders, true);
    assert.equal(init.providersError, null);
    assert.equal(controller.getBanner().kind, "warning");
    assert.match(controller.getBanner().message, /No model providers/);
    controller.dispose();
  }

  {
    const { client, posts, controller } = makeController();
    client.providersError = "HTTP 401: authentication required";
    client.modelsError = "HTTP 401: authentication required";
    await controller.handleMessage({ type: "ready" });
    const init = byType(posts, "init").at(-1);
    assert.equal(init.noProviders, false);
    assert.equal(init.providersError, "HTTP 401: authentication required");
    assert.equal(controller.getBanner().kind, "auth");
    assert.doesNotMatch(controller.getBanner().message, /No model providers/);
    assert.match(controller.getBanner().details, /401/);
    controller.dispose();
  }

  {
    const { client, posts, controller } = makeController();
    client.modelsError = "HTTP 500: boom";
    await controller.handleMessage({ type: "ready" });
    const init = byType(posts, "init").at(-1);
    assert.equal(init.noProviders, false);
    assert.equal(controller.getBanner().kind, "error");
    assert.match(controller.getBanner().details, /500/);
    controller.dispose();
  }
});

test("history is restored from GET /api/session/{id}/message on init", async () => {
  const { client, posts, controller } = makeController({
    options: { sessionID: "ses_hist" },
  });
  client.history = [
    { id: "msg_1", role: "user", text: "hi", created: 1 },
    { id: "msg_2", role: "assistant", text: "hello", created: 2 },
  ];
  try {
    await controller.handleMessage({ type: "ready" });
    assert.deepEqual(client.messagesCalls, ["ses_hist"]);
    const init = byType(posts, "init").at(-1);
    assert.equal(init.history.length, 2);
    assert.equal(init.history[0].text, "hi");
  } finally {
    controller.dispose();
  }
});

test("model selection posts model-selected (never an empty init) and persists", async () => {
  const persisted = [];
  const { client, posts, controller } = makeController({
    options: { persistModel: (model) => persisted.push(model) },
  });
  try {
    await controller.handleMessage({
      type: "selectModel",
      model: { providerID: "test-provider", modelID: "model-a" },
    });
    assert.deepEqual(controller.getSelectedModel(), {
      providerID: "test-provider",
      modelID: "model-a",
    });
    assert.deepEqual(persisted, [{ providerID: "test-provider", modelID: "model-a" }]);
    assert.equal(byType(posts, "model-selected").length, 1);
    assert.equal(byType(posts, "init").length, 0, "selection must not wipe the model list");
    assert.equal(byType(posts, "model-selected")[0].selectedModel.modelID, "model-a");
  } finally {
    controller.dispose();
  }
});

test("session.created never adopts another client's session", async () => {
  const { client, controller } = makeController({
    options: { sessionID: "ses_ours" },
  });
  try {
    await controller.handleMessage({ type: "ready" });
    client.emit({
      type: "session.created",
      data: { sessionID: "ses_other_client", title: "TUI session" },
    });
    assert.equal(controller.getSessionID(), "ses_ours");
  } finally {
    controller.dispose();
  }
});

test("events for other sessions are ignored; own deltas are applied once", async () => {
  const { client, posts, controller } = makeController({
    options: { sessionID: "ses_ours" },
  });
  try {
    await controller.handleMessage({ type: "ready" });
    posts.length = 0;

    client.emit({
      type: "session.text.delta",
      id: "evt_other",
      data: {
        sessionID: "ses_other",
        assistantMessageID: "msg_other",
        delta: "other text",
      },
    });
    assert.equal(byType(posts, "assistant-delta").length, 0);

    const payload = {
      type: "session.text.delta",
      id: "evt_ours",
      data: {
        sessionID: "ses_ours",
        assistantMessageID: "msg_ours",
        delta: "Hello",
      },
    };
    client.emit(payload);
    client.emit(payload); // simulate duplicate delivery after a reconnect

    const deltas = byType(posts, "assistant-delta");
    assert.equal(deltas.length, 1, "the same event id must not be applied twice");
    assert.equal(deltas[0].delta, "Hello");
    assert.equal(deltas[0].text, undefined, "deltas must not repeat the accumulated text");
    assert.equal(byType(posts, "assistant-start").length, 1);
  } finally {
    controller.dispose();
  }
});

test("restarting the event stream keeps exactly one live subscription", async () => {
  const { client, controller } = makeController();
  try {
    await controller.handleMessage({ type: "ready" });
    controller.ensureEventStream();
    controller.ensureEventStream();
    await wait(0);

    assert.equal(client.opens, 3, "each restart opens one stream");
    assert.equal(client.live.size, 1, "only the newest subscription may stay live");
    assert.equal(client.signals.filter((signal) => !signal.aborted).length, 1);

    controller.stopEventStream();
    await wait(0);
    assert.equal(client.live.size, 0);
  } finally {
    controller.dispose();
  }
});

test("dispose closes the SSE subscription", async () => {
  const { client, controller } = makeController();
  await controller.handleMessage({ type: "ready" });
  assert.equal(client.live.size, 1);
  controller.dispose();
  await wait(0);
  assert.equal(client.live.size, 0);
});

test("slow responses show a cancellable still-waiting status, not a hard error", async () => {
  const { client, posts, controller } = makeController({
    options: { sessionID: "ses_slow", getResponseTimeoutSeconds: () => 0.05 },
  });
  try {
    await controller.handleMessage({ type: "send", text: "slow one" });
    assert.equal(client.prompts.length, 1);
    await wait(120);

    const waiting = byType(posts, "status").filter((message) => message.status === "waiting");
    assert.equal(waiting.length, 1);
    assert.match(waiting[0].message, /Still waiting/);
    assert.equal(waiting[0].canCancel, true);
    assert.equal(byType(posts, "prompt-failed").length, 0);

    await controller.handleMessage({ type: "stop" });
    assert.deepEqual(client.interrupts, ["ses_slow"]);
    assert.equal(byType(posts, "status").at(-1).status, "idle");
  } finally {
    controller.dispose();
  }
});

test("a failed prompt shows one banner plus an inline prompt bubble", async () => {
  const { client, posts, controller } = makeController({
    options: { sessionID: "ses_fail" },
  });
  client.promptError = "HTTP 500: provider exploded";
  try {
    await controller.handleMessage({ type: "send", text: "nope" });
    const failed = byType(posts, "prompt-failed");
    assert.equal(failed.length, 1);
    assert.match(failed[0].message, /500/);
    const banners = byType(posts, "banner");
    assert.equal(banners.length, 1);
    assert.equal(banners[0].banner.kind, "error");
    assert.equal(controller.getBanner().kind, "error");
  } finally {
    controller.dispose();
  }
});

/* ------------------------------------------------------------------------- */
/* v2.3.0 feature reducer tests                                              */
/* ------------------------------------------------------------------------- */

const fixtureEvents = JSON.parse(
  readFileSync(new URL("./fixtures/reasoning-tool-permission.json", import.meta.url), "utf8")
);

const FIXTURE_MODEL = {
  id: "tidepool-alpha-free",
  modelID: "tidepool-alpha-free",
  providerID: "opencode",
  name: "Tidepool Alpha",
  limit: { context: 200000, output: 32000 },
  variants: [{ id: "medium" }, { id: "high" }],
};

test("context math uses input + cache.read from the latest step", () => {
  assert.equal(contextUsedFromTokens(undefined), 0);
  assert.equal(
    contextUsedFromTokens({ input: 100, output: 5, reasoning: 3, cache: { read: 50, write: 9 } }),
    150
  );
  assert.equal(
    contextUsedFromTokens({ input: -5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
    0
  );
  assert.equal(contextUsedFromTokens({ input: 100 }), 100, "missing cache is treated as zero");
});

test("tool titles and kinds map from verified tool inputs", () => {
  assert.equal(toolTitle({ name: "read", input: { path: "src/a.ts" } }), "src/a.ts");
  assert.equal(toolTitle({ name: "shell", input: { command: "npm test" } }), "npm test");
  assert.equal(
    toolTitle({ name: "grep", input: { pattern: "TODO", include: "src" } }),
    "TODO in src"
  );
  assert.equal(toolTitle({ name: "todowrite", input: {} }), "Update todos");
  assert.equal(toolKind("read"), "read");
  assert.equal(toolKind("edit"), "edit");
  assert.equal(toolKind("write"), "write");
  assert.equal(toolKind("bash"), "bash");
  assert.equal(toolKind("grep"), "search");
  assert.equal(toolKind("webfetch"), "web");
  assert.equal(toolKind("task"), "subagent");
  assert.equal(toolKind("todowrite"), "todo");
  assert.equal(toolKind("mystery"), "tool");
});

test("recorded reasoning -> tool -> permission -> text sequence reduces correctly", async () => {
  const { client, posts, controller } = makeController({ options: { sessionID: "ses_fixture" } });
  client.models = [FIXTURE_MODEL];
  try {
    controller.setSelectedModel({
      providerID: "opencode",
      modelID: "tidepool-alpha-free",
    });
    await controller.handleMessage({ type: "ready" });
    posts.length = 0;

    for (const event of fixtureEvents) client.emit(event);
    await wait(0);

    const reasoningStart = byType(posts, "reasoning-start");
    assert.equal(reasoningStart.length, 1);
    assert.equal(reasoningStart[0].messageID, "msg_fixture_assistant");

    const reasoningDeltas = byType(posts, "reasoning-delta");
    assert.equal(reasoningDeltas.length, 2);
    assert.equal(
      reasoningDeltas.at(-1).text,
      "The user wants me to read a file. I should use the read tool."
    );

    const reasoningEnd = byType(posts, "reasoning-end");
    assert.equal(reasoningEnd.length, 1);
    assert.equal(
      reasoningEnd[0].text,
      "The user wants me to read a file. I should use the read tool."
    );
    assert.equal(typeof reasoningEnd[0].elapsedMs, "number");

    const toolStarts = byType(posts, "tool-start");
    assert.equal(toolStarts.length, 1);
    assert.equal(toolStarts[0].tool.id, "call_fixture_read");
    assert.equal(toolStarts[0].tool.kind, "read");

    const toolUpdates = byType(posts, "tool-update");
    const running = toolUpdates.find((message) => message.tool.status === "running");
    assert.ok(running, "the tool must be marked running when called");
    assert.equal(running.tool.title, ".env");
    assert.equal(running.tool.input.path, ".env");

    const done = toolUpdates.at(-1);
    assert.equal(done.tool.status, "done");
    assert.equal(done.tool.content[0].text, "SECRET=topsecret");

    const permission = byType(posts, "permission-request");
    assert.equal(permission.length, 1);
    assert.equal(permission[0].request.id, "per_fixture_read");
    assert.equal(permission[0].request.action, "read");
    assert.deepEqual(permission[0].request.resources, [".env"]);
    assert.deepEqual(permission[0].request.save, ["*"]);

    const resolved = byType(posts, "permission-resolved");
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].requestID, "per_fixture_read");
    assert.equal(resolved[0].decision, "once");

    assert.equal(
      byType(posts, "assistant-delta").at(-1).delta,
      "The .env file contains SECRET=topsecret."
    );

    const context = byType(posts, "context").at(-1);
    assert.equal(context.used, 15900, "108 input + 15792 cache read from the final step");
    assert.equal(context.limit, 200000);
    assert.equal(context.percent, 8);
    assert.equal(context.breakdown.cache.read, 15792);

    assert.equal(byType(posts, "status").at(-1).status, "idle");
    assert.equal(controller.isGenerating(), false);
  } finally {
    controller.dispose();
  }
});

test("init exposes primary agents, commands and skills; agents can be selected and cycled", async () => {
  const { client, posts, controller } = makeController({ options: { sessionID: "ses_agent" } });
  client.agents = [
    { id: "build", name: "Build", mode: "primary", hidden: false },
    { id: "plan", name: "Plan", mode: "primary", hidden: false },
    { id: "secret", name: "Hidden", mode: "primary", hidden: true },
    { id: "explore", name: "Explore", mode: "subagent", hidden: false },
  ];
  client.commands = [{ name: "review", description: "Review changes" }];
  client.skills = [{ id: "sk_1", name: "deploy", description: "Deploy", path: "/tmp/skill" }];
  try {
    await controller.handleMessage({ type: "ready" });
    const init = byType(posts, "init").at(-1);
    assert.deepEqual(init.agents.map((agent) => agent.id), ["build", "plan"]);
    assert.equal(init.agent, "build");
    assert.deepEqual(init.commands.map((command) => command.name), ["review"]);
    assert.deepEqual(init.skills.map((skill) => skill.name), ["deploy"]);

    await controller.handleMessage({ type: "selectAgent", agent: "plan" });
    assert.deepEqual(client.sessionAgents, [["ses_agent", "plan"]]);
    assert.equal(byType(posts, "agent-selected").at(-1).agent, "plan");

    await controller.handleMessage({ type: "cycleAgent", step: -1 });
    assert.equal(byType(posts, "agent-selected").at(-1).agent, "build");
    assert.deepEqual(client.sessionAgents.at(-1), ["ses_agent", "build"]);

    await controller.handleMessage({ type: "selectAgent", agent: "not-an-agent" });
    assert.equal(byType(posts, "agent-selected").at(-1).agent, "build");
  } finally {
    controller.dispose();
  }
});

test("model variants are listed and sent in the verified Model.Ref.variant field", async () => {
  const { client, posts, controller } = makeController({ options: { sessionID: "ses_variant" } });
  client.models = [
    {
      ...FIXTURE_MODEL,
      variants: [{ id: "low" }, { id: "medium" }, { id: "high" }],
    },
  ];
  try {
    await controller.handleMessage({ type: "ready" });
    const init = byType(posts, "init").at(-1);
    assert.deepEqual(init.models[0].variants, ["low", "medium", "high"]);
    assert.equal(init.models[0].contextLimit, 200000);

    await controller.handleMessage({
      type: "selectVariant",
      model: { providerID: "opencode", modelID: "tidepool-alpha-free" },
      variant: "high",
    });
    const selected = byType(posts, "model-selected").at(-1).selectedModel;
    assert.equal(selected.variant, "high");
    assert.deepEqual(client.sessionModels.at(-1), [
      "ses_variant",
      { providerID: "opencode", modelID: "tidepool-alpha-free", variant: "high" },
    ]);

    client.emit({
      type: "session.model.selected",
      id: "evt_variant_low",
      data: {
        sessionID: "ses_variant",
        model: { id: "tidepool-alpha-free", providerID: "opencode", variant: "low" },
      },
    });
    assert.equal(byType(posts, "model-selected").at(-1).selectedModel.variant, "low");
  } finally {
    controller.dispose();
  }
});

test("session list uses search/directory/order and marks running sessions", async () => {
  const { client, posts, controller } = makeController();
  client.sessionSummaries = [
    { id: "ses_new", title: "Newest", directory: "/tmp/workspace", updated: 30 },
    { id: "ses_old", title: "Older", directory: "/tmp/workspace", updated: 10 },
  ];
  client.sessionCursor = "cursor_2";
  client.activeSessions = ["ses_old"];
  try {
    await controller.handleMessage({ type: "ready" });
    posts.length = 0;

    await controller.handleMessage({ type: "listSessions", search: "old" });
    const call = client.listSessionCalls.at(-1);
    assert.equal(call.search, "old");
    assert.equal(call.order, "desc");
    assert.equal(call.limit, 30);
    assert.equal(call.directory, "/tmp/workspace");

    const sessions = byType(posts, "sessions").at(-1);
    assert.deepEqual(sessions.sessions.map((session) => session.id), ["ses_new", "ses_old"]);
    assert.equal(sessions.cursor, "cursor_2");
    assert.equal(sessions.sessions[1].busy, true);
    assert.equal(sessions.sessions[0].busy, false);
  } finally {
    controller.dispose();
  }
});

test("switching sessions loads history, agent and model and persists the choice", async () => {
  const persisted = [];
  const { client, posts, controller } = makeController({
    options: { persistSession: (sessionID) => persisted.push(sessionID) },
  });
  client.history = [
    { id: "msg_u", role: "user", text: "hello", created: 1 },
    { id: "msg_a", role: "assistant", text: "hi", created: 2 },
  ];
  client.sessionDetails.ses_old = {
    id: "ses_old",
    title: "Older",
    agent: "plan",
    model: { providerID: "opencode", modelID: "tidepool-alpha-free" },
  };
  try {
    await controller.handleMessage({ type: "ready" });
    posts.length = 0;

    await controller.handleMessage({ type: "switchSession", sessionID: "ses_old" });
    assert.equal(controller.getSessionID(), "ses_old");
    assert.deepEqual(persisted, ["ses_old"]);

    const selected = byType(posts, "session-selected").at(-1);
    assert.equal(selected.sessionID, "ses_old");
    assert.equal(selected.history.length, 2);
    assert.equal(selected.agent, "plan");
    assert.equal(selected.selectedModel.modelID, "tidepool-alpha-free");
    assert.equal(client.pendingPermissionsSession, "ses_old");
    assert.equal(client.pendingFormsSession, "ses_old");
  } finally {
    controller.dispose();
  }
});

test("pending permissions and forms are replayed when the view reconnects", async () => {
  const { client, posts, controller } = makeController({ options: { sessionID: "ses_pending" } });
  client.pendingPermissions = [
    {
      id: "per_pending",
      sessionID: "ses_pending",
      action: "edit",
      resources: ["src/a.ts"],
    },
  ];
  client.pendingForms = [
    { id: "frm_pending", sessionID: "ses_pending", title: "Pick one", fields: [] },
  ];
  try {
    await controller.handleMessage({ type: "ready" });
    assert.equal(byType(posts, "permission-request").at(-1).request.id, "per_pending");
    assert.equal(byType(posts, "question-request").at(-1).form.id, "frm_pending");
  } finally {
    controller.dispose();
  }
});

test("permissions ask by default; readOnlyAuto only auto-approves safe actions once", async () => {
  {
    const { client, posts, controller } = makeController({
      options: { sessionID: "ses_perm_ask" },
    });
    try {
      await controller.handleMessage({ type: "ready" });
      posts.length = 0;
      client.emit({
        type: "permission.asked",
        id: "evt_perm_ask_1",
        data: {
          id: "per_ask",
          sessionID: "ses_perm_ask",
          action: "read",
          resources: ["README.md"],
        },
      });
      await wait(0);
      assert.equal(byType(posts, "permission-request").length, 1);
      assert.equal(client.permissionReplies.length, 0);
    } finally {
      controller.dispose();
    }
  }

  {
    const { client, posts, controller } = makeController({
      options: {
        sessionID: "ses_perm_auto",
        getPermissionsMode: () => "readOnlyAuto",
      },
    });
    try {
      await controller.handleMessage({ type: "ready" });
      posts.length = 0;
      client.emit({
        type: "permission.asked",
        id: "evt_perm_auto_read",
        data: {
          id: "per_read",
          sessionID: "ses_perm_auto",
          action: "read",
          resources: ["README.md"],
        },
      });
      await wait(0);
      assert.equal(byType(posts, "permission-request").length, 0);
      assert.equal(client.permissionReplies.length, 1);
      assert.equal(client.permissionReplies[0].decision, "once");

      client.emit({
        type: "permission.asked",
        id: "evt_perm_auto_edit",
        data: {
          id: "per_edit",
          sessionID: "ses_perm_auto",
          action: "edit",
          resources: ["src/a.ts"],
        },
      });
      await wait(0);
      assert.equal(byType(posts, "permission-request").length, 1);
      assert.equal(client.permissionReplies.length, 1, "edits are never auto-approved");
    } finally {
      controller.dispose();
    }
  }
});

test("permission and form replies use the verified reply payloads", async () => {
  const { client, posts, controller } = makeController({ options: { sessionID: "ses_reply" } });
  try {
    await controller.handleMessage({ type: "ready" });
    posts.length = 0;

    await controller.handleMessage({
      type: "replyPermission",
      requestID: "per_1",
      decision: "always",
    });
    assert.deepEqual(client.permissionReplies.at(-1), {
      sessionID: "ses_reply",
      requestID: "per_1",
      decision: "always",
      message: undefined,
    });
    assert.equal(byType(posts, "permission-resolved").at(-1).decision, "always");

    client.emit({
      type: "form.created",
      id: "evt_form_created",
      data: {
        form: {
          id: "frm_1",
          sessionID: "ses_reply",
          title: "Which file?",
          fields: [
            {
              key: "answer",
              title: "File",
              type: "string",
              options: [{ value: "a.ts", label: "a.ts" }],
            },
          ],
        },
      },
    });
    assert.equal(byType(posts, "question-request").at(-1).form.id, "frm_1");

    await controller.handleMessage({
      type: "replyForm",
      formID: "frm_1",
      answer: { answer: "a.ts" },
    });
    assert.deepEqual(client.formReplies.at(-1), {
      sessionID: "ses_reply",
      formID: "frm_1",
      answer: { answer: "a.ts" },
    });
    assert.equal(byType(posts, "question-resolved").at(-1).formID, "frm_1");
  } finally {
    controller.dispose();
  }
});

test("compaction events stream a running indicator and finish", async () => {
  const { client, posts, controller } = makeController({ options: { sessionID: "ses_compact" } });
  try {
    await controller.handleMessage({ type: "ready" });
    posts.length = 0;

    client.emit({
      type: "session.compaction.started",
      id: "evt_comp_start",
      data: { sessionID: "ses_compact", reason: "manual" },
    });
    assert.equal(byType(posts, "compaction").at(-1).compaction.running, true);

    client.emit({
      type: "session.compaction.delta",
      id: "evt_comp_delta",
      data: { sessionID: "ses_compact", text: "Summarizing…" },
    });
    assert.equal(byType(posts, "compaction").at(-1).compaction.text, "Summarizing…");

    client.emit({
      type: "session.compaction.ended",
      id: "evt_comp_end",
      data: { sessionID: "ses_compact", reason: "manual", text: "Done" },
    });
    const done = byType(posts, "compaction").at(-1).compaction;
    assert.equal(done.running, false);
    assert.equal(done.text, "Done");
  } finally {
    controller.dispose();
  }
});

test("write/edit tool calls and step files produce files-changed", async () => {
  const { client, posts, controller } = makeController({ options: { sessionID: "ses_files" } });
  try {
    await controller.handleMessage({ type: "ready" });
    posts.length = 0;

    client.emit({
      type: "session.tool.input.started",
      id: "evt_file_1",
      data: {
        sessionID: "ses_files",
        assistantMessageID: "msg_files",
        id: "call_write",
        name: "write",
      },
    });
    client.emit({
      type: "session.tool.called",
      id: "evt_file_2",
      data: {
        sessionID: "ses_files",
        assistantMessageID: "msg_files",
        id: "call_write",
        input: { path: "src/new.ts", content: "export {}" },
      },
    });
    client.emit({
      type: "session.tool.success",
      id: "evt_file_3",
      data: {
        sessionID: "ses_files",
        assistantMessageID: "msg_files",
        id: "call_write",
        content: [{ type: "text", text: "wrote file" }],
      },
    });
    client.emit({
      type: "session.step.ended",
      id: "evt_file_4",
      data: {
        sessionID: "ses_files",
        assistantMessageID: "msg_files",
        tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        files: ["src/new.ts"],
      },
    });
    client.emit({
      type: "session.execution.succeeded",
      id: "evt_file_5",
      data: { sessionID: "ses_files" },
    });
    await wait(0);

    const done = byType(posts, "tool-update").at(-1);
    assert.equal(done.tool.kind, "write");
    assert.equal(done.tool.title, "src/new.ts");
    assert.deepEqual(done.tool.files, ["src/new.ts"]);

    const files = byType(posts, "files-changed");
    assert.ok(files.length >= 1);
    assert.deepEqual(files.at(-1).files, ["src/new.ts"]);
  } finally {
    controller.dispose();
  }
});
