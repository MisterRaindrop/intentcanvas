# IntentCanvas

IntentCanvas turns an AI coding plan into a visual, reviewable contract before code changes begin, then compares the approved plan with the implementation after the work is done.

> Draw the intent. Approve the change. Verify the result.

## Why

Large C/C++, database kernel, and distributed-system changes are hard to review as long prose. IntentCanvas keeps the terminal workflow while moving architecture, impact, call paths, pseudocode, approvals, and final drift checks into a focused browser review.

The core rule is:

```text
code facts come from analysis tools
design decisions come from the model
execution starts only after human approval
actual implementation is checked against the approved model
```

## First development slice

The initial runnable slice includes:

- a versioned Plan Model and Doris TDE fixture;
- a loopback-only Runtime with review and approval APIs;
- a dependency-free Review Studio with overview and module drill-down;
- a shared `visual-plan` skill packaged for Claude Code and Codex;
- a non-blocking hook adapter for agent lifecycle events.

## First five minutes

Requirements: Node.js 22+ and pnpm.

```bash
git clone https://github.com/MisterRaindrop/intentcanvas.git
cd intentcanvas
pnpm install
pnpm dev
```

Open the clickable `Open visual plan` link printed in the terminal. The demo review is available at:

```text
http://127.0.0.1:4317/?review=doris-tde-demo
```

The first page shows the five-module TDE design and one plain-language summary per module. Click a module to review its simplified diagram, entry point, focused call path, member changes, and before/after pseudocode. Use **上一个模块**, **下一个模块**, or **返回总体设计** to move through the plan, then approve the module or request a change with a comment.

Approval state in this first slice is in memory. Restarting Runtime restores the demo review.

Run all checks:

```bash
pnpm check
```

## Architecture

```text
Claude / Codex
      │
      ▼
Agent Adapter ──events──> Runtime / hookd
                              │
                              ▼
                    Versioned Plan Model
                              │
                              ▼
                        Review Studio
                              │
                              └── approvals and comments ──> Runtime
```

Runtime and Studio live in one repository for the first version but are developed as independently buildable components. They may share only the versioned protocol; they must not import each other's implementation. See [architecture boundaries](docs/architecture.md).

## Plugin development

Claude Code can load this checkout directly:

```bash
claude --plugin-dir .
```

Then invoke the namespaced skill:

```text
/intentcanvas:visual-plan
```

The Codex package is prepared in `.codex-plugin/plugin.json`; a marketplace entry will be added when distribution is ready.

## Status

IntentCanvas is an early prototype. The current Runtime is local-only; automatic SSH tunnel management, clang-based code extraction, persistent review storage, and Plan-vs-Actual verification are the next milestones.
