import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTdePlanFixture } from "@intentcanvas/protocol";
import { RuntimePersistenceError } from "../src/persistence.js";
import { startRuntime } from "../src/server.js";

async function createRuntimeDirectories(t) {
  const studioDirectory = await mkdtemp(join(tmpdir(), "intentcanvas-studio-"));
  const dataDirectory = await mkdtemp(join(tmpdir(), "intentcanvas-runtime-"));
  await writeFile(
    join(studioDirectory, "index.html"),
    "<!doctype html><title>IntentCanvas test Studio</title>",
    "utf8"
  );
  t.after(async () => {
    await rm(studioDirectory, { recursive: true, force: true });
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return { studioDirectory, dataDirectory };
}

async function startManagedRuntime(t, options = {}) {
  const directories = options.studioDirectory && options.dataDirectory
    ? options
    : { ...await createRuntimeDirectories(t), ...options };
  const runtime = await startRuntime({
    port: 0,
    authToken: false,
    logger: { log() {}, error() {} },
    now: () => new Date("2026-07-17T02:00:00.000Z"),
    ...directories
  });
  t.after(async () => {
    if (runtime.server.listening) await runtime.close();
  });
  return runtime;
}

async function jsonRequest(url, method, body, expectedRevision) {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(expectedRevision === undefined
        ? {} : { "If-Match": `"${expectedRevision}"` })
    },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

test("review import, replacement, module patch, and revision history form a complete API", async (t) => {
  const runtime = await startManagedRuntime(t);
  const imported = createTdePlanFixture();
  imported.id = "real-plan";
  imported.title = "Real repository plan";

  const created = await jsonRequest(`${runtime.baseUrl}/api/reviews`, "POST", imported);
  assert.equal(created.response.status, 201);
  assert.equal(created.body.review.id, "real-plan");
  assert.equal(created.body.revision, 1);
  assert.equal(created.body.revisionInfo.operation, "created");
  assert.equal(created.response.headers.get("x-intentcanvas-revision"), "1");

  const replacement = structuredClone(imported);
  replacement.title = "Real repository plan v2";
  replacement.summary = "The complete plan was regenerated from current code facts.";
  const missingPrecondition = await jsonRequest(
    `${runtime.baseUrl}/api/reviews/real-plan`,
    "PUT",
    replacement
  );
  assert.equal(missingPrecondition.response.status, 428);
  assert.equal(missingPrecondition.body.error.code, "revision_precondition_required");
  const replaced = await jsonRequest(
    `${runtime.baseUrl}/api/reviews/real-plan`,
    "PUT",
    replacement,
    1
  );
  assert.equal(replaced.response.status, 200);
  assert.equal(replaced.body.review.title, "Real repository plan v2");
  assert.equal(replaced.body.revision, 2);

  let expectedRevision = 2;
  for (const moduleId of ["key-management", "write-path"]) {
    const approved = await jsonRequest(
      `${runtime.baseUrl}/api/reviews/real-plan/modules/${moduleId}/approval`,
      "POST",
      { decision: "approved", comment: "reviewed", expectedRevision }
    );
    assert.equal(approved.response.status, 200);
    expectedRevision = approved.body.revision;
  }

  const beforePatch = await (
    await fetch(`${runtime.baseUrl}/api/reviews/real-plan`)
  ).json();
  const replacementModule = structuredClone(
    beforePatch.modules.find((module) => module.id === "key-management")
  );
  replacementModule.summary = "Regenerated key-management implementation detail.";
  assert.equal(replacementModule.approval.decision, "approved");

  const stalePatch = await jsonRequest(
    `${runtime.baseUrl}/api/reviews/real-plan/modules/key-management`,
    "PATCH",
    replacementModule,
    2
  );
  assert.equal(stalePatch.response.status, 409);
  assert.equal(stalePatch.body.error.code, "stale_review_revision");

  const patched = await jsonRequest(
    `${runtime.baseUrl}/api/reviews/real-plan/modules/key-management`,
    "PATCH",
    replacementModule,
    expectedRevision
  );
  assert.equal(patched.response.status, 200);
  assert.equal(patched.body.module.summary, replacementModule.summary);
  assert.equal(patched.body.module.approval.decision, "pending");
  assert.equal(patched.body.revision, 5);

  const afterPatch = await (
    await fetch(`${runtime.baseUrl}/api/reviews/real-plan`)
  ).json();
  assert.equal(
    afterPatch.modules.find((module) => module.id === "key-management").approval.decision,
    "pending"
  );
  assert.equal(
    afterPatch.modules.find((module) => module.id === "write-path").approval.decision,
    "approved"
  );

  const historyResponse = await fetch(
    `${runtime.baseUrl}/api/reviews/real-plan/revisions`
  );
  const history = await historyResponse.json();
  assert.equal(history.currentRevision, 5);
  assert.deepEqual(
    history.revisions.map((revision) => revision.operation),
    ["created", "replaced", "decision_updated", "decision_updated", "module_replaced"]
  );

  const secondRevision = await (
    await fetch(`${runtime.baseUrl}/api/reviews/real-plan/history/2`)
  ).json();
  assert.equal(secondRevision.plan.title, "Real repository plan v2");
  assert.equal(secondRevision.plan.modules[0].approval.decision, "pending");

  const invalidPatch = await jsonRequest(
    `${runtime.baseUrl}/api/reviews/real-plan/modules/key-management`,
    "PATCH",
    { id: "key-management", summary: "not a complete module" },
    5
  );
  assert.equal(invalidPatch.response.status, 400);
  assert.equal(invalidPatch.body.error.code, "invalid_module");
});

test("API resets client-supplied approval and rejects stale review decisions", async (t) => {
  const runtime = await startManagedRuntime(t);
  const plan = createTdePlanFixture();
  plan.id = "approval-gate";
  plan.status = "approved";
  plan.modules.forEach((module) => {
    module.approval = {
      decision: "approved",
      comment: "must not be trusted",
      updatedAt: "2026-07-17T00:00:00.000Z"
    };
  });

  const imported = await jsonRequest(`${runtime.baseUrl}/api/reviews`, "POST", plan);
  assert.equal(imported.response.status, 201);
  assert.equal(imported.body.review.status, "in_review");
  assert.ok(imported.body.review.modules.every(
    (module) => module.approval.decision === "pending"
  ));

  const changedModule = structuredClone(imported.body.review.modules[0]);
  changedModule.summary = "A structural revision the old page has not reviewed";
  const changed = await jsonRequest(
    `${runtime.baseUrl}/api/reviews/approval-gate/modules/${changedModule.id}`,
    "PATCH",
    changedModule,
    1
  );
  assert.equal(changed.body.revision, 2);

  const stale = await jsonRequest(
    `${runtime.baseUrl}/api/reviews/approval-gate/decisions`,
    "POST",
    {
      moduleId: changedModule.id,
      decision: "approved",
      expectedRevision: 1
    }
  );
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "stale_review_revision");

  const current = await (
    await fetch(`${runtime.baseUrl}/api/reviews/approval-gate`)
  ).json();
  assert.equal(current.modules[0].approval.decision, "pending");
});

test("plans, approvals, revisions, and events recover after restart", async (t) => {
  const directories = await createRuntimeDirectories(t);
  const options = {
    ...directories,
    port: 0,
    authToken: false,
    logger: { log() {}, error() {} },
    now: () => new Date("2026-07-17T03:00:00.000Z")
  };
  const first = await startRuntime(options);

  const plan = await (
    await fetch(`${first.baseUrl}/api/reviews/doris-tde-demo`)
  ).json();
  plan.title = "Recovered plan title";
  assert.equal(
    (await jsonRequest(
      `${first.baseUrl}/api/reviews/doris-tde-demo`,
      "PUT",
      plan,
      1
    )).response.status,
    200
  );
  assert.equal(
    (await jsonRequest(
      `${first.baseUrl}/api/reviews/doris-tde-demo/modules/write-path/approval`,
      "POST",
      { decision: "approved", comment: "persist this", expectedRevision: 2 }
    )).response.status,
    200
  );
  assert.equal(
    (await jsonRequest(`${first.baseUrl}/api/events`, "POST", {
      schemaVersion: "1.0.0",
      source: "codex",
      type: "plan_ready",
      occurredAt: "2026-07-17T03:00:00.000Z",
      sessionId: "restart-test",
      project: { cwd: "/srv/project" },
      payload: { reviewId: "doris-tde-demo" }
    })).response.status,
    202
  );
  await first.close();

  const second = await startRuntime(options);
  t.after(async () => {
    if (second.server.listening) await second.close();
  });
  const recovered = await (
    await fetch(`${second.baseUrl}/api/reviews/doris-tde-demo`)
  ).json();
  assert.equal(recovered.title, "Recovered plan title");
  assert.equal(
    recovered.modules.find((module) => module.id === "write-path").approval.decision,
    "approved"
  );
  const health = await (await fetch(`${second.baseUrl}/api/health`)).json();
  assert.equal(health.eventCount, 1);
  const history = await (
    await fetch(`${second.baseUrl}/api/reviews/doris-tde-demo/revisions`)
  ).json();
  assert.equal(history.currentRevision, 3);
});

test("corrupt state produces a diagnostic and is never overwritten", async (t) => {
  const directories = await createRuntimeDirectories(t);
  const statePath = join(directories.dataDirectory, "state.json");
  const corruptBody = "{ definitely not valid JSON";
  await writeFile(statePath, corruptBody, "utf8");
  const errors = [];

  await assert.rejects(
    startRuntime({
      ...directories,
      port: 0,
      authToken: false,
      logger: { log() {}, error: (message) => errors.push(message) }
    }),
    (error) => error instanceof RuntimePersistenceError &&
      error.code === "corrupt_runtime_state" &&
      error.message.includes(statePath) &&
      error.message.includes("not overwritten")
  );
  assert.equal(await readFile(statePath, "utf8"), corruptBody);
  assert.match(errors.join("\n"), /not overwritten/);
});

test("a persistence failure returns 500 and leaves the prior review visible", async (t) => {
  const { studioDirectory } = await createRuntimeDirectories(t);
  let saveCount = 0;
  const persistence = {
    directory: null,
    statePath: "injected-state.json",
    async load() { return null; },
    async save() {
      saveCount += 1;
      if (saveCount > 1) {
        throw new RuntimePersistenceError("injected write failure", {
          code: "persistence_write_failed",
          path: "injected-state.json"
        });
      }
    }
  };
  const runtime = await startRuntime({
    port: 0,
    authToken: false,
    studioDirectory,
    persistence,
    logger: { log() {}, error() {} }
  });
  t.after(async () => {
    if (runtime.server.listening) await runtime.close();
  });

  const failed = await jsonRequest(
    `${runtime.baseUrl}/api/reviews/doris-tde-demo/modules/write-path/approval`,
    "POST",
    { decision: "approved", comment: "must not commit", expectedRevision: 1 }
  );
  assert.equal(failed.response.status, 500);
  assert.equal(failed.body.error.code, "persistence_write_failed");

  const review = await (
    await fetch(`${runtime.baseUrl}/api/reviews/doris-tde-demo`)
  ).json();
  assert.equal(
    review.modules.find((module) => module.id === "write-path").approval.decision,
    "pending"
  );
});
