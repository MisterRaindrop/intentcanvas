# Codex integration

IntentCanvas is currently loaded as a development plugin rather than installed from a published marketplace.

For skill-only development, link or copy `skills/visual-plan` into `${CODEX_HOME:-$HOME/.codex}/skills/visual-plan`, start a new Codex session, and invoke `$visual-plan`. The repository root already contains the Codex manifest at `.codex-plugin/plugin.json` for plugin validation and future packaging.

A one-command marketplace installation will be documented when the public marketplace entry is added; Codex does not automatically discover this GitHub repository as a plugin.
