# Roadmap

## Slice 1: review loop

- Versioned Plan Model
- Local Runtime and review API
- Visual overview and module drill-down
- Module approval and requested-change feedback
- Claude Code and Codex skill packaging

## Slice 2: remote workflow

- Long-running `hookd`
- Per-session event stream
- Local Bridge and automatic SSH forwarding
- Signed terminal links and desktop notifications
- Persistent review storage

## Slice 3: code facts

- Build-system discovery
- `compile_commands.json` generation
- clang-uml/Clang AST ingestion
- Current versus Proposed semantic diff
- Source locations and confidence markers

## Slice 4: execution verification

- Freeze Approved Model
- Re-extract Implemented Model
- Plan-versus-Actual drift report
- Build, test, sanitizer, static-analysis, and performance evidence
- Re-review gate for unapproved core changes
