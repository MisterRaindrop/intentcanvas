import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

import { compareText, pathForProject, toPosixPath } from "./path-utils.js";
import {
  MAX_ANALYSIS_INPUT_BYTES,
  readBoundedRegularFile,
  resolveContainedRegularPath,
  SourceBoundaryError
} from "./source.js";

const DATABASE_NAME = "compile_commands.json";
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "third_party",
  "vendor"
]);

const INCLUDE_FLAGS = new Map([
  ["-I", "user"],
  ["/I", "user"],
  ["-isystem", "system"],
  ["-internal-isystem", "system"],
  ["-internal-externc-isystem", "system"],
  ["-imsvc", "system"],
  ["/imsvc", "system"],
  ["/external:I", "system"],
  ["-iquote", "quote"],
  ["-idirafter", "after"],
  ["-F", "framework"],
  ["-iframework", "framework"]
]);

export class CompilationDatabaseError extends Error {
  constructor(message, { code = "invalid_compilation_database", path, index } = {}) {
    super(message);
    this.name = "CompilationDatabaseError";
    this.code = code;
    if (path !== undefined) this.path = path;
    if (index !== undefined) this.index = index;
  }
}

function windowsAbsolute(value) {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
}

function normalizeCommandPath(base, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CompilationDatabaseError("path values must be non-empty strings");
  }
  const clean = value.trim();
  if (windowsAbsolute(clean) || windowsAbsolute(base)) {
    return win32.resolve(base.replaceAll("/", "\\"), clean).replaceAll("\\", "/");
  }
  return toPosixPath(isAbsolute(clean) ? resolve(clean) : resolve(base, clean));
}

/** Split the POSIX-style `command` form from a compilation database safely. */
export function tokenizeCommand(command) {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new CompilationDatabaseError("command must be a non-empty string");
  }

  const words = [];
  let word = "";
  let quote = null;
  let started = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const next = command[index + 1];

    if (quote === "'") {
      if (character === "'") quote = null;
      else word += character;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null;
      } else if (character === "\\" && ['"', "\\", "$", "`"].includes(next)) {
        word += next;
        index += 1;
      } else {
        word += character;
      }
      started = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else if (character === "\\" && next !== undefined &&
               (/\s/u.test(next) || ['"', "'", "\\"].includes(next))) {
      word += next;
      index += 1;
      started = true;
    } else {
      word += character;
      started = true;
    }
  }

  if (quote !== null) {
    throw new CompilationDatabaseError("command contains an unterminated quote", {
      code: "invalid_command"
    });
  }
  if (started) words.push(word);
  if (words.length === 0) {
    throw new CompilationDatabaseError("command did not contain any arguments", {
      code: "invalid_command"
    });
  }
  return words;
}

function argumentsFor(entry) {
  if (Array.isArray(entry.arguments)) {
    if (entry.arguments.length === 0 ||
        entry.arguments.some((argument) => typeof argument !== "string")) {
      throw new CompilationDatabaseError("arguments must contain only strings", {
        code: "invalid_arguments"
      });
    }
    return [...entry.arguments];
  }
  return tokenizeCommand(entry.command);
}

function inlineInclude(argument) {
  for (const [flag, kind] of INCLUDE_FLAGS) {
    if (argument === flag) continue;
    if (argument.startsWith(`${flag}=`)) {
      return { kind, value: argument.slice(flag.length + 1), flag };
    }
    if (argument.startsWith(flag)) {
      return { kind, value: argument.slice(flag.length), flag };
    }
  }
  return null;
}

function includeDirectories(arguments_, directory) {
  const includes = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const separateKind = INCLUDE_FLAGS.get(argument);
    if (separateKind !== undefined) {
      const value = arguments_[index + 1];
      if (typeof value !== "string" || value.length === 0) {
        throw new CompilationDatabaseError(`${argument} must be followed by an include path`, {
          code: "missing_include_path"
        });
      }
      includes.push({ path: normalizeCommandPath(directory, value), kind: separateKind });
      index += 1;
      continue;
    }
    const inline = inlineInclude(argument);
    if (inline?.value) {
      includes.push({ path: normalizeCommandPath(directory, inline.value), kind: inline.kind });
    }
  }

  const unique = new Map();
  for (const include of includes) unique.set(`${include.kind}\0${include.path}`, include);
  return [...unique.values()].sort((left, right) =>
    compareText(left.path, right.path) || compareText(left.kind, right.kind));
}

export function languageForFile(file) {
  if (file.endsWith(".C")) return "c++";
  if (file.endsWith(".S")) return "assembly-with-cpp";
  const lower = file.toLowerCase();
  if (lower.endsWith(".mm")) return "objective-c++";
  if (lower.endsWith(".cu") || lower.endsWith(".cuh")) return "cuda";
  if (lower.endsWith(".c")) return "c";
  if ([".cc", ".cp", ".cpp", ".cxx", ".c++", ".ixx", ".cppm"]
    .some((extension) => lower.endsWith(extension))) {
    return "c++";
  }
  if (lower.endsWith(".m")) return "objective-c";
  if ([".h", ".hh", ".hpp", ".hxx", ".inc"].some((extension) => lower.endsWith(extension))) {
    return "c/c++-header";
  }
  if (lower.endsWith(".s") || lower.endsWith(".asm")) return "assembly";
  return "unknown";
}

/** Normalize one compile_commands.json entry without executing its command. */
export function normalizeCompileCommand(entry, {
  databaseDirectory = process.cwd(),
  projectRoot
} = {}) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new CompilationDatabaseError("each compilation database entry must be an object");
  }
  if (typeof entry.file !== "string" || entry.file.trim().length === 0) {
    throw new CompilationDatabaseError("each compilation database entry must have a file", {
      code: "missing_file"
    });
  }

  const directory = normalizeCommandPath(databaseDirectory, entry.directory ?? databaseDirectory);
  const file = normalizeCommandPath(directory, entry.file);
  const arguments_ = argumentsFor(entry);
  const normalized = {
    directory,
    file,
    sourceFile: file,
    arguments: arguments_,
    includeDirectories: includeDirectories(arguments_, directory),
    responseFiles: arguments_
      .filter((argument) => argument.startsWith("@") && argument.length > 1)
      .map((argument) => normalizeCommandPath(directory, argument.slice(1)))
      .sort(compareText),
    language: languageForFile(file)
  };
  if (entry.output !== undefined) normalized.output = normalizeCommandPath(directory, entry.output);
  if (projectRoot !== undefined) {
    normalized.projectFile = pathForProject(projectRoot, file);
    normalized.projectDirectory = pathForProject(projectRoot, directory);
    normalized.includeDirectories = normalized.includeDirectories.map((include) => ({
      ...include,
      projectPath: pathForProject(projectRoot, include.path)
    }));
  }
  return normalized;
}

export function normalizeCompileCommands(entries, options = {}) {
  if (!Array.isArray(entries)) {
    throw new CompilationDatabaseError("compilation commands must be a JSON array");
  }
  return entries.map((entry, index) => {
    try {
      return normalizeCompileCommand(entry, options);
    } catch (error) {
      if (error instanceof CompilationDatabaseError) error.index ??= index;
      throw error;
    }
  }).sort((left, right) => compareText(left.file, right.file) ||
    compareText(left.directory, right.directory) ||
    compareText(JSON.stringify(left.arguments), JSON.stringify(right.arguments)));
}

async function walkForDatabases(directory, depth, maxDepth, found) {
  let entries;
  try {
    entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareText(left.name, right.name));
  } catch (error) {
    if (["EACCES", "EPERM", "ENOENT"].includes(error.code)) return;
    throw error;
  }
  for (const entry of entries) {
    if ((entry.isFile() || entry.isSymbolicLink()) && entry.name === DATABASE_NAME) {
      found.push(join(directory, entry.name));
    }
  }
  if (depth >= maxDepth) return;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    await walkForDatabases(join(directory, entry.name), depth + 1, maxDepth, found);
  }
}

function databaseRank(projectRoot, path) {
  const projectRelative = relative(projectRoot, path).split(sep).join("/");
  if (projectRelative === DATABASE_NAME) return 0;
  const first = projectRelative.split("/")[0];
  if (first === "build") return 10;
  if (first.startsWith("cmake-build-")) return 20;
  if (first === "out") return 30;
  return 100 + projectRelative.split("/").length;
}

/** Locate all compile_commands.json files, ordered by a stable preference. */
export async function locateCompilationDatabases(projectRoot, {
  compileCommandsPath,
  maxDepth = 4
} = {}) {
  const root = resolve(projectRoot);
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new TypeError("maxDepth must be a non-negative integer");
  }
  if (compileCommandsPath !== undefined) {
    let explicit = resolve(root, compileCommandsPath);
    try {
      if ((await stat(explicit)).isDirectory()) explicit = join(explicit, DATABASE_NAME);
      if ((await stat(explicit)).isFile()) return [explicit];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return [];
  }

  const found = [];
  await walkForDatabases(root, 0, maxDepth, found);
  return [...new Set(found)].sort((left, right) =>
    databaseRank(root, left) - databaseRank(root, right) || compareText(left, right));
}

export async function findCompileCommands(projectRoot, options) {
  return (await locateCompilationDatabases(projectRoot, options))[0] ?? null;
}

export const findCompileCommandsFiles = locateCompilationDatabases;

/** Read and normalize every command in a compilation database. */
export async function readCompileCommands(path, { projectRoot, databaseRoot } = {}) {
  const databasePath = resolve(path);
  const root = await realpath(resolve(projectRoot ?? dirname(databasePath)));
  const trustedDatabaseRoot = await realpath(resolve(databaseRoot ?? root));
  let parsed;
  let canonicalDatabasePath;
  try {
    canonicalDatabasePath = await resolveContainedRegularPath(
      trustedDatabaseRoot,
      databasePath
    );
    const text = (await readBoundedRegularFile(canonicalDatabasePath, {
      maxBytes: MAX_ANALYSIS_INPUT_BYTES,
      encoding: "utf8"
    })).replace(/^\uFEFF/u, "");
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CompilationDatabaseError(`Unable to read ${databasePath}: ${error.message}`, {
      code: error instanceof SyntaxError
        ? "invalid_json"
        : error instanceof SourceBoundaryError ? error.code : "read_failed",
      path: databasePath
    });
  }
  if (!Array.isArray(parsed)) {
    throw new CompilationDatabaseError("compile_commands.json must contain a JSON array", {
      path: databasePath
    });
  }

  try {
    const commands = normalizeCompileCommands(parsed, {
      databaseDirectory: dirname(canonicalDatabasePath),
      projectRoot: root
    });
    for (const command of commands) {
      const canonicalFile = await resolveContainedRegularPath(root, command.file);
      command.file = toPosixPath(canonicalFile);
      command.sourceFile = command.file;
      command.projectFile = pathForProject(root, canonicalFile);
    }
    return commands.sort((left, right) => compareText(left.file, right.file) ||
      compareText(left.directory, right.directory) ||
      compareText(JSON.stringify(left.arguments), JSON.stringify(right.arguments)));
  } catch (error) {
    if (error instanceof CompilationDatabaseError) {
      error.path ??= databasePath;
      throw error;
    }
    if (error instanceof SourceBoundaryError) {
      throw new CompilationDatabaseError(error.message, {
        code: error.code,
        path: error.path ?? databasePath
      });
    }
    throw error;
  }
}

export async function loadCompilationDatabase(path, options = {}) {
  const databasePath = resolve(path);
  return {
    path: databasePath,
    directory: dirname(databasePath),
    commands: await readCompileCommands(databasePath, options)
  };
}

export const readCompilationDatabase = loadCompilationDatabase;
export const COMPILE_COMMANDS_FILENAME = DATABASE_NAME;
