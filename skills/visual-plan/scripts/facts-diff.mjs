#!/usr/bin/env node

import { dispatch } from "./dispatch.mjs";

process.exitCode = await dispatch(["facts-diff", ...process.argv.slice(2)]);
