# Architecture boundaries

IntentCanvas is a monorepo in v0.2, but each major capability has a narrow contract so Runtime, Studio, analysis, transport, and integrations can be released or split independently later.

## End-to-end flow

```text
repository + build artifacts
          │
          ▼
      Code Facts ───────────────┐
          │                     │
          ▼                     │
   AI Proposed Plan             │
          │                     │
          ▼                     │
 CLI validate/import ──> Runtime + persistent revisions
                              │
                              ▼
                         Review Studio
                              │
                  approve / request changes
                              │
                              ▼
                      Approved snapshot
                              │
                      implementation
                              │
                              ▼
 fresh Code Facts ──> Implemented Model ──> Plan Diff
```

## Components

### Protocol

Owns Plan Model v1, Code Facts v1, Agent events, approval decisions, validation, cloning, and compatibility rules. It is the shared contract, not an application layer.

### Code Facts

Discovers build markers, normalizes an existing compilation database, ingests existing clang-uml JSON, and emits deterministic facts with provenance and confidence. It is read-only and never runs a build, compiler, or clang-uml automatically.

### CLI

Validates/imports a plan, requests a one-use browser handoff, prints a review link, replaces exactly one module, and checks Runtime health. It contains no approval policy; Runtime is authoritative.

### Runtime

Owns review state, revisions, approvals, Agent events, atomic persistence, the loopback HTTP API, and serving static Studio assets. It does not know how diagrams are laid out.

### Studio

Owns the visual overview, module drill-down, focused call paths, pseudocode, risk/check views, revision history, and approval controls. It fetches a Plan Model over HTTP and never imports Runtime code or reads Runtime storage.

### Plan Diff

Compares the frozen Approved Model with either a fact-derived Implemented Model or direct before/after Code Facts, then reports missing or unapproved structural drift. It depends only on Protocol.

### Bridge

Owns environment detection, safe same-port SSH loopback forwarding, optional formatting of an already-issued browser handoff, and future transport-token primitives. It cannot mint a Runtime browser handoff because the remote Runtime credential remains remote. It is a standalone transport package and never imports Runtime or Studio.

### Skill and Hook

The Skill tells Claude Code or Codex how to execute the gated workflow. The Hook sends optional, allowlisted lifecycle telemetry. Hook events never grant approval and delivery failure never blocks the coding agent.

## Dependency rule

```text
Runtime ──────> Protocol <────── Plan Diff
   │               ▲
   └─ serves       │
      Studio       └──── CLI

Code Facts      Bridge      Studio
(standalone)   (standalone) (browser-only)
```

Runtime may serve Studio build artifacts, but neither component may import the other's source. Bridge and Code Facts remain dependency-free. Automated boundary checks enforce these rules.

## Storage and concurrency

Runtime serializes every mutation. A mutation is applied to a candidate store, persisted first, and committed to live memory only after the atomic write succeeds. State includes reviews, at most 100 full structural revision snapshots per review, approvals, and bounded Agent events. A cross-process lock permits only one Runtime per data directory.

The default path is `.intentcanvas/runtime/state.json`. Each write uses a private temporary file, file sync, atomic rename, and best-effort directory sync. Invalid or corrupt state stops startup and is not replaced. A dead-PID lock also fails closed; after confirming that no Runtime owns the directory, the operator may remove only `.intentcanvas/runtime/runtime.lock` and restart.

## Local security boundary

Runtime listens on `127.0.0.1`. HTTP requests must use a loopback Host; browser Origin, when present, must be the same loopback origin. Mutation bodies must be JSON and are size-limited. CLI and Hook use a private per-user bearer token. A one-use 60-second URL handoff returns a random session stored only in browser `sessionStorage` for that exact origin/port; Runtime limits it to reads and decisions for one review. The SSH Bridge forwards local loopback to remote loopback and starts OpenSSH without a shell.

This is a local developer tool, not a multi-tenant network service. Exposing Runtime directly on a LAN or public interface is outside the supported boundary. The normal same-user deployment does not defend approval from a malicious or prompt-injected agent that can read `~/.intentcanvas/auth-token`; that stronger boundary needs a separate desktop host/account or user-presence signing.

## Split readiness

The repository can split when:

1. Plan Model and Code Facts compatibility policies are stable.
2. Studio can consume a packaged or standalone Plan Model without Runtime-specific source.
3. Runtime and Studio require independent release cadence.
4. Cross-version contract tests cover all supported combinations.
5. A desktop host or third-party viewer needs the public transport and protocol packages.

Likely future repositories are `intentcanvas-runtime`, `intentcanvas-studio`, and versioned `intentcanvas-protocol`; Code Facts and Bridge are already shaped as standalone packages.
