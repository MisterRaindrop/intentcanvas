import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runBridgeCli } from "../src/cli.js";

const HANDOFF = "HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH";

function capture() {
  let value = "";
  return {
    stream: { write(chunk) { value += String(chunk); } },
    read: () => value
  };
}

function context(overrides = {}) {
  const stdout = capture();
  const stderr = capture();
  return {
    stdout,
    stderr,
    values: {
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
      signalSource: new EventEmitter(),
      cwd: "/work",
      ...overrides
    }
  };
}

test("link prints both a plain URL and an OSC8 hyperlink", async () => {
  const c = context();
  assert.equal(await runBridgeCli([
    "link", "--review", "review/42", "--handoff", HANDOFF,
    "--runtime", "http://127.0.0.1:5000"
  ], c.values), 0);
  assert.match(c.stdout.read(), /Review URL: http:\/\/127\.0\.0\.1:5000\/\?review=review%2F42&handoff=/);
  assert.match(c.stdout.read(), /\u001B\]8;;http:\/\/127\.0\.0\.1:5000/);
  assert.equal(c.stderr.read(), "");
});

test("environment emits structured SSH and tmux information", async () => {
  const c = context({
    env: {
      SSH_CONNECTION: "203.0.113.5 50000 10.0.0.2 22",
      TMUX: "/tmp/tmux/default,123,2"
    }
  });
  assert.equal(await runBridgeCli(["environment"], c.values), 0);
  const result = JSON.parse(c.stdout.read());
  assert.equal(result.ok, true);
  assert.equal(result.environment.location, "remote");
  assert.equal(result.environment.tunnel.mustRunOnClient, true);
});

test("refuses to pretend a remote process can create a client-local tunnel", async () => {
  let started = false;
  const c = context({
    env: { SSH_CONNECTION: "203.0.113.5 50000 10.0.0.2 22" },
    startSshTunnel: async () => { started = true; }
  });
  assert.equal(await runBridgeCli([
    "ssh", "builder@host", "--review", "review-42"
  ], c.values), 2);
  assert.equal(started, false);
  const result = JSON.parse(c.stderr.read());
  assert.equal(result.error.code, "remote_tunnel_not_supported");
  assert.equal(result.error.details[0].environment.tunnel.canCreateForCurrentMachine, false);
});

test("passes validated ssh configuration and explains how to open a fresh remote link", async () => {
  let config;
  const c = context({
    startSshTunnel: async (value) => {
      config = value;
      return {
        localPort: 45_500,
        wait: async () => ({ code: 0, signal: null })
      };
    }
  });
  assert.equal(await runBridgeCli([
    "ssh", "builder@host.example", "--review", "review/42",
    "--remote-port", "4318", "--local-port", "0",
    "--ssh-port", "2222", "--identity", "keys/id"
  ], c.values), 0);
  assert.deepEqual(config, {
    destination: "builder@host.example",
    reviewId: "review/42",
    remotePort: 4318,
    localPort: 0,
    sshPort: 2222,
    identity: "/work/keys/id"
  });
  assert.match(c.stdout.read(), /Tunnel ready: http:\/\/127\.0\.0\.1:45500/);
  assert.match(c.stdout.read(), /local and remote ports differ/);
});

test("ssh defaults the local port to the remote Runtime port for click-through links", async () => {
  let config;
  const c = context({
    startSshTunnel: async (value) => {
      config = value;
      return { localPort: value.localPort, wait: async () => ({ code: 0, signal: null }) };
    }
  });
  assert.equal(await runBridgeCli([
    "ssh", "builder@host.example", "--review", "review-42"
  ], c.values), 0);
  assert.equal(config.localPort, 4317);
  assert.equal(config.remotePort, 4317);
  assert.match(c.stdout.read(), /intentcanvas plan open review-42/);
});

test("rejects duplicate, unknown, missing, and option-like inputs", async () => {
  for (const argv of [
    ["link", "--review", "one", "--review", "two"],
    ["link", "--review", "one"],
    ["link", "--review", "one", "--wat", "two"],
    ["ssh", "host", "--review", "one;curl-evil"],
    ["ssh", "host", "--review"],
    ["ssh", "-oProxyCommand=evil", "--review", "one"],
    ["ssh", "host", "--review", "one", "--identity", "--proxy-command"]
  ]) {
    const c = context();
    assert.equal(await runBridgeCli(argv, c.values), 2);
    assert.equal(JSON.parse(c.stderr.read()).ok, false);
  }
});
