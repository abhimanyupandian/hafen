// A JSON summary (contracts/cli.md, Reports): the run's summary, each test (its suite, status, why,
// and what went wrong, as the command line says it: reports/outcome.js), every check result, every
// fixture that ran and every HTTP call a plugin or fixture made (no headers or bodies: those are in the
// run file), for dashboards.

import { casesOf, tally } from "./outcome.js";

export function jsonSummary(run) {
  const cases = casesOf(run);
  return `${JSON.stringify({
    _id: run._id,
    status: run.status,
    verdict: run.verdict,
    started: run.started,
    ms: run.ms,
    // (its tests counted as every report counts them: a suite that broke before its tests ran is one,
    // an error)
    summary: run.summary ? { ...run.summary, tests: tally(run, cases) } : run.summary,
    baseline: run.baseline,
    // Each test, and each suite that broke before its tests ran (or wasn't reached): what went wrong
    // in it, each { from: "turn" | "conversation" | "run" | "test" | "setup", turn, repeat, row,
    // row_name, status, check, reason } (row_name, where there's a row: its name, null for none)
    tests: cases.map((c) => ({
      suite: c.suite, id: c.test?.id, name: c.name, status: c.status, passed: c.test?.passed ?? 0, total: c.test?.total ?? 0,
      accuracy: c.test?.accuracy, unsure: c.test?.unsure ?? false, reason: c.reason ?? null,
      problems: c.problems.map(({ at, text, type, ...p }) => p),
    })),
    // Each check's result: a turn's (from: "turn"), then the whole conversation's (from:
    // "conversation", expect_conversation: no turn of its own), so they add up to summary.checks (a
    // data row's with its row_name, as the problems)
    results: [
      ...run.turns.filter((t) => t && !t.carried).flatMap((t) => (t.results ?? []).map((r) => result(r, { suite: t.suite ?? null, test: t.test, from: "turn", turn: t.index, repeat: t.repeat, row: t.row, ...(t.row ? { row_name: t.row_name ?? null } : {}) }))),
      ...run.tests.flatMap((t) => t.instances.flatMap((i) => (i.conversation_results ?? []).map((r) => result(r, { suite: t.suite, test: t.id ?? t.name, from: "conversation", turn: null, repeat: i.repeat, row: i.row, ...(i.row ? { row_name: i.row_name ?? null } : {}) })))),
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
