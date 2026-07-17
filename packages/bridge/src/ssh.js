import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";

import { BridgeError } from "./errors.js";
import {
  normalizeIdentityPath,
  parsePort,
  validateDestination
} from "./validation.js";

export const LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_REMOTE_PORT = 4_317;
export const DEFAULT_LOCAL_PORT = 0;
export const DEFAULT_FORWARD_TIMEOUT_MS = 10_000;

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onListening() {
      cleanup();
      resolve();
    }
    function cleanup() {
      server.off("error", onError);
      server.off("listening", onListening);
    }
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export async function findAvailableLocalPort({
  host = LOOPBACK_HOST,
  createServerImpl = createServer
} = {}) {
  const server = createServerImpl();
  try {
    await listen(server, host, 0);
    const address = server.address();
    if (!address || typeof address === "string" || !Number.isInteger(address.port)) {
      throw new BridgeError("local_port_allocation_failed", "Could not select a local port");
    }
    return address.port;
  } finally {
    if (server.listening) await closeServer(server);
  }
}

export async function isLocalPortAvailable(port, {
  host = LOOPBACK_HOST,
  createServerImpl = createServer
} = {}) {
  const normalizedPort = parsePort(port, "local_port");
  const server = createServerImpl();
  try {
    await listen(server, host, normalizedPort);
    return true;
  } catch (error) {
    if (error?.code === "EADDRINUSE" || error?.code === "EACCES") return false;
    throw error;
  } finally {
    if (server.listening) await closeServer(server);
  }
}

export function probeTcpPort(host, port, { timeoutMs = 250 } = {}) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    }
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function normalizeSshOptions(options = {}) {
  const destination = validateDestination(options.destination);
  const remotePort = parsePort(
    options.remotePort ?? DEFAULT_REMOTE_PORT,
    "remote_port"
  );
  const localPort = parsePort(
    options.localPort ?? DEFAULT_LOCAL_PORT,
    "local_port",
    { allowZero: true }
  );
  const sshPort = options.sshPort === undefined
    ? undefined
    : parsePort(options.sshPort, "ssh_port");
  const identity = options.identity === undefined
    ? undefined
    : normalizeIdentityPath(options.identity, {
      cwd: options.cwd,
      home: options.home
    });
  return { destination, remotePort, localPort, sshPort, identity };
}

export function buildSshArgs(options) {
  const normalized = normalizeSshOptions(options);
  if (normalized.localPort === 0) {
    throw new BridgeError(
      "local_port_not_selected",
      "localPort must be selected before building ssh arguments"
    );
  }
  const forward = `${LOOPBACK_HOST}:${normalized.localPort}:${LOOPBACK_HOST}:${normalized.remotePort}`;
  const args = [
    "-N",
    "-T",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-L", forward
  ];
  if (normalized.sshPort !== undefined) args.push("-p", String(normalized.sshPort));
  if (normalized.identity !== undefined) args.push("-i", normalized.identity);
  args.push("--", normalized.destination);
  return args;
}

function observeChild(child) {
  let settled = false;
  let outcome;
  const promise = new Promise((resolve) => {
    function finish(value) {
      if (settled) return;
      settled = true;
      outcome = value;
      resolve(value);
    }
    child.once("error", (error) => finish({ type: "error", error }));
    child.once("exit", (code, signal) => finish({ type: "exit", code, signal }));
  });
  return {
    promise,
    get settled() { return settled; },
    get outcome() { return outcome; }
  };
}

function delay(milliseconds, setTimeoutImpl) {
  return new Promise((resolve) => setTimeoutImpl(resolve, milliseconds));
}

function childFailure(outcome, beforeReady) {
  if (outcome.type === "error") {
    return new BridgeError("ssh_spawn_failed", "Could not start the ssh client");
  }
  return new BridgeError(
    beforeReady ? "ssh_exited_before_ready" : "ssh_exited",
    beforeReady ? "ssh exited before the local forwarding port was ready" : "ssh exited",
    { details: [{ code: outcome.code, signal: outcome.signal }] }
  );
}

async function waitUntilForwarded({
  childState,
  localPort,
  probePort,
  now,
  setTimeoutImpl,
  timeoutMs,
  intervalMs
}) {
  const deadline = now() + timeoutMs;
  while (true) {
    const remaining = Math.max(1, deadline - now());
    const result = await Promise.race([
      Promise.resolve(probePort(LOOPBACK_HOST, localPort, {
        timeoutMs: Math.min(250, remaining)
      })).then((ready) => ({ type: "probe", ready: ready === true })),
      childState.promise.then((outcome) => ({ type: "child", outcome }))
    ]);
    if (result.type === "child") throw childFailure(result.outcome, true);
    if (result.ready) return;
    if (now() >= deadline) {
      throw new BridgeError(
        "ssh_forward_timeout",
        "Timed out waiting for the local forwarding port"
      );
    }
    const pause = await Promise.race([
      delay(Math.min(intervalMs, Math.max(1, deadline - now())), setTimeoutImpl)
        .then(() => ({ type: "delay" })),
      childState.promise.then((outcome) => ({ type: "child", outcome }))
    ]);
    if (pause.type === "child") throw childFailure(pause.outcome, true);
  }
}

function signalExitCode(signal) {
  if (signal === "SIGHUP") return 129;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function createTunnelHandle(child, childState, metadata, dependencies) {
  let closeRequested = false;
  let closingPromise = null;
  let receivedSignal = null;
  let removeSignalHandlers = () => {};
  const setTimeoutImpl = dependencies.setTimeout ?? setTimeout;
  const clearTimeoutImpl = dependencies.clearTimeout ?? clearTimeout;
  const killTimeoutMs = dependencies.killTimeoutMs ?? 1_000;
  const forceKillGraceMs = dependencies.forceKillGraceMs ?? 250;

  function waitForExit(milliseconds) {
    if (childState.settled) return Promise.resolve(childState.outcome);
    return new Promise((resolve) => {
      const timer = setTimeoutImpl(() => resolve(null), milliseconds);
      childState.promise.then((outcome) => {
        clearTimeoutImpl(timer);
        resolve(outcome);
      });
    });
  }

  async function terminate(signal) {
    try {
      child.kill(signal);
    } catch {
      // A concurrently exiting child is already clean enough to stop managing.
    }
    let outcome = await waitForExit(killTimeoutMs);
    if (outcome) return outcome;
    try {
      child.kill("SIGKILL");
    } catch {
      // The child may have exited between the timeout and the force-kill.
    }
    outcome = await waitForExit(forceKillGraceMs);
    return outcome ?? { type: "exit", code: null, signal: "SIGKILL" };
  }

  const handle = {
    ...metadata,
    child,
    get receivedSignal() { return receivedSignal; },
    setSignalHandlers(cleanup) { removeSignalHandlers = cleanup; },
    close(signal = "SIGTERM") {
      if (!closeRequested && !childState.settled) {
        closeRequested = true;
        closingPromise = terminate(signal);
      }
      removeSignalHandlers();
      return closingPromise ?? childState.promise;
    },
    async wait() {
      const outcome = closingPromise ? await closingPromise : await childState.promise;
      removeSignalHandlers();
      if (outcome.type === "error") throw childFailure(outcome, false);
      return {
        code: receivedSignal ? signalExitCode(receivedSignal) : (outcome.code ?? 1),
        signal: outcome.signal
      };
    },
    markSignal(signal) {
      if (!receivedSignal) receivedSignal = signal;
      void handle.close("SIGTERM");
    }
  };
  void childState.promise.then(() => removeSignalHandlers());
  return handle;
}

function installSignalHandlers(handle, signalSource) {
  if (!signalSource || typeof signalSource.on !== "function") return () => {};
  const onSigint = () => handle.markSignal("SIGINT");
  const onSigterm = () => handle.markSignal("SIGTERM");
  const onSighup = () => handle.markSignal("SIGHUP");
  signalSource.on("SIGINT", onSigint);
  signalSource.on("SIGTERM", onSigterm);
  signalSource.on("SIGHUP", onSighup);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const remove = typeof signalSource.off === "function"
      ? signalSource.off.bind(signalSource)
      : signalSource.removeListener?.bind(signalSource);
    remove?.("SIGINT", onSigint);
    remove?.("SIGTERM", onSigterm);
    remove?.("SIGHUP", onSighup);
  };
}

export async function startSshTunnel(options, dependencies = {}) {
  const normalized = normalizeSshOptions(options);
  const allocateLocalPort = dependencies.findAvailableLocalPort ?? findAvailableLocalPort;
  const checkLocalPort = dependencies.isLocalPortAvailable ?? isLocalPortAvailable;
  const spawnImpl = dependencies.spawn ?? spawn;
  const probePort = dependencies.probeTcpPort ?? probeTcpPort;
  const now = dependencies.now ?? Date.now;
  const setTimeoutImpl = dependencies.setTimeout ?? setTimeout;
  const timeoutMs = dependencies.forwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS;
  const intervalMs = dependencies.probeIntervalMs ?? 100;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new BridgeError("invalid_forward_timeout", "forward timeout must be positive");
  }
  const localPort = normalized.localPort === 0
    ? parsePort(await allocateLocalPort(), "local_port")
    : normalized.localPort;
  if (normalized.localPort !== 0 && !(await checkLocalPort(localPort))) {
    throw new BridgeError("local_port_unavailable", "The requested local port is unavailable");
  }

  const resolved = { ...normalized, localPort };
  const args = buildSshArgs(resolved);
  let child;
  try {
    child = spawnImpl("ssh", args, {
      shell: false,
      stdio: ["ignore", "inherit", "inherit"]
    });
  } catch {
    throw new BridgeError("ssh_spawn_failed", "Could not start the ssh client");
  }
  if (!child || typeof child.once !== "function" || typeof child.kill !== "function") {
    throw new BridgeError("ssh_spawn_failed", "ssh did not return a child process");
  }

  const childState = observeChild(child);
  const handle = createTunnelHandle(child, childState, {
    command: "ssh",
    args: Object.freeze([...args]),
    destination: resolved.destination,
    localHost: LOOPBACK_HOST,
    localPort,
    remoteHost: LOOPBACK_HOST,
    remotePort: resolved.remotePort
  }, dependencies);
  const removeSignalHandlers = installSignalHandlers(handle, dependencies.signalSource);
  handle.setSignalHandlers(removeSignalHandlers);

  try {
    await waitUntilForwarded({
      childState,
      localPort,
      probePort,
      now,
      setTimeoutImpl,
      timeoutMs,
      intervalMs
    });
  } catch (error) {
    await handle.close();
    if (handle.receivedSignal) {
      throw new BridgeError("interrupted", `Interrupted by ${handle.receivedSignal}`, {
        exitCode: signalExitCode(handle.receivedSignal)
      });
    }
    throw error;
  }
  return handle;
}
