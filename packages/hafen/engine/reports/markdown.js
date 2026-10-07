// A Markdown summary (contracts/cli.md, Reports): for a CI job page or a pull request comment.

const sec = (ms) => (ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`);
// A cost: to the cent, or a smaller one to two significant digits ($0.000017, never $0.0000). The
// command line's lines use it too.
export const money = (usd) => {
  if (usd === undefined || usd === null) return "—";
  if (usd === 0 || usd >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(Math.min(20, 1 - Math.floor(Math.log10(usd)))).replace(/0+$/, "")}`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function markdown(run) {
  const s = run.summary ?? {};
  const icon = { passed: "✓", failed: "✗", error: "✗", skipped: "–", stopped: "–" };
  // (a run whose tests passed, but that regressed past --fail-on, isn't said to have passed)
  const done = run.status === "done" ? run.verdict : run.status;
  const verdict = done === "passed" && run.baseline?.regressed?.length ? "regressed" : done;
  const lines = [
    `## Hafen · ${verdict}`,
    "",
    `${plural(s.tests?.total ?? 0, "test")} · ${s.tests?.failed ?? 0} failed · ${s.tests?.unsure ?? 0} unsure · ${plural(s.checks?.total ?? 0, "check")} · p50 ${sec(s.latency?.total?.p50)} · p95 ${sec(s.latency?.total?.p95)} · ${money(s.cost)} · ${sec(run.ms)}`,
    "",
  ];
  if (run.error) lines.push(`**Setup error:** ${run.error.file ? `\`${run.error.file}${run.error.line ? `:${run.error.line}:${run.error.column}` : ""}\` ` : ""}${run.error.message}`, "");
  if (run.stopped) lines.push(`**Stopped:** ${run.stopped}`, "");
  if (run.tests.length) {
    lines.push("| | Test | Passed | Checks | p95 | Cost |", "|---|---|---|---|---|---|");
    for (const t of run.tests) {
      const turns = t.instances.flatMap((i) => i.turns.map((n) => run.turns[n])).filter(Boolean);
      const results = t.instances.flatMap((i) => i.results);
      const passed = results.filter((r) => r.status === "pass").length;
      const p95 = percentile(turns.map((x) => x.metrics?.ms), 95);
      const cost = turns.every((x) => x.metrics?.cost !== undefined) && turns.length ? turns.reduce((a, x) => a + x.metrics.cost, 0) : undefined;
      lines.push(`| ${t.status === "passed" && t.unsure ? "!" : icon[t.status] ?? "?"} | ${cell(t.name)} | ${t.passed}/${t.total} | ${passed}/${results.length} | ${sec(p95)} | ${money(cost)} |`);
    }
    lines.push("");
  }
  // Each check that failed or errored: a turn's, then the conversation's (expect_conversation)
  const wrong = (r) => r.status === "fail" || r.status === "error";
  const failures = [
    ...run.turns.filter(Boolean).flatMap((t) => (t.results ?? []).filter(wrong).map((r) => ({
      test: run.tests.find((x) => (x.id ?? x.name) === t.test)?.name ?? t.test, where: `turn ${t.index + 1}${t.row ? ` · row ${t.row}` : ""}`, r,
    }))),
    ...run.tests.flatMap((x) => x.instances.flatMap((i) => (i.conversation_results ?? []).filter(wrong).map((r) => ({
      test: x.name, where: `conversation${i.row ? ` · row ${i.row}` : ""}`, r,
    })))),
  ];
  if (failures.length) {
    lines.push("### Failures", "");
    for (const { test, where, r } of failures.slice(0, 50)) {
      lines.push(`- **${cell(test)}** · ${where} · ${r.status === "error" ? "error" : "failed"} · \`${cell(r.name)}\`: ${cell(r.reason)}`);
    }
    if (failures.length > 50) lines.push(`- …${failures.length - 50} more (see the JUnit report)`);
    lines.push("");
  }
  // The providers' fixtures: each that ran, when, for what, how it went
  const fixtures = run.fixtures ?? [];
  if (fixtures.length) {
    lines.push("### Fixtures", "", "| | Fixture | When | Provider | Test | Took | Calls | |", "|---|---|---|---|---|---|---|---|");
    for (const f of fixtures.slice(0, 100)) {
      const test = f.test ? `${f.test.name}${f.test.row ? ` · row ${f.test.row}` : ""}${f.test.repeat > 1 ? ` · run ${f.test.repeat}` : ""}` : "";
      lines.push(`| ${f.status === "ok" ? "✓" : "✗"} | ${cell(f.name)} | ${f.phase} | ${cell(f.provider ?? "")} | ${cell(test)} | ${sec(f.ms)} | ${f.calls ?? 0} | ${cell(f.status === "ok" ? (f.provides?.length ? `gave ${f.provides.join(", ")}` : "") : f.error)} |`);
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
