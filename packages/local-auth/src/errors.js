export class LocalAuthError extends Error {
  constructor(code, message, { path, cause } = {}) {
    super(message, { cause });
    this.name = "LocalAuthError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}
