import { dirname, resolve } from "node:path";

import { languageForFile } from "./compilation-database.js";
import { compareText, pathForProject, toPosixPath } from "./path-utils.js";
import {
  diagnostic,
  hashValue,
  MAX_ANALYSIS_INPUT_BYTES,
  readBoundedRegularFile,
  resolveContainedRegularPath,
  sourceFor,
  SourceBoundaryError
} from "./source.js";

export class ClangUmlError extends Error {
  constructor(message, { code = "invalid_clang_uml", path } = {}) {
    super(message);
    this.name = "ClangUmlError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

function positiveInteger(value) {
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function normalizeFactPath(projectRoot, value) {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const clean = value.trim();
  if (/^[A-Za-z]:[\\/]/u.test(clean) || /^\\\\/u.test(clean)) {
    return clean.replaceAll("\\", "/");
  }
  return pathForProject(projectRoot, resolve(projectRoot, clean));
}

function locationCandidate(value) {
  if (!isObject(value)) return null;
  for (const candidate of [value.source_location, value.source, value.location, value]) {
    if (isObject(candidate)) return candidate;
  }
  return null;
}

function locationFor(value, projectRoot) {
  const candidate = locationCandidate(value);
  if (!candidate) return undefined;
  const line = positiveInteger(candidate.line ?? candidate.start_line);
  if (line === undefined) return undefined;
  const location = { line };
  const file = normalizeFactPath(projectRoot,
    firstString(candidate.file, candidate.path, candidate.filename));
  const column = positiveInteger(candidate.column ?? candidate.col ?? candidate.start_column);
  const endLine = positiveInteger(candidate.endLine ?? candidate.end_line);
  const endColumn = positiveInteger(candidate.endColumn ?? candidate.end_column);
  if (file !== undefined) location.file = file;
  if (column !== undefined) location.column = column;
  if (endLine !== undefined) location.endLine = endLine;
  if (endColumn !== undefined) location.endColumn = endColumn;
  return location;
}

function fileFor(value, projectRoot, fallback) {
  const location = locationCandidate(value);
  return normalizeFactPath(projectRoot, firstString(
    location?.file,
    location?.path,
    location?.filename,
    value?.file,
    value?.path,
    fallback
  ));
}

function diagramType(diagram) {
  return firstString(diagram.diagram_type, diagram.diagramType, diagram.type, diagram.kind)
    ?.toLowerCase() ?? "unknown";
}

function isDiagram(value) {
  return isObject(value) && (
    Array.isArray(value.elements) || Array.isArray(value.participants) ||
    Array.isArray(value.relationships) || Array.isArray(value.sequences) ||
    Array.isArray(value.messages)
  );
}

function collectDiagrams(document) {
  if (Array.isArray(document)) return document.filter(isDiagram);
  if (!isObject(document)) return [];
  if (isDiagram(document)) return [document];
  if (Array.isArray(document.diagrams)) return document.diagrams.filter(isDiagram);
  if (isObject(document.diagrams)) {
    return Object.keys(document.diagrams).sort(compareText)
      .map((name) => document.diagrams[name]).filter(isDiagram);
  }
  return Object.keys(document).sort(compareText)
    .map((name) => document[name]).filter(isDiagram);
}

function collectElements(elements, found = []) {
  if (!Array.isArray(elements)) return found;
  for (const element of elements) {
    if (!isObject(element)) continue;
    const type = typeForNode(element);
    const isContainer = ["folder", "directory", "package", "namespace"].includes(type);
    if (!isContainer) found.push(element);
    collectElements(element.elements, found);
  }
  return found;
}

function referenceKey(value) {
  if (["string", "number", "bigint"].includes(typeof value)) return String(value);
  if (!isObject(value)) return undefined;
  const key = value.id ?? value.activity_id ?? value.element_id ?? value.participant_id ?? value.alias;
  return key === undefined ? undefined : String(key);
}

function endpoint(relationship, side) {
  if (side === "from") {
    return referenceKey(relationship.from ?? relationship.source ?? relationship.caller ??
      relationship.sender);
  }
  return referenceKey(relationship.to ?? relationship.destination ?? relationship.callee ??
    relationship.receiver);
}

function typeForNode(node, fallback = "symbol") {
  return firstString(node.kind, node.type, node.participant_type, node.element_type, fallback)
    .toLowerCase().replaceAll(" ", "_");
}

function isFileNode(node) {
  return ["file", "source_file", "header"]
    .includes(typeForNode(node));
}

function symbolIdentity(symbol) {
  return [
    symbol.qualifiedName ?? symbol.name,
    symbol.name,
    symbol.kind,
    symbol.file,
    symbol.signature ?? null
  ];
}

function makeSymbol(node, {
  projectRoot,
  source,
  fallbackFile,
  fallbackQualifiedName,
  forceKind
} = {}) {
  const displayName = firstString(node.display_name, node.displayName, node.name);
  const explicitQualifiedName = firstString(
    node.qualified_name,
    node.qualifiedName,
    node.full_name,
    node.fullName
  );
  const namespace = firstString(node.namespace);
  const qualifiedName = explicitQualifiedName ??
    (fallbackQualifiedName === undefined || displayName === undefined
      ? undefined
      : `${fallbackQualifiedName}::${displayName}`) ??
    (namespace === undefined || displayName === undefined
      ? undefined
      : `${namespace}::${displayName}`) ??
    displayName;
  if (qualifiedName === undefined) return null;
  const name = firstString(node.name, qualifiedName.split("::").at(-1), qualifiedName);
  const file = fileFor(node, projectRoot, fallbackFile);
  if (file === undefined) return null;
  const location = locationFor(node, projectRoot);
  const signature = firstString(node.signature, node.display_name, node.displayName);
  const base = {
    name,
    kind: forceKind ?? typeForNode(node),
    file,
    confidence: "high",
    source
  };
  if (qualifiedName !== name) base.qualifiedName = qualifiedName;
  if (signature !== undefined && signature !== name && signature !== qualifiedName) {
    base.signature = signature;
  }
  if (location !== undefined) base.location = location;
  base.fingerprint = hashValue(JSON.stringify(symbolIdentity(base)));
  const implementation = firstString(
    node.source_code,
    node.sourceCode,
    node.implementation,
    node.body
  );
  if (implementation !== undefined) {
    base.implementationFingerprint = hashValue(implementation);
  }
  base.id = `symbol:${base.fingerprint.slice("sha256:".length, "sha256:".length + 24)}`;
  return base;
}

function messagesUnder(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) messagesUnder(item, found);
    return found;
  }
  if (!isObject(value)) return found;
  if (endpoint(value, "from") !== undefined && endpoint(value, "to") !== undefined) {
    found.push(value);
  }
  for (const key of ["messages", "branches", "then", "else", "cases", "children"]) {
    if (value[key] !== undefined) messagesUnder(value[key], found);
  }
  return found;
}

function edgeKey(edge) {
  return `${edge.from}\0${edge.to}\0${JSON.stringify(edge.location ?? null)}`;
}

function sortEdges(left, right) {
  return compareText(left.from, right.from) || compareText(left.to, right.to) ||
    compareText(JSON.stringify(left.location ?? null), JSON.stringify(right.location ?? null));
}

function sortDiagnostics(left, right) {
  return compareText(left.severity, right.severity) || compareText(left.code ?? "", right.code ?? "") ||
    compareText(left.file ?? "", right.file ?? "") || compareText(left.message, right.message);
}

/**
 * Convert supported clang-uml class/include/sequence JSON into Code Facts.
 * Unsupported or unresolved records are diagnosed and omitted; source text is
 * never heuristically parsed to fill gaps.
 */
export function parseClangUmlJson(input, {
  projectRoot = process.cwd(),
  sourcePath,
  version
} = {}) {
  let document = input;
  if (typeof input === "string") {
    try {
      document = JSON.parse(input);
    } catch (error) {
      throw new ClangUmlError(`Invalid clang-uml JSON: ${error.message}`, { code: "invalid_json" });
    }
  }
  if (!isObject(document) && !Array.isArray(document)) {
    throw new ClangUmlError("clang-uml JSON must contain an object or array");
  }

  const root = resolve(projectRoot);
  const detectedVersion = version ?? firstString(document.clang_uml_version, document.version);
  const source = sourceFor("clang-uml", { version: detectedVersion, path: sourcePath });
  const files = new Map();
  const symbols = new Map();
  const includeEdges = new Map();
  const callEdges = new Map();
  const diagnostics = [];
  const diagrams = collectDiagrams(document);

  if (diagrams.length === 0) {
    diagnostics.push(diagnostic("warning", "clang_uml_no_diagrams",
      "The supplied clang-uml JSON contained no supported diagrams.", { source }));
  }

  for (const diagram of diagrams) {
    const type = diagramType(diagram);
    const fileIds = new Map();
    const symbolIds = new Map();
    const nodes = [
      ...collectElements(diagram.elements),
      ...(Array.isArray(diagram.participants) ? diagram.participants : [])
    ].filter(isObject);

    for (const node of nodes) {
      const rawId = referenceKey(node);
      if (isFileNode(node)) {
        const file = normalizeFactPath(root, firstString(
          node.path,
          node.file,
          node.display_name,
          node.name,
          node.full_name
        ));
        if (file === undefined) continue;
        fileIds.set(rawId ?? file, file);
        files.set(file, {
          path: file,
          language: languageForFile(file),
          confidence: "high",
          source
        });
        for (const activity of Array.isArray(node.activities) ? node.activities.filter(isObject) : []) {
          const activitySymbol = makeSymbol(activity, {
            projectRoot: root,
            source,
            fallbackFile: file
          });
          if (activitySymbol === null) continue;
          symbols.set(activitySymbol.id, activitySymbol);
          const activityId = referenceKey(activity);
          if (activityId !== undefined) symbolIds.set(activityId, activitySymbol.id);
        }
        continue;
      }

      const symbol = makeSymbol(node, { projectRoot: root, source });
      if (symbol === null) {
        diagnostics.push(diagnostic("warning", "clang_uml_symbol_incomplete",
          "A clang-uml symbol without a name or source file was omitted.", { source }));
        continue;
      }
      symbols.set(symbol.id, symbol);
      files.set(symbol.file, files.get(symbol.file) ?? {
        path: symbol.file,
        language: languageForFile(symbol.file),
        confidence: "high",
        source
      });
      if (rawId !== undefined) symbolIds.set(rawId, symbol.id);

      for (const [collection, forceKind] of [
        [node.methods, "method"],
        [node.members, "field"],
        [node.activities, undefined]
      ]) {
        if (!Array.isArray(collection)) continue;
        for (const child of collection.filter(isObject)) {
          const childSymbol = makeSymbol(child, {
            projectRoot: root,
            source,
            fallbackFile: symbol.file,
            fallbackQualifiedName: symbol.qualifiedName ?? symbol.name,
            forceKind
          });
          if (childSymbol === null) continue;
          symbols.set(childSymbol.id, childSymbol);
          const childRawId = referenceKey(child);
          if (childRawId !== undefined) symbolIds.set(childRawId, childSymbol.id);
        }
      }
    }

    const relationships = Array.isArray(diagram.relationships) ? diagram.relationships : [];
    const includeDiagram = type.includes("include");
    const sequenceDiagram = type.includes("sequence");
    for (const relationship of relationships.filter(isObject)) {
      const relationshipType = (firstString(relationship.type, relationship.kind) ?? "")
        .toLowerCase();
      const fromKey = endpoint(relationship, "from");
      const toKey = endpoint(relationship, "to");
      const isInclude = includeDiagram || relationshipType.includes("include");
      const isCall = sequenceDiagram || ["call", "calls", "message", "invocation"]
        .includes(relationshipType);
      if (isInclude) {
        const from = fileIds.get(fromKey);
        const to = fileIds.get(toKey);
        if (from !== undefined && to !== undefined) {
          const edge = { from, to, confidence: "high", source };
          const location = locationFor(relationship, root);
          if (location !== undefined) edge.location = location;
          includeEdges.set(edgeKey(edge), edge);
        } else {
          diagnostics.push(diagnostic("warning", "clang_uml_unresolved_include",
            "A clang-uml include relationship referenced an unknown file and was omitted.", { source }));
        }
      } else if (isCall) {
        const from = symbolIds.get(fromKey);
        const to = symbolIds.get(toKey);
        if (from !== undefined && to !== undefined) {
          const edge = { from, to, confidence: "high", source };
          const location = locationFor(relationship, root);
          if (location !== undefined) edge.location = location;
          callEdges.set(edgeKey(edge), edge);
        } else {
          diagnostics.push(diagnostic("warning", "clang_uml_unresolved_call",
            "A clang-uml call relationship referenced an unknown symbol and was omitted.", { source }));
        }
      }
    }

    const messages = [
      ...messagesUnder(diagram.sequences ?? []),
      ...messagesUnder(diagram.messages ?? [])
    ];
    for (const message of messages) {
      const messageType = (firstString(message.type, message.kind) ?? "").toLowerCase();
      if (messageType.includes("return") || messageType === "reply") continue;
      const from = symbolIds.get(endpoint(message, "from"));
      const to = symbolIds.get(endpoint(message, "to"));
      if (from === undefined || to === undefined) {
        diagnostics.push(diagnostic("warning", "clang_uml_unresolved_call",
          "A clang-uml sequence message referenced an unknown symbol and was omitted.", { source }));
        continue;
      }
      const edge = { from, to, confidence: "high", source };
      const location = locationFor(message, root);
      if (location !== undefined) edge.location = location;
      callEdges.set(edgeKey(edge), edge);
    }
  }

  for (const value of [
    ...symbols.values(),
    ...includeEdges.values(),
    ...callEdges.values(),
    ...diagnostics
  ]) {
    const file = value.location?.file;
    if (file === undefined || files.has(file)) continue;
    files.set(file, {
      path: file,
      language: languageForFile(file),
      confidence: "high",
      source
    });
  }

  return {
    files: [...files.values()].sort((left, right) => compareText(left.path, right.path)),
    symbols: [...symbols.values()].sort((left, right) =>
      compareText(left.file, right.file) ||
      (left.location?.line ?? 0) - (right.location?.line ?? 0) ||
      compareText(left.id, right.id)),
    includeEdges: [...includeEdges.values()].sort(sortEdges),
    callEdges: [...callEdges.values()].sort(sortEdges),
    diagnostics: diagnostics.sort(sortDiagnostics)
  };
}

export const ingestClangUmlJson = parseClangUmlJson;
export const parseClangUml = parseClangUmlJson;

export async function readClangUmlJson(path, options = {}) {
  const absolutePath = resolve(path);
  let text;
  let canonicalPath;
  try {
    canonicalPath = await resolveContainedRegularPath(
      options.projectRoot ?? dirname(absolutePath),
      absolutePath
    );
    text = await readBoundedRegularFile(canonicalPath, {
      maxBytes: MAX_ANALYSIS_INPUT_BYTES,
      encoding: "utf8"
    });
  } catch (error) {
    throw new ClangUmlError(`Unable to read ${absolutePath}: ${error.message}`, {
      code: error instanceof SourceBoundaryError ? error.code : "read_failed",
      path: absolutePath
    });
  }
  try {
    return parseClangUmlJson(text, {
      ...options,
      sourcePath: options.sourcePath ?? canonicalPath
    });
  } catch (error) {
    if (error instanceof ClangUmlError) error.path ??= absolutePath;
    throw error;
  }
}

export const readClangUml = readClangUmlJson;
