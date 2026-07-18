import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTdePlanFixture } from "@intentcanvas/protocol";
import {
  JsonFileReviewPersistence,
  RuntimeDataDirectoryLock,
  RuntimePersistenceError,
  SerializedReviewWriter
} from "../src/persistence.js";
import { ReviewStore } from "../src/review-store.js";

test("JsonFileReviewPersistence round-trips a Runtime snapshot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "intentcanvas-persistence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const persistence = new JsonFileReviewPersistence(directory);
  const state = new ReviewStore([createTdePlanFixture()]).exportState();

  await persistence.save(state);
  assert.deepEqual(await persistence.load(), state);
  assert.match(await readFile(join(directory, "state.json"), "utf8"), /IntentCanvasRuntimeState/);
});

test("JsonFileReviewPersistence diagnoses corrupt JSON without replacing it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "intentcanvas-persistence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const persistence = new JsonFileReviewPersistence(directory);
  const corruptBody = "{ broken";
  await writeFile(persistence.statePath, corruptBody, "utf8");

  await assert.rejects(
    persistence.load(),
    (error) => error instanceof RuntimePersistenceError &&
      error.code === "corrupt_runtime_state" &&
      error.message.includes("not overwritten")
  );
  assert.equal(await readFile(persistence.statePath, "utf8"), corruptBody);
});

test("directory fsync failure after rename reports committed and keeps memory and disk aligned", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "intentcanvas-persistence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const persistence = new JsonFileReviewPersistence(directory, {
    async syncDirectoryImpl() {
      const error = new Error("simulated directory fsync failure");
      error.code = "EIO";
      throw error;
    }
  });
  const store = new ReviewStore([createTdePlanFixture()]);
  const writer = new SerializedReviewWriter(store, persistence);

  await persistence.save(store.exportState());
  await writer.mutate((candidate) => candidate.submitDecision(
    "doris-tde-demo",
    { moduleId: "write-path", decision: "approved", expectedRevision: 1 }
  ));

  const diskState = await persistence.load();
  assert.deepEqual(diskState, store.exportState());
  assert.equal(
    store.getReview("doris-tde-demo").modules.find((module) => module.id === "write-path")
      .approval.decision,
    "approved"
  );
  const outcome = await persistence.save(store.exportState());
  assert.equal(outcome.committed, true);
  assert.equal(outcome.directorySynced, false);
  assert.equal(outcome.warning.code, "persistence_directory_sync_failed");
});

test("RuntimeDataDirectoryLock excludes another live owner and releases ownership", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "intentcanvas-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = new RuntimeDataDirectoryLock(directory, {
    pid: 41001,
    killImpl(pid) {
      assert.equal(pid, 41001);
    },
    randomUUIDImpl: () => "first-owner"
  });
  await first.acquire();

  const second = new RuntimeDataDirectoryLock(directory, {
    pid: 41002,
    killImpl(pid) {
      if (pid === 41001) return;
      const error = new Error("not found");
      error.code = "ESRCH";
      throw error;
    },
    randomUUIDImpl: () => "second-owner"
  });
  await assert.rejects(
    second.acquire(),
    (error) => error instanceof RuntimePersistenceError &&
      error.code === "runtime_data_directory_locked" &&
      error.status === 409
  );

  assert.equal(await first.release(), true);
  await assert.rejects(access(first.lockPath), (error) => error.code === "ENOENT");
  await second.acquire();
  assert.equal(await second.release(), true);
  assert.equal(await second.release(), false);
});

test("RuntimeDataDirectoryLock fails closed on a stale PID lock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "intentcanvas-lock-stale-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockPath = join(directory, "runtime.lock");
  await writeFile(lockPath, `${JSON.stringify({
    version: 1,
    pid: 32001,
    nonce: "dead-owner",
    createdAt: "2026-01-01T00:00:00.000Z"
  })}\n`, { mode: 0o600 });

  const replacement = new RuntimeDataDirectoryLock(directory, {
    pid: 32002,
    killImpl(pid) {
      assert.equal(pid, 32001);
      const error = new Error("not found");
      error.code = "ESRCH";
      throw error;
    },
    randomUUIDImpl: () => "replacement-owner"
  });
  await assert.rejects(
    replacement.acquire(),
    (error) => error instanceof RuntimePersistenceError &&
      error.code === "stale_runtime_data_directory_lock" && error.status === 409
  );
  const record = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(record.pid, 32001);
  assert.equal(record.nonce, "dead-owner");
});

test("SerializedReviewWriter serializes writes and enforces decision revision CAS", async () => {
  const store = new ReviewStore([createTdePlanFixture()]);
  let activeSaves = 0;
  let maximumActiveSaves = 0;
  const savedStates = [];
  const persistence = {
    async save(state) {
      activeSaves += 1;
      maximumActiveSaves = Math.max(maximumActiveSaves, activeSaves);
      await new Promise((resolve) => setImmediate(resolve));
      savedStates.push(structuredClone(state));
      activeSaves -= 1;
    }
  };
  const writer = new SerializedReviewWriter(store, persistence);

  const first = writer.mutate((candidate) => candidate.submitDecision(
    "doris-tde-demo",
    { moduleId: "key-management", decision: "approved", expectedRevision: 1 }
  ));
  const second = writer.mutate((candidate) => candidate.submitDecision(
    "doris-tde-demo",
    { moduleId: "write-path", decision: "approved", expectedRevision: 1 }
  ));
  const [firstResult, secondResult] = await Promise.allSettled([first, second]);
  assert.equal(firstResult.status, "fulfilled");
  assert.equal(secondResult.status, "rejected");
  assert.equal(secondResult.reason.code, "stale_review_revision");
  await writer.mutate((candidate) => candidate.submitDecision(
    "doris-tde-demo",
    { moduleId: "write-path", decision: "approved", expectedRevision: 2 }
  ));

  assert.equal(maximumActiveSaves, 1);
  assert.equal(savedStates.length, 2);
  assert.equal(
    store.getReview("doris-tde-demo").modules.find((module) => module.id === "key-management")
      .approval.decision,
    "approved"
  );
  assert.equal(
    store.getReview("doris-tde-demo").modules.find((module) => module.id === "write-path")
      .approval.decision,
    "approved"
  );
});

test("SerializedReviewWriter does not commit a failed persistence write", async () => {
  const store = new ReviewStore([createTdePlanFixture()]);
  const writer = new SerializedReviewWriter(store, {
    async save() {
      throw new RuntimePersistenceError("disk full", {
        code: "persistence_write_failed",
        path: "/tmp/state.json"
      });
    }
  });

  await assert.rejects(
    writer.mutate((candidate) => candidate.submitDecision(
      "doris-tde-demo",
      { moduleId: "write-path", decision: "approved", expectedRevision: 1 }
    )),
    (error) => error.code === "persistence_write_failed"
  );
  assert.equal(
    store.getReview("doris-tde-demo").modules.find((module) => module.id === "write-path")
      .approval.decision,
    "pending"
  );
});
