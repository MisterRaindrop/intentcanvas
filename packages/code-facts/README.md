# `@intentcanvas/code-facts`

Read-only, dependency-free extraction of deterministic Code Facts v1 for C and
C++ repositories.

The package discovers common build-system markers, locates and normalizes an
existing `compile_commands.json`, and optionally ingests existing clang-uml
JSON. It never runs a build, compiler, or clang-uml. When semantic tool output
is absent, it emits an explicit diagnostic and leaves symbols and graph edges
empty instead of parsing source text heuristically.

## JavaScript API

```js
import {
  discoverBuildSystems,
  findCompileCommands,
  readCompileCommands,
  extractCodeFacts,
  inspectCodeFacts
} from "@intentcanvas/code-facts";

const facts = await extractCodeFacts("/work/project", {
  compileCommandsPath: "/work/project/build/compile_commands.json",
  clangUmlPath: "/tmp/project-sequence.json"
});

const summary = inspectCodeFacts(facts);
```

Useful lower-level APIs include `locateCompilationDatabases`,
`normalizeCompileCommand`, `tokenizeCommand`, `parseClangUmlJson`, and
`readClangUmlJson`.

## CLI

```text
code-facts extract [project-root] \
  --compile-commands build/compile_commands.json \
  --clang-uml /tmp/diagram.json > /tmp/code-facts.json

code-facts inspect /tmp/code-facts.json
```

`extract` writes to standard output by default. `--output` writes only to the
explicit path supplied by the caller. `inspect --json` returns a machine-readable
summary.

## Code Facts v1

The versioned document contains `project`, `files`, `symbols`, `includeEdges`,
`callEdges`, and `diagnostics`. Every emitted fact has `confidence` and `source`
metadata. File paths and symbol IDs are the graph keys. All arrays use stable
sorting and no generation timestamp is added, so identical inputs produce
byte-identical serialized JSON.
