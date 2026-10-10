// JUnit XML (contracts/cli.md, Reports): a <testsuite> per suite file and a <testcase> per test, or
// per data row of a test with data rows (its repeats within it), with one status (reports/outcome.js):
// passed, nothing; failed (its pass rate missed), a <failure>; an error, an <error>; skipped or
// stopped, a <skipped>. A row's status agrees with its test's (outcome.js, rowsOf): in a test that met
// its pass rate, a row that failed is a <skipped> saying it failed within it, so the cases still reach
// the run's verdict. A <failure> or <error> says what went wrong, a line each (a turn's message and
// reply under each turn's). A run or row that failed in a test that passed is said in its
// <system-out>, with its runs passed, unsure results that didn't count as failed, and the providers'
// fixtures that ran for it (a failed one in its <system-err> too); the suite's own (beforeAll,
// afterAll) in the suite's. A suite that broke before its tests ran is a case of its own, an error.
// <properties> have the run's numbers.

import { casesOf, checksRan, passRate, rowsOf, turnsOf, unsureOf } from "./outcome.js";
import { rowLabel } from "../files/data.js";

const esc = (s) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const secs = (ms) => ((ms ?? 0) / 1000).toFixed(3);

export function junit(run) {
  const cases = casesOf(run);
  // (in the run's order of its suites; one with no cases, none of its tests picked, isn't shown)
  const bySuite = new Map((run.suites ?? []).map((s) => [s.file, []]));
  for (const c of cases) {
    if (!bySuite.has(c.suite)) bySuite.set(c.suite, []);
    bySuite.get(c.suite).push(c);
  }
  const props = properties(run, cases);
  const suites = [];
  const all = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const [file, list] of bySuite) {
    if (!list.length) continue;
    const name = list[0].suiteName;
    const count = { failures: 0, errors: 0, skipped: 0 };
    let time = 0;
    // A case: its status, and what went wrong in it, the turns it ran, its fixtures; `out`, what its
    // <system-out> starts with
    const testcase = ({ name: caseName, status, reason, problems, turns, out, unsure, fixtures }) => {
      const ms = turns.reduce((sum, t) => sum + (t.metrics?.ms ?? 0), 0);
      time += ms;
      const body = [];
      const lines = problems.map((p) => detail(p, turns));
      // (its message: the first of what went wrong that's of its kind, and how many more)
      const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : "";
      if (status === "failed" || status === "error") {
        const tag = status === "failed" ? "failure" : "error";
        const first = problems.find((p) => (status === "error") === (p.status === "error")) ?? problems[0];
        const message = `${first ? short(first) : reason ?? status}${more}`;
        const text = lines.join("\n");
        body.push(`<${tag} message="${esc(message)}"${first && first.check !== null ? ` type="${esc(first.type ?? "check")}"` : ""}${text && text !== message ? `>${esc(text)}</${tag}>` : "/>"}`);
        count[status === "failed" ? "failures" : "errors"]++;
      } else {
        if (status === "skipped" || status === "stopped") {
          // (a row that failed within its test's pass rate: that, and the first of what went wrong)
          const message = status === "skipped" && problems.length && reason ? `${reason}: ${short(problems[0])}${more}` : reason ?? status;
          body.push(`<skipped message="${esc(message)}"/>`);
          count.skipped++;
        }
        out.push(...lines);
      }
      out.push(...unsure);
      // Its fixtures (before, after): one line each; a failed one in system-err too
      out.push(...fixtures.map(fixtureText));
      if (out.length) body.push(`<system-out>${esc(out.join("\n"))}</system-out>`);
      const failedFixtures = fixtures.filter((f) => f.status !== "ok").map(fixtureText);
      if (failedFixtures.length) body.push(`<system-err>${esc(failedFixtures.join("\n"))}</system-err>`);
      return `    <testcase classname="${esc(name)}" name="${esc(caseName)}" time="${secs(ms)}">${body.length ? `\n      ${body.join("\n      ")}\n    ` : ""}</testcase>`;
    };
    const testcases = list.flatMap((c) => {
      const t = c.test;
      const turns = t ? turnsOf(run, t) : [];
      const mine = t ? (run.fixtures ?? []).filter((f) => f.test && f.test.name === t.name && (f.test.id === undefined || t.id === undefined || f.test.id === t.id)) : [];
      const passed = t?.total ? `passed ${t.passed}/${t.total}${t.instances.some((i) => i.row) ? " rows" : ""} (pass rate ${t.accuracy ?? 0}, needs ${t.settings?.pass_rate ?? 1})` : null;
      const rows = rowsOf(c);
      if (!rows) return [testcase({ name: c.name, status: c.status, reason: c.reason, problems: c.problems, turns, out: passed ? [passed] : [], unsure: t ? unsureOf(t, turns) : [], fixtures: mine })];
      // Each data row, a case of its own: its runs passed (when it repeats), then the test's
      return rows.map((r) => {
        const own = turns.filter((x) => x.row === r.row);
        const runs = r.instances.length > 1 ? [`passed ${r.instances.filter((i) => i.status === "passed").length}/${r.instances.length} runs`] : [];
        return testcase({ name: r.name, status: r.status, reason: r.reason, problems: r.problems, turns: own, out: [...runs, `the test: ${passed}`], unsure: unsureOf(t, own, r.instances), fixtures: mine.filter((f) => f.test.row === r.row) });
      });
    });
    // The run's own fixtures (beforeAll, afterAll), in every suite's output (a CI page shows them there)
    const own = (run.fixtures ?? []).filter((f) => !f.test);
    const ownOut = own.length ? `\n    <system-out>${esc(own.map(fixtureText).join("\n"))}</system-out>` : "";
    const ownErr = own.some((f) => f.status !== "ok") ? `\n    <system-err>${esc(own.filter((f) => f.status !== "ok").map(fixtureText).join("\n"))}</system-err>` : "";
    suites.push(`  <testsuite name="${esc(name)}" file="${esc(file)}" tests="${testcases.length}" failures="${count.failures}" errors="${count.errors}" skipped="${count.skipped}" time="${secs(time)}">\n${props}\n${testcases.join("\n")}${ownOut}${ownErr}\n  </testsuite>`);
    all.tests += testcases.length;
    all.failures += count.failures;
    all.errors += count.errors;
    all.skipped += count.skipped;
  }
  // The totals are the suites' (what their cases say), so they agree
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Hafen" tests="${all.tests}" failures="${all.failures}" errors="${all.errors}" skipped="${all.skipped}" time="${secs(run.ms)}">\n${suites.join("\n")}\n</testsuites>\n`;
}

// What went wrong, in a message: the check and why (contains nope: didn't find nope), a turn that
// broke (turn 1: timed out after 60 s), the whole conversation's check, or why a run or test broke
function short(p) {
  if (p.check !== null) return `${p.from === "conversation" ? "conversation · " : ""}${p.check}: ${p.reason}`;
  return p.from === "turn" ? `turn ${p.turn + 1}: ${p.reason}` : p.reason;
}

// What went wrong, in full: where and why, then the turn's message and its reply
function detail(p, turns) {
  const turn = p.from === "turn" ? turns.find((t) => t.index === p.turn && (t.repeat ?? null) === p.repeat && (t.row ?? null) === p.row) : null;
  if (!turn) return p.text;
  return [p.text, `  you: ${turn.user ?? ""}`, ...(turn.reply ? [`  reply: ${turn.reply.slice(0, 2000)}`] : [])].join("\n");
}

// A fixture that ran, as a line: "fixture acme-login (beforeAll) · providers/acme.yml · ok · 0.420 s · gave ACME_COOKIE · 1 call"
// (for a test's: "orders row 3: a refund please run 2" after its provider)
// (and "said to stop", when its run() returned false; "set BASE_URL", the environment's names it set)
export function fixtureText(f) {
  return [
    `fixture ${f.name} (${f.phase})`, f.provider, f.test ? `${f.test.name}${f.test.row ? ` ${rowLabel(f.test.row, f.test.row_name)}` : ""}${f.test.repeat > 1 ? ` run ${f.test.repeat}` : ""}` : null,
    f.status === "ok" ? "ok" : `failed: ${f.error}`, `${secs(f.ms)} s`, f.stop ? "said to stop" : null,
    f.provides?.length ? `gave ${f.provides.join(", ")}` : null, f.sets?.length ? `set ${f.sets.join(", ")}` : null, f.calls ? `${f.calls} call${f.calls === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");
}

function properties(run, cases) {
  const s = run.summary ?? {};
  const props = {
    run_id: run._id,
    status: run.status,
    verdict: run.verdict ?? "",
    ...(run.stopped ? { stopped: run.stopped } : {}),
    // (of the tests that ran, the share that passed: what --fail-on compares)
    pass_rate: passRate(run, cases) ?? "",
    // (a skipped check, turned off or not reached, isn't counted)
    checks: `${s.checks?.passed ?? 0}/${checksRan(run)}`,
    latency_p50_ms: s.latency?.total?.p50 ?? "",
    latency_p95_ms: s.latency?.total?.p95 ?? "",
    tokens_in: s.tokens?.input ?? 0,
    tokens_out: s.tokens?.output ?? 0,
    cost_usd: s.cost ?? "",
    ...(s.fixtures ? { fixtures: s.fixtures.total, fixtures_failed: s.fixtures.failed } : {}),
  };
  return `    <properties>\n${Object.entries(props).map(([k, v]) => `      <property name="${k}" value="${esc(v)}"/>`).join("\n")}\n    </properties>`;
}
