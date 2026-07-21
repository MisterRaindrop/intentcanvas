# `@intentcanvas/bridge`

`@intentcanvas/bridge` is the dependency-free, local-only SSH bridge for an
IntentCanvas Runtime. It requires Node.js 22 or newer.

## Commands

Open an SSH local forward and keep it alive until `ssh` exits:

```sh
intentcanvas-bridge ssh build-host --review review-123
intentcanvas-bridge ssh user@build-host --review review-123 \
  --remote-port 4317 --ssh-port 22 --identity ~/.ssh/id_ed25519
```

The local port defaults to the same value as the remote Runtime port (4317), so
a URL printed inside the remote terminal opens correctly on the client. After
the Bridge reports readiness, run this in the remote session and click its
five-minute one-use link:

```sh
intentcanvas plan open review-123
```

Both sides of the forward are pinned to `127.0.0.1`. `--local-port 0` remains
an advanced fallback, but the port in the fresh remote link must then be
rewritten to the selected local port.

Format a link only when an integration already has a fresh 43-character
Runtime browser handoff:

```sh
intentcanvas-bridge link --review review-123 --handoff <runtime-browser-handoff>
```

The Bridge cannot mint this handoff for a remote Runtime because the private
Runtime credential deliberately stays on the remote host. In normal use,
prefer `intentcanvas plan open` instead of the `link` command.

Inspect SSH/tmux context as structured JSON:

```sh
intentcanvas-bridge environment
```

The `ssh` command deliberately refuses to run when `SSH_CONNECTION` indicates
that the Bridge itself is already on a remote machine. A server-side process
cannot create a listening port on the user's local client; run the command on
the client instead.

## Experimental transport proof tokens

The package also exports a versioned HMAC-SHA256 transport proof API for a
future desktop host:

```js
import { createHandoffToken, verifyHandoffToken } from "@intentcanvas/bridge";

const token = createHandoffToken(
  { reviewId: "review-123", host: "127.0.0.1", port: 4317 },
  { secret: secretBytes, ttlSeconds: 60 }
);

const claims = verifyHandoffToken(token, {
  secret: secretBytes,
  expected: { reviewId: "review-123", host: "127.0.0.1", port: 4317 }
});
```

These `v1.<payload>.<mac>` proofs are not Runtime browser handoffs and cannot be
passed to `intentcanvas-bridge link` or `/api/session`. Secrets must contain at least 32 bytes. Proofs use the
`v1.<base64url-payload>.<base64url-mac>` format, live for 60 seconds by
default, and may not live for more than five minutes. The verifier checks the
MAC with `timingSafeEqual`, expiration, version, and optional expected request
binding. Neither the CLI nor the token API logs a token or secret.

## Programmatic SSH API

`buildSshArgs`, `findAvailableLocalPort`, `probeTcpPort`, and
`startSshTunnel` are exported. `startSshTunnel(options, dependencies)` accepts
injected `spawn`, port allocation, port checking, probing, clock, timer, and
signal-source implementations. Tests and callers can therefore exercise the
complete lifecycle without starting a real SSH client.
