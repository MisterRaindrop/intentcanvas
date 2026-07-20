import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createClangUmlConfig,
  planEvidencePreparation,
  prepareCodeFacts
} from "../src/index.js";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "intentcanvas-prepare-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fakeExecutable(directory, name) {
  const path = join(directory, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
}

test("generates a bounded clang-uml configuration for class and include evidence", () => {
  const config = createClangUmlConfig({
    projectRoot: "/work/repo",
    compileCommandsPath: "/private/evidence/build/compile_commands.json",
    outputDirectory: "/private/evidence/uml"
  });

  assert.match(config, /compilation_database_dir: "\/private\/evidence\/build"/u);
  assert.match(config, /intentcanvas_classes:/u);
  assert.match(config, /intentcanvas_includes:/u);
  assert.match(config, /type: include/u);
  assert.doesNotMatch(config, /sequence/u);
});

test("dry-run planning reuses an existing compilation database without invoking a build", async (t) => {
  const root = await temporaryDirectory(t);
  await writeFile(join(root, "CMakeLists.txt"), "project(example)\n");
  await writeFile(join(root, "compile_commands.json"), "[]\n");

  const plan = await planEvidencePreparation(root, {
    workDirectory: join(root, "private-evidence"),
    pathValue: ""
  });

  assert.equal(plan.compileCommandsPath, join(await realpath(root), "compile_commands.json"));
  assert.equal(plan.generatedCompilationDatabase, false);
  assert.deepEqual(plan.commands, []);
  assert.equal(plan.warnings.length, 1);
});

test("prepares CMake and clang-uml evidence in an isolated directory", async (t) => {
  const root = await temporaryDirectory(t);
  const tools = await temporaryDirectory(t);
  const workDirectory = await temporaryDirectory(t);
  const cmake = await fakeExecutable(tools, "cmake");
  const clangUml = await fakeExecutable(tools, "clang-uml");
  const source = join(root, "main.cpp");
  await writeFile(join(root, "CMakeLists.txt"), "project(example)\n");
  await writeFile(source, "int main() { return 0; }\n");

  const calls = [];
  const prepared = await prepareCodeFacts(root, {
    workDirectory,
    pathValue: tools,
    runTool: async (executable, args) => {
      calls.push({ executable, args: [...args] });
      if (executable === cmake) {
        const buildDirectory = args[args.indexOf("-B") + 1];
        await mkdir(buildDirectory, { recursive: true });
        await writeFile(join(buildDirectory, "compile_commands.json"), JSON.stringify([{
          directory: buildDirectory,
          file: source,
          arguments: ["clang++", "-c", source]
        }]));
      } else if (executable === clangUml) {
        const outputDirectory = join(workDirectory, "clang-uml");
        await writeFile(join(outputDirectory, "intentcanvas_classes.json"), JSON.stringify({
          diagram_type: "class",
          elements: [{
            id: "class-main",
            name: "Main",
            source: { file: "main.cpp", line: 1 },
            methods: [{
              id: "method-main",
              display_name: "main()",
              source: { file: "main.cpp", line: 1 }
            }]
          }]
        }));
        await writeFile(join(outputDirectory, "intentcanvas_includes.json"), JSON.stringify({
          diagram_type: "include",
          elements: []
        }));
      }
      return { stdout: "ok\n", stderr: "" };
    }
  });

  assert.deepEqual(calls.map((call) => call.executable), [cmake, clangUml]);
  assert.equal(prepared.facts.project.compileCommands.startsWith("/"), true);
  assert.equal(prepared.facts.files.some((file) => file.path === "main.cpp"), true);
  assert.equal(prepared.facts.symbols.some((symbol) => symbol.name === "main()"), true);
  assert.equal(prepared.facts.confidence, "medium");
  assert.equal(prepared.facts.coverage.semanticInventoryComplete, false);
  assert.equal(prepared.manifest.outputs.clangUml.length, 2);
  assert.equal(JSON.parse(await readFile(prepared.manifestPath, "utf8")).runs.length, 2);
});
