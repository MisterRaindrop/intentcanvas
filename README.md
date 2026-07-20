# IntentCanvas

IntentCanvas turns an AI coding plan into a visual contract that a human can review module by module before implementation, then checks the implementation against the approved design.

> Draw the intent. Approve the change. Verify the result.

It is aimed at changes that are hard to judge from prose alone: large C/C++ systems, database kernels, distributed systems, cross-module features, and structural refactors.

## What works in v0.3

- A strict, versioned Plan Model and a Doris TDE example.
- A visual Studio with a top-level module graph, one-line module summaries, simplified module diagrams, focused call paths, member changes, pseudocode, risks, and checks.
- Previous/next module navigation, module-level approval, targeted feedback, and single-module replanning without regenerating the whole design.
- A loopback-only Runtime with atomic persistent storage, decision-inclusive revision history, event ingestion, an execution gate, and revision-bound Approved Snapshots.
- A terminal CLI that validates, imports, gets, replaces, revises, checks/finalizes approval, and prints OSC8 clickable review links.
- Deterministic C/C++ Code Facts ingestion plus `facts prepare`: reuse existing build evidence or safely configure CMake in a private analysis directory, generate a bounded clang-uml config, run tools without a shell, and retain an audit manifest.
- Approved-Snapshot-versus-Implemented model and direct before/after Code Facts drift reports, including project identity and concrete include authorization.
- A Plan-versus-Actual acceptance view in Studio with an overall result, compact evidence counts, per-module status, and clickable findings. Runtime computes the report against its own approved revision and invalidates it whenever the plan changes.
- A safe SSH/tmux Bridge that creates a same-port loopback forward on the local client; the remote CLI prints the authenticated clickable URL.
- A repository launcher with one-command setup, background Runtime start/stop, `doctor`, a user command link, Claude marketplace installation, and Codex Skill linking.
- Claude Code and Codex packaging through the shared `visual-plan` Skill, plus a synchronous fail-closed Claude write gate for bound reviews and separate fail-open lifecycle telemetry.

The governing rule is:

```text
code facts come from analysis tools
design decisions come from the model
implementation starts only after Runtime approval
actual implementation is checked against the approved contract
```

## First five minutes

Requirement: Node.js 22+. Corepack or pnpm is used automatically during setup.

```bash
git clone https://github.com/MisterRaindrop/intentcanvas.git
cd intentcanvas
./intentcanvas setup
```

Setup installs workspace links, creates private local credentials, starts Runtime in the background, links the `visual-plan` Codex Skill, registers the local Claude marketplace when Claude Code is present, and places an `intentcanvas` command under `~/.local/bin`. It never overwrites an unrelated command or Skill. Run `./intentcanvas doctor` for one JSON diagnosis.

The Runtime and CLI print clickable terminal links. In iTerm2 and other OSC8-capable terminals, click one directly. Each link contains a random handoff that expires after 60 seconds and works once; run `intentcanvas plan open doris-tde-demo` whenever you need a fresh link. A bare `?review=...` URL deliberately cannot open a new browser session.

With normal setup, state is stored atomically under `~/.intentcanvas/runtime/state.json` (or `INTENTCANVAS_DATA_DIR`); restarting the Runtime keeps plans, approvals, decision revisions, events, and acceptance results. Decision and structure updates carry revision preconditions, so a concurrent review mutation between client preflight and commit is rejected. One process owns a data directory at a time, and each review retains at most 100 snapshots.

## Use it for a real change

The launcher starts Runtime automatically for networked workflow commands. Validate and import the JSON plan produced by the Skill:

```bash
intentcanvas plan validate ./plan.json
intentcanvas plan import ./plan.json
```

Click the printed review link. Start at the overall module graph, enter one module at a time, and either approve it or explain what must change. For feedback confined to one module, the agent submits only the complete replacement module:

```bash
intentcanvas plan revise <review-id> <module-id> ./module.json
```

That module returns to `pending`; approvals for untouched modules remain valid. Broader relationship or risk changes still require whole-plan replanning.

The v0.3 mechanical gate requires every module to be approved before product-code writes. Check and freeze the exact approved Runtime revision:

```bash
intentcanvas plan gate <review-id>
intentcanvas plan freeze <review-id> ./approved-snapshot.json
```

If you explicitly abandon the visual workflow, `intentcanvas plan detach` removes only the current workspace's private gate binding; it does not rewrite code or approval history.

The strongest acceptance path compares that revision-bound snapshot against Code Facts extracted before and after implementation:

```bash
intentcanvas acceptance facts <review-id> ./current-facts.json ./implemented-facts.json
```

You can also validate and compare a fact-derived Implemented Model:

```bash
intentcanvas plan validate ./implemented.json
intentcanvas acceptance model <review-id> ./implemented.json
```

The acceptance command prints a fresh link ending in `#acceptance`; click it to see the result in the same HTML review. Exit code `0` means the structural contract matches. Exit code `4` means the published result is incomplete or requires human review; it is not silently accepted.

## C/C++ facts without guessing

IntentCanvas does not parse source by impression. Preview the exact preparation commands first:

```bash
intentcanvas facts prepare /path/to/project --dry-run
```

Then explicitly run preparation. Existing `compile_commands.json` is reused. If it is missing, v0.3 supports a fixed CMake configure in a private directory under `~/.intentcanvas/evidence`; clang-uml is run with a generated class/include configuration when available:

```bash
intentcanvas facts prepare /path/to/project --output /tmp/current-facts.json
intentcanvas facts inspect /tmp/current-facts.json
```

The original fully read-only extractor remains available for pre-generated artifacts:

```bash
intentcanvas facts extract /path/to/project \
  --compile-commands /path/to/project/build/compile_commands.json \
  --clang-uml /path/to/project/build/clang-uml.json \
  --output /tmp/code-facts.json

intentcanvas facts inspect /tmp/code-facts.json
```

The output contains the full in-scope C/C++ file inventory, compilation coverage, Git repository/base revision, symbols, includes, calls, diagnostics, provenance, declaration fingerprints, and implementation fingerprints only when an analysis artifact actually supplies a body. New source files are therefore visible even before they enter `compile_commands.json`. clang-uml alone does not attest that every symbol/body was emitted, so it remains medium confidence; missing or partial evidence cannot produce a false pass.

`prepare` is explicit because CMake configuration evaluates project build logic. It uses fixed argument arrays and no shell, writes outside the checkout by default, limits tool time/output, and records the exact invocations in `manifest.json`. Projects without an existing compilation database currently receive automatic generation only for CMake; other build systems remain an explicit v0.3 follow-up.

## tmux, iTerm2, and remote servers

When tmux and the Runtime are on the same machine as the terminal, the printed OSC8 link is enough.

When the Runtime runs on a remote SSH host, a process inside that host cannot create a listening port on your laptop. Use this two-terminal flow:

```bash
# On the laptop; keep this process open. Both sides default to port 4317.
intentcanvas bridge ssh user@build-host --review <review-id> --remote-port 4317

# In Claude/Codex/tmux on the remote host, after the tunnel is ready:
intentcanvas plan open <review-id>
```

Click the fresh link printed in the remote terminal. iTerm opens `127.0.0.1:4317` on the laptop, and the same-port Bridge carries it to the remote Runtime. The Bridge invokes `ssh` with an argument array and no shell, validates all inputs, and binds both ends to loopback. Choosing a different local port is an advanced fallback and requires rewriting the port in the fresh link.

Useful diagnostics:

```bash
intentcanvas bridge environment
```

The fully automatic Moshi-style remote desktop handoff is still a later desktop-host feature. The v0.3 Bridge intentionally does not pretend a remote process can open a local tunnel by itself.

## Claude Code and Codex

Normal installation is handled by `./intentcanvas setup`. For manual Claude Code development:

```bash
claude plugin validate --strict /absolute/path/to/intentcanvas
claude --plugin-dir /absolute/path/to/intentcanvas
```

Invoke `/intentcanvas:visual-plan` or ask Claude to create an IntentCanvas visual plan.

The repository now contains a Claude marketplace catalog, so manual users may also run `claude plugin marketplace add MisterRaindrop/intentcanvas` followed by `claude plugin install intentcanvas@intentcanvas`. For Codex development, link or copy `skills/visual-plan` into the Codex skills directory and invoke `$visual-plan`; setup performs that link without replacing an existing Skill. See the focused [Claude Code](integrations/claude-code/README.md) and [Codex](integrations/codex/README.md) guides.

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
