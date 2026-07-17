import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_EVENT_ACK_KIND,
  AGENT_EVENT_SCHEMA_VERSION,
  createAgentEventAck,
  validateAgentEvent,
  validateAgentEventAck
} from "../src/index.js";

function event(overrides = {}) {
  return {
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    source: "claude-code",
    type: "plan_ready",
    occurredAt: "2026-07-17T01:00:00.000Z",
    sessionId: "session-1",
    project: { cwd: "/srv/doris" },
    payload: { planId: "doris-tde-demo" },
    ...overrides
  };
}

test("validates the versioned normalized Agent event contract", () => {
  assert.deepEqual(validateAgentEvent(event()), { valid: true, errors: [] });

  const invalid = validateAgentEvent(event({ type: "made_up_event" }));
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((item) => item.path === "$.type"));
});

test("rejects incompatible versions and incomplete project context", () => {
  const invalid = validateAgentEvent(event({
    schemaVersion: "2.0.0",
    project: {},
    payload: null
  }));

  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((item) => item.code === "unsupported_version"));
  assert.ok(invalid.errors.some((item) => item.path === "$.project.cwd"));
  assert.ok(invalid.errors.some((item) => item.path === "$.payload"));
});

test("creates and validates a versioned acknowledgement", () => {
  const ack = createAgentEventAck(event(), {
    eventCount: 3,
    receivedAt: "2026-07-17T01:00:01.000Z"
  });

  assert.equal(ack.kind, AGENT_EVENT_ACK_KIND);
  assert.equal(ack.accepted, true);
  assert.equal(ack.eventType, "plan_ready");
  assert.deepEqual(validateAgentEventAck(ack), { valid: true, errors: [] });
});

test("accepts the explicit Agent event payload vocabulary", () => {
  const result = validateAgentEvent(event({
    reviewId: "review-1",
    payload: {
      hookEventName: "PostToolUse",
      sessionSource: "startup",
      sessionReason: "user requested a review",
      notificationType: "permission_prompt",
      toolName: "Bash",
      moduleIds: ["runtime", "studio"],
      outcome: "success",
      semanticType: "tool_finished",
      reviewId: "review-1",
      result: "done",
      planId: "doris-tde-demo"
    }
  }));

  assert.deepEqual(result, { valid: true, errors: [] });
});

test("rejects unknown Agent event, project, and payload properties", () => {
  const result = validateAgentEvent(event({
    secret: "top-level",
    project: { cwd: "/srv/doris", environment: { TOKEN: "hidden" } },
    payload: { planId: "doris-tde-demo", tool_input: { command: "danger" } }
  }));

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors
      .filter((item) => item.code === "unknown_property")
      .map((item) => item.path),
    ["$.secret", "$.project.environment", "$.payload.tool_input"]
  );
});

test("Agent event identifiers reject controls and excessive length", () => {
  const result = validateAgentEvent(event({
    sessionId: "session\nforged",
    reviewId: "r".repeat(257),
    payload: { moduleIds: ["runtime\u001b[2J", "runtime;curl"] }
  }));

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) =>
    item.path === "$.sessionId" && item.code === "invalid_identifier"));
  assert.ok(result.errors.some((item) =>
    item.path === "$.reviewId" && item.code === "too_large"));
  assert.ok(result.errors.some((item) =>
    item.path === "$.payload.moduleIds[0]" && item.code === "invalid_identifier"));
  assert.ok(result.errors.some((item) =>
    item.path === "$.payload.moduleIds[1]" && item.code === "invalid_identifier"));
});
