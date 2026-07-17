#!/usr/bin/env node

import { runBridgeCli } from "../src/cli.js";

process.exitCode = await runBridgeCli(process.argv.slice(2));
