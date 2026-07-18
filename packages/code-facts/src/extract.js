import { basename, resolve } from "node:path";

import { discoverBuildSystems } from "./build-discovery.js";
import {
  CompilationDatabaseError,
  languageForFile,
  locateCompilationDatabases,
  readCompileCommands
} from "./compilation-database.js";
import { ClangUmlError, parseClangUmlJson, readClangUmlJson } from "./clang-uml.js";
import { discoverGitIdentity } from "./git-identity.js";
import { compareText, findExecutable, pathForProject, toPosixPath } from "./path-utils.js";
import {
  diagnostic,
  EXTRACTOR_NAME,
  EXTRACTOR_VERSION,
  extractorSource,
  hashFile,
  sourceFor
} from "./source.js";
import { inventorySourceFiles, SourceInventoryError } from "./source-inventory.js";

export const CODE_FACTS_SCHEMA_VERSION = "1.0.0";
export const CODE_FACTS_KIND = "IntentCanvasCodeFacts";

function compareEdges(left, right) {
  return compareText(left.from, right.from) || compareText(left.to, right.to) ||
    compareText(JSON.stringify(left.location ?? null), JSON.stringify(right.location ?? null));
}

function compareDiagnostics(left, right) {
  return compareText(left.severity, right.severity) || compareText(left.code ?? "", right.code ?? "") ||
    compareText(left.file ?? "", right.file ?? "") || compareText(left.message, right.message);
}

function relativeSource(root, tool, path, version) {
  return sourceFor(tool, {
    version,
    path: path === undefined ? undefined : pathForProject(root, path)
  });
}

function fileFromCommand(command, root, databaseSource) {
  return {
    path: command.projectFile ?? pathForProject(root, command.file),
    language: command.language,
    compile: {
      directory: command.projectDirectory ?? pathForProject(root, command.directory),
      arguments: [...command.arguments],
      includeDirectories: command.includeDirectories.map((include) => ({
        path: include.projectPath ?? pathForProject(root, include.path),
        kind: include.kind
      }))
    },
    confidence: "high",
    source: databaseSource
  };
}

function mergeClangFacts(target, parsed) {
  for (const file of parsed.files) {
    const current = target.files.get(file.path);
    target.files.set(file.path, current === undefined ? file : {
      ...file,
      ...current,
      language: current.language === "unknown" ? file.language : current.language
    });
  }
  for (const symbol of parsed.symbols) target.symbols.set(symbol.id, symbol);
  for (const edge of parsed.includeEdges) {
    target.includeEdges.set(`${edge.from}\0${edge.to}\0${JSON.stringify(edge.location ?? null)}`, edge);
  }
  for (const edge of parsed.callEdges) {
    target.callEdges.set(`${edge.from}\0${edge.to}\0${JSON.stringify(edge.location ?? null)}`, edge);
  }
  target.diagnostics.push(...parsed.diagnostics);
}

function ensureLocationFiles(target, root, clangSource) {
  const locations = [
    ...target.symbols.values(),
    ...target.includeEdges.values(),
    ...target.callEdges.values(),
    ...target.diagnostics
  ].map((value) => value.location).filter(Boolean);
  for (const location of locations) {
    if (location.file === undefined || target.files.has(location.file)) continue;
    target.files.set(location.file, {
      path: location.file,
      language: languageForFile(location.file),
      confidence: "high",
      source: clangSource ?? extractorSource()
    });
  }
}

async function addCompileFileFingerprints(target, absoluteFiles, projectRoot) {
  for (const [factPath, absolutePath] of [...absoluteFiles].sort(([left], [right]) =>
    compareText(left, right))) {
    const file = target.files.get(factPath);
    if (file === undefined || file.fingerprint !== undefined) continue;
    try {
      file.fingerprint = await hashFile(absolutePath, { projectRoot });
    } catch (error) {
      target.diagnostics.push(diagnostic("warning", "source_file_unreadable",
        `The compilation database source file could not be read: ${error.message}`, {
          file: factPath
        }));
    }
  }
}

function extractionArguments(projectRootOrOptions, maybeOptions) {
  if (projectRootOrOptions !== null && typeof projectRootOrOptions === "object" &&
      !Array.isArray(projectRootOrOptions)) {
    const { projectRoot = process.cwd(), ...options } = projectRootOrOptions;
    return { projectRoot, options };
  }
  return { projectRoot: projectRootOrOptions ?? process.cwd(), options: maybeOptions ?? {} };
}

/**
 * Extract a deterministic Code Facts v1 document using read-only inputs.
 *
 * This function never invokes a compiler, build system, or clang-uml. When a
 * semantic JSON input is absent, symbols and edges remain empty and the reason
 * is reported in `diagnostics`.
 */
export async function extractCodeFacts(projectRootOrOptions, maybeOptions) {
  const { projectRoot, options } = extractionArguments(projectRootOrOptions, maybeOptions);
  const root = resolve(projectRoot);
  const target = {
    files: new Map(),
    symbols: new Map(),
    includeEdges: new Map(),
    callEdges: new Map(),
    diagnostics: []
  };
  let buildSystems = [];
  let compilationDatabase = null;
  let compilationLoaded = false;
  let clangLoaded = false;
  let clangSource;
  const compiledSourcePaths = new Set();
  let inventoryComplete = false;
  let inventoryFileCount = 0;

  try {
    buildSystems = await discoverBuildSystems(root, {
      maxDepth: options.buildDiscoveryDepth ?? 2
    });
    if (buildSystems.length === 0) {
      target.diagnostics.push(diagnostic("warning", "build_system_not_detected",
        "No supported build-system marker was found."));
    }
  } catch (error) {
    target.diagnostics.push(diagnostic("error", "build_discovery_failed",
      `Build-system discovery failed: ${error.message}`));
  }

  try {
    const databases = await locateCompilationDatabases(root, {
      compileCommandsPath: options.compileCommandsPath ?? options.compileCommands,
      maxDepth: options.compileCommandsMaxDepth ?? 4
    });
    compilationDatabase = databases[0] ?? null;
    if (databases.length > 1) {
      target.diagnostics.push(diagnostic("info", "multiple_compilation_databases",
        `Found ${databases.length} compilation databases; selected the first deterministic candidate.`));
    }
    if (compilationDatabase === null) {
      target.diagnostics.push(diagnostic("warning", "compile_commands_not_found",
        "compile_commands.json was not found; no compiler commands were inferred."));
    } else {
      const databaseSource = relativeSource(root, "compile_commands", compilationDatabase);
      const commands = await readCompileCommands(compilationDatabase, { projectRoot: root });
      compilationLoaded = true;
      const absoluteFiles = new Map();
      for (const command of commands) {
        const file = fileFromCommand(command, root, databaseSource);
        compiledSourcePaths.add(file.path);
        absoluteFiles.set(file.path, command.file);
        if (!target.files.has(file.path)) target.files.set(file.path, file);
        if (command.responseFiles.length > 0) {
          target.diagnostics.push(diagnostic("warning", "response_file_not_expanded",
            "A compiler response file was present; its hidden include flags were not guessed.", {
              file: file.path,
              source: databaseSource
            }));
        }
      }
      await addCompileFileFingerprints(target, absoluteFiles, root);
    }
  } catch (error) {
    const code = error instanceof CompilationDatabaseError ? error.code : "compile_commands_failed";
    target.diagnostics.push(diagnostic("error", code,
      `Compilation database ingestion failed: ${error.message}`));
  }

  const directClangJson = options.clangUmlJson ??
    (options.clangUml !== null && typeof options.clangUml === "object" ? options.clangUml : undefined);
  const clangPath = options.clangUmlPath ??
    (typeof options.clangUml === "string" ? options.clangUml : undefined);
  if (directClangJson !== undefined || clangPath !== undefined) {
    try {
      let parsed;
      if (directClangJson !== undefined) {
        clangSource = sourceFor("clang-uml", { path: options.clangUmlSourcePath });
        parsed = parseClangUmlJson(directClangJson, {
          projectRoot: root,
          sourcePath: options.clangUmlSourcePath
        });
      } else {
        const absolutePath = resolve(root, clangPath);
        clangSource = relativeSource(root, "clang-uml", absolutePath);
        parsed = await readClangUmlJson(absolutePath, {
          projectRoot: root,
          sourcePath: pathForProject(root, absolutePath)
        });
      }
      mergeClangFacts(target, parsed);
      clangLoaded = true;
    } catch (error) {
      const code = error instanceof ClangUmlError ? error.code : "clang_uml_failed";
      target.diagnostics.push(diagnostic("error", code,
        `clang-uml JSON ingestion failed: ${error.message}`));
    }
  } else {
    const shouldCheckTool = options.checkToolAvailability !== false;
    const executable = shouldCheckTool ? await findExecutable(
      options.clangUmlExecutable ?? "clang-uml",
      { pathValue: options.pathValue ?? process.env.PATH ?? "" }
    ) : undefined;
    if (!shouldCheckTool) {
      target.diagnostics.push(diagnostic("warning", "clang_uml_json_not_provided",
        "No clang-uml JSON was supplied and tool availability was not checked; symbols and semantic edges were left empty rather than guessed."));
    } else if (executable === null) {
      target.diagnostics.push(diagnostic("warning", "clang_uml_unavailable",
        "No clang-uml JSON was supplied and clang-uml was not available; symbols and semantic edges were left empty rather than guessed."));
    } else {
      target.diagnostics.push(diagnostic("info", "clang_uml_json_not_provided",
        "clang-uml is available but no JSON was supplied; it was not run automatically, and symbols and semantic edges were left empty."));
    }
  }

  try {
    const inventory = await inventorySourceFiles(root, {
      ...(options.sourceInventoryMaxFiles === undefined
        ? {} : { maxFiles: options.sourceInventoryMaxFiles }),
      ...(options.sourceInventoryMaxEntries === undefined
        ? {} : { maxEntries: options.sourceInventoryMaxEntries }),
      ...(options.sourceInventoryMaxDepth === undefined
        ? {} : { maxDepth: options.sourceInventoryMaxDepth })
    });
    inventoryComplete = inventory.complete;
    inventoryFileCount = inventory.files.length;
    for (const file of inventory.files) {
      const current = target.files.get(file.path);
      target.files.set(file.path, current === undefined ? file : {
        ...file,
        ...current,
        fingerprint: current.fingerprint ?? file.fingerprint
      });
    }
    for (const item of inventory.diagnostics) {
      target.diagnostics.push(diagnostic(
        "warning",
        item.code,
        item.message,
        item.file === undefined ? {} : { file: item.file }
      ));
    }
  } catch (error) {
    const code = error instanceof SourceInventoryError
      ? error.code
      : "source_inventory_failed";
    target.diagnostics.push(diagnostic(
      "error",
      code,
      `Source inventory failed: ${error.message}`
    ));
  }

  ensureLocationFiles(target, root, clangSource);

  const semanticSourcePaths = new Set(
    [...target.symbols.values()]
      .map((symbol) => symbol.file)
      .filter((path) => compiledSourcePaths.has(path))
  );
  const coverage = {
    sourceInventoryComplete: inventoryComplete,
    semanticInventoryComplete: options.semanticInventoryComplete === true,
    inventoryFileCount,
    compiledSourceCount: compiledSourcePaths.size,
    semanticSourceCount: semanticSourcePaths.size
  };
  const highConfidence = compilationLoaded && clangLoaded && inventoryComplete &&
    coverage.semanticInventoryComplete &&
    compiledSourcePaths.size > 0 && semanticSourcePaths.size === compiledSourcePaths.size;
  const discoveredIdentity = await discoverGitIdentity(root, {
    ...(options.execFileImpl === undefined ? {} : { execFileImpl: options.execFileImpl })
  });
  const projectIdentity = {
    ...discoveredIdentity,
    ...(options.projectRepository === undefined
      ? {} : { repository: options.projectRepository }),
    ...(options.projectBaseRef === undefined
      ? {} : { baseRef: options.projectBaseRef })
  };

  const facts = {
    schemaVersion: CODE_FACTS_SCHEMA_VERSION,
    kind: CODE_FACTS_KIND,
    project: {
      root: toPosixPath(root),
      name: basename(root),
      ...projectIdentity,
      buildSystems: buildSystems.map(({ type, path }) => ({ type, path })),
      ...(compilationDatabase === null
        ? {}
        : { compileCommands: pathForProject(root, compilationDatabase) })
    },
    files: [...target.files.values()].sort((left, right) => compareText(left.path, right.path)),
    symbols: [...target.symbols.values()].sort((left, right) =>
      compareText(left.file, right.file) ||
      (left.location?.line ?? 0) - (right.location?.line ?? 0) ||
      compareText(left.id, right.id)),
    includeEdges: [...target.includeEdges.values()].sort(compareEdges),
    callEdges: [...target.callEdges.values()].sort(compareEdges),
    diagnostics: target.diagnostics.sort(compareDiagnostics),
    coverage,
    confidence: highConfidence ? "high" :
      compilationLoaded || clangLoaded ? "medium" : "low",
    source: extractorSource()
  };
  return facts;
}

export const extract = extractCodeFacts;

export function serializeCodeFacts(facts, { pretty = true } = {}) {
  return `${JSON.stringify(facts, null, pretty ? 2 : 0)}\n`;
}

export const CODE_FACTS_EXTRACTOR = Object.freeze({
  name: EXTRACTOR_NAME,
  version: EXTRACTOR_VERSION
});
