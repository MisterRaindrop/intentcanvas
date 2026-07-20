import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const EXTRACTOR_NAME = "@intentcanvas/code-facts";
export const EXTRACTOR_VERSION = "0.3.0";
export const MAX_SOURCE_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ANALYSIS_INPUT_BYTES = 64 * 1024 * 1024;

export class SourceBoundaryError extends Error {
  constructor(code, message, { path } = {}) {
    super(message);
    this.name = "SourceBoundaryError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

export function extractorSource(path) {
  return path === undefined
    ? { tool: EXTRACTOR_NAME, version: EXTRACTOR_VERSION }
    : { tool: EXTRACTOR_NAME, version: EXTRACTOR_VERSION, path };
}

export function sourceFor(tool, { version, path } = {}) {
  const source = { tool };
  if (version !== undefined) source.version = String(version);
  if (path !== undefined) source.path = path;
  return source;
}

export function hashValue(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function resolveContainedRegularPath(projectRoot, candidate) {
  const root = await realpath(resolve(projectRoot));
  let canonical;
  try {
    canonical = await realpath(resolve(candidate));
  } catch (error) {
    throw new SourceBoundaryError(
      "source_path_unavailable",
      "Analysis input is unavailable inside the project",
      { path: candidate, cause: error }
    );
  }
  const projectRelative = relative(root, canonical);
  if (projectRelative === ".." || projectRelative.startsWith(`..${sep}`) ||
      isAbsolute(projectRelative)) {
    throw new SourceBoundaryError(
      "source_outside_project",
      "Analysis input must stay inside the project root",
      { path: candidate }
    );
  }
  return canonical;
}

export async function readBoundedRegularFile(path, {
  maxBytes = MAX_ANALYSIS_INPUT_BYTES,
  encoding
} = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive integer");
  }
  let handle;
  try {
    const flags = constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0);
    handle = await open(path, flags);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new SourceBoundaryError(
        "analysis_input_not_regular",
        `Analysis input must be a regular file: ${path}`,
        { path }
      );
    }
    if (metadata.size > maxBytes) {
      throw new SourceBoundaryError(
        "analysis_input_too_large",
        `Analysis input exceeds ${maxBytes} bytes: ${path}`,
        { path }
      );
    }
    return handle.readFile(encoding === undefined ? undefined : { encoding });
  } finally {
    await handle?.close();
  }
}

export async function hashFile(path, options = {}) {
  const canonical = options.projectRoot === undefined
    ? resolve(path)
    : await resolveContainedRegularPath(options.projectRoot, path);
  return hashValue(await readBoundedRegularFile(canonical, {
    maxBytes: options.maxBytes ?? MAX_SOURCE_FILE_BYTES
  }));
}

export function diagnostic(severity, code, message, options = {}) {
  const value = {
    severity,
    code,
    message,
    confidence: options.confidence ?? "high",
    source: options.source ?? extractorSource()
  };
  if (options.file !== undefined) value.file = options.file;
  if (options.location !== undefined) value.location = options.location;
  return value;
}
