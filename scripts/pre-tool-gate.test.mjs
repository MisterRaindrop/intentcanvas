import assert from "node:assert/strict";
import test from "node:test";

import { checkPreToolGate, toolCanWrite } from "./pre-tool-gate.mjs";

const AUTH_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BINDING = {
  version: 1,
  cwd: "/repo",
  reviewId: "review-1",
  runtimeUrl: "http://127.0.0.1:4317"
};

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() { return JSON.stringify(payload); }
  };
}

test("identifies Claude write surfaces while allowing bounded planning commands", () => {
  assert.equal(toolCanWrite({ tool_name: "Edit" }), true);
  assert.equal(toolCanWrite({ tool_name: "mcp__repo__delete_file" }), true);
  assert.equal(toolCanWrite({ tool_name: "Agent", tool_input: { subagent_type: "Explore" } }), false);
  assert.equal(toolCanWrite({ tool_name: "Bash", tool_input: { command: "rg -n TODO src" } }), false);
  assert.equal(toolCanWrite({ tool_name: "Bash", tool_input: { command: "rg -n 'TODO|FIXME' src" } }), false);
  assert.equal(toolCanWrite({ tool_name: "Bash", tool_input: { command: "rg TODO src && node rewrite.mjs" } }), true);
  assert.equal(toolCanWrite({ tool_name: "Bash", tool_input: { command: "rg TODO src; python rewrite.py" } }), true);
  assert.equal(toolCanWrite({ tool_name: "Bash", tool_input: { command: "rg \"$(touch changed)\" src" } }), true);
  assert.equal(toolCanWrite({ tool_name: "Bash", tool_input: { command: "pnpm intentcanvas plan open review-1" } }), true);
  assert.equal(toolCanWrite({ tool_name: "Bash", tool_input: { command: "pnpm intentcanvas plan detach" } }), true);
  assert.equal(toolCanWrite({
    tool_name: "Bash",
    tool_input: { command: "node /plugin/skills/visual-plan/scripts/intentcanvas.mjs plan revise review-1 core module.json" }
  }), false);
  assert.equal(toolCanWrite({ tool_name: "Bash", tool_input: { command: "sed -i s/a/b/ src/a.cc" } }), true);
  assert.equal(toolCanWrite({ tool_name: "Bash", tool_input: { command: "node rewrite.mjs" } }), true);
});

test("does not gate projects without an active visual review binding", async () => {
  const result = await checkPreToolGate({ tool_name: "Write", cwd: "/repo" }, {
    readBinding: async () => null
  });
  assert.equal(result.allowed, true);
});

test("fails closed when Runtime identity or approval is unavailable", async () => {
  const identityFailure = await checkPreToolGate({ tool_name: "Write", cwd: "/repo" }, {
    readBinding: async () => BINDING,
    readToken: async () => AUTH_TOKEN,
    verifyIdentity: async () => false
  });
  assert.equal(identityFailure.allowed, false);
  assert.match(identityFailure.output.hookSpecificOutput.permissionDecisionReason, /无法证明/);

  const pending = await checkPreToolGate({ tool_name: "Edit", cwd: "/repo" }, {
    readBinding: async () => BINDING,
    readToken: async () => AUTH_TOKEN,
    verifyIdentity: async () => true,
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${AUTH_TOKEN}`);
      return jsonResponse(200, {
        reviewId: "review-1",
        revision: 4,
        status: "changes_requested",
        allowed: false
      });
    }
  });
  assert.equal(pending.allowed, false);
  assert.match(pending.output.hookSpecificOutput.permissionDecisionReason, /尚未全部批准/);
});

test("approved review releases the gate without bypassing Claude's normal permission prompt", async () => {
  const approved = await checkPreToolGate({ tool_name: "Write", cwd: "/repo" }, {
    readBinding: async () => BINDING,
    readToken: async () => AUTH_TOKEN,
    verifyIdentity: async () => true,
    fetchImpl: async () => jsonResponse(200, {
      reviewId: "review-1",
      revision: 9,
      status: "approved",
      allowed: true
    })
  });
  assert.deepEqual(approved, { allowed: true, reviewId: "review-1", revision: 9 });
  assert.equal(approved.output, undefined);
});
