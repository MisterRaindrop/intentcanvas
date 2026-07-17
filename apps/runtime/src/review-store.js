import {
  assertPlanModel,
  clonePlanModel,
  createAgentEventAck,
  validateAgentEvent,
  validateApprovalDecision
} from "@intentcanvas/protocol";

export class ReviewStoreError extends Error {
  constructor(message, { code = "store_error", status = 400, details = [] } = {}) {
    super(message);
    this.name = "ReviewStoreError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ReviewStore {
  #reviews = new Map();
  #events = [];
  #eventLimit;

  constructor(plans = [], { eventLimit = 100 } = {}) {
    if (!Number.isInteger(eventLimit) || eventLimit < 1) {
      throw new TypeError("eventLimit must be a positive integer");
    }
    this.#eventLimit = eventLimit;
    for (const plan of plans) this.addReview(plan);
  }

  addReview(plan) {
    assertPlanModel(plan);
    if (this.#reviews.has(plan.id)) {
      throw new ReviewStoreError(`Review already exists: ${plan.id}`, {
        code: "review_exists",
        status: 409
      });
    }
    this.#reviews.set(plan.id, clonePlanModel(plan));
    return this.getReview(plan.id);
  }

  get size() {
    return this.#reviews.size;
  }

  get eventCount() {
    return this.#events.length;
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
        ).length
      }));
  }

  getReview(reviewId) {
    const review = this.#reviews.get(reviewId);
    return review ? structuredClone(review) : null;
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

    const module = review.modules.find((candidate) => candidate.id === input.moduleId);
    if (!module) {
      throw new ReviewStoreError(`Unknown module: ${input.moduleId}`, {
        code: "module_not_found",
        status: 404
      });
    }

    const updatedAt = now().toISOString();
    module.approval = {
      decision: input.decision,
      comment: input.comment ?? "",
      updatedAt
    };

    const decisions = review.modules.map((candidate) => candidate.approval.decision);
    if (decisions.includes("changes_requested")) {
      review.status = "changes_requested";
    } else if (decisions.every((decision) => decision === "approved")) {
      review.status = "approved";
    } else {
      review.status = "in_review";
    }

    assertPlanModel(review);
    return {
      reviewId,
      moduleId: module.id,
      approval: structuredClone(module.approval),
      reviewStatus: review.status
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
      receivedAt: now().toISOString()
    });
  }

  listEvents() {
    return structuredClone(this.#events);
  }
}
