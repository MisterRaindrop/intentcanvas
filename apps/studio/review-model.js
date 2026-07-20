export const DEFAULT_REVIEW_ID = "doris-tde-demo";
export const PLAN_SCHEMA_VERSION = "1.0.0";
export const PLAN_KIND = "IntentCanvasPlan";

const CHANGE_STATUSES = ["added", "modified", "removed", "unchanged"];
const PLAN_STATUSES = ["draft", "in_review", "changes_requested", "approved", "implemented"];
const APPROVAL_DECISIONS = ["pending", "approved", "changes_requested"];
const NODE_TYPES = ["module", "class", "interface", "function", "service", "data"];
const RISK_LEVELS = ["low", "medium", "high", "critical"];
const ACCEPTANCE_STATUSES = ["pass", "incomplete", "review_required"];
const ACCEPTANCE_MODULE_STATUSES = [
  "matched", "drifted", "review_required", "missing", "unapproved", "incomplete"
];

function incompatible(path, message) {
  throw new Error(`计划数据不兼容：${path} ${message}`);
}

function requiredObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) incompatible(path, "必须是对象");
  return value;
}

function requiredArray(value, path, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) incompatible(path, "必须是数组");
  if (nonEmpty && value.length === 0) incompatible(path, "至少需要一项");
  return value;
}

function requiredString(value, path, { allowEmpty = false } = {}) {
  if (typeof value !== "string") incompatible(path, "必须是文字");
  if (!allowEmpty && value.trim().length === 0) incompatible(path, "不能为空");
  return value;
}

function requiredEnum(value, allowed, path) {
  if (!allowed.includes(value)) incompatible(path, `必须是 ${allowed.join(" / ")} 之一`);
  return value;
}

function optionalIsoDate(value, path, { required = false } = {}) {
  if (value === null || value === undefined) {
    if (required) incompatible(path, "必须是服务端生成的时间");
    return value;
  }
  requiredString(value, path);
  if (Number.isNaN(Date.parse(value))) incompatible(path, "必须是 ISO-8601 时间");
  return value;
}

function uniqueId(value, path, ids) {
  requiredString(value, path);
  if (ids.has(value)) incompatible(path, `不能重复：${value}`);
  ids.add(value);
}

function validateApproval(approval, path, { requireUpdatedAt = false } = {}) {
  requiredObject(approval, path);
  requiredEnum(approval.decision, APPROVAL_DECISIONS, `${path}.decision`);
  requiredString(approval.comment, `${path}.comment`, { allowEmpty: true });
  if (approval.decision === "changes_requested" && !approval.comment.trim()) {
    incompatible(`${path}.comment`, "要求调整时必须说明原因");
  }
  optionalIsoDate(approval.updatedAt, `${path}.updatedAt`, { required: requireUpdatedAt });
}

function validateEntryPoint(entryPoint, path) {
  requiredObject(entryPoint, path);
  requiredString(entryPoint.signature, `${path}.signature`);
  requiredString(entryPoint.file, `${path}.file`);
  if (entryPoint.line !== undefined &&
      (!Number.isInteger(entryPoint.line) || entryPoint.line < 1)) {
    incompatible(`${path}.line`, "必须是正整数");
  }
}

function validateDiagram(diagram, path) {
  requiredObject(diagram, path);
  const nodeIds = new Set();
  requiredArray(diagram.nodes, `${path}.nodes`, { nonEmpty: true }).forEach((node, index) => {
    const nodePath = `${path}.nodes[${index}]`;
    requiredObject(node, nodePath);
    uniqueId(node.id, `${nodePath}.id`, nodeIds);
    requiredString(node.label, `${nodePath}.label`);
    requiredEnum(node.type, NODE_TYPES, `${nodePath}.type`);
    requiredEnum(node.status, CHANGE_STATUSES, `${nodePath}.status`);
    if (node.description !== undefined) {
      requiredString(node.description, `${nodePath}.description`, { allowEmpty: true });
    }
  });

  requiredArray(diagram.edges, `${path}.edges`).forEach((edge, index) => {
    const edgePath = `${path}.edges[${index}]`;
    requiredObject(edge, edgePath);
    requiredString(edge.from, `${edgePath}.from`);
    requiredString(edge.to, `${edgePath}.to`);
    if (!nodeIds.has(edge.from)) incompatible(`${edgePath}.from`, "必须引用本图节点");
    if (!nodeIds.has(edge.to)) incompatible(`${edgePath}.to`, "必须引用本图节点");
    if (edge.label !== undefined) {
      requiredString(edge.label, `${edgePath}.label`, { allowEmpty: true });
    }
    if (edge.status !== undefined) requiredEnum(edge.status, CHANGE_STATUSES, `${edgePath}.status`);
  });
}

function validateChange(change, path) {
  requiredObject(change, path);
  requiredString(change.id, `${path}.id`);
  requiredString(change.title, `${path}.title`);
  requiredEnum(change.status, CHANGE_STATUSES, `${path}.status`);
  requiredString(change.rationale, `${path}.rationale`);

  requiredObject(change.location, `${path}.location`);
  requiredString(change.location.file, `${path}.location.file`);
  requiredString(change.location.symbol, `${path}.location.symbol`);

  requiredArray(change.callPath, `${path}.callPath`, { nonEmpty: true }).forEach((step, index) => {
    const stepPath = `${path}.callPath[${index}]`;
    requiredObject(step, stepPath);
    requiredString(step.label, `${stepPath}.label`);
    requiredEnum(step.status, CHANGE_STATUSES, `${stepPath}.status`);
    if (step.collapsedCount !== undefined &&
        (!Number.isInteger(step.collapsedCount) || step.collapsedCount < 1)) {
      incompatible(`${stepPath}.collapsedCount`, "必须是正整数");
    }
  });

  requiredObject(change.pseudocode, `${path}.pseudocode`);
  requiredString(change.pseudocode.language, `${path}.pseudocode.language`);
  requiredString(change.pseudocode.before, `${path}.pseudocode.before`, { allowEmpty: true });
  requiredString(change.pseudocode.after, `${path}.pseudocode.after`, { allowEmpty: true });

  if (change.dependencies !== undefined) {
    requiredArray(change.dependencies, `${path}.dependencies`).forEach((dependency, index) => {
      const dependencyPath = `${path}.dependencies[${index}]`;
      requiredObject(dependency, dependencyPath);
      requiredEnum(dependency.kind, ["include"], `${dependencyPath}.kind`);
      requiredString(dependency.from, `${dependencyPath}.from`);
      requiredString(dependency.to, `${dependencyPath}.to`);
      requiredEnum(dependency.status, CHANGE_STATUSES, `${dependencyPath}.status`);
    });
  }
}

function validateModule(module, index, moduleIds) {
  const path = `modules[${index}]`;
  requiredObject(module, path);
  uniqueId(module.id, `${path}.id`, moduleIds);
  requiredString(module.name, `${path}.name`);
  if (!Number.isInteger(module.order) || module.order < 1) incompatible(`${path}.order`, "必须是正整数");
  requiredEnum(module.status, CHANGE_STATUSES, `${path}.status`);
  requiredString(module.layer, `${path}.layer`);
  requiredString(module.summary, `${path}.summary`);
  requiredArray(module.entryPoints, `${path}.entryPoints`, { nonEmpty: true })
    .forEach((entryPoint, entryIndex) => validateEntryPoint(
      entryPoint,
      `${path}.entryPoints[${entryIndex}]`
    ));
  validateDiagram(module.diagram, `${path}.diagram`);

  const changeIds = new Set();
  requiredArray(module.changes, `${path}.changes`, { nonEmpty: true }).forEach((change, index) => {
    validateChange(change, `${path}.changes[${index}]`);
    uniqueId(change.id, `${path}.changes[${index}].id`, changeIds);
  });
  validateApproval(module.approval, `${path}.approval`);
}

function validateModuleReferences(items, path, moduleIds, { nonEmpty = false } = {}) {
  requiredArray(items, path, { nonEmpty }).forEach((moduleId, index) => {
    requiredString(moduleId, `${path}[${index}]`);
    if (!moduleIds.has(moduleId)) incompatible(`${path}[${index}]`, "必须引用已存在的模块");
  });
}

function validatePlan(raw) {
  requiredObject(raw, "plan");
  if (raw.schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new Error(`计划版本不兼容：页面支持 ${PLAN_SCHEMA_VERSION}，收到 ${String(raw.schemaVersion)}`);
  }
  if (raw.kind !== PLAN_KIND) throw new Error(`计划类型不兼容：需要 ${PLAN_KIND}`);
  requiredString(raw.id, "id");
  requiredString(raw.title, "title");
  requiredEnum(raw.status, PLAN_STATUSES, "status");
  optionalIsoDate(raw.createdAt, "createdAt", { required: true });
  requiredObject(raw.project, "project");
  requiredString(raw.project.name, "project.name");
  requiredString(raw.project.repository, "project.repository");
  requiredString(raw.project.baseRef, "project.baseRef");
  requiredString(raw.goal, "goal");
  requiredString(raw.summary, "summary");

  const moduleIds = new Set();
  requiredArray(raw.modules, "modules", { nonEmpty: true })
    .forEach((module, index) => validateModule(module, index, moduleIds));
  requiredArray(raw.relationships, "relationships").forEach((relationship, index) => {
    const path = `relationships[${index}]`;
    requiredObject(relationship, path);
    requiredString(relationship.from, `${path}.from`);
    requiredString(relationship.to, `${path}.to`);
    if (!moduleIds.has(relationship.from)) incompatible(`${path}.from`, "必须引用已存在的模块");
    if (!moduleIds.has(relationship.to)) incompatible(`${path}.to`, "必须引用已存在的模块");
    requiredString(relationship.label, `${path}.label`);
    requiredEnum(relationship.status, CHANGE_STATUSES, `${path}.status`);
    requiredString(relationship.summary, `${path}.summary`);
  });
  requiredArray(raw.risks, "risks").forEach((risk, index) => {
    const path = `risks[${index}]`;
    requiredObject(risk, path);
    requiredString(risk.id, `${path}.id`);
    requiredEnum(risk.level, RISK_LEVELS, `${path}.level`);
    requiredString(risk.title, `${path}.title`);
    requiredString(risk.mitigation, `${path}.mitigation`);
    validateModuleReferences(risk.moduleIds, `${path}.moduleIds`, moduleIds, { nonEmpty: true });
  });
  requiredArray(raw.verification, "verification", { nonEmpty: true }).forEach((check, index) => {
    const path = `verification[${index}]`;
    requiredObject(check, path);
    requiredString(check.id, `${path}.id`);
    requiredString(check.type, `${path}.type`);
    requiredString(check.command, `${path}.command`);
    requiredString(check.expected, `${path}.expected`);
    validateModuleReferences(check.moduleIds, `${path}.moduleIds`, moduleIds);
  });
}

export function reviewIdFromSearch(search) {
  const candidate = new URLSearchParams(search).get("review");
  return candidate && candidate.trim() ? candidate.trim() : DEFAULT_REVIEW_ID;
}

export function normalizeReview(raw) {
  validatePlan(raw);
  const normalized = structuredClone(raw);
  normalized.modules.sort((left, right) => left.order - right.order);
  return normalized;
}

export function normalizeDecisionResponse(raw, { expectedReviewId, expectedModuleId } = {}) {
  requiredObject(raw, "decisionResponse");
  requiredString(raw.reviewId, "decisionResponse.reviewId");
  requiredString(raw.moduleId, "decisionResponse.moduleId");
  if (expectedReviewId !== undefined && raw.reviewId !== expectedReviewId) {
    incompatible("decisionResponse.reviewId", "与当前计划不一致");
  }
  if (expectedModuleId !== undefined && raw.moduleId !== expectedModuleId) {
    incompatible("decisionResponse.moduleId", "与当前模块不一致");
  }
  validateApproval(raw.approval, "decisionResponse.approval", { requireUpdatedAt: true });
  requiredEnum(raw.reviewStatus, PLAN_STATUSES, "decisionResponse.reviewStatus");
  if (!Number.isInteger(raw.revision) || raw.revision < 1) {
    incompatible("decisionResponse.revision", "必须是当前计划的正整数版本");
  }
  return structuredClone(raw);
}

function requiredNonNegativeInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) incompatible(path, "必须是非负整数");
}

export function normalizeAcceptanceResponse(raw, {
  expectedReviewId,
  expectedModuleIds
} = {}) {
  requiredObject(raw, "acceptanceResponse");
  requiredString(raw.reviewId, "acceptanceResponse.reviewId");
  if (expectedReviewId !== undefined && raw.reviewId !== expectedReviewId) {
    incompatible("acceptanceResponse.reviewId", "与当前计划不一致");
  }
  if (raw.acceptance === null) return { reviewId: raw.reviewId, acceptance: null };
  const record = requiredObject(raw.acceptance, "acceptanceResponse.acceptance");
  if (record.schemaVersion !== "1.0.0" || record.kind !== "IntentCanvasAcceptanceRecord") {
    incompatible("acceptanceResponse.acceptance", "不是受支持的验收报告");
  }
  if (record.reviewId !== raw.reviewId) {
    incompatible("acceptanceResponse.acceptance.reviewId", "与当前计划不一致");
  }
  if (!Number.isInteger(record.approvedRevision) || record.approvedRevision < 1) {
    incompatible("acceptanceResponse.acceptance.approvedRevision", "必须是正整数版本");
  }
  optionalIsoDate(record.generatedAt, "acceptanceResponse.acceptance.generatedAt", {
    required: true
  });
  requiredEnum(record.sourceKind, ["model", "facts"], "acceptanceResponse.acceptance.sourceKind");
  requiredEnum(record.status, ACCEPTANCE_STATUSES, "acceptanceResponse.acceptance.status");
  const summary = requiredObject(record.summary, "acceptanceResponse.acceptance.summary");
  for (const key of [
    "totalFindings", "errors", "warnings", "plannedChanges", "satisfied",
    "incomplete", "unapproved", "evidenceIssues"
  ]) {
    requiredNonNegativeInteger(summary[key], `acceptanceResponse.acceptance.summary.${key}`);
  }
  const moduleIds = expectedModuleIds === undefined ? null : new Set(expectedModuleIds);
  requiredArray(record.modules, "acceptanceResponse.acceptance.modules").forEach((module, index) => {
    const path = `acceptanceResponse.acceptance.modules[${index}]`;
    requiredObject(module, path);
    requiredString(module.moduleId, `${path}.moduleId`);
    requiredString(module.name, `${path}.name`);
    requiredEnum(module.status, ACCEPTANCE_MODULE_STATUSES, `${path}.status`);
    if (moduleIds && !moduleIds.has(module.moduleId)) incompatible(`${path}.moduleId`, "不是当前计划模块");
    for (const key of ["plannedChanges", "satisfied", "findingCount"]) {
      requiredNonNegativeInteger(module[key], `${path}.${key}`);
    }
  });
  requiredArray(record.findings, "acceptanceResponse.acceptance.findings").forEach((item, index) => {
    const path = `acceptanceResponse.acceptance.findings[${index}]`;
    requiredObject(item, path);
    requiredString(item.code, `${path}.code`);
    requiredString(item.category, `${path}.category`);
    requiredEnum(item.severity, ["error", "warning"], `${path}.severity`);
    requiredString(item.path, `${path}.path`);
    requiredString(item.message, `${path}.message`);
    if (item.moduleId !== null) {
      requiredString(item.moduleId, `${path}.moduleId`);
      if (moduleIds && !moduleIds.has(item.moduleId)) incompatible(`${path}.moduleId`, "不是当前计划模块");
    }
  });
  requiredNonNegativeInteger(
    record.truncatedFindings,
    "acceptanceResponse.acceptance.truncatedFindings"
  );
  return structuredClone(raw);
}
