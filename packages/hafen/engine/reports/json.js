// A JSON summary (contracts/cli.md, Reports): the run's summary, every check result, every fixture that
// ran and every HTTP call a plugin or fixture made (no headers or bodies: those are in the run file),
// for dashboards.

export function jsonSummary(run) {
  return `${JSON.stringify({
    _id: run._id,
    status: run.status,
    verdict: run.verdict,
    started: run.started,
    ms: run.ms,
    summary: run.summary,
    baseline: run.baseline,
    tests: run.tests.map((t) => ({ suite: t.suite, id: t.id, name: t.name, status: t.status, passed: t.passed, total: t.total, accuracy: t.accuracy, unsure: t.unsure })),
    // Each check's result: a turn's (from: "turn"), then the whole conversation's (from:
    // "conversation", expect_conversation: no turn of its own), so they add up to summary.checks
    results: [
      ...run.turns.filter(Boolean).flatMap((t) => (t.results ?? []).map((r) => result(r, { test: t.test, from: "turn", turn: t.index, repeat: t.repeat, row: t.row }))),
      ...run.tests.flatMap((t) => t.instances.flatMap((i) => (i.conversation_results ?? []).map((r) => result(r, { test: t.id ?? t.name, from: "conversation", turn: null, repeat: i.repeat, row: i.row })))),
    ],
    fixtures: run.fixtures ?? [],
    calls: (run.spans ?? []).filter((s) => s.kind === "call").map((s) => ({
      plugin: s.plugin ?? null, call: s.name, status: s.response?.status ?? null, error: s.error ?? null,
      ms: s.end !== undefined ? Math.round((s.end - s.start) * 10) / 10 : null,
      in: (run.spans ?? []).find((p) => p._id === s.parent)?.name ?? null,
    })),
  }, null, 2)}\n`;
}

const result = (r, where) => ({
  ...where, check: r.name, type: r.check?.type ?? null, status: r.status, reason: r.reason, value: r.value, confidence: r.confidence,
});
