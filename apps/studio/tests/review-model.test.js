import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REVIEW_ID,
  normalizeAcceptanceResponse,
  normalizeApprovePendingResponse,
  normalizeDecisionResponse,
  normalizeReview,
  reviewIdFromSearch
} from "../review-model.js";

function acceptanceResponse() {
  return {
    reviewId: "review-1",
    acceptance: {
      schemaVersion: "1.0.0",
      kind: "IntentCanvasAcceptanceRecord",
      reviewId: "review-1",
      approvedRevision: 8,
      generatedAt: "2026-07-20T01:00:00.000Z",
      sourceKind: "facts",
      reportKind: "IntentCanvasFactsAuditReport",
      status: "review_required",
      summary: {
        totalFindings: 1,
        errors: 1,
        warnings: 0,
        plannedChanges: 1,
        satisfied: 1,
        incomplete: 0,
        unapproved: 1,
        evidenceIssues: 0
      },
      modules: [{
        moduleId: "storage",
        name: "存储层",
        status: "review_required",
        plannedChanges: 1,
        satisfied: 1,
        findingCount: 1
      }],
      findings: [{
        code: "unapproved_file_change",
        category: "unapproved",
        severity: "error",
        path: "/facts/files/helper.cpp",
        message: "计划外文件发生变化",
        moduleId: "storage"
      }],
      truncatedFindings: 0,
      digests: {},
      assurance: "structural_code_facts"
    }
  };
}

function validPlan() {
  return {
    schemaVersion: "1.0.0",
    kind: "IntentCanvasPlan",
    id: "review-1",
    title: "测试计划",
    status: "in_review",
    createdAt: "2026-07-17T00:00:00.000Z",
    project: { name: "Demo", repository: "local", baseRef: "main" },
    goal: "验证可视化计划",
    summary: "一个可执行的最小计划",
    modules: [
      {
        id: "storage",
        name: "存储层",
        order: 1,
        status: "modified",
        layer: "Storage",
        summary: "在文件边界增加加密包装层。",
        entryPoints: [{ signature: "Writer::open()", file: "writer.cpp" }],
        diagram: {
          nodes: [{ id: "writer", label: "Writer", type: "class", status: "modified" }],
          edges: []
        },
        changes: [
          {
            id: "wrap-output",
            title: "包装输出流",
            status: "modified",
            rationale: "让上层写入逻辑不感知加密。",
            location: { file: "writer.cpp", symbol: "Writer::open" },
            callPath: [{ label: "Writer::open()", status: "modified" }],
            pseudocode: { language: "cpp", before: "open();", after: "wrap(open());" },
            dependencies: [{
              kind: "include",
              from: "writer.cpp",
              to: "encrypted_stream.h",
              status: "added"
            }]
          }
        ],
        approval: { decision: "pending", comment: "", updatedAt: null }
      }
    ],
    relationships: [],
    risks: [],
    verification: [
      { id: "unit", type: "unit", command: "test", expected: "通过", moduleIds: [] }
    ]
  };
}

test("review id comes from the URL and keeps a safe demo default", () => {
  assert.equal(reviewIdFromSearch(""), DEFAULT_REVIEW_ID);
  assert.equal(reviewIdFromSearch("?review=feature-42"), "feature-42");
  assert.equal(reviewIdFromSearch("?review=%20%20"), DEFAULT_REVIEW_ID);
});

test("a complete Plan Model is cloned and accepted", () => {
  const input = validPlan();
  const result = normalizeReview(input);

  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.notEqual(result.modules[0], input.modules[0]);
});

test("unsupported and incomplete Plan Models are rejected instead of repaired", () => {
  const wrongVersion = validPlan();
  wrongVersion.schemaVersion = "2.0.0";
  assert.throws(() => normalizeReview(wrongVersion), /计划版本不兼容/);

  const missingLocation = validPlan();
  delete missingLocation.modules[0].changes[0].location;
  assert.throws(() => normalizeReview(missingLocation), /changes\[0\]\.location/);

  const guessedStatus = validPlan();
  guessedStatus.modules[0].status = "changed";
  assert.throws(() => normalizeReview(guessedStatus), /modules\[0\]\.status/);

  const guessedDependency = validPlan();
  guessedDependency.modules[0].changes[0].dependencies[0].kind = "guess";
  assert.throws(() => normalizeReview(guessedDependency), /dependencies\[0\]\.kind/);
});

test("a complete Runtime decision response is adopted without local fabrication", () => {
  const response = {
    reviewId: "review-1",
    moduleId: "storage",
    approval: {
      decision: "changes_requested",
      comment: "密钥必须由 KeyManager 提供",
      updatedAt: "2026-07-17T08:30:00.000Z"
    },
    reviewStatus: "changes_requested",
    revision: 3
  };

  const result = normalizeDecisionResponse(response, {
    expectedReviewId: "review-1",
    expectedModuleId: "storage"
  });
  assert.deepEqual(result, response);
  assert.notEqual(result.approval, response.approval);
});

test("incomplete or cross-module decision responses are rejected", () => {
  const response = {
    reviewId: "review-1",
    moduleId: "other-module",
    approval: { decision: "approved", comment: "", updatedAt: null },
    reviewStatus: "in_review",
    revision: 3
  };

  assert.throws(
    () => normalizeDecisionResponse(response, { expectedModuleId: "storage" }),
    /decisionResponse\.moduleId/
  );
  response.moduleId = "storage";
  assert.throws(
    () => normalizeDecisionResponse(response, { expectedModuleId: "storage" }),
    /updatedAt/
  );
  response.approval.updatedAt = "2026-07-17T08:30:00.000Z";
  delete response.revision;
  assert.throws(
    () => normalizeDecisionResponse(response, { expectedModuleId: "storage" }),
    /decisionResponse\.revision/
  );
});

test("bulk approval responses are validated before replacing module decisions", () => {
  const response = {
    reviewId: "review-1",
    approvals: [{
      moduleId: "storage",
      approval: {
        decision: "approved",
        comment: "",
        updatedAt: "2026-07-17T08:30:00.000Z"
      }
    }],
    reviewStatus: "approved",
    revision: 4
  };
  assert.deepEqual(normalizeApprovePendingResponse(response, {
    expectedReviewId: "review-1",
    expectedModuleIds: ["storage"]
  }), response);

  const unknownModule = structuredClone(response);
  unknownModule.approvals[0].moduleId = "other";
  assert.throws(
    () => normalizeApprovePendingResponse(unknownModule, {
      expectedReviewId: "review-1",
      expectedModuleIds: ["storage"]
    }),
    /moduleId/
  );
  const wrongDecision = structuredClone(response);
  wrongDecision.approvals[0].approval.decision = "changes_requested";
  wrongDecision.approvals[0].approval.comment = "blocked";
  assert.throws(() => normalizeApprovePendingResponse(wrongDecision), /approved/);
});

test("acceptance summaries are validated before Studio renders them", () => {
  const input = acceptanceResponse();
  const normalized = normalizeAcceptanceResponse(input, {
    expectedReviewId: "review-1",
    expectedModuleIds: ["storage"]
  });
  assert.deepEqual(normalized, input);
  assert.notEqual(normalized.acceptance, input.acceptance);

  const empty = normalizeAcceptanceResponse({
    reviewId: "review-1",
    acceptance: null
  }, { expectedReviewId: "review-1" });
  assert.equal(empty.acceptance, null);
});

test("acceptance summaries cannot reference another review or module", () => {
  const wrongReview = acceptanceResponse();
  wrongReview.acceptance.reviewId = "other";
  assert.throws(
    () => normalizeAcceptanceResponse(wrongReview, { expectedReviewId: "review-1" }),
    /reviewId/u
  );

  const wrongModule = acceptanceResponse();
  wrongModule.acceptance.modules[0].moduleId = "unknown";
  assert.throws(
    () => normalizeAcceptanceResponse(wrongModule, {
      expectedReviewId: "review-1",
      expectedModuleIds: ["storage"]
    }),
    /不是当前计划模块/u
  );
});
