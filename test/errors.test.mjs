import test from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, isProviderFailure } from "../test-build/errors.js";

test("connection resets and unreachable providers are not billed as extension bugs", () => {
  const samples = [
    "Connection lost while reading the response: ECONNRESET",
    "fetch failed",
    "connect ECONNREFUSED 127.0.0.1:443",
    "ETIMEDOUT while waiting for the provider",
    "socket closed unexpectedly",
  ];
  for (const sample of samples) {
    const info = classifyFailure(sample);
    assert.equal(info.kind, "connection", sample);
    assert.match(info.summary, /not an extension error/);
    assert.equal(info.retryable, true);
    assert.equal(isProviderFailure(info.kind), true);
  }
});

test("authentication, rate limits, model errors and extension errors are distinct", () => {
  assert.equal(classifyFailure("HTTP 401: authentication required").kind, "auth");
  assert.equal(classifyFailure("HTTP 403: forbidden").kind, "auth");
  assert.equal(classifyFailure("HTTP 429: rate limit exceeded").kind, "rate-limit");
  assert.equal(classifyFailure("model not found: foo/bar").kind, "model");
  assert.equal(classifyFailure("maximum context length exceeded").kind, "model");
  assert.equal(classifyFailure("TypeError: Cannot read properties of undefined").kind, "extension");
  assert.equal(classifyFailure("something odd happened").kind, "unknown");
});

test("auth failures are not marked retryable", () => {
  const info = classifyFailure("invalid api key");
  assert.equal(info.kind, "auth");
  assert.equal(info.retryable, false);
  assert.equal(isProviderFailure(info.kind), true);
});
