// The reports say how a run went as the command line does (engine/reports/outcome.js): a test is one
// case with one status, its pass rate deciding it (a run or row that failed in a test that passed is
// said, not counted); a suite that broke before its tests ran is a case of its own, an error, with why
// (each one, however many broke at once), as is a problem found before anything was sent; one the run
// never reached is skipped. JUnit, Markdown and JSON count the same, and JUnit has the pass rate among
// its properties. In JUnit, each data row of a test is a case of its own (its repeats within it), its
// status agreeing with the test's: a row that failed in a test that met its pass rate is skipped,
// saying so; an unsure result that counts as failed says it was unsure, and how to let it pass.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { jsonSummary } from "../../engine/reports/json.js";
import { junit } from "../../engine/reports/junit.js";
import { markdown } from "../../engine/reports/markdown.js";
import { casesOf, countsText, tally } from "../../engine/reports/outcome.js";
import { runSuites } from "../../engine/runner.js";
import { fakeTransport, memoryHost } from "../helpers.js";

const PROVIDER = `provider: { kind: http, url: "http://x.example/chat", body: { m: "{{user}}" }, response: { text: $.reply, usage: { input: $.usage.i, output: $.usage.o } }, price: { input: 1, output: 1 } }`;
// Replies "hello"; a setup step's request (to /seed…) gets a 500
const transport = () => fakeTransport((req) => (/\/seed/.test(req.url) ? { status: 500, body: "{}" } : { body: JSON.stringify({ reply: "hello", usage: { i: 3, o: 2 } }) }));

async function run(files, options = {}, using = transport()) {
  const host = memoryHost(files, { transport: using });
  const suites = [];
  for (const file of Object.keys(files).filter((f) => f.endsWith(".hafen.yml"))) suites.push(await loadSuite(host, file));
  return runSuites({ suites, host, options });
}

// JUnit's totals and each case's status (none, failure, error, skipped), as a CI system reads them
function readJUnit(xml) {
  const attrs = (tag) => Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const root = attrs(xml.match(/<testsuites [^>]*>/)[0]);
  const cases = [...xml.matchAll(/<testcase ([^>]*)>([\s\S]*?)<\/testcase>/g)].map((m) => ({ ...attrs(m[1]), body: m[2], statuses: m[2].match(/<(failure|error|skipped)[ />]/g) ?? [] }));
  return { root, cases, properties: Object.fromEntries([...xml.matchAll(/<property name="([^"]+)" value="([^"]*)"\/>/g)].map((m) => [m[1], m[2]])) };
}

// The counts every report gives: JUnit's, the Markdown header's, the JSON summary's
function counts(r) {
  const x = readJUnit(junit(r));
  for (const c of x.cases) assert.ok(c.statuses.length <= 1, `one status a case: ${c.name} has ${c.statuses.join(" ")}`);
  const fromJUnit = { tests: +x.root.tests, failed: +x.root.failures, errors: +x.root.errors, skipped: +x.root.skipped };
  const head = markdown(r).split("\n")[2].match(/^(\d+) tests? · (\d+) failed(?: · (\d+) errors?)?(?: · (\d+) skipped)? · /);
  const fromMarkdown = { tests: +head[1], failed: +head[2], errors: +(head[3] ?? 0), skipped: +(head[4] ?? 0) };
  const t = JSON.parse(jsonSummary(r)).summary.tests;
  const fromJSON = { tests: t.total, failed: t.failed, errors: t.error, skipped: t.skipped + t.stopped };
  assert.deepEqual(fromMarkdown, fromJUnit, "Markdown and JUnit");
  assert.deepEqual(fromJSON, fromJUnit, "JSON and JUnit");
  return fromJUnit;
}

describe("JUnit's properties", () => {
  it("include a pass rate (with latency, tokens and cost): of the tests that ran, the share that passed", async () => {
    const r = await run({ "s.hafen.yml": `version: 1
${PROVIDER}
tests:
  - { name: a, turns: [ { user: hi, expect: [ { contains: hello } ] } ] }
  - { name: b, turns: [ { user: hi, expect: [ { contains: nope } ] } ] }
` });
    const { properties } = readJUnit(junit(r));
    for (const name of ["latency_p95_ms", "tokens_out", "cost_usd"]) assert.ok(name in properties, name);
    assert.equal(properties.pass_rate, "0.5");
    assert.equal(properties.checks, "1/2");
  });
});

describe("a test is one case, its pass rate deciding it", () => {
  const flaky = `version: 1
name: Flows
${PROVIDER}
tests:
  - name: flaky
    repeat: 4
    pass_rate: 0.5
    turns: [ { user: hi, expect: [ { contains: hello } ] } ]
`;
  // The replies, request by request (its runs go in order): "hello", or "bye" for those named
  const replies = (bye) => fakeTransport((req, n) => ({ body: JSON.stringify({ reply: bye.includes(n) ? "bye" : "hello", usage: { i: 1, o: 1 } }) }));

  it("a run that failed in a test that met its pass rate is said (system-out, Markdown, JSON), not counted", async () => {
    const r = await run({ "s.hafen.yml": flaky }, {}, replies([2]));
    assert.equal(r.tests[0].status, "passed");
    assert.deepEqual(counts(r), { tests: 1, failed: 0, errors: 0, skipped: 0 });
    const [c] = readJUnit(junit(r)).cases;
    assert.match(c.body, /^\s*<system-out>passed 3\/4 \(pass rate 0\.75, needs 0\.5\)\nrun 2 · turn 1 · contains hello: didn&apos;t find hello\n {2}you: hi\n {2}reply: bye<\/system-out>/);
    const md = markdown(r);
    assert.match(md, /### Passed within their pass rate\n\n- \*\*Flows › flaky\*\* · run 2 · turn 1 · failed · `contains hello`: didn't find hello\n/);
    assert.doesNotMatch(md, /### Failures/);
    assert.deepEqual(JSON.parse(jsonSummary(r)).tests[0].problems, [{ from: "turn", repeat: 2, row: null, turn: 0, status: "fail", check: "contains hello", reason: "didn't find hello" }]);
  });

  it("a test whose pass rate was missed is one <failure>, with every run that failed in it", async () => {
    const r = await run({ "s.hafen.yml": flaky }, {}, replies([1, 2, 3]));
    assert.equal(r.tests[0].status, "failed");
    assert.deepEqual(counts(r), { tests: 1, failed: 1, errors: 0, skipped: 0 });
    const [c] = readJUnit(junit(r)).cases;
    assert.match(c.body, /^\s*<failure message="contains hello: didn&apos;t find hello \(and 2 more\)" type="check">run 1 · turn 1 · /);
    for (const n of [1, 2, 3]) assert.match(c.body, new RegExp(`run ${n} · turn 1 · contains hello: didn&apos;t find hello`));
    assert.doesNotMatch(c.body, /run 4 · /);
  });
});

describe("a suite of its own", () => {
  const broken = (name, group, step) => `version: 1
name: ${name}
group: ${group}
${PROVIDER}
setup:
  - { name: ${step}, request: { url: "http://x.example/seed/${step}", method: POST } }
tests:
  - { name: refund, turns: [ { user: hi } ] }
`;

  it("each suite whose setup broke is an error, with why: the first the run's error, the others from their steps", async () => {
    const r = await run({ "a.hafen.yml": broken("A", 1, "seed-a"), "b.hafen.yml": broken("B", 2, "seed-b") });
    assert.equal(r.status, "error");
    assert.deepEqual(r.tests, []);
    assert.deepEqual(counts(r), { tests: 2, failed: 0, errors: 2, skipped: 0 });
    assert.deepEqual(casesOf(r).map((c) => [c.suiteName, c.name, c.status, c.reason]).sort(), [
      ["A", "(setup)", "error", 'setup step "seed-a" failed: status 500'],
      ["B", "(setup)", "error", 'setup step "seed-b" failed: status 500'],
    ]);
    const xml = junit(r);
    assert.match(xml, /<testsuite name="A" file="a\.hafen\.yml" tests="1" failures="0" errors="1" skipped="0"[\s\S]*?<testcase classname="A" name="\(setup\)" time="0\.000">\s*<error message="setup step &quot;seed-a&quot; failed: status 500"\/>/);
    assert.match(xml, /<testcase classname="B" name="\(setup\)"[^>]*>\s*<error message="setup step &quot;seed-b&quot; failed: status 500"\/>/);
    assert.match(markdown(r), /## Hafen · error\n\n2 tests · 0 failed · 2 errors · 0 unsure · 0 checks · [\s\S]*\| ✗ \| \(setup\) \| A \| — \|[\s\S]*- \*\*B › \(setup\)\*\* · error · setup step "seed-b" failed: status 500/);
  });

  it("a problem found before anything was sent: the suite with it an error (each problem, where it is), the others not run", async () => {
    const r = await run({
      "a.hafen.yml": `version: 1\nname: A\n${PROVIDER}\ntests:\n  - { name: x, turns: [ { user: hi, expect: [ { type: no-such-check } ] } ] }\n`,
      "b.hafen.yml": `version: 1\nname: B\n${PROVIDER}\ntests:\n  - { name: y, turns: [ { user: hi } ] }\n`,
    });
    assert.ok(r.error?.all?.length);
    assert.deepEqual(counts(r), { tests: 2, failed: 0, errors: 1, skipped: 1 });
    const [a, b] = casesOf(r);
    assert.deepEqual([a.suiteName, a.name, a.status, b.suiteName, b.name, b.status], ["A", "(setup)", "error", "B", "(not run)", "skipped"]);
    assert.match(a.reason, /^a\.hafen\.yml:\d+:\d+: "no-such-check" isn't a check type/);
    assert.match(junit(r), /<testcase classname="B" name="\(not run\)"[^>]*>\s*<skipped message="not run: 1 problem found before anything was sent"\/>/);
  });

  it("a suite the run never reached (--bail stopped it first) is skipped, and says why", async () => {
    const r = await run({
      "a.hafen.yml": `version: 1\nname: A\n${PROVIDER}\ntests:\n  - { name: x, turns: [ { user: hi, expect: [ { contains: nope } ] } ] }\n`,
      "b.hafen.yml": `version: 1\nname: B\n${PROVIDER}\ntests:\n  - { name: y, turns: [ { user: hi } ] }\n`,
    }, { bail: true });
    assert.equal(r.status, "stopped");
    assert.deepEqual(counts(r), { tests: 2, failed: 1, errors: 0, skipped: 1 });
    assert.match(junit(r), /<testcase classname="B" name="\(not run\)"[^>]*>\s*<skipped message="not run: stopped at the first failure \(x\)"\/>/);
    assert.equal(countsText(r), "2 tests · 1 failed · 1 skipped · 0 unsure · 1 check");
    assert.deepEqual(tally(r), { passed: 0, failed: 1, unsure: 0, error: 0, skipped: 1, stopped: 0, total: 2 });
  });

  it("two suites with a test of the same name: each report says which suite", async () => {
    const r = await run({
      "a.hafen.yml": `version: 1\nname: Billing\n${PROVIDER}\ntests:\n  - { name: refund, turns: [ { user: hi, expect: [ { contains: nope } ] } ] }\n`,
      "b.hafen.yml": `version: 1\nname: Support\n${PROVIDER}\ntests:\n  - { name: refund, turns: [ { user: hi, expect: [ { contains: hello } ] } ] }\n`,
    });
    const md = markdown(r);
    assert.match(md, /\| ✗ \| refund \| Billing \| 0\/1 \| 0\/1 \|/);
    assert.match(md, /\| ✓ \| refund \| Support \| 1\/1 \| 1\/1 \|/);
    assert.match(md, /- \*\*Billing › refund\*\* · turn 1 · failed · `contains nope`: didn't find nope/);
    const json = JSON.parse(jsonSummary(r));
    assert.deepEqual(json.tests.map((t) => [t.suite, t.name, t.status]), [["a.hafen.yml", "refund", "failed"], ["b.hafen.yml", "refund", "passed"]]);
    assert.deepEqual(json.results.map((x) => [x.suite, x.test, x.status]), [["a.hafen.yml", "refund", "fail"], ["b.hafen.yml", "refund", "pass"]]);
  });
});

describe("each data row is a JUnit case of its own, its status agreeing with the test's", () => {
  // Replies with the message: a row whose question is "ok" passes, "bad" fails
  const echo = (bye = []) => fakeTransport((req, n) => ({ body: JSON.stringify({ reply: bye.includes(n) ? "bye" : JSON.parse(req.body).m, usage: { i: 1, o: 1 } }) }));
  const rows = (questions, head = "") => ({
    "data/rows.csv": `q\n${questions.join("\n")}\n`,
    "s.hafen.yml": `version: 1
name: Flows
${PROVIDER}
tests:
  - name: rows
    data: data/rows.csv
${head}    turns: [ { user: "{{row.q}}", expect: [ { contains: ok } ] } ]
`,
  });
  const run2 = (files, using = echo()) => run(files, {}, using);
  // JUnit's totals, and each case: its name, its status (none, failure, error, skipped) and its body
  const junitOf = (r) => {
    const x = readJUnit(junit(r));
    for (const c of x.cases) assert.ok(c.statuses.length <= 1, `one status a case: ${c.name}`);
    const status = (c) => c.statuses[0]?.slice(1, -1) ?? "passed";
    const of = (tag) => x.cases.filter((c) => status(c) === tag).length;
    assert.deepEqual([+x.root.failures, +x.root.errors, +x.root.skipped, +x.root.tests], [of("failure"), of("error"), of("skipped"), x.cases.length], "the totals add up");
    return { ...x, totals: [+x.root.tests, +x.root.failures, +x.root.errors, +x.root.skipped], each: x.cases.map((c) => [c.name, status(c)]) };
  };
  // The other reports: the test, one case
  const oneCase = (r, [failed, errors]) => {
    const head = markdown(r).split("\n")[2].match(/^(\d+) tests? · (\d+) failed(?: · (\d+) errors?)?/);
    assert.deepEqual([+head[1], +head[2], +(head[3] ?? 0)], [1, failed, errors], "the Markdown");
    const t = JSON.parse(jsonSummary(r)).summary.tests;
    assert.deepEqual([t.total, t.failed, t.error], [1, failed, errors], "the JSON");
  };

  it("rows all passed: a case each, none with an element", async () => {
    const r = await run2(rows(["ok", "ok then", "ok again"]));
    assert.equal(r.tests[0].status, "passed");
    const x = junitOf(r);
    assert.deepEqual(x.totals, [3, 0, 0, 0]);
    // (each named by its first column, its number keeping them in order)
    assert.deepEqual(x.each, [["rows [row 1: ok]", "passed"], ["rows [row 2: ok then]", "passed"], ["rows [row 3: ok again]", "passed"]]);
    assert.match(x.cases[0].body, /<system-out>the test: passed 3\/3 rows \(pass rate 1, needs 1\)<\/system-out>/);
    oneCase(r, [0, 0]);
  });

  it("a row failed, the pass rate 1: that row a <failure> with why, the others passed; the run failed", async () => {
    const r = await run2(rows(["ok", "bad", "ok"]));
    assert.deepEqual([r.tests[0].status, r.verdict], ["failed", "failed"]);
    const x = junitOf(r);
    assert.deepEqual(x.totals, [3, 1, 0, 0]);
    assert.deepEqual(x.each, [["rows [row 1: ok]", "passed"], ["rows [row 2: bad]", "failure"], ["rows [row 3: ok]", "passed"]]);
    assert.match(x.cases[1].body, /^\s*<failure message="contains ok: didn&apos;t find ok" type="check">row 2: bad · turn 1 · contains ok: didn&apos;t find ok\n {2}you: bad\n {2}reply: bad<\/failure>/);
    oneCase(r, [1, 0]);
  });

  it("rows failed within a pass rate the test met: each a <skipped> saying so, so JUnit alone reaches the run's verdict (passed)", async () => {
    const r = await run2(rows(["ok", "ok", "bad", "ok", "ok", "bad", "ok", "ok"], "    pass_rate: 0.75\n"));
    assert.deepEqual([r.tests[0].status, r.verdict], ["passed", "passed"]);
    const x = junitOf(r);
    assert.deepEqual(x.totals, [8, 0, 0, 2]);
    assert.deepEqual(x.each.filter(([, s]) => s !== "passed"), [["rows [row 3: bad]", "skipped"], ["rows [row 6: bad]", "skipped"]]);
    assert.match(x.cases[2].body, /^\s*<skipped message="failed, within the test&apos;s pass rate \(6\/8 ≥ 0\.75\): contains ok: didn&apos;t find ok"\/>\n\s*<system-out>the test: passed 6\/8 rows \(pass rate 0\.75, needs 0\.75\)\nrow 3: bad · turn 1 · contains ok: didn&apos;t find ok\n/);
    oneCase(r, [0, 0]);
    // (the Markdown says them as it did: passed within the pass rate)
    assert.match(markdown(r), /### Passed within their pass rate\n\n- \*\*Flows › rows\*\* · row 3: bad · turn 1 · failed · `contains ok`: didn't find ok\n/);
  });

  it("the pass rate missed by rows: each that failed a <failure>", async () => {
    const r = await run2(rows(["ok", "bad", "bad", "ok"], "    pass_rate: 0.75\n"));
    assert.equal(r.tests[0].status, "failed");
    assert.deepEqual(junitOf(r).each, [["rows [row 1: ok]", "passed"], ["rows [row 2: bad]", "failure"], ["rows [row 3: bad]", "failure"], ["rows [row 4: ok]", "passed"]]);
    oneCase(r, [1, 0]);
  });

  it("rows × repeats: a case each row, its repeats within it (passed 1/2 runs), failed repeats said or counted as the test's pass rate decides", async () => {
    // Two rows, each run twice, in order: row 1, row 2, row 1, row 2. The 3rd request (row 1's second run) says bye
    const met = await run2(rows(["ok", "ok too"], "    repeat: 2\n    pass_rate: 0.75\n"), echo([3]));
    assert.deepEqual([met.tests[0].status, met.tests[0].passed, met.tests[0].total], ["passed", 3, 4]);
    let x = junitOf(met);
    assert.deepEqual(x.each, [["rows [row 1: ok]", "skipped"], ["rows [row 2: ok too]", "passed"]]);
    assert.match(x.cases[0].body, /<skipped message="failed, within the test&apos;s pass rate \(3\/4 ≥ 0\.75\): contains ok: didn&apos;t find ok"\/>\n\s*<system-out>passed 1\/2 runs\nthe test: passed 3\/4 rows \(pass rate 0\.75, needs 0\.75\)\nrow 1: ok · run 2 · turn 1 · contains ok/);
    assert.match(x.cases[1].body, /<system-out>passed 2\/2 runs\n/);
    const missed = await run2(rows(["ok", "ok too"], "    repeat: 2\n"), echo([3]));
    assert.equal(missed.tests[0].status, "failed");
    x = junitOf(missed);
    assert.deepEqual(x.totals, [2, 1, 0, 0]);
    assert.match(x.cases[0].body, /^\s*<failure message="contains ok: didn&apos;t find ok" type="check">row 1: ok · run 2 · turn 1 · contains ok/);
    // (a row whose runs met the pass rate, a run of it failed: passed, the run said)
    const within = await run2(rows(["ok", "ok too"], "    repeat: 2\n    pass_rate: 0.5\n"), echo([3]));
    x = junitOf(within);
    assert.deepEqual(x.each, [["rows [row 1: ok]", "passed"], ["rows [row 2: ok too]", "passed"]]);
    assert.match(x.cases[0].body, /<system-out>passed 1\/2 runs\nthe test: passed 3\/4 rows \(pass rate 0\.75, needs 0\.5\)\nrow 1: ok · run 2 · turn 1 · contains ok/);
  });

  it("a row whose turn broke, in a test that failed: an <error>; a test without rows, or one that errored as a whole, is one case", async () => {
    const broken = fakeTransport((req) => (JSON.parse(req.body).m === "boom" ? { status: 500, body: "{}" } : { body: JSON.stringify({ reply: JSON.parse(req.body).m }) }));
    const r = await run(rows(["ok", "boom"], "    retries: 0\n"), {}, broken);
    assert.equal(r.tests[0].status, "failed");
    assert.deepEqual(junitOf(r).each, [["rows [row 1: ok]", "passed"], ["rows [row 2: boom]", "error"]]);
    const all = await run(rows(["boom", "boom"], "    retries: 0\n"), {}, broken);
    assert.equal(all.tests[0].status, "error");
    // (two rows of the same name: their numbers keep them apart)
    assert.deepEqual(junitOf(all).each, [["rows [row 1: boom]", "error"], ["rows [row 2: boom]", "error"]]);
    oneCase(all, [0, 1]);
  });
});

describe("an unsure result that counts as failed (unsure: fail, the default), as each report says it", () => {
  // A judge plugin that answers 0.9 with confidence 0.3: a pass the judge wasn't sure of
  const files = (head = "") => ({
    "plugins/house.js": 'export default { kind: "judge", name: "house", version: "1.0.0", async judge() { return { value: 0.9, confidence: 0.3, reason: "looked" }; } };\n',
    "s.hafen.yml": `version: 1
name: Flows
${PROVIDER}
plugins: [plugins/house.js]
judges: { mine: { kind: plugin, plugin: house } }
tests:
  - name: judged
${head}    turns: [ { user: hi, expect: [ { type: judge, judge: mine, rubric: polite } ] } ]
`,
  });
  const SAID = "unsure: looked, but confidence 0.3 is below 0.6 (unsure counts as failed; --unsure warn to let it pass)";

  it("failed: the command line's line, JUnit's <failure>, the Markdown's and the JSON's problem say it was unsure, and how to let it pass", async () => {
    const r = await run(files());
    assert.deepEqual([r.turns[0].results[0].status, r.turns[0].results[0].unsure, r.tests[0].status, r.verdict], ["unsure", "fail", "failed", "failed"]);
    const [c] = casesOf(r);
    assert.equal(c.problems[0].text, `turn 1 · judge: polite 0.9: ${SAID}`);
    assert.match(junit(r), new RegExp(`<failure message="judge: polite 0\\.9: ${SAID.replace(/[()]/g, "\\$&").replace(/\./g, "\\.")}" type="judge">`));
    assert.ok(markdown(r).includes(`- **Flows › judged** · turn 1 · failed · \`judge: polite 0.9\`: ${SAID}`), markdown(r));
    assert.deepEqual(JSON.parse(jsonSummary(r)).tests[0].problems, [{ from: "turn", repeat: 1, row: null, turn: 0, status: "unsure", check: "judge: polite 0.9", reason: SAID, confidence: 0.3 }]);
  });

  it("warn: passed, with the warning in JUnit's <system-out> and the Markdown's Unsure; pass: passed quietly", async () => {
    const r = await run(files("    unsure: warn\n"));
    assert.deepEqual([r.tests[0].status, r.verdict], ["passed", "unsure"]);
    const line = "turn 1 · unsure: judge: polite 0.9: looked, but confidence 0.3 is below 0.6 (counted as passed: unsure is warn)";
    assert.ok(junit(r).includes(`<system-out>passed 1/1 (pass rate 1, needs 1)\n${line.replace(/'/g, "&apos;")}</system-out>`), junit(r));
    assert.ok(markdown(r).includes(`### Unsure\n\n- **Flows › judged** · ${line}`), markdown(r));
    assert.equal(countsText(r), "1 test · 0 failed · 1 unsure · 1 check");
    const quiet = await run(files("    unsure: pass\n"));
    assert.deepEqual([quiet.tests[0].status, quiet.tests[0].unsure, quiet.verdict], ["passed", false, "passed"]);
    assert.doesNotMatch(markdown(quiet), /### Unsure/);
  });
});
