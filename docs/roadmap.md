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

## v0.3: assisted evidence and acceptance

Completed in the current tree:

- One-command checkout setup, private installation record, background Runtime start/stop, doctor checks, Claude local marketplace install, and Codex Skill linking.
- Existing compilation-database reuse and automatic CMake configuration in a private analysis directory.
- Generated clang-uml class/include configuration, controlled no-shell invocation, bounded outputs, dry-run preview, and an audit manifest.
- Plan/Actual acceptance computation in Runtime and a compact, revision-bound acceptance view inside Studio.
- CLI publication for both Implemented Models and Current/Implemented Code Facts, with a direct `#acceptance` link.

Still planned for v0.3:

- Approval-aware compilation-database generation for build systems beyond CMake.
- Source-link navigation and fact confidence overlays in Studio.
- Build/test/sanitizer/static-analysis evidence capture with bounded logs.
- AST-backed implementation fingerprints for C/C++ function bodies when clang-uml supplies declarations only.
- Safe partial-module execution scopes with explicit file ownership; v0.3 intentionally gates on full-plan approval.

## v0.4: richer graph review

- Cytoscape.js impact graph with search, zoom, filtering, and progressive expansion.
- Dependency matrix and cycle/cross-layer warnings.
- Larger-project graph clustering and module ownership rules.
- Complexity and hotspot imports from tools such as CodeCharta.

## Desktop host

- OS-level Runtime/Bridge supervision across login and reboot; v0.3 currently provides an on-demand background host.
- Moshi-style remote event handoff that opens the correct local forwarded page.
- iTerm2/macOS notifications and deep links without project-by-project configuration.
- A user-presence approval capability isolated from the same-user coding agent.

The desktop host is deliberately separate from the portable CLI. A process inside a remote SSH session cannot create a client-local listener without a local component or a forward established by the client.
