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
    validateApprovalDecision({
      moduleId: "write-path",
      decision: "approved",
      comment: "OK",
      expectedRevision: 1
    }).valid,
    true
  );
  assert.equal(
    validateApprovalDecision({
      moduleId: "write-path",
      decision: "pending",
      expectedRevision: 1
    }).valid,
    false
  );
  assert.equal(
    validateApprovalDecision({ moduleId: "write-path", decision: "approved" }).valid,
    false
  );
  assert.equal(validateApprovalDecision({ decision: "approved" }).valid, false);
  const missingComment = validateApprovalDecision({
    moduleId: "write-path",
    decision: "changes_requested",
    comment: "   ",
    expectedRevision: 1
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

test("changes can explicitly authorize concrete include dependency edges", () => {
  const plan = createTdePlanFixture();
  plan.modules[0].changes[0].dependencies = [{
    kind: "include",
    from: "be/src/security/key_manager.cpp",
    to: "be/src/security/key_manager.h",
    status: "added"
  }];
  assert.deepEqual(validatePlanModel(plan), { valid: true, errors: [] });

  plan.modules[0].changes[0].dependencies[0].kind = "guessed";
  assert.ok(validatePlanModel(plan).errors.some(
    (error) => error.path.endsWith(".dependencies[0].kind")
  ));
});

test("rejects unknown properties at every Plan Model structure level", () => {
  const cases = [
    ["$", (plan) => { plan.secret = "root"; }],
    ["$.project", (plan) => { plan.project.secret = "project"; }],
    ["$.modules[0]", (plan) => { plan.modules[0].secret = "module"; }],
    ["$.modules[0].entryPoints[0]", (plan) => {
      plan.modules[0].entryPoints[0].secret = "entry-point";
    }],
    ["$.modules[0].diagram", (plan) => { plan.modules[0].diagram.secret = "diagram"; }],
    ["$.modules[0].diagram.nodes[0]", (plan) => {
      plan.modules[0].diagram.nodes[0].secret = "node";
    }],
    ["$.modules[0].diagram.edges[0]", (plan) => {
      plan.modules[0].diagram.edges[0].secret = "edge";
    }],
    ["$.modules[0].changes[0]", (plan) => {
      plan.modules[0].changes[0].secret = "change";
    }],
    ["$.modules[0].changes[0].location", (plan) => {
      plan.modules[0].changes[0].location.secret = "location";
    }],
    ["$.modules[0].changes[0].callPath[0]", (plan) => {
      plan.modules[0].changes[0].callPath[0].secret = "call-path";
    }],
    ["$.modules[0].changes[0].pseudocode", (plan) => {
      plan.modules[0].changes[0].pseudocode.secret = "pseudocode";
    }],
    ["$.modules[0].changes[0].dependencies[0]", (plan) => {
      plan.modules[0].changes[0].dependencies = [{
        kind: "include",
        from: "a.cc",
        to: "b.h",
        status: "added",
        secret: "dependency"
      }];
    }],
    ["$.modules[0].approval", (plan) => {
      plan.modules[0].approval.secret = "approval";
    }],
    ["$.relationships[0]", (plan) => { plan.relationships[0].secret = "relationship"; }],
    ["$.risks[0]", (plan) => { plan.risks[0].secret = "risk"; }],
    ["$.verification[0]", (plan) => { plan.verification[0].secret = "verification"; }]
  ];

  for (const [path, mutate] of cases) {
    const plan = createTdePlanFixture();
    mutate(plan);
    const result = validatePlanModel(plan);
    assert.equal(result.valid, false, `expected ${path} to reject its unknown property`);
    assert.ok(
      result.errors.some((error) =>
        error.code === "unknown_property" && error.path === `${path}.secret`),
      `${path} did not report the unknown property: ${JSON.stringify(result.errors)}`
    );
  }
});

test("Plan identifiers reject control characters and excessive length", () => {
  const withControl = createTdePlanFixture();
  withControl.id = "review\nforged";
  const controlResult = validatePlanModel(withControl);
  assert.equal(controlResult.valid, false);
  assert.ok(controlResult.errors.some((error) =>
    error.path === "$.id" && error.code === "invalid_identifier"));

  const withShellSyntax = createTdePlanFixture();
  withShellSyntax.id = "review;curl-evil";
  const shellResult = validatePlanModel(withShellSyntax);
  assert.equal(shellResult.valid, false);
  assert.ok(shellResult.errors.some((error) =>
    error.path === "$.id" && error.code === "invalid_identifier"));

  const tooLong = createTdePlanFixture();
  tooLong.modules[0].diagram.nodes[0].id = "n".repeat(257);
  const lengthResult = validatePlanModel(tooLong);
  assert.equal(lengthResult.valid, false);
  assert.ok(lengthResult.errors.some((error) =>
    error.path === "$.modules[0].diagram.nodes[0].id" && error.code === "too_large"));
});

test("approval decision requests reject unknown properties and unsafe module ids", () => {
  const unknown = validateApprovalDecision({
    moduleId: "write-path",
    decision: "approved",
    expectedRevision: 1,
    injectedApproval: true
  });
  assert.equal(unknown.valid, false);
  assert.ok(unknown.errors.some((error) =>
    error.path === "$.injectedApproval" && error.code === "unknown_property"));

  const unsafe = validateApprovalDecision({
    moduleId: `write-path\u001b[2J`,
    decision: "approved",
    expectedRevision: 1
  });
  assert.equal(unsafe.valid, false);
  assert.ok(unsafe.errors.some((error) => error.code === "invalid_identifier"));
});
