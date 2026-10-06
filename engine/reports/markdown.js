// A Markdown summary (contracts/cli.md, Reports): for a CI job page or a pull request comment.

const sec = (ms) => (ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`);
const money = (usd) => (usd === undefined ? "—" : `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`);
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function markdown(run) {
  const s = run.summary ?? {};
  const icon = { passed: "✓", failed: "✗", error: "✗", skipped: "–", stopped: "–" };
  const verdict = run.status === "done" ? run.verdict : run.status;
  const lines = [
    `## Hafen · ${verdict}`,
    "",
    `${s.tests?.total ?? 0} tests · ${s.tests?.failed ?? 0} failed · ${s.tests?.unsure ?? 0} unsure · ${s.checks?.total ?? 0} checks · p50 ${sec(s.latency?.total?.p50)} · p95 ${sec(s.latency?.total?.p95)} · ${money(s.cost)} · ${sec(run.ms)}`,
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
  const failures = run.turns.flatMap((t) => (t.results ?? []).filter((r) => r.status === "fail" || r.status === "error").map((r) => ({ t, r })));
  if (failures.length) {
    lines.push("### Failures", "");
    for (const { t, r } of failures.slice(0, 50)) {
      const test = run.tests.find((x) => (x.id ?? x.name) === t.test)?.name ?? t.test;
      lines.push(`- **${cell(test)}** · turn ${t.index + 1}${t.row ? ` · row ${t.row}` : ""} · ${r.status === "error" ? "error" : "failed"} · \`${cell(r.name)}\`: ${cell(r.reason)}`);
    }
    if (failures.length > 50) lines.push(`- …${failures.length - 50} more (see the JUnit report)`);
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
