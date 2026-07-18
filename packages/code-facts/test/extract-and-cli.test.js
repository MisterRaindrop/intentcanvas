import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  CODE_FACTS_KIND,
  extractCodeFacts,
  inspectCodeFacts,
  serializeCodeFacts
} from "../src/index.js";
import {
  CODE_FACTS_SCHEMA_VERSION as PROTOCOL_CODE_FACTS_SCHEMA_VERSION,
  validateCodeFacts
} from "../../protocol/src/index.js";

const bin = fileURLToPath(new URL("../bin/code-facts.js", import.meta.url));

async function projectFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "intentcanvas-extract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "include"));
  await mkdir(join(root, "build"));
  await writeFile(join(root, "CMakeLists.txt"), "project(facts LANGUAGES CXX)\n");
  await writeFile(join(root, "src", "main.cpp"), "int helper();\nint main() { return helper(); }\n");
  await writeFile(join(root, "src", "helper.cpp"), "int helper() { return 0; }\n");
  await writeFile(join(root, "include", "helper.hpp"), "int helper();\n");
  await writeFile(join(root, "build", "compile_commands.json"), JSON.stringify([
    {
      directory: join(root, "build"),
      file: "../src/helper.cpp",
      arguments: ["clang++", "-I../include", "-c", "../src/helper.cpp"]
    },
    {
      directory: join(root, "build"),
      file: "../src/main.cpp",
      command: "clang++ -I../include -c ../src/main.cpp"
    }
  ]));
  await writeFile(join(root, "uml.json"), JSON.stringify({
    diagram_type: "sequence",
    participants: [
      { id: "main", type: "function", name: "main()", source: { file: "src/main.cpp", line: 2 } },
      { id: "helper", type: "function", name: "helper()", source: { file: "src/helper.cpp", line: 1 } }
    ],
    messages: [{
      from: "main",
      to: "helper",
      source_location: { file: "src/main.cpp", line: 2, column: 21 }
    }]
  }));
  return root;
}

function execute(command, arguments_, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test("extracts protocol-valid facts with deterministic order and fingerprints", async (t) => {
  const root = await projectFixture(t);
  const options = {
    compileCommandsPath: "build/compile_commands.json",
    clangUmlPath: "uml.json"
  };

  const first = await extractCodeFacts(root, options);
  const second = await extractCodeFacts(root, options);

  assert.equal(first.kind, CODE_FACTS_KIND);
  assert.equal(first.schemaVersion, PROTOCOL_CODE_FACTS_SCHEMA_VERSION);
  assert.equal(first.confidence, "medium");
  assert.deepEqual(validateCodeFacts(first), { valid: true, errors: [] });
  assert.equal(serializeCodeFacts(first), serializeCodeFacts(second));
  assert.deepEqual(first.files.map((file) => file.path), [
    "include/helper.hpp",
    "src/helper.cpp",
    "src/main.cpp"
  ]);
  assert.ok(first.files.every((file) => /^sha256:[0-9a-f]{64}$/u.test(file.fingerprint)));
  assert.deepEqual(first.coverage, {
    sourceInventoryComplete: true,
    semanticInventoryComplete: false,
    inventoryFileCount: 3,
    compiledSourceCount: 2,
    semanticSourceCount: 2
  });
  assert.equal(first.symbols.length, 2);
  assert.equal(first.callEdges.length, 1);
  assert.equal(first.project.compileCommands, "build/compile_commands.json");
});

test("reports a missing semantic tool and never guesses symbols", async (t) => {
  const root = await projectFixture(t);
  const facts = await extractCodeFacts(root, {
    compileCommandsPath: "build/compile_commands.json",
    pathValue: join(root, "empty-path")
  });

  assert.equal(facts.confidence, "medium");
  assert.equal(facts.symbols.length, 0);
  assert.equal(facts.callEdges.length, 0);
  assert.ok(facts.diagnostics.some((item) => item.code === "clang_uml_unavailable"));
  assert.deepEqual(validateCodeFacts(facts), { valid: true, errors: [] });
});

test("checks tool availability but never executes clang-uml", async (t) => {
  const root = await projectFixture(t);
  const tools = join(root, "tools");
  const sentinel = join(root, "tool-was-run");
  await mkdir(tools);
  const fakeTool = join(tools, "clang-uml");
  await writeFile(fakeTool, `#!/bin/sh\ntouch "${sentinel}"\n`);
  await chmod(fakeTool, 0o755);

  const facts = await extractCodeFacts(root, {
    compileCommandsPath: "build/compile_commands.json",
    pathValue: tools
  });

  assert.ok(facts.diagnostics.some((item) => item.code === "clang_uml_json_not_provided"));
  await assert.rejects(readFile(sentinel), (error) => error.code === "ENOENT");
});

test("inspect returns a compact summary and rejects other document kinds", async (t) => {
  const root = await projectFixture(t);
  const facts = await extractCodeFacts(root, {
    compileCommandsPath: "build/compile_commands.json",
    checkToolAvailability: false
  });
  const summary = inspectCodeFacts(facts);

  assert.equal(summary.counts.files, 3);
  assert.equal(summary.project.buildSystems[0], "cmake");
  assert.equal(summary.diagnostics.warning, 1);
  assert.throws(() => inspectCodeFacts({ ...facts, kind: "Other" }), /kind must equal/);
});

test("CLI extracts JSON to stdout and inspects it", async (t) => {
  const root = await projectFixture(t);
  const extracted = await execute(process.execPath, [
    bin,
    "extract",
    root,
    "--compile-commands",
    "build/compile_commands.json",
    "--clang-uml",
    "uml.json",
    "--compact"
  ]);

  assert.equal(extracted.code, 0, extracted.stderr);
  const facts = JSON.parse(extracted.stdout);
  assert.deepEqual(validateCodeFacts(facts), { valid: true, errors: [] });

  const outputPath = join(root, "facts.json");
  await writeFile(outputPath, extracted.stdout);
  const inspected = await execute(process.execPath, [bin, "inspect", outputPath]);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.match(inspected.stdout, /Files: 3/);
  assert.match(inspected.stdout, /Call edges: 1/);
});
