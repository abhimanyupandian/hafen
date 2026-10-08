// How a run went, said one way by the command line (cli/commands.js) and every report (JUnit,
// Markdown, JSON): so a CI system reading any one of them reaches what `hafen run` did.
//
// A test is one case, however many runs and rows it has: it failed only when its pass rate was
// missed. A run or a row that failed inside a test that met its pass rate is said, not counted. (JUnit
// gives each data row a case of its own, rowsOf below, whose statuses reach the test's.) A suite
// that broke before its tests ran (its setup step, or a provider's beforeAll fixture, failed; or a
// problem was found before anything was sent) is a case of its own, an error, with why; one the run
// never reached (it was stopped first) is one too, skipped. A case's status is one of passed, failed,
// error, skipped and stopped.
//
// A data row is said with its name, where there's one ("row 3: a refund please"; a run file from
// before row names: "row 3"), as the run recorded it on its turns and runs.

import { rowLabel } from "../files/data.js";

const STATUSES = ["passed", "failed", "error", "skipped", "stopped"];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const location = (p) => (p?.file ? `${p.file}${p.line ? `:${p.line}${p.column ? `:${p.column}` : ""}` : ""}` : "");

// A test's turns that ran, in the run's order (a turn carried from the last run, by "run this turn
// only", wasn't run: its results aren't this run's)
export const turnsOf = (run, test) => (test.instances ?? []).flatMap((i) => (i.turns ?? []).map((n) => run.turns?.[n])).filter((t) => t && !t.carried);

// A test's checks that ran and those that passed (a check turned off, or never reached, isn't counted)
export function checksOf(test) {
  const ran = (test.instances ?? []).flatMap((i) => i.results ?? []).filter((r) => r.status !== "skipped");
  return { passed: ran.filter((r) => r.status === "pass").length, ran: ran.length };
}

// What a test's turns cost, their judges too (undefined: no cost known)
export function costOf(turns) {
  let cost;
  for (const t of turns) {
    for (const c of [t.metrics?.cost, ...(t.results ?? []).map((r) => r.cost)]) if (c !== undefined) cost = (cost ?? 0) + c;
  }
  return cost;
}

// What went wrong in a test, in order: each turn that broke (once: its checks say the same), each
// check that failed or errored (an unsure one too, when it counts as failed: unsure: fail, the
// default), each check on the whole conversation that did, and each run or row that broke before its
// turns (a setup step, a before fixture). Each is { from, repeat, row, row_name, turn, status, check,
// type, reason, confidence, at, text }: at is where (row 17: its name · run 2 · turn 1), text the
// line the command line prints. (row_name: its row's name, null for none; only where there's a row)
export function problemsOf(test, turns = []) {
  const repeats = (test.settings?.repeat ?? 1) > 1;
  const where = (row, name, repeat, turn) => [row ? rowLabel(row, name) : "", repeats ? `run ${repeat}` : "", turn !== undefined ? `turn ${turn + 1}` : ""].filter(Boolean).join(" · ");
  const order = (a, b) => (a.repeat ?? 0) - (b.repeat ?? 0) || (a.row ?? 0) - (b.row ?? 0) || (a.index ?? 0) - (b.index ?? 0);
  const ran = turns.filter((t) => t && !t.carried).sort(order);
  const out = [];
  for (const t of ran) {
    const at = { from: "turn", repeat: t.repeat ?? null, row: t.row ?? null, row_name: t.row_name ?? null, turn: t.index, at: where(t.row, t.row_name, t.repeat, t.index) };
    // (a turn the run's stop cut short went wrong in nothing: the stop says why, engine/turn.js)
    if (t.error === "stopped") continue;
    if (t.error) {
      out.push(problem({ ...at, status: "error", reason: t.error }));
      continue;
    }
    for (const r of t.results ?? []) {
      const check = { ...at, check: r.name, type: r.check?.type ?? null, reason: r.reason };
      if (r.status === "fail" || r.status === "error") out.push(problem({ ...check, status: r.status }));
      else if (r.status === "unsure" && unsureCounts(r, test) === "fail") out.push(problem({ ...check, status: "unsure", reason: unsureFailed(r), confidence: r.confidence }));
    }
  }
  for (const i of test.instances ?? []) {
    const at = where(i.row, i.row_name, i.repeat);
    const of = { repeat: i.repeat ?? null, row: i.row ?? null, row_name: i.row_name ?? null, turn: null };
    for (const r of i.conversation_results ?? []) {
      const check = { from: "conversation", ...of, check: r.name, type: r.check?.type ?? null, at: [at, "conversation"].filter(Boolean).join(" · ") };
      if (r.status === "fail" || r.status === "error") out.push(problem({ ...check, status: r.status, reason: r.reason }));
      else if (r.status === "unsure" && unsureCounts(r, test) === "fail") out.push(problem({ ...check, status: "unsure", reason: unsureFailed(r), confidence: r.confidence }));
    }
    // A setup step that failed, or a row that never ran a turn: why (a turn that broke says it already)
    if (i.reason && (i.status === "error" || i.status === "failed") && !ran.some((t) => t.row === i.row && t.repeat === i.repeat && t.error)) {
      out.push(problem({ from: "run", ...of, status: i.status === "failed" ? "fail" : "error", reason: i.reason, at }));
    }
  }
  return out;
}

function problem({ from, repeat = null, row = null, row_name = null, turn = null, status, check = null, type = null, reason, confidence, at = "" }) {
  const said = check !== null ? `${status === "error" ? "error · " : ""}${check}: ${reason}`
    : from === "turn" ? `error: ${reason}` : reason;
  return { from, repeat, row, ...(row !== null ? { row_name } : {}), turn, status, check, type, reason, ...(confidence !== undefined ? { confidence } : {}), at, text: at ? `${at} · ${said}` : said };
}

// How an unsure result counts: fail, warn or pass, as the run kept it on the result (the check's, the
// test's or --unsure); a run file from before it did, the test's
export const unsureCounts = (r, test) => r.unsure ?? test?.settings?.unsure ?? "fail";

// Why an unsure result that counts as failed failed, said so a reader of any one report knows, and
// how to let it pass: "unsure: 0.55 within 0.5–1, but confidence 0.1 is below 0.6 (unsure counts as
// failed; --unsure warn to let it pass)"
const unsureFailed = (r) => `unsure: ${r.reason}${r.confidence !== undefined && !/confidence/.test(r.reason ?? "") ? ` (confidence ${r.confidence})` : ""} (unsure counts as failed; --unsure warn to let it pass)`;

// Each unsure result that didn't count as failed (warn, pass), a line each: what the reports add
// ("turn 1 · unsure: noul 0.55: 0.55 within 0.5–1, but confidence 0.1 is below 0.6 (counted as
// passed: unsure is warn)"). (instances: whose whole-conversation checks, the test's)
export function unsureOf(test, turns = [], instances = test.instances ?? []) {
  const repeats = (test.settings?.repeat ?? 1) > 1;
  const where = (row, name, repeat, turn) => [row ? rowLabel(row, name) : "", repeats ? `run ${repeat}` : "", turn].filter(Boolean).join(" · ");
  const passed = (results) => (results ?? []).filter((r) => r.status === "unsure" && unsureCounts(r, test) !== "fail");
  return [
    ...turns.filter((t) => t && !t.carried).flatMap((t) => passed(t.results).map((r) => `${where(t.row, t.row_name, t.repeat, `turn ${t.index + 1}`)} · ${unsurePassed(r, test)}`)),
    ...instances.flatMap((i) => passed(i.conversation_results).map((r) => `${where(i.row, i.row_name, i.repeat, "conversation")} · ${unsurePassed(r, test)}`)),
  ];
}

// An unsure result that counted as passed, as the command line and the reports say it
export const unsurePassed = (r, test) => `unsure: ${r.name}: ${r.reason}${r.confidence !== undefined && !/confidence/.test(r.reason ?? "") ? ` (confidence ${r.confidence})` : ""} (counted as passed: unsure is ${unsureCounts(r, test)})`;

// The run's cases: each test, then one for each suite that broke before its tests ran or that the run
// never reached. { suite (its file), suiteName, name, test (null: a suite's own), status, reason,
// problems }. reason: why it's skipped or stopped, or the test's own (its provider couldn't be made).
export function casesOf(run) {
  const nameOf = (file) => (run.suites ?? []).find((s) => s.file === file)?.name ?? file;
  const cases = (run.tests ?? []).map((test) => {
    // (a test that never ended, the run broken off under it, is an error)
    const status = STATUSES.includes(test.status) ? test.status : "error";
    const problems = problemsOf(test, turnsOf(run, test));
    const reason = test.reason
      ?? (status === "stopped" ? `stopped: ${run.stopped ?? "the run was stopped"}`
        : status === "skipped" ? `not run${run.stopped ? `: ${run.stopped}` : ""}`
        : status !== test.status ? `it never ended: ${run.error?.message ?? "the run broke off"}` : null);
    // (its own reason first, when nothing above says it: its provider couldn't be made, its data had no rows)
    if ((status === "failed" || status === "error") && reason && !problems.some((p) => p.reason === reason)) problems.unshift(problem({ from: "test", status: status === "failed" ? "fail" : "error", reason }));
    return { suite: test.suite, suiteName: nameOf(test.suite), name: test.name, test, status, reason, problems };
  });
  const ran = new Set(cases.map((c) => c.suite));
  for (const suite of run.suites ?? []) {
    if (ran.has(suite.file)) continue;
    const own = suiteCase(run, suite);
    if (own) cases.push(own);
  }
  // A run that broke with nothing above to say so (an error of its own): a case of its own, so no
  // report says it passed
  if (run.status === "error" && !cases.some((c) => c.status === "error")) {
    const reason = run.error?.message ?? "the run broke";
    cases.push({ suite: "", suiteName: "Hafen", name: "(run)", test: null, status: "error", reason, problems: [problem({ from: "setup", status: "error", reason })] });
  }
  return cases;
}

// A test's data rows, each a case of its own in JUnit (contracts/cli.md, Reports), in order: [{ row,
// row_name, name ("refunds [row 3: a refund please]"; the number keeps them in order, and two rows of
// the same name apart), status, reason, problems, instances }]; null for a test without rows, one
// none of whose rows ran, or one skipped or stopped (one case: the run's stop is what it says). A
// row's status agrees with the test's, its pass rate deciding it, so a reader of JUnit alone reaches
// the run's verdict:
//   - a row passed when its runs met the test's pass rate (with no repeat: it passed); its runs that
//     failed are said, not counted
//   - in a test that missed its pass rate, a row that didn't pass failed (an error, when its runs only
//     errored); one the run stopped before it failed anything is stopped
//   - in a test that met its pass rate, a row that didn't pass is skipped, saying it failed within it:
//     "failed, within the test's pass rate (6/8 ≥ 0.75)"
// (c: the test's case, casesOf)
export function rowsOf(c) {
  const t = c.test;
  if (!t || !["passed", "failed", "error"].includes(c.status)) return null;
  const byRow = new Map();
  for (const i of t.instances ?? []) {
    if (!i.row) continue;
    if (!byRow.has(i.row)) byRow.set(i.row, []);
    byRow.get(i.row).push(i);
  }
  if (!byRow.size) return null;
  const rate = t.settings?.pass_rate ?? 1;
  const first = Math.min(...byRow.keys());
  const rows = [...byRow].sort(([a], [b]) => a - b).map(([row, instances]) => {
    const passed = instances.filter((i) => i.status === "passed").length;
    const wrong = instances.filter((i) => i.status === "failed" || i.status === "error");
    const stopped = instances.some((i) => i.status === "stopped");
    const met = !stopped && passed / instances.length >= rate;
    const word = wrong.length && wrong.every((i) => i.status === "error") ? "error" : "failed";
    // (what went wrong in it; a test's own, said of no row, goes with its first)
    const problems = c.problems.filter((p) => p.row === row || (p.row === null && row === first));
    // (its name as its first run recorded it; a run file from before row names has none)
    const name = instances.find((i) => i.row_name)?.row_name ?? null;
    const base = { row, row_name: name, name: `${t.name} [${rowLabel(row, name)}]`, problems, instances };
    if (met) return { ...base, status: "passed", reason: null };
    if (c.status === "passed") return { ...base, status: "skipped", reason: `${word === "error" ? "an error" : "failed"}, within the test's pass rate (${t.passed}/${t.total} ≥ ${rate})` };
    if (!wrong.length) return { ...base, status: "stopped", reason: c.reason ?? `stopped: ${instances.find((i) => i.status === "stopped" && i.reason)?.reason ?? "the run was stopped"}` };
    return { ...base, status: word, reason: null };
  });
  // (a test that failed or errored says so in a row: else, one case, as its test, so none hides it)
  if (c.status !== "passed" && !rows.some((r) => r.status === "failed" || r.status === "error")) return null;
  return rows;
}

// A suite with no tests in the run: broke before them, never reached, or none of its tests were picked
// (--test, --tag: null, nothing to say)
function suiteCase(run, suite) {
  const base = { suite: suite.file, suiteName: suite.name ?? suite.file, test: null, problems: [] };
  const errorCase = (reasons) => ({ ...base, name: "(setup)", status: "error", reason: reasons[0], problems: reasons.map((reason) => problem({ from: "setup", status: "error", reason })) });
  // Problems found before anything was sent: each, where it is (a suite with none: not run)
  if (run.error?.all) {
    const mine = run.error.all.filter((p) => (p.suite ?? p.file) === suite.file);
    if (mine.length) return errorCase(mine.map((p) => (location(p) ? `${location(p)}: ${p.message}` : p.message)));
    return { ...base, name: "(not run)", status: "skipped", reason: `not run: ${plural(run.error.all.length, "problem")} found before anything was sent` };
  }
  const span = (run.spans ?? []).find((s) => s.kind === "suite" && s.ref?.suite === suite.file);
  // (the run's error is the first suite's that broke, named: another's, from its spans)
  const own = typeof run.error?.message === "string" && run.error.message.startsWith(`${suite.file}: `) ? run.error.message.slice(suite.file.length + 2) : null;
  if (own) return errorCase([own]);
  if (span?.status === "error") {
    const step = (run.spans ?? []).find((s) => s.parent === span._id && s.status === "error");
    return errorCase([step ? `${step.kind === "setup" ? "setup step" : step.kind} "${step.name}" failed${step.metrics?.status ? `: status ${step.metrics.status}` : ""}` : "its setup failed"]);
  }
  if (!span && (run.status === "stopped" || run.status === "error")) {
    return { ...base, name: "(not run)", status: "skipped", reason: `not run: ${run.stopped ?? run.error?.message ?? "the run ended first"}` };
  }
  return null;
}

// The cases counted, as the run's summary counts tests ({ passed, failed, unsure, error, skipped,
// stopped, total }: a test that passed with unsure results is unsure, not passed)
export function tally(run, cases = casesOf(run)) {
  const tests = { passed: 0, failed: 0, unsure: 0, error: 0, skipped: 0, stopped: 0, total: cases.length };
  for (const c of cases) {
    if (c.status === "passed" && c.test?.unsure) tests.unsure++;
    else tests[c.status]++;
  }
  return tests;
}

// The checks that ran (a check turned off, or never reached, isn't counted)
export const checksRan = (run) => (run.summary?.checks?.total ?? 0) - (run.summary?.checks?.skipped ?? 0);

// The share of the cases that ran that passed (unsure ones too), as compare counts it: those that
// never ran aren't counted. undefined: none ran.
export function passRate(run, cases = casesOf(run)) {
  const t = tally(run, cases);
  const ran = t.total - t.skipped;
  return ran ? Math.round(((t.passed + t.unsure) / ran) * 1000) / 1000 : undefined;
}

// The counts, as the command line's summary and the Markdown's say them:
// "4 tests · 1 failed · 1 error · 2 skipped · 1 unsure · 412 checks" (errors and skipped when there
// are any; skipped counts the stopped too)
export function countsText(run, cases = casesOf(run)) {
  const t = tally(run, cases);
  const skipped = t.skipped + t.stopped;
  return `${plural(t.total, "test")} · ${t.failed} failed${t.error ? ` · ${plural(t.error, "error")}` : ""}${skipped ? ` · ${skipped} skipped` : ""} · ${t.unsure} unsure · ${plural(checksRan(run), "check")}`;
}
