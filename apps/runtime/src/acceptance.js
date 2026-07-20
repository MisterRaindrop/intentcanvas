import {
  DRIFT_REPORT_KIND,
  FACTS_AUDIT_KIND,
  auditPlanAgainstCodeFacts,
  comparePlanModels
} from "@intentcanvas/plan-diff";

export const ACCEPTANCE_RECORD_KIND = "IntentCanvasAcceptanceRecord";
export const ACCEPTANCE_RECORD_SCHEMA_VERSION = "1.0.0";
export const MAX_ACCEPTANCE_FINDINGS = 250;

const STATUSES = new Set(["pass", "incomplete", "review_required"]);
const ASSURANCE_LEVELS = new Set(["declared_model", "structural_code_facts"]);
const MODULE_STATUSES = new Set([
  "matched",
  "drifted",
  "review_required",
  "missing",
  "unapproved",
  "incomplete"
]);

function timestampFrom(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("now must return a valid Date");
  }
  return value.toISOString();
}

function moduleIdFromPath(path) {
  if (typeof path !== "string") return null;
  const match = /^\/modules\/([^/]+)/u.exec(path);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function findingView(item, suppliedModuleId) {
  return {
    code: String(item.code),
    category: String(item.category ?? "drift"),
    severity: item.severity === "warning" ? "warning" : "error",
    path: String(item.path ?? "/"),
    message: String(item.message),
    moduleId: suppliedModuleId ?? moduleIdFromPath(item.path)
  };
}

function summarizeFindings(findings) {
  return {
    totalFindings: findings.length,
    errors: findings.filter((item) => item.severity === "error").length,
    warnings: findings.filter((item) => item.severity === "warning").length
  };
}

function compactModelReport(snapshot, report) {
  const planModules = new Map(snapshot.plan.modules.map((module) => [module.id, module]));
  const modules = report.modules.map((module) => {
    const plannedChanges = planModules.get(module.moduleId)?.changes.length ?? 0;
    const findings = module.findings.map((item) => findingView(item, module.moduleId));
    return {
      moduleId: module.moduleId,
      name: module.name,
      status: module.status,
      plannedChanges,
      satisfied: findings.length === 0 ? plannedChanges : 0,
      findingCount: findings.length
    };
  });
  const findings = [
    ...report.modules.flatMap((module) => (
      module.findings.map((item) => findingView(item, module.moduleId))
    )),
    ...report.findings.map((item) => findingView(item, null))
  ];
  return {
    modules,
    findings,
    summary: {
      ...summarizeFindings(findings),
      plannedChanges: snapshot.plan.modules.reduce(
        (total, module) => total + module.changes.length,
        0
      ),
      satisfied: modules.reduce((total, module) => total + module.satisfied, 0),
      incomplete: report.summary.missing + report.summary.mismatched,
      unapproved: report.summary.unapproved,
      evidenceIssues: 0
    },
    digests: {
      approved: report.approvedDigest,
      implemented: report.implementedDigest
    }
  };
}

function compactFactsReport(snapshot, report) {
  const findingViews = report.findings.map((item) => findingView(item));
  const modules = snapshot.plan.modules.map((module) => {
    const planned = report.plannedChanges.filter((change) => change.moduleId === module.id);
    const findings = findingViews.filter((item) => item.moduleId === module.id);
    const satisfied = planned.filter((change) => change.status === "satisfied").length;
    const status = findings.some((item) => item.category === "unapproved")
      ? "review_required"
      : findings.length > 0 || satisfied !== planned.length ? "incomplete" : "matched";
    return {
      moduleId: module.id,
      name: module.name,
      status,
      plannedChanges: planned.length,
      satisfied,
      findingCount: findings.length
    };
  });
  return {
    modules,
    findings: findingViews,
    summary: {
      ...summarizeFindings(findingViews),
      plannedChanges: report.summary.plannedChanges,
      satisfied: report.summary.satisfied,
      incomplete: report.summary.incomplete,
      unapproved: report.summary.unapproved,
      evidenceIssues: report.summary.evidenceIssues
    },
    digests: {
      approved: report.approvedDigest,
      current: report.currentFactsDigest,
      implemented: report.implementedFactsDigest
    }
  };
}

export function createAcceptanceRecord(snapshot, input, {
  now = () => new Date()
} = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Acceptance evidence must be an object");
  }
  let report;
  let compact;
  if (input.mode === "model" && Object.keys(input).every((key) => ["mode", "implemented"].includes(key))) {
    report = comparePlanModels(snapshot, input.implemented, { now });
    compact = compactModelReport(snapshot, report);
  } else if (input.mode === "facts" &&
      Object.keys(input).every((key) => ["mode", "current", "implemented"].includes(key))) {
    report = auditPlanAgainstCodeFacts(snapshot, input.current, input.implemented, { now });
    compact = compactFactsReport(snapshot, report);
  } else {
    throw new TypeError("Acceptance evidence must use mode model or facts with exact inputs");
  }

  const visibleFindings = compact.findings.slice(0, MAX_ACCEPTANCE_FINDINGS);
  return {
    schemaVersion: ACCEPTANCE_RECORD_SCHEMA_VERSION,
    kind: ACCEPTANCE_RECORD_KIND,
    reviewId: snapshot.reviewId,
    approvedRevision: snapshot.revision,
    generatedAt: timestampFrom(now),
    sourceKind: report.kind === DRIFT_REPORT_KIND ? "model" : "facts",
    reportKind: report.kind,
    status: report.status,
    summary: compact.summary,
    modules: compact.modules,
    findings: visibleFindings,
    truncatedFindings: compact.findings.length - visibleFindings.length,
    digests: compact.digests,
    assurance: report.kind === FACTS_AUDIT_KIND ? "structural_code_facts" : "declared_model"
  };
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validDigests(record) {
  if (record.digests === null || typeof record.digests !== "object" ||
      Array.isArray(record.digests) ||
      !/^sha256:[0-9a-f]{64}$/u.test(record.digests.approved)) {
    return false;
  }
  const expectedKeys = record.sourceKind === "model"
    ? ["approved", "implemented"]
    : ["approved", "current", "implemented"];
  return Object.keys(record.digests).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(record.digests, key)) &&
    expectedKeys.slice(1).every((key) => /^[0-9a-f]{64}$/u.test(record.digests[key]));
}

export function assertAcceptanceRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record) ||
      record.kind !== ACCEPTANCE_RECORD_KIND ||
      record.schemaVersion !== ACCEPTANCE_RECORD_SCHEMA_VERSION ||
      typeof record.reviewId !== "string" || record.reviewId.length === 0 ||
      !Number.isInteger(record.approvedRevision) || record.approvedRevision < 1 ||
      typeof record.generatedAt !== "string" || Number.isNaN(Date.parse(record.generatedAt)) ||
      !["model", "facts"].includes(record.sourceKind) ||
      ![DRIFT_REPORT_KIND, FACTS_AUDIT_KIND].includes(record.reportKind) ||
      !ASSURANCE_LEVELS.has(record.assurance) ||
      (record.sourceKind === "model" &&
        (record.reportKind !== DRIFT_REPORT_KIND || record.assurance !== "declared_model")) ||
      (record.sourceKind === "facts" &&
        (record.reportKind !== FACTS_AUDIT_KIND ||
          record.assurance !== "structural_code_facts")) ||
      !STATUSES.has(record.status) ||
      !Array.isArray(record.modules) || !Array.isArray(record.findings) ||
      record.findings.length > MAX_ACCEPTANCE_FINDINGS ||
      !nonNegativeInteger(record.truncatedFindings) || !validDigests(record)) {
    throw new TypeError("Invalid IntentCanvas acceptance record");
  }
  const summaryKeys = [
    "totalFindings", "errors", "warnings", "plannedChanges", "satisfied",
    "incomplete", "unapproved", "evidenceIssues"
  ];
  if (record.summary === null || typeof record.summary !== "object" ||
      summaryKeys.some((key) => !nonNegativeInteger(record.summary[key])) ||
      record.summary.totalFindings !== record.findings.length + record.truncatedFindings ||
      record.summary.errors + record.summary.warnings !== record.summary.totalFindings ||
      record.summary.satisfied > record.summary.plannedChanges ||
      record.modules.some((module) => (
        module === null || typeof module !== "object" ||
        typeof module.moduleId !== "string" || typeof module.name !== "string" ||
        !MODULE_STATUSES.has(module.status) ||
        !nonNegativeInteger(module.plannedChanges) ||
        !nonNegativeInteger(module.satisfied) ||
        !nonNegativeInteger(module.findingCount)
      )) || record.findings.some((item) => (
        item === null || typeof item !== "object" ||
        typeof item.code !== "string" || typeof item.category !== "string" ||
        !["error", "warning"].includes(item.severity) ||
        typeof item.path !== "string" || typeof item.message !== "string" ||
        !(item.moduleId === null || typeof item.moduleId === "string")
      ))) {
    throw new TypeError("Invalid IntentCanvas acceptance record details");
  }
  return structuredClone(record);
}
