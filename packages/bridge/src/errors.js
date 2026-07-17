export class BridgeError extends Error {
  constructor(code, message, { exitCode = 1, details = [] } = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function asBridgeError(error) {
  if (error instanceof BridgeError) return error;
  return new BridgeError("unexpected_error", "IntentCanvas Bridge could not complete the command");
}
