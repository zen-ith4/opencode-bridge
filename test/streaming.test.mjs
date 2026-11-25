import test from "node:test";
import assert from "node:assert/strict";

/**
 * Streaming hardening regression tests.
 *
 * Kept in a separate file so the main reducer suite stays readable; the
 * minimal fake client mirrors the pieces these tests need.
 */

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeClient {
  constructor() {
    this.creates = 0;
    this.prompts = [];
    this.interrupts = [];
    this.live = new Set();
    this.onEvent = null;
    this.models = [
      {
        id: "tidepool-alpha-free",
        modelID: "tidepool-alpha-free",
        providerID: "opencode",
        name: "Tidepool Alpha",
      },
    ];
    this.agents = [{ id: "build", name: "Build", mode: "primary", hidden: false }];
  }

  async createSession() {
    this.creates += 1;
    return { id: "ses_stream" };
  }

  async prompt(opts) {
    this.prompts.push(opts);
    return { messageID: "msg_user" };
  }

  async getProviders() {
    return [{ id: "opencode", name: "OpenCode" }];
  }

  async getModels() {
    return this.models;
  }

  async getMessages() {
    return [];
  }

  async getAgents() {
    return this.agents;
  }

  async getCommands() {
    return [];
  }

  async getSkills() {
    return [];
  }

  async listSessions() {
    return { sessions: [], next: undefined };
  }

  async getActiveSessions() {
    return [];
  }

  async interrupt(sessionID) {
    this.interrupts.push(sessionID);
  }

  async streamEvents({ signal, onEvent }) {
    this.onEvent = onEvent;
    this.live.add(signal);
    try {
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      this.live.delete(signal);
    }
  }

  setAuthHeader() {}
  setBaseUrl() {}

  emit(type, id, data) {
    this.onEvent?.({ type, id, created: Date.now(), data });
  }
}

async function makeController(options = {}) {
  const { ChatController } = await import("../test-build/chatController.js");
  const client = new FakeClient();
  const posts = [];
  const controller = new ChatController({
    client,
    post: (message) => posts.push(message),
    mode: "managed",
    serverUrl: "http://127.0.0.1:1234/api",
    workspaceDir: "/tmp/workspace",
    debug: false,
    sessionID: "ses_stream",
    ...options,
  });
  await controller.handleMessage({ type: "ready" });
  posts.length = 0;
  return { client, posts, controller };
}

function byType(posts, type) {
  return posts.filter((message) => message.type === type);
}

test("streamed text posts only deltas and deduplicates identical statuses", async () => {
  const { client, posts, controller } = await makeController();
  try {
    for (let i = 0; i < 1000; i += 1) {
      client.emit("session.text.delta", `evt_delta_${i}`, {
        sessionID: "ses_stream",
        assistantMessageID: "msg_stream",
        delta: `line ${i} `,
      });
    }

    const deltas = byType(posts, "assistant-delta");
    assert.equal(deltas.length, 1000);
    assert.ok(
      deltas.every((message) => message.text === undefined),
      "no delta may carry the full accumulated answer"
    );
    assert.ok(deltas.every((message) => typeof message.delta === "string"));

    const statuses = byType(posts, "status");
    assert.ok(statuses.length <= 2, `status flood: ${statuses.length} identical statuses`);
  } finally {
    controller.dispose();
  }
});

test("50,000 deltas keep postMessage bytes roughly linear and within the time budget", async () => {
  const { client, posts, controller } = await makeController();
  try {
    const started = Date.now();
    for (let i = 0; i < 50000; i += 1) {
      client.emit("session.text.delta", `evt_perf_${i}`, {
        sessionID: "ses_stream",
        assistantMessageID: "msg_perf",
        delta: String(i).padStart(5, "0"),
      });
    }
    const elapsed = Date.now() - started;

    const totalBytes = posts.reduce(
      (sum, message) => sum + Buffer.byteLength(JSON.stringify(message), "utf8"),
      0
    );
    const deltas = byType(posts, "assistant-delta");
    assert.equal(deltas.length, 50000);
    // The old implementation attached the whole accumulated answer to every
    // delta (O(n^2), billions of bytes here). A linear envelope is ~100 B
    // per 5-char chunk; allow a generous 10 MB ceiling.
    assert.ok(totalBytes < 10_000_000, `postMessage payload was ${totalBytes} bytes`);
    assert.ok(elapsed < 3000, `50k controller deltas took ${elapsed}ms (budget 3000ms)`);
  } finally {
    controller.dispose();
  }
});

test("a repetition loop shows a banner with Stop, switch-model and Dismiss", async () => {
  const { client, posts, controller } = await makeController();
  try {
    client.emit("session.execution.started", "evt_rep_0", { sessionID: "ses_stream" });
    client.emit("session.text.delta", "evt_rep_1", {
      sessionID: "ses_stream",
      assistantMessageID: "msg_rep",
      delta: "Story: " + "茫".repeat(260),
    });
    await wait(0);

    const banner = byType(posts, "banner").at(-1).banner;
    assert.match(banner.message, /repetition loop/i);
    assert.deepEqual(
      banner.actions.map((action) => action.id),
      ["stop", "stop-retry-model", "dismiss-repetition"]
    );
    assert.equal(client.interrupts.length, 0, "must not stop silently by default");

    await controller.handleMessage({ type: "bannerAction", action: "dismiss-repetition" });
    assert.equal(controller.getBanner(), undefined);
  } finally {
    controller.dispose();
  }
});

test("autoStopRepetition interrupts automatically only when enabled", async () => {
  const { client, posts, controller } = await makeController({
    getAutoStopRepetition: () => true,
  });
  try {
    client.emit("session.execution.started", "evt_auto_0", { sessionID: "ses_stream" });
    client.emit("session.text.delta", "evt_auto_1", {
      sessionID: "ses_stream",
      assistantMessageID: "msg_auto",
      delta: "ab".repeat(200),
    });
    await wait(0);

    assert.deepEqual(client.interrupts, ["ses_stream"]);
    assert.equal(controller.isGenerating(), false);
    const banner = byType(posts, "banner").at(-1).banner;
    assert.match(banner.details, /autoStopRepetition/);
    assert.ok(banner.actions.some((action) => action.id === "switch-model"));
  } finally {
    controller.dispose();
  }
});

test("ECONNRESET replay keeps the partial text, marks it incomplete and offers Continue", async () => {
  const { client, posts, controller } = await makeController();
  controller.setSelectedModel({ providerID: "opencode", modelID: "tidepool-alpha-free" });
  try {
    client.emit("session.execution.started", "evt_fail_0", { sessionID: "ses_stream" });
    client.emit("session.reasoning.started", "evt_fail_1", {
      sessionID: "ses_stream",
      assistantMessageID: "msg_fail",
      ordinal: 0,
    });
    client.emit("session.reasoning.delta", "evt_fail_2", {
      sessionID: "ses_stream",
      assistantMessageID: "msg_fail",
      delta: "Plan the story.",
    });
    client.emit("session.text.delta", "evt_fail_3", {
      sessionID: "ses_stream",
      assistantMessageID: "msg_fail",
      delta: "Once upon a time in a distant city, ",
    });
    client.emit("session.text.delta", "evt_fail_4", {
      sessionID: "ses_stream",
      assistantMessageID: "msg_fail",
      delta: "the story was cut off here.",
    });
    client.emit("session.execution.failed", "evt_fail_5", {
      sessionID: "ses_stream",
      error: {
        name: "ProviderError",
        data: {
          message:
            "Connection lost while reading the response: ECONNRESET (pass `verbose: true` in the second argument to fetch())",
        },
      },
    });
    await wait(0);

    const end = byType(posts, "assistant-end").at(-1);
    assert.equal(end.incomplete, true);

    const banner = byType(posts, "banner").at(-1).banner;
    assert.equal(banner.kind, "error");
    assert.match(banner.message, /opencode\/tidepool-alpha-free/);
    assert.match(banner.message, /not an extension error/);
    assert.match(banner.details, /Provider: opencode/);
    assert.match(banner.details, /ECONNRESET/);
    assert.deepEqual(
      banner.actions.map((action) => action.id),
      ["retry-prompt", "switch-model", "open-logs"]
    );

    const deltas = byType(posts, "assistant-delta").map((message) => message.delta);
    assert.match(deltas.join(""), /cut off here/);

    await controller.handleMessage({ type: "bannerAction", action: "switch-model" });
    assert.equal(byType(posts, "open-model-picker").length, 1);

    posts.length = 0;
    await controller.handleMessage({ type: "continue" });
    assert.equal(client.prompts.length, 1);
    assert.match(client.prompts[0].text, /Continue from where you stopped/);
    assert.match(byType(posts, "user-message").at(-1).text, /Continue from where you stopped/);
  } finally {
    controller.dispose();
  }
});

test("step.failed followed by execution.failed reports one failure banner", async () => {
  const { client, posts, controller } = await makeController();
  try {
    client.emit("session.text.delta", "evt_dup_1", {
      sessionID: "ses_stream",
      assistantMessageID: "msg_dup",
      delta: "partial answer",
    });
    client.emit("session.step.failed", "evt_dup_2", {
      sessionID: "ses_stream",
      error: { message: "Connection lost: ECONNRESET" },
    });
    client.emit("session.execution.failed", "evt_dup_3", {
      sessionID: "ses_stream",
      error: { name: "ProviderError", data: { message: "Connection lost: ECONNRESET" } },
    });
    await wait(0);

    assert.equal(byType(posts, "banner").length, 1, "duplicate terminal events must not stack banners");
    assert.equal(
      byType(posts, "assistant-end").filter((message) => message.incomplete).length,
      1
    );
  } finally {
    controller.dispose();
  }
});

test("authentication step failures offer a password action and name the model", async () => {
  const { client, posts, controller } = await makeController();
  try {
    client.emit("session.step.started", "evt_auth_0", {
      sessionID: "ses_stream",
      model: { id: "tidepool-alpha-free", providerID: "opencode" },
      assistantMessageID: "msg_auth",
    });
    client.emit("session.text.delta", "evt_auth_1", {
      sessionID: "ses_stream",
      assistantMessageID: "msg_auth",
      delta: "partial",
    });
    client.emit("session.step.failed", "evt_auth_2", {
      sessionID: "ses_stream",
      error: { message: "HTTP 401: authentication required" },
    });
    await wait(0);

    const banner = byType(posts, "banner").at(-1).banner;
    assert.equal(banner.kind, "auth");
    assert.deepEqual(banner.actions[0], { id: "enter-password", label: "Enter password" });
    assert.equal(byType(posts, "assistant-end").at(-1).incomplete, true);
  } finally {
    controller.dispose();
  }
});

test("user stop is neutral: partial text kept, tools stopped, no error banner", async () => {
  const { client, posts, controller } = await makeController();
  try {
    client.emit("session.execution.started", "evt_stop_0", { sessionID: "ses_stream" });
    client.emit("session.tool.called", "evt_stop_1", {
      sessionID: "ses_stream",
      assistantMessageID: "msg_stop",
      callID: "call_1",
      name: "read",
      input: { filePath: "/tmp/a.ts" },
    });
    client.emit("session.text.delta", "evt_stop_2", {
      sessionID: "ses_stream",
      assistantMessageID: "msg_stop",
      delta: "partial answer before stop",
    });

    await controller.stop();
    assert.deepEqual(client.interrupts, ["ses_stream"]);

    // The real server then reports the abort on the step and execution.
    client.emit("session.step.failed", "evt_stop_3", {
      sessionID: "ses_stream",
      error: { type: "aborted", message: "Step interrupted" },
    });
    client.emit("session.execution.interrupted", "evt_stop_4", {
      sessionID: "ses_stream",
      reason: "user",
    });
    await wait(0);

    assert.equal(byType(posts, "banner").length, 0, "a stop must not raise a banner");
    assert.equal(byType(posts, "prompt-failed").length, 0, "a stop must not fail the prompt");

    const end = byType(posts, "assistant-end").at(-1);
    assert.equal(end.stopped, true);
    assert.notEqual(end.incomplete, true);

    const tools = byType(posts, "tool-update").map((message) => message.tool.status);
    assert.ok(tools.includes("stopped"), `expected a stopped tool, got ${tools.join(",")}`);
    assert.ok(!tools.includes("failed"));

    const deltas = byType(posts, "assistant-delta").map((message) => message.delta);
    assert.match(deltas.join(""), /partial answer before stop/);
  } finally {
    controller.dispose();
  }
});

test("an interrupt from another client is neutral too", async () => {
  const { client, posts, controller } = await makeController();
  try {
    client.emit("session.execution.started", "evt_ext_0", { sessionID: "ses_stream" });
    client.emit("session.text.delta", "evt_ext_1", {
      sessionID: "ses_stream",
      assistantMessageID: "msg_ext",
      delta: "half a thought",
    });
    client.emit("session.execution.failed", "evt_ext_2", {
      sessionID: "ses_stream",
      error: { message: "MessageAbortedError: operation was aborted" },
    });
    await wait(0);

    assert.equal(byType(posts, "banner").length, 0);
    assert.equal(byType(posts, "assistant-end").at(-1).stopped, true);
  } finally {
    controller.dispose();
  }
});

test("attachments are sent as server PromptInput.FileAttachment files", async () => {
  const { client, posts, controller } = await makeController();
  try {
    await controller.sendMessage("look at this", undefined, [
      {
        uri: "file:///tmp/a.ts",
        name: "a.ts",
        kind: "file",
        mime: "text/typescript",
        size: 42,
      },
    ]);

    const prompt = client.prompts.at(-1);
    assert.equal(prompt.text, "look at this");
    assert.equal(prompt.files.length, 1);
    assert.equal(prompt.files[0].uri, "file:///tmp/a.ts");
    assert.equal(prompt.files[0].name, "a.ts");
    assert.deepEqual(prompt.files[0].source, { type: "inline" });

    const user = byType(posts, "user-message").at(-1);
    assert.equal(user.attachments.length, 1);
    assert.equal(user.attachments[0].name, "a.ts");

    // Attachments alone (no text) are a valid prompt.
    client.emit("session.execution.succeeded", "evt_att_done", { sessionID: "ses_stream" });
    await wait(0);
    posts.length = 0;
    await controller.sendMessage("", undefined, [
      { uri: "file:///tmp/b.ts", name: "b.ts", kind: "file" },
    ]);
    assert.equal(client.prompts.at(-1).files[0].uri, "file:///tmp/b.ts");
  } finally {
    controller.dispose();
  }
});

test("a new prompt clears the session's stopped state", async () => {
  const { client, posts, controller } = await makeController();
  try {
    await controller.sendMessage("first");
    await controller.stop();
    await controller.sendMessage("second");
    client.emit("session.step.failed", "evt_clear_0", {
      sessionID: "ses_stream",
      error: { message: "The provider returned HTTP 500" },
    });
    await wait(0);

    const banner = byType(posts, "banner").at(-1);
    assert.ok(banner, "a real failure after a new prompt must still banner");
    assert.equal(banner.banner.kind, "error");
  } finally {
    controller.dispose();
  }
});
