// Every report (the summary line, JUnit, Markdown, JSON, the run file) agrees with the run and its exit
// code, end to end against the mock endpoint; report formats, paths and options checked before anything
// is sent; report and compare; what the output and the reports say.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { CLI, JSON_PROVIDER, cli, dirs, mock, project, readJSON, said, suite, useMock } from "./helpers.js";

useMock();

describe("every report agrees with the run and its exit code", () => {
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
        env: { ...process.env, NO_COLOR: "1", JEV_API_KEY: "jev-secret-key-1", GITHUB_STEP_SUMMARY: "" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

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

describe("report formats, paths and options; what reports say", () => {
  // A JSON provider (one reply, in one chunk), priced; and the same with no price
  const JSON_PROVIDER = `kind: http
url: "{{base_url}}/json"
body: { message: "{{user}}" }
response:
  text: $.data.reply
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
price: { input: 1, output: 2 }
`;
  const UNPRICED = JSON_PROVIDER.replace("price: { input: 1, output: 2 }\n", "");

  async function project(files) {
    const dir = await mkdtemp(join(tmpdir(), "hafen-reports-"));
    dirs.push(dir);
    const all = { "providers/json.yml": JSON_PROVIDER, "providers/unpriced.yml": UNPRICED, ...files };
    for (const [path, text] of Object.entries(all)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text.replaceAll("MOCK_URL", mock.url));
    }
    return dir;
  }

  function cli(dir, args) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "" } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
    });
  }
  const noStack = (r) => assert.doesNotMatch(r.all, /at .*\.js:\d+|^\s*Error:/m, `a plain line, not a stack trace\n${said(r)}`);

  const suite = (tests, head = "provider: providers/json.yml") => `version: 1
name: Reports
${head}
environments:
  local: { base_url: "MOCK_URL" }
tests:
${tests}`;

  const PASSING = suite(`  - name: hello
    turns: [ { user: hello, expect: [ { contains: "hello" } ] } ]
`);

  // (a folder a test locked: unlocked, so that it can be removed)
  after(async () => {
    for (const d of dirs) await chmod(join(d, "locked"), 0o755).catch(() => {});
  });

  describe("a conversation's checks (expect_conversation) in every report", () => {
    it("the turn's check passes, the conversation's fails: JSON lists both (from: turn | conversation), Markdown and JUnit say why, and they add up to the summary", async () => {
      const dir = await project({
        "data/rows.csv": "question\nhello there\nwhere is my parcel\n",
        "s.hafen.yml": suite(`  - name: whole
    data: data/rows.csv
    turns: [ { user: "{{row.question}}", expect: [ { contains: "You said" } ] } ]
    expect_conversation:
      - { path: "$[*].reply", contains: parcel }
`),
      });
      const r = await cli(dir, ["run", "s.hafen.yml", "--report", "json:out/s.json", "--report", "md:out/s.md", "--report", "junit:out/j.xml"]);
      assert.equal(r.code, 1, said(r));
      assert.match(r.stdout, /row 1: hello there · conversation · \$\[\*\]\.reply contains parcel: didn't find parcel/);

      const json = await readJSON(dir, "out/s.json");
      assert.deepEqual(json.results.map((x) => [x.from, x.turn, x.row, x.check, x.status]), [
        ["turn", 0, 1, "contains You said", "pass"],
        ["turn", 0, 2, "contains You said", "pass"],
        ["conversation", null, 1, "$[*].reply contains parcel", "fail"],
        ["conversation", null, 2, "$[*].reply contains parcel", "pass"],
      ]);
      // (each row by its name too, its first column's value)
      assert.deepEqual(json.results.map((x) => x.row_name), ["hello there", "where is my parcel", "hello there", "where is my parcel"]);
      assert.deepEqual(json.tests[0].problems.map((p) => [p.row, p.row_name]), [[1, "hello there"]]);
      assert.equal(json.results.find((x) => x.status === "fail").reason, "didn't find parcel");
      assert.equal(json.results.find((x) => x.from === "conversation").test, "whole");
      const count = (status) => json.results.filter((x) => x.status === status).length;
      assert.deepEqual([count("pass"), count("fail"), json.results.length], [json.summary.checks.passed, json.summary.checks.failed, json.summary.checks.total]);

      const md = await readFile(join(dir, "out/s.md"), "utf8");
      assert.match(md, /### Failures\n\n- \*\*Reports › whole\*\* · row 1: hello there · conversation · failed · `\$\[\*\]\.reply contains parcel`: didn't find parcel\n/);
      assert.match(md, /\| ✗ \| whole \| Reports \| 1\/2 \| 3\/4 \|/);
      const xml = await readFile(join(dir, "out/j.xml"), "utf8");
      assert.match(xml, /<failure message="conversation · \$\[\*\]\.reply contains parcel: didn&apos;t find parcel" type="check">row 1: hello there · conversation · /);
    });
  });

  describe("report formats and paths", () => {
    it("report: a format that isn't one exits 2, before anything is written", async () => {
      const dir = await project({ "s.hafen.yml": PASSING });
      assert.equal((await cli(dir, ["run", "s.hafen.yml", "--report", "run:r.json"])).code, 0);
      const r = await cli(dir, ["report", "r.json", "--report", "md:out/a.md", "--report", "xml:x"]);
      assert.equal(r.code, 2, said(r));
      assert.match(r.stderr, /unknown report format "xml" \(junit, run, md, json\)/);
      assert.ok(!existsSync(join(dir, "out/a.md")), "nothing written");
      assert.ok(!existsSync(join(dir, "x")));
      noStack(r);
      // (and with no path after the colon)
      const empty = await cli(dir, ["report", "r.json", "--report", "md:"]);
      assert.equal(empty.code, 2, said(empty));
      assert.match(empty.stderr, /--report md: needs a path/);
    });

    it("a path that can't be written (under a file, in a locked folder, a folder itself): a setup error before anything is sent, nothing written", async () => {
      const dir = await project({ "s.hafen.yml": PASSING });
      const under = await cli(dir, ["run", "s.hafen.yml", "--report", "md:s.hafen.yml/x.md", "--report", "junit:ok.xml"]);
      assert.equal(under.code, 2, said(under));
      assert.match(under.stderr, /^can't write the md report to s\.hafen\.yml\/x\.md: s\.hafen\.yml isn't a folder$/m);
      noStack(under);
      const folder = await cli(dir, ["run", "s.hafen.yml", "--report", "junit:providers"]);
      assert.equal(folder.code, 2, said(folder));
      assert.match(folder.stderr, /can't write the junit report to providers: it's a folder/);
      // (root can write anywhere: no locked folder for it)
      if (process.getuid?.() !== 0 && process.platform !== "win32") {
        await mkdir(join(dir, "locked"));
        await chmod(join(dir, "locked"), 0o555);
        const locked = await cli(dir, ["run", "s.hafen.yml", "--report", "md:locked/deep/x.md"]);
        assert.equal(locked.code, 2, said(locked));
        assert.match(locked.stderr, /can't write the md report to locked\/deep\/x\.md: the folder locked\/deep can't be made \(permission denied\)/);
        const report = await cli(dir, ["report", "nope.json", "--report", "md:locked/x.md"]);
        assert.equal(report.code, 2, said(report));
        assert.match(report.stderr, /can't write the md report to locked\/x\.md: the folder locked can't be written in/);
      }
      assert.equal(mock.log.length, 0, "nothing sent");
      assert.ok(!existsSync(join(dir, "ok.xml")), "nothing written");
    });

    it("a report that still can't be written at the end: one line, the others written; a run that passed exits 2, one that failed keeps 1", { skip: process.platform === "win32" }, async () => {
      const dir = await project({
        "s.hafen.yml": PASSING,
        "f.hafen.yml": PASSING.replace('contains: "hello"', 'contains: "goodbye"'),
      });
      // A link to a folder that isn't there: the check before sending sees nothing wrong, writing fails
      await symlink(join(dir, "gone"), join(dir, "dangling"));
      const passed = await cli(dir, ["run", "s.hafen.yml", "--report", "md:dangling/x.md", "--report", "junit:ok.xml"]);
      assert.equal(passed.code, 2, said(passed));
      assert.match(passed.stderr, /^couldn't write the md report to dangling\/x\.md: .+$/m);
      assert.match(await readFile(join(dir, "ok.xml"), "utf8"), /<testsuites name="Hafen"/);
      noStack(passed);
      const failed = await cli(dir, ["run", "f.hafen.yml", "--report", "md:dangling/x.md", "--report", "json:ok.json"]);
      assert.equal(failed.code, 1, said(failed));
      assert.match(failed.stderr, /couldn't write the md report to dangling\/x\.md/);
      assert.equal((await readJSON(dir, "ok.json")).verdict, "failed");
      // report: the same, exit 2
      await cli(dir, ["run", "s.hafen.yml", "--report", "run:r.json"]);
      const report = await cli(dir, ["report", "r.json", "--report", "md:dangling/x.md", "--report", "json:r2.json"]);
      assert.equal(report.code, 2, said(report));
      assert.ok(existsSync(join(dir, "r2.json")));
      noStack(report);
    });
  });

  describe("options that would do nothing", () => {
    it("--fail-on without --baseline: exit 2, nothing sent", async () => {
      const dir = await project({ "s.hafen.yml": PASSING });
      const r = await cli(dir, ["run", "s.hafen.yml", "--fail-on", "p95=10"]);
      assert.equal(r.code, 2, said(r));
      assert.match(r.stderr, /--fail-on compares with a baseline: add --baseline <run file>/);
      assert.equal(mock.log.length, 0);
    });

    it("--max-cost with no prices anywhere: exit 2, nothing sent; a suite's prices for the model are enough", async () => {
      const dir = await project({
        "s.hafen.yml": PASSING.replace("providers/json.yml", "providers/unpriced.yml"),
        "priced.hafen.yml": PASSING.replace("provider: providers/json.yml", "providers:\n  m: { kind: http, url: \"{{base_url}}/json\", model: m1, body: { message: \"{{user}}\" }, response: { text: $.data.reply, usage: { input: $.usage.input_tokens, output: $.usage.output_tokens } } }\nprovider: m\nprices:\n  m1: { input: 1, output: 2 }"),
      });
      const r = await cli(dir, ["run", "s.hafen.yml", "--max-cost", "1"]);
      assert.equal(r.code, 2, said(r));
      assert.match(r.stderr, /--max-cost needs prices: .*; add prices to the suite or a provider's price, or leave out --max-cost/);
      assert.equal(mock.log.length, 0);
      const priced = await cli(dir, ["run", "priced.hafen.yml", "--max-cost", "1"]);
      assert.equal(priced.code, 0, said(priced));
    });
  });

  describe("what reports say", () => {
    it("a cost check's reason has the digits it needs; Markdown counts in the singular; costs are never $0.0000", async () => {
      const dir = await project({
        "s.hafen.yml": suite(`  - name: pricey
    turns: [ { user: hi, expect: [ { type: cost, max_cost: 0.000001 } ] } ]
`),
      });
      const r = await cli(dir, ["run", "s.hafen.yml", "--report", "md:out/s.md"]);
      assert.equal(r.code, 1, said(r));
      // (11 tokens in at $1, 3 out at $2, a million: $0.000017)
      assert.match(r.stdout, /cost ≤ \$0\.000001: \$0\.000017 > \$0\.000001/);
      assert.match(r.stdout, /\$0\.000017/);
      assert.doesNotMatch(r.all, /\$0\.0000\b/);
      const md = await readFile(join(dir, "out/s.md"), "utf8");
      assert.match(md, /^1 test · 1 failed · 0 unsure · 1 check · /m);
      assert.match(md, /`cost ≤ \$0\.000001`: \$0\.000017 > \$0\.000001/);
      assert.doesNotMatch(md, /\$0\.0000\b|1 tests|1 checks/);
    });

    it("compare: a run whose tests passed but that regressed is headed regressed; p95 noise (under 50 ms) isn't a regression", async () => {
      const dir = await project({ "s.hafen.yml": PASSING });
      assert.equal((await cli(dir, ["run", "s.hafen.yml", "--report", "run:r.json"])).code, 0);
      const run = await readJSON(dir, "r.json");
      const withP95 = (ms) => ({ ...run, summary: { ...run.summary, latency: { ...run.summary.latency, total: { ...run.summary.latency.total, p95: ms } } } });
      await writeFile(join(dir, "fast.json"), JSON.stringify(withP95(4)));
      await writeFile(join(dir, "noise.json"), JSON.stringify(withP95(11)));
      await writeFile(join(dir, "slow.json"), JSON.stringify(withP95(400)));
      // 4 ms to 11 ms: +175%, and noise
      const noise = await cli(dir, ["compare", "noise.json", "--baseline", "fast.json", "--fail-on", "p95=20"]);
      assert.equal(noise.code, 0, said(noise));
      assert.match(noise.stdout, /^## Hafen · passed$/m);
      assert.doesNotMatch(noise.stdout, /Regressed/);
      const slow = await cli(dir, ["compare", "slow.json", "--baseline", "fast.json", "--fail-on", "p95=20"]);
      assert.equal(slow.code, 1, said(slow));
      assert.match(slow.stdout, /^## Hafen · regressed$/m);
      assert.match(slow.stdout, /\*\*Regressed:\*\* p95 rose 9900% \(limit 20%\)/);
    });
  });
});

describe("reports, compare and the run file", () => {
  const passing = suite(`  - name: refund
    turns:
      - user: a refund for 4417
        expect: [ { type: status, equals: 200 }, { contains: "4417" } ]
  - name: greeting
    turns: [ { user: hello, expect: [ { contains: "hello" } ] } ]
`);

  it("every format to a file or to standard output (-); an unknown format says so; the run file by default", async () => {
    const dir = await project({ "s.hafen.yml": passing });
    const stdout = await cli(dir, ["run", "s.hafen.yml", "--quiet", "--report", "json:-"]);
    assert.equal(stdout.code, 0, said(stdout));
    const summary = JSON.parse(stdout.stdout);
    assert.equal(summary.verdict ?? summary.summary?.verdict ?? "passed", "passed");
    const junit = await cli(dir, ["run", "s.hafen.yml", "--quiet", "--report", "junit:-"]);
    assert.match(junit.stdout, /^<\?xml/);
    assert.match(junit.stdout, /<testsuite name="Flows" file="s.hafen.yml" tests="2" failures="0"/);
    const md = await cli(dir, ["run", "s.hafen.yml", "--quiet", "--report", "md:-"]);
    assert.match(md.stdout, /## Hafen · passed/);
    const unknown = await cli(dir, ["run", "s.hafen.yml", "--report", "pdf:out/x.pdf"]);
    assert.match(unknown.stderr, /unknown report format "pdf"/);
    // With no --report, the run file goes to .hafen/runs/
    const plain = await cli(dir, ["run", "s.hafen.yml"]);
    const at = plain.stdout.match(/Run file: (\S+)/)[1];
    assert.match(at, /^\.hafen\/runs\/.+\.hafen-run\.json$/);
    assert.equal((await readJSON(dir, at)).kind, "hafen-run");
  });

  it("report writes every format from a run file; compare exits 0 without a regression and 1 with one", async () => {
    const dir = await project({ "s.hafen.yml": passing });
    await cli(dir, ["run", "s.hafen.yml", "--report", "run:base.json"]);
    for (const format of ["junit", "md", "json", "run"]) {
      const r = await cli(dir, ["report", "base.json", "--report", `${format}:out/r.${format}`]);
      assert.equal(r.code, 0, `${format}: ${said(r)}`);
      assert.ok((await readFile(join(dir, `out/r.${format}`), "utf8")).length > 50);
    }
    const md = await cli(dir, ["report", "base.json"]);
    assert.match(md.stdout, /## Hafen · passed/);
    const same = await cli(dir, ["compare", "base.json", "--baseline", "base.json"]);
    assert.equal(same.code, 0, said(same));
    // A run where one test fails: the pass rate drops 50 points
    await writeFile(join(dir, "s.hafen.yml"), passing.replace('{ contains: "hello" }', '{ contains: "goodbye" }').replaceAll("MOCK_URL", mock.url));
    const worse = await cli(dir, ["run", "s.hafen.yml", "--report", "run:worse.json", "--baseline", "base.json"]);
    assert.equal(worse.code, 1, said(worse));
    assert.match(worse.stdout, /regressed: /);
    const compared = await cli(dir, ["compare", "worse.json", "--baseline", "base.json"]);
    assert.equal(compared.code, 1);
    const allowed = await cli(dir, ["compare", "worse.json", "--baseline", "base.json", "--fail-on", "pass_rate=60"]);
    assert.equal(allowed.code, 0, said(allowed));
    const badFailOn = await cli(dir, ["compare", "worse.json", "--baseline", "base.json", "--fail-on", "speed=1"]);
    assert.equal(badFailOn.code, 2);
    const noBaseline = await cli(dir, ["compare", "worse.json"]);
    assert.equal(noBaseline.code, 2);
    const unreadable = await cli(dir, ["run", "s.hafen.yml", "--baseline", "nope.json"]);
    assert.equal(unreadable.code, 2, said(unreadable));
    assert.match(unreadable.stderr, /the baseline can't be read/);
    const notRun = await cli(dir, ["report", "s.hafen.yml"]);
    assert.equal(notRun.code, 2);
  });

  it("GITHUB_STEP_SUMMARY gets the Markdown summary appended", async () => {
    const dir = await project({ "s.hafen.yml": passing, "summary.md": "# Before\n" });
    const r = await cli(dir, ["run", "s.hafen.yml"], { env: { GITHUB_STEP_SUMMARY: join(dir, "summary.md") } });
    assert.equal(r.code, 0, said(r));
    const text = await readFile(join(dir, "summary.md"), "utf8");
    assert.match(text, /^# Before\n/);
    assert.match(text, /## Hafen · passed/);
  });

  it("the output: a line per test with its counts, time and cost, then the summary; --quiet prints nothing", async () => {
    const dir = await project({ "s.hafen.yml": passing });
    const r = await cli(dir, ["run", "s.hafen.yml"]);
    assert.equal(r.code, 0, said(r));
    assert.match(r.stdout, /✓ Flows › refund {3}1\/1 {3}2\/2 checks {3}\d+\.\d s {3}\$\d/);
    assert.match(r.stdout, /1 suite · 2 tests · 0 failed · 0 unsure · 3 checks · p50 .* · p95 .* · \$\d.* · \d+\.\d s/);
    const quiet = await cli(dir, ["run", "s.hafen.yml", "--quiet"]);
    assert.equal(quiet.code, 0);
    assert.equal(quiet.stdout, "");
  });

  it("groups: the same group one after another, different groups at once, none one group; suites too", async () => {
    const dir = await project({
      "providers/slow.yml": `kind: http\nurl: "{{base_url}}/slow?ms=200"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
      "plain.hafen.yml": suite([0, 1, 2, 3].map((k) => `  - name: t${k}\n    turns: [ { user: "m${k}" } ]\n`).join(""), "provider: providers/slow.yml"),
      "grouped.hafen.yml": suite([0, 1, 2, 3].map((k) => `  - name: g${k}\n    group: ${k % 2 + 1}\n    turns: [ { user: "g${k}" } ]\n`).join(""), "provider: providers/slow.yml"),
      "one.hafen.yml": suite("  - name: one\n    turns: [ { user: one } ]\n", "group: 7\nprovider: providers/slow.yml"),
      "two.hafen.yml": suite("  - name: two\n    turns: [ { user: two } ]\n", "group: 7\nprovider: providers/slow.yml"),
      "three.hafen.yml": suite("  - name: three\n    turns: [ { user: three } ]\n", "group: 8\nprovider: providers/slow.yml"),
    });
    const tests = (run) => run.spans.filter((x) => x.kind === "test");
    const overlap = (a, b) => a.start < b.end && b.start < a.end;
    const any = (run) => tests(run).some((a) => tests(run).some((b) => a !== b && overlap(a, b)));
    // No groups: one group, one after another, in order
    const plain = await cli(dir, ["run", "plain.hafen.yml", "--report", "run:out/plain.json"]);
    assert.equal(plain.code, 0, said(plain));
    const p = await readJSON(dir, "out/plain.json");
    assert.equal(any(p), false);
    assert.deepEqual(p.tests.map((t) => t.name), ["t0", "t1", "t2", "t3"]);
    // Two groups: at once, each in order
    const grouped = await cli(dir, ["run", "grouped.hafen.yml", "--report", "run:out/grouped.json"]);
    assert.equal(grouped.code, 0, said(grouped));
    const g = await readJSON(dir, "out/grouped.json");
    const t = (name) => tests(g).find((x) => x.name === name);
    assert.ok(overlap(t("g0"), t("g1")) && overlap(t("g2"), t("g3")));
    assert.ok(t("g0").end <= t("g2").start && t("g1").end <= t("g3").start);
    // Suites: one and two (group 7) one after another; three (group 8) alongside
    const suites = await cli(dir, ["run", "one.hafen.yml", "two.hafen.yml", "three.hafen.yml", "--report", "run:out/suites.json"]);
    assert.equal(suites.code, 0, said(suites));
    const sp = (await readJSON(dir, "out/suites.json")).spans.filter((x) => x.kind === "suite");
    const [one, two, three] = ["one.hafen.yml", "two.hafen.yml", "three.hafen.yml"].map((f) => sp.find((x) => x.ref.suite === f));
    assert.ok(one.end <= two.start, "the same group: one, then two");
    assert.ok(overlap(one, three), "another group: at once");
    // A group that isn't a whole number of 1 or more: the file's problem, exit 2
    await writeFile(join(dir, "bad.hafen.yml"), suite("  - name: x\n    group: 0\n    turns: [ { user: hi } ]\n").replaceAll("MOCK_URL", mock.url));
    const bad = await cli(dir, ["run", "bad.hafen.yml"]);
    assert.equal(bad.code, 2, said(bad));
    assert.match(bad.stderr, /bad\.hafen\.yml:\d+:\d+ +tests\.0\.group: must be >= 1/);
  });
});

describe("compare's cost threshold, and the output's lines", () => {
  const suite = (tests, head = "provider: providers/json.yml") => `version: 1
name: Cover
${head}
environments:
  local: { base_url: "MOCK_URL" }
tests:
${tests}`;

  async function project(files, { withJson = true } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "hafen-cli-"));
    dirs.push(dir);
    const all = { ...(withJson ? { "providers/json.yml": JSON_PROVIDER } : {}), ...files };
    for (const [path, text] of Object.entries(all)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text.replaceAll("MOCK_URL", mock.url));
    }
    return dir;
  }

  // A node process: the command line (or a pack, or another copy of hafen) in `dir`
  function node(dir, args, { env = {}, signalAfterMs, clean = false } = {}) {
    return new Promise((resolve) => {
      const base = clean ? { PATH: process.env.PATH } : process.env;
      const child = spawn(process.execPath, args, { cwd: dir, env: { ...base, NO_COLOR: "1", MOCK_TOKEN: "tok-secret-9876", GITHUB_STEP_SUMMARY: "", ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      if (signalAfterMs) setTimeout(() => child.kill("SIGTERM"), signalAfterMs);
      child.on("close", (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
    });
  }
  const cli = (dir, args, opts) => node(dir, [CLI, ...args], opts);

  describe("compare and --fail-on", () => {
    it("cost=<percent>: a run whose cost rose by more is a regression (exit 1); within it, not; the thresholds combine", async () => {
      const dir = await project({ "s.hafen.yml": suite("  - name: a\n    turns: [ { user: hi, expect: [ { contains: hi } ] } ]\n") });
      assert.equal((await cli(dir, ["run", "--report", "run:base.json"])).code, 0);
      const base = await readJSON(dir, "base.json");
      const withCost = (factor) => ({ ...base, summary: { ...base.summary, cost: base.summary.cost * factor } });
      await writeFile(join(dir, "dearer.json"), JSON.stringify(withCost(1.5)));
      await writeFile(join(dir, "about.json"), JSON.stringify(withCost(1.05)));
      const dearer = await cli(dir, ["compare", "dearer.json", "--baseline", "base.json", "--fail-on", "cost=10"]);
      assert.equal(dearer.code, 1, said(dearer));
      assert.match(dearer.stdout, /^## Hafen · regressed$/m);
      assert.match(dearer.stdout, /\*\*Regressed:\*\* cost rose 50% \(limit 10%\)/);
      const about = await cli(dir, ["compare", "about.json", "--baseline", "base.json", "--fail-on", "cost=10"]);
      assert.equal(about.code, 0, said(about));
      // Only the thresholds given are looked at: without cost=, a dearer run passes
      assert.equal((await cli(dir, ["compare", "dearer.json", "--baseline", "base.json", "--fail-on", "pass_rate=5,p95=20"])).code, 0);
      assert.equal((await cli(dir, ["compare", "dearer.json", "--baseline", "base.json", "--fail-on", "pass_rate=5,cost=60"])).code, 0);
    });
  });

  describe("the output", () => {
    it("a test's line says up to three things that went wrong, then …N more (see the report)", async () => {
      const dir = await project({
        "data/rows.csv": `q\n${[1, 2, 3, 4, 5].map((n) => `row ${n}`).join("\n")}\n`,
        "s.hafen.yml": suite("  - name: rows\n    data: data/rows.csv\n    turns: [ { user: \"{{row.q}}\", expect: [ { contains: nowhere } ] } ]\n"),
      });
      const r = await cli(dir, ["run"]);
      assert.equal(r.code, 1, said(r));
      const lines = r.stdout.split("\n");
      const at = lines.findIndex((l) => l.startsWith("✗ Cover › rows"));
      assert.match(lines[at], /0\/5 rows {3}0\/5 checks/);
      // (each row named by its first column: q)
      assert.deepEqual(lines.slice(at + 1, at + 5).map((l) => l.trim().replace(/(nowhere): .*/, "$1")), ["row 1: row 1 · turn 1 · contains nowhere", "row 2: row 2 · turn 1 · contains nowhere", "row 3: row 3 · turn 1 · contains nowhere", "…2 more (see the report)"]);
    });

    it("a fixture that failed gets a line of its own (without --verbose), and the summary counts the fixtures that ran", async () => {
      const dir = await project({
        "plugins/warm.js": 'export default { kind: "fixture", name: "warm", version: "1.0.0", hosts: [], provides: [], async run() {} };\n',
        "plugins/logout.js": 'export default { kind: "fixture", name: "logout", version: "1.0.0", hosts: [], provides: [], async run() { throw new Error("no session to end"); } };\n',
        "providers/p.yml": JSON_PROVIDER.replace("kind: http\n", "kind: http\nfixtures: { beforeAll: [warm], afterAll: [logout] }\n"),
        "s.hafen.yml": suite("  - name: a\n    turns: [ { user: hi, expect: [ { contains: hi } ] } ]\n", "provider: providers/p.yml"),
      });
      const r = await cli(dir, ["run", "--report", "md:out/s.md", "--report", "junit:out/j.xml"]);
      assert.equal(r.code, 0, `an afterAll that fails changes no result\n${said(r)}`);
      assert.match(r.stdout, /^ {2}⚙ fixture logout · afterAll · providers\/p\.yml {2}failed: no session to end$/m);
      assert.doesNotMatch(r.stdout, /⚙ fixture warm/, "one that went well: only with --verbose");
      assert.match(r.stdout, / · 2 fixtures \(1 failed\) · /);
      assert.match(await readFile(join(dir, "out/s.md"), "utf8"), /\| ✗ \| logout \| afterAll \| providers\/p\.yml \|/);
      assert.match(await readFile(join(dir, "out/j.xml"), "utf8"), /<system-err>fixture logout \(afterAll\) · providers\/p\.yml · failed: no session to end/);
    });
  });
});

describe("--max-cost", () => {
  // A folder with these files (paths to text), its environment's base_url the mock's
  async function project(files) {
    const dir = await mkdtemp(join(tmpdir(), "hafen-cli-"));
    dirs.push(dir);
    const all = { "providers/json.yml": JSON_PROVIDER, ...files };
    for (const [path, text] of Object.entries(all)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text.replaceAll("MOCK_URL", mock.url));
    }
    return dir;
  }

  function cli(dir, args, { env = {} } = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        cwd: dir,
        env: { ...process.env, NO_COLOR: "1", MOCK_TOKEN: "tok-secret-9876", GITHUB_STEP_SUMMARY: "", ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  it("a test that had failed before the stop is failed: the summary, the run file and the reports say so (exit 3)", async () => {
    const dir = await project({
      "providers/pricey.yml": JSON_PROVIDER.replace("price: { input: 1, output: 2 }", "price: { input: 1000, output: 2000 }"),
      "s.hafen.yml": suite(`  - name: t1
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
  - name: t2
    turns: [ { user: hi, expect: [ { contains: "nope" } ] } ]
  - name: t3
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`, "provider: providers/pricey.yml"),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--max-cost", "0.03", "--report", "run:out/run.json", "--report", "junit:out/junit.xml", "--report", "md:out/summary.md", "--report", "json:out/summary.json"]);
    assert.equal(r.code, 3, said(r));
    assert.match(r.stdout, /^✗ Flows › t2 {3}0\/1 {3}0\/1 checks/m);
    assert.match(r.stdout, /^1 suite · 3 tests · 1 failed · 1 skipped · 0 unsure · 2 checks · /m);
    assert.match(r.stdout, /stopped: the run's cost reached the limit \(\$0\.03\)/);
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.status, "stopped");
    assert.equal(run.verdict, "failed");
    assert.deepEqual(run.tests.map((t) => [t.name, t.status]), [["t1", "passed"], ["t2", "failed"], ["t3", "skipped"]]);
    assert.deepEqual([run.summary.tests.failed, run.summary.tests.skipped, run.summary.tests.stopped], [1, 1, 0]);
    const xml = await readFile(join(dir, "out/junit.xml"), "utf8");
    const t2 = xml.match(/<testcase [^>]*name="t2"[^>]*>[\s\S]*?<\/testcase>/)[0];
    assert.match(t2, /<failure /);
    assert.doesNotMatch(t2, /<skipped/);
    assert.match(xml, /<testsuites name="Hafen" tests="3" failures="1" errors="0" skipped="1"/);
    assert.match(await readFile(join(dir, "out/summary.md"), "utf8"), /3 tests · 1 failed ·[\s\S]*\| ✗ \| t2 \|/);
    const json = await readJSON(dir, "out/summary.json");
    assert.deepEqual([json.verdict, json.summary.tests.failed], ["failed", 1]);
  });
});
