// What the views show, read from runs and suites: a test's result, a test's turns in a run, the words
// for statuses. Nothing is checked or timed here; the engine did that (constitution II).

// (from names.js: only what names a check, not what runs one: the page doesn't need JSONPath or JSON Schema)
import { describe as describeCheck } from "../../../engine/checks/names.js";
import { sec, tokens as tokenText, money } from "../lib/format.js";

export { describeCheck };

const testIdOf = (test) => test?.id ?? test?.name;

// The run's record of a test: { status, passed, total, unsure, instances, … } or null
export function testResult(run, file, test) {
  if (!run || !test) return null;
  return run.tests?.find((t) => t.suite === file && (t.id ?? t.name) === testIdOf(test)) ?? null;
}

// A test's status in words, and as a status for colour
export function testStatusText(result, { live = false } = {}) {
  if (!result) return { text: "—", status: "" };
  if (result.status === "running" || live) return { text: "running…", status: "running" };
  // A run up to one turn says so
  const to = result.until_turn !== undefined ? ` · to turn ${result.until_turn + 1}` : result.only_turn !== undefined ? ` · turn ${result.only_turn + 1} only` : "";
  if (result.status === "passed") return result.unsure ? { text: `unsure ${result.passed}/${result.total}${to}`, status: "unsure" } : { text: `passed ${result.passed}/${result.total}${to}`, status: "passed" };
  if (result.status === "failed") return { text: `failed ${result.passed}/${result.total}${to}`, status: "failed" };
  return { text: result.status, status: result.status };
}

// The instances (repeat × row) a run has of a test, in the order they ran: [{ repeat, row }]. The one
// shown when none is picked is the latest (the last), the one going on while it runs.
export function instancesOf(run, file, test) {
  const id = testIdOf(test);
  const seen = new Map();
  for (const t of run?.turns ?? []) {
    if (!t || t.suite !== file || t.test !== id) continue;
    const key = `${t.repeat}|${t.row ?? ""}`;
    if (!seen.has(key)) seen.set(key, { repeat: t.repeat, row: t.row ?? null });
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
// (a check turned off isn't counted)
export function turnChecksText(record, checks = []) {
  const paired = record ? pairResults(record.results, checks) : [];
  const on = checks.map((c, j) => j).filter((j) => checks[j]?.enabled !== false);
  if (!on.some((j) => paired[j])) return `${on.length} check${on.length === 1 ? "" : "s"}`;
  return `${on.filter((j) => paired[j]?.status === "pass").length}/${on.length}`;
}

// A reply's stats line
export function statsLine(record) {
  const m = record?.metrics ?? {};
  const parts = [];
  if (m.ttft_ms !== undefined) parts.push(`${sec(m.ttft_ms)} to first token`);
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
// (running, an error and skipped still say so first).
export const turnStatus = (record, checks) => {
  const unchecked = Array.isArray(checks) && !checks.some((c) => c?.enabled !== false);
  if (!record) return unchecked ? "unchecked" : "";
  if (record.live) return "running";
  if (record.skipped) return "skipped";
  if (record.error) return "error";
  if (unchecked) return "unchecked";
  // (the results of the checks the file has now; one turned off isn't counted)
  const r = checks ? pairResults(record.results, checks).filter((x, j) => x && checks[j]?.enabled !== false) : record.results ?? [];
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
