#!/usr/bin/env node

import http from "node:http";
import https from "node:https";

const DEFAULT_RUNTIME_URL = "http://127.0.0.1:4317/api/events";
const DEFAULT_TIMEOUT_MS = 300;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;

const EVENT_TYPES = Object.freeze({
  SessionStart: "session_started",
  Notification: "notification",
  Stop: "task_complete",
  SessionEnd: "session_ended"
});

function timeoutMs() {
  const configured = Number.parseInt(process.env.INTENTCANVAS_HOOK_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

async function readInput() {
  const chunks = [];
  let size = 0;

  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return null;
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function normalize(input) {
  const hookName = typeof input.hook_event_name === "string"
    ? input.hook_event_name
    : "Unknown";

  return {
    schemaVersion: "1.0.0",
    source: "claude-code",
    type: EVENT_TYPES[hookName] ?? hookName.toLowerCase(),
    occurredAt: new Date().toISOString(),
    sessionId: typeof input.session_id === "string" ? input.session_id : null,
    project: {
      cwd: typeof input.cwd === "string" ? input.cwd : process.cwd()
    },
    payload: input
  };
}

async function postEvent(endpoint, event) {
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return;

  const body = JSON.stringify(event);
  const transport = endpoint.protocol === "https:" ? https : http;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const request = transport.request(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "user-agent": "intentcanvas-claude-hook/0.1"
      }
    }, (response) => {
      response.resume();
      response.once("end", finish);
      response.once("error", finish);
    });

    request.setTimeout(timeoutMs(), () => {
      request.destroy();
      finish();
    });
    request.once("error", finish);
    request.end(body);
  });
}

async function main() {
  const input = await readInput();
  if (!input || typeof input !== "object" || Array.isArray(input)) return;

  let endpoint;
  try {
    endpoint = new URL(process.env.INTENTCANVAS_RUNTIME_URL ?? DEFAULT_RUNTIME_URL);
  } catch {
    return;
  }

  await postEvent(endpoint, normalize(input));
}

await main().catch(() => {});
