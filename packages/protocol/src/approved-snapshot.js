import { createHash } from "node:crypto";

import { assertPlanModel, validatePlanModel } from "./plan-model.js";

export const APPROVED_SNAPSHOT_SCHEMA_VERSION = "1.0.0";
export const APPROVED_SNAPSHOT_KIND = "IntentCanvasApprovedSnapshot";
const SNAPSHOT_KEYS = new Set([
  "schemaVersion",
  "kind",
  "reviewId",
  "revision",
  "frozenAt",
  "planDigest",
  "plan"
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function planModelDigest(plan) {
  assertPlanModel(plan);
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(plan)))
    .digest("hex")}`;
}

export function validateApprovedSnapshot(snapshot) {
  const errors = [];
  const add = (path, message, code = "invalid_value") => errors.push({ path, message, code });
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    add("$", "must be an object", "invalid_type");
    return { valid: false, errors };
  }
  for (const key of Object.keys(snapshot)) {
    if (!SNAPSHOT_KEYS.has(key)) add(`$.${key}`, "is not a recognized property", "unknown_property");
  }
  if (snapshot.schemaVersion !== APPROVED_SNAPSHOT_SCHEMA_VERSION) {
    add("$.schemaVersion", `must equal ${APPROVED_SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (snapshot.kind !== APPROVED_SNAPSHOT_KIND) {
    add("$.kind", `must equal ${APPROVED_SNAPSHOT_KIND}`);
  }
  if (typeof snapshot.reviewId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(snapshot.reviewId)) {
    add("$.reviewId", "must be a safe review id");
  }
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 1) {
    add("$.revision", "must be a positive integer", "invalid_number");
  }
  if (typeof snapshot.frozenAt !== "string" || Number.isNaN(Date.parse(snapshot.frozenAt))) {
    add("$.frozenAt", "must be an ISO-8601 timestamp", "invalid_date");
  }
  const planValidation = validatePlanModel(snapshot.plan);
  errors.push(...planValidation.errors.map((error) => ({
    ...error,
    path: `$.plan${error.path.slice(1)}`
  })));
  if (planValidation.valid) {
    if (snapshot.plan.id !== snapshot.reviewId) add("$.plan.id", "must match reviewId");
    if (snapshot.plan.status !== "approved") add("$.plan.status", "must be approved");
    if (!snapshot.plan.modules.every((module) => module.approval.decision === "approved")) {
      add("$.plan.modules", "every module must be approved");
    }
    const expectedDigest = planModelDigest(snapshot.plan);
    if (snapshot.planDigest !== expectedDigest) {
      add("$.planDigest", "does not match the frozen plan", "digest_mismatch");
    }
  } else if (typeof snapshot.planDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(snapshot.planDigest)) {
    add("$.planDigest", "must be a sha256 digest", "invalid_format");
  }
  return { valid: errors.length === 0, errors };
}

export function assertApprovedSnapshot(snapshot) {
  const validation = validateApprovedSnapshot(snapshot);
  if (!validation.valid) {
    const error = new TypeError(`Invalid approved snapshot: ${validation.errors
      .map((item) => `${item.path}: ${item.message}`).join("; ")}`);
    error.errors = validation.errors;
    throw error;
  }
  return snapshot;
}

export function createApprovedSnapshot(plan, { revision, frozenAt } = {}) {
  assertPlanModel(plan);
  const snapshot = {
    schemaVersion: APPROVED_SNAPSHOT_SCHEMA_VERSION,
    kind: APPROVED_SNAPSHOT_KIND,
    reviewId: plan.id,
    revision,
    frozenAt,
    planDigest: planModelDigest(plan),
    plan: structuredClone(plan)
  };
  return structuredClone(assertApprovedSnapshot(snapshot));
}

export function cloneApprovedSnapshot(snapshot) {
  return structuredClone(assertApprovedSnapshot(snapshot));
}
