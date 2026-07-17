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

const MAX_IDENTIFIER_LENGTH = 256;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const MAX_PAYLOAD_STRING_LENGTH = 1024;
const MAX_MODULE_IDS = 100;
const EVENT_KEYS = Object.freeze([
  "schemaVersion", "source", "type", "occurredAt", "sessionId", "project", "payload",
  "reviewId"
]);
const PROJECT_KEYS = Object.freeze(["cwd"]);
const PAYLOAD_KEYS = Object.freeze([
  "hookEventName",
  "sessionSource",
  "sessionReason",
  "notificationType",
  "toolName",
  "moduleIds",
  "outcome",
  "semanticType",
  "reviewId",
  "result",
  "planId"
]);

function error(path, message, code = "invalid_value") {
  return { path, message, code };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowedKeys, path, errors) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(error(`${path}.${key}`, "is not a recognized property", "unknown_property"));
    }
  }
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

function validateIdentifier(value, path, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(error(path, "must be a non-empty string", "invalid_type"));
    return;
  }
  if ([...value].length > MAX_IDENTIFIER_LENGTH) {
    errors.push(error(
      path,
      `must be at most ${MAX_IDENTIFIER_LENGTH} characters`,
      "too_large"
    ));
  }
  if (!IDENTIFIER_PATTERN.test(value)) {
    errors.push(error(
      path,
      "must be a safe identifier using letters, digits, '.', '_', ':', '/', or '-'",
      "invalid_identifier"
    ));
  }
}

function validatePayloadString(value, path, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(error(path, "must be a non-empty string", "invalid_type"));
    return;
  }
  if ([...value].length > MAX_PAYLOAD_STRING_LENGTH) {
    errors.push(error(
      path,
      `must be at most ${MAX_PAYLOAD_STRING_LENGTH} characters`,
      "too_large"
    ));
  }
}

function validatePayload(payload, errors) {
  rejectUnknownKeys(payload, PAYLOAD_KEYS, "$.payload", errors);

  for (const key of [
    "hookEventName",
    "sessionSource",
    "sessionReason",
    "notificationType",
    "toolName",
    "outcome",
    "semanticType",
    "result"
  ]) {
    if (payload[key] !== undefined) {
      validatePayloadString(payload[key], `$.payload.${key}`, errors);
    }
  }

  for (const key of ["reviewId", "planId"]) {
    if (payload[key] !== undefined) {
      validateIdentifier(payload[key], `$.payload.${key}`, errors);
    }
  }

  if (payload.moduleIds !== undefined) {
    if (!Array.isArray(payload.moduleIds)) {
      errors.push(error("$.payload.moduleIds", "must be an array", "invalid_type"));
    } else {
      if (payload.moduleIds.length > MAX_MODULE_IDS) {
        errors.push(error(
          "$.payload.moduleIds",
          `must contain at most ${MAX_MODULE_IDS} items`,
          "too_large"
        ));
      }
      payload.moduleIds.forEach((moduleId, index) => {
        validateIdentifier(moduleId, `$.payload.moduleIds[${index}]`, errors);
      });
    }
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
  rejectUnknownKeys(event, EVENT_KEYS, "$", errors);

  if (event.schemaVersion !== AGENT_EVENT_SCHEMA_VERSION) {
    errors.push(error(
      "$.schemaVersion",
      `unsupported schema version; expected ${AGENT_EVENT_SCHEMA_VERSION}`,
      "unsupported_version"
    ));
  }
  validateIdentifier(event.source, "$.source", errors);
  if (!AGENT_EVENT_TYPES.includes(event.type)) {
    errors.push(error(
      "$.type",
      `must be one of: ${AGENT_EVENT_TYPES.join(", ")}`,
      "invalid_enum"
    ));
  }
  validateTimestamp(event.occurredAt, "$.occurredAt", errors);

  if (event.sessionId !== null && event.sessionId !== undefined) {
    validateIdentifier(event.sessionId, "$.sessionId", errors);
  }
  if (!isObject(event.project)) {
    errors.push(error("$.project", "must be an object", "invalid_type"));
  } else {
    rejectUnknownKeys(event.project, PROJECT_KEYS, "$.project", errors);
    validateNonEmptyString(event.project.cwd, "$.project.cwd", errors);
  }
  if (!isObject(event.payload)) {
    errors.push(error("$.payload", "must be an object", "invalid_type"));
  } else {
    validatePayload(event.payload, errors);
  }
  if (event.reviewId !== null && event.reviewId !== undefined) {
    validateIdentifier(event.reviewId, "$.reviewId", errors);
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
