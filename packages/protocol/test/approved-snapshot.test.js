import assert from "node:assert/strict";
import test from "node:test";

import {
  createApprovedSnapshot,
  createTdePlanFixture,
  planModelDigest,
  validateApprovedSnapshot
} from "../src/index.js";

function approvedPlan() {
  const plan = createTdePlanFixture();
  plan.status = "approved";
  plan.modules.forEach((module) => {
    module.approval = {
      decision: "approved",
      comment: "reviewed",
      updatedAt: "2026-07-18T00:00:00.000Z"
    };
  });
  return plan;
}

test("freezes a revision-bound approved plan with a deterministic digest", () => {
  const plan = approvedPlan();
  const snapshot = createApprovedSnapshot(plan, {
    revision: 7,
    frozenAt: "2026-07-18T00:00:00.000Z"
  });
  assert.equal(snapshot.planDigest, planModelDigest(plan));
  assert.deepEqual(validateApprovedSnapshot(snapshot), { valid: true, errors: [] });

  snapshot.plan.summary = "tampered after approval";
  assert.equal(validateApprovedSnapshot(snapshot).valid, false);
  assert.ok(validateApprovedSnapshot(snapshot).errors.some(
    (error) => error.code === "digest_mismatch"
  ));
});

test("refuses to freeze a pending plan", () => {
  assert.throws(
    () => createApprovedSnapshot(createTdePlanFixture(), {
      revision: 1,
      frozenAt: "2026-07-18T00:00:00.000Z"
    }),
    /must be approved|every module/
  );
});
