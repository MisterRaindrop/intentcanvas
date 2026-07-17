import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../apps/cli/src/cli.js";
import { ReviewStore } from "../apps/runtime/src/review-store.js";
import { startRuntime } from "../apps/runtime/src/server.js";
import { comparePlanModels } from "../packages/plan-diff/src/index.js";
import { createTdePlanFixture } from "../packages/protocol/src/index.js";

const AUTH_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function capture() {
  let output = "";
  return {
    stream: { write(chunk) { output += chunk; } },
    read: () => output
  };
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers
    }
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return { response, payload };
}

test("a plan moves from CLI import through focused revision to persisted acceptance", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "intentcanvas-workflow-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));

  const logger = { log() {}, error() {} };
  let runtime = await startRuntime({
    port: 0,
    authToken: AUTH_TOKEN,
    store: new ReviewStore(),
    dataDirectory,
    logger
  });
  t.after(async () => {
    if (runtime.server.listening) await runtime.close();
  });

  const plan = createTdePlanFixture();
  plan.id = "workflow-e2e";
  plan.title = "IntentCanvas 端到端验收";

  const stdout = capture();
  const stderr = capture();
  const importCode = await runCli(
    ["plan", "import", "plan.json", "--runtime", runtime.baseUrl],
    {
      env: { INTENTCANVAS_AUTH_TOKEN: AUTH_TOKEN },
      fetch,
      readFile: async () => JSON.stringify(plan),
      stdout: stdout.stream,
      stderr: stderr.stream
    }
  );
  assert.equal(importCode, 0, stderr.read());
  assert.match(stdout.read(), /workflow-e2e/);

  const studio = await fetch(`${runtime.baseUrl}/?review=workflow-e2e`);
  assert.equal(studio.status, 200);
  assert.match(await studio.text(), /图形化计划评审/);

  const firstModule = plan.modules[0];
  await jsonRequest(`${runtime.baseUrl}/api/reviews/${plan.id}/decisions`, {
    method: "POST",
    body: JSON.stringify({
      moduleId: firstModule.id,
      decision: "approved",
      comment: "",
      expectedRevision: 1
    })
  });

  const revisedModule = structuredClone(firstModule);
  revisedModule.summary = `${revisedModule.summary}（已按审核意见收紧密钥边界）`;
  const reviseStdout = capture();
  const reviseStderr = capture();
  const reviseCode = await runCli(
    ["plan", "revise", plan.id, firstModule.id, "module.json", "--runtime", runtime.baseUrl],
    {
      env: { INTENTCANVAS_AUTH_TOKEN: AUTH_TOKEN },
      fetch,
      readFile: async () => JSON.stringify(revisedModule),
      stdout: reviseStdout.stream,
      stderr: reviseStderr.stream
    }
  );
  assert.equal(reviseCode, 0, reviseStderr.read());

  const history = await jsonRequest(`${runtime.baseUrl}/api/reviews/${plan.id}/revisions`);
  assert.equal(history.payload.currentRevision, 2);
  assert.equal(history.payload.revisions[1].operation, "module_replaced");
  assert.equal(history.payload.revisions[1].moduleId, firstModule.id);

  for (const module of plan.modules) {
    await jsonRequest(`${runtime.baseUrl}/api/reviews/${plan.id}/decisions`, {
      method: "POST",
      body: JSON.stringify({
        moduleId: module.id,
        decision: "approved",
        comment: "",
        expectedRevision: 2
      })
    });
  }

  const approvedResult = await jsonRequest(`${runtime.baseUrl}/api/reviews/${plan.id}`);
  const approved = approvedResult.payload;
  assert.equal(approved.status, "approved");
  assert.match(approved.modules[0].summary, /收紧密钥边界/);

  const passingReport = comparePlanModels(approved, structuredClone(approved));
  assert.equal(passingReport.status, "pass");

  const drifted = structuredClone(approved);
  drifted.modules[0].changes.push({
    ...structuredClone(drifted.modules[0].changes[0]),
    id: "unapproved-extra-change",
    title: "计划外修改"
  });
  const driftReport = comparePlanModels(approved, drifted);
  assert.equal(driftReport.status, "review_required");
  assert.ok(driftReport.modules.some((module) =>
    module.findings.some((finding) => finding.code === "unapproved_change")
  ));

  await runtime.close();
  runtime = await startRuntime({
    port: 0,
    authToken: AUTH_TOKEN,
    store: new ReviewStore(),
    dataDirectory,
    logger
  });
  const restored = await jsonRequest(`${runtime.baseUrl}/api/reviews/${plan.id}`);
  assert.equal(restored.payload.status, "approved");
  assert.equal(restored.response.headers.get("X-IntentCanvas-Revision"), "2");
});
