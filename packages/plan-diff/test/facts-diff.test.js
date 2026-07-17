import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CODE_FACTS_DIFF_KIND,
  FACTS_AUDIT_KIND,
  auditPlanAgainstCodeFacts,
  codeFactsDigest,
  compareCodeFacts,
  formatFactsAuditMarkdown
} from "../src/index.js";

const fingerprint = (character) => `sha256:${character.repeat(64)}`;
const source = (tool = "test-extractor") => ({ tool, version: "1.0.0" });

function approvedPlan({ status = "modified" } = {}) {
  return {
    schemaVersion: "1.0.0",
    kind: "IntentCanvasPlan",
    id: "service-review",
    title: "Service change",
    status: "approved",
    createdAt: "2026-07-17T00:00:00.000Z",
    project: {
      name: "example",
      repository: "https://example.invalid/example.git",
      baseRef: "main"
    },
    goal: "Change the service safely.",
    summary: "Only Service::run is allowed to change.",
    modules: [
      {
        id: "service",
        name: "Service",
        order: 1,
        status,
        layer: "Core",
        summary: "Change the service implementation.",
        entryPoints: [{ signature: "Service::run()", file: "src/service.cc" }],
        diagram: {
          nodes: [{ id: "service", label: "Service", type: "class", status }],
          edges: []
        },
        changes: [
          {
            id: "change-run",
            title: "Change run",
            status,
            location: { file: "src/service.cc", symbol: "Service::run" },
            rationale: "The behavior must change.",
            callPath: [{ label: "Service::run()", status }],
            pseudocode: {
              language: "cpp",
              before: "return old_value;",
              after: "return new_value;"
            }
          }
        ],
        approval: {
          decision: "approved",
          comment: "Approved",
          updatedAt: "2026-07-17T00:00:00.000Z"
        }
      }
    ],
    relationships: [],
    risks: [],
    verification: [
      {
        id: "unit",
        type: "test",
        command: "npm test",
        expected: "All tests pass.",
        moduleIds: ["service"]
      }
    ]
  };
}

function codeFacts({
  fileFingerprint = fingerprint("a"),
  symbolFingerprint = fingerprint("b"),
  symbolId = "ast:service-run",
  symbolConfidence = "high",
  confidence = "high",
  diagnostics = [],
  line = 10
} = {}) {
  return {
    schemaVersion: "1.0.0",
    kind: "IntentCanvasCodeFacts",
    project: { root: "/srv/example", name: "example" },
    files: [
      {
        path: "src/service.cc",
        language: "cpp",
        fingerprint: fileFingerprint,
        confidence: "high",
        source: source("filesystem")
      }
    ],
    symbols: [
      {
        id: symbolId,
        name: "run",
        qualifiedName: "Service::run",
        signature: "void Service::run()",
        kind: "method",
        file: "src/service.cc",
        location: { line },
        fingerprint: symbolFingerprint,
        confidence: symbolConfidence,
        source: source("clang-ast")
      }
    ],
    includeEdges: [],
    callEdges: [],
    diagnostics,
    confidence,
    source: source("@intentcanvas/code-facts")
  };
}

function changedFacts() {
  return codeFacts({
    fileFingerprint: fingerprint("c"),
    symbolFingerprint: fingerprint("d"),
    symbolId: "another-extractor-id",
    line: 30
  });
}

test("semantic facts diff and approved audit pass for the requested symbol change", () => {
  const current = codeFacts();
  const implemented = changedFacts();
  const diff = compareCodeFacts(current, implemented);

  assert.equal(diff.kind, CODE_FACTS_DIFF_KIND);
  assert.equal(diff.summary.files.modified, 1);
  assert.equal(diff.summary.symbols.modified, 1);
  assert.equal(diff.symbols.added.length, 0);
  assert.equal(diff.symbols.removed.length, 0);

  const report = auditPlanAgainstCodeFacts(approvedPlan(), current, implemented, {
    now: () => new Date("2026-07-17T01:00:00.000Z")
  });
  assert.equal(report.kind, FACTS_AUDIT_KIND);
  assert.equal(report.status, "pass");
  assert.deepEqual(report.summary, {
    plannedChanges: 1,
    satisfied: 1,
    incomplete: 0,
    unapproved: 0,
    evidenceIssues: 0,
    totalFindings: 0
  });
  assert.equal(report.plannedChanges[0].status, "satisfied");
  const markdown = formatFactsAuditMarkdown(report);
  assert.match(markdown, /1\/1 proven/);
  assert.match(markdown, /structural facts only/);
});

test("semantic facts diff classifies removed files, symbols, includes, and calls", () => {
  const current = codeFacts();
  current.files.push({
    path: "src/legacy.cc",
    language: "cpp",
    fingerprint: fingerprint("e"),
    confidence: "high",
    source: source("filesystem")
  });
  current.symbols.push({
    id: "ast:legacy",
    name: "legacy",
    qualifiedName: "Legacy::legacy",
    signature: "void Legacy::legacy()",
    kind: "method",
    file: "src/legacy.cc",
    location: { line: 1 },
    fingerprint: fingerprint("f"),
    confidence: "high",
    source: source("clang-ast")
  });
  current.includeEdges.push({
    from: "src/service.cc",
    to: "src/legacy.cc",
    location: { line: 1 },
    confidence: "high",
    source: source("compiler-deps")
  });
  current.callEdges.push({
    from: "ast:service-run",
    to: "ast:legacy",
    location: { file: "src/service.cc", line: 12 },
    confidence: "high",
    source: source("clang-ast")
  });

  const diff = compareCodeFacts(current, codeFacts());
  assert.equal(diff.summary.files.removed, 1);
  assert.equal(diff.summary.symbols.removed, 1);
  assert.equal(diff.summary.includeEdges.removed, 1);
  assert.equal(diff.summary.callEdges.removed, 1);
});

test("unplanned files, symbols, includes, and calls require review", () => {
  const current = codeFacts();
  const implemented = changedFacts();
  implemented.files.push({
    path: "src/unexpected.cc",
    language: "cpp",
    fingerprint: fingerprint("e"),
    confidence: "high",
    source: source("filesystem")
  });
  implemented.symbols.push({
    id: "ast:unexpected-helper",
    name: "helper",
    qualifiedName: "Unexpected::helper",
    signature: "void Unexpected::helper()",
    kind: "method",
    file: "src/unexpected.cc",
    location: { line: 1 },
    fingerprint: fingerprint("f"),
    confidence: "high",
    source: source("clang-ast")
  });
  implemented.includeEdges.push({
    from: "src/service.cc",
    to: "src/unexpected.cc",
    location: { line: 1 },
    confidence: "high",
    source: source("compiler-deps")
  });
  implemented.callEdges.push({
    from: "another-extractor-id",
    to: "ast:unexpected-helper",
    location: { file: "src/service.cc", line: 31 },
    confidence: "high",
    source: source("clang-ast")
  });

  const report = auditPlanAgainstCodeFacts(approvedPlan(), current, implemented);
  assert.equal(report.status, "review_required");
  assert.equal(report.summary.unapproved, 4);
  assert.deepEqual(
    new Set(report.findings.map((item) => item.code)),
    new Set([
      "unapproved_file_change",
      "unapproved_symbol_change",
      "unapproved_include_dependency_change",
      "unapproved_call_dependency_change"
    ])
  );
});

test("a same-named method on another class is not mistaken for approved evidence", () => {
  const current = codeFacts();
  const implemented = codeFacts({
    fileFingerprint: fingerprint("c"),
    symbolFingerprint: fingerprint("b")
  });
  implemented.symbols.push({
    id: "ast:other-run",
    name: "run",
    qualifiedName: "OtherService::run",
    signature: "void OtherService::run()",
    kind: "method",
    file: "src/service.cc",
    location: { line: 50 },
    fingerprint: fingerprint("f"),
    confidence: "high",
    source: source("clang-ast")
  });

  const report = auditPlanAgainstCodeFacts(approvedPlan(), current, implemented);
  assert.equal(report.status, "review_required");
  assert.equal(report.plannedChanges[0].status, "not_observed");
  assert.ok(report.findings.some((item) => item.code === "unapproved_symbol_change"));
});

test("a planned change that did not happen is incomplete", () => {
  const current = codeFacts();
  const implemented = codeFacts({ symbolId: "new-id-only", line: 99 });
  const report = auditPlanAgainstCodeFacts(approvedPlan(), current, implemented);

  assert.equal(report.status, "incomplete");
  assert.equal(report.summary.satisfied, 0);
  assert.equal(report.plannedChanges[0].status, "not_observed");
  assert.ok(report.findings.some((item) => item.code === "planned_change_not_observed"));
});

test("low-confidence facts and diagnostics never become a false pass", () => {
  const current = codeFacts();
  const implemented = changedFacts();
  implemented.symbols[0].confidence = "low";
  implemented.diagnostics.push({
    severity: "warning",
    code: "partial-ast",
    message: "Some declarations could not be parsed",
    file: "src/service.cc",
    confidence: "high",
    source: source("@intentcanvas/code-facts")
  });

  const report = auditPlanAgainstCodeFacts(approvedPlan(), current, implemented);
  assert.equal(report.status, "incomplete");
  assert.equal(report.plannedChanges[0].status, "evidence_insufficient");
  assert.ok(report.findings.some((item) => item.code === "planned_change_evidence_insufficient"));
  assert.ok(report.findings.some((item) => item.code === "facts_diagnostic_warning"));
});

test("missing symbol fingerprints are reported as insufficient evidence", () => {
  const current = codeFacts();
  const implemented = changedFacts();
  delete current.symbols[0].fingerprint;
  delete implemented.symbols[0].fingerprint;

  const report = auditPlanAgainstCodeFacts(approvedPlan(), current, implemented);
  assert.equal(report.status, "incomplete");
  assert.equal(report.plannedChanges[0].status, "evidence_insufficient");
  assert.equal(report.summary.evidenceIssues, 1);
});

test("semantic identities, digests, and output are stable across IDs, ordering, and line movement", () => {
  const first = codeFacts();
  first.symbols.push({
    id: "ast:caller-one",
    name: "main",
    qualifiedName: "main",
    signature: "int main()",
    kind: "function",
    file: "src/service.cc",
    location: { line: 1 },
    fingerprint: fingerprint("e"),
    confidence: "high",
    source: source("clang-ast")
  });
  first.callEdges.push({
    from: "ast:caller-one",
    to: "ast:service-run",
    location: { file: "src/service.cc", line: 4 },
    confidence: "high",
    source: source("clang-ast")
  });

  const second = structuredClone(first);
  second.symbols[0].id = "unstable-run-id";
  second.symbols[0].location.line = 80;
  second.symbols[1].id = "unstable-main-id";
  second.symbols[1].location.line = 70;
  second.project.root = "/different/worktree/example";
  second.callEdges[0].from = "unstable-main-id";
  second.callEdges[0].to = "unstable-run-id";
  second.callEdges[0].location.line = 75;
  second.symbols.reverse();

  const diff = compareCodeFacts(first, second);
  assert.equal(diff.summary.symbols.unchanged, 2);
  assert.equal(diff.summary.callEdges.unchanged, 1);
  assert.equal(diff.summary.symbols.modified, 0);
  assert.equal(diff.summary.callEdges.modified, 0);
  assert.equal(codeFactsDigest(first), codeFactsDigest(second));
  assert.deepEqual(diff, compareCodeFacts(structuredClone(first), structuredClone(second)));
});

test("facts diff CLI emits JSON and a pass exit code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "intentcanvas-facts-diff-"));
  const paths = {
    plan: join(directory, "approved.json"),
    current: join(directory, "current.json"),
    implemented: join(directory, "implemented.json")
  };
  await Promise.all([
    writeFile(paths.plan, JSON.stringify(approvedPlan())),
    writeFile(paths.current, JSON.stringify(codeFacts())),
    writeFile(paths.implemented, JSON.stringify(changedFacts()))
  ]);

  const result = spawnSync(process.execPath, [
    new URL("../src/facts-bin.js", import.meta.url).pathname,
    paths.plan,
    paths.current,
    paths.implemented
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "pass");
});
