import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeAuthManager } from "../src/auth-session.js";

const AUTH_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("exchanges a one-use short handoff for a review-scoped bearer session", () => {
  let current = Date.UTC(2026, 6, 17, 0, 0, 0);
  let byte = 0;
  const manager = new RuntimeAuthManager(AUTH_TOKEN, {
    now: () => current,
    randomBytesImpl: (size) => Buffer.alloc(size, ++byte)
  });
  const handoff = manager.createHandoff("review-1");
  const exchanged = manager.exchangeHandoff(handoff.handoff);
  const authorization = { authorization: `Bearer ${exchanged.session}` };

  assert.equal(exchanged.reviewId, "review-1");
  assert.deepEqual(manager.authenticate(authorization), {
    kind: "session",
    reviewId: "review-1"
  });
  assert.equal(manager.authorize({ authorization: `Bearer ${AUTH_TOKEN}` }), true);
  assert.throws(
    () => manager.exchangeHandoff(handoff.handoff),
    (error) => error.code === "invalid_handoff"
  );

  current += manager.sessionTtlMs;
  assert.equal(manager.authorize(authorization), false);
});

test("rejects expired handoffs and unrelated credentials", () => {
  let current = 1_000_000;
  const manager = new RuntimeAuthManager(AUTH_TOKEN, { now: () => current });
  const handoff = manager.createHandoff("review-1");
  current += manager.handoffTtlMs;

  assert.throws(
    () => manager.exchangeHandoff(handoff.handoff),
    (error) => error.code === "invalid_handoff"
  );
  assert.equal(manager.authorize({ authorization: `Bearer ${"B".repeat(43)}` }), false);
});

test("browser sessions stay inside the Runtime instance that issued them", () => {
  const first = new RuntimeAuthManager(AUTH_TOKEN);
  const second = new RuntimeAuthManager(AUTH_TOKEN);
  const firstSession = first.exchangeHandoff(first.createHandoff("review-1").handoff);
  const credential = { authorization: `Bearer ${firstSession.session}` };

  assert.equal(first.authorize(credential), true);
  assert.equal(second.authorize(credential), false);
});

test("accepts configured long-term bearer tokens across the documented length range", () => {
  for (const length of [43, 64, 128]) {
    const token = "A".repeat(length);
    const manager = new RuntimeAuthManager(token);
    assert.deepEqual(
      manager.authenticate({ authorization: `Bearer ${token}` }),
      { kind: "bearer" }
    );
  }
});
