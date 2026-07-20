# Claude Code integration

## Repository prerequisites

Use Node.js 22 or newer. From the IntentCanvas checkout, run the one-time setup:

```bash
cd /absolute/path/to/intentcanvas
./intentcanvas setup
```

Setup installs workspace links, a user command, the Claude marketplace/plugin, the Codex Skill, private credentials, and a background Runtime. It is idempotent and never overwrites an unrelated command or Skill. Diagnose the complete local environment with `intentcanvas doctor`.

The unified command surface is:

```bash
intentcanvas status
intentcanvas plan validate /path/to/plan.json
intentcanvas plan import /path/to/plan.json
intentcanvas plan gate <review-id>
intentcanvas plan freeze <review-id> /path/to/approved-snapshot.json
intentcanvas facts prepare /path/to/project --dry-run
intentcanvas facts prepare /path/to/project --output /path/to/facts.json
intentcanvas diff \
  /path/to/approved-snapshot.json /path/to/implemented.json --markdown
intentcanvas facts-diff \
  /path/to/approved-snapshot.json /path/to/current-facts.json \
  /path/to/implemented-facts.json --markdown
intentcanvas acceptance facts <review-id> \
  /path/to/current-facts.json /path/to/implemented-facts.json
```

When the packages are installed as command-line tools, the equivalent binaries are `intentcanvas`, `intentcanvas-code-facts`, `intentcanvas-diff`, and `intentcanvas-facts-diff`.

## Load the plugin

Normal setup registers this checkout as the `intentcanvas` marketplace and installs `intentcanvas@intentcanvas` at user scope. Restart Claude Code or run `/reload-plugins` after the first setup.

For development without installation, validate and load this checkout:

```bash
claude plugin validate --strict /absolute/path/to/intentcanvas
claude --plugin-dir /absolute/path/to/intentcanvas
```

Start a new Claude Code session, then invoke `/intentcanvas:visual-plan` or ask Claude to create an IntentCanvas plan. The Skill validates and imports strict Plan JSON, gives you the CLI's clickable Review URL, waits for full module-by-module approval, freezes that Runtime revision, and runs Plan-versus-Actual verification.

## Write gate and Hook events

Importing or opening a review writes a private per-user workspace binding outside the repository. The synchronous `PreToolUse` Hook checks that review before Edit, Write, mutating Bash/Agent, and mutating MCP tools. While the review is pending or changed, or if Runtime identity/availability cannot be proven, the Hook denies the write. Full approval releases this additional gate but does not bypass Claude Code's normal permission prompt.

If the user explicitly abandons the workflow, they run `intentcanvas plan detach` themselves from that project. The Hook deliberately prevents the coding agent from detaching or rebinding a pending gate.

Lifecycle event hooks are separate: they run asynchronously and fail open. `INTENTCANVAS_RUNTIME_URL` may be the Runtime origin (`http://127.0.0.1:4317`) or the full `/api/events` endpoint. Both gate and telemetry verify a fresh Runtime challenge before sending the bearer token.

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

For a local tmux workflow, `intentcanvas setup` starts Runtime in the background and later workflow commands restart it automatically if needed.

Inspect the current SSH/tmux context and ask the Runtime for a fresh one-use local review link:

```bash
intentcanvas bridge environment
intentcanvas plan open <review-id>
```

When the Runtime is on an SSH host, run the Bridge on the local client and keep it open:

```bash
intentcanvas bridge \
  ssh <user@remote-host> --review <review-id> \
  --remote-port 4317
```

After it reports the same-port tunnel ready, run `intentcanvas plan open <review-id>` inside the remote Claude/tmux session and click the fresh URL printed there. The link works once and expires after 60 seconds; rerun the command when needed. Never run the Bridge `ssh` subcommand inside the remote SSH session; a remote process cannot create the required client-local listener.
