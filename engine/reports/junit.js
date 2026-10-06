// JUnit XML (contracts/cli.md, Reports): a <testsuite> per suite file, a <testcase> per test (per row
// for data tests), a <failure> per failed check, an <error> per error, <skipped> for skipped tests,
// and <properties> with the run's numbers. Unsure results with the warn policy go in <system-out>.

const esc = (s) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const secs = (ms) => ((ms ?? 0) / 1000).toFixed(3);

export function junit(run) {
  const bySuite = new Map();
  for (const t of run.tests) {
    if (!bySuite.has(t.suite)) bySuite.set(t.suite, []);
    bySuite.get(t.suite).push(t);
  }
  // (a turn carried from the last run, by "run this turn only", wasn't run: its results aren't this run's)
  const turnsOf = (instance) => instance.turns.map((i) => run.turns[i]).filter((t) => t && !t.carried);
  const suites = [];
  const all = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const [file, tests] of bySuite) {
    const name = run.suites.find((s) => s.file === file)?.name ?? file;
    const cases = [];
    let failures = 0;
    let errors = 0;
    let skipped = 0;
    let time = 0;
    for (const test of tests) {
      const groups = test.instances.some((i) => i.row) ? test.instances : [{ ...test, all: test.instances }];
      for (const group of groups) {
        const instances = group.all ?? [group];
        const caseName = group.row ? `${test.name} [row ${group.row}${test.settings?.repeat > 1 ? `, run ${group.repeat}` : ""}]` : test.name;
        const turns = instances.flatMap(turnsOf);
        const ms = turns.reduce((sum, t) => sum + (t.metrics?.ms ?? 0), 0);
        time += ms;
        const body = [];
        const status = group.all ? test.status : group.status;
        if (status === "skipped" || status === "stopped") {
          skipped++;
          body.push(`<skipped message="${esc(test.reason ?? status)}"/>`);
        }
        for (const turn of turns) {
          for (const r of turn.results ?? []) {
            const where = `turn ${turn.index + 1}${turn.row ? ` · row ${turn.row}` : ""}${test.settings?.repeat > 1 ? ` · run ${turn.repeat}` : ""}`;
            const text = `${where}\nyou: ${turn.user}\nreply: ${(turn.reply ?? "").slice(0, 2000)}`;
            if (r.status === "fail") {
              failures++;
              body.push(`<failure message="${esc(`${r.name}: ${r.reason}`)}" type="${esc(r.check?.type ?? "check")}">${esc(text)}</failure>`);
            } else if (r.status === "error") {
              errors++;
              body.push(`<error message="${esc(`${r.name}: ${r.reason}`)}" type="${esc(r.check?.type ?? "check")}">${esc(text)}</error>`);
            }
          }
          if (turn.error && !(turn.results ?? []).some((r) => r.status === "error")) {
            errors++;
            body.push(`<error message="${esc(`turn ${turn.index + 1}: ${turn.error}`)}">${esc(turn.user)}</error>`);
          }
        }
        for (const instance of instances) {
          for (const r of instance.conversation_results ?? []) {
            if (r.status === "fail") { failures++; body.push(`<failure message="${esc(`conversation · ${r.name}: ${r.reason}`)}"/>`); }
            if (r.status === "error") { errors++; body.push(`<error message="${esc(`conversation · ${r.name}: ${r.reason}`)}"/>`); }
          }
        }
        // A test that errored or failed with nothing above to say why (its setup failed, its provider
        // couldn't be made, its data had no rows) still says so: an empty case reads as passed
        const why = test.reason ?? instances.find((i) => i.reason)?.reason ?? status;
        if (status === "error" && !body.some((b) => b.startsWith("<error"))) {
          errors++;
          body.push(`<error message="${esc(why)}"/>`);
        } else if (status === "failed" && !body.some((b) => b.startsWith("<failure") || b.startsWith("<error"))) {
          failures++;
          body.push(`<failure message="${esc(why)}"/>`);
        }
        const unsure = turns.flatMap((t) => (t.results ?? []).filter((r) => r.status === "unsure").map((r) => `unsure · turn ${t.index + 1} · ${r.name}: ${r.reason} (confidence ${r.confidence})`));
        if (group.all && test.total) body.push(`<system-out>${esc([`passed ${test.passed}/${test.total} (pass rate ${test.settings?.pass_rate ?? 1})`, ...unsure].join("\n"))}</system-out>`);
        else if (unsure.length) body.push(`<system-out>${esc(unsure.join("\n"))}</system-out>`);
        cases.push(`    <testcase classname="${esc(name)}" name="${esc(caseName)}" time="${secs(ms)}">${body.length ? `\n      ${body.join("\n      ")}\n    ` : ""}</testcase>`);
      }
    }
    suites.push(`  <testsuite name="${esc(name)}" file="${esc(file)}" tests="${cases.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${secs(time)}">\n${properties(run)}\n${cases.join("\n")}\n  </testsuite>`);
    all.tests += cases.length;
    all.failures += failures;
    all.errors += errors;
    all.skipped += skipped;
  }
  // The totals are the suites' (what their cases say), so they agree
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Hafen" tests="${all.tests}" failures="${all.failures}" errors="${all.errors}" skipped="${all.skipped}" time="${secs(run.ms)}">\n${suites.join("\n")}\n</testsuites>\n`;
}

function properties(run) {
  const s = run.summary ?? {};
  const props = {
    run_id: run._id,
    status: run.status,
    verdict: run.verdict ?? "",
    // (a skipped check, turned off or not reached, isn't counted)
    checks: `${s.checks?.passed ?? 0}/${(s.checks?.total ?? 0) - (s.checks?.skipped ?? 0)}`,
    latency_p50_ms: s.latency?.total?.p50 ?? "",
    latency_p95_ms: s.latency?.total?.p95 ?? "",
    tokens_in: s.tokens?.input ?? 0,
    tokens_out: s.tokens?.output ?? 0,
    cost_usd: s.cost ?? "",
  };
  return `    <properties>\n${Object.entries(props).map(([k, v]) => `      <property name="${k}" value="${esc(v)}"/>`).join("\n")}\n    </properties>`;
}
