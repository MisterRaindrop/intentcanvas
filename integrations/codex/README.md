# Codex integration

## Repository prerequisites

Use Node.js 22 or newer and run the one-time setup:

```bash
cd /absolute/path/to/intentcanvas
./intentcanvas setup
```

Setup links `skills/visual-plan` into the active Codex home without replacing an existing Skill, installs a user command, creates private credentials, and starts Runtime in the background. The main commands are:

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

Installed packages expose `intentcanvas`, `intentcanvas-code-facts`, `intentcanvas-diff`, and `intentcanvas-facts-diff` with the same arguments.

## Load the Skill

After setup, start a new Codex task and invoke `$visual-plan`. For manual development, link or copy `skills/visual-plan` into `<codex-home>/skills/visual-plan`. The Codex plugin manifest remains at `.codex-plugin/plugin.json` for validation and future packaging.

The Skill resolves setup's private installation record and delegates to the real checkout, so a copied or cached Skill does not need its own `node_modules`. Its workflow is: preview/prepare facts, validate/import the Plan, open the CLI's Review URL, wait for full Runtime approval, freeze the exact approved revision, implement that contract, generate Actual from fresh facts, publish the acceptance report to Studio, and run the diff. Codex currently follows this Skill gate procedurally; the synchronous PreToolUse enforcement is a Claude Code Hook capability.

When the user explicitly abandons the workflow, they run `intentcanvas plan detach` to remove the current workspace's local review binding.

## tmux and SSH Bridge

The local Runtime is supervised by the lightweight host process and networked workflow commands start it automatically.

For a Runtime already reachable on the local machine:

```bash
intentcanvas bridge environment
intentcanvas plan open <review-id>
```

For a Runtime bound to loopback on an SSH host, run this on the local client and keep it open:

```bash
intentcanvas bridge \
  ssh <user@remote-host> --review <review-id> \
  --remote-port 4317
```

After the same-port tunnel is ready, run `intentcanvas plan open <review-id>` in the remote Codex/tmux session and click its 60-second one-use URL. The `ssh` subcommand deliberately refuses to run inside a remote SSH session.
