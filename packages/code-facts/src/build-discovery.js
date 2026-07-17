import { readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import { compareText, pathForProject } from "./path-utils.js";
import { sourceFor } from "./source.js";

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "third_party",
  "vendor"
]);

const EXACT_MARKERS = new Map([
  ["CMakeLists.txt", ["cmake", "CMake"]],
  ["CMakePresets.json", ["cmake", "CMake"]],
  ["meson.build", ["meson", "Meson"]],
  ["MODULE.bazel", ["bazel", "Bazel"]],
  ["WORKSPACE.bazel", ["bazel", "Bazel"]],
  ["WORKSPACE", ["bazel", "Bazel"]],
  ["BUILD.bazel", ["bazel", "Bazel"]],
  ["BUILD", ["bazel", "Bazel"]],
  ["GNUmakefile", ["make", "Make"]],
  ["Makefile", ["make", "Make"]],
  ["makefile", ["make", "Make"]],
  ["configure.ac", ["autotools", "Autotools"]],
  ["configure.in", ["autotools", "Autotools"]],
  ["build.ninja", ["ninja", "Ninja"]],
  ["BUILD.gn", ["gn", "GN"]],
  [".gn", ["gn", "GN"]],
  ["BUCK", ["buck", "Buck"]],
  [".buckconfig", ["buck", "Buck"]],
  ["SConstruct", ["scons", "SCons"]],
  ["SConscript", ["scons", "SCons"]],
  ["xmake.lua", ["xmake", "xmake"]],
  ["premake5.lua", ["premake", "Premake"]],
  ["premake4.lua", ["premake", "Premake"]],
  ["wscript", ["waf", "Waf"]],
  ["Kbuild", ["kbuild", "Kbuild"]]
]);

function markerFor(entry) {
  const exact = EXACT_MARKERS.get(entry.name);
  if (exact) return { type: exact[0], name: exact[1] };
  if (entry.isDirectory() &&
      (entry.name.endsWith(".xcodeproj") || entry.name.endsWith(".xcworkspace"))) {
    return { type: "xcode", name: "Xcode" };
  }
  if (entry.isFile() && [".sln", ".vcxproj"].includes(extname(entry.name).toLowerCase())) {
    return { type: "msbuild", name: "MSBuild" };
  }
  if (entry.isFile() && extname(entry.name).toLowerCase() === ".pro") {
    return { type: "qmake", name: "qmake" };
  }
  return null;
}

async function walk(directory, depth, maxDepth, markers) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => compareText(left.name, right.name));

  for (const entry of entries) {
    const marker = markerFor(entry);
    if (marker) markers.push({ ...marker, absolutePath: join(directory, entry.name), depth });
  }

  if (depth >= maxDepth) return;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() ||
        SKIPPED_DIRECTORIES.has(entry.name) || entry.name.endsWith(".xcodeproj") ||
        entry.name.endsWith(".xcworkspace")) {
      continue;
    }
    await walk(join(directory, entry.name), depth + 1, maxDepth, markers);
  }
}

/**
 * Discover build-system marker files without invoking the build system.
 *
 * One result is returned per detected build-system type. If a repository has
 * more than one marker for a type, the nearest lexical marker is the canonical
 * `path` and all evidence is retained in `markers`.
 */
export async function discoverBuildSystems(projectRoot, { maxDepth = 2 } = {}) {
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new TypeError("maxDepth must be a non-negative integer");
  }
  const root = resolve(projectRoot);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new TypeError("projectRoot must be a directory");

  const markers = [];
  await walk(root, 0, maxDepth, markers);
  markers.sort((left, right) => left.depth - right.depth ||
    compareText(left.type, right.type) || compareText(left.absolutePath, right.absolutePath));

  const grouped = new Map();
  for (const marker of markers) {
    const existing = grouped.get(marker.type);
    if (existing) {
      existing.markers.push(pathForProject(root, marker.absolutePath));
      continue;
    }
    const path = pathForProject(root, marker.absolutePath);
    grouped.set(marker.type, {
      type: marker.type,
      name: marker.name,
      path,
      markers: [path],
      confidence: "high",
      source: sourceFor("filesystem")
    });
  }

  return [...grouped.values()]
    .map((item) => ({ ...item, markers: [...new Set(item.markers)].sort(compareText) }))
    .sort((left, right) => compareText(left.type, right.type) || compareText(left.path, right.path));
}

export async function discoverBuildSystem(projectRoot, options) {
  return (await discoverBuildSystems(projectRoot, options))[0] ?? null;
}

export const BUILD_SYSTEM_MARKERS = Object.freeze(
  [...EXACT_MARKERS.entries()].map(([marker, [type, name]]) =>
    Object.freeze({ marker, type, name }))
);
