import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { LocalAuthError } from "./errors.js";

export { LocalAuthError } from "./errors.js";

export const AUTH_TOKEN_ENV = "INTENTCANVAS_AUTH_TOKEN";
export const AUTH_TOKEN_FILE_ENV = "INTENTCANVAS_AUTH_TOKEN_FILE";
export const DEFAULT_AUTH_DIRECTORY = ".intentcanvas";
export const DEFAULT_AUTH_TOKEN_FILE = "auth-token";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
const IDENTITY_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const IDENTITY_PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const RUNTIME_IDENTITY_CONTEXT = "intentcanvas-runtime-identity-v1\0";
const MAX_TOKEN_FILE_BYTES = 1024;

export function validateAuthToken(value) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new LocalAuthError(
      "invalid_auth_token",
      "IntentCanvas auth token must be 43-128 base64url characters"
    );
  }
  return value;
}

export function generateAuthToken(randomBytesImpl = randomBytes) {
  return validateAuthToken(randomBytesImpl(32).toString("base64url"));
}

export function createRuntimeIdentityChallenge(randomBytesImpl = randomBytes) {
  const challenge = randomBytesImpl(32).toString("base64url");
  if (!IDENTITY_CHALLENGE_PATTERN.test(challenge)) {
    throw new LocalAuthError(
      "invalid_runtime_identity_challenge",
      "IntentCanvas Runtime identity challenge must be 32 random bytes"
    );
  }
  return challenge;
}

export function runtimeIdentityProof(token, challenge) {
  validateAuthToken(token);
  if (typeof challenge !== "string" || !IDENTITY_CHALLENGE_PATTERN.test(challenge)) {
    throw new LocalAuthError(
      "invalid_runtime_identity_challenge",
      "IntentCanvas Runtime identity challenge is invalid"
    );
  }
  return createHmac("sha256", token)
    .update(`${RUNTIME_IDENTITY_CONTEXT}${challenge}`, "utf8")
    .digest("base64url");
}

export function verifyRuntimeIdentityProof(token, challenge, proof) {
  let expected;
  try {
    expected = runtimeIdentityProof(token, challenge);
  } catch {
    return false;
  }
  if (typeof proof !== "string" || !IDENTITY_PROOF_PATTERN.test(proof)) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const proofBytes = Buffer.from(proof, "utf8");
  return expectedBytes.length === proofBytes.length && timingSafeEqual(expectedBytes, proofBytes);
}

export function resolveAuthTokenFile({
  env = process.env,
  home = homedir()
} = {}) {
  const configured = env[AUTH_TOKEN_FILE_ENV];
  if (typeof configured === "string" && configured.trim()) {
    return resolve(configured.trim());
  }
  return resolve(home, DEFAULT_AUTH_DIRECTORY, DEFAULT_AUTH_TOKEN_FILE);
}

function currentUid(getuidImpl) {
  return typeof getuidImpl === "function" ? getuidImpl() : null;
}

function assertOwnedByCurrentUser(metadata, path, getuidImpl, kind) {
  const uid = currentUid(getuidImpl);
  if (uid !== null && metadata.uid !== uid) {
    throw new LocalAuthError(
      `insecure_auth_token_${kind}`,
      `IntentCanvas auth token ${kind} must be owned by the current user: ${path}`,
      { path }
    );
  }
}

async function assertSecureTokenDirectory(path, {
  statImpl = lstat,
  platform = process.platform,
  getuidImpl = typeof process.getuid === "function" ? process.getuid.bind(process) : null
} = {}) {
  if (platform === "win32") return;
  const directoryPath = dirname(path);
  let metadata;
  try {
    metadata = await statImpl(directoryPath);
  } catch (error) {
    throw new LocalAuthError(
      "auth_token_directory_check_failed",
      `Unable to inspect IntentCanvas auth token directory at ${directoryPath}`,
      { path: directoryPath, cause: error }
    );
  }
  if (!metadata.isDirectory()) {
    throw new LocalAuthError(
      "invalid_auth_token_directory",
      `IntentCanvas auth token parent is not a directory: ${directoryPath}`,
      { path: directoryPath }
    );
  }
  assertOwnedByCurrentUser(metadata, directoryPath, getuidImpl, "directory");
  if ((metadata.mode & 0o077) !== 0) {
    throw new LocalAuthError(
      "insecure_auth_token_directory",
      `IntentCanvas auth token directory must not be accessible by group or other users: ${directoryPath}`,
      { path: directoryPath }
    );
  }
}

async function readSecureTokenFile(path, {
  openImpl = open,
  platform = process.platform,
  getuidImpl = typeof process.getuid === "function" ? process.getuid.bind(process) : null,
  ...directoryOptions
} = {}) {
  let handle;
  try {
    const flags = platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    handle = await openImpl(path, flags);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") {
      throw new LocalAuthError(
        "invalid_auth_token_file",
        `IntentCanvas auth token path must not be a symbolic link: ${path}`,
        { path, cause: error }
      );
    }
    throw new LocalAuthError(
      "auth_token_read_failed",
      `Unable to read IntentCanvas auth token at ${path}`,
      { path, cause: error }
    );
  }

  try {
    // fstat() and readFile() are deliberately performed through the same open
    // descriptor. Replacing path between a separate stat/read pair cannot swap
    // in attacker-controlled token contents.
    const metadata = await handle.stat();
    if (!metadata.isFile() || (platform !== "win32" && metadata.nlink !== 1)) {
      throw new LocalAuthError(
        "invalid_auth_token_file",
        `IntentCanvas auth token path must be a regular, singly-linked file: ${path}`,
        { path }
      );
    }
    if (metadata.size > MAX_TOKEN_FILE_BYTES) {
      throw new LocalAuthError(
        "invalid_auth_token_file",
        `IntentCanvas auth token file is unexpectedly large: ${path}`,
        { path }
      );
    }
    if (platform !== "win32") {
      assertOwnedByCurrentUser(metadata, path, getuidImpl, "file");
      if ((metadata.mode & 0o077) !== 0) {
        throw new LocalAuthError(
          "insecure_auth_token_file",
          `IntentCanvas auth token file must not be accessible by group or other users: ${path}`,
          { path }
        );
      }
    }
    await assertSecureTokenDirectory(path, {
      platform,
      getuidImpl,
      ...directoryOptions
    });
    const body = await handle.readFile("utf8");
    return validateAuthToken(body.trim());
  } finally {
    await handle.close();
  }
}

export async function readAuthToken(options = {}) {
  const env = options.env ?? process.env;
  const configured = env[AUTH_TOKEN_ENV];
  if (typeof configured === "string" && configured.trim()) {
    return validateAuthToken(configured.trim());
  }
  const path = options.path ?? resolveAuthTokenFile({ env, home: options.home });
  return readSecureTokenFile(path, options);
}

export async function loadOrCreateAuthToken(options = {}) {
  const env = options.env ?? process.env;
  const configured = env[AUTH_TOKEN_ENV];
  if (typeof configured === "string" && configured.trim()) {
    return {
      token: validateAuthToken(configured.trim()),
      path: null,
      created: false
    };
  }

  const path = options.path ?? resolveAuthTokenFile({ env, home: options.home });
  const existing = await readSecureTokenFile(path, options);
  if (existing !== null) return { token: existing, path, created: false };

  const mkdirImpl = options.mkdirImpl ?? mkdir;
  const openImpl = options.openImpl ?? open;
  await mkdirImpl(dirname(path), { recursive: true, mode: 0o700 });
  await assertSecureTokenDirectory(path, options);
  const token = generateAuthToken(options.randomBytesImpl);
  let handle;
  try {
    handle = await openImpl(path, "wx", 0o600);
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const verified = await readSecureTokenFile(path, options);
    if (verified !== token) {
      throw new LocalAuthError(
        "auth_token_create_verification_failed",
        `IntentCanvas auth token changed while it was being created at ${path}`,
        { path }
      );
    }
    return { token: verified, path, created: true };
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // Preserve the creation error.
    }
    if (error?.code === "EEXIST") {
      const raced = await readSecureTokenFile(path, options);
      if (raced !== null) return { token: raced, path, created: false };
    }
    if (error instanceof LocalAuthError) throw error;
    throw new LocalAuthError(
      "auth_token_create_failed",
      `Unable to create IntentCanvas auth token at ${path}`,
      { path, cause: error }
    );
  }
}

export function bearerAuthorization(token) {
  return `Bearer ${validateAuthToken(token)}`;
}

export {
  DEFAULT_WORKSPACE_BINDING_DIRECTORY,
  WORKSPACE_BINDING_VERSION,
  normalizeBoundRuntimeUrl,
  readWorkspaceBinding,
  removeWorkspaceBinding,
  writeWorkspaceBinding
} from "./workspace-binding.js";
