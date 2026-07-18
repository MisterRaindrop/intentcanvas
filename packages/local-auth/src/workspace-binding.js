import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { LocalAuthError } from "./errors.js";

export const WORKSPACE_BINDING_VERSION = 1;
export const DEFAULT_WORKSPACE_BINDING_DIRECTORY = "workspaces";
const MAX_BINDING_BYTES = 4096;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertOwned(metadata, path) {
  const uid = currentUid();
  if (uid !== null && metadata.uid !== uid) {
    throw new LocalAuthError(
      "insecure_workspace_binding_owner",
      `IntentCanvas workspace binding must be owned by the current user: ${path}`,
      { path }
    );
  }
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LocalAuthError(
      "invalid_workspace_binding_directory",
      `IntentCanvas workspace binding path is not a private directory: ${path}`,
      { path }
    );
  }
  if (process.platform !== "win32") {
    assertOwned(metadata, path);
    if ((metadata.mode & 0o077) !== 0) {
      throw new LocalAuthError(
        "insecure_workspace_binding_directory",
        `IntentCanvas workspace binding directory must use mode 0700: ${path}`,
        { path }
      );
    }
  }
}

export function normalizeBoundRuntimeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new LocalAuthError("invalid_workspace_runtime_url", "Workspace Runtime URL is invalid");
  }
  if (!["http:", "https:"].includes(url.protocol) ||
      !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
      url.username || url.password || url.search || url.hash ||
      url.pathname.replace(/\/+$/u, "")) {
    throw new LocalAuthError(
      "invalid_workspace_runtime_url",
      "Workspace Runtime URL must be a loopback HTTP(S) origin"
    );
  }
  return url.origin;
}

async function canonicalWorkspace(cwd, realpathImpl = realpath) {
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new LocalAuthError("invalid_workspace_path", "Workspace path is required");
  }
  try {
    return await realpathImpl(resolve(cwd));
  } catch (error) {
    throw new LocalAuthError(
      "workspace_path_unavailable",
      `Unable to resolve IntentCanvas workspace: ${cwd}`,
      { path: cwd, cause: error }
    );
  }
}

function bindingDirectory({ home = homedir() } = {}) {
  return resolve(home, ".intentcanvas", DEFAULT_WORKSPACE_BINDING_DIRECTORY);
}

function bindingPath(directory, canonicalCwd) {
  const digest = createHash("sha256").update(canonicalCwd, "utf8").digest("hex");
  return resolve(directory, `${digest}.json`);
}

function validateBinding(value, expectedCwd) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) =>
        !["version", "cwd", "reviewId", "runtimeUrl"].includes(key)) ||
      value.version !== WORKSPACE_BINDING_VERSION || value.cwd !== expectedCwd ||
      typeof value.reviewId !== "string" || !SAFE_ID.test(value.reviewId)) {
    throw new LocalAuthError(
      "invalid_workspace_binding",
      "IntentCanvas workspace binding is invalid"
    );
  }
  return {
    version: WORKSPACE_BINDING_VERSION,
    cwd: expectedCwd,
    reviewId: value.reviewId,
    runtimeUrl: normalizeBoundRuntimeUrl(value.runtimeUrl)
  };
}

export async function writeWorkspaceBinding({ cwd, reviewId, runtimeUrl }, options = {}) {
  const canonicalCwd = await canonicalWorkspace(cwd, options.realpathImpl);
  const binding = validateBinding({
    version: WORKSPACE_BINDING_VERSION,
    cwd: canonicalCwd,
    reviewId,
    runtimeUrl
  }, canonicalCwd);
  const directory = bindingDirectory(options);
  await ensurePrivateDirectory(dirname(directory));
  await ensurePrivateDirectory(directory);
  const destination = bindingPath(directory, canonicalCwd);
  const temporary = `${destination}.${randomBytes(12).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(binding)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, destination);
    if (process.platform !== "win32") await chmod(destination, 0o600);
    return binding;
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // Preserve the original failure.
    }
    try {
      await unlink(temporary);
    } catch {
      // The temporary file may not have been created or may already be gone.
    }
    throw error instanceof LocalAuthError
      ? error
      : new LocalAuthError(
        "workspace_binding_write_failed",
        `Unable to write IntentCanvas workspace binding at ${destination}`,
        { path: destination, cause: error }
      );
  }
}

export async function readWorkspaceBinding(cwd, options = {}) {
  const canonicalCwd = await canonicalWorkspace(cwd, options.realpathImpl);
  const directory = bindingDirectory(options);
  const path = bindingPath(directory, canonicalCwd);
  let handle;
  try {
    const flags = process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    handle = await open(path, flags);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new LocalAuthError(
      "workspace_binding_read_failed",
      `Unable to read IntentCanvas workspace binding at ${path}`,
      { path, cause: error }
    );
  }

  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_BINDING_BYTES ||
        (process.platform !== "win32" && metadata.nlink !== 1)) {
      throw new LocalAuthError(
        "invalid_workspace_binding",
        `IntentCanvas workspace binding must be a small regular file: ${path}`,
        { path }
      );
    }
    if (process.platform !== "win32") {
      assertOwned(metadata, path);
      if ((metadata.mode & 0o077) !== 0) {
        throw new LocalAuthError(
          "insecure_workspace_binding_file",
          `IntentCanvas workspace binding must use mode 0600: ${path}`,
          { path }
        );
      }
    }
    const source = await handle.readFile("utf8");
    return validateBinding(JSON.parse(source), canonicalCwd);
  } catch (error) {
    if (error instanceof LocalAuthError) throw error;
    throw new LocalAuthError(
      "invalid_workspace_binding",
      `IntentCanvas workspace binding is not valid JSON: ${path}`,
      { path, cause: error }
    );
  } finally {
    await handle.close();
  }
}

export async function removeWorkspaceBinding(cwd, options = {}) {
  const binding = await readWorkspaceBinding(cwd, options);
  if (binding === null) return null;
  const directory = bindingDirectory(options);
  const path = bindingPath(directory, binding.cwd);
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new LocalAuthError(
      "workspace_binding_remove_failed",
      `Unable to remove IntentCanvas workspace binding at ${path}`,
      { path, cause: error }
    );
  }
  return binding;
}
