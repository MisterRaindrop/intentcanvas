import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFilePromise = promisify(nodeExecFile);

async function readGitValue(projectRoot, arguments_, execFileImpl) {
  try {
    const result = await execFileImpl(
      "git",
      ["--no-optional-locks", "-C", projectRoot, ...arguments_],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024,
        timeout: 2_000,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0"
        }
      }
    );
    const value = String(result.stdout ?? "").trim();
    return value.length > 0 && value.length <= 4096 ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function discoverGitIdentity(projectRoot, {
  execFileImpl = execFilePromise
} = {}) {
  const [repository, baseRef] = await Promise.all([
    readGitValue(projectRoot, ["config", "--get", "remote.origin.url"], execFileImpl),
    readGitValue(projectRoot, ["rev-parse", "HEAD"], execFileImpl)
  ]);
  return {
    ...(repository === undefined ? {} : { repository }),
    ...(baseRef === undefined ? {} : { baseRef })
  };
}
