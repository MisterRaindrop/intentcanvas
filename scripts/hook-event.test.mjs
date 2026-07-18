import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  configuredTimeoutMs,
  eventInputFromArguments,
  normalize,
  postEvent,
  resolveEventEndpoint,
  verifyEventEndpointIdentity
} from "./hook-event.mjs";
import { runtimeIdentityProof } from "../packages/local-auth/src/index.js";

const AUTH_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("clamps hook timeout below the host hook deadline", () => {
  assert.equal(configuredTimeoutMs({ INTENTCANVAS_HOOK_TIMEOUT_MS: "99999" }), 1_500);
  assert.equal(configuredTimeoutMs({ INTENTCANVAS_HOOK_TIMEOUT_MS: "450" }), 450);
  assert.equal(configuredTimeoutMs({ INTENTCANVAS_HOOK_TIMEOUT_MS: "invalid" }), 300);
});

test("maps Claude lifecycle hooks to protocol event types", () => {
  const cases = [
    ["SessionStart", "session_started"],
    ["SessionEnd", "session_ended"],
    ["Notification", "notification"],
    ["PreToolUse", "tool_running"],
    ["PostToolUse", "tool_finished"],
    ["Stop", "task_complete"]
  ];

  for (const [hookEventName, expected] of cases) {
    const event = normalize({ hook_event_name: hookEventName, cwd: "/repo" }, {
      now: () => new Date("2026-07-17T00:00:00.000Z")
    });
    assert.equal(event.type, expected);
  }
  assert.equal(normalize({ hook_event_name: "Unknown", cwd: "/repo" }), null);
});

test("maps explicit workflow milestones without guessing from text", () => {
  for (const type of ["plan_ready", "approval_required", "review_drift_detected"]) {
    const input = eventInputFromArguments([
      "--event", type,
      "--review-id", "review-1",
      "--module-id", "runtime"
    ], "/repo");
    const event = normalize(input);
    assert.equal(event.type, type);
    assert.equal(event.reviewId, "review-1");
    assert.deepEqual(event.payload.moduleIds, ["runtime"]);
  }

  const ordinary = normalize({
    hook_event_name: "Notification",
    notification_type: "permission_prompt",
    message: "plan_ready appears only in this message",
    cwd: "/repo"
  });
  assert.equal(ordinary.type, "notification");
});

test("forwards only allowlisted metadata and never raw secrets or environment", () => {
  const event = normalize({
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: "/repo",
    tool_name: "Bash",
    tool_input: { command: "deploy --token top-secret" },
    tool_response: { stdout: "API_KEY=top-secret" },
    env: { API_KEY: "top-secret" },
    transcript_path: "/secret/transcript.jsonl"
  });
  const serialized = JSON.stringify(event);

  assert.equal(event.payload.toolName, "Bash");
  assert.doesNotMatch(serialized, /top-secret|API_KEY|transcript\.jsonl|tool_input|tool_response/);
});

test("drops unsafe identifiers instead of emitting protocol-invalid data", () => {
  const event = normalize({
    hook_event_name: "Notification",
    session_id: "session;curl-evil",
    review_id: "review $(evil)",
    module_ids: ["runtime", "bad;command"],
    cwd: "/repo"
  });
  assert.equal(event.sessionId, null);
  assert.equal(event.reviewId, undefined);
  assert.deepEqual(event.payload.moduleIds, ["runtime"]);
});

test("normalizes only safe Runtime event endpoints", () => {
  assert.equal(
    resolveEventEndpoint("http://127.0.0.1:4317").href,
    "http://127.0.0.1:4317/api/events"
  );
  assert.equal(
    resolveEventEndpoint("http://127.0.0.1:4317/api/events").href,
    "http://127.0.0.1:4317/api/events"
  );
  assert.equal(
    resolveEventEndpoint("http://127.0.0.1:4317/api/events/").href,
    "http://127.0.0.1:4317/api/events"
  );
  assert.equal(resolveEventEndpoint("http://user:secret@127.0.0.1:4317"), null);
  assert.equal(resolveEventEndpoint("https://collector.example/api/events"), null);
  assert.equal(resolveEventEndpoint("file:///tmp/events"), null);
  assert.equal(resolveEventEndpoint("http://127.0.0.1:4317/other"), null);
});

test("posts a normalized event with an injectable transport", async () => {
  let received = null;
  let authorization = null;
  const transport = {
    request(_endpoint, options, callback) {
      authorization = options.headers.authorization;
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.destroy = () => {};
      request.end = (body) => {
        received = JSON.parse(body);
        const response = new EventEmitter();
        response.resume = () => {};
        callback(response);
        queueMicrotask(() => response.emit("end"));
      };
      return request;
    }
  };
  const endpoint = new URL("http://127.0.0.1:4317/api/events");
  const event = normalize({ hook_event_name: "SessionStart", cwd: "/repo" });
  await postEvent(endpoint, event, {
    timeout: 500,
    authToken: AUTH_TOKEN,
    transport,
    verifyIdentity: async () => true
  });

  assert.equal(received.type, "session_started");
  assert.equal(received.project.cwd, "/repo");
  assert.equal(authorization, `Bearer ${AUTH_TOKEN}`);
});

test("verifies a fresh challenge before the hook may send its bearer token", async () => {
  const transport = {
    request(url, _options, callback) {
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.destroy = () => {};
      request.end = () => {
        const challenge = new URL(url).searchParams.get("challenge");
        const response = new EventEmitter();
        response.statusCode = 200;
        callback(response);
        queueMicrotask(() => {
          response.emit("data", Buffer.from(JSON.stringify({
            service: "intentcanvas-runtime",
            challenge,
            proof: runtimeIdentityProof(AUTH_TOKEN, challenge)
          })));
          response.emit("end");
        });
      };
      return request;
    }
  };
  assert.equal(await verifyEventEndpointIdentity(
    new URL("http://127.0.0.1:4317/api/events"),
    AUTH_TOKEN,
    { transport, randomBytesImpl: () => Buffer.alloc(32, 4) }
  ), true);

  let requests = 0;
  await postEvent(
    new URL("http://127.0.0.1:4317/api/events"),
    normalize({ hook_event_name: "SessionStart", cwd: "/repo" }),
    {
      authToken: AUTH_TOKEN,
      transport: { request() { requests += 1; } },
      verifyIdentity: async () => false
    }
  );
  assert.equal(requests, 0);
});
