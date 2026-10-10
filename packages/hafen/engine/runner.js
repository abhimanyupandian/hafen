// Running suites (data-model.md; contracts/run-file.md): suites → tests → repeats × data rows → turns,
// with setup and teardown steps, extractions, rule checks and judges, every step timed as a span. The
// run record is built as it goes and returned, redacted, at the end.
//
// The host gives everything platform-specific: { transport, files, secrets(NAME), now(), clock(),
// where, sha256?(text) }. onEvent(event) reports progress for a UI or a CLI (see EVENTS below).

import { describe, runRule, typeOf } from "./checks/index.js";
import { countChecks, isOff, OFF, runChecks, turnFailed, warned } from "./checks/run.js";
import { environmentOf, knownSecrets, unknownEnvironment } from "./environment.js";
import { createFixtures } from "./fixtures.js";
import { firstCell, rowLabel, rowNameText } from "./files/data.js";
import { providerOf } from "./files/suite-file.js";
import { first } from "./jsonpath.js";
import { preflight } from "./preflight.js";
import { createProvider } from "./providers/index.js";
import { tryJSON } from "./providers/http.js";
import { createRedactor, headerSecrets } from "./redact.js";
import { RUN_KIND, RUN_VERSION } from "./run-kind.js";
import { closeAll, createSpans } from "./spans.js";
import { executeTurn } from "./turn.js";
import { anySignal, isObject, percentiles, textChunks, uid } from "./util.js";
import { createScope, MissingVariable } from "./vars.js";

export { RUN_KIND, RUN_VERSION } from "./run-kind.js";

// What onEvent receives:
//   run:start {run}  ·  span {action: "start" | "end", span}  ·  test:start {test}  ·  test:end {test}
//   turn:start {index, key, user}  ·  turn:event {index, event}  ·  turn:retry {index, …}
//   turn:end {index, record}  ·  log {text, kind}  ·  run:end {run}

// (unsure: an unsure result counts as failed unless --unsure, the suite's defaults, the test or the
// check say warn or pass: what a judge wasn't sure of never passes quietly)
const DEFAULTS = { repeat: 1, pass_rate: 1, history: "live", on_fail: "continue", unsure: "fail", unsure_below: 0.6, timeout_ms: 120000, retries: 2 };
const SETTING_KEYS = Object.keys(DEFAULTS);
// The settings a provider can have too (its turns'): a suite's defaults and a test's own come before it
const PROVIDER_SETTINGS = ["timeout_ms", "retries"];

export function newRun({ mode = "test", host, settings = {} }) {
  return {
    _id: uid(16),
    kind: RUN_KIND,
    version: RUN_VERSION,
    mode,
    started: host.clock(),
    status: "running",
    verdict: null,
    where: host.where ?? {},
    suites: [],
    settings,
    spans: [],
    turns: [],
    tests: [],
    summary: null,
    reviews: [],
    baseline: null,
    error: null,
    // Each run of a provider's fixture: { name, phase, provider, test?, status, ms, provides, calls, error? }
    fixtures: [],
  };
}

// What runs at once: groups (contracts/test-file.md, Groups). The suites of a run with the same
// `group` run one after another, in order; different groups at the same time (the suites with none
// are one group). Within a suite, its tests the same way, by their `group`. A test's runs, rows and
// turns always go in order.
//
// options: { env, environment, vars, tests: [names], tags, ids: [test ids], repeat, unsure, maxCost,
//            bail, timeoutMs, redact: [patterns], untilTurn }
// environment ({ name, values }: values a map of NAME → text, from KEY=VALUE files or the app's
// store; name "" for one with none, the app's "no scope"; or null, none) is the chosen environment,
// for {{env.NAME}} (environmentOf); env, its name when there are no values to pass (the suites'
// environments of that name; nothing is read from the folder).
// The host's secrets are looked up once in a run (each name, for each scope), and kept: one changed
// while it runs doesn't change its later turns. host.knownSecrets?.(envName) → [values]: every secret
// the host keeps for that scope, hidden from the start wherever it shows, whether the run uses it or not.
// untilTurn (a turn's index): each test runs up to and including that turn (the ones before it are
// its history); the turns after it and the checks on the whole conversation don't run.
// onlyTurn (a turn's index), with carry ({ [test id or name]: [the records of its earlier turns, by
// index] }: the app's last run of it): only that turn is sent; each turn before it is carried, not
// sent (its record as it was, or its fixed `reply`), as the history it goes with; a turn with
// neither is sent, as untilTurn would. The turns after it and the conversation checks don't run.
export async function runSuites({ suites, host, options = {}, onEvent: emit = () => {}, signal, plugins = {} }) {
  const settings = {
    env: (isObject(options.environment) ? options.environment.name : options.env) || null,
    filters: { tests: options.tests ?? [], tags: options.tags ?? [], ids: options.ids ?? [] },
    unsure: options.unsure ?? null,
    max_cost: options.maxCost ?? null,
    until_turn: Number.isInteger(options.untilTurn) && options.untilTurn >= 0 && !Number.isInteger(options.onlyTurn) ? options.untilTurn : null,
    only_turn: Number.isInteger(options.onlyTurn) && options.onlyTurn >= 0 ? options.onlyTurn : null,
  };
  const run = newRun({ mode: "test", host, settings });
  const stopper = new AbortController();
  const runSignal = anySignal([signal, stopper.signal]);
  const secretsUsed = new Set();
  // What's redacted besides secrets: --redact's patterns and each suite's (redact: { patterns }), and
  // the headers each suite (redact: { headers }) and each of its providers (secret_headers) names.
  // One run, one redactor: what any suite asks for is redacted throughout.
  const listed = (v) => (Array.isArray(v) ? v : []);
  const redactor = createRedactor({
    secrets: secretsUsed,
    patterns: [...new Set([...listed(options.redact), ...suites.flatMap((s) => listed(s.data?.redact?.patterns))])],
    headers: [...new Set([...suites.flatMap((s) => listed(s.data?.redact?.headers)), ...suites.flatMap((s) => Object.values(s.providers ?? {}).flatMap((p) => listed(p?.secret_headers)))])],
  });
  // A scope's secrets: what its providers' beforeAll fixtures gave in this run (a login's cookie),
  // then the host's. Each fixture that runs is recorded, and told as it ends. (What they set with
  // env.set is kept there too, for this run only: it ends with it.)
  const fixtures = createFixtures({
    used: secretsUsed,
    record: (fixture) => {
      run.fixtures.push(fixture);
      onEvent({ type: "fixture:end", fixture });
    },
  });
  // The host's secrets, each looked up once in the run (for each scope) and kept: one changed, renamed
  // or deleted while it runs doesn't change its later turns. (Only text is a secret's value.)
  const hostSecrets = new Map();  // scope name (null: none) → Map(NAME → value)
  const hostSecret = (envName, name) => {
    if (!hostSecrets.has(envName)) hostSecrets.set(envName, new Map());
    const kept = hostSecrets.get(envName);
    if (!kept.has(name)) {
      const value = host.secrets(name, { env: envName });
      kept.set(name, typeof value === "string" ? value : undefined);
    }
    return kept.get(name);
  };
  const secretsFor = (envName) => (name) => fixtures.value(name, envName) ?? hostSecret(envName, name);
  // The providers the run used, by scope (config → { plugins, scope, provider }): their afterAll
  // fixtures run when it ends
  const usedProviders = new Map();
  const useProvider = (envName, config, info) => {
    if (!usedProviders.has(envName ?? "")) usedProviders.set(envName ?? "", new Map());
    if (!usedProviders.get(envName ?? "").has(config)) usedProviders.get(envName ?? "").set(config, info);
  };
  // Every event as it goes out redacted, as the run file is (a check's reason, a message, a streamed
  // reply, a step's name can hold a secret): a CI log or the page never sees one. (The run's end is
  // the run, redacted already.)
  const onEvent = (event) => emit(event.type === "run:end" ? event : redactor.redact(event));
  const spans = createSpans({ now: host.now, onChange: (action, span) => onEvent({ type: "span", action, span }) });
  run.spans = spans.list;
  run.settings.redact = redactor.rules();
  let stoppedBy = null;
  let spent = 0;
  const spend = (cost) => {
    if (cost === undefined) return;
    spent += cost;
    if (options.maxCost !== undefined && options.maxCost !== null && spent >= options.maxCost && !stoppedBy) {
      stoppedBy = `the run's cost reached the limit ($${options.maxCost})`;
      stopper.abort();
    }
  };

  for (const suite of suites) {
    run.suites.push({ file: suite.file, name: suite.name, sha256: host.sha256 && suite.text !== undefined ? await host.sha256(suite.text) : undefined });
  }
  onEvent({ type: "run:start", run: { ...run, spans: [], turns: [] } });

  // Every secret the host keeps for the scopes the suites run in, hidden from here on wherever it
  // shows (a reply that echoes one the run never sent): used or not
  try {
    await knownSecrets(host, suites.map((s) => environmentOf(s, options).envName), secretsUsed);
  } catch (err) {
    run.status = "error";
    run.error = { message: `the secrets to hide couldn't be read: ${err.message}` };
    return finish(run, { spans, redactor, onEvent, host });
  }

  // Nothing is sent while any suite has a problem
  const { problems, suitePlugins, close: closePlugins } = await preflight({ suites, host, options, plugins, secretsFor, used: secretsUsed });
  if (problems.length) {
    const e = problems[0];
    run.status = "error";
    run.error = { message: e.message, file: e.file, line: e.line, column: e.column, all: problems };
    closePlugins();
    return finish(run, { spans, redactor, onEvent, host });
  }

  const runSpan = spans.start("run", "run");
  try {
    // The suites by group: a group's one after another, the groups at once. (A suite that breaks, its
    // setup failing say, doesn't stop the others in its group; the run is an error after them.)
    const failures = [];
    await Promise.all(byGroup(suites, (suite) => suite.data?.group).map(async (members) => {
      for (const suite of members) {
        if (runSignal.aborted) break;
        try {
          await runSuite(suite, {
            run, host, options, onEvent, signal: runSignal, spans, parent: runSpan, redactor, secretsUsed, spend, fixtures, secretsFor, useProvider,
            plugins: { ...plugins, ...(suitePlugins.get(suite.file)?.plugins ?? {}) },
            stop: (why) => { stoppedBy ??= why; stopper.abort(); },
          });
        } catch (err) {
          failures.push(err);
        }
      }
    }));
    if (failures.length) throw failures[0];
    if (signal?.aborted && !stoppedBy) stoppedBy = "cancelled";
    run.status = stoppedBy ? "stopped" : "done";
    if (stoppedBy) run.stopped = stoppedBy;
  } catch (err) {
    run.status = "error";
    run.error = { message: err.message, variable: err instanceof MissingVariable ? err.variable : undefined };
  }
  // Each provider's afterAll fixtures, however the run ended (once per scope)
  for (const [envName, configs] of usedProviders) {
    for (const [config, info] of configs) await fixtures.afterAll(config, { ...info, envName, spans, parent: runSpan });
  }
  spans.end(runSpan, run.status === "done" ? "ok" : run.status === "stopped" ? "skipped" : "error");
  closePlugins();
  return finish(run, { spans, redactor, onEvent, host });
}

function finish(run, { spans, redactor, onEvent, host }) {
  closeAll(spans, run.status === "error" ? "error" : "skipped");
  // A turn whose place was taken but that never ended (the run broke off): said so
  run.turns = run.turns.map((t) => t ?? { skipped: "the run ended before this turn did", events: [], reply: "", thinking: [], tool_calls: [], results: [], metrics: {} });
  run.ended = host.clock();
  run.ms = run.ended - run.started;
  run.summary = summarize(run);
  // (A run stopped early failed if a test failed before it stopped; otherwise it can't be said to have
  // passed: null. Nor can one that ran no tests: --test matching none, a suite with none)
  if (run.status === "done" || run.status === "stopped") {
    const tests = run.tests;
    run.verdict = tests.some((t) => t.status === "failed" || t.status === "error") ? "failed" : run.status === "stopped" || !tests.length ? null : tests.some((t) => t.unsure) ? "unsure" : "passed";
  }
  const out = redactor.redact(run);
  onEvent({ type: "run:end", run: out });
  return out;
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));

// Items by group, each group in order (`groupOf`: an item's group, or undefined: the items with none
// are one group of their own), the groups in the order they first appear
export function byGroup(items, groupOf) {
  const groups = new Map();
  for (const item of items) {
    const g = groupOf(item);
    const key = g === undefined || g === null || g === "" ? "\u0000none" : `g${g}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()];
}

async function runSuite(suite, ctx) {
  const { options, host, spans, parent, signal } = ctx;
  const data = suite.data;
  const { envName, environment } = environmentOf(suite, options);
  const unknown = await unknownEnvironment(suite, options, host);
  if (unknown) throw Object.assign(new Error(`${suite.file}: ${unknown}`), { setup: true });
  const fileLayers = [options.vars ?? {}, data.variables ?? {}, environment?.suite ?? {}];
  const base = createScope({
    layers: fileLayers,
    trusted: fileLayers,
    secrets: ctx.secretsFor(envName),
    used: ctx.secretsUsed,
    environment,
    secretsFrom: options.secretsFrom,
    // (what fixtures set with env.set in this scope, as they set it: the run's, every suite's)
    overlay: ctx.fixtures.env(envName),
  });
  const suiteSpan = spans.start("suite", suite.name, { parent, ref: { suite: suite.file } });
  const tests = (data.tests ?? []).map((test, index) => ({ test, index })).filter(({ test }) => selected(test, options));
  // The beforeAll fixtures of the providers its tests use (a login), before its setup steps, which can
  // use what they give too. Each runs once in the run, however many suites use it.
  const configs = new Map();
  for (const { index } of tests) {
    const { config, file } = providerOf(suite, index);
    if (config && !configs.has(config)) configs.set(config, file);
  }
  for (const [config, provider] of configs) {
    ctx.useProvider(envName, config, { plugins: ctx.plugins, scope: base, provider });
    let stop;
    try {
      stop = await ctx.fixtures.beforeAll(config, { plugins: ctx.plugins, scope: base, envName, spans, parent: suiteSpan, signal, provider });
    } catch (err) {
      spans.end(suiteSpan, "error");
      throw Object.assign(new Error(`${suite.file}: ${err.message}`), { setup: true });
    }
    // One said to stop (its run() returned false): the run stops here, before this suite's setup
    // steps and tests, each skipped saying why (the provider's afterAll fixtures still run)
    if (stop) {
      ctx.stop(stop);
      for (const { test, index } of tests) ctx.run.tests.push({ suite: suite.file, id: test.id, name: test.name, index, status: "skipped", reason: stop, passed: 0, total: 0, instances: [] });
      spans.end(suiteSpan, "skipped");
      return;
    }
  }
  const setupVars = {};
  for (const [i, step] of (data.setup ?? []).entries()) {
    const out = await runStep(step, { ...ctx, scope: base.with({ ...setupVars }), parent: suiteSpan, kind: "setup", label: step.name ?? `setup ${i + 1}` });
    Object.assign(setupVars, out.vars);
    if (!out.ok) {
      spans.end(suiteSpan, "error");
      throw Object.assign(new Error(`${suite.file}: setup step "${step.name ?? i + 1}" failed: ${out.reason}`), { setup: true });
    }
  }
  const scope = base.with(setupVars);
  // The tests by group: a group's one after another, in the file's order; the groups at once
  const started = new Set();
  await Promise.all(byGroup(tests, ({ test }) => test.group).map(async (members) => {
    for (const { test, index } of members) {
      if (signal.aborted) break;
      started.add(index);
      const result = await runTest(suite, test, index, { ...ctx, scope, parent: suiteSpan, envName });
      if (options.bail && (result.status === "failed" || result.status === "error")) ctx.stop(`stopped at the first failure (${test.name})`);
    }
  }));
  // Tests that never started: skipped
  for (const { test, index } of tests) if (!started.has(index)) ctx.run.tests.push({ suite: suite.file, id: test.id, name: test.name, index, status: "skipped", passed: 0, total: 0, instances: [] });
  for (const [i, step] of (data.teardown ?? []).entries()) {
    await runStep(step, { ...ctx, scope, parent: suiteSpan, kind: "teardown", label: step.name ?? `teardown ${i + 1}`, signal: undefined });
  }
  // The suite's bar says how its tests went: failed if any did (stopped or not), else passed
  // (stopped: skipped)
  const mine = ctx.run.tests.filter((t) => t.suite === suite.file);
  const status = mine.some((t) => t.status === "failed" || t.status === "error") ? "fail" : signal.aborted ? "skipped" : mine.some((t) => t.status === "passed") ? "pass" : "ok";
  spans.end(suiteSpan, status);
}

function selected(test, { tests = [], tags = [], ids = [] }) {
  if (ids.length && !ids.includes(test.id)) return false;
  if (tests.length && !tests.some((t) => test.name.toLowerCase().includes(t.toLowerCase()))) return false;
  if (tags.length && !(test.tags ?? []).some((t) => tags.includes(t))) return false;
  return true;
}

async function runTest(suite, test, index, ctx) {
  const { spans, onEvent, options, run } = ctx;
  const { config: providerConfig, file: providerFile } = providerOf(suite, index);
  // The most specific wins: the test's, the suite's defaults, its provider's (timeout_ms, retries),
  // Hafen's. (The command line's --timeout, --repeat… over all of them)
  const settings = { ...DEFAULTS, ...pick(providerConfig, PROVIDER_SETTINGS), ...pick(suite.data.defaults, SETTING_KEYS), ...pick(test, SETTING_KEYS) };
  if (options.repeat) settings.repeat = options.repeat;
  if (options.unsure) settings.unsure = options.unsure;
  if (options.timeoutMs) settings.timeout_ms = options.timeoutMs;
  const testSpan = spans.start("test", test.name, { parent: ctx.parent, ref: { suite: suite.file, test: test.id ?? test.name } });
  const result = { suite: suite.file, id: test.id, name: test.name, index, status: "running", passed: 0, total: 0, unsure: false, instances: [], settings, ...(run.settings.until_turn !== null ? { until_turn: run.settings.until_turn } : {}), ...(run.settings.only_turn !== null ? { only_turn: run.settings.only_turn } : {}) };
  run.tests.push(result);
  onEvent({ type: "test:start", test: { suite: suite.file, id: test.id, name: test.name, index } });

  let provider;
  try {
    provider = createProvider(providerConfig, { plugins: ctx.plugins });
  } catch (err) {
    result.status = "error";
    result.reason = err.message;
    spans.end(testSpan, "error");
    onEvent({ type: "test:end", test: result });
    return result;
  }
  const price = providerConfig.price ?? suite.prices?.[providerConfig.model];
  const wantThinking = [...(test.turns ?? []).flatMap((t) => t.expect ?? []), ...(test.expect_conversation ?? [])].some((c) => c.on === "thinking" || typeOf(c) === "thinking.present" || (typeOf(c) === "sequence" && (c.value ?? []).includes("thinking")));

  let rows = suite.dataFiles?.[index] ?? [null];
  const dataOptions = typeof test.data === "object" ? test.data : {};
  if (dataOptions?.limit) rows = rows.slice(0, dataOptions.limit);
  for (let r = 0; r < settings.repeat; r++) {
    for (const [rowIndex, row] of rows.entries()) {
      if (ctx.signal.aborted) break;
      const instance = await runInstance(suite, test, { ...ctx, suite, suitePrices: suite.prices, settings, provider, providerConfig, providerFile, price, wantThinking, parent: testSpan, repeat: r + 1, row: row ? { index: rowIndex + 1, values: row, read: suite.dataColumns?.[index] } : null });
      result.instances.push(instance);
    }
  }
  result.total = result.instances.length;
  result.passed = result.instances.filter((i) => i.status === "passed").length;
  result.unsure = result.instances.some((i) => i.unsure);
  const planned = settings.repeat * rows.length;
  const stopped = result.instances.some((i) => i.status === "stopped") || (ctx.signal.aborted && result.total < planned);
  const rate = result.total ? result.passed / result.total : 0;
  // Stopped, a test whose runs that went wrong already rule out its pass rate went wrong, whatever
  // didn't run (a failure isn't hidden as stopped); else it's stopped
  const ran = result.instances.filter((i) => i.status !== "stopped");
  const wrong = ran.filter((i) => i.status === "failed" || i.status === "error").length;
  const lost = stopped && wrong > 0 && (planned - wrong) / planned < settings.pass_rate;
  if (stopped && !lost) {
    result.status = "stopped";
    // (a run or row its before fixture stopped: why, when the run itself wasn't)
    const said = result.instances.find((i) => i.status === "stopped" && i.reason)?.reason;
    if (said && !result.reason) result.reason = said;
  } else if (result.total && rate >= settings.pass_rate && !stopped) result.status = "passed";
  else if (ran.every((i) => i.status === "error")) {
    result.status = "error";
    // (none ran: its data file has no rows)
    if (!result.total && !result.reason) result.reason = "its data file has no rows: nothing ran";
  } else result.status = "failed";
  result.accuracy = result.total ? Math.round(rate * 1000) / 1000 : undefined;
  const checks = countChecks(result.instances.flatMap((i) => i.results));
  spans.end(testSpan, result.status === "passed" ? "pass" : result.status === "failed" ? "fail" : result.status === "stopped" ? "skipped" : "error", { checks, accuracy: result.accuracy, pass_rate: { passed: result.passed, total: result.total } });
  onEvent({ type: "test:end", test: result });
  return result;
}

async function runInstance(suite, test, ctx) {
  const { spans, run, onEvent, settings, provider, price, wantThinking, scope: outerScope, redactor } = ctx;
  const builtins = { run: { id: run._id }, test: { name: test.name, id: test.id }, repeat: ctx.repeat };
  // Its row's name: on every record of it (the run is redacted as it ends, and every event as it goes)
  const rowName = ctx.row ? rowNameOf(test, ctx.row, outerScope.with({ row: ctx.row.values }).with(builtins)) : undefined;
  const named = rowName ? { row_name: rowName } : {};
  const label = ctx.row ? `${rowLabel(ctx.row.index, rowName)}${settings.repeat > 1 ? ` · run ${ctx.repeat}` : ""}` : `run ${ctx.repeat}`;
  const instanceSpan = spans.start(ctx.row ? "row" : "repeat", label, { parent: ctx.parent });
  const instance = { repeat: ctx.repeat, row: ctx.row?.index ?? null, ...named, status: "running", turns: [], results: [], unsure: false };
  const vars = {};
  let failed = false;
  let errored = false;
  // (an error of its own: not one the run's stop caused, a step or a fixture cut off)
  let broke = false;
  // (why it stops before it starts: a before fixture said to, its run() returning false)
  let halted = null;

  // The provider's before fixtures: what they give is this test's (its secrets, before the run's)
  const fixtureTest = { name: test.name, ...(test.id ? { id: test.id } : {}), repeat: ctx.repeat, ...(ctx.row ? { row: ctx.row.index, ...named } : {}) };
  const fixtureCtx = { plugins: ctx.plugins, scope: outerScope, envName: ctx.envName, spans, parent: instanceSpan, provider: ctx.providerFile };
  let suiteScope = outerScope;
  try {
    const { given, stop } = await ctx.fixtures.before(ctx.providerConfig, { ...fixtureCtx, signal: ctx.signal, test: fixtureTest });
    if (given.size) suiteScope = outerScope.withSecrets(given);
    if (stop) instance.reason = halted = stop;
  } catch (err) {
    errored = true;
    broke ||= !ctx.signal.aborted;
    instance.reason = err.message;
  }
  let scope = suiteScope.with(ctx.row ? { row: ctx.row.values } : {}).with(builtins).with(vars);

  // Setup
  for (const [i, step] of (errored || halted ? [] : test.setup ?? []).entries()) {
    const out = await runStep(step, { ...ctx, scope, parent: instanceSpan, kind: "setup", label: step.name ?? `setup ${i + 1}` });
    Object.assign(vars, out.vars);
    scope = suiteScope.with(ctx.row ? { row: ctx.row.values } : {}).with(builtins).with({ ...vars });
    if (!out.ok) {
      errored = true;
      broke ||= !ctx.signal.aborted;
      instance.reason = `setup "${step.name ?? i + 1}" failed: ${out.reason}`;
      break;
    }
  }

  let session;
  const records = [];
  const turns = test.turns ?? [];
  const only = run.settings.only_turn;
  for (const [i, turn] of turns.entries()) {
    if (run.settings.until_turn !== null && i > run.settings.until_turn) break;
    if (only !== null && i > only) break;
    // {{turn.index}}: the turn's number, as the app and the reports count them (turn 1, turn 2)
    builtins.turn = { index: i + 1 };
    scope = suiteScope.with(ctx.row ? { row: ctx.row.values } : {}).with(builtins).with({ ...vars });
    // Its place in the run's turns, taken now: tests running at once each get their own
    const globalIndex = run.turns.length;
    run.turns.push(null);
    // user_template: the message as the file has it (before variables), so a view can tell whether
    // this record is still of the turn the file now has there
    const key = { suite: suite.file, test: test.id ?? test.name, repeat: ctx.repeat, row: ctx.row?.index ?? null, ...named, index: i, user_template: turn.user };
    // Before the one turn to run: carried (its last record, or its fixed reply), not sent
    if (only !== null && i < only) {
      const kept = ctx.options?.carry?.[test.id ?? test.name]?.[i] ?? null;
      const fixed = typeof turn.reply === "string" ? turn.reply : null;
      if (kept || fixed !== null) {
        // (its message as the file has it, filled in again: the record kept is redacted, and its
        // "[redacted]" mustn't be what the turns after it send as their history)
        const record = kept
          ? { ...structuredClone(kept), ...key, user: safeResolve(scope, turn.user), carried: "last run" }
          : { ...key, user: safeResolve(scope, turn.user), reply: fixed, carried: "fixed reply", events: [], thinking: [], tool_calls: [], results: [], metrics: {} };
        // What it extracted reaches the turns after it, as if it had run
        if (record.variables) {
          Object.assign(vars, record.variables);
          scope = suiteScope.with(ctx.row ? { row: ctx.row.values } : {}).with(builtins).with({ ...vars });
        }
        records.push(record);
        run.turns[globalIndex] = redactor.redact(record);
        instance.turns.push(globalIndex);
        onEvent({ type: "turn:end", index: globalIndex, record: run.turns[globalIndex] });
        continue;
      }
    }
    if (halted || errored || ctx.signal.aborted || (failed && settings.on_fail === "stop")) {
      const why = halted ?? (ctx.signal.aborted ? "the run was stopped" : errored ? instance.reason ?? "an earlier step failed" : "an earlier turn failed (on_fail: stop)");
      const record = { ...key, user: safeResolve(scope, turn.user), skipped: why, events: [], reply: "", thinking: [], tool_calls: [], results: (turn.expect ?? []).map((check) => ({ check, name: describe(check), status: "skipped", reason: why })), metrics: {} };
      run.turns[globalIndex] = record;
      instance.turns.push(globalIndex);
      instance.results.push(...record.results);
      onEvent({ type: "turn:end", index: globalIndex, record });
      continue;
    }
    let message;
    try {
      message = messageText(scope.resolve(turn.user));
    } catch (err) {
      errored = broke = true;
      instance.reason = err.message;
      const record = { ...key, user: messageText(turn.user), error: err.message, events: [], reply: "", thinking: [], tool_calls: [], results: (turn.expect ?? []).map((check) => ({ check, name: describe(check), status: "error", reason: err.message })), metrics: {} };
      run.turns[globalIndex] = record;
      instance.turns.push(globalIndex);
      instance.results.push(...record.results);
      onEvent({ type: "turn:end", index: globalIndex, record });
      continue;
    }
    const turnSpan = spans.start("turn", `turn ${i + 1}`, { parent: instanceSpan, ref: { turn: globalIndex } });
    // (what the page is shown as it starts: redacted, as the record will be)
    onEvent({ type: "turn:start", index: globalIndex, key, user: redactor.redact(message) });
    // (a provider with history: none sends each turn alone: no earlier turns, no session to carry
    // the conversation)
    const alone = ctx.providerConfig?.history === "none";
    const history = alone ? [] : records.map((r, j) => (settings.history === "pinned"
      ? { user: r.user, reply: turns[j].reply ?? r.reply }
      : { user: r.user, reply: r.reply, raw: r.raw_blocks?.at(-1) }));
    const out = await executeTurn({
      provider, message, history, scope, transport: ctx.host.transport, signal: ctx.signal, wantThinking, session: alone ? undefined : session,
      spans, parent: turnSpan, timeoutMs: settings.timeout_ms, retries: settings.retries,
      tools: turn.tools, price, now: ctx.host.now, onEvent, index: globalIndex,
      secretHeader: redactor.isSecretHeader, noteSecret: (value) => { for (const secret of headerSecrets(value)) ctx.secretsUsed.add(secret); },
    });
    session = out.session;
    const record = Object.assign(out.record, key);
    ctx.spend(record.metrics.cost);

    // Extractions, for later turns and steps
    const variables = {};
    for (const [name, path] of Object.entries(turn.extract ?? {})) {
      const source = out.response && typeof out.response === "object" ? out.response : null;
      const value = source ? first(path, source) : undefined;
      if (value !== undefined) {
        variables[name] = value;
        vars[name] = value;
      }
    }
    if (Object.keys(variables).length) record.variables = variables;
    scope = suiteScope.with(ctx.row ? { row: ctx.row.values } : {}).with(builtins).with({ ...vars });

    // Checks
    const conversation = [...records, record];
    const results = await runChecks(turn.expect ?? [], { turn: record, response: out.response, conversation, settings }, { ...ctx, scope, parent: turnSpan, error: out.error, stopped: out.stopped });
    record.results = results;
    for (const r of results) if (r.cost !== undefined) ctx.spend(r.cost);
    const counted = countChecks(results);
    record.metrics.checks = counted;
    const judgedConfidence = results.map((r) => r.confidence).filter((c) => c !== undefined);
    if (judgedConfidence.length) record.metrics.confidence = Math.min(...judgedConfidence);
    // (an unsure result that counts as passed, with warn or pass, is a pass here too)
    const unsurePassed = results.filter((r) => r.status === "unsure" && r.unsure !== "fail").length;
    record.metrics.accuracy = counted.total - counted.skipped ? Math.round(((counted.passed + unsurePassed) / (counted.total - counted.skipped)) * 1000) / 1000 : undefined;
    const turnStatus = out.stopped ? "skipped" : out.error ? "error" : turnFailed(results) ? "fail" : "pass";
    spans.end(turnSpan, turnStatus, record.metrics);
    if (out.stopped) instance.stopped = true;
    if (out.error && !out.stopped) errored = broke = true;
    // (a turn the stop cut short failed nothing: its reply isn't all there)
    if (turnFailed(results) && !out.stopped) failed = true;
    if (warned(results)) instance.unsure = true;

    const stored = redactor.redact(record);
    records.push(record);
    run.turns[globalIndex] = stored;
    instance.turns.push(globalIndex);
    instance.results.push(...results);
    onEvent({ type: "turn:end", index: globalIndex, record: stored });
  }

  // Checks on the whole conversation
  if (records.length && !errored && !halted && !ctx.signal.aborted && run.settings.until_turn === null && run.settings.only_turn === null && (test.expect_conversation ?? []).length) {
    const last = records.at(-1);
    const results = await runChecks(test.expect_conversation, { turn: last, response: null, conversation: records, settings, whole: true }, { ...ctx, scope, parent: instanceSpan });
    instance.conversation_results = results;
    instance.results.push(...results);
    if (turnFailed(results)) failed = true;
    if (warned(results)) instance.unsure = true;
  }

  // Teardown always runs
  for (const [i, step] of (test.teardown ?? []).entries()) {
    await runStep(step, { ...ctx, scope, parent: instanceSpan, kind: "teardown", label: step.name ?? `teardown ${i + 1}`, signal: undefined });
  }

  instance.status = instanceStatus({ halted, stopped: instance.stopped || ctx.signal.aborted, broke, errored, failed, results: instance.results });
  // The provider's after fixtures, however it went (as teardown steps, they don't change its result)
  const afterErrors = await ctx.fixtures.after(ctx.providerConfig, { ...fixtureCtx, test: { ...fixtureTest, status: instance.status } });
  if (afterErrors.length) instance.after_errors = afterErrors;
  spans.end(instanceSpan, { passed: "pass", failed: "fail", error: "error", stopped: "skipped" }[instance.status], { checks: countChecks(instance.results) });
  return instance;
}

// An instance's status from what happened to it. Stopped, what had gone wrong already still counts: a
// failed check makes it failed, an error of its own (not one the stop caused) an error.
function instanceStatus({ halted, stopped, broke, errored, failed, results }) {
  if (halted) return "stopped";                   // a before fixture said to stop
  if (stopped ? broke : errored) return "error";  // it went wrong on its own
  if (stopped && !failed) return "stopped";
  if (failed) return "failed";
  return results.some((r) => r.status === "error") ? "error" : "passed";  // a check errored, none failed
}

// A data row's name (contracts/test-file.md, Data rows): the test's row_name filled in with it
// (scope: the row's), else its first column's value; on one line, cut at 60 characters. undefined:
// none (empty, or row_name couldn't be filled in: the check before a run says why, and a row never
// fails for it)
function rowNameOf(test, row, scope) {
  if (typeof test.row_name !== "string") return rowNameText(firstCell(row.values, row.read));
  try {
    return rowNameText(scope.resolve(test.row_name));
  } catch {
    return undefined;
  }
}

// A setup or teardown step: an HTTP request, with extractions and checks
async function runStep(step, ctx) {
  const { spans, scope, host } = ctx;
  const span = spans.start(ctx.kind, ctx.label, { parent: ctx.parent });
  const vars = {};
  try {
    const req = scope.resolve(step.request);
    const body = req.body === undefined ? undefined : typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const headers = { ...(body !== undefined && typeof req.body !== "string" ? { "content-type": "application/json" } : {}), ...(req.headers ?? {}) };
    const res = await host.transport.send({ url: req.url, method: req.method ?? (body === undefined ? "GET" : "POST"), headers, body }, { signal: ctx.signal });
    let text = "";
    for await (const t of textChunks(res.body)) text += t;
    const parsed = tryJSON(text);
    for (const [name, path] of Object.entries(step.extract ?? {})) {
      const value = parsed && typeof parsed === "object" ? first(path, parsed) : undefined;
      if (value !== undefined) vars[name] = value;
    }
    const pseudo = { user: "", reply: text, response: { status: res.status }, events: [], thinking: [], tool_calls: [], metrics: {} };
    const results = (step.expect ?? []).map((check) => ({ check, name: describe(check), ...(isOff(check) ? OFF : runRule(check, { turn: pseudo, response: parsed })) }));
    const bad = results.find((r) => r.status !== "pass" && !isOff(r.check));
    // (With no checks on, its status says)
    const ok = !bad && ((step.expect ?? []).some((c) => !isOff(c)) ? true : res.status < 400);
    spans.end(span, ok ? "ok" : "error", { status: res.status });
    return { ok, vars, reason: bad ? `${bad.name}: ${bad.reason}` : `status ${res.status}`, results };
  } catch (err) {
    spans.end(span, "error");
    return { ok: false, vars, reason: err.message };
  }
}

const messageText = (user) => String(user ?? "");

function safeResolve(scope, value) {
  try {
    return messageText(scope.resolve(value));
  } catch {
    return messageText(value);
  }
}

export function summarize(run) {
  const tests = { passed: 0, failed: 0, unsure: 0, error: 0, skipped: 0, stopped: 0, total: run.tests.length };
  for (const t of run.tests) {
    if (t.status === "passed" && t.unsure) tests.unsure++;
    else if (t.status in tests) tests[t.status]++;
  }
  // (A turn carried from the last run, by "run this turn only", wasn't run: not counted)
  const ran = run.turns.filter((t) => t && !t.carried);
  const turns = ran.filter((t) => !t.skipped && t.metrics?.ms !== undefined);
  const checks = countChecks([...ran.flatMap((t) => t.results ?? []), ...run.tests.flatMap((t) => t.instances.flatMap((i) => i.conversation_results ?? []))]);
  const tokens = { input: 0, output: 0, thinking: 0 };
  let cost = 0;
  let costKnown = true;
  for (const t of turns) {
    for (const k of Object.keys(tokens)) tokens[k] += t.metrics.tokens?.[k] ?? 0;
    if (t.metrics.cost === undefined) costKnown = false;
    else cost += t.metrics.cost;
    for (const r of t.results ?? []) if (r.cost !== undefined) cost += r.cost;
  }
  const fixtures = run.fixtures ?? [];
  return {
    tests,
    checks,
    ...(fixtures.length ? { fixtures: { total: fixtures.length, failed: fixtures.filter((f) => f.status === "error").length } } : {}),
    turns: turns.length,
    latency: { total: percentiles(turns.map((t) => t.metrics.ms)), ttft: percentiles(turns.map((t) => t.metrics.ttft_ms)) },
    tokens,
    ...(costKnown && turns.length ? { cost: Math.round(cost * 1e6) / 1e6 } : {}),
  };
}
