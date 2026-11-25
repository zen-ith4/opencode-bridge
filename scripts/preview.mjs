/**
 * Render the real webview HTML in headless Chromium and capture screenshots.
 *
 * Usage: node scripts/preview.mjs [outDir]
 *
 * - Builds `src/chatView.ts` with the test `vscode` stub so the HTML is the
 *   exact shell the extension ships (CSP, codicons, scripts).
 * - Serves the project over HTTP (the CSP needs a real origin) and stubs
 *   `acquireVsCodeApi`.
 * - Drives the webview with the same messages the extension posts.
 *
 * Screenshots cover light/dark/high-contrast and 480/340/260 px widths.
 */

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { chromium } from "playwright";

const projectRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");
const outDir = process.argv[2] || join(projectRoot, "screenshots");
const require = createRequire(import.meta.url);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const stubPath = join(projectRoot, "test", "vscode-stub.mjs");
const harnessPath = join(projectRoot, "test-build", "chatViewPreview.mjs");

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

function fakeView() {
  const webview = {
    html: "",
    cspSource: "vscode-resource://preview",
    asWebviewUri(uri) {
      return "vscode-resource://preview" + uri.fsPath;
    },
    onDidReceiveMessage() {
      return { dispose() {} };
    },
    async postMessage() {
      return true;
    },
  };
  return { webview, visible: true, onDidChangeVisibility: () => ({ dispose() {} }) };
}

const provider = new OpenCodeChatView({
  client: {},
  extensionPath: projectRoot,
  serverUrl: "http://127.0.0.1:4096/api",
  mode: "managed",
  debug: false,
});
const view = fakeView();
await provider.resolveWebviewView(view, {}, {});

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/" || url.pathname === "/preview.html") {
    response.writeHead(200, { "content-type": MIME[".html"] });
    response.end(view.webview.html);
    return;
  }
  const filePath = normalize(decodeURIComponent(url.pathname));
  if (!filePath.startsWith(projectRoot + sep)) {
    response.writeHead(403);
    response.end();
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "content-type": MIME[extname(filePath)] || "application/octet-stream",
    });
    response.end(await readFile(filePath));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
view.webview.html = view.webview.html
  .split("vscode-resource://preview")
  .join(origin);

const THEMES = {
  light: {
    "vscode-editor-background": "#ffffff",
    "vscode-sideBar-background": "#f8f8f8",
    "vscode-foreground": "#24292f",
    "vscode-descriptionForeground": "#6e7781",
    "vscode-panel-border": "#d8dee4",
    "vscode-widget-border": "#d0d7de",
    "vscode-button-background": "#0969da",
    "vscode-button-foreground": "#ffffff",
    "vscode-button-hoverBackground": "#0860c4",
    "vscode-button-secondaryBackground": "#eaeef2",
    "vscode-button-secondaryForeground": "#24292f",
    "vscode-toolbar-hoverBackground": "#eaeef2",
    "vscode-list-hoverBackground": "#eaeef2",
    "vscode-input-background": "#ffffff",
    "vscode-input-foreground": "#24292f",
    "vscode-input-border": "#d0d7de",
    "vscode-input-placeholderForeground": "#8c959f",
    "vscode-focusBorder": "#0969da",
    "vscode-textCodeBlock-background": "#f6f8fa",
    "vscode-errorForeground": "#cf222e",
    "vscode-editorWarning-foreground": "#9a6700",
    "vscode-editorInfo-foreground": "#0969da",
    "vscode-textLink-foreground": "#0969da",
    "vscode-textLink-activeForeground": "#0550ae",
    "vscode-list-activeSelectionBackground": "#ddf4ff",
    "vscode-list-activeSelectionForeground": "#24292f",
    "vscode-badge-background": "#0969da",
    "vscode-badge-foreground": "#ffffff",
    "vscode-editorWidget-background": "#ffffff",
    "vscode-editorWidget-border": "#d0d7de",
    "vscode-widget-shadow": "rgba(31, 35, 40, 0.12)",
    "vscode-font-family": "'Segoe UI', 'Noto Sans', sans-serif",
    "vscode-editor-font-family": "'SFMono-Regular', Consolas, monospace",
    "vscode-font-size": "13px",
  },
  dark: {
    "vscode-editor-background": "#0d1117",
    "vscode-sideBar-background": "#161b22",
    "vscode-foreground": "#e6edf3",
    "vscode-descriptionForeground": "#8b949e",
    "vscode-panel-border": "#30363d",
    "vscode-widget-border": "#30363d",
    "vscode-button-background": "#238636",
    "vscode-button-foreground": "#ffffff",
    "vscode-button-hoverBackground": "#2ea043",
    "vscode-button-secondaryBackground": "#21262d",
    "vscode-button-secondaryForeground": "#e6edf3",
    "vscode-toolbar-hoverBackground": "#21262d",
    "vscode-list-hoverBackground": "#21262d",
    "vscode-input-background": "#0d1117",
    "vscode-input-foreground": "#e6edf3",
    "vscode-input-border": "#30363d",
    "vscode-input-placeholderForeground": "#6e7681",
    "vscode-focusBorder": "#1f6feb",
    "vscode-textCodeBlock-background": "#161b22",
    "vscode-errorForeground": "#f85149",
    "vscode-editorWarning-foreground": "#d29922",
    "vscode-editorInfo-foreground": "#58a6ff",
    "vscode-textLink-foreground": "#58a6ff",
    "vscode-textLink-activeForeground": "#79c0ff",
    "vscode-list-activeSelectionBackground": "#1f6feb",
    "vscode-list-activeSelectionForeground": "#ffffff",
    "vscode-badge-background": "#1f6feb",
    "vscode-badge-foreground": "#ffffff",
    "vscode-editorWidget-background": "#161b22",
    "vscode-editorWidget-border": "#30363d",
    "vscode-widget-shadow": "rgba(1, 4, 9, 0.5)",
    "vscode-font-family": "'Segoe UI', 'Noto Sans', sans-serif",
    "vscode-editor-font-family": "'SFMono-Regular', Consolas, monospace",
    "vscode-font-size": "13px",
  },
  "high-contrast": {
    "vscode-editor-background": "#000000",
    "vscode-sideBar-background": "#000000",
    "vscode-foreground": "#ffffff",
    "vscode-descriptionForeground": "#ffffff",
    "vscode-panel-border": "#ffffff",
    "vscode-widget-border": "#ffffff",
    "vscode-contrastBorder": "#ffffff",
    "vscode-button-background": "#ffffff",
    "vscode-button-foreground": "#000000",
    "vscode-button-hoverBackground": "#ffffff",
    "vscode-button-secondaryBackground": "#000000",
    "vscode-button-secondaryForeground": "#ffffff",
    "vscode-toolbar-hoverBackground": "#000000",
    "vscode-list-hoverBackground": "#000000",
    "vscode-input-background": "#000000",
    "vscode-input-foreground": "#ffffff",
    "vscode-input-border": "#ffffff",
    "vscode-input-placeholderForeground": "#ffffff",
    "vscode-focusBorder": "#ffffff",
    "vscode-textCodeBlock-background": "#000000",
    "vscode-errorForeground": "#ff6b6b",
    "vscode-editorWarning-foreground": "#ffd700",
    "vscode-editorInfo-foreground": "#6bc1ff",
    "vscode-textLink-foreground": "#6bc1ff",
    "vscode-textLink-activeForeground": "#6bc1ff",
    "vscode-list-activeSelectionBackground": "#ffffff",
    "vscode-list-activeSelectionForeground": "#000000",
    "vscode-badge-background": "#ffffff",
    "vscode-badge-foreground": "#000000",
    "vscode-editorWidget-background": "#000000",
    "vscode-editorWidget-border": "#ffffff",
    "vscode-widget-shadow": "rgba(0, 0, 0, 0.8)",
    "vscode-font-family": "'Segoe UI', 'Noto Sans', sans-serif",
    "vscode-editor-font-family": "'SFMono-Regular', Consolas, monospace",
    "vscode-font-size": "13px",
  },
};

const MODELS = [
  {
    label: "Tidepool Alpha",
    providerID: "opencode",
    modelID: "tidepool-alpha-free",
    variants: ["low", "high"],
  },
  {
    label: "Tidepool Beta",
    providerID: "opencode",
    modelID: "tidepool-beta",
    variants: ["low", "medium", "high"],
  },
  {
    label: "Claude Sonnet",
    providerID: "anthropic",
    modelID: "claude-sonnet-4",
  },
];

const AGENTS = [
  { id: "build", name: "Build", description: "Implement features and fixes" },
  { id: "plan", name: "Plan", description: "Design before writing code" },
  { id: "review", name: "Review", description: "Audit the current changes" },
];

function init(history, extra = {}) {
  return {
    type: "init",
    sessionID: "ses_preview",
    models: MODELS,
    selectedModel: { providerID: "opencode", modelID: "tidepool-alpha-free", variant: "high" },
    agents: AGENTS,
    agent: "build",
    commands: [
      { name: "compact", description: "Compact the conversation" },
      { name: "clear", description: "Start a new chat" },
    ],
    skills: [],
    mode: "managed",
    serverUrl: "http://127.0.0.1:4096/api",
    workspaceDir: "/home/arman/opencode-bridge",
    history,
    generating: false,
    sessions: [
      { id: "ses_preview", title: "Composer redesign" },
      { id: "ses_other", title: "Streaming hardening" },
    ],
    ...extra,
  };
}

const userTurn = {
  id: "msg_user_1",
  role: "user",
  text: "Refactor the streaming reducer so a user Stop never shows an error banner. Keep the partial answer.",
  created: Date.now() - 120000,
  attachments: [
    { uri: "file:///home/arman/opencode-bridge/src/chatController.ts", name: "chatController.ts", kind: "file", mime: "text/typescript", size: 48213 },
    { uri: "file:///home/arman/opencode-bridge/test", name: "test", kind: "folder" },
    { uri: "file:///home/arman/opencode-bridge/src/errors.ts", name: "errors.ts (lines 40-78)", kind: "selection", mime: "text/typescript", size: 2048, lines: "40-78" },
  ],
};

const assistantTurn = {
  id: "msg_assistant_1",
  role: "assistant",
  created: Date.now() - 90000,
  agent: "build",
  model: { providerID: "opencode", modelID: "tidepool-alpha-free" },
  parts: [
    {
      type: "reasoning",
      text: "The Stop path currently finishes the stream before the server's abort events arrive, so step.failed renders a banner. I'll mark the session stopped until the next prompt and treat abort-shaped errors as neutral.",
      created: Date.now() - 89000,
      completed: Date.now() - 87000,
    },
    { type: "tool", id: "t1", name: "read", status: "completed", input: { filePath: "src/chatController.ts" }, content: [{ type: "text", text: "..." }] },
    { type: "tool", id: "t2", name: "grep", status: "completed", input: { pattern: "step.failed" } },
    { type: "tool", id: "t3", name: "edit", status: "completed", files: ["src/chatController.ts"] },
    { type: "tool", id: "t4", name: "bash", status: "completed", input: { command: "npm test" }, content: [{ type: "text", text: "91 tests, 0 failures" }] },
    {
      type: "text",
      text: "Done. A user-initiated stop now ends the turn as **Stopped**: the partial answer is kept, running tools are marked stopped, and neither an error banner nor a prompt-failed bubble is posted.\n\n```ts\nif (this.isStopLike(raw)) {\n  this.neutralStop(sessionID);\n  return;\n}\n```\n\nGenuine provider failures still surface normally.",
    },
  ],
};

const stoppedTurn = {
  id: "msg_assistant_stopped",
  role: "assistant",
  created: Date.now() - 20000,
  agent: "build",
  model: { providerID: "opencode", modelID: "tidepool-alpha-free" },
  parts: [
    { type: "reasoning", text: "Checking how the composer measures its own width before collapsing labels.", created: Date.now() - 19000, completed: Date.now() - 18500 },
    { type: "tool", id: "s1", name: "bash", status: "running", input: { command: "npm run compile" } },
    { type: "text", text: "I'll measure the composer itself rather than the window, because the sidebar can" },
  ],
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await mkdir(outDir, { recursive: true });
  // The sandbox has no Playwright browser cache but does ship Chrome.
  const chromePath = "/usr/bin/google-chrome-stable";
  const launchOptions = existsSync(chromePath)
    ? { executablePath: chromePath, args: ["--no-sandbox"] }
    : {};
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 480, height: 760 } });
  await context.addInitScript(() => {
    window.__posted = [];
    window.acquireVsCodeApi = function () {
      return {
        postMessage: (message) => window.__posted.push(message),
        getState: () => undefined,
        setState: () => undefined,
      };
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  async function reset(theme, width) {
    await page.setViewportSize({ width, height: 760 });
    await page.goto(origin + "/");
    await page.evaluate((values) => {
      const root = document.documentElement;
      Object.keys(values).forEach((key) => root.style.setProperty("--" + key, values[key]));
      document.body.className =
        values["vscode-editor-background"] === "#000000"
          ? "vscode-high-contrast"
          : values["vscode-editor-background"] === "#0d1117"
            ? "vscode-dark"
            : "vscode-light";
    }, THEMES[theme]);
    await delay(120);
  }

  async function send(message) {
    await page.evaluate((payload) => window.postMessage(payload, "*"), message);
    await delay(180);
  }

  async function shot(name) {
    await page.screenshot({ path: join(outDir, name + ".png") });
    console.log("wrote", join(outDir, name + ".png"));
  }

  // Full conversation, three themes at 480px.
  for (const theme of ["light", "dark", "high-contrast"]) {
    await reset(theme, 480);
    await send(init([userTurn, assistantTurn]));
    await shot(`conversation-${theme}-480`);
  }

  // Responsive toolbar thresholds with the same conversation.
  for (const width of [340, 260]) {
    await reset("light", width);
    await send(init([userTurn, assistantTurn]));
    await shot(`conversation-light-${width}`);
  }

  // Streaming state: thinking expanded, a tool running, Stop button visible.
  await reset("light", 480);
  await send(init([userTurn], { generating: true }));
  await send({ type: "status", status: "thinking", text: "OpenCode is thinking…" });
  await send({ type: "reasoning-start", messageID: "msg_live" });
  await send({ type: "reasoning-delta", messageID: "msg_live", delta: "Reading the controller to find where the abort events are classified. " });
  await send({ type: "reasoning-delta", messageID: "msg_live", delta: "The webview should keep following the stream while the user stays near the bottom." });
  await send({ type: "tool-start", messageID: "msg_live", tool: { id: "live1", name: "bash", kind: "bash", title: "npm test", status: "running", input: { command: "npm test" } } });
  await send({ type: "assistant-delta", messageID: "msg_live", delta: "Running the test suite before changing the reducer.\n\n" });
  await shot("streaming-light-480");

  // Stopped turn: neutral badge, no banner.
  await reset("light", 480);
  await send(init([]));
  await send({ type: "assistant-start", messageID: "msg_stopped" });
  await send({ type: "reasoning-start", messageID: "msg_stopped" });
  await send({ type: "reasoning-delta", messageID: "msg_stopped", delta: "Checking how the composer measures its own width before collapsing labels." });
  await send({ type: "assistant-delta", messageID: "msg_stopped", delta: "I'll measure the composer itself rather than the window, because the sidebar can" });
  await send({ type: "assistant-end", messageID: "msg_stopped", stopped: true });
  await shot("stopped-light-480");

  // Attachment chips + warning note in the composer.
  await reset("light", 480);
  await send(init([userTurn]));
  await send({
    type: "files:add",
    attachments: [
      { uri: "file:///home/arman/opencode-bridge/media/webview.js", name: "webview.js", kind: "file", mime: "text/javascript", size: 92123 },
      { uri: "file:///home/arman/opencode-bridge/media/webview.css", name: "webview.css", kind: "file", mime: "text/css", size: 41233 },
      { uri: "file:///home/arman/opencode-bridge/test", name: "test", kind: "folder" },
    ],
    warnings: ["webview.js is large (90 KB); attaching it may be slow."],
  });
  await shot("attachments-light-480");

  // Model popover opens upward from the composer at 340px.
  await reset("light", 340);
  await send(init([userTurn, assistantTurn]));
  await page.click("#btnModel");
  await delay(150);
  await shot("popover-model-light-340");

  // Context ring popover.
  await reset("light", 480);
  await send(init([userTurn, assistantTurn]));
  await send({
    type: "context",
    used: 78234,
    limit: 128000,
    percent: 61,
    breakdown: { input: 62400, output: 4200, reasoning: 1100, cache: { read: 10534, write: 0 } },
    cost: 0.0421,
  });
  await page.click("#btnContext");
  await delay(150);
  await shot("popover-context-light-480");

  // One dismissible banner (error styling) + long RTL user text.
  await reset("light", 480);
  await send(
    init([
      {
        id: "msg_user_rtl",
        role: "user",
        text: "لطفاً مسیر فایل را بررسی کن و توضیح بده چرا جریان پاسخ قطع می‌شود.",
        created: Date.now() - 60000,
      },
      assistantTurn,
    ])
  );
  await send({
    type: "banner",
    banner: {
      kind: "error",
      message: "OpenCode could not reach the provider (opencode/tidepool-alpha-free). This is a provider error, not an extension error.",
      details: "Provider: opencode\nModel: tidepool-alpha-free\nHTTP 502 Bad Gateway",
      actions: [
        { id: "retry-prompt", label: "Retry" },
        { id: "switch-model", label: "Switch model" },
      ],
    },
  });
  await shot("banner-rtl-light-480");

  if (errors.length > 0) {
    console.error("Webview errors:\n" + errors.join("\n"));
    process.exitCode = 1;
  }

  await browser.close();
  server.close();
}

main().catch((error) => {
  console.error(error);
  server.close();
  process.exit(1);
});
