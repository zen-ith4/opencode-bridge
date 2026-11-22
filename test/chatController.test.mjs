import test from "node:test";
import assert from "node:assert/strict";
import { ChatController } from "../test-build/chatController.js";
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
    assert.equal(deltas[0].text, "Hello");
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
