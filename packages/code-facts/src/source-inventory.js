import { opendir, realpath } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

import { languageForFile } from "./compilation-database.js";
import { compareText, toPosixPath } from "./path-utils.js";
import { hashFile, sourceFor } from "./source.js";

export const DEFAULT_SOURCE_INVENTORY_LIMIT = 20_000;
const DEFAULT_ENTRY_LIMIT = 100_000;
const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".inc", ".inl",
  ".ipp", ".tcc"
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".idea", ".vscode", "build", "cmake-build-debug",
  "cmake-build-release", "dist", "node_modules", "out", "target", "third_party", "vendor"
]);

export class SourceInventoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SourceInventoryError";
    this.code = code;
  }
}

function isSourceFile(name) {
  return SOURCE_EXTENSIONS.has(extname(name).toLowerCase());
}

export async function inventorySourceFiles(projectRoot, {
  maxFiles = DEFAULT_SOURCE_INVENTORY_LIMIT,
  maxEntries = DEFAULT_ENTRY_LIMIT,
  maxDepth = 64
} = {}) {
  if (!Number.isInteger(maxFiles) || maxFiles < 1 ||
      !Number.isInteger(maxEntries) || maxEntries < 1 ||
      !Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new TypeError("source inventory limits must be positive integers");
  }
  const root = await realpath(resolve(projectRoot));
  const files = [];
  const diagnostics = [];
  let entries = 0;
  let complete = true;
  let skippedSymlinks = 0;

  async function visit(directory, depth) {
    if (depth > maxDepth) {
      throw new SourceInventoryError(
        "source_inventory_depth_exceeded",
        `Source inventory exceeded maximum depth ${maxDepth}`
      );
    }
    const handle = await opendir(directory);
    for await (const entry of handle) {
      entries += 1;
      if (entries > maxEntries) {
        throw new SourceInventoryError(
          "source_inventory_entry_limit",
          `Source inventory exceeded ${maxEntries} directory entries`
        );
      }
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (isSourceFile(entry.name) || extname(entry.name) === "") {
          skippedSymlinks += 1;
          complete = false;
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isSourceFile(entry.name)) continue;
      if (files.length >= maxFiles) {
        throw new SourceInventoryError(
          "source_inventory_file_limit",
          `Source inventory exceeded ${maxFiles} C/C++ files`
        );
      }
      const path = toPosixPath(relative(root, absolutePath));
      const file = {
        path,
        language: languageForFile(path),
        confidence: "high",
        source: sourceFor("filesystem", { path })
      };
      try {
        file.fingerprint = await hashFile(absolutePath, { projectRoot: root });
      } catch (error) {
        complete = false;
        diagnostics.push({
          code: "source_inventory_file_unreadable",
          message: `Could not fingerprint ${path}: ${error.message}`,
          file: path
        });
      }
      files.push(file);
    }
  }

  await visit(root, 0);
  if (skippedSymlinks > 0) {
    diagnostics.push({
      code: "source_inventory_symlinks_skipped",
      message: `Skipped ${skippedSymlinks} symbolic links while inventorying source files.`
    });
  }
  return {
    root,
    files: files.sort((left, right) => compareText(left.path, right.path)),
    complete,
    diagnostics
  };
}
