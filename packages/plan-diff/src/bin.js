#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { comparePlanModels, formatDriftReportMarkdown } from "./index.js";

const args = process.argv.slice(2);
const markdown = args.includes("--markdown");
const files = args.filter((arg) => arg !== "--markdown");

if (files.length !== 2) {
  console.error("Usage: intentcanvas-diff <approved-snapshot.json> <implemented-model.json> [--markdown]");
  process.exitCode = 2;
} else {
  try {
    const [approved, implemented] = await Promise.all(
      files.map(async (file) => JSON.parse(await readFile(file, "utf8")))
    );
    const report = comparePlanModels(approved, implemented);
    process.stdout.write(markdown
      ? formatDriftReportMarkdown(report)
      : `${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.status === "pass" ? 0 : 3;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: { code: "diff_failed", message: error.message }
    }));
    process.exitCode = 1;
  }
}
