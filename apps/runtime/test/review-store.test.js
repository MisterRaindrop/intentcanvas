import test from "node:test";
import assert from "node:assert/strict";

import { createTdePlanFixture } from "@intentcanvas/protocol";
import { ReviewStore, ReviewStoreError } from "../src/review-store.js";

test("ReviewStore keeps its own plan copy and returns defensive copies", () => {
  const plan = createTdePlanFixture();
  const store = new ReviewStore([plan]);
  plan.title = "changed outside";

  const firstRead = store.getReview("doris-tde-demo");
  firstRead.title = "changed read";

  assert.notEqual(store.getReview("doris-tde-demo").title, "changed outside");
  assert.notEqual(store.getReview("doris-tde-demo").title, "changed read");
});

test("ReviewStore updates module and aggregate approval state", () => {
  const store = new ReviewStore([createTdePlanFixture()]);
  const now = () => new Date("2026-07-17T01:02:03.000Z");

  const result = store.submitDecision(
    "doris-tde-demo",
    { moduleId: "write-path", decision: "changes_requested", comment: "密钥边界需要调整" },
    { now }
  );

  assert.equal(result.reviewStatus, "changes_requested");
  assert.equal(result.approval.updatedAt, "2026-07-17T01:02:03.000Z");
  assert.equal(
    store.getReview("doris-tde-demo").modules.find((module) => module.id === "write-path")
      .approval.comment,
    "密钥边界需要调整"
  );
});

test("ReviewStore reports unknown reviews and modules", () => {
  const store = new ReviewStore([createTdePlanFixture()]);

  assert.throws(
    () => store.submitDecision("missing", { moduleId: "write-path", decision: "approved" }),
    (error) => error instanceof ReviewStoreError && error.status === 404
  );
  assert.throws(
    () => store.submitDecision("doris-tde-demo", { moduleId: "missing", decision: "approved" }),
    (error) => error instanceof ReviewStoreError && error.code === "module_not_found"
  );
});

test("ReviewStore rejects changes_requested without a useful comment", () => {
  const store = new ReviewStore([createTdePlanFixture()]);

  assert.throws(
    () => store.submitDecision(
      "doris-tde-demo",
      { moduleId: "write-path", decision: "changes_requested", comment: "  " }
    ),
    (error) => error instanceof ReviewStoreError &&
      error.details.some((detail) => detail.code === "comment_required")
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
