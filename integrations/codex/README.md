# Codex integration

## Repository prerequisites

Use Node.js 22 or newer and pnpm 11.9 or newer. Install the workspace and keep the local Runtime running:

```bash
cd /absolute/path/to/intentcanvas
pnpm install
pnpm dev
```

`pnpm install` links workspace dependencies but does not install global commands. The root scripts expose checkout-local equivalents:

```bash
pnpm intentcanvas status
pnpm intentcanvas plan validate /path/to/plan.json
pnpm intentcanvas plan import /path/to/plan.json
pnpm intentcanvas plan gate <review-id>
pnpm intentcanvas plan freeze <review-id> /path/to/approved-snapshot.json
pnpm facts \
  extract /path/to/project --output /path/to/facts.json
pnpm diff \
  /path/to/approved-snapshot.json /path/to/implemented.json --markdown
pnpm facts-diff \
  /path/to/approved-snapshot.json /path/to/current-facts.json \
  /path/to/implemented-facts.json --markdown
```

Installed packages expose `intentcanvas`, `intentcanvas-code-facts`, `intentcanvas-diff`, and `intentcanvas-facts-diff` with the same arguments.

## Load the Skill

IntentCanvas has no marketplace entry in this development checkout. Link or copy `skills/visual-plan` into `<codex-home>/skills/visual-plan`, start a new Codex task, and invoke `$visual-plan`. The Codex plugin manifest remains at `.codex-plugin/plugin.json` for validation and future packaging; no marketplace configuration is required or created.

The Skill resolves checkout-local scripts relative to its own directory, so it does not depend on globally installed binaries. Its workflow is: extract read-only facts, validate/import the Plan, open the CLI's Review URL, wait for full Runtime approval, freeze the exact approved revision, implement that contract, generate Actual from fresh facts, and run the diff. Codex currently follows this Skill gate procedurally; the synchronous PreToolUse enforcement is a Claude Code Hook capability.

When the user explicitly abandons the workflow, they run `pnpm intentcanvas plan detach` to remove the current workspace's local review binding.

## tmux and SSH Bridge

The local Runtime can be kept in a dedicated tmux session:

```bash
tmux new-session -s intentcanvas-runtime \
  'cd /absolute/path/to/intentcanvas && pnpm dev'
```

For a Runtime already reachable on the local machine:

```bash
pnpm bridge environment
pnpm intentcanvas plan open <review-id>
```

For a Runtime bound to loopback on an SSH host, run this on the local client and keep it open:

```bash
pnpm bridge \
  ssh <user@remote-host> --review <review-id> \
  --remote-port 4317
```

After the same-port tunnel is ready, run `pnpm intentcanvas plan open <review-id>` in the remote Codex/tmux session and click its 60-second one-use URL. The installed `@intentcanvas/bridge` package exposes the same `intentcanvas-bridge environment`, `link`, and `ssh` commands. The `ssh` subcommand deliberately refuses to run inside a remote SSH session.
