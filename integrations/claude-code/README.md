# Claude Code integration

Load this repository directly while developing:

```bash
claude --plugin-dir /absolute/path/to/intentcanvas
```

Run `claude plugin validate /absolute/path/to/intentcanvas` to validate the manifest, skill, and hooks. Start a new session, then invoke `/intentcanvas:visual-plan` or ask Claude to create a visual plan before implementation.

The hooks forward lifecycle events to `http://127.0.0.1:4317/api/events`. Set `INTENTCANVAS_RUNTIME_URL` only when using a different local Runtime address. A missing Runtime never blocks Claude Code.
