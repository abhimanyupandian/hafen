#!/usr/bin/env node
// `npm run serve` (node server/serve.js; research §25): the browser build (app/dist, made by `npm run
// build`) and its relay (relay.js), at http://127.0.0.1:8790. The relay calls only the endpoints it's
// allowed: each --allow-endpoint <url> (a prefix), and HAFEN_ENDPOINTS (a comma-separated list). It's
// the app's, not the hafen package's: it serves the app's build.
//
//   node server/serve.js [--port 8790] [--host 127.0.0.1] [--allow-endpoint <url>]…
//
// Exit 2: a setup error (an option that isn't one, a port that's taken or isn't one), said plainly.

import { parseArgs } from "node:util";
import { serve } from "./relay.js";

const USAGE = "npm run serve -- [--port 8790] [--host 127.0.0.1] [--allow-endpoint <url>]…   (node server/serve.js …)";
const OPTIONS = {
  port: { type: "string" },
  host: { type: "string" },
  "allow-endpoint": { type: "string", multiple: true },
  help: { type: "boolean", short: "h" },
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const red = (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s);
const fail = (message) => {
  process.stderr.write(`${red(message)}\n`);
  process.exitCode = 2;
};

// --port's value: a whole number from 0 to 65535, or a setup error (never NaN taken as a port)
function portOption(raw) {
  const n = Number(raw);
  if (String(raw).trim() === "" || !Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`--port takes a whole number from 0 to 65535, not "${raw}"`);
  return n;
}

async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS }));
  } catch (e) {
    // An option that isn't one, or one missing its value: said plainly (no stack trace)
    return fail(`${e.message.split(". ")[0].replace(/\.$/, "")}\n\n${USAGE}`);
  }
  if (values.help) return void process.stdout.write(`${USAGE}\n`);
  let port;
  try {
    port = portOption(values.port ?? "8790");
  } catch (e) {
    return fail(e.message);
  }
  const allow = [...(values["allow-endpoint"] ?? []), ...(process.env.HAFEN_ENDPOINTS ?? "").split(",").map((e) => e.trim()).filter(Boolean)];
  try {
    // (it keeps running)
    await serve({ port, host: values.host ?? "127.0.0.1", allow });
  } catch (e) {
    fail(e.message);
  }
}

main(process.argv.slice(2));
