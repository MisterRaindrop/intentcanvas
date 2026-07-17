import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CompilationDatabaseError,
  discoverBuildSystems,
  findCompileCommands,
  locateCompilationDatabases,
  normalizeCompileCommand,
  readCompileCommands,
  languageForFile,
  tokenizeCommand
} from "../src/index.js";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "intentcanvas-code-facts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("discovers common build systems without invoking them", async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(join(root, "component"));
  await mkdir(join(root, "build"));
  await writeFile(join(root, "CMakeLists.txt"), "project(example)\n");
  await writeFile(join(root, "component", "meson.build"), "project('example', 'cpp')\n");
  await writeFile(join(root, "build", "build.ninja"), "# generated\n");

  const systems = await discoverBuildSystems(root);

  assert.deepEqual(systems.map(({ type, path }) => ({ type, path })), [
    { type: "cmake", path: "CMakeLists.txt" },
    { type: "meson", path: "component/meson.build" },
    { type: "ninja", path: "build/build.ninja" }
  ]);
  assert.ok(systems.every((system) => system.confidence === "high"));
});

test("finds the common root symlink to a build-tree compilation database", async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(join(root, "build"));
  await writeFile(join(root, "build", "compile_commands.json"), "[]\n");
  await symlink(join("build", "compile_commands.json"), join(root, "compile_commands.json"));

  assert.equal(await findCompileCommands(root), join(root, "compile_commands.json"));
});

test("locates compilation databases with deterministic preference", async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(join(root, "build", "debug"), { recursive: true });
  await writeFile(join(root, "compile_commands.json"), "[]\n");
  await writeFile(join(root, "build", "compile_commands.json"), "[]\n");
  await writeFile(join(root, "build", "debug", "compile_commands.json"), "[]\n");

  const paths = await locateCompilationDatabases(root);

  assert.equal(paths[0], join(root, "compile_commands.json"));
  assert.equal(await findCompileCommands(root), paths[0]);
  assert.equal(paths.length, 3);
  assert.deepEqual(
    await locateCompilationDatabases(root, { compileCommandsPath: "build" }),
    [join(root, "build", "compile_commands.json")]
  );
});

test("tokenizes quoted shell commands without executing them", () => {
  assert.deepEqual(
    tokenizeCommand('clang++ -DNAME="hello world" -I../include "../src/main file.cpp"'),
    ["clang++", "-DNAME=hello world", "-I../include", "../src/main file.cpp"]
  );
  assert.deepEqual(tokenizeCommand("cc -DVALUE='' -c empty.c"), ["cc", "-DVALUE=", "-c", "empty.c"]);
  assert.throws(
    () => tokenizeCommand("clang++ 'unterminated"),
    (error) => error instanceof CompilationDatabaseError && error.code === "invalid_command"
  );
});

test("normalizes source and include paths from command and arguments forms", () => {
  const normalized = normalizeCompileCommand({
    directory: "/work/project/build",
    file: "../src/main.cpp",
    command: 'clang++ -I../include -isystem "/opt/sdk include" -iquote../quoted @flags.rsp -c ../src/main.cpp'
  }, { projectRoot: "/work/project" });

  assert.equal(normalized.file, "/work/project/src/main.cpp");
  assert.equal(normalized.projectFile, "src/main.cpp");
  assert.deepEqual(normalized.includeDirectories.map(({ path, kind, projectPath }) => ({
    path, kind, projectPath
  })), [
    { path: "/opt/sdk include", kind: "system", projectPath: "/opt/sdk include" },
    { path: "/work/project/include", kind: "user", projectPath: "include" },
    { path: "/work/project/quoted", kind: "quote", projectPath: "quoted" }
  ]);
  assert.deepEqual(normalized.responseFiles, ["/work/project/build/flags.rsp"]);

  const argumentsForm = normalizeCompileCommand({
    directory: "/work/project",
    file: "src/a.c",
    command: "this is ignored",
    arguments: ["cc", "/Iinclude", "-c", "src/a.c"]
  });
  assert.equal(argumentsForm.language, "c");
  assert.deepEqual(argumentsForm.includeDirectories, [
    { path: "/work/project/include", kind: "user" }
  ]);

  const windows = normalizeCompileCommand({
    directory: "C:\\repo\\build",
    file: "..\\src\\main.cpp",
    arguments: ["cl.exe", "/IC:\\SDK\\include", "/I", "..\\include", "/c"]
  });
  assert.equal(windows.file, "C:/repo/src/main.cpp");
  assert.deepEqual(windows.includeDirectories, [
    { path: "C:/SDK/include", kind: "user" },
    { path: "C:/repo/include", kind: "user" }
  ]);
  assert.equal(languageForFile("source.C"), "c++");
  assert.equal(languageForFile("kernel.cuh"), "cuda");
  assert.equal(languageForFile("objc.mm"), "objective-c++");
});

test("reads a normalized compilation database and reports malformed input", async (t) => {
  const root = await temporaryDirectory(t);
  const database = join(root, "compile_commands.json");
  await writeFile(database, JSON.stringify([{
    directory: root,
    file: "a.cpp",
    arguments: ["clang++", "-c", "a.cpp"]
  }]));

  const commands = await readCompileCommands(database, { projectRoot: root });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].projectFile, "a.cpp");

  await writeFile(database, "{not json");
  await assert.rejects(
    readCompileCommands(database),
    (error) => error instanceof CompilationDatabaseError && error.code === "invalid_json"
  );
});
