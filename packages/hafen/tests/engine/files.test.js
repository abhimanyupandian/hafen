// Suite and provider files (contracts/test-file.md): loading, problems with their line and column,
// variables checked before anything is sent, and editing in place without losing comments.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseData } from "../../engine/files/data.js";
import { editText, loadSuite, newSuiteText } from "../../engine/files/suite-file.js";
import { freeTestName } from "../../engine/util.js";
import { memoryHost } from "../helpers.js";

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

describe("loading suites", () => {
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

describe("editing in place", () => {
  it("adds a check without touching anything else (a one-line diff)", () => {
    const next = editText(SUITE, "s.hafen.yml", [{ op: "add", path: ["tests", 0, "turns", 0, "expect"], value: { path: "$.data.order.id", equals: 4417 } }]);
    const before = SUITE.split("\n");
    const after = next.split("\n");
    assert.equal(after.length, before.length + 1);
    const added = after.filter((line) => !before.includes(line));
    assert.deepEqual(added, ["          - { path: $.data.order.id, equals: 4417 }"]);
    assert.match(next, /# A suite, with comments to keep/);
    assert.match(next, /# the mock/);
    assert.match(next, /# first turn/);
  });

  it("sets and deletes fields", () => {
    let next = editText(SUITE, "s.hafen.yml", [{ op: "set", path: ["tests", 0, "repeat"], value: 3 }]);
    assert.match(next, /    repeat: 3/);
    next = editText(next, "s.hafen.yml", [{ op: "delete", path: ["tests", 0, "turns", 1] }]);
    assert.doesNotMatch(next, /session \{\{session\}\}/);
    assert.match(next, /# first turn/);
  });

  it("adds a test to a JSON suite, keeping key order", () => {
    const json = `${JSON.stringify({ version: 1, name: "J", provider: "openai-chat", tests: [{ name: "a", turns: [{ user: "hi" }] }] }, null, 2)}\n`;
    const next = editText(json, "j.hafen.json", [{ op: "add", path: ["tests"], value: { name: "b", turns: [{ user: "yo" }] } }]);
    const data = JSON.parse(next);
    assert.deepEqual(Object.keys(data), ["version", "name", "provider", "tests"]);
    assert.equal(data.tests[1].name, "b");
  });

  it("writes a new suite", () => {
    const text = newSuiteText({ name: "New", provider: "providers/p.yml", tests: [{ name: "t", turns: [{ user: "hi" }] }] });
    assert.match(text, /^version: 1\nname: New\nprovider: providers\/p.yml\n/);
  });
});
