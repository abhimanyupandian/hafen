// A JSON summary (contracts/cli.md, Reports): the run's summary and every check result, for dashboards.

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
    results: run.turns.flatMap((t) => (t.results ?? []).map((r) => ({
      test: t.test, turn: t.index, repeat: t.repeat, row: t.row, check: r.name, type: r.check?.type ?? null,
      status: r.status, reason: r.reason, value: r.value, confidence: r.confidence,
    }))),
  }, null, 2)}\n`;
}
