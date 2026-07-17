import { createHash } from "node:crypto";

import { assertPlanModel } from "@intentcanvas/protocol";

export {
  CODE_FACTS_DIFF_KIND,
  CODE_FACTS_DIFF_SCHEMA_VERSION,
  FACTS_AUDIT_KIND,
  FACTS_AUDIT_SCHEMA_VERSION,
  auditPlanAgainstCodeFacts,
  codeFactsDigest,
  compareCodeFacts,
  formatFactsAuditMarkdown,
  semanticSymbolIdentity
} from "./facts-diff.js";

export const DRIFT_REPORT_SCHEMA_VERSION = "1.0.0";
export const DRIFT_REPORT_KIND = "IntentCanvasDriftReport";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function modelDigest(model) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(model)))
    .digest("hex");
}

function compact(value) {
  if (value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  return canonicalize(value);
}

function finding(code, severity, path, message, planned, actual) {
  return {
    code,
    severity,
    path,
    message,
    planned: compact(planned),
    actual: compact(actual)
  };
}

function mapBy(values, key) {
  return new Map(values.map((value) => [key(value), value]));
}

function same(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function entryPointKey(entryPoint) {
  return `${entryPoint.file}\u0000${entryPoint.signature}`;
}

function changeShape(change) {
  return {
    status: change.status,
    location: change.location,
    callPath: change.callPath.map((step) => ({
      label: step.label,
      status: step.status,
      collapsedCount: step.collapsedCount ?? null
    }))
  };
}

function nodeShape(node) {
  return { type: node.type, status: node.status, label: node.label };
}

function edgeKey(edge) {
  return `${edge.from}\u0000${edge.to}\u0000${edge.label ?? ""}`;
}

function edgeShape(edge) {
  return { status: edge.status ?? "unchanged" };
}

function compareKeyed({
  planned,
  actual,
  key,
  shape,
  path,
  missingCode,
  extraCode,
  mismatchCode,
  label
}) {
  const findings = [];
  const plannedMap = mapBy(planned, key);
  const actualMap = mapBy(actual, key);

  for (const [id, plannedValue] of plannedMap) {
    const actualValue = actualMap.get(id);
    if (!actualValue) {
      findings.push(finding(
        missingCode,
        "error",
        `${path}/${encodeURIComponent(id)}`,
        `Planned ${label} is missing from the implemented model`,
        shape(plannedValue),
        null
      ));
    } else if (!same(shape(plannedValue), shape(actualValue))) {
      findings.push(finding(
        mismatchCode,
        "error",
        `${path}/${encodeURIComponent(id)}`,
        `Implemented ${label} differs from the approved plan`,
        shape(plannedValue),
        shape(actualValue)
      ));
    }
  }

  for (const [id, actualValue] of actualMap) {
    if (!plannedMap.has(id)) {
      findings.push(finding(
        extraCode,
        "warning",
        `${path}/${encodeURIComponent(id)}`,
        `Implemented model contains an unapproved ${label}`,
        null,
        shape(actualValue)
      ));
    }
  }
  return findings;
}

function compareModule(plannedModule, actualModule) {
  const path = `/modules/${encodeURIComponent(plannedModule.id)}`;
  const findings = [];

  if (plannedModule.status !== actualModule.status) {
    findings.push(finding(
      "module_status_mismatch",
      "error",
      `${path}/status`,
      "Implemented module change status differs from the approved plan",
      plannedModule.status,
      actualModule.status
    ));
  }

  findings.push(...compareKeyed({
    planned: plannedModule.entryPoints,
    actual: actualModule.entryPoints,
    key: entryPointKey,
    shape: (entryPoint) => ({
      file: entryPoint.file,
      signature: entryPoint.signature,
      line: entryPoint.line ?? null
    }),
    path: `${path}/entryPoints`,
    missingCode: "entry_point_missing",
    extraCode: "unapproved_entry_point",
    mismatchCode: "entry_point_mismatch",
    label: "entry point"
  }));

  findings.push(...compareKeyed({
    planned: plannedModule.changes,
    actual: actualModule.changes,
    key: (change) => change.id,
    shape: changeShape,
    path: `${path}/changes`,
    missingCode: "planned_change_missing",
    extraCode: "unapproved_change",
    mismatchCode: "change_shape_mismatch",
    label: "change"
  }));

  findings.push(...compareKeyed({
    planned: plannedModule.diagram.nodes,
    actual: actualModule.diagram.nodes,
    key: (node) => node.id,
    shape: nodeShape,
    path: `${path}/diagram/nodes`,
    missingCode: "diagram_node_missing",
    extraCode: "unapproved_diagram_node",
    mismatchCode: "diagram_node_mismatch",
    label: "diagram node"
  }));

  findings.push(...compareKeyed({
    planned: plannedModule.diagram.edges,
    actual: actualModule.diagram.edges,
    key: edgeKey,
    shape: edgeShape,
    path: `${path}/diagram/edges`,
    missingCode: "diagram_edge_missing",
    extraCode: "unapproved_diagram_edge",
    mismatchCode: "diagram_edge_mismatch",
    label: "diagram edge"
  }));

  return {
    moduleId: plannedModule.id,
    name: plannedModule.name,
    plannedStatus: plannedModule.status,
    actualStatus: actualModule.status,
    status: findings.length === 0
      ? "matched"
      : findings.some((item) => item.severity === "error") ? "drifted" : "review_required",
    findings
  };
}

function relationshipKey(relationship) {
  return `${relationship.from}\u0000${relationship.to}\u0000${relationship.label}`;
}

function determineStatus(findings) {
  if (findings.length === 0) return "pass";
  const missing = findings.some((item) => [
    "planned_module_missing",
    "planned_change_missing",
    "entry_point_missing",
    "diagram_node_missing",
    "diagram_edge_missing",
    "planned_relationship_missing"
  ].includes(item.code));
  const unapproved = findings.some((item) => item.code.startsWith("unapproved_"));
  return unapproved ? "review_required" : missing ? "incomplete" : "review_required";
}

export function comparePlanModels(approvedPlan, implementedModel, {
  now = () => new Date()
} = {}) {
  assertPlanModel(approvedPlan);
  assertPlanModel(implementedModel);
  if (approvedPlan.status !== "approved") {
    throw new TypeError("Approved Plan Model must have status approved");
  }
  if (!approvedPlan.modules.every((module) => module.approval.decision === "approved")) {
    throw new TypeError("Every module in the Approved Plan Model must be approved");
  }
  if (approvedPlan.id !== implementedModel.id) {
    throw new TypeError("Implemented Model id must match the Approved Plan Model id");
  }

  const plannedModules = mapBy(approvedPlan.modules, (module) => module.id);
  const actualModules = mapBy(implementedModel.modules, (module) => module.id);
  const modules = [];
  const topLevelFindings = [];

  for (const [moduleId, plannedModule] of plannedModules) {
    const actualModule = actualModules.get(moduleId);
    if (!actualModule) {
      const item = finding(
        "planned_module_missing",
        "error",
        `/modules/${encodeURIComponent(moduleId)}`,
        "Planned module is missing from the implemented model",
        { id: moduleId, status: plannedModule.status },
        null
      );
      modules.push({
        moduleId,
        name: plannedModule.name,
        plannedStatus: plannedModule.status,
        actualStatus: null,
        status: "missing",
        findings: [item]
      });
    } else {
      modules.push(compareModule(plannedModule, actualModule));
    }
  }

  for (const [moduleId, actualModule] of actualModules) {
    if (plannedModules.has(moduleId)) continue;
    const item = finding(
      "unapproved_module",
      "warning",
      `/modules/${encodeURIComponent(moduleId)}`,
      "Implemented model contains a module outside the approved scope",
      null,
      { id: moduleId, status: actualModule.status }
    );
    modules.push({
      moduleId,
      name: actualModule.name,
      plannedStatus: null,
      actualStatus: actualModule.status,
      status: "unapproved",
      findings: [item]
    });
  }

  topLevelFindings.push(...compareKeyed({
    planned: approvedPlan.relationships,
    actual: implementedModel.relationships,
    key: relationshipKey,
    shape: (relationship) => ({ status: relationship.status }),
    path: "/relationships",
    missingCode: "planned_relationship_missing",
    extraCode: "unapproved_relationship",
    mismatchCode: "relationship_mismatch",
    label: "module relationship"
  }));

  const findings = [
    ...modules.flatMap((module) => module.findings),
    ...topLevelFindings
  ];
  const counts = findings.reduce((summary, item) => {
    summary.total += 1;
    summary[item.severity] += 1;
    if (item.code.startsWith("unapproved_")) summary.unapproved += 1;
    else if (item.code.includes("missing")) summary.missing += 1;
    else summary.mismatched += 1;
    return summary;
  }, { total: 0, error: 0, warning: 0, missing: 0, unapproved: 0, mismatched: 0 });

  return {
    schemaVersion: DRIFT_REPORT_SCHEMA_VERSION,
    kind: DRIFT_REPORT_KIND,
    reviewId: approvedPlan.id,
    generatedAt: now().toISOString(),
    status: determineStatus(findings),
    approvedDigest: modelDigest(approvedPlan),
    implementedDigest: modelDigest(implementedModel),
    summary: counts,
    modules,
    findings: topLevelFindings
  };
}

export function formatDriftReportMarkdown(report) {
  if (!report || report.kind !== DRIFT_REPORT_KIND) {
    throw new TypeError("Expected an IntentCanvas Drift Report");
  }
  const lines = [
    `# IntentCanvas implementation review: ${report.reviewId}`,
    "",
    `**Result:** ${report.status}`,
    `**Findings:** ${report.summary.total} (${report.summary.error} errors, ${report.summary.warning} warnings)`,
    ""
  ];

  for (const module of report.modules) {
    lines.push(`## ${module.name} — ${module.status}`, "");
    if (module.findings.length === 0) {
      lines.push("- Matches the approved plan.", "");
      continue;
    }
    for (const item of module.findings) {
      lines.push(`- **${item.severity}:** ${item.message} (${item.path})`);
    }
    lines.push("");
  }

  if (report.findings.length > 0) {
    lines.push("## Cross-module drift", "");
    for (const item of report.findings) {
      lines.push(`- **${item.severity}:** ${item.message} (${item.path})`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
