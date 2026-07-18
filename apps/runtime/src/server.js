import { createServer as createHttpServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadOrCreateAuthToken,
  validateAuthToken
} from "@intentcanvas/local-auth";
import {
  PLAN_SCHEMA_VERSION,
  createTdePlanFixture
} from "@intentcanvas/protocol";
import {
  acquireRuntimeDataDirectoryLock,
  JsonFileReviewPersistence,
  RuntimePersistenceError,
  SerializedReviewWriter,
  resolveDataDirectory
} from "./persistence.js";
import { RuntimeAuthManager } from "./auth-session.js";
import { ReviewStore, ReviewStoreError } from "./review-store.js";

export { resolveDataDirectory } from "./persistence.js";

export const RUNTIME_HOST = "127.0.0.1";
export const RUNTIME_PORT = 4317;
export const RUNTIME_VERSION = "0.2.0";

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
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

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
    "Content-Security-Policy": "default-src 'self'; base-uri 'none'; form-action 'self'; " +
      "frame-ancestors 'self'; object-src 'none'; img-src 'self' data:",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN"
  };
}

function sendJson(response, status, value, { head = false, headers = {} } = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...commonHeaders(),
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
    ...headers
  });
  response.end(head ? undefined : body);
}

function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, { ...commonHeaders(), ...headers });
  response.end();
}

async function readJson(request) {
  const contentType = String(request.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json" && !contentType.endsWith("+json")) {
    throw new ReviewStoreError("JSON requests must use application/json", {
      code: "unsupported_media_type",
      status: 415
    });
  }

  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_JSON_BYTES) {
      throw new ReviewStoreError(`JSON body exceeds ${MAX_JSON_BYTES} bytes`, {
        code: "body_too_large",
        status: 413
      });
    }
  }

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

function requiredExpectedRevision(request) {
  const value = request.headers["if-match"];
  const match = typeof value === "string" ? /^"(\d+)"$/u.exec(value) : null;
  if (match === null) {
    throw new ReviewStoreError("Structural review updates require an If-Match revision", {
      code: "revision_precondition_required",
      status: 428
    });
  }
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new ReviewStoreError("If-Match revision must be a positive integer", {
      code: "invalid_revision_precondition",
      status: 400
    });
  }
  return revision;
}

function assertLocalRequest(request) {
  const authorityValue = request.headers.host;
  if (typeof authorityValue !== "string" || authorityValue.length === 0) {
    throw new ReviewStoreError("Request Host is required", {
      code: "invalid_host",
      status: 400
    });
  }

  let authority;
  try {
    authority = new URL(`http://${authorityValue}`);
  } catch {
    throw new ReviewStoreError("Request Host is invalid", {
      code: "invalid_host",
      status: 400
    });
  }
  if (!LOOPBACK_HOSTS.has(authority.hostname.toLowerCase())) {
    throw new ReviewStoreError("IntentCanvas Runtime only accepts loopback Host values", {
      code: "non_loopback_host",
      status: 403
    });
  }

  const originValue = request.headers.origin;
  if (originValue === undefined) return;
  let origin;
  try {
    origin = new URL(originValue);
  } catch {
    throw new ReviewStoreError("Request Origin is invalid", {
      code: "invalid_origin",
      status: 403
    });
  }
  if (origin.protocol !== "http:" ||
      !LOOPBACK_HOSTS.has(origin.hostname.toLowerCase()) ||
      origin.host.toLowerCase() !== authority.host.toLowerCase()) {
    throw new ReviewStoreError("Cross-origin requests are not allowed", {
      code: "cross_origin_request",
      status: 403
    });
  }
}

function assertApiAuthorization(request, authManager) {
  if (authManager === false) return { kind: "disabled" };
  if (!authManager || typeof authManager.authorize !== "function") {
    throw new ReviewStoreError("Runtime authentication is not configured", {
      code: "runtime_auth_unavailable",
      status: 503
    });
  }
  const principal = typeof authManager.authenticate === "function"
    ? authManager.authenticate(request.headers)
    : authManager.authorize(request.headers) ? { kind: "bearer" } : null;
  if (!principal) {
    throw new ReviewStoreError("A valid local Runtime token is required", {
      code: "runtime_auth_required",
      status: 401
    });
  }
  return principal;
}

function assertBrowserSessionScope(request, segments, principal) {
  if (principal.kind !== "session") return;
  const reviewId = segments[0] === "api" && segments[1] === "reviews"
    ? segments[2]
    : null;
  const isReviewRead = request.method === "GET" &&
    [3, 4, 5].includes(segments.length);
  const isDecision = request.method === "POST" &&
    ((segments.length === 4 && segments[3] === "decisions") ||
      (segments.length === 6 && segments[3] === "modules" && segments[5] === "approval"));
  if (reviewId !== principal.reviewId || (!isReviewRead && !isDecision)) {
    throw new ReviewStoreError("Browser session is limited to its review", {
      code: "browser_session_scope",
      status: 403
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

  const decodedSegments = decodedPath.split("/").filter(Boolean);
  if (decodedSegments.some((segment) => segment.startsWith("."))) return null;

  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    return null;
  }

  async function containedFile(candidatePath) {
    let candidate = candidatePath;
    try {
      if ((await stat(candidate)).isDirectory()) {
        candidate = resolve(candidate, "index.html");
      }
      const canonicalCandidate = await realpath(candidate);
      if (canonicalCandidate !== canonicalRoot &&
          !canonicalCandidate.startsWith(`${canonicalRoot}${sep}`)) {
        return null;
      }
      return (await stat(canonicalCandidate)).isFile() ? canonicalCandidate : null;
    } catch {
      return null;
    }
  }

  const relativePath = decodedPath === "/" ? "index.html" : `.${decodedPath}`;
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;

  const matchedFile = await containedFile(candidate);
  if (matchedFile) return matchedFile;

  if (extname(decodedPath) === "") {
    return containedFile(resolve(root, "index.html"));
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

  if (error instanceof RuntimePersistenceError) {
    sendJson(response, error.status, {
      error: {
        code: error.code,
        message: "IntentCanvas could not persist the Runtime state",
        details: []
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
  now = () => new Date(),
  authManager = null,
  persistence = null,
  writer = new SerializedReviewWriter(store, persistence)
} = {}) {
  return async function requestHandler(request, response) {
    try {
      assertLocalRequest(request);
      const requestTarget = request.url ?? "/";
      const rawPathname = requestTarget.startsWith("/")
        ? requestTarget.split(/[?#]/u, 1)[0]
        : null;
      const url = new URL(requestTarget, `http://${RUNTIME_HOST}`);
      const segments = decodeSegments(url.pathname);
      const isApi = segments[0] === "api";

      if (request.method === "OPTIONS" && isApi) {
        sendEmpty(response, 204, { Allow: "GET, HEAD, POST, PUT, PATCH, OPTIONS" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/session") {
        if (!authManager || authManager === false) {
          throw new ReviewStoreError("Browser authentication is not configured", {
            code: "runtime_auth_unavailable",
            status: 503
          });
        }
        const body = await readJson(request);
        if (!body || typeof body !== "object" || Array.isArray(body) ||
            Object.keys(body).some((key) => key !== "handoff")) {
          throw new ReviewStoreError("Browser session request is invalid", {
            code: "invalid_handoff",
            status: 400
          });
        }
        const session = authManager.exchangeHandoff(body.handoff);
        sendJson(response, 200, {
          ok: true,
          reviewId: session.reviewId,
          session: session.session,
          expiresAt: session.expiresAt
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/identity") {
        if (!authManager || authManager === false ||
            typeof authManager.proveIdentity !== "function") {
          throw new ReviewStoreError("Runtime identity proof is not configured", {
            code: "runtime_auth_unavailable",
            status: 503
          });
        }
        const challenge = url.searchParams.get("challenge");
        if (url.searchParams.size !== 1 || typeof challenge !== "string") {
          throw new ReviewStoreError("A single Runtime identity challenge is required", {
            code: "invalid_runtime_identity_challenge",
            status: 400
          });
        }
        let proof;
        try {
          proof = authManager.proveIdentity(challenge);
        } catch {
          throw new ReviewStoreError("Runtime identity challenge is invalid", {
            code: "invalid_runtime_identity_challenge",
            status: 400
          });
        }
        sendJson(response, 200, {
          service: "intentcanvas-runtime",
          version: RUNTIME_VERSION,
          challenge,
          proof
        });
        return;
      }

      if (isApi) {
        const principal = assertApiAuthorization(request, authManager);
        assertBrowserSessionScope(request, segments, principal);
      }

      if (request.method === "POST" && url.pathname === "/api/handoffs") {
        const body = await readJson(request);
        if (!body || typeof body !== "object" || Array.isArray(body) ||
            Object.keys(body).some((key) => key !== "reviewId") ||
            typeof body.reviewId !== "string") {
          throw new ReviewStoreError("A reviewId is required", {
            code: "invalid_review_id",
            status: 400
          });
        }
        if (!store.getReview(body.reviewId)) {
          throw new ReviewStoreError(`Unknown review: ${body.reviewId}`, {
            code: "review_not_found",
            status: 404
          });
        }
        if (!authManager || authManager === false) {
          throw new ReviewStoreError("Browser authentication is not configured", {
            code: "runtime_auth_unavailable",
            status: 503
          });
        }
        sendJson(response, 201, authManager.createHandoff(body.reviewId));
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

      if (request.method === "POST" && segments.length === 2 &&
          segments[0] === "api" && segments[1] === "reviews") {
        const plan = await readJson(request);
        const result = await writer.mutate(
          (candidate) => candidate.importReview(plan, { now })
        );
        sendJson(response, 201, result, {
          headers: {
            Location: `/api/reviews/${encodeURIComponent(result.review.id)}`,
            "X-IntentCanvas-Revision": String(result.revision)
          }
        });
        return;
      }

      if (request.method === "PUT" && segments.length === 3 &&
          segments[0] === "api" && segments[1] === "reviews") {
        const expectedRevision = requiredExpectedRevision(request);
        const plan = await readJson(request);
        const result = await writer.mutate(
          (candidate) => candidate.replaceReview(segments[2], plan, {
            now,
            expectedRevision
          })
        );
        sendJson(response, 200, result, {
          headers: { "X-IntentCanvas-Revision": String(result.revision) }
        });
        return;
      }

      if (request.method === "PATCH" && segments.length === 5 &&
          segments[0] === "api" && segments[1] === "reviews" &&
          segments[3] === "modules") {
        const expectedRevision = requiredExpectedRevision(request);
        const module = await readJson(request);
        const result = await writer.mutate(
          (candidate) => candidate.replaceModule(
            segments[2],
            segments[4],
            module,
            { now, expectedRevision }
          )
        );
        sendJson(response, 200, result, {
          headers: { "X-IntentCanvas-Revision": String(result.revision) }
        });
        return;
      }

      if (request.method === "GET" && segments.length === 4 &&
          segments[0] === "api" && segments[1] === "reviews" &&
          segments[3] === "gate") {
        sendJson(response, 200, store.getExecutionGate(segments[2]));
        return;
      }

      if (request.method === "GET" && segments.length === 4 &&
          segments[0] === "api" && segments[1] === "reviews" &&
          segments[3] === "approved") {
        const snapshot = store.getApprovedSnapshot(segments[2]);
        sendJson(response, 200, snapshot, {
          headers: { "X-IntentCanvas-Revision": String(snapshot.revision) }
        });
        return;
      }

      if (request.method === "GET" && segments.length === 4 &&
          segments[0] === "api" && segments[1] === "reviews" &&
          ["revisions", "history"].includes(segments[3])) {
        const revisions = store.listRevisions(segments[2]);
        sendJson(response, 200, {
          reviewId: segments[2],
          currentRevision: revisions.at(-1)?.revision ?? null,
          revisions
        });
        return;
      }

      if (request.method === "GET" && segments.length === 5 &&
          segments[0] === "api" && segments[1] === "reviews" &&
          ["revisions", "history"].includes(segments[3])) {
        const revisionNumber = Number(segments[4]);
        const revision = store.getRevision(segments[2], revisionNumber);
        if (!revision) {
          throw new ReviewStoreError(
            `Unknown revision ${segments[4]} for review: ${segments[2]}`,
            { code: "revision_not_found", status: 404 }
          );
        }
        sendJson(response, 200, revision, {
          headers: { "X-IntentCanvas-Revision": String(revision.revision) }
        });
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
        const revision = store.getCurrentRevision(segments[2]);
        sendJson(response, 200, review, {
          headers: { "X-IntentCanvas-Revision": String(revision) }
        });
        return;
      }

      if (request.method === "POST" && segments.length === 4 &&
          segments[0] === "api" && segments[1] === "reviews" &&
          segments[3] === "decisions") {
        const input = await readJson(request);
        const result = await writer.mutate(
          (candidate) => candidate.submitDecision(segments[2], input, { now })
        );
        sendJson(response, 200, result, {
          headers: { "X-IntentCanvas-Revision": String(result.revision) }
        });
        return;
      }

      if (request.method === "POST" && segments.length === 6 &&
          segments[0] === "api" && segments[1] === "reviews" &&
          segments[3] === "modules" && segments[5] === "approval") {
        const body = await readJson(request);
        const result = await writer.mutate(
          (candidate) => candidate.submitDecision(
            segments[2],
            { ...body, moduleId: segments[4] },
            { now }
          )
        );
        sendJson(response, 200, result, {
          headers: { "X-IntentCanvas-Revision": String(result.revision) }
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/events") {
        const event = await readJson(request);
        const result = await writer.mutate(
          (candidate) => candidate.recordEvent(event, { now })
        );
        sendJson(response, 202, result);
        return;
      }

      if (isApi) {
        const status = ["GET", "HEAD", "POST", "PUT", "PATCH", "OPTIONS"]
          .includes(request.method ?? "")
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
        await serveStatic(
          request,
          response,
          rawPathname ?? url.pathname,
          studioDirectory
        );
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
  now = () => new Date(),
  dataDirectory = resolveDataDirectory(),
  persistence: configuredPersistence,
  authToken: configuredAuthToken,
  authOptions = {},
  authSessionOptions = {}
} = {}) {
  validatePort(port);
  const persistence = configuredPersistence === undefined
    ? (dataDirectory === null || dataDirectory === false
      ? null
      : new JsonFileReviewPersistence(resolveDataDirectory(dataDirectory)))
    : configuredPersistence;
  let dataLock = null;

  try {
    if (typeof persistence?.directory === "string") {
      dataLock = await acquireRuntimeDataDirectoryLock(persistence.directory);
    }

  if (persistence) {
    try {
      const state = await persistence.load();
      if (state === null) {
        await persistence.save(store.exportState());
      } else {
        store.restoreState(state);
      }
    } catch (error) {
      const failure = error instanceof RuntimePersistenceError
        ? error
        : new RuntimePersistenceError(
          `IntentCanvas Runtime state at ${persistence.statePath ?? "the configured data directory"} ` +
            `is invalid; fix or move it before restarting (it was not overwritten): ${error.message}`,
          {
            code: "invalid_runtime_state",
            path: persistence.statePath,
            cause: error
          }
        );
      logger.error?.(failure.message);
      throw failure;
    }
  }

  const writer = new SerializedReviewWriter(store, persistence);
  const authentication = configuredAuthToken === false
    ? { token: false, path: null, created: false }
    : typeof configuredAuthToken === "string"
      ? { token: validateAuthToken(configuredAuthToken), path: null, created: false }
      : await loadOrCreateAuthToken(authOptions);
  const authManager = authentication.token === false
    ? false
    : new RuntimeAuthManager(authentication.token, authSessionOptions);
  const server = createRuntimeServer({
    store,
    studioDirectory,
    now,
    writer,
    authManager
  });

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
  const reviewLink = new URL(baseUrl);
  if (primaryReview) reviewLink.searchParams.set("review", primaryReview.id);
  if (primaryReview && authManager !== false) {
    const handoff = authManager.createHandoff(primaryReview.id);
    reviewLink.searchParams.set("handoff", handoff.handoff);
  }
  const reviewUrl = reviewLink.href;

  logger.log(`IntentCanvas Runtime: ${baseUrl}`);
  logger.log(`Review ready: ${osc8Hyperlink("Open visual plan", reviewUrl)}`);

  return {
    server,
    store,
    host: RUNTIME_HOST,
    port: actualPort,
    baseUrl,
    reviewUrl,
    authTokenFile: authentication.path,
    dataDirectory: persistence?.directory ?? null,
    close: async () => {
      try {
        await new Promise((resolveClose, rejectClose) => {
          server.close((error) => error ? rejectClose(error) : resolveClose());
        });
      } finally {
        await dataLock?.release();
      }
    }
  };
  } catch (error) {
    await dataLock?.release();
    throw error;
  }
}
