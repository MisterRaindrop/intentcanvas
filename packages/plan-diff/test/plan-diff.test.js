import assert from "node:assert/strict";
import test from "node:test";

import { createTdePlanFixture } from "@intentcanvas/protocol";
import {
  DRIFT_REPORT_KIND,
  comparePlanModels,
  formatDriftReportMarkdown,
  modelDigest
} from "../src/index.js";

function approvedPlan() {
  const plan = createTdePlanFixture();
  plan.status = "approved";
  plan.modules.forEach((module) => {
    module.approval = {
      decision: "approved",
      comment: "Approved for implementation",
      updatedAt: "2026-07-17T00:00:00.000Z"
    };
  });
  return plan;
}

function implementedFrom(plan) {
  const implemented = structuredClone(plan);
  implemented.status = "implemented";
  return implemented;
}

test("identical approved and implemented shapes pass", () => {
  const approved = approvedPlan();
  const implemented = implementedFrom(approved);
  const report = comparePlanModels(approved, implemented, {
    now: () => new Date("2026-07-17T01:00:00.000Z")
  });

  assert.equal(report.kind, DRIFT_REPORT_KIND);
  assert.equal(report.status, "pass");
  assert.equal(report.summary.total, 0);
  assert.equal(report.modules.length, approved.modules.length);
  assert.ok(report.modules.every((module) => module.status === "matched"));
  assert.match(report.approvedDigest, /^[a-f0-9]{64}$/);
});

test("digest is deterministic across object key order", () => {
  assert.equal(modelDigest({ a: 1, b: { c: 2 } }), modelDigest({ b: { c: 2 }, a: 1 }));
});

test("missing planned changes make the report incomplete", () => {
  const approved = approvedPlan();
  const implemented = implementedFrom(approved);
  implemented.modules[0].changes = [];

  assert.throws(
    () => comparePlanModels(approved, implemented),
    /Invalid IntentCanvas Plan Model/
  );

  implemented.modules[0].changes = structuredClone(approved.modules[0].changes);
  implemented.modules.splice(4, 1);
  implemented.relationships = implemented.relationships.filter(
    (relationship) => relationship.from !== "maintenance-paths" && relationship.to !== "maintenance-paths"
  );
  implemented.risks = implemented.risks
    .map((risk) => ({
      ...risk,
      moduleIds: risk.moduleIds.filter((moduleId) => moduleId !== "maintenance-paths")
    }))
    .filter((risk) => risk.moduleIds.length > 0);
  implemented.verification = implemented.verification.map((check) => ({
    ...check,
    moduleIds: check.moduleIds.filter((moduleId) => moduleId !== "maintenance-paths")
  }));
  const report = comparePlanModels(approved, implemented);
  assert.equal(report.status, "incomplete");
  assert.ok(report.summary.missing >= 1);
  assert.equal(report.modules.find((module) => module.moduleId === "maintenance-paths").status, "missing");
});

test("unapproved changes and relationships require review", () => {
  const approved = approvedPlan();
  const implemented = implementedFrom(approved);
  const extraChange = structuredClone(implemented.modules[0].changes[0]);
  extraChange.id = "unexpected-key-export";
  extraChange.title = "Unexpected key export";
  implemented.modules[0].changes.push(extraChange);
  implemented.relationships.push({
    from: "fe-metadata",
    to: "write-path",
    label: "unapproved direct dependency",
    status: "added",
    summary: "This dependency was not approved."
  });

  const report = comparePlanModels(approved, implemented);
  assert.equal(report.status, "review_required");
  assert.equal(report.summary.unapproved, 2);
  assert.ok(report.modules[0].findings.some((item) => item.code === "unapproved_change"));
  assert.ok(report.findings.some((item) => item.code === "unapproved_relationship"));
});

test("status, entry-point, and call-path changes are structural drift", () => {
  const approved = approvedPlan();
  const implemented = implementedFrom(approved);
  implemented.modules[2].status = "added";
  implemented.modules[2].entryPoints[0].signature = "DeltaWriterV2::open()";
  implemented.modules[2].changes[0].callPath[0].label = "DeltaWriterV2::open()";

  const report = comparePlanModels(approved, implemented);
  const findings = report.modules.find((module) => module.moduleId === "write-path").findings;
  assert.equal(report.status, "review_required");
  assert.ok(findings.some((item) => item.code === "module_status_mismatch"));
  assert.ok(findings.some((item) => item.code === "entry_point_missing"));
  assert.ok(findings.some((item) => item.code === "change_shape_mismatch"));
});

test("requires a completely approved source plan", () => {
  const plan = createTdePlanFixture();
  assert.throws(() => comparePlanModels(plan, plan), /status approved/);

  plan.status = "approved";
  assert.throws(() => comparePlanModels(plan, plan), /Every module/);
});

test("formats a concise Markdown acceptance report", () => {
  const approved = approvedPlan();
  const implemented = implementedFrom(approved);
  implemented.modules[0].status = "modified";
  const report = comparePlanModels(approved, implemented);
  const markdown = formatDriftReportMarkdown(report);

  assert.match(markdown, /# IntentCanvas implementation review: doris-tde-demo/);
  assert.match(markdown, /Result:\*\* review_required/);
  assert.match(markdown, /密钥与加密模块/);
  assert.match(markdown, /module change status differs/);
});
