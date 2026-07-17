import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RUNTIME_URL,
  detectEnvironment,
  normalizeIdentityPath,
  normalizeRuntimeUrl,
  osc8Hyperlink,
  parsePort,
  reviewUrl,
  validateDestination
} from "../src/index.js";

test("strictly validates destinations and prevents ssh option injection", () => {
  assert.equal(validateDestination("builder@example.test"), "builder@example.test");
  assert.equal(validateDestination("host_alias"), "host_alias");
  assert.equal(validateDestination("user@2001:db8::1"), "user@2001:db8::1");
  assert.equal(validateDestination("user@[2001:DB8::1]"), "user@2001:db8::1");

  assert.throws(() => validateDestination("-oProxyCommand=evil"), /ssh option/);
  assert.throws(() => validateDestination("host -oProxyCommand=evil"), /whitespace/);
  assert.throws(() => validateDestination("user@@host"), /at most one/);
  assert.throws(() => validateDestination("user@host/path"), /safe host/);
  assert.throws(() => validateDestination("host\nProxyCommand evil"), /control/);
});

test("parses canonical ports and rejects truncation or out-of-range values", () => {
  assert.equal(parsePort("4317", "remote_port"), 4317);
  assert.equal(parsePort(0, "local_port", { allowZero: true }), 0);
  for (const value of ["04317", "1x", "1.5", "-1", 65_536, 0]) {
    assert.throws(() => parsePort(value, "remote_port"));
  }
});

test("normalizes identity paths without shell expansion", () => {
  assert.equal(
    normalizeIdentityPath("~/keys/id ed25519", { cwd: "/work", home: "/home/alice" }),
    "/home/alice/keys/id ed25519"
  );
  assert.equal(normalizeIdentityPath("keys/id", { cwd: "/work" }), "/work/keys/id");
  assert.throws(() => normalizeIdentityPath("-oProxyCommand=evil", { cwd: "/work" }), /ssh option/);
  assert.throws(() => normalizeIdentityPath("~other/id", { cwd: "/work" }), /home expansion/);
  assert.throws(() => normalizeIdentityPath("key\u0000name", { cwd: "/work" }), /control/);
});

test("builds encoded plain links and safe OSC8 links", () => {
  assert.equal(normalizeRuntimeUrl(`${DEFAULT_RUNTIME_URL}/`), DEFAULT_RUNTIME_URL);
  const handoff = "H".repeat(43);
  const url = reviewUrl(DEFAULT_RUNTIME_URL, "review/42", handoff);
  assert.equal(url, `${DEFAULT_RUNTIME_URL}/?review=review%2F42&handoff=${handoff}`);
  assert.equal(
    osc8Hyperlink("Open", url),
    `\u001B]8;;${url}\u0007Open\u001B]8;;\u0007`
  );
  assert.throws(() => osc8Hyperlink("bad\u001b]8", url), /not safe/);
  assert.throws(() => osc8Hyperlink("Open", "javascript:alert(1)"), /http or https/);
  assert.throws(() => normalizeRuntimeUrl("http://user:pass@localhost:4317"), /credentials/);
  assert.throws(() => normalizeRuntimeUrl("http://localhost:4317/api"), /path/);
  assert.throws(() => normalizeRuntimeUrl("http://runtime.example.test:4317"), /must use https/);
});

test("reports SSH and tmux context without claiming a client-local tunnel", () => {
  const remote = detectEnvironment({
    SSH_CONNECTION: "203.0.113.4 53422 10.0.0.8 22",
    TMUX: "/tmp/tmux-1000/default,1234,7"
  });
  assert.equal(remote.location, "remote");
  assert.equal(remote.ssh.connection.clientPort, 53_422);
  assert.deepEqual(remote.tmux.session, {
    socketPath: "/tmp/tmux-1000/default",
    serverPid: 1234,
    sessionId: 7
  });
  assert.equal(remote.tunnel.canCreateForCurrentMachine, false);
  assert.equal(remote.tunnel.mustRunOnClient, true);

  const malformed = detectEnvironment({ SSH_CONNECTION: "broken", TMUX: "broken" });
  assert.equal(malformed.ssh.active, true);
  assert.equal(malformed.ssh.valid, false);
  assert.equal(malformed.tmux.valid, false);

  const local = detectEnvironment({});
  assert.equal(local.location, "local");
  assert.equal(local.tunnel.canCreateForCurrentMachine, true);
});
