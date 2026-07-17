import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { ReviewStore } from "./review-store.js";

export const RUNTIME_STATE_FILE = "state.json";
export const RUNTIME_LOCK_FILE = "runtime.lock";

export class RuntimePersistenceError extends Error {
  constructor(message, { code = "persistence_error", path, cause, status = 500 } = {}) {
    super(message, { cause });
    this.name = "RuntimePersistenceError";
    this.code = code;
    this.status = status;
    this.path = path;
  }
}

export function resolveDataDirectory(
  configuredDirectory = process.env.INTENTCANVAS_DATA_DIR
) {
  return typeof configuredDirectory === "string" && configuredDirectory.trim().length > 0
    ? resolve(configuredDirectory)
    : resolve(process.cwd(), ".intentcanvas", "runtime");
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Some filesystems do not support fsync on directories. The file itself was
    // still synced before rename, so only ignore the documented platform errors.
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

export class JsonFileReviewPersistence {
  constructor(directory = resolveDataDirectory(), { syncDirectoryImpl = syncDirectory } = {}) {
    if (typeof directory !== "string" || directory.trim().length === 0) {
      throw new TypeError("data directory must be a non-empty string");
    }
    this.directory = resolve(directory);
    this.statePath = resolve(this.directory, RUNTIME_STATE_FILE);
    this.syncDirectoryImpl = syncDirectoryImpl;
  }

  async load() {
    let body;
    try {
      body = await readFile(this.statePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new RuntimePersistenceError(
        `Unable to read IntentCanvas Runtime state at ${this.statePath}: ${error.message}`,
        { code: "persistence_read_failed", path: this.statePath, cause: error }
      );
    }

    try {
      return JSON.parse(body);
    } catch (error) {
      throw new RuntimePersistenceError(
        `IntentCanvas Runtime state at ${this.statePath} is corrupted; ` +
          "fix or move the file before restarting (it was not overwritten)",
        { code: "corrupt_runtime_state", path: this.statePath, cause: error }
      );
    }
  }

  async save(state) {
    const body = `${JSON.stringify(state, null, 2)}\n`;
    const temporaryPath = resolve(
      this.directory,
      `.${RUNTIME_STATE_FILE}.${process.pid}.${randomUUID()}.tmp`
    );
    let handle;

    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(body, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.statePath);
    } catch (error) {
      try {
        await handle?.close();
      } catch {
        // Preserve the original write error.
      }
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") {
          // The primary error remains more useful than a temporary-file cleanup error.
        }
      }
      if (error instanceof RuntimePersistenceError) throw error;
      throw new RuntimePersistenceError(
        `Unable to persist IntentCanvas Runtime state at ${this.statePath}: ${error.message}`,
        { code: "persistence_write_failed", path: this.statePath, cause: error }
      );
    }

    // rename() is the commit point: after it succeeds, state.json contains the
    // new snapshot and SerializedReviewWriter must be allowed to commit the same
    // snapshot in memory. Directory fsync only strengthens crash durability. A
    // failure there must not report the write as uncommitted and create a
    // memory/disk split-brain.
    try {
      await this.syncDirectoryImpl(this.directory);
      return { committed: true, directorySynced: true };
    } catch (error) {
      return {
        committed: true,
        directorySynced: false,
        warning: new RuntimePersistenceError(
          `IntentCanvas Runtime state was committed at ${this.statePath}, but the data directory could not be synced`,
          { code: "persistence_directory_sync_failed", path: this.directory, cause: error }
        )
      };
    }
  }
}

async function readLockRecord(lockPath) {
  let handle;
  try {
    handle = await open(lockPath, "r");
    const metadata = await handle.stat();
    const body = await handle.readFile("utf8");
    return { metadata, record: JSON.parse(body) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new RuntimePersistenceError(
        `IntentCanvas Runtime lock is invalid at ${lockPath}`,
        { code: "invalid_runtime_lock", path: lockPath, cause: error }
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function processIsAlive(pid, killImpl) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/**
 * Cross-process ownership primitive for one Runtime data directory.
 *
 * Acquisition publishes a fully-written claim through an atomic hard link, so
 * another process never observes a partially-written canonical lock. A stale
 * dead-PID lock fails closed instead of being removed through an unsafe
 * read-then-unlink race; release verifies the unguessable nonce.
 */
export class RuntimeDataDirectoryLock {
  constructor(directory = resolveDataDirectory(), {
    pid = process.pid,
    killImpl = process.kill.bind(process),
    randomUUIDImpl = randomUUID,
    now = () => new Date().toISOString()
  } = {}) {
    if (typeof directory !== "string" || directory.trim().length === 0) {
      throw new TypeError("data directory must be a non-empty string");
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new TypeError("pid must be a positive safe integer");
    }
    this.directory = resolve(directory);
    this.lockPath = resolve(this.directory, RUNTIME_LOCK_FILE);
    this.pid = pid;
    this.killImpl = killImpl;
    this.nonce = randomUUIDImpl();
    this.createdAt = now();
    this.acquired = false;
  }

  async acquire() {
    if (this.acquired) return this;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });

    for (let attempt = 0; attempt < 1; attempt += 1) {
      const claimPath = resolve(
        this.directory,
        `.${RUNTIME_LOCK_FILE}.${this.pid}.${this.nonce}.${attempt}.claim`
      );
      let claimHandle;
      try {
        claimHandle = await open(claimPath, "wx", 0o600);
        await claimHandle.writeFile(`${JSON.stringify({
          version: 1,
          pid: this.pid,
          nonce: this.nonce,
          createdAt: this.createdAt
        })}\n`, "utf8");
        await claimHandle.sync();
        await claimHandle.close();
        claimHandle = undefined;
        await link(claimPath, this.lockPath);
        this.acquired = true;
        return this;
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw new RuntimePersistenceError(
            `Unable to acquire IntentCanvas Runtime data lock at ${this.lockPath}: ${error.message}`,
            { code: "runtime_lock_acquire_failed", path: this.lockPath, cause: error }
          );
        }

        const current = await readLockRecord(this.lockPath);
        if (current && processIsAlive(current.record?.pid, this.killImpl)) {
          throw new RuntimePersistenceError(
            `IntentCanvas Runtime data directory is already owned by PID ${current.record.pid}: ${this.directory}`,
            {
              code: "runtime_data_directory_locked",
              path: this.lockPath,
              status: 409
            }
          );
        }
        throw new RuntimePersistenceError(
          `IntentCanvas Runtime found a stale data lock for dead PID ${String(current?.record?.pid)}: ` +
            `${this.lockPath}. Verify no Runtime uses this directory, then remove that lock file.`,
          {
            code: "stale_runtime_data_directory_lock",
            path: this.lockPath,
            status: 409
          }
        );
      } finally {
        try {
          await claimHandle?.close();
        } catch {
          // Preserve the acquisition result/error.
        }
        try {
          await unlink(claimPath);
        } catch (cleanupError) {
          if (cleanupError?.code !== "ENOENT") {
            // A leftover private claim does not grant ownership. The canonical
            // lock remains authoritative and future acquisitions are unaffected.
          }
        }
      }
    }

    throw new RuntimePersistenceError(
      `Unable to acquire IntentCanvas Runtime data lock: ${this.lockPath}`,
      { code: "runtime_lock_acquire_failed", path: this.lockPath }
    );
  }

  async release() {
    if (!this.acquired) return false;
    const current = await readLockRecord(this.lockPath);
    if (!current || current.record?.nonce !== this.nonce || current.record?.pid !== this.pid) {
      this.acquired = false;
      return false;
    }
    try {
      await unlink(this.lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new RuntimePersistenceError(
          `Unable to release IntentCanvas Runtime data lock at ${this.lockPath}: ${error.message}`,
          { code: "runtime_lock_release_failed", path: this.lockPath, cause: error }
        );
      }
    }
    this.acquired = false;
    return true;
  }
}

export async function acquireRuntimeDataDirectoryLock(directory, options) {
  const lock = new RuntimeDataDirectoryLock(directory, options);
  return lock.acquire();
}

export class SerializedReviewWriter {
  #tail = Promise.resolve();

  constructor(store, persistence = null) {
    if (!(store instanceof ReviewStore)) {
      throw new TypeError("store must be a ReviewStore");
    }
    this.store = store;
    this.persistence = persistence;
  }

  mutate(operation) {
    const execute = async () => {
      const candidate = ReviewStore.fromState(this.store.exportState(), {
        eventLimit: this.store.eventLimit,
        revisionLimit: this.store.revisionLimit
      });
      const result = await operation(candidate);
      const nextState = candidate.exportState();

      if (this.persistence) await this.persistence.save(nextState);
      this.store.restoreState(nextState);
      return result;
    };

    const task = this.#tail.then(execute, execute);
    this.#tail = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }
}
