// hafen's commands (cli/hafen.js runs them): run suites in CI (or anywhere) with the same engine as the
// app; validate them without sending anything; write reports from a run file; compare two runs; pack
// suites, with everything they need, into one file that runs them with Node alone (cli/pack.js; a pack
// runs these same commands, cli/pack-runtime.js). The contract: spec/001-hafen/contracts/cli.md in
// Hafen's repository. (Serving the browser build with its relay is the app's: npm run serve there.)
//
// An environment's values and the secrets come from KEY=VALUE files anywhere on the disk, named on
// the command line (--env <file>, --secret <file>): read here, not through the host (which reads only
// in the project), and passed to the engine.
//
// Exit codes: 0 everything passed · 1 tests failed (or regressed past --fail-on) · 2 a setup or
// configuration error (or, after a run that passed, a report that couldn't be written) · 3 stopped
// early (--max-cost, --bail, or cancelled).

import { access, appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants, existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  compareRuns, jsonSummary, junit, loadSuite, markdown, parseEnvText, parseRun, runFileName, runSuites, serializeRun, SUITE_FILE,
} from "../engine/index.js";
import { money } from "../engine/reports/markdown.js";
import { preflight } from "../engine/runner.js";
import { createRedactor, REDACT_PATTERNS } from "../engine/redact.js";
import { fromRoot, nodeHost, secretsFrom, VERSION } from "./node-host.js";

const EXIT = { ok: 0, failed: 1, setup: 2, stopped: 3 };
const REPORT_FORMATS = ["junit", "run", "md", "json"];
// Where a run file goes with no --report
const RUNS = ".hafen/runs";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const dim = paint(2);

const sec = (ms) => (ms === undefined ? "—" : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);

const HELP = `hafen ${VERSION}: end-to-end tests for chat endpoints

  hafen run [paths…] [options]       run suites (files or folders; default: the current folder)
  hafen validate [paths…] [options]  check suites against the schema; sends nothing
  hafen report <run-file> --report <format>:<path>
  hafen compare <run-file> --baseline <run-file> [--fail-on …]
  hafen pack [paths…] -o <file.mjs>   pack suites and everything they need (providers, data, plugins
                                     with their imports, hafen itself) into one file that runs them
                                     anywhere with Node 22: node <file.mjs> run --env staging.env

Options for run: --test, --tag, --env <file|name>, --secret <file>, --var name=value, --repeat,
  --unsure pass|warn|fail, --max-cost <usd>, --bail, --timeout <ms>, --report <junit|run|md|json>:<path|->,
  --baseline <run-file>, --fail-on pass_rate=<points>,p95=<percent>,cost=<percent>, --load,
  --network delay=<ms>,jitter=<ms>,kbps=<n>,drop=<rate>, --redact email,card,phone, --quiet, --verbose, --no-color
Options for validate: --env <file|name>, --secret <file>, --var name=value, --env-check (every secret
  set), --quiet
Environments and secrets: KEY=VALUE files, anywhere on the disk
  --env ./staging.env              {{env.NAME}}: its values. Its name, staging, picks each suite's
                                   environment of that name (--env staging: only that)
  --secret ./staging.secrets.env   {{secret.NAME}}: its values, else the environment variable NAME
                                   (also --secrets). Never printed, nor in a report
What runs at once: suites and tests by their group (group: 2 in the file); the same group one after
  another, different groups at the same time; none is one group.
Exit codes: 0 passed · 1 failed · 2 setup error · 3 stopped early`;

// The options every command takes (each command uses its own)
const OPTIONS = {
  test: { type: "string", multiple: true },
  tag: { type: "string", multiple: true },
  env: { type: "string" },
  secret: { type: "string", multiple: true },
  secrets: { type: "string", multiple: true },
  var: { type: "string", multiple: true },
  repeat: { type: "string" },
  unsure: { type: "string" },
  "max-cost": { type: "string" },
  bail: { type: "boolean" },
  timeout: { type: "string" },
  report: { type: "string", multiple: true },
  baseline: { type: "string" },
  "fail-on": { type: "string" },
  load: { type: "boolean" },
  network: { type: "string" },
  redact: { type: "string" },
  quiet: { type: "boolean" },
  verbose: { type: "boolean" },
  "no-color": { type: "boolean" },
  "env-check": { type: "boolean" },
  out: { type: "string", short: "o" },
};

// A packed run's host (cli/pack-runtime.js): its files are the pack's, not the disk's
let packHost = null;

// `hafen serve` served the browser build with its relay: that's the app's now (it serves the app's
// build), in Hafen's repository
const SERVE_MOVED = "hafen serve is the Hafen app's now: in Hafen's repository, npm run serve -- --allow-endpoint <url> serves the browser build and its relay";

// argv: the command and its options. pack: in a packed run, its host and its help ({ host, help })
export async function main(argv, pack = null) {
  packHost = pack?.host ?? null;
  const [command, ...rest] = argv;
  if (pack && (!command || command === "--help" || command === "-h" || command === "help")) return out(pack.help), EXIT.ok;
  if (pack && (command === "serve" || command === "pack")) {
    err(red(`a pack runs its suites (run, validate, report, compare, info): ${command === "serve" ? "serve is the Hafen app's (npm run serve in its repository)" : "pack needs hafen itself"}`));
    return EXIT.setup;
  }
  if (!command || command === "--help" || command === "-h" || command === "help") return out(HELP), EXIT.ok;
  if (command === "--version" || command === "-v") return out(VERSION), EXIT.ok;
  // (before its options are read: they're the app's server's, not hafen's)
  if (command === "serve") return err(red(SERVE_MOVED)), EXIT.setup;
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS });
  } catch (e) {
    // An option that isn't one, or one missing its value: said plainly (no stack trace), exit 2
    if (rest.some((a) => /^--concurrency(=|$)/.test(a))) err(red("--concurrency is no longer used: suites and tests run by their group (group: in the file), the same group one after another, different groups at the same time"));
    else err(red(`${e.message.split(". ")[0].replace(/\.$/, "")}\n\n${HELP}`));
    return EXIT.setup;
  }
  const { values, positionals } = parsed;
  switch (command) {
    case "run": return run(positionals, values);
    case "validate": return validate(positionals, values);
    case "report": return report(positionals, values);
    case "compare": return compare(positionals, values);
    case "pack": {
      const { pack: packSuites } = await import("./pack.js");
      return packSuites(positionals, values, { cliHost, findSuites, out, err, red, dim, green });
    }
    default:
      err(`unknown command "${command}"\n\n${HELP}`);
      return EXIT.setup;
  }
}

export const out = (s) => process.stdout.write(`${s}\n`);
export const err = (s) => process.stderr.write(`${s}\n`);

// The suite files the paths name (files, or folders searched for *.hafen.yml|yaml|json; a folder
// outside the current one too)
async function findSuites(host, paths) {
  if (host.findSuites) return host.findSuites(paths);
  const root = host.root;
  const found = [];
  for (const p of paths.length ? paths : ["."]) {
    const rel = fromRoot(root, p);
    if (SUITE_FILE.test(rel) && (await host.files.exists(rel))) found.push(rel);
    else if (await host.files.exists(rel === "" ? "." : rel)) found.push(...(await host.list(resolve(root, rel || "."))).filter((f) => SUITE_FILE.test(f)));
    else throw Object.assign(new Error(`${p} doesn't exist`), { setup: true });
  }
  return [...new Set(found)].sort();
}

// A host for the command line: files are read in the current folder, and in the project of each path
// it names outside it (the nearest folder above the path with a .git or a package.json, else the
// path's own folder), so a suite there reaches its providers and data, and nothing beyond its project
function projectOf(dir) {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, ".git")) || existsSync(join(at, "package.json"))) return at;
    if (dirname(at) === at) return dir;
  }
}
const cliHost = (paths = [], secrets = undefined) => nodeHost({ also: paths.map((p) => resolve(p)).map((p) => projectOf(SUITE_FILE.test(p) ? dirname(p) : p)), ...(secrets ? { secrets } : {}) });

// The host for run and validate: the command line's (or a pack's), its secrets from the secrets
// file first, then the environment's variables
const hostFor = (paths, secrets) => (packHost ? { ...packHost, secrets: secretsFrom(secrets) } : cliHost(paths, secretsFrom(secrets)));

// --env's value is a KEY=VALUE file when it looks like a path (a / or \ in it, or it ends in .env)
// or a file of that name exists; else it names the suites' environment (contracts/cli.md)
export const isEnvFile = (value) => /[\\/]/.test(value) || /\.env$/i.test(value) || isFile(value);
const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
// An environment file's name: its file's, without its extension (staging.env: staging; .env: env)
export const envFileName = (path) => {
  const name = basename(path).replace(/^\.+/, "");
  return name.replace(/\.[^.]*$/, "") || name;
};

// --env and --secret (or --secrets): { env, environment, secrets }. env: the environment's name;
// environment: { name, values } when --env is a file; secrets: the secrets file's { NAME: value } ({}
// without one). A file that doesn't exist or can't be read, or that has a line that isn't NAME=value,
// is a setup error (its problems, each at its file:line:column, as `problems`).
export async function environmentOptions(values) {
  const secretFiles = [...(values.secret ?? []), ...(values.secrets ?? [])];
  if (secretFiles.length > 1) throw Object.assign(new Error(`--secret takes one file, not ${secretFiles.length} (${secretFiles.join(", ")})`), { setup: true });
  const secrets = secretFiles.length ? await readValues(secretFiles[0], "the secrets file", { secret: true }) : {};
  if (values.env === undefined || !isEnvFile(values.env)) return { env: values.env, secrets, secretFile: secretFiles[0] };
  const name = envFileName(values.env);
  return { env: name, environment: { name, values: await readValues(values.env, "the environment file") }, secrets, secretFile: secretFiles[0] };
}

// Where the CLI looks for a secret, as a missing one says (the engine's "for the scope" is the app's)
const secretsWhere = (given) => (given.secretFile ? "not in the --secret file or the environment" : "not in the environment: set it, or pass --secret <file>");

// A KEY=VALUE file's values (engine/env-file.js), read from the disk, wherever it is. A secrets file's
// problems never show what's in its lines: a name that isn't one, or what follows a quoted value,
// could be part of a secret.
async function readValues(path, what, { secret = false } = {}) {
  const file = shown(resolve(path));
  let text;
  try {
    text = await readFile(resolve(path), "utf8");
  } catch (e) {
    const why = e.code === "ENOENT" || e.code === "ENOTDIR" ? "doesn't exist" : `can't be read: ${e.code === "EISDIR" ? "it's a folder" : reasonOf(e).replace(/, \w+ '.*'$/, "")}`;
    throw Object.assign(new Error(`${what} ${file} ${why}`), { setup: true });
  }
  const { values, errors } = parseEnvText(text, file);
  if (!errors.length) return values;
  const unquoted = (message) => message.replace(/^".*" isn't a name/, "that isn't a name").replace(/^(after a quoted value, only a # comment): not .*$/, "$1");
  const problems = errors.map((p) => (secret ? { ...p, message: unquoted(p.message) } : p));
  throw Object.assign(new Error(`${what} ${file} has ${plural(problems.length, "problem")}`), { setup: true, problems });
}

// A setup error, said: each of its problems at its file:line:column, then how many (and `then`), or
// its message
function saySetup(e, then = "") {
  if (!e.problems) return err(red(e.message));
  for (const p of e.problems) err(`${red(location(p))}  ${p.message}`);
  err(red(`\n${plural(e.problems.length, "problem")}${then}`));
}

// What a secrets file holds, hidden wherever it would show (the output, every report and run file), as
// the engine hides each secret it fills in: so a value of it a suite didn't ask for is hidden too (a
// reply that has it). null: nothing to hide.
function secretsHider(secrets) {
  const found = Object.values(secrets).filter((v) => v !== "");
  return found.length ? createRedactor({ secrets: new Set(found) }) : null;
}

function parseVars(list = []) {
  return Object.fromEntries(list.map((kv) => {
    const at = kv.indexOf("=");
    if (at < 1) throw Object.assign(new Error(`--var takes name=value, not "${kv}"`), { setup: true });
    return [kv.slice(0, at), kv.slice(at + 1)];
  }));
}

function parseProfile(text, keys) {
  if (!text) return undefined;
  const outObj = {};
  for (const part of text.split(",")) {
    const [k, v] = part.split("=");
    const key = keys[k.trim()];
    if (!key || v === undefined || v.trim() === "" || !Number.isFinite(Number(v))) throw Object.assign(new Error(`can't read "${part}" (expected ${Object.keys(keys).join(", ")} as name=number)`), { setup: true });
    outObj[key] = Number(v);
  }
  return outObj;
}

// --network's profile, each value in its range (a drop rate of 5, or 0 kbps, is a configuration
// error, not a profile that does something else)
const NETWORK = {
  delay: ["delay_ms", (n) => n >= 0, "milliseconds (0 or more)"],
  jitter: ["jitter_ms", (n) => n >= 0, "milliseconds (0 or more)"],
  kbps: ["kbps", (n) => n > 0, "a number above 0"],
  drop: ["drop_rate", (n) => n >= 0 && n <= 1, "a rate from 0 to 1 (1 drops every response)"],
};
function parseNetwork(text) {
  const profile = parseProfile(text, Object.fromEntries(Object.entries(NETWORK).map(([name, [key]]) => [name, key])));
  for (const [name, [key, ok, takes]] of Object.entries(NETWORK)) {
    if (profile?.[key] !== undefined && !ok(profile[key])) throw Object.assign(new Error(`--network ${name} takes ${takes}, not ${profile[key]}`), { setup: true });
  }
  return profile;
}

// A number option's value, or a configuration error (exit 2): never NaN taken as "no limit"
function numberOption(name, raw, { min = 0, max = Infinity, integer = false } = {}) {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (String(raw).trim() === "" || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    const range = max < Infinity ? ` from ${min} to ${max}` : min > 0 ? ` of ${min} or more` : " (0 or more)";
    throw Object.assign(new Error(`--${name} takes ${integer ? "a whole number" : "a number"}${range}, not "${raw}"`), { setup: true });
  }
  return n;
}

async function run(paths, values) {
  // The environment's values and the secrets, from their files, before anything else
  let given;
  try {
    given = await environmentOptions(values);
  } catch (e) {
    saySetup(e, ": nothing was sent.");
    return EXIT.setup;
  }
  const host = hostFor(paths, given.secrets);
  let files;
  let options;
  try {
    files = await findSuites(host, paths);
    if (!files.length) throw Object.assign(new Error("no suites found (files named *.hafen.yml, *.hafen.yaml or *.hafen.json)"), { setup: true });
    options = {
      env: given.env,
      ...(given.environment ? { environment: given.environment } : {}),
      secretsFrom: secretsWhere(given),
      vars: parseVars(values.var),
      tests: values.test ?? [],
      tags: values.tag ?? [],
      repeat: numberOption("repeat", values.repeat, { min: 1, integer: true }),
      unsure: values.unsure,
      maxCost: numberOption("max-cost", values["max-cost"]),
      bail: !!values.bail,
      timeoutMs: numberOption("timeout", values.timeout, { min: 1, integer: true }),
      load: !!values.load,
      network: parseNetwork(values.network),
      redact: values.redact ? values.redact.split(",").map((s) => s.trim()) : [],
    };
    if (options.unsure && !["pass", "warn", "fail"].includes(options.unsure)) throw Object.assign(new Error("--unsure takes pass, warn or fail"), { setup: true });
    // (a pattern misspelled would redact nothing, and say nothing)
    const unknown = options.redact.filter((name) => !REDACT_PATTERNS.includes(name));
    if (unknown.length) throw Object.assign(new Error(`--redact takes ${REDACT_PATTERNS.join(", ")}, not ${unknown.map((n) => `"${n}"`).join(", ")}`), { setup: true });
    // (gone: groups in the files say what runs at once)
    if (process.env.HAFEN_CONCURRENCY?.trim()) throw Object.assign(new Error("HAFEN_CONCURRENCY is no longer used: suites and tests run by their group (group: in the file); unset it"), { setup: true });
    // (with nothing to compare with, it would be ignored, and say nothing)
    if (values["fail-on"] !== undefined && !values.baseline) throw Object.assign(new Error("--fail-on compares with a baseline: add --baseline <run file>"), { setup: true });
  } catch (e) {
    err(red(e.message));
    return EXIT.setup;
  }
  const failOn = parseFailOn(values["fail-on"]);
  if (failOn instanceof Error) {
    err(red(failOn.message));
    return EXIT.setup;
  }

  // What the options name, before anything is sent: each report's format, and that it can be written
  // where it goes (with no --report, the run file in .hafen/runs/), and the baseline
  let baseline;
  try {
    const reports = values.report?.length ? reportSpecs(values.report) : [{ format: "run", path: join(RUNS, runFileName({ _id: "next" })) }];
    for (const { format, path } of reports) {
      const why = path === "-" ? null : await unwritable(path);
      if (why) throw new Error(`can't write ${values.report?.length ? `the ${format} report to ${path}` : `the run file in ${RUNS}/`}: ${why}`);
    }
    if (values.baseline) {
      try {
        baseline = parseRun(await readFile(values.baseline, "utf8"));
      } catch (e) {
        throw new Error(`the baseline can't be read: ${e.message}`);
      }
    }
  } catch (e) {
    err(red(e.message));
    return EXIT.setup;
  }

  const suites = [];
  for (const file of files) suites.push(await loadSuite(host, file));
  if (!values.quiet) for (const w of suites.flatMap((s) => s.warnings)) err(dim(`${location(w)}  ${w.message}`));
  // --max-cost with no price anywhere would stop nothing: every cost is unknown. (A cost comes from a
  // provider's price, or the suite's prices for its model. A suite with problems says them first.)
  const priced = (s) => Object.keys(s.prices ?? {}).length > 0 || Object.values(s.providers ?? {}).some((p) => p?.price);
  if (options.maxCost !== undefined && suites.every((s) => !s.errors?.length) && !suites.some(priced)) {
    err(red("--max-cost needs prices: no suite has prices and no provider has a price, so the run's cost is unknown; add prices to the suite or a provider's price, or leave out --max-cost"));
    return EXIT.setup;
  }

  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);

  // Each test's turns as they end (redacted, as every event is), and when it started: for its line
  const seen = new Map();
  const of = (suite, id) => {
    const key = `${suite}\u0000${id}`;
    if (!seen.has(key)) seen.set(key, { turns: [] });
    return seen.get(key);
  };
  // (and the secrets file's values hidden in each, as in the run: the run's end is the run, hidden below)
  const hide = secretsHider(given.secrets);
  const onEvent = (sent) => {
    const event = hide && sent.type !== "run:end" ? hide.redact(sent) : sent;
    if (event.type === "test:start") of(event.test.suite, event.test.id ?? event.test.name).started = performance.now();
    if (event.type === "turn:end" && event.record?.suite !== undefined) of(event.record.suite, event.record.test).turns.push(event.record);
    if (values.quiet) return;
    if (event.type === "test:end") {
      const info = of(event.test.suite, event.test.id ?? event.test.name);
      out(testLine(event.test, suites, { ...info, ms: info.started === undefined ? undefined : performance.now() - info.started }));
    }
    if (values.verbose && event.type === "turn:end") {
      const r = event.record;
      out(dim(`    turn ${r.index + 1}${r.row ? ` · row ${r.row}` : ""} · ${sec(r.metrics?.ms)} · ${(r.results ?? []).map((x) => `${mark(x.status)} ${x.name}`).join("  ")}`));
    }
    // A provider's fixtures: each that failed, always (an after or afterAll one changes no result, so
    // this is where it's seen); with --verbose, each as it ends
    if (event.type === "fixture:end" && (values.verbose || event.fixture.status !== "ok")) out(fixtureLine(event.fixture));
    // With --verbose, each HTTP call a plugin or fixture made
    if (values.verbose && event.type === "span" && event.action === "end" && event.span?.kind === "call") {
      const s = event.span;
      out(dim(`      ${s.name}  ${s.response?.status ?? s.error ?? ""}  ${sec(s.end - s.start)}${s.plugin ? `  (${s.plugin})` : ""}`));
    }
  };
  const ran = await runSuites({ suites, host, options, onEvent, signal: controller.signal });
  const run = hide ? hide.redact(ran) : ran;
  // Problems the run found before it sent anything (engine/runner.js, preflight): each one, as
  // validate says them; the reports are still written, so CI shows why
  if (run.status === "error" && run.error?.all) {
    const problems = run.error.all;
    for (const p of problems) err(`${red(location(p) || p.suite)}  ${p.message}`);
    err(red(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}: nothing was sent.`));
    await writeReports(run, values.report);
    return EXIT.setup;
  }

  let code;
  if (run.status === "error") code = EXIT.setup;
  else if (run.status === "stopped") code = EXIT.stopped;
  else if (!run.tests.length) {
    // Nothing ran: in CI that's a mistake (an empty suite, or --test / --tag matching nothing), not a pass
    err(`no tests ran: ${values.test?.length || values.tag?.length ? "none match --test / --tag" : "the suites have none yet"}`);
    code = EXIT.setup;
  } else code = run.verdict === "failed" ? EXIT.failed : EXIT.ok;

  if (baseline) {
    try {
      run.baseline = compareRuns(run, baseline, failOn);
      if (run.baseline.regressed.length && code === EXIT.ok) code = EXIT.failed;
    } catch (e) {
      err(red(`the baseline can't be compared: ${e.message}`));
      code = Math.max(code, EXIT.setup) === EXIT.stopped ? EXIT.stopped : EXIT.setup;
    }
  }
  if (!values.quiet) {
    if (run.error) err(red(`${location(run.error)}  ${run.error.message}`));
    out(summaryLine(run));
    if (run.stopped) out(yellow(`stopped: ${run.stopped}`));
    if (run.baseline?.regressed.length) out(red(`regressed: ${run.baseline.regressed.join("; ")}`));
  }
  const { written, failed } = await writeReports(run, values.report);
  if (!values.quiet && written.run) out(dim(`Run file: ${written.run}`));
  // A report that couldn't be written: a run that passed exits 2 (CI would miss what it says); one
  // that failed or stopped keeps its code, which says more
  return failed && code === EXIT.ok ? EXIT.setup : code;
}

function parseFailOn(text) {
  if (!text) return { pass_rate: 5 };
  try {
    const t = parseProfile(text, { pass_rate: "pass_rate", p95: "p95", cost: "cost" });
    return t;
  } catch (e) {
    return e;
  }
}

const mark = (status) => ({ pass: green("✓"), fail: red("✗"), error: red("✗"), unsure: yellow("!"), skipped: dim("–") })[status] ?? "?";

// A fixture's line as it ends: what ran, when, for which test, how it went
//   ⚙ fixture acme-login · beforeAll · providers/acme.yml  ok  0.42 s  gave ACME_COOKIE, ACME_CSRF · 1 call
function fixtureLine(f) {
  const where = [f.provider, f.test ? `${f.test.name}${f.test.row ? ` row ${f.test.row}` : ""}${f.test.repeat > 1 ? ` run ${f.test.repeat}` : ""}` : null].filter(Boolean).join(" · ");
  const head = `  ⚙ fixture ${f.name} · ${f.phase}${where ? ` · ${where}` : ""}`;
  const tail = [f.provides?.length ? `gave ${f.provides.join(", ")}` : null, f.calls ? plural(f.calls, "call") : null].filter(Boolean).join(" · ");
  return f.status === "ok" ? dim(`${head}  ok  ${sec(f.ms)}${tail ? `  ${tail}` : ""}`) : red(`${head}  failed: ${f.error}`);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A test's line as it ends (contracts/cli.md, Output): its runs (or rows) passed, its checks passed
// (a check turned off isn't counted), its time and cost; then what went wrong, a line each (its row,
// its run when it repeats, its turn), at most three
function testLine(test, suites, { turns = [], ms } = {}) {
  const suiteName = suites.find((s) => s.file === test.suite)?.name ?? test.suite;
  const icon = test.status === "passed" ? (test.unsure ? yellow("!") : green("✓")) : test.status === "skipped" || test.status === "stopped" ? dim("–") : red("✗");
  const results = test.instances.flatMap((i) => i.results ?? []);
  const counted = results.filter((r) => r.status !== "skipped");
  const passed = counted.filter((r) => r.status === "pass").length;
  const rows = test.instances.some((i) => i.row);
  const repeats = (test.settings?.repeat ?? 1) > 1;
  let cost;
  for (const t of turns) {
    for (const c of [t.metrics?.cost, ...(t.results ?? []).map((r) => r.cost)]) if (c !== undefined) cost = (cost ?? 0) + c;
  }
  const parts = [`${icon} ${suiteName} › ${test.name}`];
  if (test.status === "skipped") parts.push(dim(test.reason ?? "skipped"));
  else {
    parts.push(`${test.passed}/${test.total}${rows ? " rows" : ""}`, `${passed}/${counted.length} checks`);
    if (ms !== undefined) parts.push(sec(ms));
    if (cost !== undefined) parts.push(money(cost));
    if (test.reason) parts.push(dim(test.reason));
  }
  const lines = [parts.join("   ")];
  const where = (row, repeat, turn) => [row ? `row ${row}` : "", repeats ? `run ${repeat}` : "", turn !== undefined ? `turn ${turn + 1}` : ""].filter(Boolean).join(" · ");
  const bad = [];
  const order = (a, b) => (a.repeat ?? 0) - (b.repeat ?? 0) || (a.row ?? 0) - (b.row ?? 0) || (a.index ?? 0) - (b.index ?? 0);
  for (const t of [...turns].sort(order)) {
    const at = where(t.row, t.repeat, t.index);
    // A turn that broke: once, why (each of its checks says the same)
    if (t.error) bad.push(`${at} · error: ${t.error}`);
    else {
      for (const r of t.results ?? []) {
        if (r.status === "fail" || r.status === "error") bad.push(`${at} · ${r.status === "error" ? "error · " : ""}${r.name}: ${r.reason}`);
        // (unsure counts as failed with --unsure fail, or the file's unsure: fail)
        else if (r.status === "unsure" && test.settings?.unsure === "fail") bad.push(`${at} · unsure, counted as failed: ${r.name} (confidence ${r.confidence})`);
      }
    }
  }
  for (const i of test.instances) {
    for (const r of i.conversation_results ?? []) if (r.status === "fail" || r.status === "error") bad.push(`${[where(i.row, i.repeat), "conversation"].filter(Boolean).join(" · ")} · ${r.name}: ${r.reason}`);
    // A setup step that failed, or a row that never ran a turn: why
    const at = where(i.row, i.repeat);
    if (i.reason && (i.status === "error" || i.status === "failed") && !turns.some((t) => t.row === i.row && t.repeat === i.repeat && t.error)) bad.push(at ? `${at} · ${i.reason}` : i.reason);
  }
  for (const line of bad.slice(0, 3)) lines.push(dim(`    ${line}`));
  if (bad.length > 3) lines.push(dim(`    …${bad.length - 3} more (see the report)`));
  if (test.unsure) for (const r of results.filter((x) => x.status === "unsure").slice(0, 2)) lines.push(yellow(`    unsure: ${r.name} (confidence ${r.confidence})`));
  return lines.join("\n");
}

function summaryLine(run) {
  const s = run.summary ?? {};
  const t = s.tests ?? {};
  const checks = (s.checks?.total ?? 0) - (s.checks?.skipped ?? 0);
  return `\n${plural(run.suites.length, "suite")} · ${plural(t.total ?? 0, "test")} · ${t.failed ?? 0} failed${t.error ? ` · ${plural(t.error, "error")}` : ""} · ${t.unsure ?? 0} unsure · ${plural(checks, "check")}${s.fixtures ? ` · ${plural(s.fixtures.total, "fixture")}${s.fixtures.failed ? ` (${s.fixtures.failed} failed)` : ""}` : ""} · p50 ${sec(s.latency?.total?.p50)} · p95 ${sec(s.latency?.total?.p95)}${s.cost !== undefined ? ` · ${money(s.cost)}` : ""} · ${sec(run.ms)}`;
}

const location = (p) => (p?.file ? `${p.file}${p.line ? `:${p.line}${p.column ? `:${p.column}` : ""}` : ""}` : "");

// --report's values as { format, path } (path "-": standard output), or a configuration error: a
// format that isn't one, or no path after the colon
function reportSpecs(list) {
  return list.map((spec) => {
    const at = spec.indexOf(":");
    const format = at === -1 ? spec : spec.slice(0, at);
    const path = at === -1 ? "-" : spec.slice(at + 1);
    if (!REPORT_FORMATS.includes(format)) throw Object.assign(new Error(`unknown report format "${format}" (${REPORT_FORMATS.join(", ")})`), { setup: true });
    if (!path.trim()) throw Object.assign(new Error(`--report ${format}: needs a path (or - for standard output)`), { setup: true });
    return { format, path };
  });
}

// An error's reason, said plainly ("no such file or directory, mkdir 'out'", not "ENOENT: …")
const reasonOf = (e) => String(e?.message ?? e).replace(/^E[A-Z]+: /, "");
// A path to show: from the current folder when it's in it
const shown = (path) => {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
};

// Why a report can't be written at this path, checked before anything is sent; null if it can. Cheap,
// and makes nothing: the path isn't a folder, and the nearest folder above it that exists can be
// written in. (Not everything: a full disk, say, is found when it's written.)
async function unwritable(path) {
  const full = resolve(path);
  // ("permission denied", without the call and the path: the message says which)
  const plain = (e) => String(e?.message ?? e).replace(/^E[A-Z]+: /, "").replace(/, \w+ '.*'$/, "");
  for (let at = full; ; at = dirname(at)) {
    let info;
    try {
      info = await stat(at);
    } catch (e) {
      if ((e.code === "ENOENT" || e.code === "ENOTDIR") && dirname(at) !== at) continue;
      return plain(e);
    }
    if (at === full && info.isDirectory()) return "it's a folder";
    if (at !== full && !info.isDirectory()) return `${shown(at)} isn't a folder`;
    try {
      await access(at, constants.W_OK);
      return null;
    } catch (e) {
      if (at === full) return plain(e);
      return at === dirname(full) ? `the folder ${shown(at)} can't be written in (${plain(e)})` : `the folder ${shown(dirname(full))} can't be made (${plain(e)})`;
    }
  }
}

// Write each report: one that can't be written says why, in a line (no stack trace), and the others
// are still written. { written: { format: path }, failed: how many couldn't be }
async function writeReports(run, reports = []) {
  const written = {};
  let failed = 0;
  for (const spec of reports.length ? reports : [`run:${RUNS}/${runFileName(run)}`]) {
    const at = spec.indexOf(":");
    const format = at === -1 ? spec : spec.slice(0, at);
    const path = at === -1 ? "-" : spec.slice(at + 1);
    try {
      const make = { junit: () => junit(run), run: () => serializeRun(run), md: () => markdown(run), json: () => jsonSummary(run) }[format];
      if (!make) throw new Error(`unknown report format "${format}" (${REPORT_FORMATS.join(", ")})`);
      const text = make();
      if (path === "-") process.stdout.write(text);
      else {
        await mkdir(dirname(resolve(path)), { recursive: true });
        await writeFile(path, text);
        written[format] = path;
      }
    } catch (e) {
      failed++;
      err(red(`couldn't write the ${format} report to ${path === "-" ? "standard output" : path}: ${reasonOf(e)}`));
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown(run)}\n`);
    } catch {}
  }
  return { written, failed };
}

async function validate(paths, values) {
  let given;
  try {
    given = await environmentOptions(values);
  } catch (e) {
    saySetup(e);
    return EXIT.setup;
  }
  const host = hostFor(paths, given.secrets);
  let files;
  try {
    files = await findSuites(host, paths);
  } catch (e) {
    err(red(e.message));
    return EXIT.setup;
  }
  if (!files.length) {
    err(red("no suites found"));
    return EXIT.setup;
  }
  let problems = 0;
  let vars;
  try {
    vars = parseVars(values.var);
  } catch (e) {
    err(red(e.message));
    return EXIT.setup;
  }
  const suites = [];
  for (const file of files) suites.push(await loadSuite(host, file));
  // The run's own check before it sends anything (its plugins, check types, --env and every
  // {{env.NAME}} its file gives, all of it): what passes here doesn't stop a run. Secrets only with
  // --env-check (from --secret's file, then the environment); without it, each is taken as set.
  const options = { env: given.env, ...(given.environment ? { environment: given.environment } : {}), secretsFrom: secretsWhere(given), vars };
  const checked = await preflight({ suites, host, options, ...(values["env-check"] ? {} : { secretsFor: () => () => "(not checked)" }) });
  checked.close();
  // (nothing said holds a value of the secrets file)
  const hide = secretsHider(given.secrets);
  const said = (text) => (hide ? hide.text(text) : text);
  for (const suite of suites) {
    const errors = checked.problems.filter((p) => p.suite === suite.file);
    for (const e of errors) err(`${red(location(e) || suite.file)}  ${said(e.message)}`);
    for (const w of suite.warnings) err(dim(`${location(w)}  ${said(w.message)}`));
    problems += errors.length;
    if (!errors.length && !values.quiet) out(`${green("✓")} ${suite.file}`);
  }
  // (a plugin's secrets, named in its code, are preflight's too: a pack's as any folder's)
  if (problems) err(red(`\n${problems} problem${problems === 1 ? "" : "s"}`));
  return problems ? EXIT.setup : EXIT.ok;
}

async function report([file], values) {
  if (!file) {
    err(red("report needs a run file"));
    return EXIT.setup;
  }
  // Every format, and every path, before anything is written: a mistake writes nothing (exit 2)
  const reports = values.report?.length ? values.report : ["md:-"];
  let run;
  try {
    for (const { format, path } of reportSpecs(reports)) {
      const why = path === "-" ? null : await unwritable(path);
      if (why) throw new Error(`can't write the ${format} report to ${path}: ${why}`);
    }
    run = parseRun(await readFile(file, "utf8"));
  } catch (e) {
    err(red(reasonOf(e)));
    return EXIT.setup;
  }
  // (one that couldn't be written after all: said, the others written, exit 2)
  const { failed } = await writeReports(run, reports);
  return failed ? EXIT.setup : EXIT.ok;
}

async function compare([file], values) {
  if (!file || !values.baseline) {
    err(red("compare needs a run file and --baseline <run file>"));
    return EXIT.setup;
  }
  const failOn = parseFailOn(values["fail-on"]);
  if (failOn instanceof Error) {
    err(red(failOn.message));
    return EXIT.setup;
  }
  try {
    const run = parseRun(await readFile(file, "utf8"));
    const baseline = parseRun(await readFile(values.baseline, "utf8"));
    run.baseline = compareRuns(run, baseline, failOn);
    out(markdown(run));
    return run.baseline.regressed.length ? EXIT.failed : EXIT.ok;
  } catch (e) {
    err(red(e.message));
    return EXIT.setup;
  }
}
