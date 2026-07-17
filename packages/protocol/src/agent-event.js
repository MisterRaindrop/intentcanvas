export const AGENT_EVENT_SCHEMA_VERSION = "1.0.0";
export const AGENT_EVENT_ACK_KIND = "IntentCanvasAgentEventAck";

export const AGENT_EVENT_TYPES = Object.freeze([
  "session_started",
  "session_ended",
  "plan_ready",
  "approval_required",
  "notification",
  "tool_running",
  "tool_finished",
  "task_complete",
  "review_drift_detected"
]);

function error(path, message, code = "invalid_value") {
  return { path, message, code };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateTimestamp(value, path, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(error(path, "must be a non-empty ISO-8601 timestamp", "invalid_type"));
  } else if (Number.isNaN(Date.parse(value))) {
    errors.push(error(path, "must be an ISO-8601 timestamp", "invalid_date"));
  }
}

function validateNonEmptyString(value, path, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(error(path, "must be a non-empty string", "invalid_type"));
  }
}

/** Validate a normalized event emitted by an Agent hook adapter. */
export function validateAgentEvent(event) {
  const errors = [];
  if (!isObject(event)) {
    return {
      valid: false,
      errors: [error("$", "must be an object", "invalid_type")]
    };
  }

  if (event.schemaVersion !== AGENT_EVENT_SCHEMA_VERSION) {
    errors.push(error(
      "$.schemaVersion",
      `unsupported schema version; expected ${AGENT_EVENT_SCHEMA_VERSION}`,
      "unsupported_version"
    ));
  }
  validateNonEmptyString(event.source, "$.source", errors);
  if (!AGENT_EVENT_TYPES.includes(event.type)) {
    errors.push(error(
      "$.type",
      `must be one of: ${AGENT_EVENT_TYPES.join(", ")}`,
      "invalid_enum"
    ));
  }
  validateTimestamp(event.occurredAt, "$.occurredAt", errors);

  if (event.sessionId !== null && event.sessionId !== undefined) {
    validateNonEmptyString(event.sessionId, "$.sessionId", errors);
  }
  if (!isObject(event.project)) {
    errors.push(error("$.project", "must be an object", "invalid_type"));
  } else {
    validateNonEmptyString(event.project.cwd, "$.project.cwd", errors);
  }
  if (!isObject(event.payload)) {
    errors.push(error("$.payload", "must be an object", "invalid_type"));
  }
  if (event.reviewId !== null && event.reviewId !== undefined) {
    validateNonEmptyString(event.reviewId, "$.reviewId", errors);
  }

  return { valid: errors.length === 0, errors };
}

export function assertAgentEvent(event) {
  const result = validateAgentEvent(event);
  if (!result.valid) {
    const details = result.errors.map((item) => `${item.path}: ${item.message}`).join("; ");
    const failure = new TypeError(`Invalid IntentCanvas Agent Event: ${details}`);
    failure.errors = result.errors;
    throw failure;
  }
  return event;
}

export function createAgentEventAck(event, {
  eventCount,
  receivedAt = new Date().toISOString()
} = {}) {
  assertAgentEvent(event);
  if (!Number.isInteger(eventCount) || eventCount < 1) {
    throw new TypeError("eventCount must be a positive integer");
  }
  return {
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    kind: AGENT_EVENT_ACK_KIND,
    accepted: true,
    eventType: event.type,
    sessionId: event.sessionId ?? null,
    receivedAt,
    eventCount
  };
}

export function validateAgentEventAck(ack) {
  const errors = [];
  if (!isObject(ack)) {
    return {
      valid: false,
      errors: [error("$", "must be an object", "invalid_type")]
    };
  }
  if (ack.schemaVersion !== AGENT_EVENT_SCHEMA_VERSION) {
    errors.push(error("$.schemaVersion", "contains an unsupported version", "unsupported_version"));
  }
  if (ack.kind !== AGENT_EVENT_ACK_KIND) {
    errors.push(error("$.kind", `must equal ${AGENT_EVENT_ACK_KIND}`, "invalid_kind"));
  }
  if (ack.accepted !== true) {
    errors.push(error("$.accepted", "must equal true", "invalid_value"));
  }
  if (!AGENT_EVENT_TYPES.includes(ack.eventType)) {
    errors.push(error("$.eventType", "must be a supported Agent event type", "invalid_enum"));
  }
  if (ack.sessionId !== null && ack.sessionId !== undefined) {
    validateNonEmptyString(ack.sessionId, "$.sessionId", errors);
  }
  validateTimestamp(ack.receivedAt, "$.receivedAt", errors);
  if (!Number.isInteger(ack.eventCount) || ack.eventCount < 1) {
    errors.push(error("$.eventCount", "must be a positive integer", "invalid_number"));
  }
  return { valid: errors.length === 0, errors };
}
