import test from "node:test";
import assert from "node:assert/strict";

import {
  PLAN_SCHEMA_VERSION,
  assertPlanModel,
  createTdePlanFixture,
  tdePlanFixture,
  validateApprovalDecision,
  validatePlanModel
} from "../src/index.js";

test("the TDE fixture is a valid, versioned Plan Model", () => {
  const result = validatePlanModel(tdePlanFixture);

  assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2));
  assert.equal(tdePlanFixture.schemaVersion, PLAN_SCHEMA_VERSION);
  assert.equal(tdePlanFixture.id, "doris-tde-demo");
  assert.equal(tdePlanFixture.modules.length, 5);
});

test("fixture copies are mutable and do not change the canonical fixture", () => {
  const copy = createTdePlanFixture();
  copy.modules[0].approval.decision = "approved";

  assert.equal(copy.modules[0].approval.decision, "approved");
  assert.equal(tdePlanFixture.modules[0].approval.decision, "pending");
});

test("validation reports useful paths for invalid plans", () => {
  const plan = createTdePlanFixture();
  plan.schemaVersion = "99.0.0";
  plan.modules[0].diagram.edges[0].to = "missing-node";

  const result = validatePlanModel(plan);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "unsupported_version"));
  assert.ok(result.errors.some((error) => error.path.endsWith(".edges[0].to")));
  assert.throws(() => assertPlanModel(plan), /Invalid IntentCanvas Plan Model/);
});

test("approval decisions reject pending and malformed requests", () => {
  assert.equal(
    validateApprovalDecision({ moduleId: "write-path", decision: "approved", comment: "OK" }).valid,
    true
  );
  assert.equal(
    validateApprovalDecision({ moduleId: "write-path", decision: "pending" }).valid,
    false
  );
  assert.equal(validateApprovalDecision({ decision: "approved" }).valid, false);
  const missingComment = validateApprovalDecision({
    moduleId: "write-path",
    decision: "changes_requested",
    comment: "   "
  });
  assert.equal(missingComment.valid, false);
  assert.ok(missingComment.errors.some((error) => error.code === "comment_required"));
});

test("stored changes_requested approvals also require an explanation", () => {
  const plan = createTdePlanFixture();
  plan.modules[0].approval.decision = "changes_requested";

  const result = validatePlanModel(plan);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "comment_required"));
});
