import {
  clonePlanModel,
  createAgentEventAck,
  validateAgentEvent,
  validateApprovalDecision,
  validatePlanModel
} from "@intentcanvas/protocol";

export const RUNTIME_STATE_KIND = "IntentCanvasRuntimeState";
export const RUNTIME_STATE_VERSION = 1;
export const DEFAULT_REVISION_LIMIT = 100;

const REVISION_OPERATIONS = new Set([
  "created",
  "replaced",
  "module_replaced"
]);

export class ReviewStoreError extends Error {
  constructor(message, { code = "store_error", status = 400, details = [] } = {}) {
    super(message);
    this.name = "ReviewStoreError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function requireValidPlan(plan, { code = "invalid_plan", message = "Invalid Plan Model" } = {}) {
  const validation = validatePlanModel(plan);
  if (!validation.valid) {
    throw new ReviewStoreError(message, {
      code,
      status: 400,
      details: validation.errors
    });
  }
  return clonePlanModel(plan);
}

function normalizeProposedReview(plan, options = {}) {
  const review = requireValidPlan(plan, options);
  review.status = "in_review";
  for (const module of review.modules) {
    module.approval = {
      decision: "pending",
      comment: "",
      updatedAt: null
    };
  }
  return requireValidPlan(review, options);
}

function requireTimestamp(value, path) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ReviewStoreError("Invalid persisted Runtime state", {
      code: "invalid_runtime_state",
      status: 500,
      details: [{ path, message: "must be an ISO-8601 timestamp", code: "invalid_date" }]
    });
  }
  return value;
}

function timestampFrom(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("now must return a valid Date");
  }
  return value.toISOString();
}

function updateReviewStatus(review) {
  const decisions = review.modules.map((candidate) => candidate.approval.decision);
  if (decisions.includes("changes_requested")) {
    review.status = "changes_requested";
  } else if (decisions.every((decision) => decision === "approved")) {
    review.status = "approved";
  } else {
    review.status = "in_review";
  }
}

function revisionMetadata(record) {
  return {
    reviewId: record.reviewId,
    revision: record.revision,
    operation: record.operation,
    createdAt: record.createdAt,
    ...(record.moduleId === undefined ? {} : { moduleId: record.moduleId })
  };
}

export class ReviewStore {
  #reviews = new Map();
  #revisions = new Map();
  #events = [];
  #eventLimit;
  #revisionLimit;

  constructor(plans = [], {
    eventLimit = 100,
    revisionLimit = DEFAULT_REVISION_LIMIT,
    state
  } = {}) {
    if (!Number.isInteger(eventLimit) || eventLimit < 1) {
      throw new TypeError("eventLimit must be a positive integer");
    }
    this.#eventLimit = eventLimit;
    if (!Number.isInteger(revisionLimit) || revisionLimit < 1) {
      throw new TypeError("revisionLimit must be a positive integer");
    }
    this.#revisionLimit = revisionLimit;

    if (state !== undefined) {
      this.restoreState(state);
      return;
    }

    for (const plan of plans) {
      this.addReview(plan, { now: () => new Date(plan.createdAt) });
    }
  }

  static fromState(state, options = {}) {
    return new ReviewStore([], { ...options, state });
  }

  addReview(plan, options = {}) {
    return this.importReview(plan, options).review;
  }

  importReview(plan, { now = () => new Date() } = {}) {
    const review = normalizeProposedReview(plan);
    if (this.#reviews.has(review.id)) {
      throw new ReviewStoreError(`Review already exists: ${review.id}`, {
        code: "review_exists",
        status: 409
      });
    }

    this.#reviews.set(review.id, review);
    const revision = this.#appendRevision(review.id, review, {
      operation: "created",
      createdAt: timestampFrom(now)
    });
    return {
      review: this.getReview(review.id),
      revision: revision.revision,
      revisionInfo: revision
    };
  }

  replaceReview(reviewId, plan, { now = () => new Date() } = {}) {
    if (!this.#reviews.has(reviewId)) {
      throw new ReviewStoreError(`Unknown review: ${reviewId}`, {
        code: "review_not_found",
        status: 404
      });
    }
    this.#assertRevisionCapacity(reviewId);

    const review = normalizeProposedReview(plan);
    if (review.id !== reviewId) {
      throw new ReviewStoreError(
        `Plan id ${review.id} does not match review URL id ${reviewId}`,
        { code: "review_id_mismatch", status: 409 }
      );
    }

    this.#reviews.set(reviewId, review);
    const revision = this.#appendRevision(reviewId, review, {
      operation: "replaced",
      createdAt: timestampFrom(now)
    });
    return {
      review: this.getReview(reviewId),
      revision: revision.revision,
      revisionInfo: revision
    };
  }

  replaceModule(reviewId, moduleId, input, { now = () => new Date() } = {}) {
    const current = this.#reviews.get(reviewId);
    if (!current) {
      throw new ReviewStoreError(`Unknown review: ${reviewId}`, {
        code: "review_not_found",
        status: 404
      });
    }
    this.#assertRevisionCapacity(reviewId);

    const moduleIndex = current.modules.findIndex((candidate) => candidate.id === moduleId);
    if (moduleIndex === -1) {
      throw new ReviewStoreError(`Unknown module: ${moduleId}`, {
        code: "module_not_found",
        status: 404
      });
    }
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new ReviewStoreError("A complete module object is required", {
        code: "invalid_module",
        status: 400,
        details: [{ path: "$", message: "must be an object", code: "invalid_type" }]
      });
    }
    if (input.id !== moduleId) {
      throw new ReviewStoreError(
        `Module id ${String(input.id)} does not match module URL id ${moduleId}`,
        { code: "module_id_mismatch", status: 409 }
      );
    }

    // Validate the submitted module as complete before Runtime-owned approval state is reset.
    const candidate = structuredClone(current);
    candidate.modules[moduleIndex] = structuredClone(input);
    requireValidPlan(candidate, {
      code: "invalid_module",
      message: "Invalid complete module"
    });

    const updatedAt = timestampFrom(now);
    candidate.modules[moduleIndex].approval = {
      decision: "pending",
      comment: "",
      updatedAt
    };
    updateReviewStatus(candidate);
    const review = requireValidPlan(candidate, {
      code: "invalid_module",
      message: "Invalid complete module"
    });

    this.#reviews.set(reviewId, review);
    const revision = this.#appendRevision(reviewId, review, {
      operation: "module_replaced",
      moduleId,
      createdAt: updatedAt
    });
    return {
      reviewId,
      module: structuredClone(review.modules[moduleIndex]),
      reviewStatus: review.status,
      revision: revision.revision,
      revisionInfo: revision
    };
  }

  get size() {
    return this.#reviews.size;
  }

  get eventCount() {
    return this.#events.length;
  }

  get eventLimit() {
    return this.#eventLimit;
  }

  get revisionLimit() {
    return this.#revisionLimit;
  }

  listReviews() {
    return [...this.#reviews.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((review) => ({
        id: review.id,
        title: review.title,
        status: review.status,
        schemaVersion: review.schemaVersion,
        createdAt: review.createdAt,
        project: structuredClone(review.project),
        moduleCount: review.modules.length,
        pendingModules: review.modules.filter(
          (module) => module.approval.decision === "pending"
        ).length,
        revision: this.getCurrentRevision(review.id)
      }));
  }

  getReview(reviewId) {
    const review = this.#reviews.get(reviewId);
    return review ? structuredClone(review) : null;
  }

  getCurrentRevision(reviewId) {
    const revisions = this.#revisions.get(reviewId);
    return revisions?.at(-1)?.revision ?? null;
  }

  listRevisions(reviewId) {
    if (!this.#reviews.has(reviewId)) {
      throw new ReviewStoreError(`Unknown review: ${reviewId}`, {
        code: "review_not_found",
        status: 404
      });
    }
    return this.#revisions.get(reviewId).map(revisionMetadata);
  }

  getRevision(reviewId, revisionNumber) {
    if (!this.#reviews.has(reviewId)) {
      throw new ReviewStoreError(`Unknown review: ${reviewId}`, {
        code: "review_not_found",
        status: 404
      });
    }
    if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
      throw new ReviewStoreError(`Invalid revision: ${revisionNumber}`, {
        code: "invalid_revision",
        status: 400
      });
    }
    const record = this.#revisions
      .get(reviewId)
      .find((candidate) => candidate.revision === revisionNumber);
    return record ? structuredClone(record) : null;
  }

  submitDecision(reviewId, input, { now = () => new Date() } = {}) {
    const validation = validateApprovalDecision(input);
    if (!validation.valid) {
      throw new ReviewStoreError("Invalid approval decision", {
        code: "invalid_decision",
        status: 400,
        details: validation.errors
      });
    }

    const review = this.#reviews.get(reviewId);
    if (!review) {
      throw new ReviewStoreError(`Unknown review: ${reviewId}`, {
        code: "review_not_found",
        status: 404
      });
    }

    const currentRevision = this.getCurrentRevision(reviewId);
    if (input.expectedRevision !== currentRevision) {
      throw new ReviewStoreError(
        `Review ${reviewId} changed from revision ${input.expectedRevision} to ${currentRevision}`,
        {
          code: "stale_review_revision",
          status: 409,
          details: [{
            path: "$.expectedRevision",
            message: "refresh and review the current revision before deciding",
            code: "revision_mismatch",
            expectedRevision: input.expectedRevision,
            currentRevision
          }]
        }
      );
    }

    const module = review.modules.find((candidate) => candidate.id === input.moduleId);
    if (!module) {
      throw new ReviewStoreError(`Unknown module: ${input.moduleId}`, {
        code: "module_not_found",
        status: 404
      });
    }

    const updatedAt = timestampFrom(now);
    module.approval = {
      decision: input.decision,
      comment: input.comment ?? "",
      updatedAt
    };

    updateReviewStatus(review);
    requireValidPlan(review);
    return {
      reviewId,
      moduleId: module.id,
      approval: structuredClone(module.approval),
      reviewStatus: review.status,
      revision: currentRevision
    };
  }

  recordEvent(event, { now = () => new Date() } = {}) {
    const validation = validateAgentEvent(event);
    if (!validation.valid) {
      throw new ReviewStoreError("Invalid Agent event", {
        code: "invalid_event",
        status: 400,
        details: validation.errors
      });
    }
    this.#events.push(structuredClone(event));
    if (this.#events.length > this.#eventLimit) {
      this.#events.splice(0, this.#events.length - this.#eventLimit);
    }
    return createAgentEventAck(event, {
      eventCount: this.#events.length,
      receivedAt: timestampFrom(now)
    });
  }

  listEvents() {
    return structuredClone(this.#events);
  }

  exportState() {
    return {
      kind: RUNTIME_STATE_KIND,
      version: RUNTIME_STATE_VERSION,
      reviews: [...this.#reviews.values()].map((review) => structuredClone(review)),
      revisions: [...this.#revisions.values()]
        .flat()
        .map((revision) => structuredClone(revision)),
      events: structuredClone(this.#events)
    };
  }

  restoreState(state) {
    if (state === null || typeof state !== "object" || Array.isArray(state)) {
      throw new ReviewStoreError("Invalid persisted Runtime state", {
        code: "invalid_runtime_state",
        status: 500,
        details: [{ path: "$", message: "must be an object", code: "invalid_type" }]
      });
    }
    if (state.kind !== RUNTIME_STATE_KIND || state.version !== RUNTIME_STATE_VERSION) {
      throw new ReviewStoreError("Unsupported persisted Runtime state", {
        code: "invalid_runtime_state",
        status: 500,
        details: [{
          path: "$.version",
          message: `expected ${RUNTIME_STATE_KIND} version ${RUNTIME_STATE_VERSION}`,
          code: "unsupported_version"
        }]
      });
    }
    if (!Array.isArray(state.reviews) || !Array.isArray(state.revisions) ||
        !Array.isArray(state.events)) {
      throw new ReviewStoreError("Invalid persisted Runtime state", {
        code: "invalid_runtime_state",
        status: 500,
        details: [{ path: "$", message: "reviews, revisions, and events must be arrays", code: "invalid_type" }]
      });
    }

    const reviews = new Map();
    for (const plan of state.reviews) {
      const review = requireValidPlan(plan, {
        code: "invalid_runtime_state",
        message: "Invalid Plan Model in persisted Runtime state"
      });
      if (reviews.has(review.id)) {
        throw new ReviewStoreError(`Duplicate review in persisted Runtime state: ${review.id}`, {
          code: "invalid_runtime_state",
          status: 500
        });
      }
      reviews.set(review.id, review);
    }

    const revisions = new Map([...reviews.keys()].map((reviewId) => [reviewId, []]));
    for (const [index, input] of state.revisions.entries()) {
      const path = `$.revisions[${index}]`;
      if (input === null || typeof input !== "object" || Array.isArray(input) ||
          typeof input.reviewId !== "string" || !reviews.has(input.reviewId) ||
          !Number.isInteger(input.revision) || input.revision < 1 ||
          !REVISION_OPERATIONS.has(input.operation)) {
        throw new ReviewStoreError("Invalid revision in persisted Runtime state", {
          code: "invalid_runtime_state",
          status: 500,
          details: [{ path, message: "contains invalid revision metadata", code: "invalid_value" }]
        });
      }
      requireTimestamp(input.createdAt, `${path}.createdAt`);
      const plan = requireValidPlan(input.plan, {
        code: "invalid_runtime_state",
        message: "Invalid revision snapshot in persisted Runtime state"
      });
      if (plan.id !== input.reviewId ||
          (input.operation === "module_replaced" &&
            (typeof input.moduleId !== "string" ||
              !plan.modules.some((module) => module.id === input.moduleId)))) {
        throw new ReviewStoreError("Invalid revision snapshot in persisted Runtime state", {
          code: "invalid_runtime_state",
          status: 500,
          details: [{ path, message: "does not match its review or module", code: "invalid_reference" }]
        });
      }
      revisions.get(input.reviewId).push({
        reviewId: input.reviewId,
        revision: input.revision,
        operation: input.operation,
        createdAt: input.createdAt,
        ...(input.moduleId === undefined ? {} : { moduleId: input.moduleId }),
        plan
      });
    }

    for (const [reviewId, history] of revisions) {
      history.sort((left, right) => left.revision - right.revision);
      if (history.length === 0 ||
          history.length > this.#revisionLimit ||
          history.some((record, index) => record.revision !== index + 1)) {
        throw new ReviewStoreError(`Invalid revision sequence for review: ${reviewId}`, {
          code: "invalid_runtime_state",
          status: 500
        });
      }
    }

    const events = [];
    for (const [index, event] of state.events.entries()) {
      const validation = validateAgentEvent(event);
      if (!validation.valid) {
        throw new ReviewStoreError("Invalid event in persisted Runtime state", {
          code: "invalid_runtime_state",
          status: 500,
          details: validation.errors.map((error) => ({
            ...error,
            path: `$.events[${index}]${error.path.slice(1)}`
          }))
        });
      }
      events.push(structuredClone(event));
    }
    if (events.length > this.#eventLimit) {
      events.splice(0, events.length - this.#eventLimit);
    }

    this.#reviews = reviews;
    this.#revisions = revisions;
    this.#events = events;
  }

  #appendRevision(reviewId, plan, { operation, createdAt, moduleId } = {}) {
    this.#assertRevisionCapacity(reviewId);
    const history = this.#revisions.get(reviewId) ?? [];
    const record = {
      reviewId,
      revision: history.length + 1,
      operation,
      createdAt,
      ...(moduleId === undefined ? {} : { moduleId }),
      plan: structuredClone(plan)
    };
    history.push(record);
    this.#revisions.set(reviewId, history);
    return revisionMetadata(record);
  }

  #assertRevisionCapacity(reviewId) {
    const history = this.#revisions.get(reviewId) ?? [];
    if (history.length >= this.#revisionLimit) {
      throw new ReviewStoreError(
        `Review ${reviewId} reached its ${this.#revisionLimit} revision limit; create a new review`,
        { code: "revision_limit_reached", status: 409 }
      );
    }
  }
}
