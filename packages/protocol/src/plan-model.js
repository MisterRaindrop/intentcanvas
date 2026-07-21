export const PLAN_SCHEMA_VERSION = "1.0.0";
export const PLAN_KIND = "IntentCanvasPlan";

export const PLAN_STATUSES = Object.freeze([
  "draft",
  "in_review",
  "changes_requested",
  "approved",
  "implemented"
]);

export const CHANGE_STATUSES = Object.freeze([
  "added",
  "removed",
  "modified",
  "unchanged"
]);

export const APPROVAL_DECISIONS = Object.freeze([
  "pending",
  "approved",
  "changes_requested"
]);

const RISK_LEVELS = Object.freeze(["low", "medium", "high", "critical"]);
const NODE_TYPES = Object.freeze([
  "module",
  "class",
  "interface",
  "function",
  "service",
  "data"
]);
const MAX_IDENTIFIER_LENGTH = 256;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

const PLAN_KEYS = Object.freeze([
  "schemaVersion", "kind", "id", "title", "status", "createdAt", "project",
  "goal", "summary", "modules", "relationships", "risks", "verification"
]);
const PROJECT_KEYS = Object.freeze(["name", "repository", "baseRef"]);
const MODULE_KEYS = Object.freeze([
  "id", "name", "order", "status", "layer", "summary", "entryPoints", "diagram",
  "changes", "approval"
]);
const ENTRY_POINT_KEYS = Object.freeze(["signature", "file", "line"]);
const DIAGRAM_KEYS = Object.freeze(["nodes", "edges"]);
const DIAGRAM_NODE_KEYS = Object.freeze(["id", "label", "type", "status", "description"]);
const DIAGRAM_EDGE_KEYS = Object.freeze(["from", "to", "label", "status"]);
const CHANGE_KEYS = Object.freeze([
  "id", "title", "status", "location", "rationale", "callPath", "pseudocode",
  "dependencies"
]);
const DEPENDENCY_KEYS = Object.freeze(["kind", "from", "to", "status"]);
const LOCATION_KEYS = Object.freeze(["file", "symbol"]);
const CALL_PATH_STEP_KEYS = Object.freeze(["label", "status", "collapsedCount"]);
const PSEUDOCODE_KEYS = Object.freeze(["language", "before", "after"]);
const APPROVAL_KEYS = Object.freeze(["decision", "comment", "updatedAt"]);
const RELATIONSHIP_KEYS = Object.freeze(["from", "to", "label", "status", "summary"]);
const RISK_KEYS = Object.freeze(["id", "level", "title", "mitigation", "moduleIds"]);
const VERIFICATION_KEYS = Object.freeze(["id", "type", "command", "expected", "moduleIds"]);
const APPROVAL_DECISION_KEYS = Object.freeze([
  "moduleId", "expectedRevision", "decision", "comment"
]);
const APPROVE_PENDING_KEYS = Object.freeze(["expectedRevision"]);

function addError(errors, path, message, code = "invalid_value") {
  errors.push({ path, message, code });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, path, errors) {
  if (!isObject(value)) {
    addError(errors, path, "must be an object", "invalid_type");
    return false;
  }
  return true;
}

function requireArray(value, path, errors, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    addError(errors, path, "must be an array", "invalid_type");
    return false;
  }
  if (nonEmpty && value.length === 0) {
    addError(errors, path, "must contain at least one item", "too_small");
    return false;
  }
  return true;
}

function requireString(value, path, errors, { allowEmpty = false } = {}) {
  if (typeof value !== "string") {
    addError(errors, path, "must be a string", "invalid_type");
    return false;
  }
  if (!allowEmpty && value.trim().length === 0) {
    addError(errors, path, "must not be empty", "too_small");
    return false;
  }
  return true;
}

function rejectUnknownKeys(value, allowedKeys, path, errors) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      addError(errors, `${path}.${key}`, "is not a recognized property", "unknown_property");
    }
  }
}

function requireIdentifier(value, path, errors) {
  if (!requireString(value, path, errors)) return false;
  if ([...value].length > MAX_IDENTIFIER_LENGTH) {
    addError(
      errors,
      path,
      `must be at most ${MAX_IDENTIFIER_LENGTH} characters`,
      "too_large"
    );
    return false;
  }
  if (!IDENTIFIER_PATTERN.test(value)) {
    addError(
      errors,
      path,
      "must start with a letter or digit and contain only letters, digits, '.', '_', ':', '/', or '-'",
      "invalid_identifier"
    );
    return false;
  }
  return true;
}

function requireEnum(value, allowed, path, errors) {
  if (!allowed.includes(value)) {
    addError(errors, path, `must be one of: ${allowed.join(", ")}`, "invalid_enum");
    return false;
  }
  return true;
}

function validateProject(project, errors) {
  if (!requireObject(project, "$.project", errors)) return;
  rejectUnknownKeys(project, PROJECT_KEYS, "$.project", errors);
  requireString(project.name, "$.project.name", errors);
  requireString(project.repository, "$.project.repository", errors);
  requireString(project.baseRef, "$.project.baseRef", errors);
}

function validateEntryPoint(entryPoint, path, errors) {
  if (!requireObject(entryPoint, path, errors)) return;
  rejectUnknownKeys(entryPoint, ENTRY_POINT_KEYS, path, errors);
  requireString(entryPoint.signature, `${path}.signature`, errors);
  requireString(entryPoint.file, `${path}.file`, errors);
  if (entryPoint.line !== undefined &&
      (!Number.isInteger(entryPoint.line) || entryPoint.line < 1)) {
    addError(errors, `${path}.line`, "must be a positive integer", "invalid_number");
  }
}

function validateDiagram(diagram, path, errors) {
  if (!requireObject(diagram, path, errors)) return;
  rejectUnknownKeys(diagram, DIAGRAM_KEYS, path, errors);
  const nodeIds = new Set();

  if (requireArray(diagram.nodes, `${path}.nodes`, errors, { nonEmpty: true })) {
    diagram.nodes.forEach((node, index) => {
      const nodePath = `${path}.nodes[${index}]`;
      if (!requireObject(node, nodePath, errors)) return;
      rejectUnknownKeys(node, DIAGRAM_NODE_KEYS, nodePath, errors);
      if (requireIdentifier(node.id, `${nodePath}.id`, errors)) {
        if (nodeIds.has(node.id)) {
          addError(errors, `${nodePath}.id`, "must be unique within the diagram", "duplicate_id");
        }
        nodeIds.add(node.id);
      }
      requireString(node.label, `${nodePath}.label`, errors);
      requireEnum(node.type, NODE_TYPES, `${nodePath}.type`, errors);
      requireEnum(node.status, CHANGE_STATUSES, `${nodePath}.status`, errors);
      if (node.description !== undefined) {
        requireString(node.description, `${nodePath}.description`, errors, { allowEmpty: true });
      }
    });
  }

  if (requireArray(diagram.edges, `${path}.edges`, errors)) {
    diagram.edges.forEach((edge, index) => {
      const edgePath = `${path}.edges[${index}]`;
      if (!requireObject(edge, edgePath, errors)) return;
      rejectUnknownKeys(edge, DIAGRAM_EDGE_KEYS, edgePath, errors);
      if (requireIdentifier(edge.from, `${edgePath}.from`, errors) && !nodeIds.has(edge.from)) {
        addError(errors, `${edgePath}.from`, "must reference a node in this diagram", "unknown_reference");
      }
      if (requireIdentifier(edge.to, `${edgePath}.to`, errors) && !nodeIds.has(edge.to)) {
        addError(errors, `${edgePath}.to`, "must reference a node in this diagram", "unknown_reference");
      }
      if (edge.label !== undefined) {
        requireString(edge.label, `${edgePath}.label`, errors, { allowEmpty: true });
      }
      if (edge.status !== undefined) {
        requireEnum(edge.status, CHANGE_STATUSES, `${edgePath}.status`, errors);
      }
    });
  }
}

function validateChange(change, path, errors) {
  if (!requireObject(change, path, errors)) return;
  rejectUnknownKeys(change, CHANGE_KEYS, path, errors);
  requireIdentifier(change.id, `${path}.id`, errors);
  requireString(change.title, `${path}.title`, errors);
  requireEnum(change.status, CHANGE_STATUSES, `${path}.status`, errors);
  requireString(change.rationale, `${path}.rationale`, errors);

  if (requireObject(change.location, `${path}.location`, errors)) {
    rejectUnknownKeys(change.location, LOCATION_KEYS, `${path}.location`, errors);
    requireString(change.location.file, `${path}.location.file`, errors);
    requireString(change.location.symbol, `${path}.location.symbol`, errors);
  }

  if (requireArray(change.callPath, `${path}.callPath`, errors, { nonEmpty: true })) {
    change.callPath.forEach((step, index) => {
      const stepPath = `${path}.callPath[${index}]`;
      if (!requireObject(step, stepPath, errors)) return;
      rejectUnknownKeys(step, CALL_PATH_STEP_KEYS, stepPath, errors);
      requireString(step.label, `${stepPath}.label`, errors);
      requireEnum(step.status, CHANGE_STATUSES, `${stepPath}.status`, errors);
      if (step.collapsedCount !== undefined &&
          (!Number.isInteger(step.collapsedCount) || step.collapsedCount < 1)) {
        addError(
          errors,
          `${stepPath}.collapsedCount`,
          "must be a positive integer",
          "invalid_number"
        );
      }
    });
  }

  if (requireObject(change.pseudocode, `${path}.pseudocode`, errors)) {
    rejectUnknownKeys(change.pseudocode, PSEUDOCODE_KEYS, `${path}.pseudocode`, errors);
    requireString(change.pseudocode.language, `${path}.pseudocode.language`, errors);
    requireString(change.pseudocode.before, `${path}.pseudocode.before`, errors, { allowEmpty: true });
    requireString(change.pseudocode.after, `${path}.pseudocode.after`, errors, { allowEmpty: true });
  }

  if (change.dependencies !== undefined &&
      requireArray(change.dependencies, `${path}.dependencies`, errors)) {
    change.dependencies.forEach((dependency, index) => {
      const dependencyPath = `${path}.dependencies[${index}]`;
      if (!requireObject(dependency, dependencyPath, errors)) return;
      rejectUnknownKeys(dependency, DEPENDENCY_KEYS, dependencyPath, errors);
      requireEnum(dependency.kind, ["include"], `${dependencyPath}.kind`, errors);
      requireString(dependency.from, `${dependencyPath}.from`, errors);
      requireString(dependency.to, `${dependencyPath}.to`, errors);
      requireEnum(dependency.status, CHANGE_STATUSES, `${dependencyPath}.status`, errors);
    });
  }
}

function validateApproval(approval, path, errors) {
  if (!requireObject(approval, path, errors)) return;
  rejectUnknownKeys(approval, APPROVAL_KEYS, path, errors);
  requireEnum(approval.decision, APPROVAL_DECISIONS, `${path}.decision`, errors);
  requireString(approval.comment, `${path}.comment`, errors, { allowEmpty: true });
  if (approval.decision === "changes_requested" &&
      (typeof approval.comment !== "string" || approval.comment.trim().length === 0)) {
    addError(
      errors,
      `${path}.comment`,
      "must explain the requested changes",
      "comment_required"
    );
  }
  if (approval.updatedAt !== null && approval.updatedAt !== undefined) {
    if (requireString(approval.updatedAt, `${path}.updatedAt`, errors) &&
        Number.isNaN(Date.parse(approval.updatedAt))) {
      addError(errors, `${path}.updatedAt`, "must be an ISO-8601 timestamp or null", "invalid_date");
    }
  }
}

function validateModule(module, index, moduleIds, errors) {
  const path = `$.modules[${index}]`;
  if (!requireObject(module, path, errors)) return;
  rejectUnknownKeys(module, MODULE_KEYS, path, errors);

  if (requireIdentifier(module.id, `${path}.id`, errors)) {
    if (moduleIds.has(module.id)) {
      addError(errors, `${path}.id`, "must be unique", "duplicate_id");
    }
    moduleIds.add(module.id);
  }
  requireString(module.name, `${path}.name`, errors);
  if (!Number.isInteger(module.order) || module.order < 1) {
    addError(errors, `${path}.order`, "must be a positive integer", "invalid_number");
  }
  requireEnum(module.status, CHANGE_STATUSES, `${path}.status`, errors);
  requireString(module.layer, `${path}.layer`, errors);
  requireString(module.summary, `${path}.summary`, errors);

  if (requireArray(module.entryPoints, `${path}.entryPoints`, errors, { nonEmpty: true })) {
    module.entryPoints.forEach((entryPoint, entryIndex) => {
      validateEntryPoint(entryPoint, `${path}.entryPoints[${entryIndex}]`, errors);
    });
  }
  validateDiagram(module.diagram, `${path}.diagram`, errors);

  const changeIds = new Set();
  if (requireArray(module.changes, `${path}.changes`, errors, { nonEmpty: true })) {
    module.changes.forEach((change, changeIndex) => {
      validateChange(change, `${path}.changes[${changeIndex}]`, errors);
      if (isObject(change) && typeof change.id === "string") {
        if (changeIds.has(change.id)) {
          addError(errors, `${path}.changes[${changeIndex}].id`, "must be unique within the module", "duplicate_id");
        }
        changeIds.add(change.id);
      }
    });
  }
  validateApproval(module.approval, `${path}.approval`, errors);
}

function validateRelationships(relationships, moduleIds, errors) {
  if (!requireArray(relationships, "$.relationships", errors)) return;
  relationships.forEach((relationship, index) => {
    const path = `$.relationships[${index}]`;
    if (!requireObject(relationship, path, errors)) return;
    rejectUnknownKeys(relationship, RELATIONSHIP_KEYS, path, errors);
    if (requireIdentifier(relationship.from, `${path}.from`, errors) &&
        !moduleIds.has(relationship.from)) {
      addError(errors, `${path}.from`, "must reference a module", "unknown_reference");
    }
    if (requireIdentifier(relationship.to, `${path}.to`, errors) &&
        !moduleIds.has(relationship.to)) {
      addError(errors, `${path}.to`, "must reference a module", "unknown_reference");
    }
    requireString(relationship.label, `${path}.label`, errors);
    requireEnum(relationship.status, CHANGE_STATUSES, `${path}.status`, errors);
    requireString(relationship.summary, `${path}.summary`, errors);
  });
}

function validateRisks(risks, moduleIds, errors) {
  if (!requireArray(risks, "$.risks", errors)) return;
  risks.forEach((risk, index) => {
    const path = `$.risks[${index}]`;
    if (!requireObject(risk, path, errors)) return;
    rejectUnknownKeys(risk, RISK_KEYS, path, errors);
    requireIdentifier(risk.id, `${path}.id`, errors);
    requireEnum(risk.level, RISK_LEVELS, `${path}.level`, errors);
    requireString(risk.title, `${path}.title`, errors);
    requireString(risk.mitigation, `${path}.mitigation`, errors);
    if (requireArray(risk.moduleIds, `${path}.moduleIds`, errors, { nonEmpty: true })) {
      risk.moduleIds.forEach((moduleId, moduleIndex) => {
        if (requireIdentifier(moduleId, `${path}.moduleIds[${moduleIndex}]`, errors) &&
            !moduleIds.has(moduleId)) {
          addError(
            errors,
            `${path}.moduleIds[${moduleIndex}]`,
            "must reference a module",
            "unknown_reference"
          );
        }
      });
    }
  });
}

function validateVerification(verification, moduleIds, errors) {
  if (!requireArray(verification, "$.verification", errors, { nonEmpty: true })) return;
  verification.forEach((check, index) => {
    const path = `$.verification[${index}]`;
    if (!requireObject(check, path, errors)) return;
    rejectUnknownKeys(check, VERIFICATION_KEYS, path, errors);
    requireIdentifier(check.id, `${path}.id`, errors);
    requireString(check.type, `${path}.type`, errors);
    requireString(check.command, `${path}.command`, errors);
    requireString(check.expected, `${path}.expected`, errors);
    if (requireArray(check.moduleIds, `${path}.moduleIds`, errors)) {
      check.moduleIds.forEach((moduleId, moduleIndex) => {
        if (requireIdentifier(moduleId, `${path}.moduleIds[${moduleIndex}]`, errors) &&
            !moduleIds.has(moduleId)) {
          addError(
            errors,
            `${path}.moduleIds[${moduleIndex}]`,
            "must reference a module",
            "unknown_reference"
          );
        }
      });
    }
  });
}

/**
 * Validate an IntentCanvas Plan Model without mutating it.
 *
 * @param {unknown} plan candidate plan
 * @returns {{valid: boolean, errors: Array<{path: string, message: string, code: string}>}}
 */
export function validatePlanModel(plan) {
  const errors = [];
  if (!requireObject(plan, "$", errors)) return { valid: false, errors };
  rejectUnknownKeys(plan, PLAN_KEYS, "$", errors);

  if (requireString(plan.schemaVersion, "$.schemaVersion", errors) &&
      plan.schemaVersion !== PLAN_SCHEMA_VERSION) {
    addError(
      errors,
      "$.schemaVersion",
      `unsupported schema version; expected ${PLAN_SCHEMA_VERSION}`,
      "unsupported_version"
    );
  }
  if (plan.kind !== PLAN_KIND) {
    addError(errors, "$.kind", `must equal ${PLAN_KIND}`, "invalid_kind");
  }
  requireIdentifier(plan.id, "$.id", errors);
  requireString(plan.title, "$.title", errors);
  requireEnum(plan.status, PLAN_STATUSES, "$.status", errors);
  if (requireString(plan.createdAt, "$.createdAt", errors) && Number.isNaN(Date.parse(plan.createdAt))) {
    addError(errors, "$.createdAt", "must be an ISO-8601 timestamp", "invalid_date");
  }
  validateProject(plan.project, errors);
  requireString(plan.goal, "$.goal", errors);
  requireString(plan.summary, "$.summary", errors);

  const moduleIds = new Set();
  if (requireArray(plan.modules, "$.modules", errors, { nonEmpty: true })) {
    plan.modules.forEach((module, index) => validateModule(module, index, moduleIds, errors));
  }
  validateRelationships(plan.relationships, moduleIds, errors);
  validateRisks(plan.risks, moduleIds, errors);
  validateVerification(plan.verification, moduleIds, errors);

  return { valid: errors.length === 0, errors };
}

export function assertPlanModel(plan) {
  const result = validatePlanModel(plan);
  if (!result.valid) {
    const details = result.errors.map((error) => `${error.path}: ${error.message}`).join("; ");
    const failure = new TypeError(`Invalid IntentCanvas Plan Model: ${details}`);
    failure.errors = result.errors;
    throw failure;
  }
  return plan;
}

export function validateApprovalDecision(value) {
  const errors = [];
  if (!requireObject(value, "$", errors)) return { valid: false, errors };
  rejectUnknownKeys(value, APPROVAL_DECISION_KEYS, "$", errors);
  requireIdentifier(value.moduleId, "$.moduleId", errors);
  if (!Number.isInteger(value.expectedRevision) || value.expectedRevision < 1) {
    addError(
      errors,
      "$.expectedRevision",
      "must be a positive integer",
      "invalid_number"
    );
  }
  requireEnum(
    value.decision,
    APPROVAL_DECISIONS.filter((decision) => decision !== "pending"),
    "$.decision",
    errors
  );
  if (value.comment !== undefined) {
    requireString(value.comment, "$.comment", errors, { allowEmpty: true });
  }
  if (value.decision === "changes_requested" &&
      (typeof value.comment !== "string" || value.comment.trim().length === 0)) {
    addError(
      errors,
      "$.comment",
      "must explain the requested changes",
      "comment_required"
    );
  }
  return { valid: errors.length === 0, errors };
}

export function validateApprovePendingRequest(value) {
  const errors = [];
  if (!requireObject(value, "$", errors)) return { valid: false, errors };
  rejectUnknownKeys(value, APPROVE_PENDING_KEYS, "$", errors);
  if (!Number.isInteger(value.expectedRevision) || value.expectedRevision < 1) {
    addError(
      errors,
      "$.expectedRevision",
      "must be a positive integer",
      "invalid_number"
    );
  }
  return { valid: errors.length === 0, errors };
}

export function clonePlanModel(plan) {
  return structuredClone(assertPlanModel(plan));
}
