import { createHash } from "node:crypto";

import { assertCodeFacts, assertPlanModel } from "@intentcanvas/protocol";

export const CODE_FACTS_DIFF_SCHEMA_VERSION = "1.0.0";
export const CODE_FACTS_DIFF_KIND = "IntentCanvasCodeFactsDiff";
export const FACTS_AUDIT_SCHEMA_VERSION = "1.0.0";
export const FACTS_AUDIT_KIND = "IntentCanvasFactsAuditReport";

const CONFIDENCE_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });
const CHANGE_KINDS = Object.freeze(["added", "removed", "modified", "unchanged"]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function canonicalString(value) {
  return JSON.stringify(canonicalize(value));
}

function same(left, right) {
  return canonicalString(left) === canonicalString(right);
}

function hash(value) {
  return createHash("sha256").update(canonicalString(value)).digest("hex");
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), "en");
}

function sortByIdentity(values) {
  return [...values].sort((left, right) => {
    const identity = compareText(left.identity, right.identity);
    if (identity !== 0) return identity;
    return compareText(canonicalString(left), canonicalString(right));
  });
}

function minimumConfidence(...values) {
  const known = values.filter((value) => value in CONFIDENCE_RANK);
  if (known.length === 0) return "low";
  return known.reduce((minimum, value) => (
    CONFIDENCE_RANK[value] < CONFIDENCE_RANK[minimum] ? value : minimum
  ), known[0]);
}

function sourceShape(source) {
  if (!source) return null;
  return {
    tool: source.tool,
    version: source.version ?? null,
    path: source.path ?? null
  };
}

function evidenceShape(value, fallbackConfidence) {
  if (!value) return null;
  return {
    confidence: value.confidence ?? fallbackConfidence ?? "low",
    source: sourceShape(value.source),
    fingerprint: value.fingerprint ?? null
  };
}

function normalizeSignature(value) {
  return String(value ?? "").replace(/\s+/gu, "").trim();
}

function symbolDisplayName(symbol) {
  return symbol.qualifiedName ?? symbol.name;
}

/**
 * A symbol's extractor ID is deliberately excluded. Some extractors derive it
 * from traversal order or a version-specific AST identity. The source path,
 * kind, semantic name, and signature form the review identity instead.
 */
export function semanticSymbolIdentity(symbol) {
  return [
    symbol.file,
    symbol.kind,
    symbolDisplayName(symbol),
    normalizeSignature(symbol.signature)
  ].join("\u0000");
}

function fileComparable(file) {
  return {
    language: file.language,
    generated: file.generated ?? false,
    fingerprint: file.fingerprint ?? null
  };
}

function fileView(file) {
  if (!file) return null;
  return {
    path: file.path,
    language: file.language,
    generated: file.generated ?? false,
    fingerprint: file.fingerprint ?? null,
    confidence: file.confidence,
    source: sourceShape(file.source)
  };
}

function symbolComparable(symbol) {
  return {
    file: symbol.file,
    kind: symbol.kind,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName ?? null,
    signature: normalizeSignature(symbol.signature),
    fingerprint: symbol.fingerprint ?? null
  };
}

function symbolView(symbol) {
  if (!symbol) return null;
  return {
    file: symbol.file,
    kind: symbol.kind,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName ?? null,
    signature: symbol.signature ?? null,
    fingerprint: symbol.fingerprint ?? null,
    confidence: symbol.confidence,
    source: sourceShape(symbol.source)
  };
}

function groupBy(values, identity) {
  const groups = new Map();
  for (const value of values) {
    const key = identity(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => compareText(canonicalString(left), canonicalString(right)));
  }
  return groups;
}

function changeEvidence(kind, before, after, currentConfidence, implementedConfidence) {
  const beforeEvidence = evidenceShape(before, currentConfidence);
  const afterEvidence = evidenceShape(after, implementedConfidence);
  const confidence = kind === "added"
    ? minimumConfidence(afterEvidence?.confidence, currentConfidence)
    : kind === "removed"
      ? minimumConfidence(beforeEvidence?.confidence, implementedConfidence)
      : minimumConfidence(beforeEvidence?.confidence, afterEvidence?.confidence);
  const fingerprints = [beforeEvidence?.fingerprint, afterEvidence?.fingerprint].filter(Boolean);
  return {
    confidence,
    status: confidence === "low" || ((kind === "modified" || kind === "unchanged") && fingerprints.length < 2)
      ? "insufficient"
      : "supported",
    before: beforeEvidence,
    after: afterEvidence
  };
}

function makeChange(kind, identity, before, after, view, currentConfidence, implementedConfidence) {
  return {
    identity,
    before: view(before),
    after: view(after),
    evidence: changeEvidence(kind, before, after, currentConfidence, implementedConfidence)
  };
}

function diffGroupedEntities({
  current,
  implemented,
  identity,
  comparable,
  view,
  currentConfidence,
  implementedConfidence
}) {
  const result = Object.fromEntries(CHANGE_KINDS.map((kind) => [kind, []]));
  const currentGroups = groupBy(current, identity);
  const implementedGroups = groupBy(implemented, identity);
  const keys = [...new Set([...currentGroups.keys(), ...implementedGroups.keys()])].sort(compareText);

  for (const key of keys) {
    const before = [...(currentGroups.get(key) ?? [])];
    const after = [...(implementedGroups.get(key) ?? [])];
    const matchedBefore = new Set();
    const matchedAfter = new Set();

    for (let beforeIndex = 0; beforeIndex < before.length; beforeIndex += 1) {
      const matchingAfter = after.findIndex((candidate, afterIndex) => (
        !matchedAfter.has(afterIndex) && same(comparable(before[beforeIndex]), comparable(candidate))
      ));
      if (matchingAfter < 0) continue;
      matchedBefore.add(beforeIndex);
      matchedAfter.add(matchingAfter);
      result.unchanged.push(makeChange(
        "unchanged",
        key,
        before[beforeIndex],
        after[matchingAfter],
        view,
        currentConfidence,
        implementedConfidence
      ));
    }

    const remainingBefore = before.filter((_, index) => !matchedBefore.has(index));
    const remainingAfter = after.filter((_, index) => !matchedAfter.has(index));
    const paired = Math.min(remainingBefore.length, remainingAfter.length);

    for (let index = 0; index < paired; index += 1) {
      result.modified.push(makeChange(
        "modified",
        key,
        remainingBefore[index],
        remainingAfter[index],
        view,
        currentConfidence,
        implementedConfidence
      ));
    }
    for (const value of remainingBefore.slice(paired)) {
      result.removed.push(makeChange(
        "removed", key, value, null, view, currentConfidence, implementedConfidence
      ));
    }
    for (const value of remainingAfter.slice(paired)) {
      result.added.push(makeChange(
        "added", key, null, value, view, currentConfidence, implementedConfidence
      ));
    }
  }

  return Object.fromEntries(
    CHANGE_KINDS.map((kind) => [kind, sortByIdentity(result[kind])])
  );
}

function symbolLookup(facts) {
  return new Map(facts.symbols.map((symbol) => [symbol.id, semanticSymbolIdentity(symbol)]));
}

function aggregateEdges(edges, identity, endpointView) {
  const groups = new Map();
  for (const edge of edges) {
    const key = identity(edge);
    const existing = groups.get(key) ?? {
      identity: key,
      ...endpointView(edge),
      count: 0,
      confidence: edge.confidence,
      sources: []
    };
    existing.count += 1;
    existing.confidence = minimumConfidence(existing.confidence, edge.confidence);
    existing.sources.push(sourceShape(edge.source));
    groups.set(key, existing);
  }
  return [...groups.values()].map((edge) => ({
    ...edge,
    sources: [...new Map(edge.sources.map((source) => [canonicalString(source), source])).values()]
      .sort((left, right) => compareText(canonicalString(left), canonicalString(right)))
  }));
}

function edgeComparable(edge) {
  return { count: edge.count };
}

function edgeView(edge) {
  if (!edge) return null;
  return {
    from: edge.from,
    to: edge.to,
    count: edge.count,
    confidence: edge.confidence,
    sources: edge.sources
  };
}

function diffAggregatedEdges(current, implemented, currentConfidence, implementedConfidence) {
  const result = Object.fromEntries(CHANGE_KINDS.map((kind) => [kind, []]));
  const before = new Map(current.map((edge) => [edge.identity, edge]));
  const after = new Map(implemented.map((edge) => [edge.identity, edge]));
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort(compareText);

  for (const identity of keys) {
    const left = before.get(identity);
    const right = after.get(identity);
    const kind = !left ? "added" : !right ? "removed" : same(edgeComparable(left), edgeComparable(right))
      ? "unchanged" : "modified";
    const evidence = changeEvidence(
      kind,
      left ? { confidence: left.confidence, source: left.sources[0], fingerprint: `count:${left.count}` } : null,
      right ? { confidence: right.confidence, source: right.sources[0], fingerprint: `count:${right.count}` } : null,
      currentConfidence,
      implementedConfidence
    );
    result[kind].push({
      identity,
      before: edgeView(left),
      after: edgeView(right),
      evidence
    });
  }
  return Object.fromEntries(CHANGE_KINDS.map((kind) => [kind, sortByIdentity(result[kind])]));
}

function summarizeChanges(changes) {
  return Object.fromEntries(CHANGE_KINDS.map((kind) => [kind, changes[kind].length]));
}

function diagnosticView(diagnostic) {
  return {
    severity: diagnostic.severity,
    code: diagnostic.code ?? null,
    message: diagnostic.message,
    file: diagnostic.file ?? diagnostic.location?.file ?? null,
    confidence: diagnostic.confidence,
    source: sourceShape(diagnostic.source)
  };
}

function sortedDiagnostics(diagnostics) {
  return diagnostics.map(diagnosticView).sort((left, right) => (
    compareText(canonicalString(left), canonicalString(right))
  ));
}

function normalizedFactsForDigest(facts) {
  const symbolsById = symbolLookup(facts);
  const includeEdges = aggregateEdges(
    facts.includeEdges,
    (edge) => `${edge.from}\u0000${edge.to}`,
    (edge) => ({ from: edge.from, to: edge.to })
  );
  const callEdges = aggregateEdges(
    facts.callEdges,
    (edge) => `${symbolsById.get(edge.from)}\u0000${symbolsById.get(edge.to)}`,
    (edge) => ({ from: symbolsById.get(edge.from), to: symbolsById.get(edge.to) })
  );
  return {
    project: {
      name: facts.project.name,
      compileCommands: facts.project.compileCommands ?? null,
      buildSystems: [...(facts.project.buildSystems ?? [])].sort((left, right) => (
        compareText(`${left.type}\u0000${left.path}`, `${right.type}\u0000${right.path}`)
      ))
    },
    files: [...facts.files].sort((left, right) => compareText(left.path, right.path))
      .map((file) => ({ identity: file.path, value: fileView(file) })),
    symbols: [...facts.symbols].sort((left, right) => (
      compareText(semanticSymbolIdentity(left), semanticSymbolIdentity(right)) ||
      compareText(canonicalString(symbolView(left)), canonicalString(symbolView(right)))
    )).map((symbol) => ({ identity: semanticSymbolIdentity(symbol), value: symbolView(symbol) })),
    includeEdges: includeEdges.sort((left, right) => compareText(left.identity, right.identity)),
    callEdges: callEdges.sort((left, right) => compareText(left.identity, right.identity)),
    diagnostics: sortedDiagnostics(facts.diagnostics),
    confidence: facts.confidence,
    source: sourceShape(facts.source)
  };
}

export function codeFactsDigest(facts) {
  assertCodeFacts(facts);
  return hash(normalizedFactsForDigest(facts));
}

/**
 * Produce a deterministic, semantic Code Facts delta. Source line movement and
 * extractor-generated symbol IDs do not create false changes.
 */
export function compareCodeFacts(currentFacts, implementedFacts) {
  assertCodeFacts(currentFacts);
  assertCodeFacts(implementedFacts);

  const files = diffGroupedEntities({
    current: currentFacts.files,
    implemented: implementedFacts.files,
    identity: (file) => file.path,
    comparable: fileComparable,
    view: fileView,
    currentConfidence: currentFacts.confidence,
    implementedConfidence: implementedFacts.confidence
  });
  const symbols = diffGroupedEntities({
    current: currentFacts.symbols,
    implemented: implementedFacts.symbols,
    identity: semanticSymbolIdentity,
    comparable: symbolComparable,
    view: symbolView,
    currentConfidence: currentFacts.confidence,
    implementedConfidence: implementedFacts.confidence
  });

  const currentSymbols = symbolLookup(currentFacts);
  const implementedSymbols = symbolLookup(implementedFacts);
  const currentIncludes = aggregateEdges(
    currentFacts.includeEdges,
    (edge) => `${edge.from}\u0000${edge.to}`,
    (edge) => ({ from: edge.from, to: edge.to })
  );
  const implementedIncludes = aggregateEdges(
    implementedFacts.includeEdges,
    (edge) => `${edge.from}\u0000${edge.to}`,
    (edge) => ({ from: edge.from, to: edge.to })
  );
  const currentCalls = aggregateEdges(
    currentFacts.callEdges,
    (edge) => `${currentSymbols.get(edge.from)}\u0000${currentSymbols.get(edge.to)}`,
    (edge) => ({ from: currentSymbols.get(edge.from), to: currentSymbols.get(edge.to) })
  );
  const implementedCalls = aggregateEdges(
    implementedFacts.callEdges,
    (edge) => `${implementedSymbols.get(edge.from)}\u0000${implementedSymbols.get(edge.to)}`,
    (edge) => ({ from: implementedSymbols.get(edge.from), to: implementedSymbols.get(edge.to) })
  );
  const includeEdges = diffAggregatedEdges(
    currentIncludes, implementedIncludes, currentFacts.confidence, implementedFacts.confidence
  );
  const callEdges = diffAggregatedEdges(
    currentCalls, implementedCalls, currentFacts.confidence, implementedFacts.confidence
  );

  return {
    schemaVersion: CODE_FACTS_DIFF_SCHEMA_VERSION,
    kind: CODE_FACTS_DIFF_KIND,
    currentDigest: codeFactsDigest(currentFacts),
    implementedDigest: codeFactsDigest(implementedFacts),
    summary: {
      files: summarizeChanges(files),
      symbols: summarizeChanges(symbols),
      includeEdges: summarizeChanges(includeEdges),
      callEdges: summarizeChanges(callEdges)
    },
    files,
    symbols,
    includeEdges,
    callEdges,
    evidence: {
      current: {
        projectRoot: currentFacts.project.root,
        confidence: currentFacts.confidence,
        source: sourceShape(currentFacts.source),
        diagnostics: sortedDiagnostics(currentFacts.diagnostics)
      },
      implemented: {
        projectRoot: implementedFacts.project.root,
        confidence: implementedFacts.confidence,
        source: sourceShape(implementedFacts.source),
        diagnostics: sortedDiagnostics(implementedFacts.diagnostics)
      }
    }
  };
}

function normalizeSymbolReference(value) {
  return String(value ?? "")
    .replace(/^::/u, "")
    .replace(/\s+/gu, "")
    .replace(/\([^()]*(?:\([^()]*\)[^()]*)*\)$/u, "")
    .replace(/\(\)$/u, "");
}

function symbolReferenceTokens(value) {
  const normalized = normalizeSymbolReference(value);
  if (!normalized) return new Set();
  const last = normalized.split("::").at(-1);
  return new Set([normalized, last]);
}

function viewMatchesSymbol(view, file, symbolReference) {
  if (!view || view.file !== file) return false;
  const expected = normalizeSymbolReference(symbolReference);
  if (!expected) return false;
  if (expected.includes("::")) {
    return [view.qualifiedName, view.name]
      .filter(Boolean)
      .some((candidate) => normalizeSymbolReference(candidate) === expected);
  }
  const candidates = [view.qualifiedName, view.name, view.signature]
    .filter(Boolean)
    .flatMap((value) => [...symbolReferenceTokens(value)]);
  return candidates.includes(expected);
}

function changeMatchesPlanLocation(record, location) {
  return viewMatchesSymbol(record.before, location.file, location.symbol) ||
    viewMatchesSymbol(record.after, location.file, location.symbol);
}

function allChanged(changes) {
  return ["added", "removed", "modified"].flatMap((kind) => (
    changes[kind].map((record) => ({ ...record, changeKind: kind }))
  ));
}

function finding({ code, category, severity, path, message, planned = null, actual = null, evidence = null }) {
  return { code, category, severity, path, message, planned, actual, evidence };
}

function plannedChangeResult(module, change, status, evidence, message) {
  return {
    moduleId: module.id,
    moduleName: module.name,
    changeId: change.id,
    title: change.title,
    expectedStatus: change.status,
    location: change.location,
    status,
    message,
    evidence
  };
}

function matchingSymbolChanges(diff, change) {
  return Object.fromEntries(CHANGE_KINDS.map((kind) => [kind, (
    diff.symbols[kind].filter((record) => changeMatchesPlanLocation(record, change.location))
  )]));
}

function evaluatePlannedChange(module, change, diff) {
  const matches = matchingSymbolChanges(diff, change);
  const fingerprintGap = matches.unchanged.some((record) => record.evidence.status === "insufficient");
  let evidence = [];
  let observed = false;

  if (change.status === "added") {
    evidence = matches.added;
    observed = evidence.length > 0;
  } else if (change.status === "removed") {
    evidence = matches.removed;
    observed = evidence.length > 0;
  } else if (change.status === "modified") {
    evidence = matches.modified;
    if (evidence.length === 0 && matches.added.length > 0 && matches.removed.length > 0) {
      evidence = [...matches.removed, ...matches.added];
    }
    observed = evidence.length > 0;
  } else {
    evidence = matches.unchanged;
    observed = evidence.length > 0;
  }

  if (observed) {
    const confidence = minimumConfidence(...evidence.map((record) => record.evidence.confidence));
    const supported = confidence !== "low" && evidence.every((record) => record.evidence.status === "supported");
    return plannedChangeResult(
      module,
      change,
      supported ? "satisfied" : "evidence_insufficient",
      { confidence, records: evidence },
      supported
        ? "The requested symbol change is present in the Code Facts delta."
        : "The requested symbol change appears present, but its evidence is not strong enough to approve."
    );
  }

  const otherEvidence = [...matches.added, ...matches.removed, ...matches.modified, ...matches.unchanged];
  const insufficientOtherEvidence = fingerprintGap || otherEvidence.some((record) => (
    record.evidence.status === "insufficient" || record.evidence.confidence === "low"
  ));
  return plannedChangeResult(
    module,
    change,
    insufficientOtherEvidence ? "evidence_insufficient" : "not_observed",
    {
      confidence: "low",
      records: otherEvidence
    },
    fingerprintGap
      ? "The target symbol exists, but fingerprints are missing so the requested change cannot be proven."
      : "The requested symbol change was not observed in the Code Facts delta."
  );
}

function callEndpointMatchesReference(identity, reference) {
  const parts = identity.split("\u0000");
  const endpoint = normalizeSymbolReference(parts[2] ?? "");
  const expected = normalizeSymbolReference(reference);
  if (!endpoint || !expected) return false;
  if (expected.includes("::")) return endpoint === expected;
  return endpoint.split("::").at(-1) === expected;
}

function callRecordMatchesPlan(record, modules) {
  const endpoint = record.after ?? record.before;
  if (!endpoint) return false;
  for (const module of modules) {
    for (const change of module.changes) {
      const concreteSteps = change.callPath.filter((step) => step.collapsedCount === undefined);
      for (let index = 0; index < concreteSteps.length - 1; index += 1) {
        const fromMatches = callEndpointMatchesReference(endpoint.from, concreteSteps[index].label);
        const toMatches = callEndpointMatchesReference(endpoint.to, concreteSteps[index + 1].label);
        if (fromMatches && toMatches) return true;
      }
    }
  }
  return false;
}

function addDiagnosticsFindings(findings, stage, evidence, allowDiagnosticWarnings) {
  for (const [index, diagnostic] of evidence.diagnostics.entries()) {
    if (diagnostic.severity === "info") continue;
    const blocking = diagnostic.severity === "error" || !allowDiagnosticWarnings;
    findings.push(finding({
      code: diagnostic.severity === "error" ? "facts_diagnostic_error" : "facts_diagnostic_warning",
      category: "evidence",
      severity: blocking ? "error" : "warning",
      path: `/evidence/${stage}/diagnostics/${index}`,
      message: `${stage} Code Facts reported: ${diagnostic.message}`,
      actual: diagnostic,
      evidence: { confidence: diagnostic.confidence, source: diagnostic.source }
    }));
  }
}

function sortFindings(findings) {
  return [...findings].sort((left, right) => (
    compareText(left.category, right.category) ||
    compareText(left.path, right.path) ||
    compareText(left.code, right.code) ||
    compareText(left.message, right.message)
  ));
}

function determineAuditStatus(findings) {
  if (findings.some((item) => item.category === "unapproved")) return "review_required";
  if (findings.some((item) => item.severity === "error")) return "incomplete";
  return "pass";
}

function summarizeAudit(plannedChanges, findings) {
  return {
    plannedChanges: plannedChanges.length,
    satisfied: plannedChanges.filter((item) => item.status === "satisfied").length,
    incomplete: plannedChanges.filter((item) => item.status !== "satisfied").length,
    unapproved: findings.filter((item) => item.category === "unapproved").length,
    evidenceIssues: findings.filter((item) => (
      item.category === "evidence" || item.code === "planned_change_evidence_insufficient"
    )).length,
    totalFindings: findings.length
  };
}

/**
 * Audit an approved plan against real before/after Code Facts. Pass is only
 * possible when every concrete planned symbol change is observed and no
 * unapproved file, symbol, include, or call dependency change is present.
 */
export function auditPlanAgainstCodeFacts(approvedPlan, currentFacts, implementedFacts, {
  now = () => new Date(),
  allowDiagnosticWarnings = false
} = {}) {
  assertPlanModel(approvedPlan);
  assertCodeFacts(currentFacts);
  assertCodeFacts(implementedFacts);
  if (approvedPlan.status !== "approved") {
    throw new TypeError("Approved Plan Model must have status approved");
  }
  if (!approvedPlan.modules.every((module) => module.approval.decision === "approved")) {
    throw new TypeError("Every module in the Approved Plan Model must be approved");
  }

  const diff = compareCodeFacts(currentFacts, implementedFacts);
  const plannedChanges = approvedPlan.modules.flatMap((module) => (
    module.changes.map((change) => evaluatePlannedChange(module, change, diff))
  ));
  const findings = [];

  for (const planned of plannedChanges) {
    if (planned.status === "satisfied") continue;
    findings.push(finding({
      code: planned.status === "not_observed"
        ? "planned_change_not_observed"
        : "planned_change_evidence_insufficient",
      category: "planned",
      severity: "error",
      path: `/modules/${encodeURIComponent(planned.moduleId)}/changes/${encodeURIComponent(planned.changeId)}`,
      message: planned.message,
      planned: { status: planned.expectedStatus, location: planned.location },
      actual: planned.evidence.records,
      evidence: { confidence: planned.evidence.confidence }
    }));
  }

  if (currentFacts.project.name !== implementedFacts.project.name) {
    findings.push(finding({
      code: "facts_project_mismatch",
      category: "evidence",
      severity: "error",
      path: "/project",
      message: "Current and implemented Code Facts describe different projects.",
      planned: { name: currentFacts.project.name, root: currentFacts.project.root },
      actual: { name: implementedFacts.project.name, root: implementedFacts.project.root }
    }));
  }

  for (const [stage, facts] of [["current", currentFacts], ["implemented", implementedFacts]]) {
    if (facts.confidence === "low") {
      findings.push(finding({
        code: "low_global_confidence",
        category: "evidence",
        severity: "error",
        path: `/evidence/${stage}/confidence`,
        message: `${stage} Code Facts have low global confidence; absence cannot be proven.`,
        actual: facts.confidence,
        evidence: { confidence: facts.confidence, source: sourceShape(facts.source) }
      }));
    }
  }
  addDiagnosticsFindings(findings, "current", diff.evidence.current, allowDiagnosticWarnings);
  addDiagnosticsFindings(findings, "implemented", diff.evidence.implemented, allowDiagnosticWarnings);

  const plannedLocations = approvedPlan.modules.flatMap((module) => module.changes.map((change) => change.location));
  const plannedFiles = new Set(plannedLocations.map((location) => location.file));

  for (const record of allChanged(diff.files)) {
    const path = record.after?.path ?? record.before?.path;
    if (plannedFiles.has(path)) continue;
    findings.push(finding({
      code: "unapproved_file_change",
      category: "unapproved",
      severity: "error",
      path: `/facts/files/${encodeURIComponent(path)}`,
      message: `File changed outside the approved plan scope: ${path}`,
      actual: { changeKind: record.changeKind, before: record.before, after: record.after },
      evidence: record.evidence
    }));
  }

  for (const record of allChanged(diff.symbols)) {
    if (plannedLocations.some((location) => changeMatchesPlanLocation(record, location))) continue;
    const view = record.after ?? record.before;
    findings.push(finding({
      code: "unapproved_symbol_change",
      category: "unapproved",
      severity: "error",
      path: `/facts/symbols/${encodeURIComponent(record.identity)}`,
      message: `Symbol changed outside the approved plan scope: ${symbolDisplayName(view)}`,
      actual: { changeKind: record.changeKind, before: record.before, after: record.after },
      evidence: record.evidence
    }));
  }

  for (const record of allChanged(diff.includeEdges)) {
    findings.push(finding({
      code: "unapproved_include_dependency_change",
      category: "unapproved",
      severity: "error",
      path: `/facts/includeEdges/${encodeURIComponent(record.identity)}`,
      message: "A concrete include dependency changed without a concrete include edge in the approved plan.",
      actual: { changeKind: record.changeKind, before: record.before, after: record.after },
      evidence: record.evidence
    }));
  }

  for (const record of allChanged(diff.callEdges)) {
    if (callRecordMatchesPlan(record, approvedPlan.modules)) continue;
    findings.push(finding({
      code: "unapproved_call_dependency_change",
      category: "unapproved",
      severity: "error",
      path: `/facts/callEdges/${encodeURIComponent(record.identity)}`,
      message: "A call dependency changed outside the approved call paths.",
      actual: { changeKind: record.changeKind, before: record.before, after: record.after },
      evidence: record.evidence
    }));
  }

  const orderedFindings = sortFindings(findings);
  return {
    schemaVersion: FACTS_AUDIT_SCHEMA_VERSION,
    kind: FACTS_AUDIT_KIND,
    reviewId: approvedPlan.id,
    generatedAt: now().toISOString(),
    status: determineAuditStatus(orderedFindings),
    approvedDigest: hash(approvedPlan),
    currentFactsDigest: diff.currentDigest,
    implementedFactsDigest: diff.implementedDigest,
    summary: summarizeAudit(plannedChanges, orderedFindings),
    assurance: {
      level: "structural",
      provenByThisReport: [
        "file presence and content fingerprint changes",
        "symbol presence and fingerprint changes",
        "include dependency changes",
        "call dependency changes",
        "scope alignment with concrete Plan change locations"
      ],
      notProvenByThisReport: [
        "pseudocode behavioral equivalence",
        "runtime correctness",
        "verification command results",
        "performance or security properties"
      ]
    },
    plannedChanges,
    findings: orderedFindings,
    factsDiff: diff
  };
}

export function formatFactsAuditMarkdown(report) {
  if (!report || report.kind !== FACTS_AUDIT_KIND) {
    throw new TypeError("Expected an IntentCanvas Facts Audit Report");
  }
  const lines = [
    `# IntentCanvas facts review: ${report.reviewId}`,
    "",
    `**Result:** ${report.status}`,
    `**Planned changes:** ${report.summary.satisfied}/${report.summary.plannedChanges} proven`,
    `**Unexpected changes:** ${report.summary.unapproved}`,
    `**Evidence issues:** ${report.summary.evidenceIssues}`,
    `**Assurance:** ${report.assurance.level} facts only; behavior and test results are not proven here.`,
    "",
    "## Approved changes",
    ""
  ];

  for (const change of report.plannedChanges) {
    lines.push(
      `- **${change.moduleName} / ${change.title}:** ${change.status} — ${change.location.file} :: ${change.location.symbol}`
    );
  }

  if (report.findings.length > 0) {
    lines.push("", "## Findings", "");
    for (const item of report.findings) {
      lines.push(`- **${item.category}/${item.code}:** ${item.message}`);
    }
  }

  lines.push(
    "",
    `Evidence: current ${report.currentFactsDigest.slice(0, 12)}, implemented ${report.implementedFactsDigest.slice(0, 12)}`
  );
  return `${lines.join("\n").trimEnd()}\n`;
}
