#!/usr/bin/env node

import { runCli } from "../../../apps/cli/src/cli.js";

process.exitCode = await runCli(process.argv.slice(2));
