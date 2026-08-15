#!/usr/bin/env node

import { runCli } from "./run-cli.js";

const exitCode = await runCli(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(line),
  stderr: (line) => process.stderr.write(line),
});
process.exitCode = exitCode;
