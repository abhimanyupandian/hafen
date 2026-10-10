// Suite and provider files: loading them (each problem at its line and column), a test's provider by
// name, only the opened folder read, a data row's name, and what suites use (Import and Export).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { nodeHost } from "../../cli/node-host.js";
import { firstCell, parseData, readData, rowLabel, rowNameText } from "../../engine/files/data.js";
import { dependencies, fileRefs, freeName, relativeImports, retarget } from "../../engine/files/dependencies.js";
import { problemsFor, secretsNeeded } from "../../engine/files/needs.js";
import { climbsOut, loadSuite, providerOf } from "../../engine/files/suite-file.js";
import { fixturesOf } from "../../engine/fixture-lists.js";
import { preflight } from "../../engine/preflight.js";
import { jsonSummary } from "../../engine/reports/json.js";
import { junit } from "../../engine/reports/junit.js";
import { markdown } from "../../engine/reports/markdown.js";
import { parseRun, serializeRun } from "../../engine/reports/run-file.js";
import { runSuites } from "../../engine/runner.js";
import { servePort, suiteView } from "../../engine/serve-port.js";
import { freeTestName } from "../../engine/util.js";
import { fakeTransport, memoryHost, MOCK_SSE_PROVIDER, startMock } from "../helpers.js";

let mock;
const dirs = [];
before(async () => { mock = await startMock({ chunkMs: 1 }); });
beforeEach(() => mock.reset());
after(async () => {
  await mock.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("loading suites", () => {
  const PROVIDER = "kind: http\nurl: \"{{base_url}}/json\"\nbody: { message: \"{{user}}\" }\nresponse:\n  text: $.data.reply\n";

  const SUITE = `# A suite, with comments to keep
version: 1
name: Refunds
provider: providers/p.yml
environments:
  local: { base_url: "http://localhost:8791" }   # the mock
tests:
  - name: refund
    turns:
      - user: "I want a refund"   # first turn
        extract:
          session: $.session_id
        expect:
          - { type: status, equals: 200 }
          - { path: $.data.reply, contains: "4417" }
      - user: "session {{session}}"
`;

  it("loads a valid suite and its provider", async () => {
    const host = memoryHost({ "s.hafen.yml": SUITE, "providers/p.yml": PROVIDER });
    const suite = await loadSuite(host, "s.hafen.yml");
    assert.deepEqual(suite.errors, []);
    assert.deepEqual(suite.missing, []);
    assert.equal(suite.name, "Refunds");
    assert.equal(suite.provider.kind, "http");
    assert.equal(suite.data.tests[0].turns.length, 2);
  });

  it("reports schema problems with their line and column", async () => {
    const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider: openai-chat\ntests:\n  - name: a\n    repeat: zero\n    turns:\n      - user: hi\n" });
    const suite = await loadSuite(host, "s.hafen.yml");
    const e = suite.errors.find((x) => /repeat/.test(x.message));
    assert.ok(e, JSON.stringify(suite.errors));
    assert.equal(e.line, 5);
    assert.equal(e.file, "s.hafen.yml");
  });

  it("refuses a newer version, saying so", async () => {
    const suite = await loadSuite(memoryHost({ "s.hafen.yml": "version: 2\ntests: []\n" }), "s.hafen.yml");
    assert.match(suite.errors[0].message, /newer Hafen/);
    assert.equal(suite.errors[0].line, 1);
  });

  it("reports YAML that doesn't parse", async () => {
    const suite = await loadSuite(memoryHost({ "s.hafen.yml": "version: 1\ntests: [\n" }), "s.hafen.yml");
    assert.ok(suite.errors.length);
    assert.ok(suite.errors[0].line);
  });

  it("finds a missing provider file, data file and variable", async () => {
    const host = memoryHost({
      "s.hafen.yml": "version: 1\nprovider: providers/nope.yml\ntests:\n  - name: a\n    data: rows.csv\n    turns:\n      - user: \"{{who}}\"\n",
    });
    const suite = await loadSuite(host, "s.hafen.yml");
    const messages = suite.errors.map((e) => e.message).join("\n");
    assert.match(messages, /providers\/nope.yml doesn't exist/);
    assert.match(messages, /rows.csv doesn't exist/);
  });

  it("finds variables used before they're set", async () => {
    const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider: openai-chat\ntests:\n  - name: a\n    turns:\n      - user: \"{{who}}\"\n      - user: ok\n        extract: { x: $.a }\n" });
    const suite = await loadSuite(host, "s.hafen.yml");
    assert.match(suite.missing.map((e) => e.message).join("\n"), /\{\{who\}\} isn't set anywhere/);
    assert.equal(suite.missing[0].line, 6);
    assert.equal(suite.missing[0].variable, "who");
  });

  it("finds invalid paths, patterns and judges", async () => {
    const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider: openai-chat\ntests:\n  - name: a\n    turns:\n      - user: hi\n        expect:\n          - { path: \"$.[bad\", equals: 1 }\n          - { matches: \"(\" }\n          - { type: judge, judge: nobody, rubric: x }\n" });
    const messages = (await loadSuite(host, "s.hafen.yml")).errors.map((e) => e.message).join("\n");
    assert.match(messages, /isn't a valid JSONPath/);
    assert.match(messages, /isn't a valid regular expression/);
    assert.match(messages, /no judge named "nobody"/);
  });

  it("an unknown key is a problem (it would do nothing, silently), and stays in the file; x- keys are the user's own", async () => {
    const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider: openai-chat\nowner: qa\nx-team: support\ntests:\n  - name: a\n    turns:\n      - user: hi\n        expect: [ { contains: hi } ]\n" });
    const suite = await loadSuite(host, "s.hafen.yml");
    assert.equal(suite.errors.length, 1);
    assert.match(suite.errors[0].message, /unknown key "owner" \(keys of your own start with x-, as x-owner\)/);
    assert.equal(suite.errors[0].line, 3);
    assert.equal(suite.data.owner, "qa");
    assert.equal(suite.data["x-team"], "support");
  });

  it("a misspelled key says what it meant, as the one problem: no false green, no wall of schema errors", async () => {
    const at = async (text) => (await loadSuite(memoryHost({ "s.hafen.yml": text }), "s.hafen.yml")).errors.map((e) => `${e.line} ${e.message}`);
    const head = "version: 1\nprovider: openai-chat\ntests:\n  - name: a\n";
    // A turn's checks under a misspelled key never ran, and the test passed
    assert.deepEqual(await at(`${head}    turns:\n      - user: hi\n        expcet: [ { contains: nope } ]\n`), ['7 tests.0.turns.0: unknown key "expcet" (did you mean "expect"?)']);
    // A check's operator misspelled: once, not "must have required property" for each operator
    assert.deepEqual(await at(`${head}    turns:\n      - user: hi\n        expect:\n          - { path: $.a, equal: 1 }\n`), ['8 tests.0.turns.0.expect.0: unknown key "equal" (did you mean "equals"?)']);
    assert.deepEqual(await at(`${head}    turns:\n      - user: hi\n        expect:\n          - { contains: hi, ignorecase: true }\n`), ['8 tests.0.turns.0.expect.0: unknown key "ignorecase" (did you mean "ignore_case"?)']);
    assert.deepEqual(await at(`${head}    tunrs:\n      - user: hi\n`), ['5 tests.0: unknown key "tunrs" (did you mean "turns"?)']);
    // An operator missing, nothing misspelled: one line naming what would do
    const none = await at(`${head}    turns:\n      - user: hi\n        expect:\n          - { path: $.a }\n`);
    assert.equal(none.length, 1);
    assert.match(none[0], /^8 tests\.0\.turns\.0\.expect\.0: needs one of: type, equals, not_equals, contains/);
    // A check plugin's check takes what fields it likes
    assert.deepEqual(await at(`${head}    turns:\n      - user: hi\n        expect:\n          - { type: polite, strictness: 3 }\n`), []);
  });

  it("a provider's misspelled key is a problem too (a plugin's provider takes what it likes)", async () => {
    const host = memoryHost({
      "s.hafen.yml": "version: 1\nprovider: p.yml\ntests:\n  - name: a\n    turns:\n      - user: hi\n        expect: [ { contains: hi } ]\n",
      "p.yml": "kind: http\nurl: http://x\nbody: { message: \"{{user}}\" }\nrespnse: { text: $.reply }\nevents:\n  - { when: { $.type: delta }, txt: $.delta }\n",
      "q.hafen.yml": "version: 1\nprovider: { kind: \"plugin:acme\", anything: 1 }\ntests:\n  - name: a\n    turns:\n      - user: hi\n        expect: [ { contains: hi } ]\n",
    });
    const messages = (await loadSuite(host, "s.hafen.yml")).errors.map((e) => `${e.file}:${e.line} ${e.message}`);
    assert.deepEqual(messages, ['p.yml:4 unknown key "respnse" (did you mean "response"?)', 'p.yml:6 events.0: unknown key "txt" (did you mean "text"?)']);
    assert.deepEqual((await loadSuite(host, "q.hafen.yml")).errors, []);
  });

  it("two tests named the same are a problem; a test with no checks is a warning", async () => {
    const suite = await loadSuite(memoryHost({ "s.hafen.yml": "version: 1\nprovider: openai-chat\ntests:\n  - name: a\n    turns: [ { user: hi, expect: [ { contains: hi } ] } ]\n  - name: a\n    turns: [ { user: hi } ]\n" }), "s.hafen.yml");
    assert.deepEqual(suite.errors.map((e) => e.message), ['tests.1.name: tests.0 is named "a" too: each test\'s name is its own']);
    assert.match(suite.warnings.map((w) => w.message).join("\n"), /"a" has no checks: it passes whenever each turn gets a reply/);
    // So a test the app adds (+, Save as test) takes a name no test has
    assert.equal(freeTestName(suite.data.tests, "b"), "b");
    assert.equal(freeTestName([...suite.data.tests, { name: "a 2" }], "a"), "a 3");
  });

  it("reads data files", async () => {
    assert.deepEqual(parseData('question,order\n"Where is ""my"" order?",4417\nhi,1\n', "d.csv"), [{ question: 'Where is "my" order?', order: "4417" }, { question: "hi", order: "1" }]);
    assert.deepEqual(parseData('{"q":"a"}\n\n{"q":"b"}\n', "d.jsonl"), [{ q: "a" }, { q: "b" }]);
    assert.throws(() => parseData("{\"q\":1}\nnot json\n", "d.jsonl"), /d.jsonl:2/);
  });
});

describe("a test's provider, by its name under providers", () => {
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

describe("the opened folder, and where each problem is", () => {
  const PROVIDER = "kind: http\nurl: http://endpoint.example/chat\nbody: { message: \"{{user}}\" }\nresponse:\n  text: $.data.reply\n";

  // The engine behind a port, as the app has it: call(cmd, args), and the log lines it sends
  function connect(host) {
    let handler;
    const waiting = new Map();
    const logs = [];
    let next = 1;
    servePort({ receive: (h) => { handler = h; }, send: (m) => { if (m.log) logs.push(m.log); waiting.get(m.id)?.(m); } }, async () => host);
    const call = (cmd, args) => new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, (m) => (m.ok ? resolve(m.value) : reject(new Error(m.error))));
      handler({ id, cmd, args });
    });
    return { call, logs };
  }

  const at = (problems) => problems.map((p) => `${p.file}:${p.line}:${p.column}  ${p.message}`);

  // A JSON provider on one of the mock's paths, with more of its keys
  const provider = (path, more = "") => `kind: http
url: "{{base_url}}${path}"
body: { message: "{{user}}" }
response: { text: $.data.reply }
${more}`;

  // A suite of one test on providers/p.yml (its head and test keys given)
  const suite = ({ head = "", test = "", expect = "[ { contains: \"You said\" } ]" } = {}) => `version: 1
provider: providers/p.yml
${head}
tests:
  - name: t
${test}    turns: [ { user: hi, expect: ${expect} } ]
`;

  describe("files are read only in the opened folder (and the folders a command line names)", () => {
    let root;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "hafen-read-"));
      mkdirSync(join(root, "folder", "data"), { recursive: true });
      mkdirSync(join(root, "outside"), { recursive: true });
      writeFileSync(join(root, "outside", "credentials"), "aws_secret_access_key = SECRET");
      writeFileSync(join(root, "folder", "data", "rows.csv"), "q\nhi\n");
      symlinkSync(join(root, "outside", "credentials"), join(root, "folder", "data", "link.csv"));
    });

    it("refuses a path outside it (absolute, ../, or a link out), and says so", async () => {
      const host = nodeHost({ root: join(root, "folder") });
      assert.equal(await host.files.read("data/rows.csv"), "q\nhi\n");
      for (const p of [join(root, "outside", "credentials"), "../outside/credentials", "data/link.csv"]) {
        await assert.rejects(host.files.read(p), /isn't in the opened folder/, p);
        assert.equal(await host.files.exists(p), false, p);
      }
      assert.equal(host.files.outside("../outside/credentials"), true);
      assert.equal(host.files.outside("data/rows.csv"), false);
      await assert.rejects(host.files.write("../outside/x", "x"), /isn't in the opened folder/);
      assert.deepEqual(await host.list(join(root, "outside")), []);
    });

    it("a suite naming a data file outside it: a problem that says why, nothing read or sent", async () => {
      writeFileSync(join(root, "folder", "s.hafen.yml"), `version: 1\nprovider: p.yml\ntests:\n  - name: t\n    data: ${join(root, "outside", "credentials")}\n    turns: [ { user: "row: {{row}}" } ]\n`);
      writeFileSync(join(root, "folder", "p.yml"), PROVIDER);
      const transport = fakeTransport(() => ({ body: "{}" }));
      const host = nodeHost({ root: join(root, "folder"), transport });
      const suite = await loadSuite(host, "s.hafen.yml");
      assert.ok(suite.errors.some((e) => /isn't in the opened folder/.test(e.message)), JSON.stringify(suite.errors));
      await runSuites({ suites: [suite], host, options: {} });
      assert.equal(transport.requests.length, 0);
    });

    it("a folder the command line names is read too", async () => {
      const host = nodeHost({ root: join(root, "folder"), also: [join(root, "outside")] });
      assert.match(await host.files.read(join(root, "outside", "credentials")), /SECRET/);
      assert.deepEqual(await host.list(join(root, "outside")), ["../outside/credentials"]);
      rmSync(root, { recursive: true, force: true });
    });
  });

  describe("a provider file outside the opened folder", () => {
    it("climbsOut: a path with more ../ than its file is deep", () => {
      assert.equal(climbsOut("s.hafen.yml", "../outside.yml"), true);
      assert.equal(climbsOut("tests/s.hafen.yml", "../providers/p.yml"), false);
      assert.equal(climbsOut("tests/s.hafen.yml", "../../p.yml"), true);
      assert.equal(climbsOut("tests/s.hafen.yml", "a/../../../p.yml"), true);
      assert.equal(climbsOut("./s.hafen.yml", "./p.yml"), false);
      assert.equal(climbsOut("s.hafen.yml", "/abs/p.yml"), false);
      assert.equal(climbsOut("../other/s.hafen.yml", "../p.yml"), false);
    });

    it("is said to be outside it, once: not as a file that doesn't exist, and not as no provider too (nor the one in the folder it would have found)", async () => {
      const host = memoryHost({ "outside.yml": provider("/json"), "s.hafen.yml": suite().replace("providers/p.yml", "../outside.yml") });
      const s = await loadSuite(host, "s.hafen.yml");
      assert.deepEqual(at(s.errors), ["s.hafen.yml:2:11  provider: the provider file ../outside.yml isn't in the opened folder (only files in it are read)"]);
      // On disk, the file there
      const root = await mkdtemp(join(tmpdir(), "hafen-outside-"));
      dirs.push(root);
      const files = { "outside.yml": provider("/json"), "proj/s.hafen.yml": suite().replace("providers/p.yml", "../outside.yml"), "proj/data.hafen.yml": suite({ test: "    data: ../rows.csv\n" }), "proj/providers/p.yml": provider("/json"), "rows.csv": "a\n1\n" };
      for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), text);
      }
      const disk = nodeHost({ root: join(root, "proj") });
      assert.deepEqual(at((await loadSuite(disk, "s.hafen.yml")).errors), ["s.hafen.yml:2:11  provider: the provider file ../outside.yml isn't in the opened folder (only files in it are read)"]);
      assert.deepEqual((await loadSuite(disk, "data.hafen.yml")).errors.map((e) => e.message), ["the data file ../rows.csv isn't in the opened folder (only files in it are read)"]);
    });

    it("one that doesn't exist, or a name that's none: said once, no \"no provider\" after it; a test with no provider at all still is", async () => {
      const host = memoryHost({ "s.hafen.yml": suite().replace("providers/p.yml", "providers/nope.yml") });
      assert.deepEqual(at((await loadSuite(host, "s.hafen.yml")).errors), ["s.hafen.yml:2:11  provider: the provider file providers/nope.yml doesn't exist"]);
      const tests = memoryHost({ "s.hafen.yml": "version: 1\ntests:\n  - name: a\n    provider: nope\n    turns: [ { user: hi } ]\n  - name: b\n    turns: [ { user: hi } ]\n" });
      assert.deepEqual((await loadSuite(tests, "s.hafen.yml")).errors.map((e) => e.message), [
        "tests.0.provider: there's no provider named \"nope\" (the suite has none under providers), and it isn't a preset or a file",
        "no provider: set provider at the top, or on every test",
      ]);
    });

    it("a plugin a suite names outside it: the same", async () => {
      const host = memoryHost({ "plugins/p.js": "export default {};", "providers/p.yml": provider("/json"), "s.hafen.yml": suite({ head: "plugins: [../plugins/p.js]" }) });
      const checked = await preflight({ suites: [await loadSuite(host, "s.hafen.yml")], host, options: { vars: { base_url: "x" } } });
      checked.close();
      assert.deepEqual(checked.problems.map((p) => p.message), ["the plugin ../plugins/p.js isn't in the opened folder (only files in it are read)"]);
    });
  });

  describe("a suite written wrong can't stop the folder opening", () => {
    const P = "kind: http\nurl: http://x\nbody: { m: \"{{user}}\" }\nresponse: { text: $.r }\n";
    const cases = {
      "an empty test": "version: 1\nprovider: providers/p.yml\ntests:\n  -\n",
      "an empty turn": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    turns:\n      -\n",
      "an empty check": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    turns:\n      - user: hi\n        expect:\n          -\n",
      "tests as a map": "version: 1\nprovider: providers/p.yml\ntests:\n  a: 1\n",
      "a turn as text": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    turns: [hi]\n",
      "tags as text": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    tags: smoke\n    turns: [ { user: hi } ]\n",
      "expect as a map": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    turns:\n      - user: hi\n        expect:\n          path: $.x\n",
      "a null judge": "version: 1\nprovider: providers/p.yml\njudges:\n  j: ~\ntests:\n  - name: a\n    turns:\n      - user: hi\n        expect: [ { type: systemone.noul, question: q } ]\n",
    };
    for (const [label, text] of Object.entries(cases)) {
      it(`${label}: loads with its problem, its shape safe to read`, async () => {
        const host = memoryHost({ "bad.hafen.yml": text, "good.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: g\n    turns: [ { user: hi } ]\n", "providers/p.yml": P });
        const suite = await loadSuite(host, "bad.hafen.yml");
        assert.ok(suite.errors.length, "it has a problem");
        for (const t of suite.data.tests ?? []) {
          assert.equal(typeof t, "object");
          assert.ok(Array.isArray(t.turns ?? []));
          for (const u of t.turns ?? []) assert.ok(Array.isArray(u.expect ?? []) && typeof u === "object");
          assert.ok(Array.isArray(t.tags ?? []));
        }
        problemsFor(suite, {}, () => undefined, null);
        secretsNeeded(suite);
        // The folder opens, the other suite with it
        const { call } = connect(host);
        const opened = await call("open", {});
        assert.deepEqual(opened.suites.map((s) => s.file).sort(), ["bad.hafen.yml", "good.hafen.yml"]);
        assert.deepEqual(opened.suites.find((s) => s.file === "good.hafen.yml").errors, []);
      });
    }
  });

  it("a provider is renamed all or nothing: one suite it can't be changed in, and nothing's changed", async () => {
    const files = {
      "a.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    turns: [ { user: hi } ]\n",
      "c.hafen.yml": "version: 1\nproviders:\n  main: &p providers/p.yml\nprovider: *p\ntests:\n  - name: c\n    turns: [ { user: hi } ]\n",
      "providers/p.yml": PROVIDER,
    };
    const host = memoryHost({ ...files });
    const { call } = connect(host);
    await call("open", {});
    await assert.rejects(call("rename", { file: "providers/p.yml", to: "providers/q.yml" }), /nothing was renamed/);
    assert.deepEqual(Object.fromEntries(host.store), files);
  });

  describe("every problem has its file, line and column", () => {
    it("a provider file's fixture lists: at the fixture in its list (or the list, or the key)", async () => {
      const files = {
        "plugins/check.js": "export default { kind: \"check\", name: \"a-check\", version: \"1.0.0\", async check() { return { status: \"pass\" }; } };\n",
        "providers/p.yml": `${provider("/json")}fixtures:\n  beforeAll: [nothere]\n  before: [a-check, a-check]\n  later: [x]\n`,
        "providers/q.yml": `${provider("/json")}fixtures:\n  after: [ok, 3]\n`,
        "s.hafen.yml": `${suite()}  - name: q\n    provider: providers/q.yml\n    turns: [ { user: hi } ]\n`,
      };
      const host = memoryHost(files);
      const checked = await preflight({ suites: [await loadSuite(host, "s.hafen.yml")], host, options: { vars: { base_url: "x" } } });
      checked.close();
      // (the schema's own problems with these files are there too, each with its place)
      assert.deepEqual(at(checked.problems.filter((p) => /fixture/.test(p.message) && !/unknown key|must be/.test(p.message))), [
        "providers/p.yml:7:21  fixtures.before names a-check twice: a list runs each fixture once (another list can name it too)",
        "providers/p.yml:8:10  fixtures has no list \"later\": its lists are beforeAll, before, after and afterAll",
        "providers/p.yml:6:15  the fixture \"nothere\" (fixtures.beforeAll) isn't in the folder's plugins/ or the suite's plugins",
        "providers/p.yml:7:12  the plugin \"a-check\" (fixtures.before) is a check, not a fixture",
        "providers/q.yml:6:15  fixtures.after is a list of fixture plugins' names",
      ]);
      assert.ok(checked.problems.every((p) => p.line && p.column), at(checked.problems).join("\n"));
      assert.deepEqual(fixturesOf({ fixtures: { before: ["a", "b", "a"] } }).at, [["fixtures", "before", 2]]);
    });

    it("a provider's {{variable}} the suite doesn't set, an --env that isn't there, a plugin entry that isn't", async () => {
      const files = { "providers/p.yml": "kind: http\nurl: x\nheaders: { x-who: \"{{ who }}\" }\nbody: { m: \"{{user}}\" }\n", "s.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    turns: [ { user: hi } ]\n" };
      const varsHost = memoryHost(files);
      const vars = await preflight({ suites: [await loadSuite(varsHost, "s.hafen.yml")], host: varsHost });
      vars.close();
      assert.deepEqual(at(vars.problems), ["providers/p.yml:3:20  the provider uses {{who}}, which the suite doesn't set"]);
      const inline = memoryHost({ "s.hafen.yml": "version: 1\nprovider:\n  kind: http\n  url: \"x/{{nope}}\"\ntests:\n  - name: a\n    turns: [ { user: hi } ]\n" });
      assert.deepEqual(at((await loadSuite(inline, "s.hafen.yml")).missing), ["s.hafen.yml:4:11  the provider uses {{nope}}, which the suite doesn't set"]);
      const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider: openai-chat\nplugins: [./plugins/missing.js]\nenvironments:\n  local: {}\ntests:\n  - name: a\n    turns: [ { user: hi } ]\n" });
      const checked = await preflight({ suites: [await loadSuite(host, "s.hafen.yml")], host, options: { env: "stagnig" }, secretsFor: () => () => "x" });
      checked.close();
      assert.deepEqual(at(checked.problems), [
        "s.hafen.yml:5:3  there's no environment or scope \"stagnig\" (local)",
        "s.hafen.yml:3:11  the plugin ./plugins/missing.js doesn't exist",
      ]);
      assert.ok(checked.problems.every((p) => !("entry" in p)));
    });

    it("a fixture list written in the suite, and a provider plugin that isn't there: in the suite", async () => {
      const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider:\n  kind: http\n  url: x\n  fixtures: { before: [nobody] }\nproviders:\n  acme: { kind: \"plugin:acme\" }\ntests:\n  - name: a\n    provider: acme\n    turns: [ { user: hi } ]\n" });
      const checked = await preflight({ suites: [await loadSuite(host, "s.hafen.yml")], host });
      checked.close();
      assert.deepEqual(at(checked.problems), [
        "s.hafen.yml:7:17  the provider plugin \"acme\" isn't in the folder's plugins/ or the suite's plugins",
        "s.hafen.yml:5:24  the fixture \"nobody\" (fixtures.before) isn't in the folder's plugins/ or the suite's plugins",
      ]);
    });
  });
});

const SECRET = "sk-live-5150abcd";
// (its key a secret, so the run knows it: a data cell that holds it is redacted)
const PROVIDER = `provider: { kind: http, url: "http://x.example/chat", headers: { x-key: "{{secret.API_KEY}}" }, body: { m: "{{user}}" }, response: { text: $.reply } }`;
const suite = (tests, head = "") => `version: 1\nname: Orders\n${head}${PROVIDER}\ntests:\n${tests}`;
const ORDERS = "question,order\na refund for 4417,4417\n\"  where is\nmy   parcel  \",4418\n,4419\n";

// A run of the files, its replies the message (or reply(message)): { run, events, transport }
async function runFiles(files, { reply = (m) => m, secrets = { API_KEY: SECRET } } = {}) {
  const transport = fakeTransport((req) => ({ body: JSON.stringify({ reply: reply(JSON.parse(req.body).m) }) }));
  const host = memoryHost(files, { secrets, transport });
  const suites = [];
  for (const f of Object.keys(files).filter((f) => f.endsWith(".hafen.yml"))) suites.push(await loadSuite(host, f));
  const events = [];
  const run = await runSuites({ suites, host, onEvent: (e) => events.push(e) });
  return { run, events, transport };
}
const caseNames = (xml) => [...xml.matchAll(/<testcase [^>]*name="([^"]*)"/g)].map((m) => m[1]);
const rowSpans = (run) => run.spans.filter((s) => s.kind === "row").map((s) => s.name);
// Where a text is in a file (its first after `after`): "line:column"
const where = (text, needle, after = "") => {
  const before = text.slice(0, text.indexOf(needle, text.indexOf(after)));
  return `${before.split("\n").length}:${before.length - before.lastIndexOf("\n")}`;
};

describe("a row's name, as it's said", () => {
  it("on one line, at most 60 characters (cut with …); empty is none", () => {
    assert.equal(rowNameText("  a refund\n  please\t "), "a refund please");
    assert.equal(rowNameText("x".repeat(60)), "x".repeat(60));
    assert.equal(rowNameText("x".repeat(61)), `${"x".repeat(59)}…`);
    assert.equal([...rowNameText("é".repeat(80))].length, 60);
    // (the cut doesn't leave a space before the …)
    assert.equal(rowNameText(`${"a".repeat(58)} bcd`), `${"a".repeat(58)}…`);
    for (const none of ["", "   \n ", null, undefined]) assert.equal(rowNameText(none), undefined);
    assert.equal(rowNameText(4417), "4417");
    assert.equal(rowNameText({ id: 1 }), '{"id":1}');
    assert.equal(rowLabel(3, "a refund please"), "row 3: a refund please");
    assert.equal(rowLabel(3, undefined), "row 3");
  });

  it("the first column: a CSV file's by its header's order, a JSON line's first key", () => {
    // (a column named "1" would come first among an object's keys: the header says it's second)
    const csv = readData("question,1\nhi,x\n", "d.csv");
    assert.deepEqual(csv.columns, ["question", "1"]);
    assert.equal(firstCell(csv.rows[0], csv), "hi");
    const lines = readData('{"b":1,"a":2}\n{"a":3,"c":4}\n', "d.jsonl");
    assert.deepEqual(lines.columns, ["b", "a", "c"]);
    assert.deepEqual(lines.rows.map((r) => firstCell(r, lines)), [1, 3]);
  });
});

describe("each row's name, in the run and every report", () => {
  it("without row_name: its first column's value (CSV and JSON lines), on its runs, turns and steps; an empty one is none", async () => {
    const { run } = await runFiles({
      "data/orders.csv": ORDERS,
      "data/orders.jsonl": '{"question":"hi","order":1}\n{"order":2,"question":"bye"}\n',
      "s.hafen.yml": suite(`  - name: orders
    data: data/orders.csv
    turns: [ { user: "order {{row.order}}", expect: [ { contains: "4417" } ] } ]
  - name: lines
    data: data/orders.jsonl
    turns: [ { user: "{{row.question}}", expect: [ { contains: "i" } ] } ]
`),
    });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    const [orders, lines] = run.tests;
    assert.deepEqual(orders.instances.map((i) => i.row_name), ["a refund for 4417", "where is my parcel", undefined]);
    assert.ok(!("row_name" in orders.instances[2]), "none: not there at all");
    assert.deepEqual(lines.instances.map((i) => i.row_name), ["hi", "2"]);
    assert.deepEqual(run.turns.map((t) => t.row_name), ["a refund for 4417", "where is my parcel", undefined, "hi", "2"]);
    assert.deepEqual(rowSpans(run), ["row 1: a refund for 4417", "row 2: where is my parcel", "row 3", "row 1: hi", "row 2: 2"]);
    // JUnit: a case each row, its number and its name; the reports say where it went wrong the same way
    const xml = junit(run);
    assert.deepEqual(caseNames(xml), ["orders [row 1: a refund for 4417]", "orders [row 2: where is my parcel]", "orders [row 3]", "lines [row 1: hi]", "lines [row 2: 2]"]);
    assert.match(xml, /<failure message="contains 4417: didn&apos;t find 4417" type="check">row 2: where is my parcel · turn 1 · contains 4417/);
    assert.match(markdown(run), /- \*\*Orders › orders\*\* · row 2: where is my parcel · turn 1 · failed · `contains 4417`/);
    assert.match(markdown(run), /- \*\*Orders › orders\*\* · row 3 · turn 1 · failed/);
    const json = JSON.parse(jsonSummary(run));
    assert.deepEqual(json.tests[0].problems.map((p) => [p.row, p.row_name, p.turn]), [[2, "where is my parcel", 0], [3, null, 0]]);
    assert.deepEqual(json.results.filter((r) => r.test === "orders").map((r) => r.row_name), ["a refund for 4417", "where is my parcel", null]);
  });

  it("row_name: a template filled in with the row, the suite's variables and the environment's values, cut at 60; one that can't be filled in is none, and the row runs", async () => {
    const long = "x".repeat(80);
    const { run } = await runFiles({
      "data/orders.csv": `question,order\na refund for 4417,4417\n${long},4418\n`,
      "data/sparse.jsonl": '{"q":"hi","order":1}\n{"q":"bye"}\n',
      "s.hafen.yml": suite(`  - name: orders
    data: data/orders.csv
    row_name: "{{row.question}} ({{row.order}}, {{shop}}, {{env.region}})"
    turns: [ { user: "{{row.question}}", expect: [ { contains: "e" } ] } ]
  - name: sparse
    data: data/sparse.jsonl
    row_name: "{{row.q}} #{{row.order}}"
    turns: [ { user: "{{row.q}}", expect: [ { contains: "e" } ] } ]
`, "variables: { shop: Acme }\nenvironments: { local: { region: eu } }\n"),
    });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.deepEqual(run.tests[0].instances.map((i) => i.row_name), ["a refund for 4417 (4417, Acme, eu)", `${"x".repeat(59)}…`]);
    // (a row the template can't be filled in for: no name, never an error of its own)
    assert.deepEqual(run.tests[1].instances.map((i) => [i.row_name, i.status]), [["hi #1", "failed"], [undefined, "passed"]]);
    assert.deepEqual(caseNames(junit(run)).slice(2), ["sparse [row 1: hi #1]", "sparse [row 2]"]);
  });

  it("a secret in a data cell is redacted in the name: in the run file, JUnit, the Markdown, the JSON and every event", async () => {
    const { run, events } = await runFiles({
      "data/keys.csv": `question\nmy key is ${SECRET}\nhello\n`,
      "s.hafen.yml": suite(`  - name: keys
    data: data/keys.csv
    repeat: 2
    turns: [ { user: "{{row.question}}", expect: [ { contains: nope } ] } ]
`),
    });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.deepEqual(run.tests[0].instances.map((i) => i.row_name), ["my key is [redacted]", "hello", "my key is [redacted]", "hello"]);
    const reports = { "the run file": serializeRun(run), JUnit: junit(run), "the Markdown": markdown(run), "the JSON": jsonSummary(run), "the events": JSON.stringify(events) };
    for (const [what, text] of Object.entries(reports)) assert.ok(!text.includes(SECRET), `${what} has the secret`);
    assert.ok(caseNames(reports.JUnit).includes("keys [row 1: my key is [redacted]]"));
    assert.match(reports["the Markdown"], /row 1: my key is \[redacted\] · run 2 · turn 1 · failed/);
    // (the row's step as it started: before the turn that sends the secret)
    const started = events.find((e) => e.type === "span" && e.action === "start" && e.span.kind === "row");
    assert.equal(started.span.name, "row 1: my key is [redacted] · run 1");
    const turnStart = events.find((e) => e.type === "turn:start");
    assert.equal(turnStart.key.row_name, "my key is [redacted]");
  });

  it("a run file from before row names: each row said by its number", async () => {
    const { run } = await runFiles({
      "data/orders.csv": ORDERS,
      "s.hafen.yml": suite(`  - name: orders
    data: data/orders.csv
    turns: [ { user: "order {{row.order}}", expect: [ { contains: "4417" } ] } ]
`),
    });
    const old = parseRun(JSON.stringify(JSON.parse(serializeRun(run), (k, v) => (k === "row_name" ? undefined : v))));
    assert.ok(!serializeRun(old).includes("row_name"));
    assert.deepEqual(caseNames(junit(old)), ["orders [row 1]", "orders [row 2]", "orders [row 3]"]);
    assert.match(markdown(old), /- \*\*Orders › orders\*\* · row 2 · turn 1 · failed/);
    assert.deepEqual(JSON.parse(jsonSummary(old)).tests[0].problems.map((p) => [p.row, p.row_name]), [[2, null], [3, null]]);
  });
});

describe("the check before a run: row_name", () => {
  const check = async (files) => {
    const host = memoryHost(files, { secrets: { API_KEY: SECRET } });
    const out = await preflight({ suites: [await loadSuite(host, "s.hafen.yml")], host });
    out.close();
    return out.problems.map((p) => `${p.file}:${p.line}:${p.column}  ${p.message}`);
  };

  it("on a test with no data file: said (and only that)", async () => {
    const text = suite(`  - name: plain
    row_name: "{{row.question}}"
    turns: [ { user: hi, expect: [ { contains: hi } ] } ]
`);
    assert.deepEqual(await check({ "s.hafen.yml": text }), [`s.hafen.yml:${where(text, "row_name")}  tests.0.row_name: row_name names a data row: this test has no data file (data)`]);
  });

  it("with a secret in it: said where it's written (a row's name is in every report)", async () => {
    const text = suite(`  - name: orders
    data: data/orders.csv
    row_name: "{{row.question}} {{secret.API_KEY}}"
    turns: [ { user: hi, expect: [ { contains: hi } ] } ]
`);
    assert.deepEqual(await check({ "s.hafen.yml": text, "data/orders.csv": ORDERS }), [`s.hafen.yml:${where(text, "{{secret.API_KEY}}", "row_name")}  tests.0.row_name: a row's name can't hold a secret ({{secret.API_KEY}}): it's shown in every report`]);
  });

  it("a column the data file hasn't: said where it's written, with the one it most likely meant; a variable nothing sets, as anywhere; nothing is sent", async () => {
    const text = suite(`  - name: orders
    data: data/orders.csv
    row_name: "{{row.qestion}} {{row.zzz}} {{row.order}}"
    turns: [ { user: hi, expect: [ { contains: hi } ] } ]
  - name: lines
    data: { file: data/orders.jsonl }
    row_name: "{{row.ordr}} {{nowhere}}"
    turns: [ { user: hi, expect: [ { contains: hi } ] } ]
`);
    const files = { "s.hafen.yml": text, "data/orders.csv": ORDERS, "data/orders.jsonl": '{"question":"hi","order":1}\n' };
    assert.deepEqual(await check(files), [
      `s.hafen.yml:${where(text, "{{row.qestion}}")}  tests.0.row_name: {{row.qestion}} isn't a column of data/orders.csv (did you mean {{row.question}}?)`,
      `s.hafen.yml:${where(text, "{{row.zzz}}")}  tests.0.row_name: {{row.zzz}} isn't a column of data/orders.csv (its columns: question, order)`,
      `s.hafen.yml:${where(text, "{{row.ordr}}")}  tests.1.row_name: {{row.ordr}} isn't a column of data/orders.jsonl (did you mean {{row.order}}?)`,
      `s.hafen.yml:${where(text, '"{{row.ordr}}')}  {{nowhere}} isn't set anywhere before it's used (variables, environments, an extract or a setup step)`,
    ]);
    const { run, transport } = await runFiles(files);
    assert.equal(run.status, "error");
    assert.equal(transport.requests.length, 0);
  });
});

describe("what suites use, and copying them", () => {
  // A pretend port: call(cmd, args) → the engine's answer
  function connect(makeHost, makePlace) {
    let handler;
    const waiting = new Map();
    let next = 1;
    servePort({ receive: (h) => { handler = h; }, send: (m) => { waiting.get(m.id)?.(m); } }, makeHost, makePlace);
    return (cmd, args) => new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, (m) => (m.ok ? resolve(m.value) : reject(new Error(m.error))));
      handler({ id, cmd, args });
    });
  }

  const PROVIDER = "kind: http\nurl: http://x\nresponse: { text: $.a }\n";
  // A plugin of each kind, by name (each loads in its worker); one imports a helper beside it
  const plugin = (kind, name, more = "") => `${more}export default { kind: "${kind}", name: "${name}", version: "1.0.0", hosts: [],
  ${{ provider: "async *send() { yield { type: \"text\", text: \"hi\" }; yield { type: \"done\" }; }", check: "async check() { return { status: \"pass\", reason: \"\" }; }", judge: "async judge() { return { value: 1, reason: \"\" }; }", fixture: "async setup() { return {}; }" }[kind]} };\n`;

  const SUITE = `version: 1
provider: providers/main.yml
providers:
  other: providers/other.yml
  inline: { kind: plugin:acme }
prices: prices.yml
plugins: [./plugins/own.js, some-package]
judges:
  mine: { kind: plugin, plugin: grader }
tests:
  - name: a
    provider: other
    data: data/rows.csv
    turns:
      - user: hi
        expect:
          - { type: json, schema: schemas/order.json }
          - { type: json, schema: schemas/off.json, enabled: false }
          - { type: polite }
  - name: b
    provider: openai-chat
    data: { file: data/more.jsonl }
    turns: [ { user: hi } ]
`;

  const FOLDER = {
    "shop/checkout.hafen.yml": SUITE.replaceAll("providers/", "../providers/").replace("prices.yml", "../prices.yml").replace("./plugins/own.js", "../plugins/own.js").replaceAll("data/", "../data/").replaceAll("schemas/", "../schemas/"),
    "providers/main.yml": `${PROVIDER}fixtures: { before: [login] }\n`,
    "providers/other.yml": PROVIDER,
    "providers/unused.yml": PROVIDER,
    "prices.yml": "gpt: { input: 1, output: 2 }\n",
    "data/rows.csv": "a\n1\n",
    "data/more.jsonl": "{\"a\": 1}\n",
    "schemas/order.json": "{\"type\": \"object\"}\n",
    "plugins/own.js": plugin("check", "own"),
    "plugins/acme.js": plugin("provider", "acme", 'import { hello } from "./lib/hello.js";\n'),
    "plugins/lib/hello.js": 'export { more as hello } from "../../lib/more.js";\n',
    "lib/more.js": "export const more = 1;\n",
    "plugins/login.js": plugin("fixture", "login"),
    "plugins/grader.js": plugin("judge", "grader"),
    // (named for one name, but it's another's: found by its name, not its file's)
    "plugins/manners.js": plugin("check", "polite"),
    "plugins/unused.js": plugin("check", "unused"),
  };

  describe("what suites use", () => {
    it("lists every file a suite needs: its providers, data, prices, schemas, plugins and what they import", async () => {
      const host = memoryHost(FOLDER);
      const out = await dependencies(host, ["shop/checkout.hafen.yml"]);
      assert.deepEqual(out.files, [
        "data/more.jsonl", "data/rows.csv", "lib/more.js",
        "plugins/acme.js", "plugins/grader.js", "plugins/lib/hello.js", "plugins/login.js", "plugins/manners.js", "plugins/own.js",
        "prices.yml", "providers/main.yml", "providers/other.yml", "schemas/order.json", "shop/checkout.hafen.yml",
      ]);
      // (a check that's off names a schema that isn't there: not a problem)
      assert.deepEqual(out.problems, []);
      assert.deepEqual(out.packages, ["some-package"]);
    });

    it("says what a suite names that isn't there, and an import outside the folder", async () => {
      const host = memoryHost({
        "a.hafen.yml": "version: 1\nprovider: providers/gone.yml\nplugins: [./plugins/out.js]\ntests:\n  - name: a\n    data: rows.csv\n    turns: [ { user: hi, expect: [ { type: missing-kind } ] } ]\n",
        "plugins/out.js": `import "../../elsewhere.js";\nimport "./nope.js";\n${plugin("check", "out")}`,
      });
      const out = await dependencies(host, ["a.hafen.yml", "b.hafen.yml"]);
      assert.deepEqual(out.files, ["a.hafen.yml", "plugins/out.js"]);
      assert.deepEqual(out.problems.map((p) => `${p.file}: ${p.message}`).sort(), [
        "a.hafen.yml: it uses the plugin \"missing-kind\", which isn't in the folder's plugins/ or the suite's plugins",
        "a.hafen.yml: the data file rows.csv isn't there",
        "a.hafen.yml: the provider file providers/gone.yml isn't there",
        "b.hafen.yml: the suite isn't there",
        "plugins/out.js: it imports ../../elsewhere.js, which isn't in the folder (only files in it are copied)",
        "plugins/out.js: it imports ./nope.js, which isn't there",
      ]);
    });

    it("knows a plugin that can't be loaded by its file's name", async () => {
      const host = memoryHost({
        "a.hafen.yml": "version: 1\nprovider: plugin:broken\ntests:\n  - name: a\n    turns: [ { user: hi } ]\n",
        "plugins/broken.js": "export default {;\n",
      });
      assert.deepEqual((await dependencies(host, ["a.hafen.yml"])).files, ["a.hafen.yml", "plugins/broken.js"]);
    });

    it("reads a script's relative imports, static and dynamic, and not its packages", () => {
      assert.deepEqual(relativeImports([
        'import a from "./a.js";', "import { b, c } from '../b.mjs';", 'import "./side.js";', 'export * from "./re.js";',
        'export { x } from "./x.js";', 'const d = await import("./lazy.js");', 'import fs from "node:fs";', 'import yaml from "yaml";',
        "const nope = require('./cjs.js');", 'imported("./not-an-import.js")',
      ].join("\n")), ["./a.js", "../b.mjs", "./side.js", "./re.js", "./x.js", "./lazy.js"]);
    });

    it("finds the files a suite names, where it names them", () => {
      const refs = fileRefs({ provider: "other", providers: { other: "p/o.yml", x: "openai-chat" }, tests: [{ provider: "plugin:acme" }, { provider: "p/t.yml", data: "d.csv" }] });
      assert.deepEqual(refs.map((r) => [r.path.join("."), r.ref]), [["providers.other", "p/o.yml"], ["tests.1.provider", "p/t.yml"], ["tests.1.data", "d.csv"]]);
    });

    it("names a file kept beside another one free name on, a suite keeping its .hafen.yml", () => {
      const taken = new Set(["a/smoke-2.hafen.yml"]);
      assert.equal(freeName("a/smoke.hafen.yml", (p) => taken.has(p)), "a/smoke-3.hafen.yml");
      assert.equal(freeName("providers/p.yml", () => false), "providers/p-2.yml");
      assert.equal(freeName("data/rows", () => false), "data/rows-2");
    });

    it("points a suite at files written under another name, comments kept", () => {
      const text = "# mine\nversion: 1\nprovider: ../providers/p.yml   # the shop\ntests:\n  - name: a\n    data: { file: rows.csv }\n    turns: [ { user: hi } ]\n";
      const next = retarget(text, "shop/a.hafen.yml", new Map([["providers/p.yml", "providers/p-2.yml"], ["shop/rows.csv", "shop/rows-2.csv"]]));
      assert.equal(next, text.replace("p.yml   #", "p-2.yml   #").replace("rows.csv", "rows-2.csv"));
    });
  });

  describe("Import and Export's commands", () => {
    // The workspace, and folders picked (by name) to copy from or to
    const asked = [];  // each folder opened: { name, write }
    const setup = (workspace, places) => {
      asked.length = 0;
      const host = memoryHost(workspace);
      const opened = Object.fromEntries(Object.entries(places).map(([name, files]) => [name, memoryHost(files)]));
      const call = connect(async () => host, async ({ name }, { write }) => {
        asked.push({ name, write });
        if (!opened[name]) throw new Error(`no folder ${name}`);
        return opened[name];
      });
      return { host, opened, call };
    };

    it("lists a folder's suites, and what they use", async () => {
      const { call } = setup({}, { src: FOLDER });
      await call("open", {});
      assert.deepEqual(await call("suites", { from: { name: "src" } }), ["shop/checkout.hafen.yml"]);
      const deps = await call("dependencies", { files: ["shop/checkout.hafen.yml"], from: { name: "src" } });
      assert.equal(deps.files.length, 14);
      // (the workspace's, when none is named: it has none)
      assert.deepEqual((await call("dependencies", { files: ["shop/checkout.hafen.yml"] })).files, []);
    });

    it("says how each file stands where it would go: new, the same, or changed", async () => {
      const { call } = setup({ "a.hafen.yml": "same\n", "providers/p.yml": "mine\n", "staging.env": "A=1\n", "staging.secret.env": "S=1\n" }, { src: { "a.hafen.yml": "same\n", "providers/p.yml": "theirs\n", "data/d.csv": "a\n" } });
      await call("open", {});
      const plan = await call("copyPlan", { files: ["a.hafen.yml", "providers/p.yml", "data/d.csv"], from: { name: "src" }, texts: { "staging.env": "A=2\n" }, also: ["staging.secret.env", "prod.secret.env"] });
      assert.deepEqual(plan, [
        { file: "a.hafen.yml", status: "same" }, { file: "providers/p.yml", status: "changed" }, { file: "data/d.csv", status: "new" },
        { file: "staging.env", status: "changed" }, { file: "staging.secret.env", status: "there" }, { file: "prod.secret.env", status: "new" },
      ]);
    });

    it("copies into the workspace, keeping both where asked: the copies renamed, the suites pointed at them, a plugin kept as it was", async () => {
      const src = {
        "smoke.hafen.yml": "# theirs\nversion: 1\nprovider: providers/p.yml\nprices: prices.yml\ntests:\n  - name: theirs\n    turns: [ { user: hi, expect: [ { type: polite } ] } ]\n",
        "providers/p.yml": "kind: http   # theirs\nurl: http://x\nresponse: { text: $.a }\n",
        "prices.yml": "a: 1\n",
        "plugins/polite.js": plugin("check", "polite"),
      };
      const { host, call } = setup({ "smoke.hafen.yml": "mine\n", "smoke-2.hafen.yml": "mine too\n", "providers/p.yml": "mine\n", "plugins/polite.js": "// mine\n" }, { src });
      await call("open", {});
      const files = Object.keys(src).sort();
      const out = await call("copy", { files, from: { name: "src" }, keepBoth: ["smoke.hafen.yml", "providers/p.yml", "plugins/polite.js"] });
      assert.deepEqual(out, {
        written: [{ file: "prices.yml", as: "prices.yml" }, { file: "providers/p.yml", as: "providers/p-2.yml" }, { file: "smoke.hafen.yml", as: "smoke-3.hafen.yml" }],
        kept: ["plugins/polite.js"],
      });
      assert.equal(host.store.get("smoke.hafen.yml"), "mine\n");
      assert.equal(host.store.get("smoke-3.hafen.yml"), src["smoke.hafen.yml"].replace("providers/p.yml", "providers/p-2.yml"));
      assert.equal(host.store.get("providers/p-2.yml"), src["providers/p.yml"]);
      assert.equal(host.store.get("plugins/polite.js"), "// mine\n");
      // The suite copied reads as one, its provider the copy
      const loaded = await call("load", {});
      assert.deepEqual(loaded.suites.find((s) => s.file === "smoke-3.hafen.yml").providerFiles, { "": "providers/p-2.yml" });
    });

    it("copies from the workspace to a folder, with files written as they are given (a scope's .env)", async () => {
      const workspace = { "a.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests: []\n", "providers/p.yml": PROVIDER };
      const { opened, call } = setup(workspace, { out: { "a.hafen.yml": "old\n", "README.md": "theirs\n" } });
      await call("open", {});
      const deps = await call("dependencies", { files: ["a.hafen.yml"] });
      const out = await call("copy", { files: deps.files, to: { name: "out" }, texts: { "staging.env": "base_url=http://x\n" } });
      assert.deepEqual(out.written.map((w) => w.as), ["a.hafen.yml", "providers/p.yml", "staging.env"]);
      assert.deepEqual(Object.fromEntries(opened.out.store), { ...workspace, "README.md": "theirs\n", "staging.env": "base_url=http://x\n" });
      // (a folder to read from is opened to read only; the one written to, to write)
      assert.deepEqual(asked.splice(0), [{ name: "out", write: true }]);
      await call("copyPlan", { files: ["a.hafen.yml"], from: { name: "out" } });
      assert.deepEqual(asked, [{ name: "out", write: false }]);
    });

    it("can't copy where the platform opens no folders", async () => {
      const call = connect(async () => memoryHost({}));
      await call("open", {});
      await assert.rejects(call("dependencies", { files: ["a.hafen.yml"], from: { name: "src" } }), /can't be imported or exported here/);
    });
  });
});
