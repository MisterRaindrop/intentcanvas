import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RUNTIME_HOST,
  RUNTIME_PORT,
  resolveStudioDirectory,
  startRuntime
} from "../src/server.js";

async function startTestRuntime(t) {
  const studioDirectory = await mkdtemp(join(tmpdir(), "intentcanvas-studio-"));
  await writeFile(
    join(studioDirectory, "index.html"),
    "<!doctype html><title>IntentCanvas test Studio</title>",
    "utf8"
  );
  const logs = [];
  const runtime = await startRuntime({
    port: 0,
    studioDirectory,
    logger: { log: (line) => logs.push(line) },
    now: () => new Date("2026-07-17T01:02:03.000Z")
  });

  t.after(async () => {
    await runtime.close();
    await rm(studioDirectory, { recursive: true, force: true });
  });
  return { ...runtime, logs };
}

test("runtime binds locally, exposes health and prints an OSC8 review link", async (t) => {
  const runtime = await startTestRuntime(t);
  const healthResponse = await fetch(`${runtime.baseUrl}/api/health`);
  const health = await healthResponse.json();

  assert.equal(runtime.host, RUNTIME_HOST);
  assert.equal(RUNTIME_PORT, 4317);
  assert.equal(healthResponse.status, 200);
  assert.equal(health.status, "ok");
  assert.equal(health.reviewCount, 1);
  assert.match(runtime.logs.join("\n"), /\u001B]8;;http:\/\/127\.0\.0\.1:/);
  assert.match(runtime.logs.join("\n"), /doris-tde-demo/);
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
        comment: "RowsetWriter 不应持有主密钥"
      })
    }
  );
  assert.equal(decisionResponse.status, 200);
  assert.equal((await decisionResponse.json()).reviewStatus, "changes_requested");

  const moduleResponse = await fetch(
    `${runtime.baseUrl}/api/reviews/doris-tde-demo/modules/write-path/approval`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved", comment: "调整后批准" })
    }
  );
  const moduleResult = await moduleResponse.json();
  assert.equal(moduleResponse.status, 200);
  assert.equal(moduleResult.approval.decision, "approved");
});

test("runtime validates decisions, accepts hook events and serves Studio", async (t) => {
  const runtime = await startTestRuntime(t);

  const invalidDecision = await fetch(
    `${runtime.baseUrl}/api/reviews/doris-tde-demo/decisions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moduleId: "write-path", decision: "pending" })
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
        comment: " "
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

test("Studio directory can be selected explicitly for packaged installs", () => {
  assert.equal(resolveStudioDirectory("/tmp/intentcanvas-studio"), "/tmp/intentcanvas-studio");
});
