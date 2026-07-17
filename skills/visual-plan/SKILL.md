---
name: visual-plan
description: Create a structured, visual-first code-change plan, hold implementation for explicit approval, and compare the approved plan with the actual implementation. Use for architecture changes, cross-module features, refactors, migrations, or any request to visualize, review, or approve a coding plan before edits.
---

# Visual Plan

Follow this gated workflow.

## 1. Establish code facts

- Inspect the repository, build metadata, symbols, dependencies, and relevant tests with read-only tools.
- Prefer compiler, language-server, AST, and build-system facts over guesses. Label remaining design assumptions.
- Do not edit product code during planning.

## 2. Produce the proposed plan

Create a valid IntentCanvas Plan Model before rendering it. Use the bundled protocol validator when available. Include:

- goal, plain-language summary, affected modules, and relationships;
- one short summary line per module;
- real top-level entry points and source locations;
- added, removed, modified, and unchanged nodes and edges;
- one focused change at a time, with collapsed incidental calls;
- before/after pseudocode, risks, and verification commands;
- module approval state set to `pending` and plan status set to `in_review`.

Render the model as a progressive visual review:

1. Start with a small module-level overview and color legend.
2. Let each module open into a simplified diagram showing its entry point, omitted calls, and target symbol.
3. Place the focused change, pseudocode, risk, and verification details below that diagram.
4. Provide Overview, Previous module, and Next module navigation.

For a large feature, add modules and drill-down views; do not put the full project graph on one canvas.

## 3. Stop for approval

Present the visual artifact or clickable review URL plus a short summary. Ask the user to approve all modules, approve selected modules, request revisions, or abandon the plan.

Do not edit product code, run implementation commands, or commit changes until the user explicitly approves the applicable modules. Read-only investigation and generation of review artifacts remain allowed.

## 4. Implement only the approved scope

- Treat the approved model as the implementation contract.
- Implement and verify only approved modules.
- If a public interface, module dependency, security boundary, lifecycle, or key call path must differ, stop. Update the proposed model, mark the affected module `pending`, and request approval again.

## 5. Compare Plan with Actual

After implementation, extract the actual code facts and compare them with the approved model. Report:

- planned changes completed or missing;
- unplanned files, symbols, dependencies, or call-path changes;
- verification results;
- remaining risks and design drift.

Do not mark the review complete while an unapproved core deviation remains.
