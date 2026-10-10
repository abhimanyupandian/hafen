// What the views show, read from runs and suites: a test's result, a test's turns in a run, the words
// for statuses. Nothing is checked or timed here; the engine did that (constitution II).

// (from names.js: only what names a check, not what runs one: the page doesn't need JSONPath or JSON Schema)
import { describe as describeCheck } from "hafen/engine/checks/names.js";
// (where a data row is said, as the engine and the reports say it: "row 3: a refund please", or
// "row 3" for a run from before row names)
import { rowLabel } from "hafen/engine/files/data.js";
import { sec, tokens as tokenText, money } from "../lib/format.js";

export { describeCheck, rowLabel };

const testIdOf = (test) => test?.id ?? test?.name;

// A run the engine refused before sending anything: its check before a run (runner.js, preflight:
// what `hafen validate` lists) found problems, so nothing ran. Its error is the first of them, and
// error.all is every one.
export const refusedRun = (run) => run?.status === "error" && Array.isArray(run.error?.all);

// Whether a run was asked to run this test of the suite `file`: its suites have the file, and its
// filters pick the test out (none: every test), as the engine picks them (runner.js, selected)
export function askedFor(run, file, test) {
  if (!run || !test || !(run.suites ?? []).some((s) => (s?.file ?? s) === file)) return false;
  const { ids = [], tests = [], tags = [] } = run.settings?.filters ?? {};
  if (ids.length && !ids.includes(test.id)) return false;
  if (tests.length && !tests.some((t) => String(test.name ?? "").toLowerCase().includes(String(t).toLowerCase()))) return false;
  if (tags.length && !(test.tags ?? []).some((t) => tags.includes(t))) return false;
  return true;
}

// The run's record of a test: { status, passed, total, unsure, instances, … } or null. A run that
// broke off before it reached a test it was asked to run (refused before sending anything, or a
// provider's fixture or the suite's setup failed) has no record of it, but it's still how its last
// try went: { status: "error", reason, refused, unreached: true }, its reason the run's error.
export function testResult(run, file, test) {
  if (!run || !test) return null;
  const record = run.tests?.find((t) => t.suite === file && (t.id ?? t.name) === testIdOf(test));
  if (record || run.status !== "error" || !askedFor(run, file, test)) return record ?? null;
  return { suite: file, id: test.id, name: test.name, status: "error", reason: run.error?.message ?? "the run broke off", refused: refusedRun(run), unreached: true, passed: 0, total: 0, instances: [] };
}

// A test's status in words, and as a status for colour (the engine's: passed, failed, error, stopped,
// skipped; unsure, a pass the judges weren't sure of; couldn't run, refused before sending anything,
// coloured as an error). why: what went wrong, for an error, or why it stopped or was skipped (a
// fixture said to stop), said in full where there's room (the top bar, a tooltip)
export function testStatusText(result, { live = false } = {}) {
  if (!result) return { text: "—", status: "" };
  if (result.status === "running" || live) return { text: "running…", status: "running" };
  // A run up to one turn says so
  const to = result.until_turn !== undefined ? ` · to turn ${result.until_turn + 1}` : result.only_turn !== undefined ? ` · turn ${result.only_turn + 1} only` : "";
  if (result.status === "passed") return result.unsure ? { text: `unsure ${result.passed}/${result.total}${to}`, status: "unsure" } : { text: `passed ${result.passed}/${result.total}${to}`, status: "passed" };
  if (result.status === "failed") return { text: `failed ${result.passed}/${result.total}${to}`, status: "failed" };
  if (result.refused) return { text: "couldn't run", status: "error", why: result.reason };
  return { text: result.status, status: result.status, why: ["error", "stopped", "skipped"].includes(result.status) ? result.reason : undefined };
}

// How a run went, in the same words (a run of one test: that test's): couldn't run (refused before
// sending anything), error (it broke off, or a test erred and none failed), failed, stopped, unsure,
// passed. { text, status (for colour), why }. Works on a run or on its summary (state.js, summaryOf).
export function runOutcome(run) {
  if (!run) return null;
  if (run.status === "running") return { text: "running…", status: "running" };
  if (refusedRun(run)) return { text: "couldn't run", status: "error", why: run.error.message };
  if (run.status === "error") return { text: "error", status: "error", why: run.error?.message };
  const tests = run.tests ?? [];
  if (tests.length === 1 && tests[0].status !== "skipped") {
    const { status, why } = testStatusText(tests[0]);
    return { text: status, status, why };
  }
  if (tests.some((t) => t.status === "failed")) return { text: "failed", status: "failed" };
  const erred = tests.find((t) => t.status === "error");
  if (erred) return { text: "error", status: "error", why: erred.reason };
  if (run.status === "stopped") return { text: "stopped", status: "stopped", why: run.stopped };
  const word = run.verdict ?? run.status;
  return { text: word, status: word };
}

// What a run is called: its one test's name (one that broke off before the test it was asked for:
// that test's, found by its id in the suites, or the name it was asked for by), else
// its suites' names
export function runName(run, suites = []) {
  const tests = run?.tests ?? [];
  if (tests.length === 1) return tests[0].name;
  const files = (run?.suites ?? []).map((s) => s?.file ?? s);
  const { ids = [], tests: names = [] } = run?.settings?.filters ?? {};
  if (!tests.length && ids.length + names.length === 1) {
    const found = suites.filter((s) => files.includes(s.file)).flatMap((s) => s.data?.tests ?? []).find((t) => (ids.length ? t?.id === ids[0] : t?.name === names[0]));
    if (found?.name ?? names[0]) return found?.name ?? names[0];
  }
  return (run?.suites ?? []).map((s) => s?.name ?? s?.file ?? s).join(", ") || "run";
}

// A turn's request stopped on purpose (Esc, Stop): the engine says so as its error ("stopped",
// turn.js), but it isn't a failure of anything, and isn't shown as one
export const stoppedTurn = (record) => record?.error === "stopped";

// The instances (repeat × row) a run has of a test, in the order they ran: [{ repeat, row, row_name? }]
// (row_name: the row's name, as its turns recorded it). The one shown when none is picked is the
// latest (the last), the one going on while it runs.
export function instancesOf(run, file, test) {
  const id = testIdOf(test);
  const seen = new Map();
  for (const t of run?.turns ?? []) {
    if (!t || t.suite !== file || t.test !== id) continue;
    const key = `${t.repeat}|${t.row ?? ""}`;
    if (!seen.has(key)) seen.set(key, { repeat: t.repeat, row: t.row ?? null, ...(t.row_name ? { row_name: t.row_name } : {}) });
  }
  return [...seen.values()];
}

// The instance picked (selection's repeat and row), else the latest
export const pickedInstance = (instances, selection = {}) => instances.find((x) => x.repeat === selection.repeat && (x.row ?? null) === (selection.row ?? null)) ?? instances.at(-1);

// A test's turns in a run, for one instance (default: the latest): [{ record, globalIndex }] by turn index
export function turnsOf(run, file, test, instance) {
  const id = testIdOf(test);
  const all = (run?.turns ?? []).map((t, i) => ({ record: t, globalIndex: i })).filter(({ record }) => record && record.suite === file && record.test === id);
  if (!all.length) return [];
  const shown = instance ?? instancesOf(run, file, test).at(-1);
  return all.filter(({ record }) => record.repeat === shown.repeat && (record.row ?? null) === (shown.row ?? null));
}

// How many times a test runs, as the file says (its repeat, or its suite's default): ×3 when over 1
export const repeatOf = (suite, test) => Number(test?.repeat ?? suite?.data?.defaults?.repeat ?? 1) || 1;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The run's record of each turn the test has now ([{ record, globalIndex } | null], one per turn):
// a record counts for a turn when it was of that turn's message as the file has it (its
// user_template), so a turn added, deleted, moved or changed since the run isn't shown another's
// reply. (Records from before user_template was kept pair by position.)
export function pairTurns(recorded, defined) {
  const used = new Set();
  return defined.map((turn, i) => {
    const fits = (r) => (r.record.user_template === undefined ? r.record.index === i : same(r.record.user_template, turn.user));
    let hit = recorded.find((r) => r.record.index === i && !used.has(r) && fits(r)) ?? null;
    if (!hit) hit = recorded.find((r) => !used.has(r) && r.record.user_template !== undefined && same(r.record.user_template, turn.user)) ?? null;
    if (hit) used.add(hit);
    return hit;
  });
}

// A check's result as it counted: an unsure one as the run's unsure setting said (fail: failed, pass:
// passed, warn: unsure), so a result that failed the test never looks like a pass. (A run from before
// the setting was kept on the result counted it as warn.)
export function countedResult(r) {
  if (r?.status !== "unsure" || (r.unsure !== "fail" && r.unsure !== "pass")) return r;
  return { ...r, status: r.unsure, reason: `unsure: ${r.reason} (unsure counts as ${r.unsure === "fail" ? "failed" : "passed"})` };
}

// Each check's result in a record (null: not run as the file has it now): a result is of the check it
// recorded, so a check added, deleted, moved or changed since isn't shown another's result
export function pairResults(results = [], checks = []) {
  const used = new Set();
  return checks.map((check, j) => {
    let k = results.findIndex((r, n) => !used.has(n) && r.check !== undefined && same(r.check, check));
    if (k === -1 && results[j] && results[j].check === undefined && !used.has(j)) k = j;
    if (k === -1) return null;
    used.add(k);
    return results[k];
  });
}

// A turn's checks counted against what the file has: "4/5", or "5 checks" when none has run as it is
// (a check turned off isn't counted). A turn stopped or skipped ran none of them, and says so rather
// than "0/5".
export function turnChecksText(record, checks = []) {
  if (stoppedTurn(record) && !record.live) return "stopped";
  if (record?.skipped) return "skipped";
  const paired = record ? pairResults(record.results, checks) : [];
  const on = checks.map((c, j) => j).filter((j) => checks[j]?.enabled !== false);
  if (!on.some((j) => paired[j])) return `${on.length} check${on.length === 1 ? "" : "s"}`;
  return `${on.filter((j) => countedResult(paired[j])?.status === "pass").length}/${on.length}`;
}

// A reply's stats line
export function statsLine(record) {
  const m = record?.metrics ?? {};
  const parts = [];
  // (a turn that failed before any text came had no first token)
  if (m.ttft_ms !== undefined && (!record.error || record.reply)) parts.push(`${sec(m.ttft_ms)} to first token`);
  if (m.ms !== undefined) parts.push(sec(m.ms));
  const t = tokenText(m.tokens);
  if (t) parts.push(t);
  if (m.tokens_per_s) parts.push(`${m.tokens_per_s} tok/s`);
  if (m.cost !== undefined) parts.push(money(m.cost));
  return parts.join(" · ");
}

// Checks counted: "6/6"
export const checksText = (results = []) => {
  const run = results.filter((r) => r.status !== "skipped");
  return results.length ? `${results.filter((r) => r.status === "pass").length}/${run.length || results.length}` : "";
};

// A turn's status: from its record, and (given the checks the file has now) only the results of those.
// A turn with no checks (or every one turned off) is "unchecked", run or not: nothing says it's right
// (running, an error, stopped and skipped still say so first).
export const turnStatus = (record, checks) => {
  const unchecked = Array.isArray(checks) && !checks.some((c) => c?.enabled !== false);
  if (!record) return unchecked ? "unchecked" : "";
  if (record.live) return "running";
  if (record.skipped) return "skipped";
  if (stoppedTurn(record)) return "stopped";
  if (record.error) return "error";
  if (unchecked) return "unchecked";
  // (the results of the checks the file has now; one turned off isn't counted)
  const r = (checks ? pairResults(record.results, checks).filter((x, j) => x && checks[j]?.enabled !== false) : record.results ?? []).map(countedResult);
  if (r.some((x) => x.status === "fail" || x.status === "error")) return "failed";
  if (r.some((x) => x.status === "unsure")) return "unsure";
  return r.length ? "passed" : "done";
};

// The words for a thinking event's visibility
export const visibilityText = (v) => ({ full: "full", summary: "summary", progress: "progress notes", omitted: "omitted", redacted: "redacted" })[v] ?? v;

// The span that stands for a turn, check or event in a run
export function spanFor(run, ref) {
  return (run?.spans ?? []).find((s) => s.ref && Object.entries(ref).every(([k, v]) => s.ref[k] === v));
}
