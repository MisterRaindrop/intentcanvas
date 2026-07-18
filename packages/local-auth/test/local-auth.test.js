import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bearerAuthorization,
  createRuntimeIdentityChallenge,
  generateAuthToken,
  loadOrCreateAuthToken,
  readAuthToken,
  readWorkspaceBinding,
  removeWorkspaceBinding,
  resolveAuthTokenFile,
  runtimeIdentityProof,
  validateAuthToken,
  verifyRuntimeIdentityProof,
  writeWorkspaceBinding
} from "../src/index.js";

test("creates and verifies a challenge-bound Runtime identity proof", () => {
  const token = generateAuthToken(() => Buffer.alloc(32, 1));
  const challenge = createRuntimeIdentityChallenge(() => Buffer.alloc(32, 2));
  const proof = runtimeIdentityProof(token, challenge);

  assert.equal(verifyRuntimeIdentityProof(token, challenge, proof), true);
  assert.equal(verifyRuntimeIdentityProof(token, "C".repeat(43), proof), false);
  assert.equal(verifyRuntimeIdentityProof("D".repeat(43), challenge, proof), false);
});

test("stores a private workspace-to-review binding without touching the repository", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "intentcanvas-binding-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "intentcanvas-binding-workspace-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const written = await writeWorkspaceBinding({
    cwd: workspace,
    reviewId: "review-1",
    runtimeUrl: "http://127.0.0.1:4317/"
  }, { home });
  assert.equal(written.reviewId, "review-1");
  assert.equal(written.runtimeUrl, "http://127.0.0.1:4317");
  assert.deepEqual(await readWorkspaceBinding(workspace, { home }), written);
  assert.equal(await readWorkspaceBinding(home, { home }), null);
  await assert.rejects(
    writeWorkspaceBinding({
      cwd: workspace,
      reviewId: "review-1",
      runtimeUrl: "https://untrusted.example"
    }, { home }),
    (error) => error.code === "invalid_workspace_runtime_url"
  );
  assert.deepEqual(await removeWorkspaceBinding(workspace, { home }), written);
  assert.equal(await readWorkspaceBinding(workspace, { home }), null);
  assert.equal(await removeWorkspaceBinding(workspace, { home }), null);
});

test("creates and reuses a private per-user token", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "intentcanvas-auth-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const first = await loadOrCreateAuthToken({ home, env: {} });
  const second = await loadOrCreateAuthToken({ home, env: {} });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.token, first.token);
  assert.equal(await readAuthToken({ home, env: {} }), first.token);
  assert.equal(first.path, resolveAuthTokenFile({ home, env: {} }));
  assert.equal(bearerAuthorization(first.token), `Bearer ${first.token}`);
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, ".intentcanvas"))).mode & 0o777, 0o700);
});

test("uses a validated environment token without creating a file", async () => {
  const token = generateAuthToken();
  const result = await loadOrCreateAuthToken({
    env: { INTENTCANVAS_AUTH_TOKEN: token },
    home: "/unused"
  });
  assert.deepEqual(result, { token, path: null, created: false });
});

test("rejects weak tokens and permissive token files", async (t) => {
  assert.throws(() => validateAuthToken("too-short"), /43-128/);
  const home = await mkdtemp(join(tmpdir(), "intentcanvas-auth-mode-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const created = await loadOrCreateAuthToken({ home, env: {} });
  await chmod(created.path, 0o644);
  await assert.rejects(
    readAuthToken({ home, env: {}, platform: "linux" }),
    (error) => error.code === "insecure_auth_token_file"
  );
});

test("rejects token files outside a private current-user directory", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "intentcanvas-auth-dir-mode-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const created = await loadOrCreateAuthToken({ home, env: {} });
  const directory = join(home, ".intentcanvas");
  await chmod(directory, 0o755);

  await assert.rejects(
    readAuthToken({ home, env: {}, platform: "linux" }),
    (error) => error.code === "insecure_auth_token_directory"
  );
});

test("rejects a token file not owned by the current user", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "intentcanvas-auth-owner-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await loadOrCreateAuthToken({ home, env: {} });
  const metadata = await stat(join(home, ".intentcanvas", "auth-token"));

  await assert.rejects(
    readAuthToken({
      home,
      env: {},
      platform: "linux",
      getuidImpl: () => metadata.uid + 1
    }),
    (error) => error.code === "insecure_auth_token_file"
  );
});

test("rejects symbolic-link token paths", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "intentcanvas-auth-symlink-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const created = await loadOrCreateAuthToken({ home, env: {} });
  const target = join(home, ".intentcanvas", "target-token");
  const link = join(home, ".intentcanvas", "linked-token");
  await rename(created.path, target);
  await symlink(target, link);

  await assert.rejects(
    readAuthToken({ path: link, env: {}, platform: "linux" }),
    (error) => error.code === "invalid_auth_token_file"
  );
});

test("rejects a symbolic-link token directory", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "intentcanvas-auth-dir-link-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const realDirectory = join(home, "real-private-directory");
  const linkedDirectory = join(home, "linked-directory");
  await mkdir(realDirectory, { mode: 0o700 });
  await writeFile(
    join(realDirectory, "auth-token"),
    `${generateAuthToken()}\n`,
    { mode: 0o600 }
  );
  await symlink(realDirectory, linkedDirectory);

  await assert.rejects(
    readAuthToken({ path: join(linkedDirectory, "auth-token"), env: {}, platform: "linux" }),
    (error) => error.code === "invalid_auth_token_directory"
  );
});

test("detects path replacement while metadata and contents stay bound to one descriptor", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "intentcanvas-auth-fd-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const created = await loadOrCreateAuthToken({ home, env: {} });
  const replacementToken = generateAuthToken();
  const replacement = join(home, ".intentcanvas", "replacement-token");
  await writeFile(replacement, `${replacementToken}\n`, { mode: 0o600 });
  let opened = false;

  await assert.rejects(
    readAuthToken({
      path: created.path,
      env: {},
      platform: "linux",
      async openImpl(path, flags) {
        const handle = await open(path, flags);
        opened = true;
        await rename(replacement, path);
        return handle;
      }
    }),
    (error) => error.code === "invalid_auth_token_file"
  );

  assert.equal(opened, true);
  assert.equal(await readAuthToken({ path: created.path, env: {} }), replacementToken);
});
