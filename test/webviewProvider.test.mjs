/**
 * P0 end-to-end check through the REAL WebviewViewProvider message handler.
 *
 * chatView.ts is bundled with esbuild, replacing the `vscode` module with the
 * stub in test/vscode-stub.mjs. The test then drives the provider exactly the
 * way VS Code does:
 *   resolveWebviewView() -> webview.onDidReceiveMessage handler
 * and asserts that {"type":"ready"} produces init and {"type":"send"} produces
 * a user-message plus a real prompt call.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const stubPath = fileURLToPath(new URL("./vscode-stub.mjs", import.meta.url));
const harnessPath = fileURLToPath(new URL("../test-build/chatViewHarness.mjs", import.meta.url));

await esbuild.build({
  stdin: {
    contents: 'export { OpenCodeChatView } from "./src/chatView.ts";',
    resolveDir: projectRoot,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: harnessPath,
  external: ["@opencode-ai/sdk"],
  plugins: [
    {
      name: "vscode-stub",
      setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: stubPath }));
      },
    },
  ],
  logLevel: "silent",
});

const { OpenCodeChatView } = await import(harnessPath);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

class FakeClient {
  constructor() {
    this.creates = 0;
    this.prompts = [];
    this.interrupts = [];
    this.opens = 0;
    this.live = new Set();
  }

  async createSession() {
    this.creates += 1;
    return { id: "ses_from_provider" };
  }

  async prompt(opts) {
    this.prompts.push(opts);
    return { messageID: "msg_from_provider" };
  }

  async getProviders() {
    return [{ id: "test-provider", name: "Test Provider" }];
  }

  async getModels() {
    return [
      { id: "model-a", modelID: "model-a", providerID: "test-provider", name: "Model A" },
    ];
  }

  async getMessages() {
    return [];
  }

  async interrupt(sessionID) {
    this.interrupts.push(sessionID);
  }

  async streamEvents({ signal }) {
    this.opens += 1;
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
}

function makeFakeView() {
  const posted = [];
  let onMessage;
  const webview = {
    options: {},
    html: "",
    cspSource: "vscode-resource://test",
    asWebviewUri(uri) {
      return "vscode-resource://test" + uri.fsPath;
    },
    onDidReceiveMessage(callback) {
      onMessage = callback;
      return { dispose() {} };
    },
    async postMessage(message) {
      posted.push(message);
      return true;
    },
  };
  const view = {
    webview,
    visible: true,
    onDidChangeVisibility() {
      return { dispose() {} };
    },
  };
  return {
    view,
    posted,
    send: (message) => onMessage?.(message),
  };
}

test("P0: provider message handler drives ready -> init and send -> prompt", async () => {
  const client = new FakeClient();
  const provider = new OpenCodeChatView({
    client,
    extensionPath: projectRoot,
    serverUrl: "http://127.0.0.1:1234/api",
    mode: "managed",
    debug: true,
  });

  const fake = makeFakeView();
  try {
    await provider.resolveWebviewView(fake.view, {}, {});

    assert.match(fake.view.webview.html, /Content-Security-Policy/);
    assert.match(fake.view.webview.html, /nonce=/);
    assert.ok(!/style=/.test(fake.view.webview.html), "no inline style attributes");
    assert.ok(!/\son[a-z]+=/.test(fake.view.webview.html), "no inline event handlers");

    const webviewSource = await readFile(new URL("../media/webview.js", import.meta.url), "utf8");
    assert.match(webviewSource, /acquireVsCodeApi\(\)/);
    assert.ok(!webviewSource.includes("parent.postMessage"));

    // Exactly what the webview posts after acquireVsCodeApi() is available.
    fake.send({ type: "ready" });
    await waitFor(
      () => fake.posted.some((message) => message.type === "init"),
      "the init payload"
    );
    assert.equal(client.opens, 1, "ready must open one SSE subscription");
    assert.equal(client.live.size, 1);

    fake.send({ type: "send", text: "hello from the webview" });
    await waitFor(() => client.prompts.length === 1, "the prompt call");

    assert.equal(client.creates, 1);
    assert.equal(client.prompts[0].text, "hello from the webview");
    assert.equal(client.prompts[0].sessionID, "ses_from_provider");
    assert.deepEqual(
      fake.posted.filter((message) => message.type === "user-message").map((message) => message.text),
      ["hello from the webview"]
    );
  } finally {
    provider.dispose();
    await wait(0);
    assert.equal(client.live.size, 0, "dispose must close the SSE subscription");
  }
});
