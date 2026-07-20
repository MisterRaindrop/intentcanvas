import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function available(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function installedLauncher({
  home = homedir(),
  env = process.env
} = {}) {
  const configuredHome = env.INTENTCANVAS_HOME
    ? resolve(env.INTENTCANVAS_HOME)
    : join(resolve(home), ".intentcanvas");
  try {
    const record = JSON.parse(await readFile(join(configuredHome, "installation.json"), "utf8"));
    if (record?.kind !== "IntentCanvasInstallation" || record.version !== 1 ||
        typeof record.launcher !== "string") return null;
    const launcher = await realpath(record.launcher);
    return await available(launcher) ? launcher : null;
  } catch {
    return null;
  }
}

export async function resolveLauncher(options = {}) {
  const installed = await installedLauncher(options);
  if (installed) return installed;
  const checkout = fileURLToPath(new URL("../../../intentcanvas", import.meta.url));
  if (await available(checkout)) return checkout;
  throw new Error("IntentCanvas is not set up. Run ./intentcanvas setup from its checkout.");
}

export async function dispatch(arguments_, options = {}) {
  const launcher = await resolveLauncher(options);
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl(process.execPath, [launcher, ...arguments_], {
      stdio: "inherit",
      env: options.env ?? process.env
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`IntentCanvas terminated by ${signal}`));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}
