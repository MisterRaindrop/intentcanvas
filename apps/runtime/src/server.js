import { createServer as createHttpServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLAN_SCHEMA_VERSION,
  createTdePlanFixture
} from "@intentcanvas/protocol";
import { ReviewStore, ReviewStoreError } from "./review-store.js";

export const RUNTIME_HOST = "127.0.0.1";
export const RUNTIME_PORT = 4317;
export const RUNTIME_VERSION = "0.1.0";

const MONOREPO_STUDIO_DIRECTORY = fileURLToPath(
  new URL("../../studio/", import.meta.url)
);

export function resolveStudioDirectory(
  configuredDirectory = process.env.INTENTCANVAS_STUDIO_DIR
) {
  return typeof configuredDirectory === "string" && configuredDirectory.trim().length > 0
    ? resolve(configuredDirectory)
    : MONOREPO_STUDIO_DIRECTORY;
}

export const DEFAULT_STUDIO_DIRECTORY = resolveStudioDirectory();

const MAX_JSON_BYTES = 256 * 1024;

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

function commonHeaders() {
  return {
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN"
  };
}

function sendJson(response, status, value, { head = false } = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...commonHeaders(),
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(head ? undefined : body);
}

function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, { ...commonHeaders(), ...headers });
  response.end();
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_JSON_BYTES) {
      throw new ReviewStoreError(`JSON body exceeds ${MAX_JSON_BYTES} bytes`, {
        code: "body_too_large",
        status: 413
      });
    }
    chunks.push(chunk);
  }

  if (length === 0) {
    throw new ReviewStoreError("JSON body is required", {
      code: "empty_body",
      status: 400
    });
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ReviewStoreError("Request body is not valid JSON", {
      code: "invalid_json",
      status: 400
    });
  }
}

function decodeSegments(pathname) {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    throw new ReviewStoreError("URL contains invalid escaping", {
      code: "invalid_url",
      status: 400
    });
  }
}

async function findStaticFile(pathname, studioDirectory) {
  const root = resolve(studioDirectory);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relativePath = decodedPath === "/" ? "index.html" : `.${decodedPath}`;
  let candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) candidate = resolve(candidate, "index.html");
    if ((await stat(candidate)).isFile()) return candidate;
  } catch {
    // Extensionless routes fall through to the Studio shell below.
  }

  if (extname(decodedPath) === "") {
    const shell = resolve(root, "index.html");
    try {
      if ((await stat(shell)).isFile()) return shell;
    } catch {
      return null;
    }
  }
  return null;
}

async function serveStatic(request, response, pathname, studioDirectory) {
  const file = await findStaticFile(pathname, studioDirectory);
  if (!file) {
    sendJson(response, 404, {
      error: {
        code: "not_found",
        message: "No API route or Studio resource matched this URL"
      }
    }, { head: request.method === "HEAD" });
    return;
  }

  const body = await readFile(file);
  response.writeHead(200, {
    ...commonHeaders(),
    "Cache-Control": "no-cache",
    "Content-Length": body.length,
    "Content-Type": CONTENT_TYPES.get(extname(file).toLowerCase()) ?? "application/octet-stream"
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function apiError(response, error) {
  if (error instanceof ReviewStoreError) {
    sendJson(response, error.status, {
      error: {
        code: error.code,
        message: error.message,
        details: error.details
      }
    });
    return;
  }

  sendJson(response, 500, {
    error: {
      code: "internal_error",
      message: "IntentCanvas Runtime could not process the request"
    }
  });
}

export function createDefaultReviewStore() {
  return new ReviewStore([createTdePlanFixture()]);
}

export function createRequestHandler({
  store = createDefaultReviewStore(),
  studioDirectory = resolveStudioDirectory(),
  now = () => new Date()
} = {}) {
  return async function requestHandler(request, response) {
    try {
      const url = new URL(request.url ?? "/", `http://${RUNTIME_HOST}`);
      const segments = decodeSegments(url.pathname);
      const isApi = segments[0] === "api";

      if (request.method === "OPTIONS" && isApi) {
        sendEmpty(response, 204, { Allow: "GET, HEAD, POST, OPTIONS" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "intentcanvas-runtime",
          version: RUNTIME_VERSION,
          schemaVersion: PLAN_SCHEMA_VERSION,
          reviewCount: store.size,
          eventCount: store.eventCount
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/reviews") {
        sendJson(response, 200, { reviews: store.listReviews() });
        return;
      }

      if (request.method === "GET" && segments.length === 3 &&
          segments[0] === "api" && segments[1] === "reviews") {
        const review = store.getReview(segments[2]);
        if (!review) {
          throw new ReviewStoreError(`Unknown review: ${segments[2]}`, {
            code: "review_not_found",
            status: 404
          });
        }
        sendJson(response, 200, review);
        return;
      }

      if (request.method === "POST" && segments.length === 4 &&
          segments[0] === "api" && segments[1] === "reviews" &&
          segments[3] === "decisions") {
        const input = await readJson(request);
        const result = store.submitDecision(segments[2], input, { now });
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && segments.length === 6 &&
          segments[0] === "api" && segments[1] === "reviews" &&
          segments[3] === "modules" && segments[5] === "approval") {
        const body = await readJson(request);
        const result = store.submitDecision(
          segments[2],
          { ...body, moduleId: segments[4] },
          { now }
        );
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/events") {
        const event = await readJson(request);
        const result = store.recordEvent(event, { now });
        sendJson(response, 202, result);
        return;
      }

      if (isApi) {
        const status = ["GET", "HEAD", "POST", "OPTIONS"].includes(request.method ?? "")
          ? 404
          : 405;
        sendJson(response, status, {
          error: {
            code: status === 405 ? "method_not_allowed" : "not_found",
            message: status === 405 ? "Method is not allowed for this API" : "API route not found"
          }
        });
        return;
      }

      if (request.method === "GET" || request.method === "HEAD") {
        await serveStatic(request, response, url.pathname, studioDirectory);
        return;
      }

      sendJson(response, 405, {
        error: { code: "method_not_allowed", message: "Only GET and HEAD serve Studio resources" }
      });
    } catch (error) {
      apiError(response, error);
    }
  };
}

export function createRuntimeServer(options = {}) {
  return createHttpServer(createRequestHandler(options));
}

export function osc8Hyperlink(label, url) {
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

function validatePort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError("port must be an integer between 0 and 65535");
  }
}

export async function startRuntime({
  port = RUNTIME_PORT,
  store = createDefaultReviewStore(),
  studioDirectory = resolveStudioDirectory(),
  logger = console,
  now = () => new Date()
} = {}) {
  validatePort(port);
  const server = createRuntimeServer({ store, studioDirectory, now });

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, RUNTIME_HOST);
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = `http://${RUNTIME_HOST}:${actualPort}`;
  const primaryReview = store.listReviews()[0] ?? null;
  const reviewUrl = primaryReview
    ? `${baseUrl}/?review=${encodeURIComponent(primaryReview.id)}`
    : baseUrl;

  logger.log(`IntentCanvas Runtime: ${baseUrl}`);
  logger.log(`Review ready: ${osc8Hyperlink("Open visual plan", reviewUrl)}`);

  return {
    server,
    store,
    host: RUNTIME_HOST,
    port: actualPort,
    baseUrl,
    reviewUrl,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    })
  };
}
