function parseConnection(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const match = value.match(/^\s*(\S+)\s+([0-9]+)\s+(\S+)\s+([0-9]+)\s*$/u);
  if (!match) return null;
  const clientPort = Number(match[2]);
  const serverPort = Number(match[4]);
  if (
    !Number.isInteger(clientPort) || clientPort < 1 || clientPort > 65_535 ||
    !Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65_535
  ) {
    return null;
  }
  return {
    clientAddress: match[1],
    clientPort,
    serverAddress: match[3],
    serverPort
  };
}

function parseTmux(value) {
  if (typeof value !== "string" || !value) return null;
  const parts = value.split(",");
  if (parts.length < 3) return null;
  const sessionId = Number(parts.pop());
  const serverPid = Number(parts.pop());
  const socketPath = parts.join(",");
  if (!socketPath || !Number.isInteger(serverPid) || !Number.isInteger(sessionId)) return null;
  return { socketPath, serverPid, sessionId };
}

export function detectEnvironment(env = process.env) {
  const sshActive = typeof env.SSH_CONNECTION === "string" && env.SSH_CONNECTION.length > 0;
  const tmuxActive = typeof env.TMUX === "string" && env.TMUX.length > 0;
  const connection = parseConnection(env.SSH_CONNECTION);
  const session = parseTmux(env.TMUX);

  return {
    location: sshActive ? "remote" : "local",
    isRemote: sshActive,
    isSsh: sshActive,
    isTmux: tmuxActive,
    ssh: {
      active: sshActive,
      connection,
      valid: !sshActive || connection !== null
    },
    tmux: {
      active: tmuxActive,
      session,
      valid: !tmuxActive || session !== null
    },
    tunnel: {
      canCreateForCurrentMachine: !sshActive,
      mustRunOnClient: sshActive
    }
  };
}

export const detectBridgeEnvironment = detectEnvironment;
