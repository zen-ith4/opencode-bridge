import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  authHeaderFromPassword,
  buildBaseUrl,
  findFreePort,
  generateRandomPassword,
  probeServer,
} from "../test-build/managedServer.js";

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("buildBaseUrl always ends in /api", () => {
  assert.equal(buildBaseUrl("127.0.0.1", 4096), "http://127.0.0.1:4096/api");
});

test("auth header uses the opencode username and base64 password", () => {
  const header = authHeaderFromPassword("secret");
  assert.equal(header, "Basic " + Buffer.from("opencode:secret").toString("base64"));
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString();
  assert.equal(decoded, "opencode:secret");
});

test("generated passwords are long and random", () => {
  const a = generateRandomPassword();
  const b = generateRandomPassword();
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notEqual(a, b);
});

test("findFreePort returns a usable port", async () => {
  const port = await findFreePort();
  assert.ok(port > 0 && port < 65536);
});

test("probeServer hits /api/info exactly once (no /api/api/info)", async () => {
  const seen = [];
  const { server, port } = await listen((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  try {
    const result = await probeServer(buildBaseUrl("127.0.0.1", port));
    assert.deepEqual(seen, ["/api/info"]);
    assert.equal(result.reachable, true);
    assert.equal(result.statusCode, 200);
  } finally {
    server.close();
  }
});

test("probeServer reports 401/403 as reachable auth failures", async () => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(401);
    res.end("no");
  });
  try {
    const result = await probeServer(buildBaseUrl("127.0.0.1", port));
    assert.equal(result.reachable, true);
    assert.equal(result.statusCode, 401);
  } finally {
    server.close();
  }
});

test("a 404 is not silently treated as a working OpenCode server", async () => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(404);
    res.end("not found");
  });
  try {
    const result = await probeServer(buildBaseUrl("127.0.0.1", port));
    assert.equal(result.reachable, true);
    assert.equal(result.statusCode, 404);
    assert.notEqual(result.statusCode, 200);
  } finally {
    server.close();
  }
});

test("probeServer reports unreachable for a closed port", async () => {
  const port = await findFreePort();
  const result = await probeServer(buildBaseUrl("127.0.0.1", port));
  assert.equal(result.reachable, false);
  assert.ok(result.error);
});
