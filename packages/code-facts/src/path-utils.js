import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";

export function toPosixPath(value) {
  return sep === "/" ? value : value.split(sep).join("/");
}

export function resolveFrom(base, value) {
  return resolve(base, value);
}

export function pathForProject(projectRoot, value) {
  const absoluteRoot = resolve(projectRoot);
  const absoluteValue = resolve(value);
  const projectRelative = relative(absoluteRoot, absoluteValue);
  if (projectRelative === "") return ".";
  if (projectRelative !== ".." && !projectRelative.startsWith(`..${sep}`) &&
      !isAbsolute(projectRelative)) {
    return toPosixPath(projectRelative);
  }
  return toPosixPath(absoluteValue);
}

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortUnique(values) {
  return [...new Set(values)].sort(compareText);
}

export async function findExecutable(name, {
  pathValue = process.env.PATH ?? "",
  platform = process.platform
} = {}) {
  if (typeof name !== "string" || name.length === 0) return null;

  const hasSeparator = name.includes("/") || name.includes("\\");
  const extensions = platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const candidates = [];

  if (hasSeparator || isAbsolute(name)) {
    for (const extension of extensions) candidates.push(`${name}${extension}`);
  } else {
    for (const directory of pathValue.split(delimiter).filter(Boolean)) {
      for (const extension of extensions) {
        candidates.push(resolve(directory, `${name}${extension}`));
      }
    }
  }

  for (const candidate of candidates) {
    try {
      await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH. Merely checking availability never runs the tool.
    }
  }
  return null;
}
