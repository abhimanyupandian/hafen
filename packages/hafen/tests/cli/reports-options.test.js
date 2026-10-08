// Reports and the options that check what they're given (contracts/cli.md), end to end from the
// command line against the mock endpoint: a conversation's checks in every report; a report format or
// path that's wrong found before anything is sent (or written), and one that still can't be written
// said in a line, the others written; options that would do nothing (--fail-on without --baseline,
// --max-cost with no prices) or are out of range (--network) are setup errors; --network drop cuts off
// any response; costs and counts said plainly; compare says "regressed", and ignores p95 noise.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { withNetwork } from "../../engine/transport.js";
import { fakeTransport, startMock } from "../helpers.js";

const CLI = fileURLToPath(new URL("../../cli/hafen.js", import.meta.url));
let mock;
const dirs = [];

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
    const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "", HAFEN_CONCURRENCY: "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
  });
}
const readJSON = async (dir, path) => JSON.parse(await readFile(join(dir, path), "utf8"));
const said = (r) => `exit ${r.code}\n${r.stdout}\n${r.stderr}`;
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

before(async () => {
  mock = await startMock({ chunkMs: 1 });
});
beforeEach(() => mock.reset());
after(async () => {
  await mock.close();
  for (const d of dirs) {
    await chmod(join(d, "locked"), 0o755).catch(() => {});
    await rm(d, { recursive: true, force: true });
  }
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

describe("options that would do nothing, or are out of range", () => {
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

  for (const value of ["drop=5", "drop=-0.1", "kbps=0", "delay=-1", "jitter=-5", "drop="]) {
    it(`--network ${value}: exit 2, nothing sent`, async () => {
      const dir = await project({ "s.hafen.yml": PASSING });
      const r = await cli(dir, ["run", "s.hafen.yml", "--network", value]);
      assert.equal(r.code, 2, said(r));
      assert.match(r.stderr, /--network \w+ takes|can't read "drop="/);
      assert.equal(mock.log.length, 0);
    });
  }

  it("--network drop=1 cuts off a JSON reply (one chunk) too: the turn errors; drop=0 cuts off nothing", async () => {
    const dir = await project({ "s.hafen.yml": PASSING });
    const dropped = await cli(dir, ["run", "s.hafen.yml", "--network", "drop=1", "--report", "run:out/run.json"]);
    assert.equal(dropped.code, 1, said(dropped));
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.tests[0].status, "error");
    assert.match(run.turns[0].error, /connection dropped \(network simulation\)/i);
    const kept = await cli(dir, ["run", "s.hafen.yml", "--network", "drop=0,kbps=1000"]);
    assert.equal(kept.code, 0, said(kept));
  });

  it("withNetwork drops any response at drop_rate 1 (none at 0), whatever the random draw, and never its last chunk", async () => {
    const read = async (res) => {
      const got = [];
      try {
        for await (const c of res.body) got.push(new TextDecoder().decode(c));
        return { got };
      } catch (e) {
        return { got, error: e.message };
      }
    };
    for (const chunks of [['{"reply":"hi"}'], ["a", "b", "c", "d", "e", "f"], []]) {
      for (const draw of [0, 0.5, 0.999]) {
        const res = await withNetwork(fakeTransport(() => ({ chunks })), { drop_rate: 1 }, { random: () => draw }).send({ url: "x" });
        const { got, error } = await read(res);
        assert.match(error ?? "", /The connection dropped/, `${JSON.stringify(chunks)} at ${draw}`);
        assert.ok(got.length < Math.max(1, chunks.length) && got.length <= 3, `cut off partway: ${JSON.stringify(got)}`);
      }
      const kept = await read(await withNetwork(fakeTransport(() => ({ chunks })), { drop_rate: 0, kbps: 100000 }).send({ url: "x" }));
      assert.deepEqual(kept, { got: chunks });
    }
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
