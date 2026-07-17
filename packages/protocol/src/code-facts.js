export const CODE_FACTS_SCHEMA_VERSION = "1.0.0";
export const CODE_FACTS_KIND = "IntentCanvasCodeFacts";

export const CODE_FACTS_CONFIDENCE_LEVELS = Object.freeze([
  "low",
  "medium",
  "high"
]);

export const CODE_FACTS_DIAGNOSTIC_SEVERITIES = Object.freeze([
  "info",
  "warning",
  "error"
]);

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

function requireArray(value, path, errors) {
  if (!Array.isArray(value)) {
    addError(errors, path, "must be an array", "invalid_type");
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

function requireEnum(value, allowed, path, errors) {
  if (!allowed.includes(value)) {
    addError(errors, path, `must be one of: ${allowed.join(", ")}`, "invalid_enum");
    return false;
  }
  return true;
}

function requirePositiveInteger(value, path, errors) {
  if (!Number.isInteger(value) || value < 1) {
    addError(errors, path, "must be a positive integer", "invalid_number");
    return false;
  }
  return true;
}

function validateSource(source, path, errors) {
  if (!requireObject(source, path, errors)) return;
  requireString(source.tool, `${path}.tool`, errors);
  if (source.version !== undefined) {
    requireString(source.version, `${path}.version`, errors);
  }
  if (source.path !== undefined) {
    requireString(source.path, `${path}.path`, errors);
  }
}

function validateConfidence(confidence, path, errors) {
  requireEnum(confidence, CODE_FACTS_CONFIDENCE_LEVELS, path, errors);
}

function validateFactMetadata(value, path, errors) {
  validateConfidence(value.confidence, `${path}.confidence`, errors);
  validateSource(value.source, `${path}.source`, errors);
}

function validateFingerprint(fingerprint, path, errors) {
  if (!requireString(fingerprint, path, errors)) return;
  if (!/^sha256:[0-9a-f]{64}$/.test(fingerprint)) {
    addError(errors, path, "must be a lowercase sha256 fingerprint", "invalid_format");
  }
}

function validateLocation(location, path, errors, filePaths) {
  if (!requireObject(location, path, errors)) return;
  const hasLine = requirePositiveInteger(location.line, `${path}.line`, errors);

  if (location.file !== undefined &&
      requireString(location.file, `${path}.file`, errors) &&
      !filePaths.has(location.file)) {
    addError(errors, `${path}.file`, "must reference a file", "unknown_reference");
  }
  if (location.column !== undefined) {
    requirePositiveInteger(location.column, `${path}.column`, errors);
  }
  if (location.endLine !== undefined) {
    const hasEndLine = requirePositiveInteger(location.endLine, `${path}.endLine`, errors);
    if (hasLine && hasEndLine && location.endLine < location.line) {
      addError(errors, `${path}.endLine`, "must not precede line", "invalid_range");
    }
  }
  if (location.endColumn !== undefined) {
    const hasEndColumn = requirePositiveInteger(
      location.endColumn,
      `${path}.endColumn`,
      errors
    );
    if (hasEndColumn && Number.isInteger(location.column) &&
        (location.endLine === undefined || location.endLine === location.line) &&
        location.endColumn < location.column) {
      addError(errors, `${path}.endColumn`, "must not precede column", "invalid_range");
    }
  }
}

function validateProject(project, errors) {
  if (!requireObject(project, "$.project", errors)) return;
  requireString(project.root, "$.project.root", errors);
  requireString(project.name, "$.project.name", errors);

  if (project.buildSystems !== undefined &&
      requireArray(project.buildSystems, "$.project.buildSystems", errors)) {
    const buildSystemKeys = new Set();
    project.buildSystems.forEach((buildSystem, index) => {
      const path = `$.project.buildSystems[${index}]`;
      if (!requireObject(buildSystem, path, errors)) return;
      const hasType = requireString(buildSystem.type, `${path}.type`, errors);
      const hasPath = requireString(buildSystem.path, `${path}.path`, errors);
      if (hasType && hasPath) {
        const key = `${buildSystem.type}\0${buildSystem.path}`;
        if (buildSystemKeys.has(key)) {
          addError(errors, path, "must be unique", "duplicate_value");
        }
        buildSystemKeys.add(key);
      }
    });
  }

  if (project.compileCommands !== undefined) {
    requireString(project.compileCommands, "$.project.compileCommands", errors);
  }
}

function validateCompile(compile, path, errors) {
  if (!requireObject(compile, path, errors)) return;
  requireString(compile.directory, `${path}.directory`, errors);

  if (requireArray(compile.arguments, `${path}.arguments`, errors)) {
    compile.arguments.forEach((argument, index) => {
      // Empty argv entries are valid and are distinct from a missing argument.
      requireString(argument, `${path}.arguments[${index}]`, errors, { allowEmpty: true });
    });
  }

  if (requireArray(compile.includeDirectories, `${path}.includeDirectories`, errors)) {
    compile.includeDirectories.forEach((includeDirectory, index) => {
      const includePath = `${path}.includeDirectories[${index}]`;
      if (!requireObject(includeDirectory, includePath, errors)) return;
      requireString(includeDirectory.path, `${includePath}.path`, errors);
      requireString(includeDirectory.kind, `${includePath}.kind`, errors);
    });
  }
}

function validateFiles(files, filePaths, errors) {
  if (!requireArray(files, "$.files", errors)) return;
  files.forEach((file, index) => {
    const path = `$.files[${index}]`;
    if (!requireObject(file, path, errors)) return;

    if (requireString(file.path, `${path}.path`, errors)) {
      if (filePaths.has(file.path)) {
        addError(errors, `${path}.path`, "must be unique", "duplicate_id");
      }
      filePaths.add(file.path);
    }
    requireString(file.language, `${path}.language`, errors);
    if (file.generated !== undefined && typeof file.generated !== "boolean") {
      addError(errors, `${path}.generated`, "must be a boolean", "invalid_type");
    }
    if (file.fingerprint !== undefined) {
      validateFingerprint(file.fingerprint, `${path}.fingerprint`, errors);
    }
    if (file.compile !== undefined) {
      validateCompile(file.compile, `${path}.compile`, errors);
    }
    validateFactMetadata(file, path, errors);
  });
}

function validateSymbols(symbols, filePaths, symbolIds, errors) {
  if (!requireArray(symbols, "$.symbols", errors)) return;
  symbols.forEach((symbol, index) => {
    const path = `$.symbols[${index}]`;
    if (!requireObject(symbol, path, errors)) return;

    if (requireString(symbol.id, `${path}.id`, errors)) {
      if (symbolIds.has(symbol.id)) {
        addError(errors, `${path}.id`, "must be unique", "duplicate_id");
      }
      symbolIds.add(symbol.id);
    }
    requireString(symbol.name, `${path}.name`, errors);
    requireString(symbol.kind, `${path}.kind`, errors);
    if (requireString(symbol.file, `${path}.file`, errors) && !filePaths.has(symbol.file)) {
      addError(errors, `${path}.file`, "must reference a file", "unknown_reference");
    }
    if (symbol.qualifiedName !== undefined) {
      requireString(symbol.qualifiedName, `${path}.qualifiedName`, errors);
    }
    if (symbol.signature !== undefined) {
      requireString(symbol.signature, `${path}.signature`, errors, { allowEmpty: true });
    }
    if (symbol.fingerprint !== undefined) {
      validateFingerprint(symbol.fingerprint, `${path}.fingerprint`, errors);
    }
    if (symbol.location !== undefined) {
      validateLocation(symbol.location, `${path}.location`, errors, filePaths);
    }
    validateFactMetadata(symbol, path, errors);
  });
}

function validateEdgeMetadata(edge, path, filePaths, errors) {
  if (edge.location !== undefined) {
    validateLocation(edge.location, `${path}.location`, errors, filePaths);
  }
  validateFactMetadata(edge, path, errors);
}

function validateEdges(edges, path, knownIds, referenceName, filePaths, errors) {
  if (!requireArray(edges, path, errors)) return;
  const edgeKeys = new Set();

  edges.forEach((edge, index) => {
    const edgePath = `${path}[${index}]`;
    if (!requireObject(edge, edgePath, errors)) return;

    const hasFrom = requireString(edge.from, `${edgePath}.from`, errors);
    const hasTo = requireString(edge.to, `${edgePath}.to`, errors);
    if (hasFrom && !knownIds.has(edge.from)) {
      addError(
        errors,
        `${edgePath}.from`,
        `must reference a ${referenceName}`,
        "unknown_reference"
      );
    }
    if (hasTo && !knownIds.has(edge.to)) {
      addError(
        errors,
        `${edgePath}.to`,
        `must reference a ${referenceName}`,
        "unknown_reference"
      );
    }

    validateEdgeMetadata(edge, edgePath, filePaths, errors);

    if (hasFrom && hasTo) {
      const location = isObject(edge.location) ? edge.location : {};
      const key = [
        edge.from,
        edge.to,
        location.file ?? "",
        location.line ?? "",
        location.column ?? "",
        location.endLine ?? "",
        location.endColumn ?? ""
      ].join("\0");
      if (edgeKeys.has(key)) {
        addError(errors, edgePath, "must be unique", "duplicate_value");
      }
      edgeKeys.add(key);
    }
  });
}

function validateDiagnostics(diagnostics, filePaths, errors) {
  if (!requireArray(diagnostics, "$.diagnostics", errors)) return;
  diagnostics.forEach((diagnostic, index) => {
    const path = `$.diagnostics[${index}]`;
    if (!requireObject(diagnostic, path, errors)) return;

    requireEnum(
      diagnostic.severity,
      CODE_FACTS_DIAGNOSTIC_SEVERITIES,
      `${path}.severity`,
      errors
    );
    requireString(diagnostic.message, `${path}.message`, errors);
    if (diagnostic.code !== undefined) {
      requireString(diagnostic.code, `${path}.code`, errors);
    }
    if (diagnostic.file !== undefined) {
      requireString(diagnostic.file, `${path}.file`, errors);
    }
    if (diagnostic.location !== undefined) {
      validateLocation(diagnostic.location, `${path}.location`, errors, filePaths);
    }
    validateFactMetadata(diagnostic, path, errors);
  });
}

/**
 * Validate a deterministic snapshot of facts extracted from source code.
 *
 * Unknown properties are retained for forward-compatible tool metadata, while
 * the graph identity and reference fields remain strict.
 *
 * @param {unknown} facts candidate Code Facts document
 * @returns {{valid: boolean, errors: Array<{path: string, message: string, code: string}>}}
 */
export function validateCodeFacts(facts) {
  const errors = [];
  if (!requireObject(facts, "$", errors)) return { valid: false, errors };

  if (requireString(facts.schemaVersion, "$.schemaVersion", errors) &&
      facts.schemaVersion !== CODE_FACTS_SCHEMA_VERSION) {
    addError(
      errors,
      "$.schemaVersion",
      `unsupported schema version; expected ${CODE_FACTS_SCHEMA_VERSION}`,
      "unsupported_version"
    );
  }
  if (facts.kind !== CODE_FACTS_KIND) {
    addError(errors, "$.kind", `must equal ${CODE_FACTS_KIND}`, "invalid_kind");
  }

  validateProject(facts.project, errors);

  const filePaths = new Set();
  validateFiles(facts.files, filePaths, errors);

  const symbolIds = new Set();
  validateSymbols(facts.symbols, filePaths, symbolIds, errors);
  validateEdges(facts.includeEdges, "$.includeEdges", filePaths, "file", filePaths, errors);
  validateEdges(facts.callEdges, "$.callEdges", symbolIds, "symbol", filePaths, errors);
  validateDiagnostics(facts.diagnostics, filePaths, errors);
  validateConfidence(facts.confidence, "$.confidence", errors);
  validateSource(facts.source, "$.source", errors);

  return { valid: errors.length === 0, errors };
}

export function assertCodeFacts(facts) {
  const result = validateCodeFacts(facts);
  if (!result.valid) {
    const details = result.errors.map((item) => `${item.path}: ${item.message}`).join("; ");
    const failure = new TypeError(`Invalid IntentCanvas Code Facts: ${details}`);
    failure.errors = result.errors;
    throw failure;
  }
  return facts;
}

export function cloneCodeFacts(facts) {
  return structuredClone(assertCodeFacts(facts));
}
