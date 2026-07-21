import test from "node:test";
import assert from "node:assert/strict";

import { createTdePlanFixture } from "@intentcanvas/protocol";
import { createAcceptanceRecord } from "../src/acceptance.js";
import { ReviewStore, ReviewStoreError } from "../src/review-store.js";

function approveAll(store, reviewId = "doris-tde-demo") {
  let revision = store.getCurrentRevision(reviewId);
  for (const module of store.getReview(reviewId).modules) {
    revision = store.submitDecision(reviewId, {
      moduleId: module.id,
      decision: "approved",
      expectedRevision: revision
    }).revision;
  }
  return revision;
}

test("ReviewStore keeps its own plan copy and returns defensive copies", () => {
  const plan = createTdePlanFixture();
  const store = new ReviewStore([plan]);
  plan.title = "changed outside";

  const firstRead = store.getReview("doris-tde-demo");
  firstRead.title = "changed read";

  assert.notEqual(store.getReview("doris-tde-demo").title, "changed outside");
  assert.notEqual(store.getReview("doris-tde-demo").title, "changed read");
});

test("ReviewStore owns approval state on import and whole-plan replacement", () => {
  const plan = createTdePlanFixture();
  plan.id = "authority-test";
  plan.status = "approved";
  plan.modules.forEach((module) => {
    module.approval = {
      decision: "approved",
      comment: "client claimed approval",
      updatedAt: "2026-07-17T00:00:00.000Z"
    };
  });

  const store = new ReviewStore();
  const imported = store.importReview(plan);
  assert.equal(imported.review.status, "in_review");
  assert.ok(imported.review.modules.every((module) =>
    module.approval.decision === "pending" && module.approval.updatedAt === null
  ));

  store.submitDecision("authority-test", {
    moduleId: imported.review.modules[0].id,
    decision: "approved",
    expectedRevision: 1
  });
  const replacement = store.getReview("authority-test");
  replacement.title = "Replacement cannot retain approval";
  const replaced = store.replaceReview("authority-test", replacement);
  assert.equal(replaced.review.status, "in_review");
  assert.ok(replaced.review.modules.every((module) => module.approval.decision === "pending"));
});

test("ReviewStore rejects a decision made against a stale review revision", () => {
  const store = new ReviewStore([createTdePlanFixture()]);
  const module = store.getReview("doris-tde-demo").modules[0];
  module.summary = "New detail the reviewer has not seen";
  store.replaceModule("doris-tde-demo", module.id, module);

  assert.throws(
    () => store.submitDecision("doris-tde-demo", {
      moduleId: module.id,
      decision: "approved",
      expectedRevision: 1
    }),
    (error) => error instanceof ReviewStoreError &&
      error.code === "stale_review_revision" &&
      error.status === 409
  );
  assert.equal(
    store.getReview("doris-tde-demo").modules[0].approval.decision,
    "pending"
  );
});

test("ReviewStore updates module and aggregate approval state", () => {
  const store = new ReviewStore([createTdePlanFixture()]);
  const now = () => new Date("2026-07-17T01:02:03.000Z");

  const result = store.submitDecision(
    "doris-tde-demo",
    {
      moduleId: "write-path",
      decision: "changes_requested",
      comment: "密钥边界需要调整",
      expectedRevision: 1
    },
    { now }
  );

  assert.equal(result.reviewStatus, "changes_requested");
  assert.equal(result.revision, 2);
  assert.equal(result.revisionInfo.operation, "decision_updated");
  assert.equal(result.approval.updatedAt, "2026-07-17T01:02:03.000Z");
  assert.equal(
    store.getReview("doris-tde-demo").modules.find((module) => module.id === "write-path")
      .approval.comment,
    "密钥边界需要调整"
  );
});

test("ReviewStore rejects replayed decisions and exposes a fail-closed execution gate", () => {
  const store = new ReviewStore([createTdePlanFixture()]);
  const rejected = store.submitDecision("doris-tde-demo", {
    moduleId: "write-path",
    decision: "changes_requested",
    comment: "先调整密钥边界",
    expectedRevision: 1
  });
  assert.equal(rejected.revision, 2);
  assert.throws(
    () => store.submitDecision("doris-tde-demo", {
      moduleId: "write-path",
      decision: "approved",
      comment: "旧页面重放",
      expectedRevision: 1
    }),
    (error) => error instanceof ReviewStoreError &&
      error.code === "stale_review_revision" && error.status === 409
  );
  assert.equal(store.getExecutionGate("doris-tde-demo").allowed, false);

  const revised = store.getReview("doris-tde-demo").modules
    .find((module) => module.id === "write-path");
  revised.summary = "密钥边界已经按意见调整";
  const replacement = store.replaceModule("doris-tde-demo", revised.id, revised);
  let revision = replacement.revision;
  for (const module of store.getReview("doris-tde-demo").modules) {
    revision = store.submitDecision("doris-tde-demo", {
      moduleId: module.id,
      decision: "approved",
      expectedRevision: revision
    }).revision;
  }
  const gate = store.getExecutionGate("doris-tde-demo");
  assert.equal(gate.allowed, true);
  assert.equal(gate.revision, revision);
  const snapshot = store.getApprovedSnapshot("doris-tde-demo");
  assert.equal(snapshot.plan.status, "approved");
  assert.equal(snapshot.revision, revision);
  assert.match(snapshot.planDigest, /^sha256:[a-f0-9]{64}$/u);
});

test("ReviewStore persists acceptance for one approved revision and invalidates it on change", () => {
  const store = new ReviewStore([createTdePlanFixture()]);
  const revision = approveAll(store);
  const snapshot = store.getApprovedSnapshot("doris-tde-demo");
  const implemented = structuredClone(snapshot.plan);
  implemented.status = "implemented";
  const record = createAcceptanceRecord(snapshot, { mode: "model", implemented });

  assert.equal(store.recordAcceptance("doris-tde-demo", record).status, "pass");
  assert.equal(store.getAcceptance("doris-tde-demo").approvedRevision, revision);
  const restored = ReviewStore.fromState(store.exportState());
  assert.equal(restored.getAcceptance("doris-tde-demo").status, "pass");

  store.submitDecision("doris-tde-demo", {
    moduleId: store.getReview("doris-tde-demo").modules[0].id,
    decision: "changes_requested",
    comment: "re-open this module",
    expectedRevision: revision
  });
  assert.equal(store.getAcceptance("doris-tde-demo"), null);
});

test("ReviewStore reports unknown reviews and modules", () => {
  const store = new ReviewStore([createTdePlanFixture()]);

  assert.throws(
    () => store.submitDecision("missing", {
      moduleId: "write-path",
      decision: "approved",
      expectedRevision: 1
    }),
    (error) => error instanceof ReviewStoreError && error.status === 404
  );
  assert.throws(
    () => store.submitDecision("doris-tde-demo", {
      moduleId: "missing",
      decision: "approved",
      expectedRevision: 1
    }),
    (error) => error instanceof ReviewStoreError && error.code === "module_not_found"
  );
});

test("ReviewStore rejects changes_requested without a useful comment", () => {
  const store = new ReviewStore([createTdePlanFixture()]);

  assert.throws(
    () => store.submitDecision(
      "doris-tde-demo",
      {
        moduleId: "write-path",
        decision: "changes_requested",
        comment: "  ",
        expectedRevision: 1
      }
    ),
    (error) => error instanceof ReviewStoreError &&
      error.details.some((detail) => detail.code === "comment_required")
  );
});

test("ReviewStore approves every pending module in one atomic revision", () => {
  const store = new ReviewStore([createTdePlanFixture()]);
  const result = store.approvePendingModules(
    "doris-tde-demo",
    { expectedRevision: 1 },
    { now: () => new Date("2026-07-17T05:00:00.000Z") }
  );

  assert.equal(result.revision, 2);
  assert.equal(result.reviewStatus, "approved");
  assert.equal(result.approvals.length, 5);
  assert.ok(result.approvals.every(
    (entry) => entry.approval.decision === "approved" &&
      entry.approval.updatedAt === "2026-07-17T05:00:00.000Z"
  ));
  assert.ok(store.getReview("doris-tde-demo").modules.every(
    (module) => module.approval.decision === "approved"
  ));
  assert.deepEqual(
    store.listRevisions("doris-tde-demo").map((revision) => revision.operation),
    ["created", "pending_modules_approved"]
  );
  assert.equal(
    ReviewStore.fromState(store.exportState()).getReview("doris-tde-demo").status,
    "approved"
  );
});

test("bulk approval preserves requested changes and rejects stale or empty requests", () => {
  const store = new ReviewStore([createTdePlanFixture()]);
  store.submitDecision("doris-tde-demo", {
    moduleId: "write-path",
    decision: "changes_requested",
    comment: "Keep this module blocked",
    expectedRevision: 1
  });

  assert.throws(
    () => store.approvePendingModules("doris-tde-demo", { expectedRevision: 1 }),
    (error) => error instanceof ReviewStoreError && error.code === "stale_review_revision"
  );
  const result = store.approvePendingModules("doris-tde-demo", { expectedRevision: 2 });
  assert.equal(result.reviewStatus, "changes_requested");
  assert.equal(result.approvals.length, 4);
  assert.equal(
    store.getReview("doris-tde-demo").modules.find((module) => module.id === "write-path")
      .approval.decision,
    "changes_requested"
  );
  assert.throws(
    () => store.approvePendingModules("doris-tde-demo", { expectedRevision: 3 }),
    (error) => error instanceof ReviewStoreError && error.code === "no_pending_modules"
  );
});

test("ReviewStore validates Agent events and returns a versioned ack", () => {
  const store = new ReviewStore([createTdePlanFixture()]);
  const event = {
    schemaVersion: "1.0.0",
    source: "claude-code",
    type: "task_complete",
    occurredAt: "2026-07-17T01:00:00.000Z",
    sessionId: null,
    project: { cwd: "/srv/doris" },
    payload: { result: "done" }
  };

  const ack = store.recordEvent(event, {
    now: () => new Date("2026-07-17T01:00:01.000Z")
  });
  assert.equal(ack.kind, "IntentCanvasAgentEventAck");
  assert.equal(ack.eventType, "task_complete");
  assert.equal(ack.eventCount, 1);

  assert.throws(
    () => store.recordEvent({ ...event, type: "unknown" }),
    (error) => error instanceof ReviewStoreError && error.code === "invalid_event"
  );
});

test("ReviewStore records complete-plan and module revisions without resetting unrelated approvals", () => {
  const initial = createTdePlanFixture();
  initial.id = "revision-test";
  const store = new ReviewStore();
  const first = store.importReview(initial, {
    now: () => new Date("2026-07-17T01:00:00.000Z")
  });
  assert.equal(first.revision, 1);

  const completeReplacement = structuredClone(initial);
  completeReplacement.title = "Complete replacement";
  const second = store.replaceReview("revision-test", completeReplacement, {
    now: () => new Date("2026-07-17T02:00:00.000Z")
  });
  assert.equal(second.revision, 2);

  const firstDecision = store.submitDecision(
    "revision-test",
    {
      moduleId: "key-management",
      decision: "approved",
      comment: "keep this?",
      expectedRevision: 2
    },
    { now: () => new Date("2026-07-17T02:10:00.000Z") }
  );
  assert.equal(firstDecision.revision, 3);
  const secondDecision = store.submitDecision(
    "revision-test",
    {
      moduleId: "write-path",
      decision: "approved",
      comment: "preserve this",
      expectedRevision: 3
    },
    { now: () => new Date("2026-07-17T02:11:00.000Z") }
  );
  assert.equal(secondDecision.revision, 4);

  const module = store.getReview("revision-test").modules[0];
  module.summary = "Only this complete module changed.";
  const third = store.replaceModule("revision-test", module.id, module, {
    now: () => new Date("2026-07-17T03:00:00.000Z")
  });

  assert.equal(third.revision, 5);
  assert.equal(third.module.approval.decision, "pending");
  assert.equal(
    store.getReview("revision-test").modules.find((item) => item.id === "write-path")
      .approval.decision,
    "approved"
  );
  assert.deepEqual(
    store.listRevisions("revision-test").map((revision) => revision.operation),
    ["created", "replaced", "decision_updated", "decision_updated", "module_replaced"]
  );
  assert.equal(store.getRevision("revision-test", 2).plan.title, "Complete replacement");
});

test("ReviewStore state snapshots restore reviews, revision history, and events", () => {
  const store = new ReviewStore([createTdePlanFixture()]);
  store.recordEvent({
    schemaVersion: "1.0.0",
    source: "codex",
    type: "plan_ready",
    occurredAt: "2026-07-17T04:00:00.000Z",
    sessionId: "state-test",
    project: { cwd: "/srv/project" },
    payload: { reviewId: "doris-tde-demo" }
  });
  store.submitDecision(
    "doris-tde-demo",
    { moduleId: "write-path", decision: "approved", expectedRevision: 1 }
  );

  const recovered = ReviewStore.fromState(store.exportState());
  assert.equal(recovered.size, 1);
  assert.equal(recovered.eventCount, 1);
  assert.equal(recovered.getCurrentRevision("doris-tde-demo"), 2);
  assert.equal(
    recovered.getReview("doris-tde-demo").modules.find((module) => module.id === "write-path")
      .approval.decision,
    "approved"
  );
});

test("ReviewStore bounds full-plan revision history without mutating the accepted plan", () => {
  const plan = createTdePlanFixture();
  plan.id = "bounded-history";
  const store = new ReviewStore([plan], { revisionLimit: 2 });
  const replacement = store.getReview(plan.id);
  replacement.title = "Revision two";
  store.replaceReview(plan.id, replacement);

  const rejected = store.getReview(plan.id);
  rejected.title = "Revision three must not be committed";
  assert.throws(
    () => store.replaceReview(plan.id, rejected),
    (error) => error instanceof ReviewStoreError &&
      error.code === "revision_limit_reached" && error.status === 409
  );
  assert.equal(store.getCurrentRevision(plan.id), 2);
  assert.equal(store.getReview(plan.id).title, "Revision two");
});
