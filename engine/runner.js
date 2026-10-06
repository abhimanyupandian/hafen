// Running suites (data-model.md; contracts/run-file.md): suites → tests → repeats × data rows → turns,
// with setup and teardown steps, extractions, rule checks and judges, every step timed as a span. The
// run record is built as it goes and returned, redacted, at the end.
//
// The host gives everything platform-specific: { transport, files, secrets(NAME), now(), clock(),
// where, sha256?(text) }. onEvent(event) reports progress for a UI or a CLI (see EVENTS below).

import { isJudged, runRule, typeOf, describe, valuesOf } from "./checks/index.js";
import { createFixtures } from "./fixtures.js";
import { fixtureProvides, loadPlugins, PLUGIN_FILE, pluginNames, versionProblems } from "./plugins.js";
import { problemsFor, SIMULATE_NOT_BUILT, turnNotBuilt } from "./files/suite-file.js";
import { first } from "./jsonpath.js";
import { runJudged } from "./judges/index.js";
import { createProvider } from "./providers/index.js";
import { createRedactor } from "./redact.js";
import { readScope } from "./scopes.js";
import { closeAll, createSpans } from "./spans.js";
import { executeTurn } from "./turn.js";
import { anySignal, basename, percentiles, short, textChunks, uid } from "./util.js";
import { createScope, MissingVariable } from "./vars.js";
import { tryJSON } from "./providers/http.js";
import { RUN_KIND, RUN_VERSION } from "./run-kind.js";

export { RUN_KIND, RUN_VERSION } from "./run-kind.js";

// What onEvent receives:
//   run:start {run}  ·  span {action: "start" | "end", span}  ·  test:start {test}  ·  test:end {test}
//   turn:start {index, key, user}  ·  turn:event {index, event}  ·  turn:retry {index, …}
//   turn:end {index, record}  ·  log {text, kind}  ·  run:end {run}

const DEFAULTS = { repeat: 1, pass_rate: 1, history: "live", on_fail: "continue", unsure: "warn", unsure_below: 0.6, timeout_ms: 120000, retries: 2 };
const SETTING_KEYS = Object.keys(DEFAULTS).concat(["network"]);

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
  };
}

// What runs at once: groups (contracts/test-file.md, Groups). The suites of a run with the same
// `group` run one after another, in order; different groups at the same time (the suites with none
// are one group). Within a suite, its tests the same way, by their `group`. A test's runs, rows and
// turns always go in order.
//
// options: { env, vars, tests: [names], tags, ids: [test ids], repeat, unsure, maxCost,
//            bail, timeoutMs, network, redact: [patterns], load, untilTurn }
// untilTurn (a turn's index): each test runs up to and including that turn (the ones before it are
// its history); the turns after it and the checks on the whole conversation don't run.
// onlyTurn (a turn's index), with carry ({ [test id or name]: [the records of its earlier turns, by
// index] }: the app's last run of it): only that turn is sent; each turn before it is carried, not
// sent (its record as it was, or its fixed `reply`), as the history it goes with; a turn with
// neither is sent, as untilTurn would. The turns after it and the conversation checks don't run.
export async function runSuites({ suites, host, options = {}, onEvent: emit = () => {}, signal, plugins = {} }) {
  const settings = {
    env: options.env ?? null,
    filters: { tests: options.tests ?? [], tags: options.tags ?? [], ids: options.ids ?? [] },
    unsure: options.unsure ?? null,
    network: options.network ?? null,
    max_cost: options.maxCost ?? null,
    until_turn: Number.isInteger(options.untilTurn) && options.untilTurn >= 0 && !Number.isInteger(options.onlyTurn) ? options.untilTurn : null,
    only_turn: Number.isInteger(options.onlyTurn) && options.onlyTurn >= 0 ? options.onlyTurn : null,
  };
  const run = newRun({ mode: "test", host, settings });
  const stopper = new AbortController();
  const runSignal = anySignal([signal, stopper.signal]);
  const secretsUsed = new Set();
  const redactor = createRedactor({ secrets: secretsUsed, patterns: options.redact ?? [] });
  // A scope's secrets: what its providers' fixtures gave in this run (a login's cookie), then the host's
  const fixtures = createFixtures({ used: secretsUsed });
  const secretsFor = (envName) => (name) => fixtures.value(name, envName) ?? host.secrets(name, { env: envName });
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

  // Each scope's variables, read once (environments/<scope>.yml)
  const scopes = new Map();
  const scopeFor = async (name) => {
    if (!scopes.has(name)) scopes.set(name, await readScope(host, name));
    return scopes.get(name);
  };

  // Each suite's plugins, loaded (each in its worker) before anything is sent: the ones it names, and
  // the folder's (plugins/*.js, as Settings → Plugins lists them), which any suite may use by name
  // without naming them. The folder's are loaded once (for each scope's secrets), and only when a
  // suite uses a name its own don't give.
  const suitePlugins = new Map();
  const folderPlugins = new Map();  // scope name → loaded
  const folderFor = async (envName) => {
    if (!folderPlugins.has(envName)) {
      const files = host.list ? (await host.list()).filter((f) => PLUGIN_FILE.test(f)) : [];
      folderPlugins.set(envName, await loadPlugins(host, files, null, { secrets: secretsFor(envName), used: secretsUsed, transport: host.transport }));
    }
    return folderPlugins.get(envName);
  };
  const closePlugins = () => {
    for (const loaded of [...suitePlugins.values(), ...folderPlugins.values()]) loaded.close();
  };

  // Nothing is sent while any suite has a problem
  const problems = [];
  for (const s of suites) {
    const envName = options.env ?? Object.keys(s.data?.environments ?? {})[0];
    const scope = await scopeFor(envName);
    const loaded = (s.data?.plugins ?? []).length
      ? await loadPlugins(host, s.data.plugins, s.file, { secrets: secretsFor(envName), used: secretsUsed, transport: host.transport })
      : { plugins: {}, problems: [], close: () => {} };
    suitePlugins.set(s.file, loaded);
    const missing = [...pluginNames(s)].filter((name) => !loaded.plugins[name] && !plugins[name]);
    if (missing.length) {
      const folder = await folderFor(envName);
      for (const name of missing) {
        if (folder.plugins[name]) loaded.plugins[name] = folder.plugins[name];
        // (one that didn't load, its file named as the plugin: why)
        else problems.push(...folder.problems.filter((p) => basename(p.file ?? "").replace(/\.m?js$/i, "") === name).map((p) => ({ ...p, file: s.file, message: `${p.file}: ${p.message}` })));
      }
    }
    problems.push(...loaded.problems, ...versionProblems(s, { ...plugins, ...loaded.plugins }));
    // (a name a provider's fixture gives is set, though only once the fixture has run)
    const given = fixtureProvides(Object.values(s.providers ?? {}), { ...plugins, ...loaded.plugins });
    problems.push(...(scope?.errors ?? []), ...problemsFor(s, options.vars ?? {}, (name) => (given.has(name) ? "(a fixture's)" : secretsFor(envName)(name)), scope));
    // Load mode (many requests at once, ramped up, with percentiles: spec US11) isn't built: a load
    // test asked to run (--load) would be sent once, as any test, and look like a load test that
    // passed. Said instead, before anything is sent.
    if (options.load) {
      for (const test of (s.data?.tests ?? []).filter((t) => t?.load && selected(t, options))) {
        problems.push({ file: s.file, message: `"${test.name}" is a load test, and load tests can't run yet (load mode isn't built): leave out --load to skip it` });
      }
    }
  }
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
            run, host, options, onEvent, signal: runSignal, spans, parent: runSpan, redactor, secretsUsed, spend, scopeFor, fixtures, secretsFor,
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
  if (run.status === "done") {
    const tests = run.tests;
    run.verdict = tests.some((t) => t.status === "failed" || t.status === "error") ? "failed" : tests.some((t) => t.unsure) ? "unsure" : "passed";
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
  const envName = options.env ?? Object.keys(data.environments ?? {})[0];
  const chosenScope = await ctx.scopeFor(envName);
  // (A scope with its own file is one, even when this suite has no environment of that name)
  if (options.env && !(data.environments ?? {})[options.env] && Object.keys(data.environments ?? {}).length && !chosenScope?.file) {
    throw Object.assign(new Error(`${suite.file}: there's no environment or scope "${options.env}" (${Object.keys(data.environments).join(", ")})`), { setup: true });
  }
  const fileLayers = [options.vars ?? {}, data.variables ?? {}, (data.environments ?? {})[envName] ?? {}];
  const base = createScope({
    layers: fileLayers,
    trusted: fileLayers,
    secrets: ctx.secretsFor(envName),
    used: ctx.secretsUsed,
    scope: chosenScope,
  });
  const suiteSpan = spans.start("suite", suite.name, { parent, ref: { suite: suite.file } });
  const tests = (data.tests ?? []).map((test, index) => ({ test, index })).filter(({ test }) => selected(test, options));
  // The fixtures of the providers its tests use (a login), before its setup steps, which can use what
  // they give too. Each runs once in the run, however many suites use it.
  for (const config of new Set(tests.map(({ index }) => suite.providers[`test:${index}`] ?? suite.provider))) {
    try {
      await ctx.fixtures.ensure(config, { plugins: ctx.plugins, scope: base, envName, spans, parent: suiteSpan, signal });
    } catch (err) {
      spans.end(suiteSpan, "error");
      throw Object.assign(new Error(`${suite.file}: ${err.message}`), { setup: true });
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
      const result = await runTest(suite, test, index, { ...ctx, scope, parent: suiteSpan });
      if (options.bail && (result.status === "failed" || result.status === "error")) ctx.stop(`stopped at the first failure (${test.name})`);
    }
  }));
  // Tests that never started: skipped
  for (const { test, index } of tests) if (!started.has(index)) ctx.run.tests.push({ suite: suite.file, id: test.id, name: test.name, index, status: "skipped", passed: 0, total: 0, instances: [] });
  for (const [i, step] of (data.teardown ?? []).entries()) {
    await runStep(step, { ...ctx, scope, parent: suiteSpan, kind: "teardown", label: step.name ?? `teardown ${i + 1}`, signal: undefined });
  }
  // The suite's bar says how its tests went: failed if any did, else passed (stopped: skipped)
  const mine = ctx.run.tests.filter((t) => t.suite === suite.file);
  const status = signal.aborted ? "skipped" : mine.some((t) => t.status === "failed" || t.status === "error") ? "fail" : mine.some((t) => t.status === "passed") ? "pass" : "ok";
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
  const settings = { ...DEFAULTS, ...pick(suite.data.defaults, SETTING_KEYS), ...pick(test, SETTING_KEYS) };
  if (options.repeat) settings.repeat = options.repeat;
  if (options.unsure) settings.unsure = options.unsure;
  if (options.timeoutMs) settings.timeout_ms = options.timeoutMs;
  if (options.network) settings.network = options.network;
  const testSpan = spans.start("test", test.name, { parent: ctx.parent, ref: { suite: suite.file, test: test.id ?? test.name } });
  const result = { suite: suite.file, id: test.id, name: test.name, index, status: "running", passed: 0, total: 0, unsure: false, instances: [], settings, ...(run.settings.until_turn !== null ? { until_turn: run.settings.until_turn } : {}), ...(run.settings.only_turn !== null ? { only_turn: run.settings.only_turn } : {}) };
  run.tests.push(result);
  onEvent({ type: "test:start", test: { suite: suite.file, id: test.id, name: test.name, index } });

  if (test.load && !options.load) {
    result.status = "skipped";
    result.reason = "a load test (needs --load, or confirming in the app)";
    spans.end(testSpan, "skipped");
    onEvent({ type: "test:end", test: result });
    return result;
  }

  // Simulated users aren't built: said, rather than pass having sent nothing
  if (test.simulate) {
    result.status = "error";
    result.reason = SIMULATE_NOT_BUILT.replace(": running this test is an error", "");
    spans.end(testSpan, "error");
    onEvent({ type: "test:end", test: result });
    return result;
  }

  const providerConfig = suite.providers[`test:${index}`] ?? suite.provider;
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
      const instance = await runInstance(suite, test, { ...ctx, suite, suitePrices: suite.prices, settings, provider, providerConfig, price, wantThinking, parent: testSpan, repeat: r + 1, row: row ? { index: rowIndex + 1, values: row } : null });
      result.instances.push(instance);
    }
  }
  result.total = result.instances.length;
  result.passed = result.instances.filter((i) => i.status === "passed").length;
  result.unsure = result.instances.some((i) => i.unsure);
  const stopped = result.instances.some((i) => i.status === "stopped") || (ctx.signal.aborted && result.total < settings.repeat * rows.length);
  const rate = result.total ? result.passed / result.total : 0;
  if (stopped && result.total === 0) result.status = "stopped";
  else if (result.total && rate >= settings.pass_rate && !stopped) result.status = "passed";
  else if (stopped) result.status = "stopped";
  else if (result.instances.every((i) => i.status === "error")) {
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
  const { spans, run, onEvent, settings, provider, price, wantThinking, scope: suiteScope, redactor } = ctx;
  const label = ctx.row ? `row ${ctx.row.index}${settings.repeat > 1 ? ` · run ${ctx.repeat}` : ""}` : `run ${ctx.repeat}`;
  const instanceSpan = spans.start(ctx.row ? "row" : "repeat", label, { parent: ctx.parent });
  const instance = { repeat: ctx.repeat, row: ctx.row?.index ?? null, status: "running", turns: [], results: [], unsure: false };
  const vars = {};
  const builtins = { run: { id: run._id }, test: { name: test.name, id: test.id }, repeat: ctx.repeat };
  let scope = suiteScope.with(ctx.row ? { row: ctx.row.values } : {}).with(builtins).with(vars);
  let failed = false;
  let errored = false;

  // Setup
  for (const [i, step] of (test.setup ?? []).entries()) {
    const out = await runStep(step, { ...ctx, scope, parent: instanceSpan, kind: "setup", label: step.name ?? `setup ${i + 1}` });
    Object.assign(vars, out.vars);
    scope = suiteScope.with(ctx.row ? { row: ctx.row.values } : {}).with(builtins).with({ ...vars });
    if (!out.ok) {
      errored = true;
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
    // Its place in the run's turns, taken now: tests running at once each get their own
    const globalIndex = run.turns.length;
    run.turns.push(null);
    // user_template: the message as the file has it (before variables), so a view can tell whether
    // this record is still of the turn the file now has there
    const key = { suite: suite.file, test: test.id ?? test.name, repeat: ctx.repeat, row: ctx.row?.index ?? null, index: i, user_template: turn.user };
    // Before the one turn to run: carried (its last record, or its fixed reply), not sent
    if (only !== null && i < only) {
      const kept = ctx.options?.carry?.[test.id ?? test.name]?.[i] ?? null;
      const fixed = typeof turn.reply === "string" ? turn.reply : null;
      if (kept || fixed !== null) {
        const record = kept
          ? { ...structuredClone(kept), ...key, carried: "last run" }
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
    if (errored || ctx.signal.aborted || (failed && settings.on_fail === "stop")) {
      const why = ctx.signal.aborted ? "the run was stopped" : errored ? instance.reason ?? "an earlier step failed" : "an earlier turn failed (on_fail: stop)";
      const record = { ...key, user: safeResolve(scope, turn.user), skipped: why, events: [], reply: "", thinking: [], tool_calls: [], results: (turn.expect ?? []).map((check) => ({ check, name: describe(check), status: "skipped", reason: why })), metrics: {} };
      run.turns[globalIndex] = record;
      instance.turns.push(globalIndex);
      instance.results.push(...record.results);
      onEvent({ type: "turn:end", index: globalIndex, record });
      continue;
    }
    let message;
    try {
      // (attachments, an image: not built, so not sent without them)
      const notYet = turnNotBuilt(turn);
      if (notYet) throw new Error(notYet.replace(": running this turn is an error", ""));
      message = messageText(scope.resolve(turn.user));
    } catch (err) {
      errored = true;
      instance.reason = err.message;
      const record = { ...key, user: typeof turn.user === "string" ? turn.user : messageText(turn.user), error: err.message, events: [], reply: "", thinking: [], tool_calls: [], results: (turn.expect ?? []).map((check) => ({ check, name: describe(check), status: "error", reason: err.message })), metrics: {} };
      run.turns[globalIndex] = record;
      instance.turns.push(globalIndex);
      instance.results.push(...record.results);
      onEvent({ type: "turn:end", index: globalIndex, record });
      continue;
    }
    const turnSpan = spans.start("turn", `turn ${i + 1}`, { parent: instanceSpan, ref: { turn: globalIndex } });
    // (what the page is shown as it starts: redacted, as the record will be)
    onEvent({ type: "turn:start", index: globalIndex, key, user: redactor.redact(message) });
    const history = records.map((r, j) => (settings.history === "pinned"
      ? { user: r.user, reply: turns[j].reply ?? r.reply }
      : { user: r.user, reply: r.reply, raw: r.raw_blocks?.at(-1) }));
    const out = await executeTurn({
      provider, message, history, scope, transport: ctx.host.transport, signal: ctx.signal, wantThinking, session,
      spans, parent: turnSpan, timeoutMs: settings.timeout_ms, retries: settings.retries, network: settings.network,
      tools: turn.tools, price, now: ctx.host.now, onEvent, index: globalIndex,
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
    const results = await runChecks(turn.expect ?? [], { turn: record, response: out.response, conversation, settings }, { ...ctx, scope, parent: turnSpan, error: out.error });
    record.results = results;
    for (const r of results) if (r.cost !== undefined) ctx.spend(r.cost);
    const counted = countChecks(results);
    record.metrics.checks = counted;
    const judgedConfidence = results.map((r) => r.confidence).filter((c) => c !== undefined);
    if (judgedConfidence.length) record.metrics.confidence = Math.min(...judgedConfidence);
    record.metrics.accuracy = counted.total - counted.skipped ? Math.round(((counted.passed + (settings.unsure === "fail" ? 0 : counted.unsure)) / (counted.total - counted.skipped)) * 1000) / 1000 : undefined;
    const turnStatus = out.stopped ? "skipped" : out.error ? "error" : turnFailed(results, settings) ? "fail" : "pass";
    spans.end(turnSpan, turnStatus, record.metrics);
    if (out.stopped) instance.stopped = true;
    if (out.error && !out.stopped) errored = true;
    if (turnFailed(results, settings)) failed = true;
    if (results.some((r) => r.status === "unsure") && settings.unsure === "warn") instance.unsure = true;

    const stored = redactor.redact(record);
    records.push(record);
    run.turns[globalIndex] = stored;
    instance.turns.push(globalIndex);
    instance.results.push(...results);
    onEvent({ type: "turn:end", index: globalIndex, record: stored });
  }

  // Checks on the whole conversation
  if (records.length && !errored && !ctx.signal.aborted && run.settings.until_turn === null && run.settings.only_turn === null && (test.expect_conversation ?? []).length) {
    const last = records.at(-1);
    const results = await runChecks(test.expect_conversation, { turn: last, response: null, conversation: records, settings, whole: true }, { ...ctx, scope, parent: instanceSpan });
    instance.conversation_results = results;
    instance.results.push(...results);
    if (turnFailed(results, settings)) failed = true;
  }

  // Teardown always runs
  for (const [i, step] of (test.teardown ?? []).entries()) {
    await runStep(step, { ...ctx, scope, parent: instanceSpan, kind: "teardown", label: step.name ?? `teardown ${i + 1}`, signal: undefined });
  }

  instance.status = instance.stopped || ctx.signal.aborted ? "stopped" : errored ? "error" : failed || instance.results.some((r) => r.status === "error") ? "failed" : "passed";
  if (instance.status === "failed" && !failed && instance.results.some((r) => r.status === "error")) instance.status = "error";
  spans.end(instanceSpan, { passed: "pass", failed: "fail", error: "error", stopped: "skipped" }[instance.status], { checks: countChecks(instance.results) });
  return instance;
}

const turnFailed = (results, settings) => results.some((r) => r.status === "fail" || (r.status === "unsure" && settings.unsure === "fail"));

// A check turned off (enabled: false) is skipped, and says so (contracts/checks.md)
const isOff = (check) => check?.enabled === false;
const OFF = { status: "skipped", reason: "turned off (enabled: false)" };

// A turn's checks: rule checks at once, judged ones together (contracts/checks.md)
async function runChecks(checks, checkCtx, ctx) {
  const { spans, parent } = ctx;
  const results = new Array(checks.length);
  const spanIds = [];
  const judged = [];
  const pluginChecks = [];
  // Variables in checks resolve first ({{row.want}}); one that can't is that check's error (one
  // turned off isn't looked at)
  const resolved = checks.map((check) => {
    if (isOff(check)) return { check };
    try {
      return { check: ctx.scope ? ctx.scope.resolve(check) : check };
    } catch (err) {
      return { check, error: err.message };
    }
  });
  for (const [index, check] of checks.entries()) {
    const name = describe(check);
    spanIds[index] = spans.start("check", name, { parent, ref: { check: index } });
    if (isOff(check)) {
      results[index] = { ...OFF };
      continue;
    }
    if (resolved[index].error) {
      results[index] = { status: "error", reason: resolved[index].error };
      continue;
    }
    if (ctx.error && !(check.on === "events" || typeOf(check) === "latency" || typeOf(check) === "status")) {
      results[index] = { status: "skipped", reason: `the turn failed: ${short(ctx.error, 120)}` };
      continue;
    }
    const plugin = ctx.plugins?.[typeOf(check)];
    if (plugin?.check) pluginChecks.push({ index, check: resolved[index].check, plugin });
    else if (isJudged(check)) judged.push({ index, check: resolved[index].check });
    else results[index] = runRule(resolved[index].check, checkCtx);
  }
  // A check plugin's checks (in its worker): given what the check's on/path selects
  for (const { index, check, plugin } of pluginChecks) {
    try {
      let value;
      try {
        const values = valuesOf(check, checkCtx);
        value = values.length === 1 ? values[0] : values;
      } catch (err) {
        results[index] = { status: "error", reason: err.message };
        continue;
      }
      const t = checkCtx.turn ?? {};
      const turn = { user: t.user, reply: t.reply, thinking: t.thinking, tool_calls: t.tool_calls, usage: t.usage, metrics: t.metrics, status: t.response?.status };
      const conversation = (checkCtx.conversation ?? []).map((x) => ({ user: x.user, reply: x.reply }));
      const out = await plugin.check({ value, turn, conversation, params: check }, { signal: ctx.signal });
      const status = ["pass", "fail", "unsure", "skipped", "error"].includes(out?.status) ? out.status : "error";
      results[index] = {
        status, reason: out?.reason ?? (status === "error" ? "the plugin's check gave no status" : ""),
        ...(out?.value !== undefined ? { value: out.value } : {}), ...(out?.confidence !== undefined ? { confidence: out.confidence } : {}),
        ...(out?.actual !== undefined ? { actual: out.actual } : {}), ...(out?.expected !== undefined ? { expected: out.expected } : {}),
      };
    } catch (err) {
      results[index] = { status: "error", reason: err.message };
    }
  }
  if (judged.length) {
    const judgedResults = await runJudged(judged, checkCtx, {
      suite: ctx.suite, scope: ctx.scope, transport: ctx.host.transport, signal: ctx.signal, spans,
      parentFor: (index) => spanIds[index], prices: ctx.suitePrices, plugins: ctx.plugins, redact: ctx.redactor?.redact,
    });
    for (const [index, r] of judgedResults) results[index] = r;
  }
  return checks.map((check, index) => {
    const r = results[index] ?? { status: "error", reason: "the check didn't run" };
    const name = r.value !== undefined && typeof r.value === "number" && isJudged(check) ? `${describe(check)} ${round2(r.value)}` : describe(check);
    spans.end(spanIds[index], r.status, { ...(r.confidence !== undefined ? { confidence: r.confidence } : {}) });
    spans.update(spanIds[index], { name });
    return { check, name, ...r };
  });
}

const round2 = (n) => Math.round(n * 100) / 100;

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

function messageText(user) {
  if (typeof user === "string") return user;
  if (Array.isArray(user)) return user.map((p) => p.text ?? "").filter(Boolean).join("\n");
  return String(user ?? "");
}

function safeResolve(scope, value) {
  try {
    return messageText(scope.resolve(value));
  } catch {
    return messageText(value);
  }
}

export function countChecks(results) {
  const c = { passed: 0, failed: 0, unsure: 0, skipped: 0, error: 0, total: results.length };
  for (const r of results) {
    if (r.status === "pass") c.passed++;
    else if (r.status === "fail") c.failed++;
    else if (r.status === "unsure") c.unsure++;
    else if (r.status === "skipped") c.skipped++;
    else c.error++;
  }
  return c;
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
  return {
    tests,
    checks,
    turns: turns.length,
    latency: { total: percentiles(turns.map((t) => t.metrics.ms)), ttft: percentiles(turns.map((t) => t.metrics.ttft_ms)) },
    tokens,
    ...(costKnown && turns.length ? { cost: Math.round(cost * 1e6) / 1e6 } : {}),
  };
}
