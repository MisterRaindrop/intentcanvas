import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { CODE_FACTS_KIND, CODE_FACTS_SCHEMA_VERSION } from "./extract.js";

export class CodeFactsInspectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodeFactsInspectionError";
    this.code = "invalid_code_facts";
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCandidate(candidate) {
  if (typeof candidate !== "string") return candidate;
  try {
    return JSON.parse(candidate.replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new CodeFactsInspectionError(`Invalid Code Facts JSON: ${error.message}`);
  }
}

function requireDocument(candidate) {
  const facts = parseCandidate(candidate);
  if (!isObject(facts)) throw new CodeFactsInspectionError("Code Facts must be a JSON object");
  if (facts.kind !== CODE_FACTS_KIND) {
    throw new CodeFactsInspectionError(`kind must equal ${CODE_FACTS_KIND}`);
  }
  if (facts.schemaVersion !== CODE_FACTS_SCHEMA_VERSION) {
    throw new CodeFactsInspectionError(
      `schemaVersion must equal ${CODE_FACTS_SCHEMA_VERSION}`
    );
  }
  if (!isObject(facts.project) || typeof facts.project.root !== "string") {
    throw new CodeFactsInspectionError("project.root must be present");
  }
  for (const field of ["files", "symbols", "includeEdges", "callEdges", "diagnostics"]) {
    if (!Array.isArray(facts[field])) {
      throw new CodeFactsInspectionError(`${field} must be an array`);
    }
  }
  return facts;
}

/** Return a compact, non-mutating summary of a Code Facts v1 document. */
export function inspectCodeFacts(candidate) {
  const facts = requireDocument(candidate);
  const diagnosticCounts = { error: 0, warning: 0, info: 0 };
  for (const item of facts.diagnostics) {
    if (Object.hasOwn(diagnosticCounts, item?.severity)) diagnosticCounts[item.severity] += 1;
  }
  return {
    schemaVersion: facts.schemaVersion,
    kind: facts.kind,
    project: {
      name: facts.project.name ?? "",
      root: facts.project.root,
      buildSystems: Array.isArray(facts.project.buildSystems)
        ? facts.project.buildSystems.map((item) => item.type)
        : [],
      compileCommands: facts.project.compileCommands ?? null
    },
    counts: {
      files: facts.files.length,
      symbols: facts.symbols.length,
      includeEdges: facts.includeEdges.length,
      callEdges: facts.callEdges.length,
      diagnostics: facts.diagnostics.length
    },
    diagnostics: diagnosticCounts,
    confidence: facts.confidence,
    source: facts.source
  };
}

export function formatCodeFactsInspection(summary) {
  const systems = summary.project.buildSystems.length > 0
    ? summary.project.buildSystems.join(", ")
    : "none detected";
  const compilationDatabase = summary.project.compileCommands ?? "not found";
  return [
    `${summary.kind} ${summary.schemaVersion}`,
    `Project: ${summary.project.name || "(unnamed)"}`,
    `Root: ${summary.project.root}`,
    `Build systems: ${systems}`,
    `Compilation database: ${compilationDatabase}`,
    `Files: ${summary.counts.files}`,
    `Symbols: ${summary.counts.symbols}`,
    `Include edges: ${summary.counts.includeEdges}`,
    `Call edges: ${summary.counts.callEdges}`,
    `Diagnostics: ${summary.diagnostics.error} error, ${summary.diagnostics.warning} warning, ${summary.diagnostics.info} info`,
    `Confidence: ${summary.confidence ?? "unknown"}`
  ].join("\n");
}

export async function inspectCodeFactsFile(path) {
  return inspectCodeFacts(await readFile(resolve(path), "utf8"));
}
