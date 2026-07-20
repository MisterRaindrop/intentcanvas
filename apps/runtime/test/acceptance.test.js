import test from "node:test";
import assert from "node:assert/strict";

import {
  createApprovedSnapshot,
  createTdePlanFixture
} from "@intentcanvas/protocol";
import {
  ACCEPTANCE_RECORD_KIND,
  assertAcceptanceRecord,
  createAcceptanceRecord
} from "../src/acceptance.js";

function approvedSnapshot() {
  const plan = createTdePlanFixture();
  plan.status = "approved";
  for (const module of plan.modules) {
    module.approval = {
      decision: "approved",
      comment: "reviewed",
      updatedAt: "2026-07-20T00:00:00.000Z"
    };
  }
  return createApprovedSnapshot(plan, {
    revision: 9,
    frozenAt: "2026-07-20T00:00:00.000Z"
  });
}

test("compacts a model acceptance report for Studio without storing the full model", () => {
  const snapshot = approvedSnapshot();
  const implemented = structuredClone(snapshot.plan);
  implemented.status = "implemented";

  const record = createAcceptanceRecord(snapshot, {
    mode: "model",
    implemented
  }, { now: () => new Date("2026-07-20T01:00:00.000Z") });

  assert.equal(record.kind, ACCEPTANCE_RECORD_KIND);
  assert.equal(record.reviewId, snapshot.reviewId);
  assert.equal(record.approvedRevision, 9);
  assert.equal(record.status, "pass");
  assert.equal(record.modules.length, snapshot.plan.modules.length);
  assert.equal(record.findings.length, 0);
  assert.equal(record.assurance, "declared_model");
  assert.deepEqual(assertAcceptanceRecord(record), record);
  assert.equal("implemented" in record, false);
});

test("rejects malformed acceptance input instead of guessing its mode", () => {
  const snapshot = approvedSnapshot();
  assert.throws(
    () => createAcceptanceRecord(snapshot, { mode: "model" }),
    /Plan Model.*must be an object/u
  );
  assert.throws(
    () => assertAcceptanceRecord({ kind: ACCEPTANCE_RECORD_KIND }),
    /Invalid IntentCanvas acceptance record/u
  );

  const record = createAcceptanceRecord(snapshot, {
    mode: "model",
    implemented: { ...snapshot.plan, status: "implemented" }
  });
  assert.throws(
    () => assertAcceptanceRecord({
      ...record,
      sourceKind: "facts",
      assurance: "structural_code_facts"
    }),
    /Invalid IntentCanvas acceptance record/u
  );
  assert.throws(
    () => assertAcceptanceRecord({
      ...record,
      digests: { ...record.digests, implemented: "not-a-digest" }
    }),
    /Invalid IntentCanvas acceptance record/u
  );
  assert.throws(
    () => assertAcceptanceRecord({
      ...record,
      summary: { ...record.summary, totalFindings: 1 }
    }),
    /Invalid IntentCanvas acceptance record details/u
  );
});
