/**
 * Live integration check against a managed `opencode serve`.
 *
 * Run with: npm run test:integration
 *
 * It verifies, against a real server:
 *  - managed server start + auth (random password),
 *  - `GET /api/provider` / `GET /api/model` match what `opencode models` sees,
 *  - the ready handshake opens exactly one SSE subscription,
 *  - sending a prompt reaches the server and events are parsed,
 *  - no SSE event id is applied twice and no text delta is duplicated.
 *
 * Model replies depend on the local OpenCode provider configuration, so a
 * provider/network failure is reported instead of failing the structural
 * assertions (which would make the check useless on machines without keys).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ManagedServer, probeServer } from "../test-build/managedServer.js";
import { OpencodeBridgeClient } from "../test-build/client.js";
import { ChatController } from "../test-build/chatController.js";
import { setLogSink } from "../test-build/log.js";

const logLines = [];
setLogSink({ appendLine: (line) => logLines.push(line) });

const RESPONSE_TIMEOUT_SECONDS = 30;
const MAX_WAIT_MS = 45_000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

let restartResolve;
const restartPromise = new Promise((resolve) => {
  restartResolve = resolve;
});
let restartedWith;

const server = new ManagedServer({
  opencodePath: process.env.OPENCODE_BIN || "opencode",
  hostname: "127.0.0.1",
  cwd: process.cwd(),
  maxRestarts: 3,
  logger: (line) => logLines.push(line),
  errorLogger: (line) => logLines.push(`ERROR: ${line}`),
  onRestart: (nextInfo, attempt) => {
    restartedWith = { info: nextInfo, attempt };
    restartResolve();
  },
});

let controller;
try {
  // Verify the child env does not inherit a stray OPENCODE_PASSWORD.
  const previousPassword = process.env.OPENCODE_PASSWORD;
  process.env.OPENCODE_PASSWORD = "must-not-leak";
  const info = await server.start();
  if (previousPassword === undefined) delete process.env.OPENCODE_PASSWORD;
  else process.env.OPENCODE_PASSWORD = previousPassword;
  console.log(`managed server: ${info.baseUrl} (password enforced: yes)`);

  try {
    const environ = readFileSync(`/proc/${info.spawnedProcess.pid}/environ`, "utf8").split("\0");
    const hasServerPassword = environ.some((entry) => entry.startsWith("OPENCODE_SERVER_PASSWORD="));
    const hasLegacyPassword = environ.some((entry) => entry.startsWith("OPENCODE_PASSWORD="));
    console.log(
      `child env: OPENCODE_SERVER_PASSWORD=${hasServerPassword ? "set" : "missing"} ` +
        `OPENCODE_PASSWORD=${hasLegacyPassword ? "LEAKED" : "absent"}`
    );
    if (!hasServerPassword) fail("managed child is missing OPENCODE_SERVER_PASSWORD");
    if (hasLegacyPassword) fail("managed child inherited OPENCODE_PASSWORD");
  } catch (err) {
    console.log(`child env check skipped: ${err.message}`);
  }

  const client = new OpencodeBridgeClient(info.baseUrl, true);
  client.connect(info.authHeader);

  /* ------------------------------------------------------------------ */
  /* Provider / model parity with `opencode models`                     */
  /* ------------------------------------------------------------------ */

  const providers = await client.getProviders();
  const models = await client.getModels();
  let cliModels = [];
  try {
    cliModels = execFileSync(process.env.OPENCODE_BIN || "opencode", ["models"], {
      encoding: "utf8",
      timeout: 20_000,
      env: process.env,
    })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[^/\s]+\/.+$/.test(line));
  } catch (err) {
    console.log(`opencode models failed: ${err.message}`);
  }

  const apiProviderIDs = new Set(providers.map((provider) => provider.id));
  const cliProviderIDs = new Set(cliModels.map((line) => line.split("/")[0]));
  const apiModelIDs = new Set(models.map((model) => `${model.providerID}/${model.modelID}`));
  const cliModelIDs = new Set(cliModels);

  const requestedModel = process.env.OPENCODE_BRIDGE_TEST_MODEL;
  const preferredModels = requestedModel
    ? [requestedModel]
    : [
        "opencode/tidepool-alpha-free",
        "opencode/hy4-flash-free",
        "opencode/longcat-2.5-free",
        "opencode/iceman-free",
      ];
  const promptModelID =
    preferredModels.find((id) => apiModelIDs.has(id)) ??
    [...apiModelIDs].find((id) => id.startsWith("opencode/") && id.endsWith("-free")) ??
    null;
  const promptModel = promptModelID
    ? { providerID: promptModelID.split("/")[0], modelID: promptModelID.split("/").slice(1).join("/") }
    : null;
  console.log(`test model: ${promptModelID ?? "server default (none configured)"}`);

  const missingProviders = [...cliProviderIDs].filter((id) => !apiProviderIDs.has(id));
  const missingModels = [...cliModelIDs].filter((id) => !apiModelIDs.has(id));
  console.log(
    `providers: api=${providers.length} cli=${cliProviderIDs.size} ` +
      `missing-in-api=${missingProviders.length ? missingProviders.join(",") : "none"}`
  );
  console.log(
    `models: api=${models.length} cli=${cliModelIDs.size} ` +
      `missing-in-api=${missingModels.length ? missingModels.slice(0, 5).join(",") : "none"}`
  );
  if (providers.length === 0) fail("GET /api/provider returned zero providers");
  if (cliProviderIDs.size > 0 && missingProviders.length > 0) {
    fail(`CLI providers missing from /api/provider: ${missingProviders.join(", ")}`);
  }
  if (cliModelIDs.size > 0 && missingModels.length > 0) {
    fail(`CLI models missing from /api/model: ${missingModels.slice(0, 5).join(", ")}`);
  }

  /* ------------------------------------------------------------------ */
  /* Verified v2.3.0 structural endpoints                               */
  /* ------------------------------------------------------------------ */

  const agents = await client.getAgents(process.cwd());
  const commands = await client.getCommands(process.cwd());
  const skills = await client.getSkills(process.cwd());
  const listedSessions = await client.listSessions({
    limit: 5,
    order: "desc",
    directory: process.cwd(),
  });
  const activeSessions = await client.getActiveSessions();
  const primaryAgents = agents.filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all")
  );
  console.log(
    `structure: agents=${agents.length} (primary=${primaryAgents.length}) ` +
      `commands=${commands.length} skills=${skills.length} ` +
      `sessions=${listedSessions.sessions.length} active=${activeSessions.length}`
  );
  console.log(
    `agents: ${agents.map((agent) => `${agent.id}:${agent.mode}${agent.hidden ? ":hidden" : ""}`).join(", ") || "none"}`
  );
  if (!Array.isArray(agents)) fail("GET /api/agent did not return an array");
  if (!Array.isArray(commands)) fail("GET /api/command did not return an array");
  if (!Array.isArray(skills)) fail("GET /api/skill did not return an array");
  if (!Array.isArray(listedSessions.sessions)) fail("GET /api/session did not return a session list");
  if (!Array.isArray(activeSessions)) fail("GET /api/session/active did not return a list");
  if (agents.length > 0 && primaryAgents.length === 0) {
    fail("GET /api/agent returned no primary non-hidden agents");
  }

  /* ------------------------------------------------------------------ */
  /* Controller with subscription tracking                              */
  /* ------------------------------------------------------------------ */

  const posts = [];
  const rawEvents = [];
  let opens = 0;
  let live = 0;
  let maxLive = 0;
  const signals = [];
  const originalStream = client.streamEvents.bind(client);
  client.streamEvents = async (opts) => {
    opens += 1;
    live += 1;
    maxLive = Math.max(maxLive, live);
    signals.push(opts.signal);
    try {
      return await originalStream({
        signal: opts.signal,
        onEvent: (event) => {
          rawEvents.push(event);
          opts.onEvent(event);
        },
      });
    } finally {
      live -= 1;
    }
  };

  controller = new ChatController({
    client,
    post: (message) => posts.push(message),
    mode: "managed",
    serverUrl: info.baseUrl,
    workspaceDir: process.cwd(),
    debug: true,
    getResponseTimeoutSeconds: () => RESPONSE_TIMEOUT_SECONDS,
  });
  if (promptModel) controller.setSelectedModel(promptModel);

  await controller.handleMessage({ type: "ready" });
  await waitFor(() => opens === 1 && live === 1, 15_000, "the first SSE subscription");
  console.log(`SSE: opens=${opens} live=${live} after ready`);

  /* ------------------------------------------------------------------ */
  /* Prompt + events                                                    */
  /* ------------------------------------------------------------------ */

  const promptText = "Reply with exactly: OK";
  await controller.handleMessage({ type: "send", text: promptText });
  const promptFailed = posts.find((message) => message.type === "prompt-failed");
  if (promptFailed) {
    console.log(`PROMPT: rejected by server: ${promptFailed.message}`);
  } else {
    console.log("PROMPT: accepted by server");
  }
  console.log(`SESSION: ${controller.getSessionID()}`);

  const started = Date.now();
  while (controller.isGenerating() && Date.now() - started < MAX_WAIT_MS) {
    await wait(250);
  }
  await wait(500);

  const types = [...new Set(rawEvents.map((event) => event.type))].sort();
  console.log(`SSE event types (${rawEvents.length} total): ${types.join(", ")}`);

  const sessionID = controller.getSessionID();
  if (sessionID) {
    const detail = await client.getSession(sessionID);
    const pendingPermissions = await client.getPermissions(sessionID);
    const pendingForms = await client.getForms(sessionID);
    const diff = await client.getDiff(sessionID);
    const refreshed = await client.listSessions({ limit: 30, order: "desc", directory: process.cwd() });
    console.log(
      `session: detail=${detail ? "ok" : "missing"} ` +
        `permissions=${pendingPermissions.length} forms=${pendingForms.length} diff=${diff.length}`
    );
    if (!detail) fail(`GET /api/session/${sessionID} returned no data`);
    if (!Array.isArray(pendingPermissions)) fail("GET /api/session/{id}/permission did not return a list");
    if (!Array.isArray(pendingForms)) fail("GET /api/session/{id}/form did not return a list");
    if (!Array.isArray(diff)) fail("GET /api/session/{id}/diff did not return a list");
    if (!refreshed.sessions.some((session) => session.id === sessionID)) {
      fail("the created session is missing from GET /api/session");
    }
  }
  const deltaEvents = rawEvents.filter(
    (event) => event.type === "session.text.delta" && event.sessionID === sessionID
  );
  const deltaIDs = deltaEvents.map((event) => event.id).filter(Boolean);
  const uniqueDeltaIDs = new Set(deltaIDs);
  const appliedDeltas = posts.filter((message) => message.type === "assistant-delta");

  const expectedText = deltaEvents
    .map((event) => (event.data && typeof event.data.delta === "string" ? event.data.delta : ""))
    .join("");
  const appliedText = appliedDeltas.reduce(
    (text, message) => (message.resync ? String(message.text || "") : text + String(message.delta || "")),
    ""
  );
  console.log(
    `DELTAS: events=${deltaEvents.length} unique-ids=${uniqueDeltaIDs.size} ` +
      `applied=${appliedDeltas.length} chars=${appliedText.length}`
  );

  if (rawEvents.length === 0) fail("no SSE events were received");
  if (opens !== 1) fail(`expected exactly one SSE subscription, saw ${opens}`);
  if (maxLive !== 1) fail(`expected at most one live subscription, saw ${maxLive}`);
  if (deltaIDs.length !== uniqueDeltaIDs.size) fail("duplicate session.text.delta event ids were received");
  if (appliedDeltas.length > uniqueDeltaIDs.size) {
    fail("more assistant-delta messages were applied than unique delta events");
  }
  if (appliedDeltas.some((message) => !message.resync && message.text !== undefined)) {
    fail("assistant-delta included the full accumulated text (O(n^2) stream)");
  }
  if (expectedText !== appliedText && deltaEvents.length > 0) {
    fail("streamed assistant text does not match the concatenated deltas");
  }
  if (live !== 1) fail(`expected exactly one live SSE subscription, saw ${live}`);

  const interrupted = posts.filter((message) => message.type === "status").at(-1);
  console.log(`FINAL STATUS: ${interrupted ? `${interrupted.status} ${interrupted.message || ""}` : "none"}`);
  console.log(
    promptFailed
      ? "RESULT: structural SSE checks passed; no model reply (provider unavailable)."
      : `RESULT: ${deltaEvents.length > 0 ? "model reply streamed once" : "prompt accepted, no text deltas observed"}.`
  );

  /* ------------------------------------------------------------------ */
  /* Managed restart (backoff) + fresh credentials                      */
  /* ------------------------------------------------------------------ */

  controller.dispose();
  controller = undefined;
  const oldUrl = server.info.baseUrl;
  console.log(`RESTART: killing managed child (${oldUrl})`);
  server.info.spawnedProcess.kill("SIGKILL");
  const restarted = await Promise.race([
    restartPromise.then(() => true),
    wait(25_000).then(() => false),
  ]);
  if (!restarted) {
    fail("managed server did not restart after an unexpected exit");
  } else {
    const next = restartedWith.info;
    const authed = await probeServer(next.baseUrl, next.authHeader);
    const anonymous = await probeServer(next.baseUrl);
    console.log(
      `RESTART: attempt=${restartedWith.attempt} url=${next.baseUrl} ` +
        `auth=${authed.statusCode ?? "error"} anon=${anonymous.statusCode ?? "error"}`
    );
    if (authed.statusCode !== 200) fail(`restarted server rejected its new password (${authed.statusCode})`);
    if (anonymous.statusCode !== 401 && anonymous.statusCode !== 403) {
      fail(`restarted server is not password protected (anonymous=${anonymous.statusCode})`);
    }
    if (server.info.baseUrl !== next.baseUrl) fail("restarted server info was not updated");
  }
} catch (err) {
  fail(err instanceof Error ? err.stack || err.message : String(err));
} finally {
  try {
    controller?.dispose();
  } catch {
    /* ignore */
  }
  server.dispose();
  await wait(500);
  if (process.exitCode) {
    const debug = logLines.filter((line) => /ERROR|SSE|ignoring|unhandled/.test(line));
    console.error(debug.slice(-20).join("\n"));
  }
}
