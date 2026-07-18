#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { auditPlanAgainstCodeFacts, formatFactsAuditMarkdown } from "./facts-diff.js";

const args = process.argv.slice(2);
const markdown = args.includes("--markdown");
const files = args.filter((argument) => argument !== "--markdown");

if (files.length !== 3) {
  console.error(
    "Usage: intentcanvas-facts-diff <approved-snapshot.json> <current-facts.json> <implemented-facts.json> [--markdown]"
  );
  process.exitCode = 2;
} else {
  try {
    const [approved, current, implemented] = await Promise.all(
      files.map(async (file) => JSON.parse(await readFile(file, "utf8")))
    );
    const report = auditPlanAgainstCodeFacts(approved, current, implemented);
    process.stdout.write(markdown
      ? formatFactsAuditMarkdown(report)
      : `${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.status === "pass" ? 0 : 3;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: { code: "facts_diff_failed", message: error.message }
    }));
    process.exitCode = 1;
  }
}
