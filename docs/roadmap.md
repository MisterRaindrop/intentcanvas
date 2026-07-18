# Roadmap

## v0.2: executable visual review loop

Completed in the current tree:

- Versioned Plan Model and Code Facts contracts.
- Visual overview, simplified module diagrams, focused call paths, member changes, pseudocode, risks, and verification commands.
- Module approval, targeted feedback, previous/next navigation, and single-module replacement.
- Loopback Runtime with atomic persistent storage, decision-inclusive revision history, an execution gate, and revision-bound Approved Snapshots.
- CLI import/validate/get/replace/open/revise/gate/freeze flow with OSC8 links.
- Read-only C/C++ build discovery, Git identity, bounded source inventory, compilation coverage, compilation database normalization, and clang-uml JSON ingestion.
- Approved-Snapshot-versus-Implemented model diff and direct Current/Implemented Code Facts audits with project, body-evidence, and include-authorization checks.
- One-use browser handoffs, review-scoped browser sessions, and safe same-port SSH forwarding for remote tmux workflows.
- Shared Claude Code/Codex Skill, checkout-local Skill tools, synchronous fail-closed Claude write gate, and separate allowlisted fail-open telemetry.

## v0.3: automatic evidence preparation

- Project-specific, approval-aware generation of `compile_commands.json`.
- clang-uml configuration generation and controlled invocation.
- Source-link navigation and fact confidence overlays in Studio.
- Build/test/sanitizer/static-analysis evidence capture with bounded logs.
- Plan/Actual acceptance view inside Studio.
- AST-backed implementation fingerprints for C/C++ function bodies when clang-uml supplies declarations only.
- Safe partial-module execution scopes with explicit file ownership; v0.2 intentionally gates on full-plan approval.

## v0.4: richer graph review

- Cytoscape.js impact graph with search, zoom, filtering, and progressive expansion.
- Dependency matrix and cycle/cross-layer warnings.
- Larger-project graph clustering and module ownership rules.
- Complexity and hotspot imports from tools such as CodeCharta.

## Desktop host

- One-time local installer and background Runtime/Bridge supervision.
- Moshi-style remote event handoff that opens the correct local forwarded page.
- iTerm2/macOS notifications and deep links without project-by-project configuration.
- A user-presence approval capability isolated from the same-user coding agent.

The desktop host is deliberately separate from the portable CLI. A process inside a remote SSH session cannot create a client-local listener without a local component or a forward established by the client.
