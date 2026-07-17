# Architecture boundaries

IntentCanvas starts as a monorepo but treats Runtime and Studio as independently releasable products.

## Components

### Runtime

Owns agent events, sessions, review state, approval routing, the loopback gateway, and later the local/remote bridge protocol.

Runtime must not know how a diagram is laid out or how review pages are styled.

### Studio

Owns the visual overview, module drill-down, call-path presentation, pseudocode, decisions, and acceptance report.

Studio must be able to render a standalone Plan Model without importing Runtime code or reading Runtime storage directly.

### Protocol

Owns identifiers, schema versions, Current/Proposed/Approved/Actual models, events, and compatibility rules.

Protocol is the only source-level dependency that Runtime and Studio may share.

## Dependency rule

```text
Runtime ──────> Protocol <────── Studio
```

The Runtime may serve Studio build artifacts, but neither component may import the other's source code.

## Split readiness

The monorepo is ready to split when all of the following are true:

1. `Plan Model v1` is stable.
2. Studio can open a `plan.json` without Runtime.
3. Runtime and Studio have independent release needs.
4. Cross-version contract tests cover supported protocol versions.
5. A third-party viewer or agent adapter needs the public protocol.

At that point the repositories become `intentcanvas-runtime` and `intentcanvas-studio`, while the protocol is published as a versioned package.
