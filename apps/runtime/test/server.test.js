import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RUNTIME_HOST,
  RUNTIME_PORT,
  resolveStudioDirectory,
  startRuntime
} from "../src/server.js";
import { verifyRuntimeIdentityProof } from "@intentcanvas/local-auth";

const AUTH_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function startTestRuntime(t, overrides = {}) {
  const studioDirectory = await mkdtemp(join(tmpdir(), "intentcanvas-studio-"));
  const dataDirectory = await mkdtemp(join(tmpdir(), "intentcanvas-runtime-"));
  await writeFile(
    join(studioDirectory, "index.html"),
    "<!doctype html><title>IntentCanvas test Studio</title>",
    "utf8"
  );
  const logs = [];
  const runtime = await startRuntime({
    port: 0,
    authToken: false,
    studioDirectory,
    dataDirectory,
    logger: { log: (line) => logs.push(line) },
    now: () => new Date("2026-07-17T01:02:03.000Z"),
    ...overrides
  });

  t.after(async () => {
    await runtime.close();
    await rm(studioDirectory, { recursive: true, force: true });
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return { ...runtime, logs, studioDirectory };
}

async function rawRequest(runtime, { path = "/", method = "GET", headers = {}, setHost = true } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      hostname: runtime.host,
      port: runtime.port,
      path,
      method,
      headers,
      setHost
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolveRequest({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", rejectRequest);
    request.end();
  });
}

test("runtime binds locally, exposes health and prints an OSC8 review link", async (t) => {
  const runtime = await startTestRuntime(t);
  const healthResponse = await fetch(`${runtime.baseUrl}/api/health`);
  const health = await healthResponse.json();

  assert.equal(runtime.host, RUNTIME_HOST);
  assert.equal(RUNTIME_PORT, 4317);
  assert.equal(healthResponse.status, 200);
  assert.match(healthResponse.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(
    healthResponse.headers.get("cross-origin-resource-policy"),
    "same-origin"
  );
  assert.equal(health.status, "ok");
  assert.equal(health.reviewCount, 1);
  assert.match(runtime.logs.join("\n"), /\u001B]8;;http:\/\/127\.0\.0\.1:/);
  assert.match(runtime.logs.join("\n"), /doris-tde-demo/);
});

test("runtime exchanges a one-use link for a browser session without exposing its bearer token", async (t) => {
  const runtime = await startTestRuntime(t, { authToken: AUTH_TOKEN });

  const challenge = "C".repeat(43);
  const identity = await (
    await fetch(`${runtime.baseUrl}/api/identity?challenge=${challenge}`)
  ).json();
  assert.equal(identity.service, "intentcanvas-runtime");
  assert.equal(identity.challenge, challenge);
  assert.equal(verifyRuntimeIdentityProof(AUTH_TOKEN, challenge, identity.proof), true);
  assert.doesNotMatch(JSON.stringify(identity), new RegExp(AUTH_TOKEN));
  assert.equal((await fetch(`${runtime.baseUrl}/api/identity?challenge=short`)).status, 400);

  const publicStudio = await fetch(runtime.baseUrl);
  assert.equal(publicStudio.status, 200);

  const missing = await fetch(`${runtime.baseUrl}/api/health`);
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, "runtime_auth_required");

  const wrong = await fetch(`${runtime.baseUrl}/api/health`, {
    headers: { Authorization: `Bearer ${"B".repeat(43)}` }
  });
  assert.equal(wrong.status, 401);

  const allowed = await fetch(`${runtime.baseUrl}/api/health`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
  });
  assert.equal(allowed.status, 200);

  const openingUrl = new URL(runtime.reviewUrl);
  const handoff = openingUrl.searchParams.get("handoff");
  assert.match(handoff, /^[A-Za-z0-9_-]{43}$/u);
  assert.doesNotMatch(runtime.reviewUrl, new RegExp(AUTH_TOKEN));
  assert.doesNotMatch(runtime.logs.join("\n"), new RegExp(AUTH_TOKEN));

  const exchange = await fetch(`${runtime.baseUrl}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handoff })
  });
  const session = await exchange.json();
  assert.equal(exchange.status, 200);
  assert.equal(session.reviewId, "doris-tde-demo");
  assert.match(session.session, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(exchange.headers.get("set-cookie"), null);
  const sessionHeaders = { Authorization: `Bearer ${session.session}` };

  const replay = await fetch(`${runtime.baseUrl}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handoff })
  });
  assert.equal(replay.status, 401);

  const browserAllowed = await fetch(`${runtime.baseUrl}/api/reviews/doris-tde-demo`, {
    headers: sessionHeaders
  });
  assert.equal(browserAllowed.status, 200);

  const approvePending = await fetch(
    `${runtime.baseUrl}/api/reviews/doris-tde-demo/approve-pending`,
    {
      method: "POST",
      headers: { ...sessionHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1 })
    }
  );
  assert.equal(approvePending.status, 200);
  const approvePendingResult = await approvePending.json();
  assert.equal(approvePendingResult.reviewStatus, "approved");
  assert.equal(approvePendingResult.approvals.length, 5);

  const crossReview = await fetch(`${runtime.baseUrl}/api/reviews/another-review`, {
    headers: sessionHeaders
  });
  assert.equal(crossReview.status, 403);
  assert.equal((await crossReview.json()).error.code, "browser_session_scope");

  const sessionMint = await fetch(`${runtime.baseUrl}/api/handoffs`, {
    method: "POST",
    headers: { ...sessionHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ reviewId: "doris-tde-demo" })
  });
  assert.equal(sessionMint.status, 403);

  const scopedWrites = [
    ["PUT", "/api/reviews/doris-tde-demo", {}],
    ["PATCH", "/api/reviews/doris-tde-demo/modules/write-path", {}],
    ["POST", "/api/reviews", {}],
    ["POST", "/api/events", {}]
  ];
  for (const [method, path, body] of scopedWrites) {
    const response = await fetch(`${runtime.baseUrl}${path}`, {
      method,
      headers: { ...sessionHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal((await response.json()).error.code, "browser_session_scope");
  }

  const healthFromBrowser = await fetch(`${runtime.baseUrl}/api/health`, {
    headers: sessionHeaders
  });
  assert.equal(healthFromBrowser.status, 403);
  assert.equal((await healthFromBrowser.json()).error.code, "browser_session_scope");
});

test("runtime reads the TDE review and accepts both approval endpoints", async (t) => {
  const runtime = await startTestRuntime(t);
  const reviewResponse = await fetch(`${runtime.baseUrl}/api/reviews/doris-tde-demo`);
  const review = await reviewResponse.json();

  assert.equal(reviewResponse.status, 200);
  assert.equal(review.modules.length, 5);

  const decisionResponse = await fetch(
    `${runtime.baseUrl}/api/reviews/doris-tde-demo/decisions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        moduleId: "write-path",
        decision: "changes_requested",
        comment: "RowsetWriter 不应持有主密钥",
        expectedRevision: 1
      })
    }
  );
  assert.equal(decisionResponse.status, 200);
  const decisionResult = await decisionResponse.json();
  assert.equal(decisionResult.reviewStatus, "changes_requested");
  assert.equal(decisionResult.revision, 2);

  const moduleResponse = await fetch(
    `${runtime.baseUrl}/api/reviews/doris-tde-demo/modules/write-path/approval`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision: "approved",
        comment: "旧页面不得覆盖调整意见",
        expectedRevision: 1
      })
    }
  );
  const moduleResult = await moduleResponse.json();
  assert.equal(moduleResponse.status, 409);
  assert.equal(moduleResult.error.code, "stale_review_revision");
});

test("runtime validates decisions, accepts hook events and serves Studio", async (t) => {
  const runtime = await startTestRuntime(t);

  const invalidDecision = await fetch(
    `${runtime.baseUrl}/api/reviews/doris-tde-demo/decisions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        moduleId: "write-path",
        decision: "pending",
        expectedRevision: 1
      })
    }
  );
  assert.equal(invalidDecision.status, 400);
  assert.equal((await invalidDecision.json()).error.code, "invalid_decision");

  const missingComment = await fetch(
    `${runtime.baseUrl}/api/reviews/doris-tde-demo/decisions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        moduleId: "write-path",
        decision: "changes_requested",
        comment: " ",
        expectedRevision: 1
      })
    }
  );
  assert.equal(missingComment.status, 400);

  const eventResponse = await fetch(`${runtime.baseUrl}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "1.0.0",
      source: "claude-code",
      type: "plan_ready",
      occurredAt: "2026-07-17T01:02:03.000Z",
      sessionId: "session-1",
      project: { cwd: "/srv/doris" },
      payload: { reviewId: "doris-tde-demo" }
    })
  });
  assert.equal(eventResponse.status, 202);
  const ack = await eventResponse.json();
  assert.equal(ack.kind, "IntentCanvasAgentEventAck");
  assert.equal(ack.eventType, "plan_ready");

  const invalidEvent = await fetch(`${runtime.baseUrl}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: "1.0.0", type: "unknown" })
  });
  assert.equal(invalidEvent.status, 400);
  assert.equal((await invalidEvent.json()).error.code, "invalid_event");

  const studioResponse = await fetch(`${runtime.baseUrl}/reviews/doris-tde-demo`);
  assert.equal(studioResponse.status, 200);
  assert.match(await studioResponse.text(), /IntentCanvas test Studio/);

  const health = await (await fetch(`${runtime.baseUrl}/api/health`)).json();
  assert.equal(health.eventCount, 1);
});

test("runtime rejects browser cross-origin writes and non-JSON mutation bodies", async (t) => {
  const runtime = await startTestRuntime(t);
  const endpoint = `${runtime.baseUrl}/api/reviews/doris-tde-demo/decisions`;
  const body = JSON.stringify({
    moduleId: "write-path",
    decision: "approved",
    comment: "",
    expectedRevision: 1
  });

  const crossOrigin = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://untrusted.example"
    },
    body
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).error.code, "cross_origin_request");

  const wrongType = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body
  });
  assert.equal(wrongType.status, 415);
  assert.equal((await wrongType.json()).error.code, "unsupported_media_type");
});

test("runtime rejects missing, malicious and cross-origin request authorities", async (t) => {
  const runtime = await startTestRuntime(t);

  const missingHost = await rawRequest(runtime, {
    path: "/api/health",
    setHost: false
  });
  assert.equal(missingHost.status, 400);
  // Node's HTTP parser may reject HTTP/1.1 without Host before the handler runs.
  if (missingHost.body.length > 0) {
    assert.equal(JSON.parse(missingHost.body).error.code, "invalid_host");
  }

  const maliciousHost = await rawRequest(runtime, {
    path: "/api/health",
    headers: { Host: "untrusted.example" }
  });
  assert.equal(maliciousHost.status, 403);
  assert.equal(JSON.parse(maliciousHost.body).error.code, "non_loopback_host");

  const crossOrigin = await rawRequest(runtime, {
    path: "/api/health",
    headers: {
      Host: `${runtime.host}:${runtime.port}`,
      Origin: "http://127.0.0.1:65535"
    }
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(JSON.parse(crossOrigin.body).error.code, "cross_origin_request");
});

test("runtime limits JSON request bodies to 256 KiB", async (t) => {
  const runtime = await startTestRuntime(t);
  const response = await fetch(`${runtime.baseUrl}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(256 * 1024) })
  });

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "body_too_large");
});

test("Studio static serving rejects hidden paths and symlinks outside its root", async (t) => {
  const runtime = await startTestRuntime(t);
  const outsideDirectory = await mkdtemp(join(tmpdir(), "intentcanvas-outside-"));
  const outsideFile = join(outsideDirectory, "secret.txt");
  await writeFile(outsideFile, "must not escape", "utf8");
  await writeFile(join(runtime.studioDirectory, ".hidden"), "hidden", "utf8");
  await symlink(outsideFile, join(runtime.studioDirectory, "leak.txt"));
  t.after(() => rm(outsideDirectory, { recursive: true, force: true }));

  const hidden = await fetch(`${runtime.baseUrl}/%2Ehidden`);
  assert.equal(hidden.status, 404);

  const nestedHidden = await fetch(`${runtime.baseUrl}/assets/%2Eprivate`);
  assert.equal(nestedHidden.status, 404);

  const encodedTraversal = await rawRequest(runtime, {
    path: "/%2e%2e/secret.txt"
  });
  assert.equal(encodedTraversal.status, 404);

  const escapedSymlink = await fetch(`${runtime.baseUrl}/leak.txt`);
  assert.equal(escapedSymlink.status, 404);
  assert.doesNotMatch(await escapedSymlink.text(), /must not escape/);
});

test("Studio directory can be selected explicitly for packaged installs", () => {
  assert.equal(resolveStudioDirectory("/tmp/intentcanvas-studio"), "/tmp/intentcanvas-studio");
});
