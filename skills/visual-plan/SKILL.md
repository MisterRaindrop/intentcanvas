---
name: visual-plan
description: Create and import a strict IntentCanvas code-change plan, wait for full module-by-module approval, freeze the approved Runtime revision, implement only that scope, and compare fact-derived Actual evidence with the approved snapshot. Use for architecture changes, cross-module features, refactors, migrations, or any request to visualize, revise, approve, or verify a coding plan before edits.
---

# Visual Plan

Use this gated workflow. Read [references/model-contracts.md](references/model-contracts.md) before writing or revising any Plan or Implemented Model.

Resolve the directory containing this `SKILL.md` as `<skill-root>`. Always invoke the bundled checkout-local tools below; do not assume globally installed `intentcanvas*` commands:

```text
node <skill-root>/scripts/intentcanvas.mjs ...
node <skill-root>/scripts/code-facts.mjs ...
node <skill-root>/scripts/plan-diff.mjs ...
node <skill-root>/scripts/facts-diff.mjs ...
```

## 1. Extract read-only facts

- Confirm the repository CLI and local Runtime are available with `node <skill-root>/scripts/intentcanvas.mjs --version` and `node <skill-root>/scripts/intentcanvas.mjs status`.
- Inspect source, symbols, dependencies, build metadata, and relevant tests without editing product code or running implementation commands.
- Prefer language-server, AST, compiler, build-system, and `node <skill-root>/scripts/code-facts.mjs ...` output. Record unknowns as assumptions; never invent symbols, files, edges, or line numbers.
- Run `node <skill-root>/scripts/code-facts.mjs prepare <project-root> --dry-run` when automatic evidence is useful. If the plan would configure CMake or invoke a project tool, show the fixed commands and obtain permission before running `prepare --output <current-facts.json>`. Capture current facts before implementation.

## 2. Write, validate, and import the plan

- Write one raw JSON file that satisfies the Plan contract. Use status `in_review` and set every module approval to `pending`.
- Run `node <skill-root>/scripts/intentcanvas.mjs plan validate <plan.json>`. Fix every validation error before continuing.
- Run `node <skill-root>/scripts/intentcanvas.mjs plan import <plan.json> [--runtime <url>]` exactly once for the new review.
- Give the user the exact clickable Review URL printed by the CLI and a short module summary.
- When the bundled event adapter is available, emit `plan_ready` after import and `approval_required` when presenting the gate. Event delivery is best-effort telemetry, never approval.

## 3. Wait for module approval

Stop before product-code edits. Ask the user to approve modules or request module changes in IntentCanvas. If the user explicitly abandons the visual workflow, ask them to run `node <skill-root>/scripts/intentcanvas.mjs plan detach` in their terminal; the Hook deliberately prevents the coding agent from removing or rebinding a pending gate. Do not treat chat assent, a successful import, or a pending review as approval.

After the user returns, require `plan gate` to report the whole review as approved. v1 does not infer a safe partial file scope from a subset of module approvals.

For feedback limited to one module:

1. Copy the current complete module object and change only that module.
2. Preserve its module ID and leave every other module and top-level field untouched.
3. Run `node <skill-root>/scripts/intentcanvas.mjs plan revise <review-id> <module-id> <module.json> [--runtime <url>]`.
4. Return the refreshed Review URL and wait for that module to be approved again.

Never regenerate or re-import the whole plan for a single-module adjustment.

## 4. Implement the approved contract

- Confirm the mechanical gate with `node <skill-root>/scripts/intentcanvas.mjs plan gate <review-id>`.
- Freeze the revision-bound approved scope with `node <skill-root>/scripts/intentcanvas.mjs plan freeze <review-id> <approved-snapshot.json>`.
- Edit and verify only that snapshot's modules and checks.
- If implementation would change a public interface, dependency, security boundary, lifecycle, or key call path outside the approved shape, stop and request a revised approval before making that change.

## 5. Verify Plan versus Actual

- Re-extract facts from the resulting code; do not derive actual state from the proposed plan.
- Prefer the direct evidence path: run `node <skill-root>/scripts/facts-diff.mjs <approved-snapshot.json> <current-facts.json> <implemented-facts.json> --markdown`.
- Publish that same evidence into Studio with `node <skill-root>/scripts/intentcanvas.mjs acceptance facts <review-id> <current-facts.json> <implemented-facts.json>` and give the user its direct `#acceptance` link.
- Generate a strict Implemented Model only when a visual Plan-shaped Actual view is also useful; validate it and run `node <skill-root>/scripts/plan-diff.mjs <approved-snapshot.json> <implemented.json> --markdown`.
- When using an Implemented Model, publish it with `node <skill-root>/scripts/intentcanvas.mjs acceptance model <review-id> <implemented.json>` so the declared-model assurance is clearly distinguished from real Code Facts.
- Report verification evidence, missing planned work, and all unapproved drift. A diff exit code of `3` is a review result, not a tool failure.
- Emit `review_drift_detected` when the adapter is available and the diff reports drift.
- Do not hide drift by editing the approved snapshot. Do not declare completion while unapproved core drift remains.
