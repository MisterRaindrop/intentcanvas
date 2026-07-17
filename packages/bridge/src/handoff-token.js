import { createHmac, timingSafeEqual } from "node:crypto";

import { BridgeError } from "./errors.js";
import { parsePort, validateHost, validateReviewId } from "./validation.js";

export const HANDOFF_TOKEN_VERSION = 1;
export const HANDOFF_TOKEN_PREFIX = "v1";
export const DEFAULT_HANDOFF_TTL_SECONDS = 60;
export const MAX_HANDOFF_TTL_SECONDS = 300;

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export class HandoffTokenError extends BridgeError {
  constructor(code, message) {
    super(code, message);
    this.name = "HandoffTokenError";
  }
}

function tokenError(code, message) {
  throw new HandoffTokenError(code, message);
}

function normalizeSecret(secret) {
  let bytes;
  if (typeof secret === "string") {
    bytes = Buffer.from(secret, "utf8");
  } else if (Buffer.isBuffer(secret) || secret instanceof Uint8Array) {
    bytes = Buffer.from(secret);
  } else {
    tokenError("invalid_token_secret", "handoff token secret must be bytes or a string");
  }
  if (bytes.length < 32) {
    tokenError("invalid_token_secret", "handoff token secret must contain at least 32 bytes");
  }
  return bytes;
}

function nowInSeconds(now) {
  const milliseconds = typeof now === "function" ? now() : now;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    tokenError("invalid_token_time", "handoff token clock must return epoch milliseconds");
  }
  return Math.floor(milliseconds / 1_000);
}

function normalizeTtl(options) {
  if (options.ttlMs !== undefined && options.ttlSeconds !== undefined) {
    tokenError("invalid_token_ttl", "set either ttlSeconds or ttlMs, not both");
  }
  const seconds = options.ttlMs === undefined
    ? (options.ttlSeconds ?? DEFAULT_HANDOFF_TTL_SECONDS)
    : Math.ceil(options.ttlMs / 1_000);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_HANDOFF_TTL_SECONDS) {
    tokenError(
      "invalid_token_ttl",
      `handoff token lifetime must be between 1 and ${MAX_HANDOFF_TTL_SECONDS} seconds`
    );
  }
  return seconds;
}

function hmac(value, secret) {
  return createHmac("sha256", secret).update(value, "utf8").digest();
}

function decodeBase64Url(value) {
  if (!BASE64URL.test(value)) tokenError("invalid_handoff_token", "handoff token is invalid");
  const decoded = Buffer.from(value, "base64url");
  if (!decoded.length || decoded.toString("base64url") !== value) {
    tokenError("invalid_handoff_token", "handoff token is invalid");
  }
  return decoded;
}

function normalizeExpected(options) {
  const expected = options.expected ?? {};
  return {
    reviewId: options.reviewId ?? expected.reviewId,
    host: options.host ?? expected.host,
    port: options.port ?? expected.port
  };
}

export function createHandoffToken(claims, options = {}) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    tokenError("invalid_token_claims", "handoff token claims must be an object");
  }
  const secret = normalizeSecret(options.secret);
  const issuedAt = nowInSeconds(options.now ?? Date.now);
  const lifetime = normalizeTtl(options);
  const payload = {
    v: HANDOFF_TOKEN_VERSION,
    reviewId: validateReviewId(claims.reviewId),
    host: validateHost(claims.host),
    port: parsePort(claims.port, "port"),
    iat: issuedAt,
    exp: issuedAt + lifetime
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signedValue = `${HANDOFF_TOKEN_PREFIX}.${encodedPayload}`;
  const signature = hmac(signedValue, secret).toString("base64url");
  return `${signedValue}.${signature}`;
}

export function verifyHandoffToken(token, options = {}) {
  if (typeof token !== "string" || token.length > 4_096) {
    tokenError("invalid_handoff_token", "handoff token is invalid");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== HANDOFF_TOKEN_PREFIX) {
    tokenError("unsupported_handoff_token", "handoff token version is not supported");
  }

  const secret = normalizeSecret(options.secret);
  const payloadBytes = decodeBase64Url(parts[1]);
  let suppliedSignature;
  try {
    suppliedSignature = decodeBase64Url(parts[2]);
  } catch {
    tokenError("invalid_handoff_token", "handoff token is invalid");
  }
  const expectedSignature = hmac(`${parts[0]}.${parts[1]}`, secret);
  const signatureMatches = suppliedSignature.length === expectedSignature.length
    ? timingSafeEqual(suppliedSignature, expectedSignature)
    : timingSafeEqual(Buffer.alloc(expectedSignature.length), expectedSignature) && false;
  if (!signatureMatches) {
    tokenError("invalid_handoff_token", "handoff token signature is invalid");
  }

  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    tokenError("invalid_handoff_token", "handoff token payload is invalid");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    tokenError("invalid_handoff_token", "handoff token payload is invalid");
  }
  if (payload.v !== HANDOFF_TOKEN_VERSION) {
    tokenError("unsupported_handoff_token", "handoff token payload version is not supported");
  }

  let reviewId;
  let host;
  let port;
  try {
    reviewId = validateReviewId(payload.reviewId);
    host = validateHost(payload.host);
    port = parsePort(payload.port, "port");
  } catch {
    tokenError("invalid_handoff_token", "handoff token payload is invalid");
  }
  if (
    !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) ||
    payload.iat < 0 || payload.exp <= payload.iat ||
    payload.exp - payload.iat > MAX_HANDOFF_TTL_SECONDS
  ) {
    tokenError("invalid_handoff_token", "handoff token lifetime is invalid");
  }

  const currentTime = nowInSeconds(options.now ?? Date.now);
  if (payload.iat > currentTime + 5) {
    tokenError("invalid_handoff_token", "handoff token was issued in the future");
  }
  if (currentTime >= payload.exp) {
    tokenError("expired_handoff_token", "handoff token has expired");
  }

  const expected = normalizeExpected(options);
  if (expected.reviewId !== undefined && validateReviewId(expected.reviewId) !== reviewId) {
    tokenError("handoff_token_binding_mismatch", "handoff token does not match this review");
  }
  if (expected.host !== undefined && validateHost(expected.host) !== host) {
    tokenError("handoff_token_binding_mismatch", "handoff token does not match this host");
  }
  if (expected.port !== undefined && parsePort(expected.port, "port") !== port) {
    tokenError("handoff_token_binding_mismatch", "handoff token does not match this port");
  }

  return Object.freeze({
    version: HANDOFF_TOKEN_VERSION,
    reviewId,
    host,
    port,
    issuedAt: payload.iat,
    expiresAt: payload.exp
  });
}
