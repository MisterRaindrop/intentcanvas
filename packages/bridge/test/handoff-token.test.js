import assert from "node:assert/strict";
import test from "node:test";

import {
  HANDOFF_TOKEN_PREFIX,
  HANDOFF_TOKEN_VERSION,
  createHandoffToken,
  verifyHandoffToken
} from "../src/index.js";

const secret = Buffer.alloc(32, 0x5a);
const now = Date.UTC(2026, 6, 17, 8, 0, 0);
const claims = { reviewId: "review/42", host: "LOCALHOST", port: 4317 };

test("creates a versioned base64url HMAC token and verifies request binding", () => {
  const token = createHandoffToken(claims, {
    secret,
    now,
    ttlSeconds: 45
  });
  const [prefix, encodedPayload, signature] = token.split(".");
  assert.equal(prefix, HANDOFF_TOKEN_PREFIX);
  assert.match(encodedPayload, /^[A-Za-z0-9_-]+$/);
  assert.match(signature, /^[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(token, /review\/42|LOCALHOST/);

  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  assert.equal(payload.v, HANDOFF_TOKEN_VERSION);
  assert.equal(payload.host, "localhost");
  assert.equal(payload.exp - payload.iat, 45);

  assert.deepEqual(verifyHandoffToken(token, {
    secret,
    now: now + 44_000,
    expected: { reviewId: "review/42", host: "localhost", port: 4317 }
  }), {
    version: 1,
    reviewId: "review/42",
    host: "localhost",
    port: 4317,
    issuedAt: now / 1_000,
    expiresAt: now / 1_000 + 45
  });
});

test("rejects an expired token at the expiry boundary", () => {
  const token = createHandoffToken(claims, { secret, now, ttlSeconds: 2 });
  assert.throws(
    () => verifyHandoffToken(token, { secret, now: now + 2_000 }),
    (error) => error.code === "expired_handoff_token"
  );
});

test("rejects payload and signature tampering", () => {
  const token = createHandoffToken(claims, { secret, now });
  const parts = token.split(".");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  payload.reviewId = "review/other";
  const alteredPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  assert.throws(
    () => verifyHandoffToken(`${parts[0]}.${alteredPayload}.${parts[2]}`, { secret, now }),
    (error) => error.code === "invalid_handoff_token"
  );

  const first = parts[2][0] === "A" ? "B" : "A";
  const alteredSignature = `${first}${parts[2].slice(1)}`;
  assert.throws(
    () => verifyHandoffToken(`${parts[0]}.${parts[1]}.${alteredSignature}`, { secret, now }),
    (error) => error.code === "invalid_handoff_token"
  );
});

test("rejects mismatched review, host, and port bindings", () => {
  const token = createHandoffToken(claims, { secret, now });
  for (const expected of [
    { reviewId: "other" },
    { host: "127.0.0.1" },
    { port: 4318 }
  ]) {
    assert.throws(
      () => verifyHandoffToken(token, { secret, now, expected }),
      (error) => error.code === "handoff_token_binding_mismatch"
    );
  }
});

test("enforces strong secrets and short lifetimes", () => {
  assert.throws(
    () => createHandoffToken(claims, { secret: "too-short", now }),
    (error) => error.code === "invalid_token_secret"
  );
  assert.throws(
    () => createHandoffToken(claims, { secret, now, ttlSeconds: 301 }),
    (error) => error.code === "invalid_token_ttl"
  );
  const token = createHandoffToken(claims, { secret, now });
  assert.throws(
    () => verifyHandoffToken(`v2.${token.split(".").slice(1).join(".")}`, { secret, now }),
    (error) => error.code === "unsupported_handoff_token"
  );
});
