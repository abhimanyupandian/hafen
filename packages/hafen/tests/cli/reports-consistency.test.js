// Every report agrees with `hafen run` (contracts/cli.md, Reports), end to end against the mock
// endpoint: for each kind of run (all passed; a check failed; a pass rate met with runs that failed, and
// missed; a turn's error; a timeout; a before fixture that failed; a suite's setup step that failed;
// --max-cost, stopping before a test and in the middle of others; --bail; unsure by default (fail), with
// --unsure warn, fail and pass, and the file's and the check's unsure; a judged value that misses with
// low confidence, under every policy; the endpoint down; two suites with a test of the same name; data
// rows, all passed, one failed, failed within the pass rate, and with repeats), the summary line, the
// exit code, JUnit (read as a CI system reads it), the Markdown's header and the JSON's summary count
// the same tests failed, errored and skipped, reach the same verdict, and every reason the command line
// gives is in each report. (JUnit gives each data row a case of its own: its counts are the rows', and
// still reach the verdict.)

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../helpers.js";

const CLI = fileURLToPath(new URL("../../cli/hafen.js", import.meta.url));
let mock;
const dirs = [];

// A JSON provider (one reply) at a path of the mock's, priced
const provider = (path, { price = "{ input: 1, output: 2 }", extra = "" } = {}) => `kind: http
url: "{{base_url}}${path}"
${extra}body: { message: "{{user}}" }
response:
  text: $.data.reply
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
price: ${price}
`;
const suite = (name, tests, head = "provider: providers/json.yml") => `version: 1
name: ${name}
${head}
environments:
  local: { base_url: "MOCK_URL" }
tests:
${tests}`;
const JUDGES = `provider: providers/json.yml
judges:
  default: { kind: systemone, endpoint: "{{base_url}}/systemone" }`;
// System One answers 0.55 with confidence 0.1 (the mock's UNSURE): within min 0.5, unsure; below
// min 0.8, failed, whatever the policy. (head: the test's own keys; check: the check's)
const UNSURE = ({ min = 0.5, head = "", check = "", defaults = "" } = {}) => suite("Flows", `  - name: unsure
${head}    turns:
      - user: a refund for 4417
        expect: [ { type: systemone.noul, question: "UNSURE: is it polite?", min: ${min}${check} } ]
`, `${JUDGES}${defaults}`);
const ROWS = (rows, { head = "", provider = "" } = {}) => ({
  "data/orders.csv": `question,order\n${rows}`,
  "s.hafen.yml": suite("Flows", `  - name: rows
    data: data/orders.csv
${head}    turns: [ { user: "{{row.question}}", expect: [ { path: $.data.order.id, equals: "{{row.order}}" } ] } ]
`, provider || undefined),
});
// Two rows, each run 3 times, against the flaky endpoint: a run fails in each row (calls 4 and 5)
const ROWS_REPEATED = (passRate) => ({
  "providers/flaky.yml": provider("/flaky?rate=0.7"),
  "data/orders.csv": "order\n4417\n4418\n",
  "s.hafen.yml": suite("Flows", `  - name: rows
    data: data/orders.csv
    repeat: 3
    pass_rate: ${passRate}
    turns: [ { user: "a refund for {{row.order}}", expect: [ { contains: refund } ] } ]
`, "provider: providers/flaky.yml"),
});
const FLAKY = (passRate) => ({
  "providers/flaky.yml": provider("/flaky?rate=0.7"),
  "s.hafen.yml": suite("Flows", `  - name: flaky
    repeat: 10
    pass_rate: ${passRate}
    turns: [ { user: a refund for 4417, expect: [ { contains: refund } ] } ]
`, "provider: providers/flaky.yml"),
});
const PRICEY = provider("/json", { price: "{ input: 1000, output: 2000 }" });

// Each run: its files, its options, and what it must come to (exit code; tests, failed, errors,
// skipped), and reasons each report must give besides those the command line printed
const RUNS = {
  "all passed": { code: 0, counts: [2, 0, 0, 0], files: { "s.hafen.yml": suite("Flows", `  - name: a
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
  - name: b
    turns: [ { user: hello, expect: [ { contains: hello } ] } ]
`) } },
  "a check failed": { code: 1, counts: [2, 1, 0, 0], files: { "s.hafen.yml": suite("Flows", `  - name: a
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
  - name: b
    turns: [ { user: hello, expect: [ { contains: nope }, { contains: hello } ] } ]
`) } },
  "pass rate met, with runs that failed": { code: 0, counts: [1, 0, 0, 0], files: FLAKY(0.5) },
  "pass rate missed": { code: 1, counts: [1, 1, 0, 0], files: FLAKY(0.9) },
  "a turn's error": { code: 1, counts: [2, 0, 1, 0], files: { "providers/broken.yml": provider("/error/500"), "s.hafen.yml": suite("Flows", `  - name: ok
    provider: providers/json.yml
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
  - name: broken
    retries: 0
    turns: [ { user: hi, expect: [ { contains: "You said" }, { type: status, equals: 200 }, { type: latency, max_ms: 5000 } ] } ]
`, "provider: providers/broken.yml") }, reasons: ["the mock is having a bad day"] },
  "a timeout": { code: 1, counts: [1, 0, 1, 0], args: ["--timeout", "200"], files: { "providers/slow.yml": provider("/slow?ms=2000"), "s.hafen.yml": suite("Flows", `  - name: slow
    retries: 0
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`, "provider: providers/slow.yml") }, reasons: ["timed out after 200 ms"] },
  "a before fixture failed": { code: 1, counts: [1, 0, 1, 0], files: {
    "plugins/login.js": 'export default { kind: "fixture", name: "login", version: "1.0.0", hosts: [], provides: [], async run() { throw new Error("login failed: 401"); } };\n',
    "providers/p.yml": provider("/json", { extra: "fixtures: { before: [login] }\n" }),
    "s.hafen.yml": suite("Flows", `  - name: needs login
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`, "provider: providers/p.yml") }, reasons: ['the fixture "login" (before) failed: login failed: 401'] },
  "a suite's setup step failed": { code: 2, counts: [2, 0, 1, 0], paths: [], files: {
    "a.hafen.yml": suite("Seeded", `  - name: refund
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`, `provider: providers/json.yml
setup:
  - name: seed
    request: { url: "{{base_url}}/error/500", method: POST }`),
    "b.hafen.yml": suite("Other", `  - name: refund
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`) }, reasons: ['setup step "seed" failed: status 500'] },
  "--max-cost, after a test failed": { code: 3, counts: [3, 1, 0, 1], args: ["--max-cost", "0.03"], files: { "providers/pricey.yml": PRICEY, "s.hafen.yml": suite("Flows", `  - name: t1
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
  - name: t2
    turns: [ { user: hi, expect: [ { contains: "nope" } ] } ]
  - name: t3
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`, "provider: providers/pricey.yml") }, reasons: ["the run's cost reached the limit ($0.03)"] },
  "--max-cost, in the middle of a test": { code: 3, counts: [3, 0, 0, 3], args: ["--max-cost", "0.01"], files: { "providers/pricey.yml": PRICEY, "providers/slow.yml": provider("/slow?ms=3000"), "s.hafen.yml": suite("Flows", `  - name: t1
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
  - name: t2
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
  - name: t3
    group: 2
    provider: providers/slow.yml
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`, "provider: providers/pricey.yml") }, reasons: ["the run's cost reached the limit ($0.01)"] },
  "--bail": { code: 3, counts: [2, 1, 0, 1], args: ["--bail"], files: { "s.hafen.yml": suite("Flows", `  - name: first
    turns: [ { user: hi, expect: [ { contains: nope } ] } ]
  - name: second
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`) }, reasons: ["stopped at the first failure (first)"] },
  "unsure, by default: counted as failed": { code: 1, counts: [1, 1, 0, 0], files: { "s.hafen.yml": UNSURE() }, reasons: ["noul 0.55", "unsure: 0.55 within 0.5–1, but confidence 0.1 is below 0.6 (unsure counts as failed; --unsure warn to let it pass)"] },
  "unsure, --unsure warn": { code: 0, counts: [1, 0, 0, 0], unsure: 1, args: ["--unsure", "warn"], files: { "s.hafen.yml": UNSURE() }, reasons: ["noul 0.55"], junitSays: ["unsure: noul 0.55: 0.55 within 0.5–1, but confidence 0.1 is below 0.6 (counted as passed: unsure is warn)"] },
  "unsure, --unsure fail": { code: 1, counts: [1, 1, 0, 0], args: ["--unsure", "fail"], files: { "s.hafen.yml": UNSURE() }, reasons: ["noul 0.55"] },
  "unsure, --unsure pass": { code: 0, counts: [1, 0, 0, 0], args: ["--unsure", "pass"], files: { "s.hafen.yml": UNSURE() } },
  "unsure, the suite's defaults say warn": { code: 0, counts: [1, 0, 0, 0], unsure: 1, files: { "s.hafen.yml": UNSURE({ defaults: "\ndefaults: { unsure: warn }" }) } },
  "unsure, the check says pass (the test, fail)": { code: 0, counts: [1, 0, 0, 0], files: { "s.hafen.yml": UNSURE({ head: "    unsure: fail\n", check: ", unsure: pass" }) } },
  "unsure, the check says warn, --unsure fail over it": { code: 1, counts: [1, 1, 0, 0], args: ["--unsure", "fail"], files: { "s.hafen.yml": UNSURE({ check: ", unsure: warn" }) }, reasons: ["(unsure counts as failed; --unsure warn to let it pass)"] },
  "a value below its min, with low confidence: failed by default": { code: 1, counts: [1, 1, 0, 0], files: { "s.hafen.yml": UNSURE({ min: 0.8 }) }, reasons: ["0.55 outside 0.8–1"] },
  "a value below its min, with low confidence: failed with --unsure warn": { code: 1, counts: [1, 1, 0, 0], args: ["--unsure", "warn"], files: { "s.hafen.yml": UNSURE({ min: 0.8 }) }, reasons: ["0.55 outside 0.8–1"] },
  "a value below its min, with low confidence: failed with --unsure pass": { code: 1, counts: [1, 1, 0, 0], args: ["--unsure", "pass"], files: { "s.hafen.yml": UNSURE({ min: 0.8 }) }, reasons: ["0.55 outside 0.8–1"] },
  "the endpoint down (--network drop=1)": { code: 1, counts: [2, 0, 2, 0], args: ["--network", "drop=1"], files: { "s.hafen.yml": suite("Flows", `  - name: a
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
  - name: b
    turns: [ { user: hi, expect: [ { type: status, equals: 200 } ] } ]
`) }, reasons: ["the connection dropped (network simulation)"] },
  "two suites, a test of the same name in each": { code: 1, counts: [2, 1, 0, 0], paths: [], files: {
    "a.hafen.yml": suite("Billing", "  - name: refund\n    turns: [ { user: hi, expect: [ { contains: nope } ] } ]\n"),
    "b.hafen.yml": suite("Support", "  - name: refund\n    turns: [ { user: hi, expect: [ { contains: \"You said\" } ] } ]\n") } },
  "data rows, all passed": { code: 0, counts: [1, 0, 0, 0], junit: [3, 0, 0, 0], files: ROWS("a refund for 4417,4417\nwhere is my parcel,4417\nhello,4417\n") },
  "data rows, a row failed (pass rate 1)": { code: 1, counts: [1, 1, 0, 0], junit: [3, 1, 0, 0], files: ROWS("a refund for 4417,4417\nwhere is my parcel,4417\na refund please,9999\n") },
  "data rows, a row failed within the pass rate": { code: 0, counts: [1, 0, 0, 0], junit: [3, 0, 0, 1], files: ROWS("a refund for 4417,4417\nwhere is my parcel,4417\na refund please,9999\n", { head: "    pass_rate: 0.6\n" }),
    junitSays: ["failed, within the test's pass rate (2/3 ≥ 0.6): $.data.order.id = {{row.order}}: 4417 ≠ 9999"] },
  "data rows, a row errored (the test failed: an <error> in JUnit)": { code: 1, counts: [1, 1, 0, 0], junit: [2, 0, 1, 0], args: ["--timeout", "200"], files: {
    "data/orders.csv": "question,order,ms\nhi,4417,0\nhello,4417,2000\n",
    "providers/slow.yml": provider("/slow?ms={{row.ms}}"),
    "s.hafen.yml": suite("Flows", `  - name: rows
    data: data/orders.csv
    retries: 0
    turns: [ { user: "{{row.question}}", expect: [ { path: $.data.order.id, equals: "{{row.order}}" } ] } ]
`, "provider: providers/slow.yml") }, reasons: ["timed out after 200 ms"] },
  "data rows × repeats, a run failed in each row, within the pass rate": { code: 0, counts: [1, 0, 0, 0], junit: [2, 0, 0, 0], files: ROWS_REPEATED(0.6), junitSays: ["passed 2/3 runs"] },
  "data rows × repeats, the pass rate missed": { code: 1, counts: [1, 1, 0, 0], junit: [2, 2, 0, 0], files: ROWS_REPEATED(0.7), junitSays: ["passed 2/3 runs"] },
};

before(async () => {
  mock = await startMock({ chunkMs: 1 });
});
after(async () => {
  await mock.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
beforeEach(() => mock.reset());

async function project(files) {
  const dir = await mkdtemp(join(tmpdir(), "hafen-consistency-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries({ "providers/json.yml": provider("/json"), ...files })) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text.replaceAll("MOCK_URL", mock.url));
  }
  return dir;
}

function cli(dir, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: "1", JEV_API_KEY: "jev-secret-key-1", GITHUB_STEP_SUMMARY: "", HAFEN_CONCURRENCY: "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const said = (r) => `exit ${r.code}\n${r.stdout}\n${r.stderr}`;

const unxml = (s) => s.replace(/&(lt|gt|amp|quot|apos);/g, (_, e) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e]);
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], unxml(m[2])]));

// JUnit as a CI system reads it: its totals, each suite's, each case's status (and a <skipped>'s
// message)
function readJUnit(xml) {
  const root = attrs(xml.match(/<testsuites [^>]*>/)[0]);
  const suites = [...xml.matchAll(/<testsuite [^>]*>[\s\S]*?<\/testsuite>/g)].map(([text]) => ({
    ...attrs(text.match(/<testsuite [^>]*>/)[0]),
    properties: Object.fromEntries([...text.matchAll(/<property name="([^"]+)" value="([^"]*)"\/>/g)].map((m) => [m[1], unxml(m[2])])),
    cases: [...text.matchAll(/<testcase ([^>]*)>([\s\S]*?)<\/testcase>/g)].map((m) => ({
      ...attrs(m[1]),
      statuses: (m[2].match(/<(failure|error|skipped)[ />]/g) ?? []).map((s) => s.slice(1, -1)),
      skipped: attrs(m[2].match(/<skipped [^>]*>/)?.[0] ?? "").message,
    })),
  }));
  return { root, suites, text: unxml(xml) };
}

// A test's JUnit cases: its own, or one for each data row ("rows [row 2: hello]"); and how they say it went:
// broke (a failure or an error), skipped (only skipped, none for failing within the pass rate), or
// passed
const casesFor = (suite, test) => suite.cases.filter((x) => x.name === test || x.name.startsWith(`${test} [row `));
function caseStatus(cases) {
  if (cases.some((c) => ["failure", "error"].includes(c.statuses[0]))) return "broke";
  if (cases.every((c) => c.statuses[0] === "skipped" && !/^(failed|an error), within the test's pass rate/.test(c.skipped))) return "skipped";
  return "passed";
}

// The counts a summary gives: "3 tests · 1 failed · 1 error · 1 skipped · 0 unsure · 2 checks"
const COUNTS = /(\d+) tests? · (\d+) failed(?: · (\d+) errors?)?(?: · (\d+) skipped)? · (\d+) unsure · (\d+) checks?/;
const countsIn = (line) => {
  const m = line.match(COUNTS);
  assert.ok(m, `no counts in ${JSON.stringify(line)}`);
  return { tests: +m[1], failed: +m[2], errors: +(m[3] ?? 0), skipped: +(m[4] ?? 0), unsure: +m[5], checks: +m[6] };
};

// Every string in a JSON value
const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

// Why, in a line the command line printed: without where (row 2: hello · run 3 · turn 1, a suite's
// file) and the check's name (each report says it its own way: `contains nope`: …)
function reasonOf(line) {
  const text = line.trim().replace(/^(row \d+(?:: .*?)? · |run \d+ · |turn \d+ · |conversation · )+/, "").replace(/^error(: | · )/, "").replace(/^\S+\.hafen\.yml: /, "");
  return text.match(/^.+?: (.+)$/)?.[1] ?? text;
}

describe("every report agrees with the run and its exit code", () => {
  for (const [name, want] of Object.entries(RUNS)) {
    it(name, async () => {
      const dir = await project(want.files);
      const r = await cli(dir, ["run", ...(want.paths ?? ["s.hafen.yml"]), ...(want.args ?? []), "--report", "junit:out/junit.xml", "--report", "md:out/summary.md", "--report", "json:out/summary.json"]);
      assert.equal(r.code, want.code, said(r));
      const xml = readJUnit(await readFile(join(dir, "out/junit.xml"), "utf8"));
      const md = await readFile(join(dir, "out/summary.md"), "utf8");
      const json = JSON.parse(await readFile(join(dir, "out/summary.json"), "utf8"));

      // The counts: the summary line's, JUnit's, the Markdown header's, the JSON summary's (JUnit's
      // cases are the data rows, when a test has them)
      const [tests, failed, errors, skipped] = want.counts;
      const expected = { tests, failed, errors, skipped };
      const [junitTests, junitFailed, junitErrors, junitSkipped] = want.junit ?? want.counts;
      const pick = (c) => ({ tests: c.tests, failed: c.failed, errors: c.errors, skipped: c.skipped });
      const consoleCounts = countsIn(r.stdout.split("\n").find((l) => /^\d+ suites? · /.test(l)) ?? "");
      const mdCounts = countsIn(md.split("\n")[2]);
      const t = json.summary.tests;
      assert.deepEqual(pick(consoleCounts), expected, `the summary line\n${said(r)}`);
      assert.deepEqual({ tests: +xml.root.tests, failed: +xml.root.failures, errors: +xml.root.errors, skipped: +xml.root.skipped }, { tests: junitTests, failed: junitFailed, errors: junitErrors, skipped: junitSkipped }, `JUnit\n${xml.text}`);
      assert.deepEqual(pick(mdCounts), expected, "the Markdown header");
      assert.deepEqual({ tests: t.total, failed: t.failed, errors: t.error, skipped: t.skipped + t.stopped }, expected, "the JSON summary");
      assert.equal(json.tests.length, tests, "a JSON test a case");
      assert.deepEqual([mdCounts.unsure, t.unsure], [consoleCounts.unsure, consoleCounts.unsure], "unsure");
      assert.equal(consoleCounts.unsure, want.unsure ?? 0);
      // (checks: those that ran, a check turned off or never reached not counted)
      const checks = xml.suites[0].properties.checks.split("/")[1];
      assert.deepEqual([mdCounts.checks, +checks, json.summary.checks.total - json.summary.checks.skipped], [consoleCounts.checks, consoleCounts.checks, consoleCounts.checks], "checks");

      // JUnit's suites add up to its totals, each case has one status at most, and none counts more
      // than it has
      const cases = xml.suites.flatMap((s) => s.cases);
      assert.equal(cases.length, junitTests);
      for (const c of cases) assert.ok(c.statuses.length <= 1, `${c.classname} › ${c.name}: ${c.statuses.join(", ")}`);
      const sum = (key) => xml.suites.reduce((n, s) => n + +s[key], 0);
      assert.deepEqual([sum("tests"), sum("failures"), sum("errors"), sum("skipped")], [junitTests, junitFailed, junitErrors, junitSkipped]);
      const by = (status) => cases.filter((c) => c.statuses[0] === status).length;
      assert.deepEqual([by("failure"), by("error"), by("skipped")], [junitFailed, junitErrors, junitSkipped]);
      for (const s of xml.suites) {
        assert.ok(+s.failures + +s.errors + +s.skipped <= +s.tests, s.name);
        assert.equal(+s.tests, s.cases.length, s.name);
      }

      // The verdict: what a CI system reading only one report concludes is what the exit code says
      const heading = md.split("\n")[0].replace("## Hafen · ", "");
      const broke = failed + errors > 0;
      assert.equal(junitFailed + junitErrors > 0, broke, "JUnit's failures and errors alone reach the verdict");
      if (want.code === 0) assert.ok(!broke && ["passed", "unsure"].includes(heading) && ["passed", "unsure"].includes(json.verdict), heading);
      if (want.code === 1) assert.ok(broke && heading === "failed" && json.verdict === "failed", heading);
      if (want.code === 2) assert.ok(errors > 0 && heading === "error" && json.status === "error", heading);
      if (want.code === 3) assert.ok(heading === "stopped" && json.status === "stopped" && xml.suites[0].properties.status === "stopped" && broke === (json.verdict === "failed"), heading);

      // Each test's status: the command line's line for it, its JUnit case, its Markdown row, its JSON
      const kind = { "✓": "passed", "!": "passed", "✗": "broke", "–": "skipped" };
      const lines = [...r.stdout.matchAll(/^([✓!✗–]) (.+?) › (.+?)(?: {3}|$)/gm)];
      assert.ok(lines.length, said(r));
      for (const [, icon, suiteName, test] of lines) {
        const mine = casesFor(xml.suites.find((s) => s.name === suiteName) ?? { cases: [] }, test);
        assert.ok(mine.length, `JUnit has ${suiteName} › ${test}`);
        assert.equal(caseStatus(mine), kind[icon], `${suiteName} › ${test} in JUnit`);
        const row = md.split("\n").find((l) => l.startsWith(`| ${icon === "!" ? "!" : icon} | ${test} | ${suiteName} |`));
        assert.ok(row, `the Markdown has a row for ${suiteName} › ${test}`);
        const file = xml.suites.find((s) => s.name === suiteName).file;
        const j = json.tests.find((x) => x.name === test && x.suite === file);
        assert.equal({ failed: "broke", error: "broke", skipped: "skipped", stopped: "skipped" }[j?.status] ?? "passed", kind[icon], `${suiteName} › ${test} in the JSON`);
      }

      // Every reason: each the command line gave (what went wrong, a line under a test; a suite's
      // setup; the stop), and each this run must give, in every report
      const reasons = [
        ...[...r.stdout.matchAll(/^ {4}(?!…|unsure: )(.+)$/gm)].map((m) => m[1]),
        ...r.stderr.split("\n").filter(Boolean),
        ...[...r.stdout.matchAll(/^stopped: (.+)$/gm)].map((m) => m[1]),
      ].map(reasonOf);
      for (const reason of [...reasons, ...(want.reasons ?? [])]) {
        assert.ok(xml.text.includes(reason), `JUnit says "${reason}"`);
        assert.ok(md.includes(reason), `the Markdown says "${reason}"\n${md}`);
        assert.ok(strings(json).some((s) => s.includes(reason)), `the JSON says "${reason}"`);
      }
      for (const text of want.junitSays ?? []) assert.ok(xml.text.includes(text), `JUnit says "${text}"\n${xml.text}`);
    });
  }
});
