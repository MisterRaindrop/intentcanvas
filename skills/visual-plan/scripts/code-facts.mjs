#!/usr/bin/env node

import { runCli } from "../../../packages/code-facts/src/cli.js";

process.exitCode = await runCli(process.argv.slice(2));
