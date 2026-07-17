import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const EXTRACTOR_NAME = "@intentcanvas/code-facts";
export const EXTRACTOR_VERSION = "0.2.0";

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

export async function hashFile(path) {
  return hashValue(await readFile(path));
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
