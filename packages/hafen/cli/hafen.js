#!/usr/bin/env node
// hafen, the command line: its commands are in cli/commands.js. Exit codes: 0 everything passed ·
// 1 tests failed (or regressed past --fail-on) · 2 a setup or configuration error · 3 stopped early
// (--max-cost, --bail, or cancelled).

import { err, main } from "./commands.js";

main(process.argv.slice(2)).then(
  (code) => { if (code !== null) process.exitCode = code; },
  (e) => {
    err(e?.stack ?? String(e));
    process.exitCode = 2;
  },
);
