import { asBridgeError, BridgeError } from "./errors.js";
import { detectEnvironment } from "./environment.js";
import { DEFAULT_RUNTIME_URL, formatReviewLinks } from "./links.js";
import { startSshTunnel } from "./ssh.js";
import {
  normalizeIdentityPath,
  normalizeRuntimeUrl,
  parsePort,
  validateDestination,
  validateReviewId
} from "./validation.js";

export const BRIDGE_VERSION = "0.2.0";

const HELP = `IntentCanvas Bridge ${BRIDGE_VERSION}

Usage:
  intentcanvas-bridge ssh <destination> --review ID [--remote-port 4317] [--local-port 4317] [--ssh-port N] [--identity FILE]
  intentcanvas-bridge link --review ID --handoff TOKEN [--runtime URL]
  intentcanvas-bridge environment

The ssh command must run on the local client machine. It never asks a remote
session to create a tunnel back to the client.
`;

const OPTION_NAMES = new Set([
  "--review",
  "--handoff",
  "--runtime",
  "--remote-port",
  "--local-port",
  "--ssh-port",
  "--identity"
]);

function write(stream, value) {
  stream.write(String(value));
}

function writeLine(stream, value = "") {
  write(stream, `${value}\n`);
}

function parseOptions(argv, allowed) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    if (!OPTION_NAMES.has(option) || !allowed.has(option)) {
      throw new BridgeError("unknown_option", `Unknown option: ${option}`, { exitCode: 2 });
    }
    if (Object.hasOwn(result, option)) {
      throw new BridgeError("duplicate_option", `Option may only be set once: ${option}`, {
        exitCode: 2
      });
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new BridgeError("missing_option_value", `${option} requires a value`, {
        exitCode: 2
      });
    }
    result[option] = value;
  }
  return result;
}

function requireReview(options) {
  if (options["--review"] === undefined) {
    throw new BridgeError("missing_review", "--review is required", { exitCode: 2 });
  }
  return validateReviewId(options["--review"]);
}

function printLinks(stdout, runtime, reviewId, handoff) {
  const links = formatReviewLinks(runtime, reviewId, handoff);
  writeLine(stdout, links.plain);
  writeLine(stdout, links.osc8);
}

function reportError(stderr, error) {
  const normalized = asBridgeError(error);
  writeLine(stderr, JSON.stringify({
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details
    }
  }));
  return normalized.exitCode;
}

function sshConfig(destination, options, dependencies) {
  const remotePort = parsePort(options["--remote-port"] ?? 4_317, "remote_port");
  return {
    destination: validateDestination(destination),
    reviewId: requireReview(options),
    remotePort,
    localPort: parsePort(options["--local-port"] ?? remotePort, "local_port", { allowZero: true }),
    sshPort: options["--ssh-port"] === undefined
      ? undefined
      : parsePort(options["--ssh-port"], "ssh_port"),
    identity: options["--identity"] === undefined
      ? undefined
      : normalizeIdentityPath(options["--identity"], {
        cwd: dependencies.cwd,
        home: dependencies.home
      })
  };
}

export async function runBridgeCli(argv, overrides = {}) {
  const dependencies = {
    env: overrides.env ?? process.env,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    signalSource: overrides.signalSource ?? process,
    startSshTunnel: overrides.startSshTunnel ?? startSshTunnel,
    cwd: overrides.cwd ?? process.cwd(),
    home: overrides.home,
    tunnelDependencies: overrides.tunnelDependencies ?? {}
  };

  try {
    if (argv.length === 0 || (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"))) {
      write(dependencies.stdout, HELP);
      return 0;
    }
    if (argv.length === 1 && argv[0] === "--version") {
      writeLine(dependencies.stdout, BRIDGE_VERSION);
      return 0;
    }

    if (argv[0] === "environment") {
      if (argv.length !== 1) {
        throw new BridgeError(
          "invalid_arguments",
          "Usage: intentcanvas-bridge environment",
          { exitCode: 2 }
        );
      }
      writeLine(dependencies.stdout, JSON.stringify({
        ok: true,
        environment: detectEnvironment(dependencies.env)
      }));
      return 0;
    }

    if (argv[0] === "link") {
      const options = parseOptions(
        argv.slice(1),
        new Set(["--review", "--runtime", "--handoff"])
      );
      const reviewId = requireReview(options);
      if (options["--handoff"] === undefined) {
        throw new BridgeError(
          "missing_handoff",
          "--handoff is required; generate a fresh one with intentcanvas plan open",
          { exitCode: 2 }
        );
      }
      const runtime = normalizeRuntimeUrl(options["--runtime"] ?? DEFAULT_RUNTIME_URL);
      printLinks(dependencies.stdout, runtime, reviewId, options["--handoff"]);
      return 0;
    }

    if (argv[0] === "ssh") {
      if (argv.length < 2) {
        throw new BridgeError(
          "missing_destination",
          "ssh requires a destination",
          { exitCode: 2 }
        );
      }
      const environment = detectEnvironment(dependencies.env);
      if (environment.isRemote) {
        throw new BridgeError(
          "remote_tunnel_not_supported",
          "Run intentcanvas-bridge ssh on the local client; a remote session cannot create a client-local tunnel",
          { exitCode: 2, details: [{ environment }] }
        );
      }
      const options = parseOptions(
        argv.slice(2),
        new Set(["--review", "--remote-port", "--local-port", "--ssh-port", "--identity"])
      );
      const config = sshConfig(argv[1], options, dependencies);
      const tunnel = await dependencies.startSshTunnel(config, {
        ...dependencies.tunnelDependencies,
        signalSource: dependencies.signalSource
      });
      writeLine(
        dependencies.stdout,
        `Tunnel ready: http://127.0.0.1:${tunnel.localPort} -> remote Runtime ${config.remotePort}`
      );
      if (tunnel.localPort === config.remotePort) {
        writeLine(
          dependencies.stdout,
          `In the remote terminal run: intentcanvas plan open ${config.reviewId}`
        );
        writeLine(dependencies.stdout, "Then click the fresh link printed there.");
      } else {
        writeLine(
          dependencies.stdout,
          "The local and remote ports differ; rewrite the fresh remote link to the local port above."
        );
      }
      const result = await tunnel.wait();
      return result.code;
    }

    throw new BridgeError(
      "unknown_command",
      "Unknown command. Run intentcanvas-bridge --help",
      { exitCode: 2 }
    );
  } catch (error) {
    return reportError(dependencies.stderr, error);
  }
}
