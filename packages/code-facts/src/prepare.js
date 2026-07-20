import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { discoverBuildSystems } from "./build-discovery.js";
import { locateCompilationDatabases } from "./compilation-database.js";
import { extractCodeFacts } from "./extract.js";
import { findExecutable } from "./path-utils.js";
import {
  MAX_ANALYSIS_INPUT_BYTES,
  readBoundedRegularFile
} from "./source.js";

const execFile = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TOOL_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_LOG_CHARS = 16 * 1024;
const SOURCE_GLOB = ".*\\.(?:c|cc|cp|cpp|cxx|c\\+\\+|C|m|mm)$";

export class EvidencePreparationError extends Error {
  constructor(message, { code = "evidence_preparation_failed", details = [] } = {}) {
    super(message);
    this.name = "EvidencePreparationError";
    this.code = code;
    this.details = details;
  }
}

function workspaceKey(projectRoot) {
  return createHash("sha256").update(projectRoot).digest("hex").slice(0, 32);
}

export function defaultEvidenceDirectory(projectRoot, {
  home = homedir()
} = {}) {
  return join(resolve(home), ".intentcanvas", "evidence", workspaceKey(resolve(projectRoot)));
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

export function createClangUmlConfig({
  projectRoot,
  compileCommandsPath,
  outputDirectory
}) {
  return [
    `compilation_database_dir: ${yamlString(dirname(compileCommandsPath))}`,
    `output_directory: ${yamlString(outputDirectory)}`,
    `relative_to: ${yamlString(projectRoot)}`,
    "generate_method_arguments: full",
    "diagrams:",
    "  intentcanvas_classes:",
    "    type: class",
    "    generate_packages: true",
    "    package_type: directory",
    "    glob:",
    `      - r: ${yamlString(SOURCE_GLOB)}`,
    "  intentcanvas_includes:",
    "    type: include",
    "    glob:",
    `      - r: ${yamlString(SOURCE_GLOB)}`,
    ""
  ].join("\n");
}

async function resolveExecutable(name, options) {
  return findExecutable(name, {
    pathValue: options.pathValue ?? options.env?.PATH ?? process.env.PATH ?? "",
    platform: options.platform ?? process.platform
  });
}

function commandRecord(purpose, executable, args, cwd) {
  return {
    purpose,
    executable,
    args: [...args],
    cwd
  };
}

export async function planEvidencePreparation(projectRoot, options = {}) {
  const root = await realpath(resolve(projectRoot));
  const workDirectory = resolve(
    options.workDirectory ?? defaultEvidenceDirectory(root, { home: options.home })
  );
  const buildSystems = await discoverBuildSystems(root, {
    maxDepth: options.buildDiscoveryDepth ?? 2
  });
  const existingDatabases = await locateCompilationDatabases(root, {
    compileCommandsPath: options.compileCommandsPath,
    maxDepth: options.compileCommandsMaxDepth ?? 4
  });
  const commands = [];
  let compileCommandsPath = existingDatabases[0] ?? null;
  let compilationDatabaseRoot = root;
  let generatedCompilationDatabase = false;

  if (compileCommandsPath === null) {
    const cmake = buildSystems.find((system) => system.type === "cmake");
    if (!cmake) {
      throw new EvidencePreparationError(
        "No compilation database was found and automatic generation currently supports CMake projects only",
        {
          code: "automatic_compile_database_unsupported",
          details: buildSystems.map((system) => ({ type: system.type, path: system.path }))
        }
      );
    }
    const cmakeExecutable = await resolveExecutable(
      options.cmakeExecutable ?? "cmake",
      options
    );
    if (cmakeExecutable === null) {
      throw new EvidencePreparationError(
        "CMake is required to generate compile_commands.json but was not found",
        { code: "cmake_unavailable" }
      );
    }
    const sourceDirectory = dirname(resolve(root, cmake.path));
    const buildDirectory = join(workDirectory, "cmake-build");
    compileCommandsPath = join(buildDirectory, "compile_commands.json");
    compilationDatabaseRoot = workDirectory;
    generatedCompilationDatabase = true;
    commands.push(commandRecord(
      "generate_compile_commands",
      cmakeExecutable,
      [
        "-S", sourceDirectory,
        "-B", buildDirectory,
        "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
        "-DCMAKE_BUILD_TYPE=Debug"
      ],
      root
    ));
  }

  let clangUml = null;
  if (options.runClangUml !== false) {
    const clangUmlExecutable = await resolveExecutable(
      options.clangUmlExecutable ?? "clang-uml",
      options
    );
    if (clangUmlExecutable !== null) {
      const configPath = join(workDirectory, "clang-uml.yml");
      const outputDirectory = join(workDirectory, "clang-uml");
      clangUml = { executable: clangUmlExecutable, configPath, outputDirectory };
      commands.push(commandRecord(
        "extract_clang_uml_json",
        clangUmlExecutable,
        ["-c", configPath, "-g", "json"],
        root
      ));
    }
  }

  return {
    schemaVersion: "1.0.0",
    kind: "IntentCanvasEvidencePreparationPlan",
    projectRoot: root,
    workDirectory,
    compileCommandsPath,
    compilationDatabaseRoot,
    generatedCompilationDatabase,
    buildSystems: buildSystems.map(({ type, name, path }) => ({ type, name, path })),
    clangUml,
    commands,
    warnings: clangUml === null && options.runClangUml !== false
      ? ["clang-uml was not found; preparation can still produce file and compiler facts."]
      : []
  };
}

async function defaultRunTool(executable, args, options) {
  return execFile(executable, args, options);
}

function boundedLog(value) {
  const text = String(value ?? "");
  return text.length <= MAX_MANIFEST_LOG_CHARS
    ? text
    : `${text.slice(0, MAX_MANIFEST_LOG_CHARS)}\n[output truncated]\n`;
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function writePrivate(path, contents) {
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function readGeneratedClangJson(outputDirectory) {
  const entries = (await readdir(outputDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (entries.length === 0) {
    throw new EvidencePreparationError(
      "clang-uml completed without producing JSON diagrams",
      { code: "clang_uml_output_missing" }
    );
  }
  if (entries.length > 32) {
    throw new EvidencePreparationError(
      "clang-uml produced too many JSON files",
      { code: "clang_uml_output_excessive" }
    );
  }
  const diagrams = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const source = await readBoundedRegularFile(join(outputDirectory, entry.name), {
      maxBytes: MAX_ANALYSIS_INPUT_BYTES,
      encoding: "utf8"
    });
    totalBytes += Buffer.byteLength(source);
    if (totalBytes > MAX_ANALYSIS_INPUT_BYTES) {
      throw new EvidencePreparationError(
        "Combined clang-uml JSON exceeds the analysis limit",
        { code: "clang_uml_output_too_large" }
      );
    }
    try {
      diagrams.push(JSON.parse(source));
    } catch {
      throw new EvidencePreparationError(
        `clang-uml produced invalid JSON: ${entry.name}`,
        { code: "clang_uml_output_invalid" }
      );
    }
  }
  return { diagrams, files: entries.map((entry) => entry.name) };
}

export async function prepareCodeFacts(projectRoot, options = {}) {
  const plan = await planEvidencePreparation(projectRoot, options);
  if (options.dryRun === true) return { plan, manifest: null, facts: null };

  await ensurePrivateDirectory(plan.workDirectory);
  const runs = [];
  const runTool = options.runTool ?? defaultRunTool;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new TypeError("timeoutMs must be a positive integer");
  }

  for (const command of plan.commands) {
    if (command.purpose === "extract_clang_uml_json") {
      await ensurePrivateDirectory(plan.clangUml.outputDirectory);
      await writePrivate(plan.clangUml.configPath, createClangUmlConfig({
        projectRoot: plan.projectRoot,
        compileCommandsPath: plan.compileCommandsPath,
        outputDirectory: plan.clangUml.outputDirectory
      }));
    } else if (command.purpose === "generate_compile_commands") {
      await ensurePrivateDirectory(dirname(plan.compileCommandsPath));
    }

    let result;
    const startedAt = new Date().toISOString();
    try {
      result = await runTool(command.executable, command.args, {
        cwd: command.cwd,
        env: options.env ?? process.env,
        timeout,
        maxBuffer: MAX_TOOL_OUTPUT_BYTES,
        windowsHide: true
      });
    } catch (error) {
      throw new EvidencePreparationError(
        `${command.purpose} failed: ${error.message}`,
        {
          code: `${command.purpose}_failed`,
          details: [{
            purpose: command.purpose,
            exitCode: error.code ?? null,
            stdout: boundedLog(error.stdout),
            stderr: boundedLog(error.stderr)
          }]
        }
      );
    }
    runs.push({
      purpose: command.purpose,
      executable: command.executable,
      args: command.args,
      cwd: command.cwd,
      startedAt,
      completedAt: new Date().toISOString(),
      stdout: boundedLog(result?.stdout),
      stderr: boundedLog(result?.stderr)
    });
    if (command.purpose === "generate_compile_commands") {
      let metadata;
      try {
        metadata = await stat(plan.compileCommandsPath);
      } catch {
        metadata = null;
      }
      if (!metadata?.isFile()) {
        throw new EvidencePreparationError(
          "CMake completed without producing compile_commands.json",
          { code: "compile_commands_output_missing" }
        );
      }
    }
  }

  let combinedClangJson;
  let clangFiles = [];
  let combinedClangPath;
  if (plan.clangUml !== null) {
    const generated = await readGeneratedClangJson(plan.clangUml.outputDirectory);
    combinedClangJson = { diagrams: generated.diagrams };
    clangFiles = generated.files;
    combinedClangPath = join(plan.workDirectory, "clang-uml-combined.json");
    await writePrivate(combinedClangPath, `${JSON.stringify(combinedClangJson, null, 2)}\n`);
  }

  const facts = await extractCodeFacts(plan.projectRoot, {
    compileCommandsPath: plan.compileCommandsPath,
    compilationDatabaseRoot: plan.compilationDatabaseRoot,
    ...(combinedClangJson === undefined
      ? { checkToolAvailability: false }
      : {
          clangUmlJson: combinedClangJson,
          clangUmlSourcePath: combinedClangPath,
          semanticInventoryComplete: false
        })
  });
  const manifest = {
    schemaVersion: "1.0.0",
    kind: "IntentCanvasEvidencePreparationManifest",
    generatedAt: new Date().toISOString(),
    plan,
    runs,
    outputs: {
      compileCommands: plan.compileCommandsPath,
      clangUml: clangFiles,
      confidence: facts.confidence,
      coverage: facts.coverage
    }
  };
  const manifestPath = join(plan.workDirectory, "manifest.json");
  await writePrivate(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { plan, manifest, manifestPath, facts };
}

export const PREPARATION_DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
