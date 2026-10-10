// Every runner flow from the command line (contracts/cli.md, test-file.md, checks.md), end to end
// against the mock endpoint: what the app runs, the CLI runs the same, and says so in its exit code,
// its output and its reports. Each test has a folder of its own.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../helpers.js";

const CLI = fileURLToPath(new URL("../../cli/hafen.js", import.meta.url));
const SSE = await readFile(fileURLToPath(new URL("../fixtures/suites/providers/mock-sse.yml", import.meta.url)), "utf8");
let mock;
const dirs = [];

// A JSON provider (one reply), its key a secret
const JSON_PROVIDER = `kind: http
url: "{{base_url}}/json"
headers: { Authorization: "Bearer {{secret.MOCK_TOKEN}}" }
body: { message: "{{user}}" }
response:
  text: $.data.reply
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
price: { input: 1, output: 2 }
`;

// A folder with these files (paths to text), its environment's base_url the mock's
async function project(files) {
  const dir = await mkdtemp(join(tmpdir(), "hafen-flows-"));
  dirs.push(dir);
  const all = { "providers/json.yml": JSON_PROVIDER, "providers/sse.yml": SSE, ...files };
  for (const [path, text] of Object.entries(all)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), typeof text === "function" ? text(mock.url) : text.replaceAll("MOCK_URL", mock.url));
  }
  return dir;
}

function cli(dir, args, { env = {}, signalAfterMs, signal = "SIGTERM" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: "1", MOCK_TOKEN: "tok-secret-9876", JEV_API_KEY: "jev-secret-key-1", GITHUB_STEP_SUMMARY: "", HAFEN_CONCURRENCY: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    if (signalAfterMs) setTimeout(() => child.kill(signal), signalAfterMs);
    child.on("close", (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
  });
}
const readJSON = async (dir, path) => JSON.parse(await readFile(join(dir, path), "utf8"));
const results = (run) => run.turns.map((t) => (t.results ?? []).map((r) => r.status));
const said = (r) => `exit ${r.code}\n${r.stdout}\n${r.stderr}`;

// A suite: its head (provider, environments…), then its tests (YAML)
const suite = (tests, head = "provider: providers/json.yml") => `version: 1
name: Flows
${head}
environments:
  local: { base_url: "MOCK_URL" }
tests:
${tests}`;

before(async () => {
  mock = await startMock({ chunkMs: 1 });
});
beforeEach(() => mock.reset());
after(async () => {
  await mock.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("the command itself", () => {
  it("--help and --version exit 0; an unknown command or option exits 2", async () => {
    const dir = await project({});
    const help = await cli(dir, ["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /hafen run \[paths…\]/);
    assert.match(help.stdout, /Exit codes: 0 passed · 1 failed · 2 setup error · 3 stopped early/);
    const version = await cli(dir, ["--version"]);
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
    const unknown = await cli(dir, ["frobnicate"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown command "frobnicate"/);
    const badOption = await cli(dir, ["run", "--frobnicate"]);
    assert.equal(badOption.code, 2, said(badOption));
    assert.match(badOption.stderr, /frobnicate/);
    assert.doesNotMatch(badOption.stderr, /at .*\.js:\d+/, "a plain message, not a stack trace");
  });

  it("with no paths, runs every suite under the current folder (not node_modules, .hafen or dist), in name order", async () => {
    const one = suite(`  - name: one
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`);
    const dir = await project({
      "b.hafen.yml": one.replace("name: Flows", "name: B"),
      "nested/a.hafen.yaml": one.replace("name: Flows", "name: A").replaceAll("providers/json.yml", "../providers/json.yml"),
      "node_modules/x/c.hafen.yml": one.replace("name: Flows", "name: C"),
      ".hafen/d.hafen.yml": one.replace("name: Flows", "name: D"),
      "dist/e.hafen.yml": one.replace("name: Flows", "name: E"),
      "f.hafen.json": JSON.stringify({ version: 1, name: "F", provider: "providers/json.yml", environments: { local: { base_url: mock.url } }, tests: [{ name: "one", turns: [{ user: "hi", expect: [{ contains: "You said" }] }] }] }),
    });
    const r = await cli(dir, ["run", "--report", "run:out/run.json"]);
    assert.equal(r.code, 0, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.deepEqual(run.suites.map((s) => s.file ?? s), ["b.hafen.yml", "f.hafen.json", "nested/a.hafen.yaml"]);
    assert.match(r.stdout, /3 suites · 3 tests · 0 failed/);
  });

  it("a path that doesn't exist, or a folder with no suites, exits 2 and sends nothing", async () => {
    const dir = await project({ "notes.txt": "nothing here" });
    const missing = await cli(dir, ["run", "nope.hafen.yml"]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /nope\.hafen\.yml doesn't exist/);
    const none = await cli(dir, ["run", "."]);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /no suites found/);
    const validate = await cli(dir, ["validate"]);
    assert.equal(validate.code, 2);
    assert.equal(mock.log.length, 0);
  });
});

describe("what a run sends and checks", () => {
  it("a streamed reply (SSE) with thinking and a tool call: tool, thinking and sequence checks pass", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: tools
    turns:
      - user: a refund for 4417
        expect:
          - { type: tool.called, tool: lookup_order, args: { $.order_id: 4417 } }
          - { type: tool.not_called, tool: delete_account }
          - { on: thinking, type: present }
          - { on: thinking, contains: "look the order up" }
          - { type: sequence, value: [thinking, tool_call, text] }
          - { contains: "4417" }
          - { type: tokens, max_tokens: 100 }
`, "provider: providers/sse.yml\nvariables: { scenario: tools }"),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json", "--verbose"]);
    assert.equal(r.code, 0, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.deepEqual(results(run), [["pass", "pass", "pass", "pass", "pass", "pass", "pass"]]);
    assert.equal(run.turns[0].tool_calls[0].name, "lookup_order");
    // --verbose: a line per turn, with its checks
    assert.match(r.stdout, /turn 1 · .* ✓ called lookup_order/);
  });

  it("a session carried between turns (extracted, sent back), and {{variables}} from extractions", async () => {
    const dir = await project({
      "providers/session.yml": `kind: http
url: "{{base_url}}/session"
body: { message: "{{user}}", session_id: "{{session}}" }
history: session
session: { extract: $.session_id }
response: { text: $.reply }
`,
      "s.hafen.yml": suite(`  - name: session
    turns:
      - user: first
        extract: { sid: $.session_id }
        expect: [ { contains: "turn 1" } ]
      - user: "second, in {{sid}}"
        expect: [ { contains: "turn 2" }, { contains: "second, in sess_" } ]
`, "provider: providers/session.yml"),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"]);
    assert.equal(r.code, 0, said(r));
    const sent = mock.log.filter((x) => x.path === "/session");
    assert.equal(sent.length, 2);
    assert.equal(sent[0].body.session_id, "");
    assert.match(sent[1].body.session_id, /^sess_\d+$/);
  });

  it("data rows: a test runs once per row ({{row.col}}, typed), each row reported; a failing row fails the test", async () => {
    const dir = await project({
      "data/orders.csv": "question,order\na refund for 4417,4417\nwhere is my parcel,4417\na refund please,9999\n",
      "s.hafen.yml": suite(`  - name: rows
    data: data/orders.csv
    turns:
      - user: "{{row.question}}"
        expect:
          - { path: $.data.order.id, equals: "{{row.order}}" }
`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json", "--report", "junit:out/junit.xml"]);
    assert.equal(r.code, 1, said(r));
    assert.match(r.stdout, /✗ Flows › rows {3}2\/3 rows {3}2\/3 checks/);
    assert.match(r.stdout, /row 3: a refund please · turn 1/, "the failing row is named, by its first column");
    const run = await readJSON(dir, "out/run.json");
    assert.deepEqual(run.tests[0].instances.map((i) => [i.row, i.status]), [[1, "passed"], [2, "passed"], [3, "failed"]]);
    assert.deepEqual(mock.log.map((x) => x.body.message), ["a refund for 4417", "where is my parcel", "a refund please"]);
    const junit = await readFile(join(dir, "out/junit.xml"), "utf8");
    // A testcase for each row, named by its first column: rows 1 and 2 passed, row 3 failed, and why
    assert.match(junit, /<testsuite [^>]*tests="3" failures="1" errors="0" skipped="0"/);
    assert.match(junit, /<testcase [^>]*name="rows \[row 1: a refund for 4417\]"[^>]*>\s*<system-out>[^<]*<\/system-out>\s*<\/testcase>/);
    assert.match(junit, /<testcase [^>]*name="rows \[row 3: a refund please\]"[^>]*>\s*<failure [^>]*>row 3: a refund please · turn 1 · \$\.data\.order\.id = \{\{row\.order\}\}: 4417 ≠ 9999/);
    assert.deepEqual(run.tests[0].instances.map((i) => i.row_name), ["a refund for 4417", "where is my parcel", "a refund please"]);
    // A data file in JSON lines, and a limit
    await writeFile(join(dir, "data/orders.jsonl"), '{"question":"a refund for 4417","order":4417}\n{"question":"hi","order":4417}\n{"question":"x","order":1}\n');
    await writeFile(join(dir, "s.hafen.yml"), suite(`  - name: rows
    data: { file: data/orders.jsonl, limit: 2 }
    turns:
      - user: "{{row.question}}"
        expect: [ { path: $.data.order.id, equals: "{{row.order}}" } ]
`).replaceAll("MOCK_URL", mock.url));
    const lines = await cli(dir, ["run", "s.hafen.yml", "--report", "junit:out/lines.xml"]);
    assert.equal(lines.code, 0, said(lines));
    assert.match(lines.stdout, /2\/2 rows/);
    // (a JSON line's row named by its first key)
    assert.deepEqual([...(await readFile(join(dir, "out/lines.xml"), "utf8")).matchAll(/<testcase [^>]*name="([^"]*)"/g)].map((m) => m[1]), ["rows [row 1: a refund for 4417]", "rows [row 2: hi]"]);
  });

  it("repeat and pass_rate: a flaky reply passes at its rate; --repeat overrides the file's", async () => {
    const dir = await project({
      "providers/flaky.yml": `kind: http\nurl: "{{base_url}}/flaky?rate=0.5"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
      "s.hafen.yml": suite(`  - name: flaky
    repeat: 4
    pass_rate: 0.25
    turns:
      - user: a refund for 4417
        expect: [ { contains: "refund" } ]
`, "provider: providers/flaky.yml"),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"]);
    assert.equal(r.code, 0, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.tests[0].total, 4);
    assert.ok(run.tests[0].passed >= 1 && run.tests[0].passed < 4, `${run.tests[0].passed}/4 passed`);
    const once = await cli(dir, ["run", "s.hafen.yml", "--repeat", "2", "--report", "run:out/two.json"]);
    assert.equal((await readJSON(dir, "out/two.json")).tests[0].total, 2, said(once));
  });

  it("setup and teardown steps: extracted values reach the turns; a failing setup errors the test, teardown still runs", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: logged in
    setup:
      - name: log in
        request: { url: "{{base_url}}/login", method: POST, body: { user: qa } }
        extract: { token: $.access_token }
        expect: [ { type: status, equals: 200 } ]
    teardown:
      - name: log out
        request: { url: "{{base_url}}/json", method: POST, body: { message: "log out {{token}}" } }
    turns:
      - user: "token {{token}}"
        expect: [ { contains: "token " } ]
  - name: setup fails
    setup:
      - name: broken
        request: { url: "{{base_url}}/error/500", method: POST }
        expect: [ { type: status, equals: 200 } ]
    teardown:
      - name: clean up
        request: { url: "{{base_url}}/json", method: POST, body: { message: "cleaned up" } }
    turns:
      - user: never sent
`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json", "--report", "junit:out/junit.xml"]);
    assert.equal(r.code, 1, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.tests[0].status, "passed");
    assert.equal(run.tests[1].status, "error");
    const messages = mock.log.map((x) => x.body?.message).filter(Boolean);
    assert.ok(messages.some((m) => /^token \S+/.test(m) && !m.includes("{{")), messages.join(" | "));
    assert.ok(messages.some((m) => m.startsWith("log out ")), "teardown ran");
    assert.ok(messages.includes("cleaned up"), "teardown ran after the failed setup");
    assert.ok(!messages.includes("never sent"));
    assert.match(r.stdout, /setup "broken" failed/);
    assert.match(await readFile(join(dir, "out/junit.xml"), "utf8"), /<testcase [^>]*name="setup fails"[^>]*>\s*<error/);
  });

  it("suite setup runs once before the tests, its values reaching every test", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: a
    turns: [ { user: "a {{token}}", expect: [ { contains: "a " } ] } ]
  - name: b
    turns: [ { user: "b {{token}}", expect: [ { contains: "b " } ] } ]
`, `provider: providers/json.yml
setup:
  - name: log in
    request: { url: "{{base_url}}/login", method: POST }
    extract: { token: $.access_token }`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml"]);
    assert.equal(r.code, 0, said(r));
    assert.equal(mock.log.filter((x) => x.path === "/login").length, 1);
    const sent = mock.log.filter((x) => x.path === "/json").map((x) => x.body.message);
    const token = sent[0].split(" ")[1];
    assert.ok(token && !token.includes("{{"));
    assert.deepEqual(sent.sort(), [`a ${token}`, `b ${token}`]);
  });

  it("a suite's setup that fails: exit 2 naming the step, its tests not sent, the reports written; --env that names nothing: exit 2", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: a
    turns: [ { user: never sent } ]
`, `provider: providers/json.yml
setup:
  - name: log in
    request: { url: "{{base_url}}/error/500", method: POST }
    expect: [ { type: status, equals: 200 } ]`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json", "--report", "junit:out/junit.xml"]);
    assert.equal(r.code, 2, said(r));
    assert.match(r.stderr, /setup step "log in" failed/);
    assert.ok(!mock.log.some((x) => x.body?.message === "never sent"));
    assert.equal((await readJSON(dir, "out/run.json")).status, "error");
    await readFile(join(dir, "out/junit.xml"), "utf8");
    const env = await cli(dir, ["run", "s.hafen.yml", "--env", "nowhere"]);
    assert.equal(env.code, 2, said(env));
    assert.match(env.stderr, /there's no environment or scope "nowhere" \(local\)/);
  });

  it("on_fail: stop skips the turns after a failed one; continue (the default) runs them", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: stops
    on_fail: stop
    turns:
      - { user: one, expect: [ { contains: "nope" } ] }
      - { user: two, expect: [ { contains: "two" } ] }
  - name: carries on
    turns:
      - { user: one, expect: [ { contains: "nope" } ] }
      - { user: two, expect: [ { contains: "two" } ] }
`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"]);
    assert.equal(r.code, 1, said(r));
    const run = await readJSON(dir, "out/run.json");
    const byTest = run.tests.map((t) => t.instances[0].turns.map((g) => run.turns[g].results.map((x) => x.status)));
    assert.deepEqual(byTest, [[["fail"], ["skipped"]], [["fail"], ["pass"]]]);
    assert.equal(mock.log.length, 3);
  });

  it("expect_conversation checks the whole conversation after the last turn (its input by default), a judge seeing all of it", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: whole
    turns:
      - { user: a refund for 4417 }
      - { user: second message }
    expect_conversation:
      - { path: "$[*].reply", contains: "You said: second message" }
      - { path: "$[0].reply", contains: "why" }
      - { path: "$[*].user", contains: "never said" }
      - { contains: "never said", enabled: false }
      - { type: systemone.noul, question: "Did the assistant ask why?", min: 0.8 }
`, `provider: providers/json.yml
judges:
  default: { kind: systemone, endpoint: "{{base_url}}/systemone" }`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json", "--report", "junit:out/junit.xml"]);
    assert.equal(r.code, 1, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.deepEqual(run.tests[0].instances[0].conversation_results.map((x) => x.status), ["pass", "pass", "fail", "skipped", "pass"]);
    // The judge was given every turn: the first reply (which asks why) as well as the last
    const asked = mock.log.find((x) => x.path === "/systemone/v1/systemone").body.state;
    assert.match(asked, /Could you tell me why/);
    assert.match(asked, /You said: second message/);
    // Named in the output and the report
    assert.match(r.stdout, /conversation · \$\[\*\]\.user contains never said/);
    assert.match(await readFile(join(dir, "out/junit.xml"), "utf8"), /<failure [^>]*never said/);
  });

  it("a check turned off (enabled: false) is skipped and not counted; the test passes", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: off
    turns:
      - user: hi
        expect:
          - { contains: "You said" }
          - { contains: "nowhere in the reply", enabled: false }
`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"]);
    assert.equal(r.code, 0, said(r));
    assert.match(r.stdout, /1\/1 checks/);
    const run = await readJSON(dir, "out/run.json");
    assert.deepEqual(results(run), [["pass", "skipped"]]);
  });

  it("pinned history: earlier turns are given the file's reply, not the live one", async () => {
    const dir = await project({
      "providers/msgs.yml": `kind: http
url: "{{base_url}}/json"
body: { messages: "{{messages}}" }
history: messages
response: { text: $.data.reply }
`,
      "s.hafen.yml": suite(`  - name: pinned
    history: pinned
    turns:
      - { user: first, reply: "A PINNED REPLY" }
      - { user: second, expect: [ { contains: "second" } ] }
`, "provider: providers/msgs.yml"),
    });
    const r = await cli(dir, ["run", "s.hafen.yml"]);
    assert.equal(r.code, 0, said(r));
    const last = mock.log.at(-1).body.messages;
    assert.ok(JSON.stringify(last).includes("A PINNED REPLY"), JSON.stringify(last));
    assert.ok(!JSON.stringify(last).includes("You said: first"));
  });
});

describe("judges", () => {
  const judges = `provider: providers/json.yml
judges:
  default: { kind: systemone, endpoint: "{{base_url}}/systemone" }
  rubric: { kind: llm, provider: judge, samples: 3 }
providers:
  judge: { kind: openai-chat, base_url: "{{base_url}}/judge", model: mock-judge, api_key: "" }`;

  it("System One (one request per turn, the key from JEV_API_KEY, never written) and an LLM judge", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: judged
    turns:
      - user: a refund for 4417
        expect:
          - { type: systemone.noul, question: "Does the reply ask why?", min: 0.8 }
          - { type: systemone.choice, question: "What does it offer?", options: [refund, replacement], equals: refund }
          - { type: judge, judge: rubric, rubric: ["Mentions the order number"] }
          - { type: judge, judge: rubric, rubric: ["NOT-MET: offers a discount"] }
`, judges),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"]);
    assert.equal(r.code, 1, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.deepEqual(results(run), [["pass", "pass", "pass", "fail"]]);
    assert.equal(mock.log.filter((x) => x.path === "/systemone/v1/systemone").length, 1);
    assert.equal(mock.log.find((x) => x.path === "/systemone/v1/systemone").headers.authorization, "Bearer jev-secret-key-1");
    const text = await readFile(join(dir, "out/run.json"), "utf8");
    assert.ok(!text.includes("jev-secret-key-1"));
    // The judge call's request is kept (its key hidden)
    const call = run.spans.find((s) => s.kind === "judge_call" && s.request);
    assert.equal(call.request.headers.authorization, "[redacted]");
  });

  it("System One's key missing: exit 2 before anything is sent", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: judged
    turns:
      - user: hi
        expect: [ { type: systemone.noul, question: "Is it kind?", min: 0.5 } ]
`, judges),
    });
    const r = await cli(dir, ["run", "s.hafen.yml"], { env: { JEV_API_KEY: "" } });
    assert.equal(r.code, 2, said(r));
    assert.match(r.stderr, /JEV_API_KEY/);
    assert.equal(mock.log.length, 0);
  });

  it("unsure: fail (the default) fails, saying why and how to let it pass; warn passes with a warning line; pass passes quietly; the file's policy is overridden", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: unsure
    turns:
      - user: a refund for 4417
        expect: [ { type: systemone.noul, question: "UNSURE: is it polite?", min: 0.5 } ]
`, judges),
    });
    const fail = await cli(dir, ["run", "s.hafen.yml"]);
    assert.equal(fail.code, 1, said(fail));
    assert.match(fail.stdout, /✗ Flows › unsure .*\n {4}turn 1 · noul 0\.55: unsure: 0\.55 within 0\.5–1, but confidence 0\.1 is below 0\.6 \(unsure counts as failed; --unsure warn to let it pass\)\n/);
    assert.match(fail.stdout, /1 failed · 0 unsure/);
    const warn = await cli(dir, ["run", "s.hafen.yml", "--unsure", "warn"]);
    assert.equal(warn.code, 0, said(warn));
    assert.match(warn.stdout, /! Flows › unsure .*\n {4}unsure: noul 0\.55: 0\.55 within 0\.5–1, but confidence 0\.1 is below 0\.6 \(counted as passed: unsure is warn\)\n/);
    assert.match(warn.stdout, /1 unsure/);
    const failed = await cli(dir, ["run", "s.hafen.yml", "--unsure", "fail"]);
    assert.equal(failed.code, 1, said(failed));
    const pass = await cli(dir, ["run", "s.hafen.yml", "--unsure", "pass"]);
    assert.equal(pass.code, 0, said(pass));
    assert.match(pass.stdout, /✓ Flows › unsure /);
    assert.doesNotMatch(pass.stdout, /unsure:/);
    const bad = await cli(dir, ["run", "s.hafen.yml", "--unsure", "maybe"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--unsure takes pass, warn or fail/);
  });

  it("a judge that's unreachable is an error (exit 1, listed as an error, not a failure)", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: judged
    turns:
      - user: hi
        expect: [ { type: systemone.noul, question: "Is it kind?", min: 0.5 } ]
`, judges.replace('endpoint: "{{base_url}}/systemone"', 'endpoint: "http://127.0.0.1:9/systemone"')),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "junit:out/junit.xml"]);
    assert.equal(r.code, 1, said(r));
    const junit = await readFile(join(dir, "out/junit.xml"), "utf8");
    assert.match(junit, /<error /);
    assert.doesNotMatch(junit, /<failure /);
  });
});

describe("plugins", () => {
  const PROVIDER_PLUGIN = `export default {
  kind: "provider", name: "acme", version: "1.4.0", hosts: ["127.0.0.1"],
  async *send({ message, history, settings, transport, signal }) {
    const res = await transport.fetch({ url: settings.url, method: "POST", headers: { authorization: "Bearer {{secret.ACME_KEY}}" }, body: { message }, signal });
    const data = await res.json();
    yield { type: "text", text: data.data.reply };
    yield { type: "usage", input: 3, output: 5 };
    yield { type: "done" };
  },
};
`;
  const CHECK_PLUGIN = `export default {
  kind: "check", name: "polite", version: "1.0.0",
  async check({ value }) {
    const rude = /\\b(stupid|idiot)\\b/i.test(String(value));
    return { status: rude ? "fail" : "pass", reason: rude ? "found an insult" : "no insults" };
  },
};
`;
  const JUDGE_PLUGIN = `export default {
  kind: "judge", name: "house", version: "2.1.0",
  async judge({ input }) { return { value: input.includes("4417") ? 0.9 : 0.1, confidence: 0.8, reason: "looked" }; },
};
`;

  it("a provider, a check and a judge plugin run from the command line, the secret filled in by the engine", async () => {
    const dir = await project({
      "plugins/acme.js": PROVIDER_PLUGIN,
      "plugins/polite.js": CHECK_PLUGIN,
      "plugins/house.js": JUDGE_PLUGIN,
      "s.hafen.yml": suite(`  - name: plugged
    turns:
      - user: a refund for 4417
        expect:
          - { type: polite }
          - { type: judge, judge: mine, rubric: "mentions the order", min: 0.5 }
`, `provider: { kind: "plugin:acme@^1", url: "{{base_url}}/json" }
plugins: [ ./plugins/acme.js, ./plugins/polite.js, ./plugins/house.js ]
judges:
  mine: { kind: plugin, plugin: house }`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"], { env: { ACME_KEY: "acme-secret-1" } });
    assert.equal(r.code, 0, said(r));
    assert.equal(mock.log[0].headers.authorization, "Bearer acme-secret-1");
    const text = await readFile(join(dir, "out/run.json"), "utf8");
    assert.ok(!text.includes("acme-secret-1"));
    assert.deepEqual(results(JSON.parse(text)), [["pass", "pass"]]);
  });

  it("a plugin that's missing, or doesn't load, is a setup error (exit 2), nothing sent", async () => {
    const dir = await project({
      "plugins/bad.js": "export default { kind: 'check', name: 'bad', version: '1.0.0', check: 42 ",
      "missing.hafen.yml": suite(`  - name: x
    turns: [ { user: hi } ]
`, "provider: providers/json.yml\nplugins: [ ./plugins/nowhere.js ]"),
      "bad.hafen.yml": suite(`  - name: x
    turns: [ { user: hi } ]
`, "provider: providers/json.yml\nplugins: [ ./plugins/bad.js ]"),
    });
    for (const file of ["missing.hafen.yml", "bad.hafen.yml"]) {
      const r = await cli(dir, ["run", file]);
      assert.equal(r.code, 2, `${file}: ${said(r)}`);
    }
    assert.equal(mock.log.length, 0);
  });
});

describe("scopes, variables and secrets", () => {
  it("--env <file> fills {{env.NAME}}, the secrets come from the job's environment, the secret redacted", async () => {
    const dir = await project({
      "stage.env": "who=stage-crew\nbase=MOCK_URL\n",
      "providers/scoped.yml": `kind: http
url: "{{env.base}}/json"
headers: { Authorization: "Bearer {{secret.API_KEY}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`,
      "s.hafen.yml": `version: 1
name: Scoped
provider: providers/scoped.yml
tests:
  - name: scoped
    turns:
      - user: "hi from {{env.who}}"
        expect: [ { contains: "hi from stage-crew" } ]
`,
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--env", "stage.env", "--report", "run:out/run.json"], { env: { API_KEY: "sk-stage-777" } });
    assert.equal(r.code, 0, said(r));
    assert.equal(mock.log[0].headers.authorization, "Bearer sk-stage-777");
    assert.ok(!(await readFile(join(dir, "out/run.json"), "utf8")).includes("sk-stage-777"));
    // No environment chosen, or a secret not set: exit 2, nothing sent
    mock.reset();
    const none = await cli(dir, ["run", "s.hafen.yml"], { env: { API_KEY: "sk-stage-777" } });
    assert.equal(none.code, 2, said(none));
    assert.match(none.stderr, /\{\{env\.base\}\} isn't set: no environment is chosen/);
    const missing = await cli(dir, ["run", "s.hafen.yml", "--env", "stage.env"], { env: { API_KEY: "" } });
    assert.equal(missing.code, 2, said(missing));
    assert.match(missing.stderr, /\{\{secret\.API_KEY\}\} isn't set/);
    assert.equal(mock.log.length, 0);
    // validate takes --env too
    const valid = await cli(dir, ["validate", "s.hafen.yml", "--env", "stage.env"]);
    assert.equal(valid.code, 0, said(valid));
  });

  it("--env <name> only names the environment: a folder's environments/<name>.yml isn't read, so its values aren't set", async () => {
    const dir = await project({
      "environments/stage.yml": "base: MOCK_URL\n",
      "s.hafen.yml": `version: 1
provider: { kind: http, url: "{{env.base}}/json", body: { message: "{{user}}" }, response: { text: $.data.reply } }
tests:
  - name: a
    turns: [ { user: hi } ]
`,
    });
    for (const command of ["validate", "run"]) {
      const r = await cli(dir, [command, "s.hafen.yml", "--env", "stage"]);
      assert.equal(r.code, 2, said(r));
      assert.match(r.stderr, /s\.hafen\.yml:2:31 {2}\{\{env\.base\}\} isn't set: the environment "stage" has no base/);
      assert.doesNotMatch(r.all, /old way/);
    }
    assert.equal(mock.log.length, 0);
  });

  it("--env picks a suite's environment by name; the first is the default; --var overrides a variable", async () => {
    const dir = await project({
      "s.hafen.yml": `version: 1
name: Envs
provider: providers/json.yml
environments:
  local: { base_url: "MOCK_URL", who: local }
  other: { base_url: "MOCK_URL", who: other }
variables: { greeting: hello }
tests:
  - name: env
    turns: [ { user: "{{greeting}} from {{who}}" } ]
`,
    });
    await cli(dir, ["run", "s.hafen.yml"]);
    await cli(dir, ["run", "s.hafen.yml", "--env", "other"]);
    await cli(dir, ["run", "s.hafen.yml", "--var", "greeting=hey", "--var", "who=me=too"]);
    assert.deepEqual(mock.log.map((x) => x.body.message), ["hello from local", "hello from other", "hey from me=too"]);
    const bad = await cli(dir, ["run", "s.hafen.yml", "--var", "nothing"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--var takes name=value/);
  });

  it("a secret in a check's reason, a message or a reply never reaches the output (a CI log), even with --verbose", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: secretive
    turns:
      - user: "echo {{secret.MOCK_TOKEN}}"
        expect:
          - { contains: "not {{secret.MOCK_TOKEN}} at all" }
          - { not_contains: "{{secret.MOCK_TOKEN}}" }
`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--verbose", "--report", "md:-", "--report", "junit:out/junit.xml"]);
    assert.equal(r.code, 1, said(r));
    assert.equal(mock.log[0].body.message, "echo tok-secret-9876", "it was sent");
    assert.ok(!r.all.includes("tok-secret-9876"), r.all);
    assert.match(r.stdout, /contains not \{\{secret\.MOCK_TOKEN\}\} at …: didn't find not \[redacted\] at all/);
    assert.ok(!(await readFile(join(dir, "out/junit.xml"), "utf8")).includes("tok-secret-9876"));
  });

  it("HAFEN_CONCURRENCY is gone: set, it's an error saying so; empty (a CI variable that isn't set), it's nothing", async () => {
    const dir = await project({ "s.hafen.yml": suite("  - name: one\n    turns: [ { user: hi } ]\n") });
    assert.equal((await cli(dir, ["run", "s.hafen.yml"], { env: { HAFEN_CONCURRENCY: "" } })).code, 0);
    assert.equal((await cli(dir, ["run", "s.hafen.yml"], { env: { HAFEN_CONCURRENCY: "  " } })).code, 0);
    const set = await cli(dir, ["run", "s.hafen.yml"], { env: { HAFEN_CONCURRENCY: "4" } });
    assert.equal(set.code, 2);
    assert.match(set.stderr, /HAFEN_CONCURRENCY is no longer used: suites and tests run by their group/);
  });

  it("--redact email: an address in a reply is hidden in the run file and reports", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: email
    turns: [ { user: "write to priya@example.com", expect: [ { contains: "nothing like this" } ] } ]
`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--redact", "email", "--report", "run:out/run.json", "--report", "junit:out/junit.xml", "--report", "md:out/s.md", "--report", "json:out/s.json"]);
    assert.equal(r.code, 1, said(r));
    for (const f of ["out/run.json", "out/junit.xml", "out/s.md", "out/s.json"]) {
      assert.ok(!(await readFile(join(dir, f), "utf8")).includes("priya@example.com"), f);
    }
    assert.ok(!r.stdout.includes("priya@example.com"), "nor in the output");
  });

  it("a suite's redact (patterns and headers) and a provider's secret_headers are redacted, the header's value wherever it shows", async () => {
    const dir = await project({
      "providers/tokens.yml": `kind: http
url: "MOCK_URL/json"
headers: { X-Session-Token: "tok-plain-12345", X-Tenant: "Bearer tenant-key-777", X-Trace: "trace-visible-1" }
secret_headers: [x-session-token]
body: { message: "{{user}}" }
response: { text: $.data.reply }
`,
      "s.hafen.yml": `version: 1
provider: providers/tokens.yml
redact: { patterns: [email], headers: [x-tenant] }
tests:
  - name: a
    turns:
      - user: "write to priya@example.com about tok-plain-12345 and tenant-key-777"
        expect: [ { contains: "nothing like this" } ]
`,
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json", "--report", "junit:out/junit.xml", "--report", "md:out/s.md", "--report", "json:out/s.json"]);
    assert.equal(r.code, 1, said(r));
    // (it was sent as written: redaction is of what's kept and shown)
    assert.equal(mock.log[0].headers["x-session-token"], "tok-plain-12345");
    for (const f of ["out/run.json", "out/junit.xml", "out/s.md", "out/s.json"]) {
      const text = await readFile(join(dir, f), "utf8");
      // The headers, and their values echoed in the message and its reply ("You said: …")
      for (const secret of ["tok-plain-12345", "tenant-key-777", "priya@example.com"]) assert.ok(!text.includes(secret), `${secret} in ${f}`);
    }
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.turns[0].request.headers["X-Session-Token"], "[redacted]");
    assert.equal(run.turns[0].request.headers["X-Tenant"], "[redacted]");
    // A header no one named stays as it was
    assert.equal(run.turns[0].request.headers["X-Trace"], "trace-visible-1");
    assert.ok(!r.all.includes("tok-plain-12345") && !r.all.includes("tenant-key-777"), "nor in the output");
  });

  it("--redact takes only the patterns there are", async () => {
    const dir = await project({ "s.hafen.yml": suite("  - name: a\n    turns: [ { user: hi, expect: [ { contains: hi } ] } ]\n") });
    const r = await cli(dir, ["run", "s.hafen.yml", "--redact", "emails,card"]);
    assert.equal(r.code, 2, said(r));
    assert.match(r.stderr, /--redact takes email, card, phone, not "emails"/);
    assert.equal(mock.log.length, 0);
  });
});

describe("choosing what runs, and stopping", () => {
  const three = suite(`  - name: refund one
    tags: [smoke]
    turns: [ { user: a refund, expect: [ { contains: "refund" } ] } ]
  - name: refund two
    tags: [slow]
    turns: [ { user: another refund, expect: [ { contains: "nope" } ] } ]
  - name: greeting
    tags: [smoke]
    turns: [ { user: hello, expect: [ { contains: "hello" } ] } ]
`);

  it("--test (by part of the name, any case) and --tag (any of them); none matching exits 2", async () => {
    const dir = await project({ "s.hafen.yml": three });
    const byName = await cli(dir, ["run", "s.hafen.yml", "--test", "REFUND ONE", "--report", "run:out/a.json"]);
    assert.equal(byName.code, 0, said(byName));
    assert.deepEqual((await readJSON(dir, "out/a.json")).tests.filter((t) => t.status !== "skipped").map((t) => t.name), ["refund one"]);
    const byTag = await cli(dir, ["run", "s.hafen.yml", "--tag", "smoke", "--report", "run:out/b.json"]);
    assert.equal(byTag.code, 0, said(byTag));
    assert.deepEqual((await readJSON(dir, "out/b.json")).tests.map((t) => t.name).sort(), ["greeting", "refund one"]);
    const both = await cli(dir, ["run", "s.hafen.yml", "--tag", "smoke", "--tag", "slow", "--test", "refund"]);
    assert.equal(both.code, 1, said(both));
    const none = await cli(dir, ["run", "s.hafen.yml", "--tag", "nope"]);
    assert.equal(none.code, 2, said(none));
    assert.match(none.stderr, /none match --test \/ --tag/);
  });

  it("--bail stops at the first failed test (exit 3), the reports written for what ran", async () => {
    const dir = await project({ "s.hafen.yml": three });
    const r = await cli(dir, ["run", "s.hafen.yml", "--bail", "--report", "run:out/run.json", "--report", "junit:out/junit.xml"]);
    assert.equal(r.code, 3, said(r));
    assert.match(r.stdout, /stopped: /);
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.status, "stopped");
    assert.deepEqual(run.tests.map((t) => [t.name, t.status]).slice(0, 2), [["refund one", "passed"], ["refund two", "failed"]]);
    assert.ok(!mock.log.some((x) => x.body?.message === "hello"), "the test after it never ran");
    assert.match(await readFile(join(dir, "out/junit.xml"), "utf8"), /<testcase [^>]*name="greeting"[^>]*>\s*<skipped/);
  });

  it("--timeout: a turn slower than it is an error (exit 1); a bad value exits 2", async () => {
    const dir = await project({
      "providers/slow.yml": `kind: http\nurl: "{{base_url}}/slow?ms=1500"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\nretries: 0\n`,
      "s.hafen.yml": suite(`  - name: slow
    retries: 0
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`, "provider: providers/slow.yml"),
    });
    const started = Date.now();
    const r = await cli(dir, ["run", "s.hafen.yml", "--timeout", "300", "--report", "run:out/run.json"]);
    assert.equal(r.code, 1, said(r));
    assert.ok(Date.now() - started < 5000);
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.tests[0].status, "error");
    assert.match(run.turns[0].error, /time|300/i);
    const bad = await cli(dir, ["run", "s.hafen.yml", "--timeout", "5s"]);
    assert.equal(bad.code, 2);
  });

  it("--network delay: every request waits; a bad profile exits 2", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: delayed
    turns: [ { user: hi, expect: [ { type: latency, max_ms: 5000 } ] } ]
`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--network", "delay=300", "--report", "run:out/run.json"]);
    assert.equal(r.code, 0, said(r));
    assert.ok((await readJSON(dir, "out/run.json")).turns[0].metrics.ms >= 290);
    const bad = await cli(dir, ["run", "s.hafen.yml", "--network", "speed=fast"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /can't read "speed=fast"/);
  });

  it("SIGINT stops the run as SIGTERM does: exit 3, the run file written with what ran", async () => {
    const dir = await project({
      "providers/slow.yml": `kind: http\nurl: "{{base_url}}/slow?ms=400"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
      "s.hafen.yml": suite(`  - name: slow
    repeat: 20
    turns: [ { user: hi } ]
`, "provider: providers/slow.yml"),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json", "--report", "junit:out/junit.xml"], { signalAfterMs: 1500, signal: "SIGINT" });
    assert.equal(r.code, 3, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.status, "stopped");
    assert.ok(run.tests[0].total >= 1 && run.tests[0].total < 20, String(run.tests[0].total));
    assert.ok(run.spans.every((s) => s.end !== undefined), "every span ended");
    await readFile(join(dir, "out/junit.xml"), "utf8");
  });

  it("load tests are skipped without --load, saying why; with it, a setup error (load mode isn't built)", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: load
    load: { concurrency: 4, requests: 8 }
    turns: [ { user: hi } ]
  - name: plain
    turns: [ { user: hi } ]
`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"]);
    assert.equal(r.code, 0, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.tests.find((t) => t.name === "load").status, "skipped");
    assert.match(r.stdout, /– Flows › load {3}a load test \(needs --load/);
    assert.equal(mock.log.length, 1);
    // With --load: load mode isn't built, so it says so (exit 2) rather than send it once and call it
    // passed; nothing is sent. Another test, chosen with --test, still runs.
    mock.reset();
    const load = await cli(dir, ["run", "s.hafen.yml", "--load"]);
    assert.equal(load.code, 2, said(load));
    assert.match(load.stderr, /"load" is a load test, and load tests can't run yet/);
    assert.equal(mock.log.length, 0);
    const plain = await cli(dir, ["run", "s.hafen.yml", "--load", "--test", "plain"]);
    assert.equal(plain.code, 0, said(plain));
  });
});

describe("endpoints that misbehave", () => {
  it("an endpoint that's down, a 500, a reply cut mid-stream: errors (exit 1), each said plainly", async () => {
    const dir = await project({
      "providers/down.yml": `kind: http\nurl: "http://127.0.0.1:9/chat"\nbody: { message: "{{user}}" }\nresponse: { text: $.reply }\n`,
      "providers/500.yml": `kind: http\nurl: "{{base_url}}/error/500"\nbody: { message: "{{user}}" }\nresponse: { text: $.reply }\n`,
      "s.hafen.yml": suite(`  - name: down
    provider: providers/down.yml
    retries: 0
    turns: [ { user: hi, expect: [ { contains: "x" } ] } ]
  - name: server error
    provider: providers/500.yml
    retries: 0
    turns: [ { user: hi, expect: [ { type: status, equals: 200 } ] } ]
  - name: cut
    provider: providers/sse.yml
    retries: 0
    turns: [ { user: hi, expect: [ { contains: "x" } ] } ]
`, "provider: providers/json.yml\nvariables: { scenario: cut }"),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json", "--report", "junit:out/junit.xml"]);
    assert.equal(r.code, 1, said(r));
    const run = await readJSON(dir, "out/run.json");
    const status = Object.fromEntries(run.tests.map((t) => [t.name, t.status]));
    assert.equal(status.down, "error");
    assert.equal(status.cut, "error");
    assert.ok(["error", "failed"].includes(status["server error"]), status["server error"]);
    assert.match(r.stdout, /✗ Flows › down/);
    assert.ok(!/TypeError|at .*\.js:\d+/.test(r.all), "no stack traces");
  });

  it("a rate limit (429) is retried, and the turn passes", async () => {
    const dir = await project({
      "providers/rl.yml": `kind: http\nurl: "{{base_url}}/ratelimit"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
      "s.hafen.yml": suite(`  - name: limited
    turns: [ { user: a refund, expect: [ { contains: "refund" } ] } ]
`, "provider: providers/rl.yml"),
    });
    const r = await cli(dir, ["run", "s.hafen.yml"]);
    assert.equal(r.code, 0, said(r));
    assert.equal(mock.log.filter((x) => x.path === "/ratelimit").length, 2);
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
  });

  it("a run file from before the rename (hafen-eval-run) is read by report, compare and --baseline", async () => {
    const dir = await project({ "s.hafen.yml": passing });
    await cli(dir, ["run", "s.hafen.yml", "--report", "run:base.json"]);
    const legacy = (await readFile(join(dir, "base.json"), "utf8")).replace('"kind": "hafen-run"', '"kind": "hafen-eval-run"').replace('"kind":"hafen-run"', '"kind":"hafen-eval-run"');
    assert.ok(legacy.includes("hafen-eval-run"));
    await writeFile(join(dir, "legacy.json"), legacy);
    const report = await cli(dir, ["report", "legacy.json", "--report", "md:-"]);
    assert.equal(report.code, 0, said(report));
    const compare = await cli(dir, ["compare", "legacy.json", "--baseline", "legacy.json"]);
    assert.equal(compare.code, 0, said(compare));
    const run = await cli(dir, ["run", "s.hafen.yml", "--baseline", "legacy.json"]);
    assert.equal(run.code, 0, said(run));
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

describe("validate", () => {
  it("a newer version, a bad path, an unknown judge, a bad regex: each named with its line, exit 2", async () => {
    const dir = await project({
      "newer.hafen.yml": "version: 2\nprovider: providers/json.yml\ntests: []\n",
      "bad.hafen.yml": suite(`  - name: bad
    turns:
      - user: hi
        expect:
          - { path: "$.[", exists: true }
          - { matches: "(" }
          - { type: judge, judge: nobody, rubric: [x] }
`),
      "good.hafen.yml": suite(`  - name: good
    turns: [ { user: hi } ]
`),
      "empty.hafen.yml": suite("  []\n").replace("tests:\n  []", "tests: []"),
    });
    const r = await cli(dir, ["validate", "newer.hafen.yml", "bad.hafen.yml", "good.hafen.yml", "empty.hafen.yml"]);
    assert.equal(r.code, 2, said(r));
    assert.match(r.stderr, /newer\.hafen\.yml.*version/);
    assert.match(r.stderr, /bad\.hafen\.yml:\d+:\d+/);
    assert.match(r.stderr, /nobody/);
    assert.match(r.stdout, /✓ good\.hafen\.yml/);
    assert.match(r.stdout, /✓ empty\.hafen\.yml/);
    assert.match(r.stderr, /no tests yet/);
    assert.equal(mock.log.length, 0);
    // Running only an empty suite: exit 2 (nothing ran)
    const empty = await cli(dir, ["run", "empty.hafen.yml"]);
    assert.equal(empty.code, 2, said(empty));
    assert.match(empty.stderr, /the suites have none yet/);
  });

  // What validate passes, run doesn't stop on: they're the same check (engine/runner.js, preflight).
  // Each of these passed validate, then sent the run, then failed it (or passed it, with checks that
  // never ran).
  it("a misspelled key or check type, a plugin that isn't there, an --env that isn't: validate finds each, and run sends nothing (exit 2)", async () => {
    const dir = await project({
      "typo-key.hafen.yml": suite(`  - name: a
    turns:
      - user: hi
        expcet: [ { contains: "never in the reply" } ]
`),
      "typo-type.hafen.yml": suite(`  - name: a
    turns:
      - user: hi
        expect: [ { type: contians, value: hi } ]
`),
      "no-plugin.hafen.yml": suite(`  - name: a
    turns: [ { user: hi, expect: [ { contains: hi } ] } ]
`, 'provider: "plugin:nothere"'),
      "no-judge-plugin.hafen.yml": suite(`  - name: a
    turns: [ { user: hi, expect: [ { type: judge, judge: mine, rubric: [polite] } ] } ]
`, "provider: providers/json.yml\njudges:\n  mine: { kind: plugin, plugin: nobody }"),
    });
    const expected = {
      "typo-key.hafen.yml": /typo-key\.hafen\.yml:10:9 +tests\.0\.turns\.0: unknown key "expcet" \(did you mean "expect"\?\)/,
      "typo-type.hafen.yml": /typo-type\.hafen\.yml:10:\d+ +"contians" isn't a check type \(did you mean "contains"\?\)/,
      "no-plugin.hafen.yml": /the provider plugin "nothere" isn't in the folder's plugins/,
      "no-judge-plugin.hafen.yml": /the judge "mine" uses the plugin "nobody", which isn't/,
    };
    for (const [file, problem] of Object.entries(expected)) {
      const valid = await cli(dir, ["validate", file]);
      assert.equal(valid.code, 2, `${file}: ${said(valid)}`);
      assert.match(valid.stderr, problem);
      const ran = await cli(dir, ["run", file, "--report", "junit:out/junit.xml"]);
      assert.equal(ran.code, 2, `${file}: ${said(ran)}`);
      assert.match(ran.stderr, problem);
      assert.match(ran.stderr, /nothing was sent/);
      // (the reports are still written, so CI shows why)
      assert.match(await readFile(join(dir, "out/junit.xml"), "utf8"), /<testsuites/);
    }
    // An environment that isn't there
    const env = await cli(dir, ["validate", "typo-type.hafen.yml", "--env", "stagnig"]);
    assert.match(env.stderr, /there's no environment or scope "stagnig" \(local\)/);
    assert.equal(mock.log.length, 0);
  });

  it("validate --env --env-check checks the secrets as run does", async () => {
    const dir = await project({
      "providers/scoped.yml": `kind: http
url: "MOCK_URL/json"
headers: { Authorization: "Bearer {{secret.API_KEY}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`,
      "s.hafen.yml": `version: 1
provider: providers/scoped.yml
tests:
  - name: a
    turns: [ { user: hi, expect: [ { contains: hi } ] } ]
`,
    });
    const unchecked = await cli(dir, ["validate", "s.hafen.yml", "--env", "stage"], { env: { API_KEY: "" } });
    assert.equal(unchecked.code, 0, said(unchecked));
    const checked = await cli(dir, ["validate", "s.hafen.yml", "--env", "stage", "--env-check"], { env: { API_KEY: "" } });
    assert.equal(checked.code, 2, said(checked));
    assert.match(checked.stderr, /providers\/scoped\.yml:3:35 {2}\{\{secret\.API_KEY\}\} isn't set \(not in the environment: set it, or pass --secret <file>\)/);
    const set = await cli(dir, ["validate", "s.hafen.yml", "--env", "stage", "--env-check"], { env: { API_KEY: "sk-1" } });
    assert.equal(set.code, 0, said(set));
  });

  it("run checks --report and --baseline before it sends anything", async () => {
    const dir = await project({ "s.hafen.yml": suite("  - name: a\n    turns: [ { user: hi, expect: [ { contains: hi } ] } ]\n") });
    const format = await cli(dir, ["run", "s.hafen.yml", "--report", "xml:out/x.xml"]);
    assert.equal(format.code, 2, said(format));
    assert.match(format.stderr, /unknown report format "xml" \(junit, run, md, json\)/);
    const baseline = await cli(dir, ["run", "s.hafen.yml", "--baseline", "nope.json"]);
    assert.equal(baseline.code, 2, said(baseline));
    assert.match(baseline.stderr, /the baseline can't be read/);
    assert.equal(mock.log.length, 0);
  });

  it("a check's schema can be a file (JSON or YAML); one that isn't there stops the run before it sends", async () => {
    const dir = await project({
      "schemas/reply.json": '{ "type": "object", "required": ["reply"], "properties": { "reply": { "type": "string" } } }',
      "schemas/strict.yml": "type: object\nrequired: [nothing]\n",
      "s.hafen.yml": suite(`  - name: a
    turns:
      - user: hi
        expect:
          - { path: $.data, schema: schemas/reply.json }
          - { path: $.data, schema: schemas/strict.yml }
`),
      "missing.hafen.yml": suite(`  - name: a
    turns:
      - user: hi
        expect: [ { path: $.data, schema: schemas/nope.json } ]
`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"]);
    assert.equal(r.code, 1, said(r));
    assert.deepEqual(results(await readJSON(dir, "out/run.json")), [["pass", "fail"]]);
    mock.reset();
    const missing = await cli(dir, ["validate", "missing.hafen.yml"]);
    assert.equal(missing.code, 2, said(missing));
    assert.match(missing.stderr, /missing\.hafen\.yml:10:\d+ +the schema file schemas\/nope\.json doesn't exist/);
    assert.equal(mock.log.length, 0);
  });

  it("{{turn.index}} is the turn's number, from 1", async () => {
    const dir = await project({ "s.hafen.yml": suite(`  - name: a
    turns:
      - { user: "turn {{turn.index}}", expect: [ { contains: "turn 1" } ] }
      - { user: "turn {{turn.index}}", expect: [ { contains: "turn 2" } ] }
`) });
    const r = await cli(dir, ["run", "s.hafen.yml"]);
    assert.equal(r.code, 0, said(r));
    assert.deepEqual(mock.log.map((x) => x.body.message), ["turn 1", "turn 2"]);
  });
});

describe("serve", () => {
  // The relay that serves the browser build is the app's (npm run serve in Hafen's repository): hafen
  // says so, in a line, whatever options it's given
  it("hafen serve: a setup error that says where it is now (exit 2)", async () => {
    const dir = await project({});
    for (const args of [["serve"], ["serve", "--port", "8790", "--allow-endpoint", `${mock.url}/json`]]) {
      const r = await cli(dir, args);
      assert.equal(r.code, 2, said(r));
      assert.equal(r.stdout, "");
      assert.equal(r.stderr, "hafen serve is the Hafen app's now: in Hafen's repository, npm run serve -- --allow-endpoint <url> serves the browser build and its relay\n");
    }
  });
});

describe("fixtures", () => {
  // A login (the mock's /auth/login): its cookies and CSRF token, for an HTTP provider as {{secret.…}}
  const files = {
    "plugins/acme-login.js": `export default {
  kind: "fixture",
  name: "acme-login",
  version: "1.0.0",
  hosts: ["127.0.0.1"],
  provides: ["ACME_COOKIE", "ACME_CSRF"],
  async setup({ settings, transport, signal }) {
    const res = await transport.fetch({ url: settings.login_url, method: "POST", body: { user: "qa-bot", password: "{{secret.ACME_PASSWORD}}" }, signal });
    if (res.status >= 400) throw new Error("login failed: " + res.status);
    const { csrf_token } = await res.json();
    return { ACME_COOKIE: [res.headers["set-cookie"]].flat().map((c) => c.split(";")[0]).join("; "), ACME_CSRF: csrf_token };
  },
};
`,
    "providers/acme.yml": `kind: http
fixtures: { beforeAll: [acme-login] }
url: "{{base_url}}/auth/chat"
login_url: "{{base_url}}/auth/login"
headers: { cookie: "{{secret.ACME_COOKIE}}", x-csrf-token: "{{secret.ACME_CSRF}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`,
    "s.hafen.yml": `version: 1
provider: providers/acme.yml
environments:
  local: { base_url: "MOCK_URL" }
tests:
  - name: behind the login
    turns: [ { user: hello, expect: [ { type: status, equals: 200 }, { contains: "You said: hello" } ] } ]
`,
  };

  it("a provider's fixture logs in first; the names it gives count as set for validate and run; their values are redacted", async () => {
    const dir = await project(files);
    const env = { ACME_PASSWORD: "qa-pass-1234" };
    const valid = await cli(dir, ["validate", "s.hafen.yml", "--env-check"], { env });
    assert.equal(valid.code, 0, said(valid));
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"], { env });
    assert.equal(r.code, 0, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.spans.find((s) => s.kind === "fixture")?.status, "ok");
    const text = JSON.stringify(run) + r.all;
    for (const secret of ["sess-5f2a9c71", "csrf-0b7e41d2", "qa-pass-1234"]) assert.ok(!text.includes(secret), `${secret} is redacted`);
    // --verbose: each fixture as it ends, and each call it made
    const verbose = await cli(dir, ["run", "s.hafen.yml", "--verbose"], { env });
    assert.equal(verbose.code, 0, said(verbose));
    assert.match(verbose.stdout, /⚙ fixture acme-login · beforeAll · providers\/acme\.yml {2}ok {2}[\d.]+ s {2}gave ACME_COOKIE, ACME_CSRF · 1 call/);
    assert.match(verbose.stdout, /POST 127\.0\.0\.1:\d+\/auth\/login {2}200 {2}[\d.]+ s {2}\(fixture acme-login\)/);
    assert.match(verbose.stdout, /1 fixture · p50/);
    // Without the password: the run is a setup error (exit 2), saying why
    const failed = await cli(dir, ["run", "s.hafen.yml"], { env: { ACME_PASSWORD: "wrong" } });
    assert.equal(failed.code, 2, said(failed));
    assert.match(failed.all, /the fixture "acme-login" \(beforeAll\) failed: login failed: 401/);
    assert.match(failed.stdout, /⚙ fixture acme-login · beforeAll · providers\/acme\.yml {2}failed: login failed: 401/);
  });
});

describe("plugins' imports", () => {
  it("a plugin imports any file (in the project, outside it), a package and JSON: loaded from its file", async () => {
    const dir = await project({
      "project/plugins/polite.js": `import { words } from "../lib/words.js";
import { lower } from "../../shared/text.js";
import { count } from "fake-counter";
import extra from "./extra.json" with { type: "json" };
export default {
  kind: "check",
  name: "polite",
  version: "1.0.0",
  async check({ value }) {
    const text = lower(value);
    const found = [...words, ...extra.words].filter((w) => text.includes(w));
    return { status: found.length ? "pass" : "fail", reason: \`found \${count(found)}: \${found.join(", ")}\` };
  },
};
`,
      "project/plugins/extra.json": `{ "words": ["said"] }`,
      "project/lib/words.js": `export const words = ["please", "sorry"];\n`,
      "shared/text.js": `export const lower = (s) => String(s).toLowerCase();\n`,
      "project/node_modules/fake-counter/package.json": `{ "name": "fake-counter", "type": "module", "exports": "./index.js" }`,
      "project/node_modules/fake-counter/index.js": `export const count = (list) => list.length;\n`,
      "project/providers/json.yml": JSON_PROVIDER,
      "project/s.hafen.yml": `version: 1
provider: providers/json.yml
environments:
  local: { base_url: "MOCK_URL" }
tests:
  - name: polite
    turns: [ { user: hello, expect: [ { type: polite } ] } ]
`,
    });
    const r = await cli(join(dir, "project"), ["run", "s.hafen.yml", "--report", "run:out/run.json"]);
    assert.equal(r.code, 0, said(r));
    const run = await readJSON(join(dir, "project"), "out/run.json");
    assert.equal(run.turns[0].results[0].reason, "found 1: said");
  });
});

describe("hafen pack", () => {
  // A node process running `file` (a pack) in `dir`, as cli() runs the command line
  const node = (dir, file, args, env = {}) => new Promise((resolveRun) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: dir, env: { PATH: process.env.PATH, NO_COLOR: "1", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolveRun({ code, stdout, stderr, all: stdout + stderr }));
  });
  // A project: a suite with a data file and an environment's value; its provider logs in first (a
  // fixture, its password a secret); a check plugin importing a file outside the project, a package
  // and JSON
  const files = {
    "project/package.json": "{}",
    "project/tests/refunds.hafen.yml": `version: 1
provider: ../providers/acme.yml
tests:
  - name: polite
    data: ../data/rows.csv
    turns: [ { user: "{{row.q}}", expect: [ { type: polite }, { type: status, equals: 200 } ] } ]
`,
    "project/data/rows.csv": "q\nhello there\nsay please\n",
    "project/providers/acme.yml": `kind: http
fixtures: { beforeAll: [acme-login] }
url: "{{env.base_url}}/auth/chat"
login_url: "{{env.base_url}}/auth/login"
headers: { cookie: "{{secret.ACME_COOKIE}}", x-csrf-token: "{{secret.ACME_CSRF}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`,
    "project/plugins/acme-login.js": `export default {
  kind: "fixture", name: "acme-login", version: "1.0.0", hosts: ["127.0.0.1"], provides: ["ACME_COOKIE", "ACME_CSRF"],
  async run({ settings, transport, signal }) {
    const res = await transport.fetch({ url: settings.login_url, method: "POST", body: { password: "{{secret.ACME_PASSWORD}}" }, signal });
    if (res.status >= 400) throw new Error("login failed: " + res.status);
    const { csrf_token } = await res.json();
    return { ACME_COOKIE: [res.headers["set-cookie"]].flat().map((c) => c.split(";")[0]).join("; "), ACME_CSRF: csrf_token };
  },
};
`,
    "project/plugins/polite.js": `import { words } from "../lib/words.js";
import { lower } from "../../shared/text.js";
import { count } from "fake-counter";
import extra from "./extra.json" with { type: "json" };
export default { kind: "check", name: "polite", version: "1.0.0", async check({ value }) {
  const found = [...words, ...extra.words].filter((w) => lower(value).includes(w));
  return { status: found.length ? "pass" : "fail", reason: "found " + count(found) };
} };
`,
    "project/plugins/extra.json": `{ "words": ["said"] }`,
    "project/lib/words.js": `export const words = ["please"];\n`,
    "shared/text.js": `export const lower = (s) => String(s).toLowerCase();\n`,
    "project/node_modules/fake-counter/package.json": `{ "name": "fake-counter", "type": "module", "exports": "./index.js" }`,
    "project/node_modules/fake-counter/index.js": `export const count = (list) => list.length;\n`,
  };

  it("packs suites with everything they need into one file, which runs anywhere with Node alone: no hafen, no project, no node_modules", async () => {
    const dir = await project(files);
    const packed = await cli(join(dir, "project"), ["pack", "tests", "-o", "out/refunds.hafen-pack.mjs"]);
    assert.equal(packed.code, 0, said(packed));
    assert.match(packed.stdout, /packed refunds\.hafen-pack\.mjs \([\d.]+ (kB|MB)\)/);
    assert.match(packed.stdout, /1 suite · 1 provider · 2 plugins \(bundled with \d+ files\) · 1 data file\n/);
    assert.match(packed.stdout, /environment values it uses, from --env <file>: base_url/);
    assert.match(packed.stdout, /secrets it needs, from --secret <file> or the environment: ACME_PASSWORD/);
    const text = await readFile(join(dir, "project/out/refunds.hafen-pack.mjs"), "utf8");
    assert.ok(!text.includes(dir) && !text.includes(process.cwd()), "no path of this machine's in it");
    assert.ok(!text.includes("qa-pass-1234"), "no secret in it");

    assert.ok(!text.includes(mock.url), "no environment's value in it");

    // Somewhere else, empty: only the pack, and the environment's values given where it runs
    const away = await mkdtemp(join(tmpdir(), "hafen-pack-run-"));
    dirs.push(away);
    await writeFile(join(away, "refunds.hafen-pack.mjs"), text);
    await writeFile(join(away, "stage.env"), `base_url=${mock.url}\n`);
    const info = await node(away, "refunds.hafen-pack.mjs", ["info"]);
    assert.equal(info.code, 0, said(info));
    assert.match(info.stdout, /suites \(1\):\n {2}tests\/refunds\.hafen\.yml/);
    assert.match(info.stdout, /plugins\/acme-login\.js {2}fixture acme-login 1\.0\.0/);
    assert.match(info.stdout, /plugins\/polite\.js {2}check polite 1\.0\.0 · [3-9] files/);
    assert.match(info.stdout, /data\/rows\.csv/);
    assert.match(info.stdout, /secrets it needs, from --secret <file> or the environment: ACME_PASSWORD/);
    // Without the secret: a setup error, before anything's sent (in the scope the run will have: the
    // secrets are checked once the rest is right, its plugin's as its files')
    const missing = await node(away, "refunds.hafen-pack.mjs", ["validate", "--env", "stage.env", "--env-check"]);
    assert.equal(missing.code, 2, said(missing));
    assert.match(missing.all, /\{\{secret\.ACME_PASSWORD\}\} isn't set/);
    // With it: the run, its reports written where it runs
    const run = await node(away, "refunds.hafen-pack.mjs", ["run", "--env", "stage.env", "--report", "run:out/run.json", "--verbose"], { ACME_PASSWORD: "qa-pass-1234" });
    assert.equal(run.code, 0, said(run));
    assert.match(run.stdout, /✓ refunds › polite {3}2\/2 rows {3}4\/4 checks/);
    assert.match(run.stdout, /⚙ fixture acme-login · beforeAll · providers\/acme\.yml {2}ok/);
    const record = await readJSON(away, "out/run.json");
    assert.equal(record.verdict, "passed");
    assert.equal(record.where.pack, "refunds.hafen-pack.mjs");
    assert.ok(!JSON.stringify(record).includes("qa-pass-1234"));
    // One suite by its path; one that isn't in it; what a pack can't do
    assert.equal((await node(away, "refunds.hafen-pack.mjs", ["run", "tests/refunds.hafen.yml", "--env", "stage.env"], { ACME_PASSWORD: "qa-pass-1234" })).code, 0);
    const nope = await node(away, "refunds.hafen-pack.mjs", ["run", "tests/other.hafen.yml"]);
    assert.equal(nope.code, 2);
    assert.match(nope.all, /tests\/other\.hafen\.yml isn't a suite in the pack \(it has tests\/refunds\.hafen\.yml\)/);
    const serve = await node(away, "refunds.hafen-pack.mjs", ["serve"]);
    assert.equal(serve.code, 2);
    assert.match(serve.all, /a pack runs its suites/);
    assert.match((await node(away, "refunds.hafen-pack.mjs", ["--help"])).stdout, /node refunds\.hafen-pack\.mjs run \[suites…\]/);
  });

  it("packs nothing when a suite has problems, or a plugin imports what can't be found", async () => {
    const broken = await project({ ...files, "project/tests/refunds.hafen.yml": files["project/tests/refunds.hafen.yml"].replace("../providers/acme.yml", "../providers/none.yml") });
    const r = await cli(join(broken, "project"), ["pack", "tests", "-o", "x.mjs"]);
    assert.equal(r.code, 2, said(r));
    assert.match(r.all, /none\.yml doesn't exist[\s\S]*nothing was packed/);
    const unfound = await project({ ...files, "project/plugins/polite.js": `import { nope } from "not-installed-anywhere";\n${files["project/plugins/polite.js"]}` });
    const u = await cli(join(unfound, "project"), ["pack", "tests", "-o", "x.mjs"]);
    assert.equal(u.code, 2, said(u));
    assert.match(u.all, /plugins\/polite\.js|not-installed-anywhere/);
    assert.match(u.all, /nothing was packed/);
  });
});
