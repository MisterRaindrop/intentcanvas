import test from "node:test";
import assert from "node:assert/strict";

import { parseClangUmlJson } from "../src/index.js";
import { validateCodeFacts } from "../../protocol/src/index.js";

const source = { tool: "test", version: "1" };

function documentWith(parsed) {
  return {
    schemaVersion: "1.0.0",
    kind: "IntentCanvasCodeFacts",
    project: { root: "/repo", name: "repo" },
    ...parsed,
    confidence: "high",
    source
  };
}

test("ingests real file, symbol, include, and sequence relationships", () => {
  const parsed = parseClangUmlJson({
    version: "0.6.2",
    diagrams: {
      includes: {
        diagram_type: "include",
        elements: [
          {
            id: "folder-1",
            type: "folder",
            name: "src",
            elements: [{ id: "f1", type: "file", display_name: "src/main.cpp" }]
          },
          {
            id: "folder-2",
            type: "folder",
            name: "include",
            elements: [{ id: "f2", type: "file", display_name: "include/service.hpp" }]
          }
        ],
        relationships: [{ source: "f1", destination: "f2", type: "association" }]
      },
      sequence: {
        diagram_type: "sequence",
        participants: [
          {
            id: "s1",
            type: "function",
            name: "main()",
            source: { file: "src/main.cpp", line: 4, column: 1 }
          },
          {
            id: "service",
            type: "class",
            name: "Service",
            source_location: { file: "src/service.cpp", line: 8, column: 1 },
            activities: [{
              id: "s2",
              type: "method",
              name: "run",
              full_name: "Service::run()",
              source_location: { file: "src/service.cpp", line: 10, column: 3 }
            }]
          }
        ],
        sequences: [{
          messages: [{
            from: { activity_id: "s1", participant_id: "s1" },
            to: { activity_id: "s2", participant_id: "service" },
            name: "run",
            type: "message",
            source_location: { file: "src/main.cpp", line: 6, column: 5 }
          }, {
            from: { activity_id: "s2", participant_id: "service" },
            to: { activity_id: "s1", participant_id: "s1" },
            type: "return",
            source_location: { file: "src/service.cpp", line: 10, column: 20 }
          }]
        }]
      }
    }
  }, { projectRoot: "/repo", sourcePath: "uml.json" });

  assert.deepEqual(parsed.files.map((file) => file.path), [
    "include/service.hpp",
    "src/main.cpp",
    "src/service.cpp"
  ]);
  assert.equal(parsed.symbols.length, 3);
  assert.equal(parsed.includeEdges.length, 1);
  assert.deepEqual(parsed.includeEdges[0], {
    from: "src/main.cpp",
    to: "include/service.hpp",
    confidence: "high",
    source: { tool: "clang-uml", version: "0.6.2", path: "uml.json" }
  });
  assert.equal(parsed.callEdges.length, 1);
  assert.equal(parsed.symbols.find((symbol) => symbol.id === parsed.callEdges[0].to).kind, "method");
  assert.equal(parsed.callEdges[0].location.file, "src/main.cpp");
  assert.equal(parsed.callEdges[0].location.line, 6);
  assert.deepEqual(validateCodeFacts(documentWith(parsed)), { valid: true, errors: [] });
});

test("uses semantic method and field kinds rather than class JSON value types", () => {
  const parsed = parseClangUmlJson({
    diagram_type: "class",
    elements: [{
      id: "class-a",
      type: "class",
      name: "A",
      namespace: "example",
      source_location: { file: "a.hpp", line: 1 },
      methods: [{
        name: "run",
        display_name: "run(int)",
        type: "void",
        source_location: { file: "a.hpp", line: 3 }
      }],
      members: [{
        name: "value",
        type: "int",
        source_location: { file: "a.hpp", line: 5 }
      }]
    }]
  }, { projectRoot: "/repo" });

  assert.deepEqual(parsed.symbols.map((symbol) => symbol.kind).sort(), ["class", "field", "method"]);
  assert.ok(parsed.symbols.some((symbol) => symbol.qualifiedName === "example::A::run(int)"));
});

test("symbol identity ignores line movement and only fingerprints bodies when supplied", () => {
  const makeDocument = (line, body) => ({
    diagram_type: "class",
    elements: [{
      id: "service",
      type: "class",
      name: "Service",
      source_location: { file: "service.cc", line: 1 },
      methods: [{
        name: "run",
        display_name: "run()",
        source_location: { file: "service.cc", line },
        ...(body === undefined ? {} : { body })
      }]
    }]
  });
  const first = parseClangUmlJson(makeDocument(3));
  const moved = parseClangUmlJson(makeDocument(30));
  const supplied = parseClangUmlJson(makeDocument(3, "return 1;"));
  const firstMethod = first.symbols.find((symbol) => symbol.kind === "method");
  const movedMethod = moved.symbols.find((symbol) => symbol.kind === "method");
  const suppliedMethod = supplied.symbols.find((symbol) => symbol.kind === "method");

  assert.equal(firstMethod.id, movedMethod.id);
  assert.equal(firstMethod.fingerprint, movedMethod.fingerprint);
  assert.equal(firstMethod.implementationFingerprint, undefined);
  assert.match(suppliedMethod.implementationFingerprint, /^sha256:[0-9a-f]{64}$/u);
});

test("diagnoses incomplete and unresolved clang-uml records instead of inventing facts", () => {
  const parsed = parseClangUmlJson({
    diagram_type: "sequence",
    participants: [
      { id: "named-but-no-file", type: "function", name: "missing()" },
      { id: "ok", type: "function", name: "ok()", source: { file: "ok.cpp", line: 1 } }
    ],
    messages: [{ from: "ok", to: "missing", name: "unknown" }]
  }, { projectRoot: "/repo" });

  assert.equal(parsed.symbols.length, 1);
  assert.equal(parsed.callEdges.length, 0);
  assert.ok(parsed.diagnostics.some((item) => item.code === "clang_uml_symbol_incomplete"));
  assert.ok(parsed.diagnostics.some((item) => item.code === "clang_uml_unresolved_call"));
});

test("accepts JSON text and diagnoses documents without supported diagrams", () => {
  const parsed = parseClangUmlJson('{"metadata":{"tool":"clang-uml"}}');
  assert.equal(parsed.files.length, 0);
  assert.equal(parsed.symbols.length, 0);
  assert.equal(parsed.diagnostics[0].code, "clang_uml_no_diagrams");
  assert.throws(() => parseClangUmlJson("not-json"), /Invalid clang-uml JSON/);
});
