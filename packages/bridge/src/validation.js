import { homedir } from "node:os";
import { isIP } from "node:net";
import { resolve } from "node:path";

import { BridgeError } from "./errors.js";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const HOST_LABEL = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/u;
const USER_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/u;
const LOOPBACK_URL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function invalid(code, message) {
  throw new BridgeError(code, message, { exitCode: 2 });
}

function validateText(value, name, { maxLength, allowWhitespace = false } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    invalid(`invalid_${name}`, `${name} must be a non-empty string`);
  }
  if (value !== value.trim()) {
    invalid(`invalid_${name}`, `${name} must not have leading or trailing whitespace`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    invalid(`invalid_${name}`, `${name} must not contain control characters`);
  }
  if (!allowWhitespace && /\s/u.test(value)) {
    invalid(`invalid_${name}`, `${name} must not contain whitespace`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    invalid(`invalid_${name}`, `${name} is too long`);
  }
  return value;
}

export function validateReviewId(value) {
  const reviewId = validateText(value, "review_id", { maxLength: 256 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(reviewId)) {
    invalid(
      "invalid_review_id",
      "review_id must use only letters, digits, '.', '_', ':', '/', or '-'"
    );
  }
  return reviewId;
}

export function validateBrowserHandoff(value) {
  const handoff = validateText(value, "handoff", { maxLength: 43 });
  if (!/^[A-Za-z0-9_-]{43}$/u.test(handoff)) {
    invalid("invalid_handoff", "handoff must be a 43 character base64url token");
  }
  return handoff;
}

export function parsePort(value, name = "port", { allowZero = false } = {}) {
  let port;
  if (typeof value === "number") {
    port = value;
  } else if (typeof value === "string" && /^(?:0|[1-9][0-9]{0,4})$/u.test(value)) {
    port = Number(value);
  } else {
    invalid(`invalid_${name}`, `${name} must be a decimal integer`);
  }

  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(port) || port < minimum || port > 65_535) {
    invalid(
      `invalid_${name}`,
      `${name} must be between ${minimum} and 65535`
    );
  }
  return port;
}

function normalizeHostValue(value, name) {
  const host = validateText(value, name, { maxLength: 253 });
  if (host.startsWith("-") || host.includes("@")) {
    invalid(`invalid_${name}`, `${name} is not a safe host name or IP address`);
  }

  if (host.startsWith("[") || host.endsWith("]")) {
    if (!(host.startsWith("[") && host.endsWith("]") && isIP(host.slice(1, -1)) === 6)) {
      invalid(`invalid_${name}`, `${name} has invalid IPv6 brackets`);
    }
    return host.slice(1, -1).toLowerCase();
  }

  if (isIP(host)) return host.toLowerCase();
  const withoutTrailingDot = host.endsWith(".") ? host.slice(0, -1) : host;
  const labels = withoutTrailingDot.split(".");
  if (!withoutTrailingDot || !labels.every((label) => HOST_LABEL.test(label))) {
    invalid(`invalid_${name}`, `${name} is not a safe host name or IP address`);
  }
  return withoutTrailingDot.toLowerCase();
}

export function validateHost(value) {
  return normalizeHostValue(value, "host");
}

export function validateDestination(value) {
  const destination = validateText(value, "destination", { maxLength: 320 });
  if (destination.startsWith("-")) {
    invalid("invalid_destination", "destination must not look like an ssh option");
  }

  const firstAt = destination.indexOf("@");
  const lastAt = destination.lastIndexOf("@");
  if (firstAt !== lastAt) {
    invalid("invalid_destination", "destination must contain at most one @ separator");
  }

  const user = firstAt === -1 ? null : destination.slice(0, firstAt);
  const rawHost = firstAt === -1 ? destination : destination.slice(firstAt + 1);
  if (user !== null && !USER_NAME.test(user)) {
    invalid("invalid_destination", "destination has an invalid ssh user name");
  }
  const host = normalizeHostValue(rawHost, "destination");
  return user === null ? host : `${user}@${host}`;
}

export function normalizeIdentityPath(value, {
  cwd = process.cwd(),
  home = homedir()
} = {}) {
  const identity = validateText(value, "identity", {
    maxLength: 4_096,
    allowWhitespace: true
  });
  if (identity.startsWith("-")) {
    invalid("invalid_identity", "identity must not look like an ssh option");
  }

  let expanded = identity;
  if (identity === "~") {
    expanded = home;
  } else if (identity.startsWith("~/")) {
    expanded = resolve(home, identity.slice(2));
  } else if (identity.startsWith("~")) {
    invalid("invalid_identity", "identity only supports ~ or ~/ home expansion");
  }
  return resolve(cwd, expanded);
}

export function normalizeRuntimeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    invalid("invalid_runtime_url", "Runtime URL is not valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    invalid("invalid_runtime_url", "Runtime URL must use http or https");
  }
  if (url.protocol === "http:" && !LOOPBACK_URL_HOSTS.has(url.hostname.toLowerCase())) {
    invalid("insecure_runtime_url", "A non-loopback Runtime URL must use https");
  }
  if (url.username || url.password || url.search || url.hash) {
    invalid(
      "invalid_runtime_url",
      "Runtime URL must not contain credentials, query parameters, or a fragment"
    );
  }
  if (url.pathname.replace(/\/+$/u, "")) {
    invalid("invalid_runtime_url", "Runtime URL must not contain a path");
  }
  return url.origin;
}

export function hasControlCharacters(value) {
  return typeof value === "string" && CONTROL_CHARACTERS.test(value);
}
