#!/usr/bin/env node

import http from "node:http";
import https from "node:https";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  bearerAuthorization,
  createRuntimeIdentityChallenge,
  readAuthToken,
  verifyRuntimeIdentityProof
} from "../packages/local-auth/src/index.js";

export const DEFAULT_RUNTIME_URL = "http://127.0.0.1:4317/api/events";
export const DEFAULT_TIMEOUT_MS = 300;
export const MAX_TIMEOUT_MS = 1_500;
export const MAX_INPUT_BYTES = 2 * 1024 * 1024;

export const EVENT_TYPES = Object.freeze([
  "session_started",
  "session_ended",
  "plan_ready",
  "approval_required",
  "notification",
  "tool_running",
  "tool_finished",
  "task_complete",
  "review_drift_detected"
]);

const EVENT_TYPE_SET = new Set(EVENT_TYPES);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const HOOK_EVENT_TYPES = Object.freeze({
  SessionStart: "session_started",
  SessionEnd: "session_ended",
  Notification: "notification",
  PreToolUse: "tool_running",
  PostToolUse: "tool_finished",
  PostToolUseFailure: "tool_finished",
  TaskCompleted: "task_complete",
  Stop: "task_complete"
});

function safeString(value, maxLength = 512) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : null;
}

function safeIdentifier(value) {
  const candidate = safeString(value, 256);
  return candidate && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(candidate)
    ? candidate
    : null;
}

function safeStringList(value, maxItems = 100) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => safeIdentifier(item))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function configuredTimeoutMs(env = process.env) {
  const configured = Number.parseInt(env.INTENTCANVAS_HOOK_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}

export async function readInput(stream = process.stdin) {
  const chunks = [];
  let size = 0;

  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return null;
    chunks.push(chunk);
  }

  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function explicitEventType(input, hookName) {
  const intentcanvas = input.intentcanvas && typeof input.intentcanvas === "object"
    ? input.intentcanvas
    : {};
  const candidates = [
    input.intentcanvas_event_type,
    intentcanvas.type,
    hookName === "IntentCanvas" ? input.type : null,
    EVENT_TYPE_SET.has(input.notification_type) ? input.notification_type : null,
    EVENT_TYPE_SET.has(hookName) ? hookName : null
  ];
  return candidates.find((candidate) => EVENT_TYPE_SET.has(candidate)) ?? null;
}

function eventPayload(input, hookName, type) {
  const payload = { hookEventName: hookName };
  const sessionSource = safeString(input.source, 64);
  const sessionReason = safeString(input.reason, 64);
  const notificationType = safeString(input.notification_type, 64);
  const toolName = safeString(input.tool_name, 128);
  const intentcanvas = input.intentcanvas && typeof input.intentcanvas === "object"
    ? input.intentcanvas
    : {};
  const moduleIds = safeStringList(input.module_ids ?? intentcanvas.moduleIds);

  if (sessionSource) payload.sessionSource = sessionSource;
  if (sessionReason) payload.sessionReason = sessionReason;
  if (notificationType) payload.notificationType = notificationType;
  if (toolName) payload.toolName = toolName;
  if (moduleIds.length > 0) payload.moduleIds = moduleIds;
  if (hookName === "PostToolUseFailure") payload.outcome = "failure";
  if (hookName === "IntentCanvas") payload.semanticType = type;

  return payload;
}

export function normalize(input, {
  now = () => new Date(),
  fallbackCwd = process.cwd()
} = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const hookName = safeString(input.hook_event_name, 128) ?? "Unknown";
  const type = explicitEventType(input, hookName) ?? HOOK_EVENT_TYPES[hookName] ?? null;
  if (!type) return null;

  const intentcanvas = input.intentcanvas && typeof input.intentcanvas === "object"
    ? input.intentcanvas
    : {};
  const reviewId = safeIdentifier(
    input.review_id ?? input.reviewId ?? intentcanvas.reviewId
  );

  return {
    schemaVersion: "1.0.0",
    source: "claude-code",
    type,
    occurredAt: now().toISOString(),
    sessionId: safeIdentifier(input.session_id),
    project: {
      cwd: safeString(input.cwd, 4096) ?? fallbackCwd
    },
    payload: eventPayload(input, hookName, type),
    ...(reviewId ? { reviewId } : {})
  };
}

export function eventInputFromArguments(argv, cwd = process.cwd()) {
  let eventType = null;
  let reviewId = null;
  const moduleIds = [];

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!["--event", "--review-id", "--module-id"].includes(option) || !value) return null;
    if (option === "--event") eventType = value;
    if (option === "--review-id") reviewId = value;
    if (option === "--module-id") moduleIds.push(value);
    index += 1;
  }

  if (!EVENT_TYPE_SET.has(eventType)) return null;
  return {
    hook_event_name: "IntentCanvas",
    intentcanvas_event_type: eventType,
    cwd,
    ...(reviewId ? { review_id: reviewId } : {}),
    ...(moduleIds.length > 0 ? { module_ids: moduleIds } : {})
  };
}

export function resolveEventEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username ||
      endpoint.password || endpoint.search || endpoint.hash) return null;
  if (!LOOPBACK_HOSTS.has(endpoint.hostname.toLowerCase())) return null;

  const pathname = endpoint.pathname.replace(/\/+$/, "");
  if (!pathname) endpoint.pathname = "/api/events";
  else if (pathname !== "/api/events") return null;
  else endpoint.pathname = pathname;
  return endpoint;
}

export async function verifyEventEndpointIdentity(endpoint, authToken, {
  timeout = DEFAULT_TIMEOUT_MS,
  transport = endpoint?.protocol === "https:" ? https : http,
  randomBytesImpl
} = {}) {
  if (!endpoint || !["http:", "https:"].includes(endpoint.protocol)) return false;
  const challenge = createRuntimeIdentityChallenge(randomBytesImpl);
  const identityUrl = new URL("/api/identity", endpoint.origin);
  identityUrl.searchParams.set("challenge", challenge);

  return new Promise((resolveIdentity) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveIdentity(value);
    };
    const request = transport.request(identityUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "intentcanvas-claude-hook/0.2"
      }
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 4096) {
          request.destroy();
          finish(false);
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        if (response.statusCode !== 200) return finish(false);
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          finish(payload?.service === "intentcanvas-runtime" &&
            payload?.challenge === challenge &&
            verifyRuntimeIdentityProof(authToken, challenge, payload?.proof));
        } catch {
          finish(false);
        }
      });
      response.once("error", () => finish(false));
    });
    request.setTimeout(timeout, () => {
      request.destroy();
      finish(false);
    });
    request.once("error", () => finish(false));
    request.end();
  });
}

export async function postEvent(endpoint, event, {
  timeout = DEFAULT_TIMEOUT_MS,
  authToken,
  transport = endpoint?.protocol === "https:" ? https : http,
  verifyIdentity = verifyEventEndpointIdentity
} = {}) {
  if (!endpoint || !["http:", "https:"].includes(endpoint.protocol)) return;
  if (!await verifyIdentity(endpoint, authToken, { timeout, transport })) return;

  const body = JSON.stringify(event);

  await new Promise((resolveRequest) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveRequest();
    };

    const request = transport.request(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "authorization": bearerAuthorization(authToken),
        "user-agent": "intentcanvas-claude-hook/0.2"
      }
    }, (response) => {
      response.resume();
      response.once("end", finish);
      response.once("error", finish);
    });

    request.setTimeout(timeout, () => {
      request.destroy();
      finish();
    });
    request.once("error", finish);
    request.end(body);
  });
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdin = process.stdin,
  cwd = process.cwd(),
  home
} = {}) {
  const input = argv.length > 0
    ? eventInputFromArguments(argv, cwd)
    : await readInput(stdin);
  if (!input) return;

  const event = normalize(input, { fallbackCwd: cwd });
  const endpoint = resolveEventEndpoint(env.INTENTCANVAS_RUNTIME_URL ?? DEFAULT_RUNTIME_URL);
  const authToken = await readAuthToken({ env, home });
  if (!event || !endpoint || !authToken) return;

  await postEvent(endpoint, event, {
    timeout: configuredTimeoutMs(env),
    authToken
  });
}

const invokedAsScript = process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) await main().catch(() => {});
