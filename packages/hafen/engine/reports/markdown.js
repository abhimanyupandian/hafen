// A Markdown summary (contracts/cli.md, Reports): for a CI job page or a pull request comment. Its
// counts, each test's and what went wrong are the command line's (reports/outcome.js): the tests that
// failed or errored and why, a line each; then those skipped or stopped, the runs or rows that failed
// in a test that passed, and the unsure results.

import { casesOf, checksOf, costOf, countsText, turnsOf, unsureOf } from "./outcome.js";
import { rowLabel } from "../files/data.js";

const sec = (ms) => (ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`);
// A cost: to the cent, or a smaller one to two significant digits ($0.000017, never $0.0000). The
// command line's lines use it too.
export const money = (usd) => {
  if (usd === undefined || usd === null) return "—";
  if (usd === 0 || usd >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(Math.min(20, 1 - Math.floor(Math.log10(usd)))).replace(/0+$/, "")}`;
};
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
// (an unsure result that counts as failed: failed, its reason saying it was unsure and how to let it pass)
const WORD = { fail: "failed", error: "error", unsure: "failed" };

export function markdown(run) {
  const s = run.summary ?? {};
  const cases = casesOf(run);
  const icon = { passed: "✓", failed: "✗", error: "✗", skipped: "–", stopped: "–" };
  // (a run whose tests passed, but that regressed past --fail-on, isn't said to have passed; nor one
  // with no tests: the command line says that's an error)
  const done = run.status !== "done" ? run.status : cases.length ? run.verdict : "no tests ran";
  const verdict = done === "passed" && run.baseline?.regressed?.length ? "regressed" : done;
  const lines = [
    `## Hafen · ${verdict}`,
    "",
    `${countsText(run, cases)} · p50 ${sec(s.latency?.total?.p50)} · p95 ${sec(s.latency?.total?.p95)} · ${money(s.cost)} · ${sec(run.ms)}`,
    "",
  ];
  if (run.error) lines.push(`**Setup error:** ${run.error.file ? `\`${run.error.file}${run.error.line ? `:${run.error.line}:${run.error.column}` : ""}\` ` : ""}${run.error.message}`, "");
  if (run.stopped) lines.push(`**Stopped:** ${run.stopped}`, "");
  if (cases.length) {
    lines.push("| | Test | Suite | Passed | Checks | p95 | Cost |", "|---|---|---|---|---|---|---|");
    for (const c of cases) {
      const t = c.test;
      // (a suite's own: it broke before its tests ran, or wasn't reached)
      if (!t) {
        lines.push(`| ${icon[c.status]} | ${cell(c.name)} | ${cell(c.suiteName)} | — | — | — | — |`);
        continue;
      }
      const turns = turnsOf(run, t);
      const checks = checksOf(t);
      const p95 = percentile(turns.map((x) => x.metrics?.ms), 95);
      lines.push(`| ${c.status === "passed" && t.unsure ? "!" : icon[c.status]} | ${cell(c.name)} | ${cell(c.suiteName)} | ${t.passed}/${t.total} | ${checks.passed}/${checks.ran} | ${sec(p95)} | ${money(costOf(turns))} |`);
    }
    lines.push("");
  }
  // What went wrong, a line each: the suite and test, where (row, run, turn, or the conversation), how
  // and why
  const who = (c) => `**${cell(c.suiteName)} › ${cell(c.name)}**`;
  const said = (c, p) => `- ${who(c)} · ${p.at ? `${p.at} · ` : ""}${WORD[p.status]} · ${p.check !== null ? `\`${cell(p.check)}\`: ` : ""}${cell(p.reason)}`;
  const section = (title, items) => {
    if (!items.length) return;
    lines.push(`### ${title}`, "", ...items.slice(0, 50));
    if (items.length > 50) lines.push(`- …${items.length - 50} more (see the JUnit report)`);
    lines.push("");
  };
  section("Failures", cases.filter((c) => c.status === "failed" || c.status === "error").flatMap((c) => c.problems.map((p) => said(c, p))));
  section("Skipped", cases.filter((c) => c.status === "skipped" || c.status === "stopped").flatMap((c) => [`- ${who(c)} · ${cell(c.reason ?? c.status)}`, ...c.problems.map((p) => said(c, p))]));
  section("Passed within their pass rate", cases.filter((c) => c.status === "passed").flatMap((c) => c.problems.map((p) => said(c, p))));
  // (with warn: with pass, as the command line, they pass quietly)
  section("Unsure", cases.filter((c) => c.test?.unsure).flatMap((c) => unsureOf(c.test, turnsOf(run, c.test)).map((line) => `- ${who(c)} · ${cell(line)}`)));
  // The providers' fixtures: each that ran, when, for what, how it went
  const fixtures = run.fixtures ?? [];
  if (fixtures.length) {
    lines.push("### Fixtures", "", "| | Fixture | When | Provider | Test | Took | Calls | |", "|---|---|---|---|---|---|---|---|");
    for (const f of fixtures.slice(0, 100)) {
      const test = f.test ? `${f.test.name}${f.test.row ? ` · ${rowLabel(f.test.row, f.test.row_name)}` : ""}${f.test.repeat > 1 ? ` · run ${f.test.repeat}` : ""}` : "";
      // (what it did: said to stop, gave its names, set the environment's)
      const did = [f.stop ? "said to stop" : "", f.provides?.length ? `gave ${f.provides.join(", ")}` : "", f.sets?.length ? `set ${f.sets.join(", ")}` : ""].filter(Boolean).join(" · ");
      lines.push(`| ${f.status === "ok" ? "✓" : "✗"} | ${cell(f.name)} | ${f.phase} | ${cell(f.provider ?? "")} | ${cell(test)} | ${sec(f.ms)} | ${f.calls ?? 0} | ${cell(f.status === "ok" ? did : f.error)} |`);
    }
    if (fixtures.length > 100) lines.push(`| | …${fixtures.length - 100} more (see the run file) | | | | | | |`);
    lines.push("");
  }
  if (run.baseline) {
    const b = run.baseline;
    lines.push("### Compared with the baseline", "", "| | Run | Baseline | Change |", "|---|---|---|---|");
    for (const [label, key, fmt] of [["Pass rate", "pass_rate", (v) => `${Math.round(v * 100)}%`], ["p50", "p50", sec], ["p95", "p95", sec], ["Cost", "cost", money]]) {
      const row = b[key];
      if (row) lines.push(`| ${label} | ${fmt(row.run)} | ${fmt(row.baseline)} | ${row.change ?? "—"} |`);
    }
    if (b.regressed?.length) lines.push("", `**Regressed:** ${b.regressed.join("; ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)] : undefined;
}
