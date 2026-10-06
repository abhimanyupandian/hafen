// Suite and provider files (contracts/test-file.md): loading, problems with their line and column,
// variables checked before anything is sent, and editing in place without losing comments.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseData } from "../../engine/files/data.js";
import { editText, loadSuite, newSuiteText } from "../../engine/files/suite-file.js";
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

  it("warns about unknown keys, and keeps them", async () => {
    const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider: openai-chat\nowner: qa\ntests:\n  - name: a\n    turns:\n      - user: hi\n" });
    const suite = await loadSuite(host, "s.hafen.yml");
    assert.deepEqual(suite.errors, []);
    assert.match(suite.warnings[0].message, /unknown key "owner"/);
    assert.equal(suite.data.owner, "qa");
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
