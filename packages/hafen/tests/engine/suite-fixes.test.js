// A test's provider by name (contracts/test-file.md: a name under providers, a preset, plugin:…, a
// file, in that order); a secret that isn't set, said where it's first used; and a run stopped early
// (--max-cost) whose test had already failed: failed, in the run and every report.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { loadSuite, problemsFor, providerOf, secretsNeeded, secretUses } from "../../engine/files/suite-file.js";
import { preflight, runSuites } from "../../engine/runner.js";
import { jsonSummary } from "../../engine/reports/json.js";
import { junit } from "../../engine/reports/junit.js";
import { markdown } from "../../engine/reports/markdown.js";
import { servePort, suiteView } from "../../engine/serve-port.js";
import { MOCK_SSE_PROVIDER, memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
after(() => mock.close());
beforeEach(() => mock.reset());

const JSON_PROVIDER = `kind: http
url: "{{base_url}}/json"
body: { message: "{{user}}" }
response:
  text: $.data.reply
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
price: { input: 1, output: 2 }
`;
// (a turn of "hi" costs $0.017 at these prices: 11 tokens in, 3 out)
const PRICEY = JSON_PROVIDER.replace("price: { input: 1, output: 2 }", "price: { input: 1000, output: 2000 }");

const host = (files, secrets = {}) => memoryHost({ "providers/json.yml": JSON_PROVIDER, "providers/sse.yml": MOCK_SSE_PROVIDER, "providers/pricey.yml": PRICEY, ...files }, { secrets });

async function load(yaml, files = {}, secrets = {}) {
  const h = host({ "s.hafen.yml": yaml, ...files }, secrets);
  return { host: h, suite: await loadSuite(h, "s.hafen.yml") };
}

async function run(yaml, { files = {}, options = {}, secrets = {} } = {}) {
  const { host: h, suite } = await load(yaml, files, secrets);
  assert.deepEqual(suite.errors, [], JSON.stringify(suite.errors));
  return runSuites({ suites: [suite], host: h, options: { vars: { base_url: mock.url }, ...options } });
}

function connect(h) {
  let handler;
  const waiting = new Map();
  let next = 1;
  servePort({ receive: (fn) => { handler = fn; }, send: (m) => waiting.get(m.id)?.(m) }, async () => h);
  return (cmd, args) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, (m) => (m.ok ? resolve(m.value) : reject(new Error(m.error))));
    handler({ id, cmd, args });
  });
}

const TOOLSY = `  toolsy:
    kind: http
    url: "{{base_url}}/json"
    headers: { x-which: toolsy }
    body: { message: "{{user}}" }
    response: { text: $.data.reply }
`;

describe("a test's provider, by its name under providers", () => {
  it("a test uses the named one, the others the suite's; a judge still names its own", async () => {
    const r = await run(`version: 1
provider: providers/json.yml
providers:
${TOOLSY}  judge: { kind: openai-chat, base_url: "{{base_url}}/judge", model: mock-judge, api_key: "" }
judges:
  rubric: { kind: llm, provider: judge, samples: 1 }
tests:
  - name: by name
    provider: toolsy
    turns:
      - user: a refund
        expect:
          - { contains: "refund" }
          - { type: judge, judge: rubric, rubric: [Asks why] }
  - name: the suite's
    turns:
      - user: hi
        expect: [ { contains: "You said" } ]
`);
    assert.equal(r.status, "done");
    assert.equal(r.verdict, "passed", JSON.stringify(r.turns.map((t) => t.results)));
    const chats = mock.log.filter((x) => x.path === "/json");
    assert.deepEqual(chats.map((x) => [x.body.message, x.headers["x-which"]]), [["a refund", "toolsy"], ["hi", undefined]]);
    assert.ok(mock.log.some((x) => x.path.startsWith("/judge")), "the judge asked its provider");
  });

  it("the suite's own provider can be a name; a name comes before a preset of the same name", async () => {
    const top = await run(`version: 1
provider: toolsy
providers:
${TOOLSY}tests:
  - name: a
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`);
    assert.equal(top.verdict, "passed");
    assert.equal(mock.log[0].headers["x-which"], "toolsy");
    mock.reset();
    // (gemini is a preset too: the suite's own wins, and its key isn't needed)
    const { suite } = await load(`version: 1
provider: providers/json.yml
providers:
${TOOLSY.replace("toolsy:", "gemini:")}tests:
  - name: a
    provider: gemini
    turns: [ { user: hi } ]
`);
    assert.deepEqual(suite.errors, []);
    assert.equal(providerOf(suite, 0).config.headers["x-which"], "toolsy");
    assert.equal(secretsNeeded(suite).includes("GEMINI_API_KEY"), false);
  });

  it("a named provider file: the test runs with it, and renaming the file changes only the name's path", async () => {
    const files = { "s.hafen.yml": `version: 1
provider: providers/json.yml
providers:
  streamer: providers/sse.yml
tests:
  - name: streamed
    provider: streamer
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
` };
    const h = host(files);
    const suite = await loadSuite(h, "s.hafen.yml");
    assert.deepEqual(suite.errors, []);
    assert.deepEqual(providerOf(suite, 0), { config: suite.providers.streamer, file: "providers/sse.yml" });
    assert.deepEqual(Object.keys(suite.providerFiles).sort(), ["", "streamer"]);
    assert.equal(suite.providerNames["test:0"], "streamer");
    const r = await runSuites({ suites: [suite], host: h, options: { vars: { base_url: mock.url, scenario: "sse" } } });
    assert.equal(r.verdict, "passed");
    assert.equal(mock.log[0].path, "/sse");
    // (the page gets the suite as data it can copy: no parsed file in it)
    structuredClone(suiteView(suite));
    const call = connect(h);
    await call("open", {});
    await call("rename", { file: "providers/sse.yml", to: "providers/stream.yml" });
    const text = h.store.get("s.hafen.yml");
    assert.match(text, /streamer: providers\/stream\.yml/);
    assert.match(text, /provider: streamer\n/);
  });

  it("a name that's nothing: said where it is, with the suite's names and the one it most likely meant", async () => {
    const { suite } = await load(`version: 1
provider: providers/json.yml
providers:
${TOOLSY}  judge: anthropic-messages
tests:
  - name: a
    provider: tooly
    turns: [ { user: hi } ]
  - name: b
    provider: gemni
    turns: [ { user: hi } ]
  - name: c
    provider: providers/nope.yml
    turns: [ { user: hi } ]
`);
    assert.deepEqual(suite.errors.map((e) => `${e.file}:${e.line}:${e.column}  ${e.message}`), [
      `s.hafen.yml:13:15  tests.0.provider: there's no provider named "tooly" (under providers: toolsy, judge), and it isn't a preset or a file (did you mean "toolsy"?)`,
      `s.hafen.yml:16:15  tests.1.provider: there's no provider named "gemni" (under providers: toolsy, judge), and it isn't a preset or a file (did you mean "gemini"?)`,
      "s.hafen.yml:19:15  tests.2.provider: the provider file providers/nope.yml doesn't exist",
    ]);
    const none = await load("version: 1\nprovider: providers/json.yml\ntests:\n  - name: a\n    provider: mystery\n    turns: [ { user: hi } ]\n");
    assert.deepEqual(none.suite.errors.map((e) => e.message), [`tests.0.provider: there's no provider named "mystery" (the suite has none under providers), and it isn't a preset or a file`]);
  });

  it("what a run checks first sees it: a named plugin provider a test uses is one problem, said once", async () => {
    const { host: h, suite } = await load(`version: 1
providers:
  acme: { kind: "plugin:acme", url: "{{base_url}}/json" }
tests:
  - name: a
    provider: acme
    turns: [ { user: hi } ]
`);
    assert.deepEqual(suite.errors, []);
    const checked = await preflight({ suites: [suite], host: h, options: { vars: { base_url: "x" } } });
    checked.close();
    assert.deepEqual(checked.problems.map((p) => p.message), [`the provider plugin "acme" isn't in the folder's plugins/ or the suite's plugins`]);
  });
});

describe("a secret that isn't set: where it's first used", () => {
  const at = (problems) => problems.map((p) => `${p.file}:${p.line}:${p.column}  ${p.message}`);

  it("in a provider file, in the suite (an inline provider, a setup step), and a preset's key at its kind", async () => {
    const { suite } = await load(`version: 1
provider: providers/keyed.yml
providers:
  judge: anthropic-messages
  inline: { kind: gemini, model: m }
setup:
  - name: log in
    request: { url: "{{base_url}}/login", body: { password: "{{secret.QA_PASSWORD}}" } }
tests:
  - name: a
    provider:
      kind: http
      url: "{{base_url}}/json"
      headers: { x-key: "{{secret.INLINE_KEY}}" }
    turns: [ { user: "hi {{secret.QA_PASSWORD}}" } ]
`, { "providers/keyed.yml": `# a provider with a key
kind: http
url: "{{base_url}}/json"
headers: { Authorization: "Bearer {{secret.ACME_KEY}}" }
` });
    assert.deepEqual(suite.errors, []);
    const problems = problemsFor(suite, { base_url: "x" }, () => undefined);
    assert.deepEqual(at(problems), [
      "s.hafen.yml:8:62  {{secret.QA_PASSWORD}} isn't set",
      "s.hafen.yml:14:26  {{secret.INLINE_KEY}} isn't set",
      "s.hafen.yml:4:10  {{secret.ANTHROPIC_API_KEY}} isn't set",
      "s.hafen.yml:5:19  {{secret.GEMINI_API_KEY}} isn't set",
      "providers/keyed.yml:4:35  {{secret.ACME_KEY}} isn't set",
    ]);
    assert.deepEqual(problems.map((p) => p.variable), ["QA_PASSWORD", "INLINE_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "ACME_KEY"]);
    // A preset's kind in a provider file
    const file = await load("version: 1\nprovider: providers/claude.yml\ntests:\n  - name: a\n    turns: [ { user: hi } ]\n", { "providers/claude.yml": "model: claude-x\nkind: anthropic-messages\n" });
    assert.deepEqual(at(problemsFor(file.suite, {}, () => undefined)), ["providers/claude.yml:2:7  {{secret.ANTHROPIC_API_KEY}} isn't set"]);
  });

  it("System One's key at its judge, or with none declared, at the first check that asks it", async () => {
    const asks = `tests:
  - name: a
    turns:
      - user: hi
        expect:
          - { type: systemone.noul, question: "off?", enabled: false }
          - { type: systemone.noul, question: "why?" }
`;
    const judged = await load(`version: 1\nprovider: providers/json.yml\njudges:\n  default:\n    kind: systemone\n${asks}`);
    assert.deepEqual(at(problemsFor(judged.suite, { base_url: "x" }, () => undefined)), ["s.hafen.yml:5:11  {{secret.JEV_API_KEY}} isn't set"]);
    const bare = await load(`version: 1\nprovider: providers/json.yml\n${asks}`);
    assert.deepEqual(at(problemsFor(bare.suite, { base_url: "x" }, () => undefined)), ["s.hafen.yml:9:21  {{secret.JEV_API_KEY}} isn't set"]);
  });

  it("a check turned off isn't a use; a run's check keeps each problem's suite", async () => {
    const { host: h, suite } = await load(`version: 1
provider: providers/json.yml
tests:
  - name: a
    turns:
      - user: hi
        expect:
          - { contains: "{{secret.OFF_KEY}}", enabled: false }
          - { contains: "{{secret.ON_KEY}}" }
`);
    assert.deepEqual(secretUses(suite), [{ name: "ON_KEY", file: "s.hafen.yml", line: 9, column: 26 }]);
    const checked = await preflight({ suites: [suite], host: h, options: { vars: { base_url: "x" } } });
    checked.close();
    assert.deepEqual(checked.problems, [{ file: "s.hafen.yml", line: 9, column: 26, variable: "ON_KEY", message: "{{secret.ON_KEY}} isn't set", suite: "s.hafen.yml" }]);
  });
});

describe("a run stopped early (--max-cost)", () => {
  const three = `version: 1
provider: providers/pricey.yml
tests:
  - name: t1
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
  - name: t2
    turns: [ { user: hi, expect: [ { contains: "nope" } ] } ]
  - name: t3
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`;

  it("a test that had failed before the stop is failed, in the run and in every report; one that never ran is skipped", async () => {
    const r = await run(three, { options: { maxCost: 0.03 } });
    assert.equal(r.status, "stopped");
    assert.match(r.stopped, /cost reached the limit/);
    assert.deepEqual(r.tests.map((t) => [t.name, t.status]), [["t1", "passed"], ["t2", "failed"], ["t3", "skipped"]]);
    assert.equal(r.tests[1].instances[0].status, "failed");
    assert.deepEqual(r.summary.tests, { passed: 1, failed: 1, unsure: 0, error: 0, skipped: 1, stopped: 0, total: 3 });
    assert.equal(r.verdict, "failed");
    assert.equal(r.spans.find((s) => s.kind === "suite").status, "fail");
    assert.equal(mock.log.length, 2);
    const xml = junit(r);
    const t2 = xml.match(/<testcase [^>]*name="t2"[^>]*>[\s\S]*?<\/testcase>/)[0];
    assert.match(t2, /<failure message="contains nope/);
    assert.doesNotMatch(t2, /<skipped/);
    assert.match(xml, /<testcase [^>]*name="t3"[^>]*>\s*<skipped/);
    assert.match(xml, /<testsuite [^>]*failures="1" errors="0" skipped="1"/);
    assert.match(xml, /<property name="verdict" value="failed"\/>/);
    const md = markdown(r);
    assert.match(md, /3 tests · 1 failed/);
    assert.match(md, /\| ✗ \| t2 \|/);
    const json = JSON.parse(jsonSummary(r));
    assert.equal(json.verdict, "failed");
    assert.deepEqual(json.tests.map((t) => t.status), ["passed", "failed", "skipped"]);
  });

  it("a passing test the stop caught is stopped, and the run's verdict is null: nothing failed, not everything ran", async () => {
    const r = await run(three, { options: { maxCost: 0.01 } });
    assert.deepEqual(r.tests.map((t) => [t.name, t.status]), [["t1", "stopped"], ["t2", "skipped"], ["t3", "skipped"]]);
    assert.equal(r.verdict, null);
    assert.equal(r.spans.find((s) => s.kind === "suite").status, "skipped");
  });

  it("with repeats, failed only when the runs that failed already rule out its pass rate", async () => {
    const repeated = (rate) => `version: 1
provider: providers/pricey.yml
tests:
  - name: r
    repeat: 3
    pass_rate: ${rate}
    turns: [ { user: hi, expect: [ { contains: "nope" } ] } ]
`;
    const strict = await run(repeated(1), { options: { maxCost: 0.01 } });
    assert.deepEqual([strict.tests[0].status, strict.tests[0].total], ["failed", 1]);
    const lenient = await run(repeated(0.5), { options: { maxCost: 0.01 } });
    assert.deepEqual([lenient.tests[0].status, lenient.tests[0].total], ["stopped", 1]);
  });

  it("an error of the test's own before the stop is an error, not stopped", async () => {
    // (a's setup fails at once; while its teardown waits, b spends past the limit)
    const r = await run(`version: 1
provider: providers/pricey.yml
tests:
  - name: a
    group: 1
    setup:
      - request: { url: "{{base_url}}/error/500", method: POST }
        expect: [ { type: status, equals: 200 } ]
    teardown:
      - request: { url: "{{base_url}}/slow?ms=600", method: POST, body: { message: x } }
    turns: [ { user: hi } ]
  - name: b
    group: 2
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`, { options: { maxCost: 0.01 } });
    assert.equal(r.status, "stopped");
    const a = r.tests.find((t) => t.name === "a");
    assert.equal(a.status, "error");
    assert.match(a.instances[0].reason, /setup "1" failed/);
    assert.equal(r.verdict, "failed");
  });
});
