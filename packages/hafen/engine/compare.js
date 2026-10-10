// Comparing a run with a baseline (spec US9; data-model.md, Comparison): pass rate, latency p50 and
// p95, cost, the checks that flipped, and which thresholds were crossed.

const passRate = (run) => {
  const tests = run.tests.filter((t) => t.status !== "skipped");
  return tests.length ? tests.filter((t) => t.status === "passed").length / tests.length : undefined;
};

const pct = (a, b) => (a === undefined || b === undefined || b === 0 ? undefined : ((a - b) / b) * 100);
// p95 that rose less than this isn't a regression, whatever the percentage: 4 ms to 11 ms is +175%,
// and noise
export const P95_FLOOR_MS = 50;
const signed = (n, unit) => (n === undefined ? undefined : `${n > 0 ? "+" : ""}${Math.round(n * 10) / 10}${unit}`);

// thresholds: { pass_rate: points it may fall, p95: percent it may rise (and by P95_FLOOR_MS or
// more), cost: percent it may rise }
export function compareRuns(run, baseline, thresholds = { pass_rate: 5 }) {
  const a = run.summary ?? {};
  const b = baseline.summary ?? {};
  const rate = { run: passRate(run), baseline: passRate(baseline) };
  rate.change = rate.run !== undefined && rate.baseline !== undefined ? signed((rate.run - rate.baseline) * 100, " pts") : undefined;
  const p50 = { run: a.latency?.total?.p50, baseline: b.latency?.total?.p50 };
  p50.change = signed(pct(p50.run, p50.baseline), "%");
  const p95 = { run: a.latency?.total?.p95, baseline: b.latency?.total?.p95 };
  p95.change = signed(pct(p95.run, p95.baseline), "%");
  const cost = { run: a.cost, baseline: b.cost };
  cost.change = signed(pct(cost.run, cost.baseline), "%");

  // Checks by test, turn and name; the last result of each, in each run
  const statuses = (r) => {
    const out = new Map();
    for (const t of r.turns) {
      const test = r.tests.find((x) => (x.id ?? x.name) === t.test)?.name ?? t.test;
      for (const res of t.results ?? []) out.set(`${test}\u0000${t.index}\u0000${res.name}`, { test, turn: t.index, check: res.name, status: res.status });
    }
    return out;
  };
  const now = statuses(run);
  const before = statuses(baseline);
  const flipped = [];
  for (const [key, cur] of now) {
    const old = before.get(key);
    if (!old) continue;
    const was = old.status === "pass";
    const is = cur.status === "pass";
    if (was !== is) flipped.push({ test: cur.test, turn: cur.turn, check: cur.check, from: old.status, to: cur.status });
  }

  const regressed = [];
  if (thresholds.pass_rate !== undefined && rate.run !== undefined && rate.baseline !== undefined && (rate.baseline - rate.run) * 100 > thresholds.pass_rate) {
    const fell = Math.round((rate.baseline - rate.run) * 1000) / 10;
    regressed.push(`pass rate fell ${fell} point${fell === 1 ? "" : "s"} (limit ${thresholds.pass_rate})`);
  }
  if (thresholds.p95 !== undefined && pct(p95.run, p95.baseline) > thresholds.p95 && p95.run - p95.baseline >= P95_FLOOR_MS) {
    regressed.push(`p95 rose ${Math.round(pct(p95.run, p95.baseline))}% (limit ${thresholds.p95}%)`);
  }
  if (thresholds.cost !== undefined && pct(cost.run, cost.baseline) > thresholds.cost) regressed.push(`cost rose ${Math.round(pct(cost.run, cost.baseline))}% (limit ${thresholds.cost}%)`);

  return {
    baseline: { _id: baseline._id, started: baseline.started },
    pass_rate: rate,
    p50,
    p95,
    cost,
    flipped,
    thresholds,
    regressed,
  };
}
