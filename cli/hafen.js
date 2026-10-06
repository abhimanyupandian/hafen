#!/usr/bin/env node
// hafen: run suites in CI (or anywhere) with the same engine as the app; validate them without
// sending anything; write reports from a run file; compare two runs; serve the browser build with
// its relay. The contract: spec/001-hafen/contracts/cli.md.
//
// Exit codes: 0 everything passed · 1 tests failed (or regressed past --fail-on) · 2 a setup or
// configuration error · 3 stopped early (--max-cost, --bail, or cancelled).

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  compareRuns, jsonSummary, junit, loadSuite, markdown, parseRun, runFileName, runSuites, serializeRun, SUITE_FILE,
} from "../engine/index.js";
import { problemsFor } from "../engine/files/suite-file.js";
import { secretsNeeded } from "../engine/files/suite-file.js";
import { suiteFixtureNames } from "../engine/plugins.js";
import { fromRoot, nodeHost, VERSION } from "./node-host.js";

const EXIT = { ok: 0, failed: 1, setup: 2, stopped: 3 };

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const dim = paint(2);

const sec = (ms) => (ms === undefined ? "—" : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
const money = (usd) => (usd === undefined ? "" : `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`);

const HELP = `hafen ${VERSION}: end-to-end tests for chat endpoints

  hafen run [paths…] [options]       run suites (files or folders; default: the current folder)
  hafen validate [paths…] [options]  check suites against the schema; sends nothing
  hafen report <run-file> --report <format>:<path>
  hafen compare <run-file> --baseline <run-file> [--fail-on …]
  hafen serve [--port 8790] [--host 127.0.0.1] [--allow-endpoint <url>]…

Options for run: --test, --tag, --env, --var name=value, --repeat, --unsure pass|warn|fail,
  --max-cost <usd>, --bail, --timeout <ms>, --report <junit|run|md|json>:<path|->, --baseline <run-file>,
  --fail-on pass_rate=<points>,p95=<percent>,cost=<percent>, --load, --network delay=<ms>,kbps=<n>,drop=<rate>,
  --redact email,card,phone, --quiet, --verbose, --no-color
Options for validate: --env, --var name=value, --env-check (every \${env:…} set), --quiet
What runs at once: suites and tests by their group (group: 2 in the file); the same group one after
  another, different groups at the same time; none is one group.
Exit codes: 0 passed · 1 failed · 2 setup error · 3 stopped early`;

// The options every command takes (each command uses its own)
const OPTIONS = {
  test: { type: "string", multiple: true },
  tag: { type: "string", multiple: true },
  env: { type: "string" },
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
  port: { type: "string" },
  host: { type: "string" },
  "allow-endpoint": { type: "string", multiple: true },
};

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") return out(HELP), EXIT.ok;
  if (command === "--version" || command === "-v") return out(VERSION), EXIT.ok;
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
    case "serve": {
      const { serve } = await import("./relay.js");
      let port;
      try {
        port = numberOption("port", values.port ?? "8790", { integer: true, max: 65535 });
      } catch (e) {
        err(red(e.message));
        return EXIT.setup;
      }
      try {
        await serve({ port, host: values.host ?? "127.0.0.1", allow: [...(values["allow-endpoint"] ?? []), ...(process.env.HAFEN_ENDPOINTS ?? "").split(",").map((e) => e.trim()).filter(Boolean)] });
      } catch (e) {
        err(red(e.message));
        return EXIT.setup;
      }
      return null;  // keeps running
    }
    default:
      err(`unknown command "${command}"\n\n${HELP}`);
      return EXIT.setup;
  }
}

const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);

// The suite files the paths name (files, or folders searched for *.hafen.yml|yaml|json; a folder
// outside the current one too)
async function findSuites(host, paths) {
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
const cliHost = (paths = []) => nodeHost({ also: paths.map((p) => resolve(p)).map((p) => projectOf(SUITE_FILE.test(p) ? dirname(p) : p)) });

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
    if (!key || v === undefined || !Number.isFinite(Number(v))) throw Object.assign(new Error(`can't read "${part}" (expected ${Object.keys(keys).join(", ")} as name=number)`), { setup: true });
    outObj[key] = Number(v);
  }
  return outObj;
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
  const host = cliHost(paths);
  let files;
  let options;
  try {
    files = await findSuites(host, paths);
    if (!files.length) throw Object.assign(new Error("no suites found (files named *.hafen.yml, *.hafen.yaml or *.hafen.json)"), { setup: true });
    options = {
      env: values.env,
      vars: parseVars(values.var),
      tests: values.test ?? [],
      tags: values.tag ?? [],
      repeat: numberOption("repeat", values.repeat, { min: 1, integer: true }),
      unsure: values.unsure,
      maxCost: numberOption("max-cost", values["max-cost"]),
      bail: !!values.bail,
      timeoutMs: numberOption("timeout", values.timeout, { min: 1, integer: true }),
      load: !!values.load,
      network: parseProfile(values.network, { delay: "delay_ms", jitter: "jitter_ms", kbps: "kbps", drop: "drop_rate" }),
      redact: values.redact ? values.redact.split(",").map((s) => s.trim()) : [],
    };
    if (options.unsure && !["pass", "warn", "fail"].includes(options.unsure)) throw Object.assign(new Error("--unsure takes pass, warn or fail"), { setup: true });
    // (gone: groups in the files say what runs at once)
    if (process.env.HAFEN_CONCURRENCY?.trim()) throw Object.assign(new Error("HAFEN_CONCURRENCY is no longer used: suites and tests run by their group (group: in the file); unset it"), { setup: true });
  } catch (e) {
    err(red(e.message));
    return EXIT.setup;
  }
  const failOn = parseFailOn(values["fail-on"]);
  if (failOn instanceof Error) {
    err(red(failOn.message));
    return EXIT.setup;
  }

  const suites = [];
  for (const file of files) suites.push(await loadSuite(host, file));
  // (a name a provider's fixture gives is set: the fixture sets it when the run starts)
  const problems = [];
  for (const s of suites) {
    const given = await suiteFixtureNames(host, s);
    problems.push(...problemsFor(s, options.vars, (name) => (given.has(name) ? "(a fixture's)" : process.env[name])));
  }
  if (problems.length) {
    for (const p of problems) err(`${red(location(p))}  ${p.message}`);
    err(red(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}: nothing was sent.`));
    // Still write the reports, so CI shows why
    const run = await runSuites({ suites, host, options });
    await writeReports(run, values.report);
    return EXIT.setup;
  }
  if (!values.quiet) for (const w of suites.flatMap((s) => s.warnings)) err(dim(`${location(w)}  ${w.message}`));

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
  const onEvent = (event) => {
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
  };
  const run = await runSuites({ suites, host, options, onEvent, signal: controller.signal });

  let code;
  if (run.status === "error") code = EXIT.setup;
  else if (run.status === "stopped") code = EXIT.stopped;
  else if (!run.tests.length) {
    // Nothing ran: in CI that's a mistake (an empty suite, or --test / --tag matching nothing), not a pass
    err(`no tests ran: ${values.test?.length || values.tag?.length ? "none match --test / --tag" : "the suites have none yet"}`);
    code = EXIT.setup;
  } else code = run.verdict === "failed" ? EXIT.failed : EXIT.ok;

  if (values.baseline) {
    try {
      const baseline = parseRun(await readFile(values.baseline, "utf8"));
      run.baseline = compareRuns(run, baseline, failOn);
      if (run.baseline.regressed.length && code === EXIT.ok) code = EXIT.failed;
    } catch (e) {
      err(red(`the baseline can't be read: ${e.message}`));
      code = Math.max(code, EXIT.setup) === EXIT.stopped ? EXIT.stopped : EXIT.setup;
    }
  }
  if (!values.quiet) {
    if (run.error) err(red(`${location(run.error)}  ${run.error.message}`));
    out(summaryLine(run));
    if (run.stopped) out(yellow(`stopped: ${run.stopped}`));
    if (run.baseline?.regressed.length) out(red(`regressed: ${run.baseline.regressed.join("; ")}`));
  }
  const written = await writeReports(run, values.report);
  if (!values.quiet && written.run) out(dim(`Run file: ${written.run}`));
  return code;
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
  return `\n${plural(run.suites.length, "suite")} · ${plural(t.total ?? 0, "test")} · ${t.failed ?? 0} failed${t.error ? ` · ${plural(t.error, "error")}` : ""} · ${t.unsure ?? 0} unsure · ${plural(checks, "check")} · p50 ${sec(s.latency?.total?.p50)} · p95 ${sec(s.latency?.total?.p95)}${s.cost !== undefined ? ` · ${money(s.cost)}` : ""} · ${sec(run.ms)}`;
}

const location = (p) => (p?.file ? `${p.file}${p.line ? `:${p.line}${p.column ? `:${p.column}` : ""}` : ""}` : "");

async function writeReports(run, reports = []) {
  const written = {};
  const list = reports.length ? reports : [`run:.hafen/runs/${runFileName(run)}`];
  if (!list.some((r) => r.startsWith("run:")) && reports.length === 0) list.push(`run:.hafen/runs/${runFileName(run)}`);
  for (const spec of list) {
    const at = spec.indexOf(":");
    const format = at === -1 ? spec : spec.slice(0, at);
    const path = at === -1 ? "-" : spec.slice(at + 1);
    const text = { junit: () => junit(run), run: () => serializeRun(run), md: () => markdown(run), json: () => jsonSummary(run) }[format]?.();
    if (text === undefined) {
      err(red(`unknown report format "${format}" (junit, run, md, json)`));
      continue;
    }
    if (path === "-") process.stdout.write(text);
    else {
      await mkdir(dirname(resolve(path)), { recursive: true });
      await writeFile(path, text);
      written[format] = path;
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown(run)}\n`).catch(() => {});
  return written;
}

async function validate(paths, values) {
  const host = cliHost(paths);
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
  try {
    parseVars(values.var);
  } catch (e) {
    err(red(e.message));
    return EXIT.setup;
  }
  for (const file of files) {
    const suite = await loadSuite(host, file);
    const errors = [...suite.errors];
    const vars = parseVars(values.var);
    errors.push(...(suite.missing ?? []).filter((m) => !(m.variable in vars)));
    if (values["env-check"] && suite.data) {
      const given = await suiteFixtureNames(host, suite);
      for (const name of secretsNeeded(suite)) if (!process.env[name] && !given.has(name)) errors.push({ file, message: `\${env:${name}} isn't set` });
    }
    for (const e of errors) err(`${red(location(e) || file)}  ${e.message}`);
    for (const w of suite.warnings) err(dim(`${location(w)}  ${w.message}`));
    problems += errors.length;
    if (!errors.length && !values.quiet) out(`${green("✓")} ${file}`);
  }
  if (problems) err(red(`\n${problems} problem${problems === 1 ? "" : "s"}`));
  return problems ? EXIT.setup : EXIT.ok;
}

async function report([file], values) {
  if (!file) {
    err(red("report needs a run file"));
    return EXIT.setup;
  }
  try {
    const run = parseRun(await readFile(file, "utf8"));
    await writeReports(run, values.report?.length ? values.report : ["md:-"]);
    return EXIT.ok;
  } catch (e) {
    err(red(e.message));
    return EXIT.setup;
  }
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

main(process.argv.slice(2)).then(
  (code) => { if (code !== null) process.exitCode = code; },
  (e) => {
    err(red(e?.stack ?? String(e)));
    process.exitCode = e?.setup ? EXIT.setup : EXIT.setup;
  },
);
