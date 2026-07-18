import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RUNTIME_URL,
  MAX_RESPONSE_BYTES,
  normalizeRuntimeUrl,
  osc8Hyperlink,
  parseJsonDocument,
  reviewUrl,
  runCli,
  verifyRuntimeIdentity
} from "../src/cli.js";
import {
  APPROVED_SNAPSHOT_KIND,
  createApprovedSnapshot,
  createTdePlanFixture
} from "@intentcanvas/protocol";
import { runtimeIdentityProof } from "@intentcanvas/local-auth";

const AUTH_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HANDOFF = "HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH";

function capture() {
  let value = "";
  return {
    stream: { write(chunk) { value += chunk; } },
    read: () => value
  };
}

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; }
  };
}

function approvedPlan() {
  const plan = createTdePlanFixture();
  plan.status = "approved";
  for (const module of plan.modules) {
    module.approval = {
      decision: "approved",
      comment: "reviewed",
      updatedAt: "2026-07-18T00:00:00.000Z"
    };
  }
  return plan;
}

function dependencies(overrides = {}) {
  const stdout = capture();
  const stderr = capture();
  return {
    stdout,
    stderr,
    values: {
      env: { INTENTCANVAS_AUTH_TOKEN: AUTH_TOKEN },
      stdout: stdout.stream,
      stderr: stderr.stream,
      readFile: async () => JSON.stringify(createTdePlanFixture()),
      readStdin: async () => JSON.stringify(createTdePlanFixture()),
      fetch: async () => response(200, {}),
      verifyRuntimeIdentity: async () => {},
      writeWorkspaceBinding: async () => {},
      removeWorkspaceBinding: async () => null,
      ...overrides
    }
  };
}

test("parses raw JSON and exactly one fenced json block", () => {
  assert.deepEqual(parseJsonDocument('{"id":"one"}'), { id: "one" });
  assert.deepEqual(
    parseJsonDocument('Plan:\n```json\n{"id":"two"}\n```\n'),
    { id: "two" }
  );
  assert.throws(
    () => parseJsonDocument('```json\n{}\n```\n```json\n{}\n```'),
    /exactly one/
  );
  assert.throws(() => parseJsonDocument('```json\nnope\n```'), /not valid JSON/);
});

test("normalizes safe runtime URLs and encodes review ids", () => {
  assert.equal(normalizeRuntimeUrl(`${DEFAULT_RUNTIME_URL}/`), DEFAULT_RUNTIME_URL);
  assert.equal(reviewUrl(DEFAULT_RUNTIME_URL, "review/one"), `${DEFAULT_RUNTIME_URL}/?review=review%2Fone`);
  assert.throws(() => normalizeRuntimeUrl("file:///tmp/runtime"), /http or https/);
  assert.throws(() => normalizeRuntimeUrl("http://user:pass@localhost:4317"), /credentials/);
  assert.throws(() => normalizeRuntimeUrl("http://localhost:4317/api"), /must not contain a path/);
  assert.throws(() => normalizeRuntimeUrl("http://runtime.example.test:4317"), /loopback/);
  assert.throws(() => normalizeRuntimeUrl("https://runtime.example.test"), /loopback/);
});

test("verifies a challenge response before any bearer-authenticated request", async () => {
  let authorization;
  await verifyRuntimeIdentity(async (url, options) => {
    authorization = options.headers.Authorization;
    const challenge = new URL(url).searchParams.get("challenge");
    return response(200, {
      service: "intentcanvas-runtime",
      challenge,
      proof: runtimeIdentityProof(AUTH_TOKEN, challenge)
    });
  }, DEFAULT_RUNTIME_URL, AUTH_TOKEN, {
    randomBytesImpl: () => Buffer.alloc(32, 7)
  });
  assert.equal(authorization, undefined);

  await assert.rejects(
    verifyRuntimeIdentity(async (url) => {
      const challenge = new URL(url).searchParams.get("challenge");
      return response(200, {
        service: "intentcanvas-runtime",
        challenge,
        proof: "Z".repeat(43)
      });
    }, DEFAULT_RUNTIME_URL, AUTH_TOKEN, {
      randomBytesImpl: () => Buffer.alloc(32, 8)
    }),
    (error) => error.code === "runtime_identity_mismatch"
  );
});

test("validates plans from stdin with machine-readable output", async () => {
  const context = dependencies();
  const exitCode = await runCli(["plan", "validate", "-"], context.values);

  assert.equal(exitCode, 0);
  const result = JSON.parse(context.stdout.read());
  assert.equal(result.ok, true);
  assert.equal(result.reviewId, "doris-tde-demo");
  assert.equal(result.modules, 5);
  assert.equal(context.stderr.read(), "");
});

test("detaches an abandoned visual review without contacting Runtime", async () => {
  let removed = false;
  const context = dependencies({
    fetch: async () => { throw new Error("must not fetch"); },
    removeWorkspaceBinding: async () => {
      removed = true;
      return { reviewId: "review-1" };
    }
  });
  assert.equal(await runCli(["plan", "detach"], context.values), 0);
  assert.equal(removed, true);
  assert.match(context.stdout.read(), /Detached visual review: review-1/u);
});

test("reports validation errors without echoing source input", async () => {
  const secret = "do-not-echo-this";
  const context = dependencies({ readStdin: async () => JSON.stringify({ secret }) });
  const exitCode = await runCli(["plan", "validate", "-"], context.values);

  assert.equal(exitCode, 1);
  const result = JSON.parse(context.stderr.read());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_plan");
  assert.doesNotMatch(context.stderr.read(), new RegExp(secret));
});

test("imports a plan and prints a clickable review link", async () => {
  const requests = [];
  const context = dependencies({
    fetch: async (url, options) => {
      requests.push({ url, options });
      return url.endsWith("/api/handoffs")
        ? response(201, { reviewId: "doris-tde-demo", handoff: HANDOFF })
        : response(201, { review: { id: "doris-tde-demo" } });
    }
  });
  const exitCode = await runCli(["plan", "import", "plan.json"], context.values);

  assert.equal(exitCode, 0);
  assert.equal(requests[0].url, `${DEFAULT_RUNTIME_URL}/api/reviews`);
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${AUTH_TOKEN}`);
  assert.match(context.stdout.read(), /Review URL: http:\/\/127\.0\.0\.1:4317\/\?review=doris-tde-demo/);
  assert.match(context.stdout.read(), new RegExp(`handoff=${HANDOFF}`));
  assert.doesNotMatch(context.stdout.read(), new RegExp(AUTH_TOKEN));
  assert.match(context.stdout.read(), /\u001B\]8;;/);
  assert.equal(requests[1].url, `${DEFAULT_RUNTIME_URL}/api/handoffs`);
  assert.equal(requests[1].options.redirect, "error");
});

test("opens a review with a fresh one-use handoff from Runtime", async () => {
  let calls = 0;
  const context = dependencies({
    fetch: async () => {
      calls += 1;
      return response(201, { reviewId: "feature/42", handoff: HANDOFF });
    }
  });
  const exitCode = await runCli(["plan", "open", "feature/42"], context.values);

  assert.equal(exitCode, 0);
  assert.equal(calls, 1);
  assert.match(context.stdout.read(), /feature%2F42/);
  assert.match(context.stdout.read(), /handoff=/);
  assert.equal(osc8Hyperlink("Open", "https://example.test"), "\u001B]8;;https://example.test\u0007Open\u001B]8;;\u0007");
});

test("gets, replaces, freezes, and checks the execution gate", async () => {
  const plan = createTdePlanFixture();
  let written;
  const getContext = dependencies({
    fetch: async () => response(200, plan),
    writeFile: async (path, source, options) => { written = { path, source, options }; }
  });
  assert.equal(await runCli(["plan", "get", plan.id, "plan.json"], getContext.values), 0);
  assert.equal(written.path, "plan.json");
  assert.equal(JSON.parse(written.source).id, plan.id);
  assert.equal(written.options.mode, 0o600);

  const replaceRequests = [];
  const replaceContext = dependencies({
    fetch: async (url, options) => {
      replaceRequests.push({ url, options });
      if (url.endsWith("/gate")) {
        return response(200, {
          reviewId: plan.id,
          revision: 4,
          status: "in_review",
          allowed: false,
          blockingModules: []
        });
      }
      return url.endsWith("/api/handoffs")
        ? response(201, { reviewId: plan.id, handoff: HANDOFF })
        : response(200, { review: { id: plan.id } });
    }
  });
  assert.equal(
    await runCli(["plan", "replace", plan.id, "plan.json"], replaceContext.values),
    0
  );
  assert.equal(replaceRequests[1].options.method, "PUT");
  assert.equal(replaceRequests[1].options.headers["If-Match"], "\"4\"");
  assert.match(replaceContext.stdout.read(), /Replaced review/);

  const snapshot = createApprovedSnapshot(approvedPlan(), {
    revision: 6,
    frozenAt: "2026-07-18T00:00:00.000Z"
  });
  const freezeContext = dependencies({ fetch: async () => response(200, snapshot) });
  assert.equal(
    await runCli(["plan", "freeze", plan.id, "-"], freezeContext.values),
    0
  );
  assert.equal(JSON.parse(freezeContext.stdout.read()).kind, APPROVED_SNAPSHOT_KIND);

  const blocked = dependencies({
    fetch: async () => response(200, {
      reviewId: plan.id,
      revision: 2,
      status: "in_review",
      allowed: false,
      blockingModules: [{ id: "write-path", decision: "pending" }]
    })
  });
  assert.equal(await runCli(["plan", "gate", plan.id], blocked.values), 3);
  assert.equal(JSON.parse(blocked.stdout.read()).allowed, false);
});

test("revises one module through encoded API path", async () => {
  const requests = [];
  const module = createTdePlanFixture().modules[0];
  const context = dependencies({
    readFile: async () => JSON.stringify(module),
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/gate")) {
        return response(200, {
          reviewId: "review/1",
          revision: 7,
          status: "changes_requested",
          allowed: false,
          blockingModules: []
        });
      }
      return url.endsWith("/api/handoffs")
        ? response(201, { reviewId: "review/1", handoff: HANDOFF })
        : response(200, { module });
    }
  });
  const exitCode = await runCli(
    ["plan", "revise", "review/1", module.id, "module.json"],
    context.values
  );

  assert.equal(exitCode, 0);
  assert.equal(
    requests[1].url,
    `${DEFAULT_RUNTIME_URL}/api/reviews/review%2F1/modules/key-management`
  );
  assert.equal(requests[1].options.method, "PATCH");
  assert.equal(requests[1].options.headers["If-Match"], "\"7\"");
  assert.equal(requests[2].url, `${DEFAULT_RUNTIME_URL}/api/handoffs`);
});

test("checks Runtime health and preserves structured server errors", async () => {
  const healthy = dependencies({
    fetch: async () => response(200, { status: "ok", service: "intentcanvas-runtime" })
  });
  assert.equal(await runCli(["status"], healthy.values), 0);
  assert.equal(JSON.parse(healthy.stdout.read()).health.status, "ok");

  const failed = dependencies({
    fetch: async () => response(409, {
      error: { code: "review_exists", message: "Review already exists", details: [] }
    })
  });
  assert.equal(await runCli(["plan", "import", "plan.json"], failed.values), 1);
  const error = JSON.parse(failed.stderr.read());
  assert.equal(error.error.code, "review_exists");
});

test("uses environment runtime URL and rejects unknown options", async () => {
  let requestedUrl;
  const context = dependencies({
    env: {
      INTENTCANVAS_RUNTIME_URL: "http://127.0.0.1:5317",
      INTENTCANVAS_AUTH_TOKEN: AUTH_TOKEN
    },
    fetch: async (url) => {
      requestedUrl = url;
      return response(200, { status: "ok" });
    }
  });
  assert.equal(await runCli(["status"], context.values), 0);
  assert.equal(requestedUrl, "http://127.0.0.1:5317/api/health");

  const invalid = dependencies();
  assert.equal(await runCli(["status", "--wat"], invalid.values), 2);
  assert.equal(JSON.parse(invalid.stderr.read()).error.code, "unknown_option");
});

test("rejects terminal-control identifiers returned by Runtime", async () => {
  const context = dependencies({
    fetch: async () => response(201, { review: { id: "bad\u001b]52;payload" } })
  });
  const exitCode = await runCli(["plan", "import", "plan.json"], context.values);

  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(context.stderr.read()).error.code, "invalid_runtime_response");
  assert.doesNotMatch(context.stdout.read(), /\u001b/);
  assert.throws(
    () => osc8Hyperlink("bad\u001b]8", "https://example.test"),
    /not safe/
  );

  const shellSyntax = dependencies({
    fetch: async () => response(201, { reviewId: "bad;curl", handoff: HANDOFF })
  });
  assert.equal(await runCli(["plan", "open", "bad;curl"], shellSyntax.values), 1);
  assert.equal(JSON.parse(shellSyntax.stderr.read()).error.code, "invalid_runtime_response");
});

test("network commands fail closed when the local auth token is unavailable", async () => {
  const context = dependencies({
    env: {},
    readAuthToken: async () => null
  });
  const exitCode = await runCli(["status"], context.values);

  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(context.stderr.read()).error.code, "runtime_auth_required");
});

test("bounds Runtime request time and response size", async () => {
  const timedOut = dependencies({
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }),
    timeoutSignal: () => AbortSignal.timeout(1)
  });
  assert.equal(await runCli(["status"], timedOut.values), 1);
  assert.equal(JSON.parse(timedOut.stderr.read()).error.code, "runtime_timeout");

  const oversized = dependencies({
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.alloc(MAX_RESPONSE_BYTES + 1, 0x20);
        }
      }
    })
  });
  assert.equal(await runCli(["status"], oversized.values), 1);
  assert.equal(JSON.parse(oversized.stderr.read()).error.code, "runtime_response_too_large");
});

test("local plan validation does not depend on a configured Runtime URL", async () => {
  const context = dependencies({
    env: { INTENTCANVAS_RUNTIME_URL: "not a url" },
    readStdin: async () => JSON.stringify(createTdePlanFixture())
  });
  const code = await runCli(["plan", "validate", "-"], context.values);

  assert.equal(code, 0);
  assert.equal(context.stderr.read(), "");
  assert.equal(JSON.parse(context.stdout.read()).ok, true);
});
