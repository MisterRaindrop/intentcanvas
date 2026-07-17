import test from "node:test";
import assert from "node:assert/strict";

import {
  CODE_FACTS_KIND,
  CODE_FACTS_SCHEMA_VERSION,
  assertCodeFacts,
  cloneCodeFacts,
  validateCodeFacts
} from "../src/index.js";

function codeFacts(overrides = {}) {
  return {
    schemaVersion: CODE_FACTS_SCHEMA_VERSION,
    kind: CODE_FACTS_KIND,
    project: {
      root: "/srv/example",
      name: "example",
      buildSystems: [{ type: "cmake", path: "CMakeLists.txt" }],
      compileCommands: "build/compile_commands.json"
    },
    files: [
      {
        path: "src/main.cc",
        language: "cpp",
        compile: {
          directory: "/srv/example/build",
          arguments: ["c++", "-Iinclude", "-c", "src/main.cc"],
          includeDirectories: [{ path: "include", kind: "user" }]
        },
        fingerprint: `sha256:${"a".repeat(64)}`,
        confidence: "high",
        source: { tool: "compile_commands", path: "build/compile_commands.json" }
      },
      {
        path: "include/service.h",
        language: "cpp",
        confidence: "high",
        source: { tool: "filesystem" }
      }
    ],
    symbols: [
      {
        id: "function:main",
        name: "main",
        kind: "function",
        file: "src/main.cc",
        location: { line: 4, column: 1, endLine: 8, endColumn: 2 },
        fingerprint: `sha256:${"b".repeat(64)}`,
        confidence: "high",
        source: { tool: "clang-ast", version: "18.1.0" }
      },
      {
        id: "function:serve",
        name: "serve",
        kind: "function",
        file: "include/service.h",
        location: { line: 3 },
        confidence: "medium",
        source: { tool: "text-index" }
      }
    ],
    includeEdges: [
      {
        from: "src/main.cc",
        to: "include/service.h",
        location: { line: 1 },
        confidence: "high",
        source: { tool: "compiler-deps" }
      }
    ],
    callEdges: [
      {
        from: "function:main",
        to: "function:serve",
        location: { file: "src/main.cc", line: 6, column: 3 },
        confidence: "medium",
        source: { tool: "clang-ast" }
      }
    ],
    diagnostics: [
      {
        severity: "info",
        code: "fallback-parser",
        message: "One symbol came from the text index",
        file: "include/service.h",
        confidence: "high",
        source: { tool: "@intentcanvas/code-facts" }
      }
    ],
    confidence: "medium",
    source: {
      tool: "@intentcanvas/code-facts",
      version: "1.0.0"
    },
    ...overrides
  };
}

test("validates a versioned Code Facts document", () => {
  const facts = codeFacts();

  assert.deepEqual(validateCodeFacts(facts), { valid: true, errors: [] });
  assert.equal(facts.schemaVersion, CODE_FACTS_SCHEMA_VERSION);
  assert.equal(facts.kind, CODE_FACTS_KIND);
});

test("reports incompatible versions, duplicate identities, and dangling graph edges", () => {
  const facts = codeFacts({ schemaVersion: "2.0.0" });
  facts.files.push({ ...facts.files[0] });
  facts.callEdges[0].to = "function:missing";

  const result = validateCodeFacts(facts);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.code === "unsupported_version"));
  assert.ok(result.errors.some((item) => item.path === "$.files[2].path"));
  assert.ok(result.errors.some((item) => item.path === "$.callEdges[0].to"));
  assert.throws(() => assertCodeFacts(facts), /Invalid IntentCanvas Code Facts/);
});

test("validates source locations, confidence markers, and provenance", () => {
  const facts = codeFacts();
  facts.symbols[0].location.endLine = 2;
  facts.includeEdges[0].confidence = "certain";
  facts.callEdges[0].location.file = "src/missing.cc";
  facts.source.tool = " ";
  facts.files[0].fingerprint = "sha256:not-a-digest";

  const result = validateCodeFacts(facts);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.code === "invalid_range"));
  assert.ok(result.errors.some((item) => item.path === "$.includeEdges[0].confidence"));
  assert.ok(result.errors.some((item) => item.path === "$.callEdges[0].location.file"));
  assert.ok(result.errors.some((item) => item.path === "$.source.tool"));
  assert.ok(result.errors.some((item) => item.path === "$.files[0].fingerprint"));
});

test("requires provenance and confidence on every fact", () => {
  const facts = codeFacts();
  delete facts.files[0].source;
  delete facts.symbols[0].confidence;
  delete facts.callEdges[0].source;
  delete facts.diagnostics[0].confidence;

  const result = validateCodeFacts(facts);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path === "$.files[0].source"));
  assert.ok(result.errors.some((item) => item.path === "$.symbols[0].confidence"));
  assert.ok(result.errors.some((item) => item.path === "$.callEdges[0].source"));
  assert.ok(result.errors.some((item) => item.path === "$.diagnostics[0].confidence"));
});

test("clones a validated document without sharing nested data", () => {
  const facts = codeFacts();
  const copy = cloneCodeFacts(facts);

  copy.files[0].compile.arguments.push("-Wall");
  copy.symbols[0].name = "renamed";

  assert.notEqual(copy, facts);
  assert.deepEqual(facts.files[0].compile.arguments, ["c++", "-Iinclude", "-c", "src/main.cc"]);
  assert.equal(facts.symbols[0].name, "main");
});

test("allows the same graph edge location in different files", () => {
  const facts = codeFacts();
  facts.callEdges.push({
    ...facts.callEdges[0],
    location: { file: "include/service.h", line: 6, column: 3 }
  });

  assert.deepEqual(validateCodeFacts(facts), { valid: true, errors: [] });
});

test("preserves valid empty compiler argv entries", () => {
  const facts = codeFacts();
  facts.files[0].compile.arguments.push("");

  assert.deepEqual(validateCodeFacts(facts), { valid: true, errors: [] });
});
