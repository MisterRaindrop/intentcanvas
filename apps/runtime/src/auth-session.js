import { randomBytes, timingSafeEqual } from "node:crypto";

import { validateAuthToken } from "@intentcanvas/local-auth";
import { ReviewStoreError } from "./review-store.js";

export const HANDOFF_TTL_MS = 60_000;
export const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const MAX_HANDOFFS = 256;
const MAX_SESSIONS = 512;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length
    ? timingSafeEqual(leftBytes, rightBytes)
    : timingSafeEqual(Buffer.alloc(rightBytes.length), rightBytes) && false;
}

function opaqueToken(randomBytesImpl) {
  return randomBytesImpl(32).toString("base64url");
}

function cap(map, limit) {
  while (map.size > limit) map.delete(map.keys().next().value);
}

export class RuntimeAuthManager {
  #authToken;
  #handoffs = new Map();
  #sessions = new Map();
  #now;
  #randomBytes;

  constructor(authToken, {
    now = Date.now,
    randomBytesImpl = randomBytes,
    handoffTtlMs = HANDOFF_TTL_MS,
    sessionTtlMs = SESSION_TTL_MS
  } = {}) {
    this.#authToken = validateAuthToken(authToken);
    this.#now = now;
    this.#randomBytes = randomBytesImpl;
    if (!Number.isInteger(handoffTtlMs) || handoffTtlMs < 1 || handoffTtlMs > 300_000) {
      throw new TypeError("handoffTtlMs must be between 1 and 300000");
    }
    if (!Number.isInteger(sessionTtlMs) || sessionTtlMs < 60_000 ||
        sessionTtlMs > 24 * 60 * 60 * 1_000) {
      throw new TypeError("sessionTtlMs must be between one minute and one day");
    }
    this.handoffTtlMs = handoffTtlMs;
    this.sessionTtlMs = sessionTtlMs;
  }

  #prune() {
    const current = this.#now();
    for (const [token, record] of this.#handoffs) {
      if (record.expiresAt <= current) this.#handoffs.delete(token);
    }
    for (const [token, record] of this.#sessions) {
      if (record.expiresAt <= current) this.#sessions.delete(token);
    }
  }

  createHandoff(reviewId) {
    if (typeof reviewId !== "string" || !reviewId || reviewId.length > 256 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(reviewId)) {
      throw new ReviewStoreError("Review id is not safe for a browser handoff", {
        code: "invalid_review_id",
        status: 400
      });
    }
    this.#prune();
    const token = opaqueToken(this.#randomBytes);
    const expiresAt = this.#now() + this.handoffTtlMs;
    this.#handoffs.set(token, { reviewId, expiresAt });
    cap(this.#handoffs, MAX_HANDOFFS);
    return { handoff: token, reviewId, expiresAt: new Date(expiresAt).toISOString() };
  }

  exchangeHandoff(token) {
    this.#prune();
    if (typeof token !== "string" || !OPAQUE_TOKEN.test(token)) {
      throw new ReviewStoreError("Browser handoff is invalid or expired", {
        code: "invalid_handoff",
        status: 401
      });
    }
    const record = this.#handoffs.get(token);
    this.#handoffs.delete(token);
    if (!record || record.expiresAt <= this.#now()) {
      throw new ReviewStoreError("Browser handoff is invalid or expired", {
        code: "invalid_handoff",
        status: 401
      });
    }
    const session = opaqueToken(this.#randomBytes);
    const expiresAt = this.#now() + this.sessionTtlMs;
    this.#sessions.set(session, { reviewId: record.reviewId, expiresAt });
    cap(this.#sessions, MAX_SESSIONS);
    return {
      reviewId: record.reviewId,
      session,
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  authenticate(headers = {}) {
    this.#prune();
    const authorization = headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      return null;
    }
    const credential = authorization.slice("Bearer ".length);
    if (safeEqual(credential, this.#authToken)) return { kind: "bearer" };
    if (!OPAQUE_TOKEN.test(credential)) return null;
    const record = this.#sessions.get(credential);
    return record && record.expiresAt > this.#now()
      ? { kind: "session", reviewId: record.reviewId }
      : null;
  }

  authorize(headers = {}) {
    return this.authenticate(headers) !== null;
  }
}
