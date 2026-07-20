import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  createRuntimeIdentityChallenge,
  loadOrCreateAuthToken,
  readAuthToken,
  verifyRuntimeIdentityProof
} from "../packages/local-auth/src/index.js";

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const RUNTIME_ENTRY = join(REPOSITORY_ROOT, "apps", "runtime", "src", "index.js");
const DEFAULT_RUNTIME_URL = "http://127.0.0.1:4317";
const HOST_STATE_VERSION = 1;

export class HostError extends Error {
  constructor(code, message, { details = [] } = {}) {
    super(message);
    this.name = "HostError";
    this.code = code;
    this.details = details;
  }
}

export function resolveHostDirectory({
  home = homedir(),
  env = process.env
} = {}) {
  const configured = env.INTENTCANVAS_HOME;
  return resolve(
    typeof configured === "string" && configured.trim()
      ? configured.trim()
      : join(home, ".intentcanvas")
  );
}

function hostPaths(options = {}) {
  const directory = resolveHostDirectory(options);
  return {
    directory,
    installation: join(directory, "installation.json"),
    pid: join(directory, "runtime.pid"),
    log: join(directory, "runtime.log")
  };
}

function localAuthOptions(options = {}) {
  return {
    env: options.env ?? process.env,
    home: options.home,
    path: join(resolveHostDirectory(options), "auth-token")
  };
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function writePrivateFile(path, body) {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readSmallRegularFile(path, maxBytes = 64 * 1024) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
    throw new HostError("invalid_host_state", `Unsafe IntentCanvas host state: ${path}`);
  }
  return readFile(path, "utf8");
}

async function findExecutable(name, env = process.env) {
  if (name.includes("/") || name.includes("\\")) {
    try {
      await access(name, constants.X_OK);
      return resolve(name);
    } catch {
      return null;
    }
  }
  for (const directory of String(env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return null;
}

async function defaultRunTool(executable, args, options = {}) {
  return execFile(executable, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    timeout: options.timeout ?? 120_000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    windowsHide: true
  });
}

async function workspaceDependenciesReady(repositoryRoot = REPOSITORY_ROOT) {
  try {
    for (const packageName of ["protocol", "plan-diff"]) {
      await access(
        join(repositoryRoot, "apps", "runtime", "node_modules", "@intentcanvas", packageName),
        constants.R_OK
      );
    }
    return true;
  } catch {
    return false;
  }
}

export async function installWorkspaceDependencies(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  if (await (options.dependenciesReady ?? workspaceDependenciesReady)(repositoryRoot)) {
    return { installed: false };
  }
  const env = options.env ?? process.env;
  const pnpm = await (options.findExecutable ?? findExecutable)("pnpm", env);
  const corepack = pnpm === null
    ? await (options.findExecutable ?? findExecutable)("corepack", env)
    : null;
  if (pnpm === null && corepack === null) {
    throw new HostError(
      "pnpm_unavailable",
      "pnpm or Corepack is required for the one-time IntentCanvas setup"
    );
  }
  const executable = pnpm ?? corepack;
  const args = pnpm === null
    ? ["pnpm", "install", "--frozen-lockfile"]
    : ["install", "--frozen-lockfile"];
  await (options.runTool ?? defaultRunTool)(executable, args, {
    cwd: repositoryRoot,
    env,
    timeout: 10 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (!await (options.dependenciesReady ?? workspaceDependenciesReady)(repositoryRoot)) {
    throw new HostError("dependency_install_failed", "Workspace dependencies are still unavailable");
  }
  return { installed: true };
}

export async function probeRuntime(options = {}) {
  const env = options.env ?? process.env;
  const token = options.token ?? await readAuthToken(localAuthOptions(options)).catch(() => null);
  if (!token) return { running: false, reason: "auth_token_missing" };
  const challenge = createRuntimeIdentityChallenge(options.randomBytesImpl);
  const baseUrl = options.runtimeUrl ?? DEFAULT_RUNTIME_URL;
  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(
      `${baseUrl}/api/identity?challenge=${encodeURIComponent(challenge)}`,
      {
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 750),
        headers: { Accept: "application/json" }
      }
    );
    if (!response.ok) return { running: false, reason: `http_${response.status}` };
    const payload = await response.json();
    const running = payload?.service === "intentcanvas-runtime" &&
      payload?.challenge === challenge &&
      verifyRuntimeIdentityProof(token, challenge, payload?.proof);
    return running
      ? { running: true, baseUrl, version: payload.version }
      : { running: false, reason: "identity_mismatch" };
  } catch (error) {
    return { running: false, reason: error?.name === "TimeoutError" ? "timeout" : "unreachable" };
  }
}

async function readRuntimePid(path) {
  try {
    const source = (await readSmallRegularFile(path, 64)).trim();
    const pid = Number(source);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function defaultSpawnRuntime(entry, { cwd, env, stdout, stderr }) {
  return spawn(process.execPath, [entry], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", stdout, stderr]
  });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function startBackgroundRuntime(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  if (!await (options.dependenciesReady ?? workspaceDependenciesReady)(repositoryRoot)) {
    throw new HostError("workspace_not_setup", "Run intentcanvas setup before starting Runtime");
  }
  const authentication = await loadOrCreateAuthToken(localAuthOptions(options));
  const existing = await probeRuntime({ ...options, token: authentication.token });
  if (existing.running) return { ...existing, started: false, pid: null };

  const paths = hostPaths(options);
  await ensurePrivateDirectory(paths.directory);
  const logHandle = await open(paths.log, "a", 0o600);
  await chmod(paths.log, 0o600);
  let child;
  try {
    const inheritedEnvironment = options.env ?? process.env;
    child = (options.spawnRuntime ?? defaultSpawnRuntime)(
      options.runtimeEntry ?? join(repositoryRoot, "apps", "runtime", "src", "index.js"),
      {
        cwd: repositoryRoot,
        env: {
          ...inheritedEnvironment,
          INTENTCANVAS_PORT: String(options.port ?? 4317),
          INTENTCANVAS_DATA_DIR: inheritedEnvironment.INTENTCANVAS_DATA_DIR ??
            join(paths.directory, "runtime"),
          ...(authentication.path === null
            ? {}
            : { INTENTCANVAS_AUTH_TOKEN_FILE: authentication.path })
        },
        stdout: logHandle.fd,
        stderr: logHandle.fd
      }
    );
    if (!Number.isInteger(child.pid) || child.pid < 2) {
      throw new HostError("runtime_spawn_failed", "Runtime did not return a process id");
    }
    child.unref?.();
    await writePrivateFile(paths.pid, `${child.pid}\n`);
  } catch (error) {
    if (Number.isInteger(child?.pid) && child.pid > 1) {
      try {
        (options.killImpl ?? process.kill)(child.pid, "SIGTERM");
      } catch {
        // Preserve the setup failure.
      }
    }
    throw error;
  } finally {
    await logHandle.close();
  }

  const attempts = options.startAttempts ?? 50;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await probeRuntime({ ...options, token: authentication.token });
    if (status.running) {
      return { ...status, started: true, pid: child.pid, log: paths.log };
    }
    await (options.delayImpl ?? delay)(options.startPollMs ?? 200);
  }
  (options.killImpl ?? process.kill)(child.pid, "SIGTERM");
  await unlink(paths.pid).catch(() => {});
  throw new HostError(
    "runtime_start_timeout",
    `Runtime did not become ready; inspect ${paths.log}`
  );
}

export async function stopBackgroundRuntime(options = {}) {
  const paths = hostPaths(options);
  const pid = await readRuntimePid(paths.pid);
  if (pid === null) return { stopped: false, reason: "pid_missing" };
  const status = await probeRuntime(options);
  if (!status.running) {
    throw new HostError(
      "runtime_identity_unavailable",
      "Runtime identity could not be verified; refusing to signal the recorded pid"
    );
  }
  try {
    (options.killImpl ?? process.kill)(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  for (let attempt = 0; attempt < (options.stopAttempts ?? 30); attempt += 1) {
    if (!(await probeRuntime(options)).running) {
      await unlink(paths.pid).catch(() => {});
      return { stopped: true, pid };
    }
    await (options.delayImpl ?? delay)(options.stopPollMs ?? 100);
  }
  throw new HostError("runtime_stop_timeout", "Runtime did not stop after SIGTERM");
}

async function installSymlink(target, source) {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    const metadata = await lstat(target);
    if (!metadata.isSymbolicLink()) {
      return { installed: false, warning: `${target} already exists and was not replaced` };
    }
    const existing = resolve(dirname(target), await readlink(target));
    try {
      if (await realpath(existing) === await realpath(source)) {
        return { installed: false, path: target };
      }
    } catch {
      return { installed: false, warning: `${target} is a broken link and was not replaced` };
    }
    return { installed: false, warning: `${target} points to another installation and was not replaced` };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await symlink(source, target);
  return { installed: true, path: target };
}

async function installClaudePlugin(repositoryRoot, options = {}) {
  const env = options.env ?? process.env;
  const claude = await (options.findExecutable ?? findExecutable)("claude", env);
  if (claude === null) return { installed: false, warning: "Claude Code was not found; plugin install skipped" };
  const runTool = options.runTool ?? defaultRunTool;
  try {
    const listed = await runTool(claude, ["plugin", "marketplace", "list", "--json"], {
      cwd: repositoryRoot,
      env
    });
    if (!String(listed.stdout).includes('"name": "intentcanvas"') &&
        !String(listed.stdout).includes('"name":"intentcanvas"')) {
      await runTool(claude, ["plugin", "marketplace", "add", repositoryRoot], {
        cwd: repositoryRoot,
        env
      });
    }
    const plugins = await runTool(claude, ["plugin", "list", "--json"], {
      cwd: repositoryRoot,
      env
    });
    if (String(plugins.stdout).includes("intentcanvas@intentcanvas")) {
      await runTool(claude, ["plugin", "update", "intentcanvas@intentcanvas", "--scope", "user"], {
        cwd: repositoryRoot,
        env
      });
      return { installed: false, updated: true };
    }
    await runTool(
      claude,
      ["plugin", "install", "intentcanvas@intentcanvas", "--scope", "user"],
      { cwd: repositoryRoot, env }
    );
    return { installed: true };
  } catch (error) {
    return {
      installed: false,
      warning: `Claude plugin setup failed: ${String(error.stderr ?? error.message).trim()}`
    };
  }
}

export async function setupHost(options = {}) {
  const repositoryRoot = await realpath(resolve(options.repositoryRoot ?? REPOSITORY_ROOT));
  const dependencies = await installWorkspaceDependencies({ ...options, repositoryRoot });
  const authentication = await loadOrCreateAuthToken(localAuthOptions(options));
  const paths = hostPaths(options);
  const launcher = join(repositoryRoot, "intentcanvas");
  await writePrivateFile(paths.installation, `${JSON.stringify({
    kind: "IntentCanvasInstallation",
    version: HOST_STATE_VERSION,
    repositoryRoot,
    launcher,
    installedAt: new Date().toISOString()
  }, null, 2)}\n`);

  const userBin = join(resolve(options.home ?? homedir()), ".local", "bin", "intentcanvas");
  const commandLink = await installSymlink(userBin, launcher);
  const codexHome = resolve(
    options.codexHome ?? options.env?.CODEX_HOME ?? join(options.home ?? homedir(), ".codex")
  );
  const codexSkill = await installSymlink(
    join(codexHome, "skills", "visual-plan"),
    join(repositoryRoot, "skills", "visual-plan")
  );
  const runtime = options.skipStart
    ? { running: false, started: false }
    : await startBackgroundRuntime({ ...options, repositoryRoot });
  const claude = options.skipClaude
    ? { installed: false }
    : await installClaudePlugin(repositoryRoot, options);

  return {
    ok: true,
    repositoryRoot,
    dependencies,
    authTokenCreated: authentication.created,
    installation: paths.installation,
    commandLink,
    codexSkill,
    claude,
    runtime,
    warnings: [commandLink.warning, codexSkill.warning, claude.warning].filter(Boolean)
  };
}

export async function diagnoseHost(options = {}) {
  const env = options.env ?? process.env;
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const major = Number(process.versions.node.split(".")[0]);
  const tools = {};
  for (const name of ["pnpm", "claude", "cmake", "clang-uml"]) {
    tools[name] = await (options.findExecutable ?? findExecutable)(name, env);
  }
  const runtime = await probeRuntime(options);
  const dependencies = await (options.dependenciesReady ?? workspaceDependenciesReady)(repositoryRoot);
  const paths = hostPaths(options);
  let installation = false;
  try {
    const value = JSON.parse(await readSmallRegularFile(paths.installation));
    installation = value.kind === "IntentCanvasInstallation" && value.version === HOST_STATE_VERSION;
  } catch {
    installation = false;
  }
  return {
    ok: major >= 22 && dependencies && installation && runtime.running,
    checks: {
      node: { ok: major >= 22, version: process.versions.node },
      dependencies: { ok: dependencies },
      installation: { ok: installation, path: paths.installation },
      runtime,
      tools: Object.fromEntries(Object.entries(tools).map(([name, path]) => [
        name,
        { ok: path !== null, path, required: name === "pnpm" }
      ])),
      terminal: {
        tmux: Boolean(env.TMUX),
        ssh: Boolean(env.SSH_CONNECTION || env.SSH_TTY),
        program: env.TERM_PROGRAM ?? null,
        osc8Expected: env.TERM !== "dumb"
      }
    }
  };
}

function line(stream, value = "") {
  stream.write(`${value}\n`);
}

export async function runHostCli(arguments_, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const command = arguments_[0];
    if (command === "setup") {
      const unknown = arguments_.slice(1).filter((value) => !["--skip-claude", "--skip-start"].includes(value));
      if (unknown.length > 0) throw new HostError("invalid_arguments", `Unknown setup option: ${unknown[0]}`);
      const result = await setupHost({
        ...options,
        skipClaude: arguments_.includes("--skip-claude"),
        skipStart: arguments_.includes("--skip-start")
      });
      line(stdout, "IntentCanvas setup complete.");
      line(stdout, `Command: ${result.commandLink.path ?? "use ./intentcanvas"}`);
      line(stdout, `Codex Skill: ${result.codexSkill.path ?? "existing installation kept"}`);
      line(stdout, result.runtime.running ? `Runtime: ${result.runtime.baseUrl}` : "Runtime: not started");
      for (const warning of result.warnings) line(stderr, `Warning: ${warning}`);
      return 0;
    }
    if (command === "start") {
      const result = await startBackgroundRuntime(options);
      line(stdout, result.started
        ? `IntentCanvas Runtime started: ${result.baseUrl}`
        : `IntentCanvas Runtime is already running: ${result.baseUrl}`);
      if (result.log) line(stdout, `Log: ${result.log}`);
      return 0;
    }
    if (command === "stop") {
      const result = await stopBackgroundRuntime(options);
      line(stdout, result.stopped ? "IntentCanvas Runtime stopped." : "IntentCanvas Runtime was not started by this host.");
      return 0;
    }
    if (command === "doctor") {
      const result = await diagnoseHost(options);
      line(stdout, JSON.stringify(result, null, 2));
      return result.ok ? 0 : 3;
    }
    throw new HostError("unknown_host_command", "Usage: intentcanvas setup|start|stop|doctor");
  } catch (error) {
    const normalized = error instanceof HostError
      ? error
      : new HostError("host_failed", error.message ?? "IntentCanvas host failed");
    line(stderr, JSON.stringify({
      ok: false,
      error: { code: normalized.code, message: normalized.message, details: normalized.details }
    }));
    return 1;
  }
}

const invokedAsScript = process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) process.exitCode = await runHostCli(process.argv.slice(2));
