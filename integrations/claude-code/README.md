# Claude Code integration

## Repository prerequisites

Use Node.js 22 or newer and pnpm 11.9 or newer. From the IntentCanvas checkout, install the workspace dependencies once and start the local Runtime in a terminal that remains open:

```bash
cd /absolute/path/to/intentcanvas
pnpm install
pnpm dev
```

The repository packages are not globally installed by `pnpm install`; the root scripts provide the checkout-local commands:

```bash
pnpm intentcanvas status
pnpm intentcanvas plan validate /path/to/plan.json
pnpm intentcanvas plan import /path/to/plan.json
pnpm facts \
  extract /path/to/project --output /path/to/facts.json
pnpm diff \
  /path/to/approved-plan.json /path/to/implemented.json --markdown
pnpm facts-diff \
  /path/to/approved-plan.json /path/to/current-facts.json \
  /path/to/implemented-facts.json --markdown
```

When the packages are installed as command-line tools, the equivalent binaries are `intentcanvas`, `intentcanvas-code-facts`, `intentcanvas-diff`, and `intentcanvas-facts-diff`.

## Load the plugin

Validate and load this checkout:

```bash
claude plugin validate --strict /absolute/path/to/intentcanvas
claude --plugin-dir /absolute/path/to/intentcanvas
```

Start a new Claude Code session, then invoke `/intentcanvas:visual-plan` or ask Claude to create an IntentCanvas plan. The Skill validates and imports strict Plan JSON, gives you the CLI's clickable Review URL, waits for Runtime module approval, implements only approved scope, and runs the Plan-versus-Actual diff.

## Hook events

Plugin hooks run asynchronously and fail open. Runtime failure never blocks Claude Code. `INTENTCANVAS_RUNTIME_URL` may be the Runtime origin (`http://127.0.0.1:4317`) or the full `/api/events` endpoint.

The adapter uses these canonical mappings:

- `SessionStart` → `session_started`
- `Notification` → `notification`
- `Stop` and `TaskCompleted` → `task_complete`
- `SessionEnd` → `session_ended`
- explicit `plan_ready`, `approval_required`, and `review_drift_detected` milestones keep those exact protocol types

An integration can emit an explicit workflow milestone without parsing assistant text:

```bash
node /absolute/path/to/intentcanvas/scripts/hook-event.mjs \
  --event plan_ready --review-id <review-id>
node /absolute/path/to/intentcanvas/scripts/hook-event.mjs \
  --event approval_required --review-id <review-id> --module-id <module-id>
node /absolute/path/to/intentcanvas/scripts/hook-event.mjs \
  --event review_drift_detected --review-id <review-id>
```

Only allowlisted structural metadata is forwarded. Raw tool input/output, transcripts, environment objects, credentials, and tokens are never included or logged.

## tmux and SSH Bridge

For a local tmux workflow, keep the Runtime in its own session and run Claude Code in another pane or terminal:

```bash
tmux new-session -s intentcanvas-runtime \
  'cd /absolute/path/to/intentcanvas && pnpm dev'
```

Inspect the current SSH/tmux context and ask the Runtime for a fresh one-use local review link:

```bash
pnpm bridge environment
pnpm intentcanvas plan open <review-id>
```

When the Runtime is on an SSH host, run the Bridge on the local client and keep it open:

```bash
pnpm bridge \
  ssh <user@remote-host> --review <review-id> \
  --remote-port 4317
```

After it reports the same-port tunnel ready, run `pnpm intentcanvas plan open <review-id>` inside the remote Claude/tmux session and click the fresh URL printed there. The link works once and expires after 60 seconds; rerun the command when needed. The installed `@intentcanvas/bridge` package exposes the same commands as `intentcanvas-bridge`. Never run its `ssh` subcommand inside the remote SSH session; a remote process cannot create the required client-local listener.
