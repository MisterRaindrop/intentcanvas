import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readAuthToken, runtimeIdentityProof } from "../packages/local-auth/src/index.js";
import {
  installWorkspaceDependencies,
  setupHost,
  startBackgroundRuntime
} from "./host.mjs";
import { resolveLauncher } from "../skills/visual-plan/scripts/dispatch.mjs";

const repositoryRoot = new URL("../", import.meta.url).pathname;

async function temporaryHome(t) {
  const directory = await mkdtemp(join(tmpdir(), "intentcanvas-host-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("dependency setup uses a fixed pnpm argument vector without a shell", async () => {
  const calls = [];
  let ready = false;
  const result = await installWorkspaceDependencies({
    repositoryRoot,
    dependenciesReady: async () => ready,
    findExecutable: async (name) => name === "pnpm" ? "/tools/pnpm" : null,
    runTool: async (executable, args, options) => {
      calls.push({ executable, args, options });
      ready = true;
      return { stdout: "", stderr: "" };
    }
  });

  assert.equal(result.installed, true);
  assert.equal(calls[0].executable, "/tools/pnpm");
  assert.deepEqual(calls[0].args, ["install", "--frozen-lockfile"]);
  assert.equal(calls[0].options.cwd, repositoryRoot.replace(/\/$/u, ""));
});

test("one-time setup writes a private installation record and links Codex and the launcher", async (t) => {
  const home = await temporaryHome(t);
  const result = await setupHost({
    repositoryRoot,
    home,
    env: { PATH: "" },
    dependenciesReady: async () => true,
    skipClaude: true,
    skipStart: true
  });

  assert.equal(result.ok, true);
  assert.equal((await readAuthToken({ home })).length, 43);
  const installation = JSON.parse(await readFile(
    join(home, ".intentcanvas", "installation.json"),
    "utf8"
  ));
  assert.equal(installation.kind, "IntentCanvasInstallation");
  assert.equal(installation.repositoryRoot, repositoryRoot.replace(/\/$/u, ""));
  assert.equal(
    await readlink(join(home, ".local", "bin", "intentcanvas")),
    join(installation.repositoryRoot, "intentcanvas")
  );
  assert.equal(
    await readlink(join(home, ".codex", "skills", "visual-plan")),
    join(installation.repositoryRoot, "skills", "visual-plan")
  );
  assert.equal(await resolveLauncher({ home, env: {} }), installation.launcher);
});

test("background start waits for a challenge-verified Runtime and records its pid", async (t) => {
  const home = await temporaryHome(t);
  let spawned = false;
  let spawnOptions;
  const fetchImpl = async (url) => {
    if (!spawned) throw new TypeError("not running");
    const challenge = new URL(url).searchParams.get("challenge");
    const token = await readAuthToken({ home });
    return {
      ok: true,
      async json() {
        return {
          service: "intentcanvas-runtime",
          version: "0.3.0",
          challenge,
          proof: runtimeIdentityProof(token, challenge)
        };
      }
    };
  };
  const result = await startBackgroundRuntime({
    repositoryRoot,
    home,
    env: {},
    dependenciesReady: async () => true,
    fetchImpl,
    spawnRuntime: (entry, options) => {
      spawned = true;
      spawnOptions = { entry, options };
      return { pid: 4242, unref() {} };
    },
    startAttempts: 1,
    delayImpl: async () => {}
  });

  assert.equal(result.started, true);
  assert.equal(result.pid, 4242);
  assert.equal(
    await readFile(join(home, ".intentcanvas", "runtime.pid"), "utf8"),
    "4242\n"
  );
  assert.equal(
    spawnOptions.options.env.INTENTCANVAS_AUTH_TOKEN_FILE,
    join(home, ".intentcanvas", "auth-token")
  );
  assert.equal(
    spawnOptions.options.env.INTENTCANVAS_DATA_DIR,
    join(home, ".intentcanvas", "runtime")
  );
});
