import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const studioDirectory = path.resolve(testDirectory, "..");

async function readStudioFile(name) {
  return readFile(path.join(studioDirectory, name), "utf8");
}

test("studio contains the complete overview and module review journey", async () => {
  const html = await readStudioFile("index.html");

  for (const expectedCopy of [
    "总体模块图",
    "每个模块准备怎么改",
    "简化调用路径",
    "类、函数和成员修改",
    "关键伪代码",
    "上一个模块",
    "下一个模块",
    "批准这个模块",
    "要求调整",
    "返回总体设计"
  ]) {
    assert.match(html, new RegExp(expectedCopy), `missing UI copy: ${expectedCopy}`);
  }
});

test("studio selects the requested review and calls the decisions API", async () => {
  const script = await readStudioFile("app.js");

  assert.match(script, /reviewIdFromSearch\(window\.location\.search\)/);
  assert.match(script, /encodeURIComponent\(REVIEW_ID\)/);
  assert.match(script, /\/decisions/);
  assert.match(script, /method:\s*"POST"/);
  assert.match(script, /moduleId:\s*module\.id/);
  assert.match(script, /submitDecision\("approved"\)/);
  assert.match(script, /submitDecision\("changes_requested"\)/);
});

test("studio validates and adopts the Runtime response", async () => {
  const script = await readStudioFile("app.js");

  assert.match(script, /normalizeDecisionResponse\(await response\.json\(\)/);
  assert.match(script, /module\.approval = result\.approval/);
  assert.match(script, /state\.review\.status = result\.reviewStatus/);
  assert.doesNotMatch(script, /updatedAt:\s*new Date\(\)\.toISOString\(\)/);
});

test("studio loads its browser code as modules", async () => {
  const html = await readStudioFile("index.html");

  assert.match(html, /<script src="\.\/app\.js" type="module"><\/script>/);
});

test("change colors and approval colors use separate semantics", async () => {
  const css = await readStudioFile("styles.css");

  assert.match(css, /--added:\s*#168456/);
  assert.match(css, /--modified:\s*#a56300/);
  assert.match(css, /--removed:\s*#c23b44/);
  assert.match(css, /--unchanged:\s*#667085/);
  assert.match(css, /--approval-approved:\s*#3159c7/);
  assert.match(css, /--approval-changes:\s*#7556a8/);
  assert.doesNotMatch(css, /--approval-approved:\s*var\(--added\)/);
  assert.doesNotMatch(css, /--approval-changes:\s*var\(--removed\)/);
});

test("studio package remains dependency free", async () => {
  const packageJson = JSON.parse(await readStudioFile("package.json"));

  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
  assert.equal(packageJson.scripts.test, "node --test tests/*.test.js");
});
