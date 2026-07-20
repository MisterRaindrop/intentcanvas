#!/usr/bin/env node

import { dispatch } from "./dispatch.mjs";

process.exitCode = await dispatch(["facts", ...process.argv.slice(2)]);
