#!/usr/bin/env node

import { dispatch } from "./dispatch.mjs";

process.exitCode = await dispatch(["diff", ...process.argv.slice(2)]);
