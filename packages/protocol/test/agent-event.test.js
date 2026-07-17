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
