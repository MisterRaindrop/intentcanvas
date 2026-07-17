# IntentCanvas model contracts

Use this reference whenever generating a Plan Model, revising a module, freezing approved scope, or generating an Implemented Model.

## Read-only fact input

Build models from repository evidence, not from the requested design alone. For C/C++ repositories with existing analysis artifacts, the fact extractor can be run without invoking a build:

```bash
intentcanvas-code-facts extract <project-root> \
  --compile-commands <compile_commands.json> \
  --clang-uml <clang-uml.json> \
  --output <facts.json>
intentcanvas-code-facts inspect <facts.json> --json
```

The extractor reads existing artifacts and reports diagnostics when they are absent; it must not be treated as evidence for symbols or edges it did not return. Use language-native read-only tools for repositories it cannot cover.

Never place credentials, tokens, environment-variable values, or unnecessary source contents in a model.

## JSON encoding rules

- Write one raw UTF-8 JSON object. Do not use Markdown fences, comments, trailing commas, placeholders, or non-finite numbers.
- Use stable kebab-case IDs. Every ID must start with an ASCII letter or digit and then use only letters, digits, `.`, `_`, `:`, `/`, or `-` (maximum 256 characters). Keep plan, module, change, node, risk, and verification IDs unique in their respective scopes.
- Use repository-relative source paths. Include a line only when a tool reported a positive, current line number.
- Use ISO-8601 timestamps.
- Validate every complete model with `intentcanvas plan validate <file>`.

## Plan Model v1

The root object requires exactly this contract:

- `schemaVersion`: `"1.0.0"`
- `kind`: `"IntentCanvasPlan"`
- `id`, `title`, `goal`, `summary`: non-empty strings
- `status`: `"in_review"` for a proposed plan
- `createdAt`: ISO-8601 string
- `project`: `{ "name", "repository", "baseRef" }`, all non-empty strings
- `modules`: non-empty array of complete module objects
- `relationships`: array, possibly empty
- `risks`: array, possibly empty
- `verification`: non-empty array

Allowed status values are:

- change status: `added`, `removed`, `modified`, `unchanged`
- plan status: `draft`, `in_review`, `changes_requested`, `approved`, `implemented`
- approval decision: `pending`, `approved`, `changes_requested`
- risk level: `low`, `medium`, `high`, `critical`
- diagram node type: `module`, `class`, `interface`, `function`, `service`, `data`

### Module object

Each module requires:

- `id`, `name`, `layer`, `summary`: non-empty strings
- `order`: positive integer
- `status`: change status
- `entryPoints`: non-empty array of `{ "signature", "file", "line"? }`
- `diagram`: `{ "nodes", "edges" }`; nodes are non-empty and edges may be empty
- `changes`: non-empty array
- `approval`: `{ "decision": "pending", "comment": "", "updatedAt": null }` for a proposed or revised module

Each diagram node requires `id`, `label`, `type`, and `status`; `description` is optional. Node IDs must be unique within the module. Each edge requires `from` and `to` IDs present in that diagram; `label` and `status` are optional.

Each change requires:

- `id`, `title`, `rationale`: non-empty strings
- `status`: change status
- `location`: `{ "file", "symbol" }`, both non-empty and fact-backed
- `callPath`: non-empty array of `{ "label", "status", "collapsedCount"? }`
- `pseudocode`: `{ "language", "before", "after" }`; `language` is non-empty and before/after may be empty strings when addition or removal makes that truthful

Use `collapsedCount` only as a positive integer for deliberately collapsed incidental calls. Keep one focused change per change object.

### Top-level relationships, risks, and verification

A relationship requires `from`, `to`, `label`, `status`, and `summary`. Both endpoints must reference module IDs.

A risk requires `id`, `level`, `title`, `mitigation`, and a non-empty `moduleIds` array. Every module ID must exist in this model.

A verification item requires `id`, `type`, `command`, `expected`, and `moduleIds`. Every referenced module ID must exist. Commands describe checks to run after approval; do not run mutating or implementation commands during planning.

Every module must be referenced by at least one verification item so any approved subset retains an applicable acceptance check.

## Import and approval source of truth

Use the CLI in this order:

```bash
intentcanvas plan validate <plan.json>
intentcanvas plan import <plan.json> [--runtime <url>]
```

Relay the exact URL printed as `Review URL`. The Runtime, not the local plan file or chat transcript, owns approval state. After the user says review is complete, read:

```text
GET <runtime>/api/reviews/<review-id>
```

Only `modules[].approval.decision == "approved"` authorizes implementation. `pending` and `changes_requested` do not.

### Single-module revision

Write a file containing the complete replacement module object only—no root plan envelope. Keep its `id` equal to `<module-id>`, use pending approval, and run:

```bash
intentcanvas plan revise <review-id> <module-id> <module.json> [--runtime <url>]
```

The Runtime replaces that module, resets its approval to pending, retains the other modules, and prints the review URL. Never regenerate or re-import the full plan for feedback confined to one module. If the feedback truly changes cross-module relationships or top-level risks/checks, identify it as broader replanning instead of hiding it inside a module replacement.

## Frozen approved-scope snapshot

`intentcanvas-diff` requires an input Plan whose status is `approved` and whose every included module is approved.

For a fully approved review, save the Runtime model unchanged as the approved snapshot.

For partial approval, derive a strict snapshot that represents only the authorized contract:

1. Keep the same plan ID and set plan status to `approved`.
2. Keep only modules whose Runtime approval decision is `approved`; do not alter their approved content.
3. Keep only relationships whose two endpoints remain.
4. Filter each risk and verification item's `moduleIds` to the retained set; drop items with no remaining target.
5. Keep at least one applicable verification item and renumber module order if needed.
6. Validate the snapshot before editing product code.

Do not mark pending modules approved merely to satisfy the diff tool. The snapshot is the exact implementation boundary.

## Implemented Model

### Direct Code Facts acceptance (preferred)

When both pre-change and post-change Code Facts are available, compare them directly against the approved plan so Actual is never reconstructed from AI memory:

```bash
intentcanvas-facts-diff \
  <approved-plan.json> <current-facts.json> <implemented-facts.json> --markdown
```

Exit code `0` passes, `3` requires human review for missing or unapproved drift, `1` is an execution/input failure, and `2` is invalid usage. Keep both facts files as acceptance evidence.

### Plan-shaped Actual view (optional)

The Implemented Model uses the same v1 JSON shape so it can be validated and compared. Generate it from fresh post-change facts with these rules:

- Keep `schemaVersion`, `kind`, and `id` equal to the approved snapshot.
- Set root `status` to `implemented` and use the extraction time for `createdAt`.
- Copy module approvals from the frozen approved snapshot; approval records describe the contract, not a new approval.
- Rebuild modules, entry points, diagram nodes/edges, change locations, and call paths from actual code facts relative to the same `baseRef`.
- Preserve approved IDs only for the same actual entities. Add stable new IDs for unapproved actual entities; omit missing planned entities so the diff can report them.
- Keep required arrays structurally valid. If a planned module has no implemented representation, omit the module rather than fabricating a change.
- Keep risks and verification structurally valid, but report actual command outcomes separately as acceptance evidence; do not add unrecognized result fields.

Validate and compare:

```bash
intentcanvas plan validate <approved-plan.json>
intentcanvas plan validate <implemented.json>
intentcanvas-diff <approved-plan.json> <implemented.json> --markdown
```

Diff exit codes:

- `0`: the compared structural shape passes
- `3`: incomplete or unapproved drift was found and requires review
- `1`: input, validation, or execution failure
- `2`: invalid command usage

Never edit the approved snapshot to make a drift result pass. Report missing planned work, unapproved modules/files/symbols/dependencies/call paths, verification outcomes, and remaining risk. Core drift requires a new approval before completion.
