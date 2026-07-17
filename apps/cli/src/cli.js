import { readFile } from "node:fs/promises";

import {
  bearerAuthorization,
  readAuthToken
} from "@intentcanvas/local-auth";
import { PLAN_SCHEMA_VERSION, validatePlanModel } from "@intentcanvas/protocol";

export const CLI_VERSION = "0.2.0";
export const DEFAULT_RUNTIME_URL = "http://127.0.0.1:4317";
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const OPAQUE_HANDOFF = /^[A-Za-z0-9_-]{43}$/u;

const HELP = `IntentCanvas CLI ${CLI_VERSION}

Usage:
  intentcanvas status [--runtime URL]
  intentcanvas plan validate <file|->
  intentcanvas plan import <file|-> [--runtime URL]
  intentcanvas plan open <review-id> [--runtime URL]
  intentcanvas plan revise <review-id> <module-id> <module-file|-> [--runtime URL]

Use '-' to read a plan or module from standard input.
`;

export class CliError extends Error {
  constructor(code, message, { details = [], exitCode = 1 } = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

function write(stream, value) {
  stream.write(String(value));
}

function writeLine(stream, value = "") {
  write(stream, `${value}\n`);
}

export function osc8Hyperlink(label, url) {
  if (typeof label !== "string" || !label || /[\u0000-\u001f\u007f-\u009f]/u.test(label)) {
    throw new CliError("invalid_link_label", "OSC8 link label is not safe");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError("invalid_link_url", "OSC8 link URL is not valid");
  }
  if (!["http:", "https:"].includes(parsed.protocol) ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(url)) {
    throw new CliError("invalid_link_url", "OSC8 link URL is not safe");
  }
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

export function normalizeRuntimeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("invalid_runtime_url", "Runtime URL is not valid");
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new CliError("invalid_runtime_url", "Runtime URL must use http or https");
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new CliError(
      "insecure_runtime_url",
      "A non-loopback Runtime URL must use https"
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CliError(
      "invalid_runtime_url",
      "Runtime URL must not contain credentials, query parameters, or a fragment"
    );
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname) {
    throw new CliError("invalid_runtime_url", "Runtime URL must not contain a path");
  }
  return url.origin;
}

export function reviewUrl(runtimeUrl, reviewId, handoff) {
  const url = new URL(normalizeRuntimeUrl(runtimeUrl));
  url.searchParams.set("review", safeIdentifier(reviewId, "review id"));
  if (handoff !== undefined) {
    if (typeof handoff !== "string" || !OPAQUE_HANDOFF.test(handoff)) {
      throw new CliError("invalid_runtime_response", "browser handoff is invalid");
    }
    url.searchParams.set("handoff", handoff);
  }
  return url.href;
}

function safeIdentifier(value, name) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) {
    throw new CliError("invalid_runtime_response", `${name} is not safe for terminal output`);
  }
  return value;
}

export function parseJsonDocument(input) {
  const source = String(input).trim();
  if (!source) throw new CliError("empty_input", "Input is empty");

  try {
    return JSON.parse(source);
  } catch {
    const blocks = [...source.matchAll(/```json[\t ]*\r?\n([\s\S]*?)```/gi)];
    if (blocks.length !== 1) {
      throw new CliError(
        "invalid_document",
        "Input must be JSON or contain exactly one fenced json block"
      );
    }
    try {
      return JSON.parse(blocks[0][1].trim());
    } catch {
      throw new CliError("invalid_json", "The fenced json block is not valid JSON");
    }
  }
}

function parseOptions(argv, env) {
  const args = [];
  let runtime = env.INTENTCANVAS_RUNTIME_URL ?? DEFAULT_RUNTIME_URL;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--runtime") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new CliError("missing_option_value", "--runtime requires a URL", { exitCode: 2 });
      }
      runtime = next;
      index += 1;
      continue;
    }
    if (value.startsWith("--")) {
      throw new CliError("unknown_option", `Unknown option: ${value}`, { exitCode: 2 });
    }
    args.push(value);
  }

  return { args, runtime };
}

async function defaultReadStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readDocument(path, dependencies) {
  const source = path === "-"
    ? await dependencies.readStdin()
    : await dependencies.readFile(path, "utf8");
  return parseJsonDocument(source);
}

function assertPlan(plan) {
  const validation = validatePlanModel(plan);
  if (!validation.valid) {
    throw new CliError("invalid_plan", "Plan Model validation failed", {
      details: validation.errors
    });
  }
  return plan;
}

function assertModule(module, expectedId) {
  if (!module || typeof module !== "object" || Array.isArray(module)) {
    throw new CliError("invalid_module", "Module must be a JSON object");
  }
  if (typeof module.id !== "string" || !module.id.trim()) {
    throw new CliError("invalid_module", "Module id must be a non-empty string");
  }
  if (module.id !== expectedId) {
    throw new CliError("module_id_mismatch", "Module file id does not match the requested module");
  }
  return module;
}

async function readResponseJson(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new CliError(
      "runtime_response_too_large",
      `Runtime response exceeds ${maxBytes} bytes`
    );
  }

  if (response.body && typeof response.body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        await response.body.cancel?.().catch?.(() => {});
        throw new CliError(
          "runtime_response_too_large",
          `Runtime response exceeds ${maxBytes} bytes`
        );
      }
      chunks.push(bytes);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return null;
    }
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function requestJson(fetchImpl, url, accessToken, options = {}, {
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  timeoutSignal = AbortSignal.timeout,
  maxResponseBytes = MAX_RESPONSE_BYTES
} = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: options.signal ?? timeoutSignal(timeoutMs),
      headers: {
        Accept: "application/json",
        Authorization: bearerAuthorization(accessToken),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers
      }
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new CliError("runtime_timeout", "IntentCanvas Runtime request timed out");
    }
    throw new CliError("runtime_unreachable", "IntentCanvas Runtime is not reachable");
  }

  const payload = await readResponseJson(response, maxResponseBytes);
  if (!response.ok) {
    throw new CliError(
      payload?.error?.code ?? "runtime_error",
      payload?.error?.message ?? `Runtime returned HTTP ${response.status}`,
      { details: Array.isArray(payload?.error?.details) ? payload.error.details : [] }
    );
  }
  if (!payload || typeof payload !== "object") {
    throw new CliError("invalid_runtime_response", "Runtime returned an invalid JSON response");
  }
  return payload;
}

async function createBrowserHandoff(fetchImpl, runtime, accessToken, reviewId, requestOptions) {
  const safeReviewId = safeIdentifier(reviewId, "review id");
  const payload = await requestJson(
    fetchImpl,
    `${runtime}/api/handoffs`,
    accessToken,
    { method: "POST", body: JSON.stringify({ reviewId: safeReviewId }) },
    requestOptions
  );
  if (payload.reviewId !== safeReviewId ||
      typeof payload.handoff !== "string" || !OPAQUE_HANDOFF.test(payload.handoff)) {
    throw new CliError("invalid_runtime_response", "Runtime returned an invalid browser handoff");
  }
  return payload.handoff;
}

function requireArguments(args, count, usage) {
  if (args.length !== count) {
    throw new CliError("invalid_arguments", `Usage: ${usage}`, { exitCode: 2 });
  }
}

function printReviewLink(stdout, runtime, reviewId, handoff) {
  const url = reviewUrl(runtime, reviewId, handoff);
  writeLine(stdout, `Review URL: ${url}`);
  writeLine(stdout, osc8Hyperlink("Open visual plan", url));
}

function reportError(stderr, error) {
  const normalized = error instanceof CliError
    ? error
    : new CliError("unexpected_error", "IntentCanvas could not complete the command");
  writeLine(stderr, JSON.stringify({
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details
    }
  }));
  return normalized.exitCode;
}

export async function runCli(argv, overrides = {}) {
  const dependencies = {
    env: overrides.env ?? process.env,
    fetch: overrides.fetch ?? globalThis.fetch,
    readFile: overrides.readFile ?? readFile,
    readStdin: overrides.readStdin ?? defaultReadStdin,
    readAuthToken: overrides.readAuthToken ?? readAuthToken,
    home: overrides.home,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr
  };
  dependencies.requestOptions = {
    timeoutMs: overrides.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    timeoutSignal: overrides.timeoutSignal ?? AbortSignal.timeout,
    maxResponseBytes: overrides.maxResponseBytes ?? MAX_RESPONSE_BYTES
  };

  try {
    if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
      write(dependencies.stdout, HELP);
      return 0;
    }
    if (argv.length === 1 && argv[0] === "--version") {
      writeLine(dependencies.stdout, CLI_VERSION);
      return 0;
    }

    const { args, runtime: configuredRuntime } = parseOptions(argv, dependencies.env);
    if (args[0] === "status") {
      requireArguments(args, 1, "intentcanvas status [--runtime URL]");
      const runtime = normalizeRuntimeUrl(configuredRuntime);
      const accessToken = await dependencies.readAuthToken({
        env: dependencies.env,
        home: dependencies.home
      });
      if (accessToken === null) {
        throw new CliError("runtime_auth_required", "IntentCanvas local auth token was not found");
      }
      const health = await requestJson(
        dependencies.fetch,
        `${runtime}/api/health`,
        accessToken,
        {},
        dependencies.requestOptions
      );
      writeLine(dependencies.stdout, JSON.stringify({ ok: true, runtime, health }));
      return 0;
    }

    if (args[0] !== "plan") {
      throw new CliError("unknown_command", "Unknown command. Run intentcanvas --help", {
        exitCode: 2
      });
    }

    const action = args[1];
    if (action === "validate") {
      requireArguments(args, 3, "intentcanvas plan validate <file|->");
      const plan = assertPlan(await readDocument(args[2], dependencies));
      writeLine(dependencies.stdout, JSON.stringify({
        ok: true,
        schemaVersion: PLAN_SCHEMA_VERSION,
        reviewId: plan.id,
        modules: plan.modules.length
      }));
      return 0;
    }

    const runtime = normalizeRuntimeUrl(configuredRuntime);
    const accessToken = await dependencies.readAuthToken({
      env: dependencies.env,
      home: dependencies.home
    });
    if (accessToken === null) {
      throw new CliError("runtime_auth_required", "IntentCanvas local auth token was not found");
    }

    if (action === "import") {
      requireArguments(args, 3, "intentcanvas plan import <file|-> [--runtime URL]");
      const plan = assertPlan(await readDocument(args[2], dependencies));
      const result = await requestJson(dependencies.fetch, `${runtime}/api/reviews`, accessToken, {
        method: "POST",
        body: JSON.stringify(plan)
      }, dependencies.requestOptions);
      const importedId = safeIdentifier(typeof result.review?.id === "string"
        ? result.review.id
        : typeof result.id === "string" ? result.id : plan.id, "review id");
      const handoff = await createBrowserHandoff(
        dependencies.fetch,
        runtime,
        accessToken,
        importedId,
        dependencies.requestOptions
      );
      writeLine(dependencies.stdout, `Imported review: ${importedId}`);
      printReviewLink(dependencies.stdout, runtime, importedId, handoff);
      return 0;
    }

    if (action === "open") {
      requireArguments(args, 3, "intentcanvas plan open <review-id> [--runtime URL]");
      const reviewId = safeIdentifier(args[2], "review id");
      const handoff = await createBrowserHandoff(
        dependencies.fetch,
        runtime,
        accessToken,
        reviewId,
        dependencies.requestOptions
      );
      printReviewLink(dependencies.stdout, runtime, reviewId, handoff);
      return 0;
    }

    if (action === "revise") {
      requireArguments(
        args,
        5,
        "intentcanvas plan revise <review-id> <module-id> <module-file|-> [--runtime URL]"
      );
      const [reviewId, moduleId, modulePath] = args.slice(2);
      const module = assertModule(await readDocument(modulePath, dependencies), moduleId);
      const result = await requestJson(
        dependencies.fetch,
        `${runtime}/api/reviews/${encodeURIComponent(reviewId)}/modules/${encodeURIComponent(moduleId)}`,
        accessToken,
        { method: "PATCH", body: JSON.stringify(module) },
        dependencies.requestOptions
      );
      writeLine(dependencies.stdout, `Revised module: ${safeIdentifier(
        result.module?.id ?? moduleId,
        "module id"
      )}`);
      const handoff = await createBrowserHandoff(
        dependencies.fetch,
        runtime,
        accessToken,
        reviewId,
        dependencies.requestOptions
      );
      printReviewLink(dependencies.stdout, runtime, reviewId, handoff);
      return 0;
    }

    throw new CliError("unknown_command", "Unknown plan command. Run intentcanvas --help", {
      exitCode: 2
    });
  } catch (error) {
    return reportError(dependencies.stderr, error);
  }
}
