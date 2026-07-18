import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REVIEW_ID,
  normalizeDecisionResponse,
  normalizeReview,
  reviewIdFromSearch
} from "../review-model.js";

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
