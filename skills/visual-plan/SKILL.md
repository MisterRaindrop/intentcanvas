---
name: visual-plan
description: Create and import a strict IntentCanvas code-change plan, wait for module-level approval, implement only approved scope, and compare a fact-derived Implemented Model with the approved plan. Use for architecture changes, cross-module features, refactors, migrations, or any request to visualize, revise, approve, or verify a coding plan before edits.
---

# Visual Plan

Use this gated workflow. Read [references/model-contracts.md](references/model-contracts.md) before writing or revising any Plan or Implemented Model.

## 1. Extract read-only facts

- Confirm the repository CLI and local Runtime are available with `intentcanvas --version` and `intentcanvas status`.
- Inspect source, symbols, dependencies, build metadata, and relevant tests without editing product code or running implementation commands.
- Prefer language-server, AST, compiler, build-system, and `intentcanvas-code-facts` output. Record unknowns as assumptions; never invent symbols, files, edges, or line numbers.

## 2. Write, validate, and import the plan

- Write one raw JSON file that satisfies the Plan contract. Use status `in_review` and set every module approval to `pending`.
- Run `intentcanvas plan validate <plan.json>`. Fix every validation error before continuing.
- Run `intentcanvas plan import <plan.json> [--runtime <url>]` exactly once for the new review.
- Give the user the exact clickable Review URL printed by the CLI and a short module summary.
- When the bundled event adapter is available, emit `plan_ready` after import and `approval_required` when presenting the gate. Event delivery is best-effort telemetry, never approval.

## 3. Wait for module approval

Stop before product-code edits. Ask the user to approve modules, request module changes, or abandon the plan in IntentCanvas. Do not treat chat assent, a successful import, or a pending review as approval.

After the user returns, read the current review from the Runtime and verify each module decision. Implement only modules whose Runtime decision is `approved`.

For feedback limited to one module:

1. Copy the current complete module object and change only that module.
2. Preserve its module ID and leave every other module and top-level field untouched.
3. Run `intentcanvas plan revise <review-id> <module-id> <module.json> [--runtime <url>]`.
4. Return the refreshed Review URL and wait for that module to be approved again.

Never regenerate or re-import the whole plan for a single-module adjustment.

## 4. Implement the approved contract

- Freeze a valid approved-scope snapshot as described in the model contract.
- Edit and verify only that snapshot's modules and checks.
- If implementation would change a public interface, dependency, security boundary, lifecycle, or key call path outside the approved shape, stop and request a revised approval before making that change.

## 5. Verify Plan versus Actual

- Re-extract facts from the resulting code; do not derive actual state from the proposed plan.
- Prefer the direct evidence path: run `intentcanvas-facts-diff <approved-plan.json> <current-facts.json> <implemented-facts.json> --markdown`.
- Generate a strict Implemented Model only when a visual Plan-shaped Actual view is also useful; validate it and run `intentcanvas-diff <approved-plan.json> <implemented.json> --markdown`.
- Report verification evidence, missing planned work, and all unapproved drift. A diff exit code of `3` is a review result, not a tool failure.
- Emit `review_drift_detected` when the adapter is available and the diff reports drift.
- Do not hide drift by editing the approved snapshot. Do not declare completion while unapproved core drift remains.
