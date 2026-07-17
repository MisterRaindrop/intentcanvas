import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  buildSshArgs,
  findAvailableLocalPort,
  isLocalPortAvailable,
  startSshTunnel
} from "../src/index.js";

class FakeChild extends EventEmitter {
  constructor({ exitOnKill = true } = {}) {
    super();
    this.exitOnKill = exitOnKill;
    this.kills = [];
  }

  kill(signal) {
    this.kills.push(signal);
    if (this.exitOnKill) queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

test("builds a shell-free, loopback-only ssh argument vector", () => {
  assert.deepEqual(buildSshArgs({
    destination: "builder@example.test",
    localPort: 45_001,
    remotePort: 4_317,
    sshPort: 2_222,
    identity: "keys/id ed25519",
    cwd: "/work"
  }), [
    "-N",
    "-T",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-L", "127.0.0.1:45001:127.0.0.1:4317",
    "-p", "2222",
    "-i", "/work/keys/id ed25519",
    "--", "builder@example.test"
  ]);
});

test("argument construction rejects option injection and invalid ports", () => {
  assert.throws(() => buildSshArgs({
    destination: "-oProxyCommand=evil",
    localPort: 40_001
  }), /ssh option/);
  assert.throws(() => buildSshArgs({
    destination: "host",
    localPort: 40_001,
    identity: "--proxy-command"
  }), /ssh option/);
  assert.throws(() => buildSshArgs({ destination: "host", localPort: 0 }), /selected/);
  assert.throws(() => buildSshArgs({ destination: "host", localPort: "65536" }), /65535/);
});

test("selects and releases an available loopback port", async () => {
  class FakeServer extends EventEmitter {
    constructor({ error } = {}) {
      super();
      this.error = error;
      this.listening = false;
      this.closed = false;
    }

    listen(options) {
      this.options = options;
      if (this.error) {
        queueMicrotask(() => this.emit("error", this.error));
      } else {
        this.listening = true;
        queueMicrotask(() => this.emit("listening"));
      }
    }

    address() {
      return { address: "127.0.0.1", family: "IPv4", port: this.options.port || 45_010 };
    }

    close(callback) {
      this.listening = false;
      this.closed = true;
      queueMicrotask(() => callback());
    }
  }

  const selected = new FakeServer();
  assert.equal(await findAvailableLocalPort({ createServerImpl: () => selected }), 45_010);
  assert.equal(selected.options.host, "127.0.0.1");
  assert.equal(selected.options.exclusive, true);
  assert.equal(selected.closed, true);

  const available = new FakeServer();
  assert.equal(await isLocalPortAvailable(45_011, {
    createServerImpl: () => available
  }), true);
  assert.equal(available.closed, true);

  const inUseError = Object.assign(new Error("in use"), { code: "EADDRINUSE" });
  assert.equal(await isLocalPortAvailable(45_012, {
    createServerImpl: () => new FakeServer({ error: inUseError })
  }), false);
});

test("spawns only ssh with an argument array and probes readiness", async () => {
  const child = new FakeChild();
  const calls = [];
  let probes = 0;
  const tunnel = await startSshTunnel({
    destination: "builder@example.test",
    localPort: 0,
    remotePort: 4317
  }, {
    findAvailableLocalPort: async () => 45_123,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
    probeTcpPort: async () => {
      probes += 1;
      return probes >= 2;
    },
    probeIntervalMs: 1,
    forwardTimeoutMs: 100
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ssh");
  assert.ok(Array.isArray(calls[0].args));
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "inherit", "inherit"]);
  assert.ok(calls[0].args.includes("127.0.0.1:45123:127.0.0.1:4317"));
  assert.equal(tunnel.localPort, 45_123);

  child.emit("exit", 0, null);
  assert.deepEqual(await tunnel.wait(), { code: 0, signal: null });
});

test("does not spawn when an explicit local port is unavailable", async () => {
  let spawned = false;
  await assert.rejects(() => startSshTunnel({
    destination: "host",
    localPort: 45_124
  }, {
    isLocalPortAvailable: async () => false,
    spawn() { spawned = true; }
  }), (error) => error.code === "local_port_unavailable");
  assert.equal(spawned, false);
});

test("SIGINT, SIGTERM, and SIGHUP handlers clean up the ssh child", async () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const child = new FakeChild();
    const signalSource = new EventEmitter();
    const tunnel = await startSshTunnel({ destination: "host", localPort: 45_125 }, {
      isLocalPortAvailable: async () => true,
      spawn: () => child,
      probeTcpPort: async () => true,
      signalSource
    });

    signalSource.emit(signal);
    assert.deepEqual(child.kills, ["SIGTERM"]);
    const result = await tunnel.wait();
    assert.equal(result.code, signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
    assert.equal(signalSource.listenerCount("SIGINT"), 0);
    assert.equal(signalSource.listenerCount("SIGTERM"), 0);
    assert.equal(signalSource.listenerCount("SIGHUP"), 0);
  }
});

test("cleans up when interrupted while waiting for readiness", async () => {
  const child = new FakeChild();
  const signalSource = new EventEmitter();
  await assert.rejects(() => startSshTunnel({ destination: "host", localPort: 45_129 }, {
    isLocalPortAvailable: async () => true,
    spawn: () => {
      queueMicrotask(() => signalSource.emit("SIGINT"));
      return child;
    },
    probeTcpPort: async () => new Promise(() => {}),
    signalSource
  }), (error) => error.code === "interrupted" && error.exitCode === 130);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});

test("escalates cleanup to SIGKILL if ssh ignores termination", async () => {
  const child = new FakeChild({ exitOnKill: false });
  const tunnel = await startSshTunnel({ destination: "host", localPort: 45_128 }, {
    isLocalPortAvailable: async () => true,
    spawn: () => child,
    probeTcpPort: async () => true,
    killTimeoutMs: 1,
    forceKillGraceMs: 1
  });
  const result = await tunnel.close();
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(result, { type: "exit", code: null, signal: "SIGKILL" });
  assert.deepEqual(await tunnel.wait(), { code: 1, signal: "SIGKILL" });
});

test("kills ssh when it exits before readiness or probing times out", async () => {
  const exited = new FakeChild();
  setImmediate(() => exited.emit("exit", 255, null));
  await assert.rejects(() => startSshTunnel({ destination: "host", localPort: 45_126 }, {
    isLocalPortAvailable: async () => true,
    spawn: () => exited,
    probeTcpPort: async () => false,
    probeIntervalMs: 1,
    forwardTimeoutMs: 100
  }), (error) => error.code === "ssh_exited_before_ready");

  const timedOut = new FakeChild();
  await assert.rejects(() => startSshTunnel({ destination: "host", localPort: 45_127 }, {
    isLocalPortAvailable: async () => true,
    spawn: () => timedOut,
    probeTcpPort: async () => false,
    probeIntervalMs: 1,
    forwardTimeoutMs: 3
  }), (error) => error.code === "ssh_forward_timeout");
  assert.deepEqual(timedOut.kills, ["SIGTERM"]);
});
