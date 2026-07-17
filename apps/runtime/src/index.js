#!/usr/bin/env node

import { RUNTIME_PORT, startRuntime } from "./server.js";

const configuredPort = process.env.INTENTCANVAS_PORT === undefined
  ? RUNTIME_PORT
  : Number(process.env.INTENTCANVAS_PORT);

try {
  const runtime = await startRuntime({ port: configuredPort });
  const shutdown = async () => {
    try {
      await runtime.close();
    } finally {
      process.exitCode = 0;
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGHUP", shutdown);
} catch (error) {
  console.error(`IntentCanvas Runtime failed to start: ${error.message}`);
  process.exitCode = 1;
}
