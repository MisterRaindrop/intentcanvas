# IntentCanvas

IntentCanvas turns an AI coding plan into a visual contract that a human can review module by module before implementation, then checks the implementation against the approved design.

> Draw the intent. Approve the change. Verify the result.

It is aimed at changes that are hard to judge from prose alone: large C/C++ systems, database kernels, distributed systems, cross-module features, and structural refactors.

## What works in v0.2

- A strict, versioned Plan Model and a Doris TDE example.
- A visual Studio with a top-level module graph, one-line module summaries, simplified module diagrams, focused call paths, member changes, pseudocode, risks, and checks.
- Previous/next module navigation, module-level approval, targeted feedback, and single-module replanning without regenerating the whole design.
- A loopback-only Runtime with atomic persistent storage, decision-inclusive revision history, event ingestion, an execution gate, and revision-bound Approved Snapshots.
- A terminal CLI that validates, imports, gets, replaces, revises, checks/finalizes approval, and prints OSC8 clickable review links.
- Deterministic C/C++ Code Facts ingestion from an existing `compile_commands.json` and clang-uml JSON, plus a bounded full source inventory, Git identity, provenance, coverage, and honest implementation fingerprints.
- Approved-Snapshot-versus-Implemented model and direct before/after Code Facts drift reports, including project identity and concrete include authorization.
- A safe SSH/tmux Bridge that creates a same-port loopback forward on the local client; the remote CLI prints the authenticated clickable URL.
- Claude Code and Codex packaging through the shared `visual-plan` Skill, plus a synchronous fail-closed write gate for bound reviews and separate fail-open lifecycle telemetry.

The governing rule is:

```text
code facts come from analysis tools
design decisions come from the model
implementation starts only after Runtime approval
actual implementation is checked against the approved contract
```

## First five minutes

Requirements: Node.js 22+ and pnpm 11.9+.

```bash
git clone https://github.com/MisterRaindrop/intentcanvas.git
cd intentcanvas
pnpm install
pnpm dev
```

The Runtime prints `Open visual plan` as a clickable terminal link. In iTerm2 and other OSC8-capable terminals, click it directly. Each link contains a random handoff that expires after 60 seconds and works once; run `pnpm intentcanvas plan open doris-tde-demo` whenever you need a fresh link. A bare `?review=...` URL deliberately cannot open a new browser session.

State is stored atomically under `.intentcanvas/runtime/state.json`; restarting the Runtime keeps plans, approvals, decision revisions, and events. Decision and structure updates carry revision preconditions, so a concurrent review mutation between client preflight and commit is rejected. One process owns a data directory at a time, and each review retains at most 100 snapshots.

## Use it for a real change

Keep `pnpm dev` running. In another terminal, validate and import the JSON plan produced by the Skill:

```bash
pnpm intentcanvas plan validate ./plan.json
pnpm intentcanvas plan import ./plan.json
```

Click the printed review link. Start at the overall module graph, enter one module at a time, and either approve it or explain what must change. For feedback confined to one module, the agent submits only the complete replacement module:

```bash
pnpm intentcanvas plan revise <review-id> <module-id> ./module.json
```

That module returns to `pending`; approvals for untouched modules remain valid. Broader relationship or risk changes still require whole-plan replanning.

The v0.2 mechanical gate requires every module to be approved before product-code writes. Check and freeze the exact approved Runtime revision:

```bash
pnpm intentcanvas plan gate <review-id>
pnpm intentcanvas plan freeze <review-id> ./approved-snapshot.json
```

If you explicitly abandon the visual workflow, `pnpm intentcanvas plan detach` removes only the current workspace's private gate binding; it does not rewrite code or approval history.

The strongest acceptance path compares that revision-bound snapshot against Code Facts extracted before and after implementation:

```bash
pnpm facts-diff ./approved-snapshot.json ./current-facts.json ./implemented-facts.json --markdown
```

You can also validate and compare a fact-derived Implemented Model:

```bash
pnpm intentcanvas plan validate ./implemented.json
pnpm diff ./approved-snapshot.json ./implemented.json --markdown
```

Exit code `0` means the structural contract matches. Exit code `3` means missing or unapproved drift needs human review; it is not silently accepted.

## C/C++ facts without guessing

IntentCanvas does not parse source by impression. Its first extractor consumes existing build and semantic artifacts without running a build or compiler:

```bash
pnpm facts extract /path/to/project \
  --compile-commands /path/to/project/build/compile_commands.json \
  --clang-uml /path/to/project/build/clang-uml.json \
  --output /tmp/code-facts.json

pnpm facts inspect /tmp/code-facts.json
```

The output contains the full in-scope C/C++ file inventory, compilation coverage, Git repository/base revision, symbols, includes, calls, diagnostics, provenance, declaration fingerprints, and implementation fingerprints only when an analysis artifact actually supplies a body. New source files are therefore visible even before they enter `compile_commands.json`. clang-uml alone does not attest that every symbol/body was emitted, so it remains medium confidence; missing or partial evidence cannot produce a false pass.

Generating `compile_commands.json` and invoking clang-uml remain explicit project-specific steps in v0.2 because build commands can change a checkout. The Skill must obtain permission before running them.

## tmux, iTerm2, and remote servers

When tmux and the Runtime are on the same machine as the terminal, the printed OSC8 link is enough.

When the Runtime runs on a remote SSH host, a process inside that host cannot create a listening port on your laptop. Use this two-terminal flow:

```bash
# On the laptop; keep this process open. Both sides default to port 4317.
pnpm bridge ssh user@build-host --review <review-id> --remote-port 4317

# In Claude/Codex/tmux on the remote host, after the tunnel is ready:
pnpm intentcanvas plan open <review-id>
```

Click the fresh link printed in the remote terminal. iTerm opens `127.0.0.1:4317` on the laptop, and the same-port Bridge carries it to the remote Runtime. The Bridge invokes `ssh` with an argument array and no shell, validates all inputs, and binds both ends to loopback. Choosing a different local port is an advanced fallback and requires rewriting the port in the fresh link.

Useful diagnostics:

```bash
pnpm bridge environment
```

The fully automatic Moshi-style desktop handoff is a later desktop-host feature. The v0.2 Bridge intentionally does not pretend a remote process can open a local tunnel by itself.

## Claude Code and Codex

For Claude Code development:

```bash
claude plugin validate --strict /absolute/path/to/intentcanvas
claude --plugin-dir /absolute/path/to/intentcanvas
```

Invoke `/intentcanvas:visual-plan` or ask Claude to create an IntentCanvas visual plan.

For Codex development, link or copy `skills/visual-plan` into the Codex skills directory and invoke `$visual-plan`. No marketplace entry is created in this repository. See the focused [Claude Code](integrations/claude-code/README.md) and [Codex](integrations/codex/README.md) guides.

## Architecture and checks

Runtime and Studio live in one repository for the first release, but the implementation boundaries keep them independently removable. They share the versioned Protocol, not each other's source. See [architecture boundaries](docs/architecture.md) and the [roadmap](docs/roadmap.md).

Run all tests and boundary checks:

```bash
pnpm check
```

## Security posture

- Runtime binds only to `127.0.0.1`, validates loopback Host/Origin values, requires JSON mutation bodies, limits payload size, blocks static path/symlink escapes, and serves Studio with restrictive browser headers.
- A private per-user token authenticates CLI and Hook calls but never appears in a URL. Before sending it, clients require a fresh challenge/HMAC identity proof from the loopback Runtime. A 60-second one-use handoff becomes an origin-scoped browser session that can read and decide only its bound review; it cannot import, rewrite, emit events, or mint more links.
- Persistent writes use a synced temporary file plus atomic rename, a single-owner data-directory lock, bounded revisions, and fail-closed corrupt/stale-state handling.
- Bridge never constructs a shell command and never exposes Runtime on a non-loopback interface.
- Import/open binds the current workspace to one review outside the repository. Claude Code's synchronous PreToolUse Hook blocks write-capable tools until that review is fully approved; Runtime failure and identity mismatch fail closed. Separate lifecycle telemetry is allowlisted, asynchronous, and fail open.
- Approval comes from Runtime state, never from assistant prose or Hook telemetry. This is an accidental-cross-action boundary, not isolation from a malicious same-user agent: Claude/Codex, CLI, Hook, and Runtime normally share one OS account, so that agent can read the same local token. A future desktop host or user-presence signature is required for a cryptographically independent human-approval boundary.

## License

IntentCanvas is licensed under the [Apache License, Version 2.0](LICENSE).
