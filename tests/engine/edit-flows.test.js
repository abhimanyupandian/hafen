// Every edit the app makes to a suite (app/js: editSuite calls), on suites written every way people
// write them: block style, flow style, mixed, with comments, JSON. Each edit must give exactly the
// data the edit means (the file parsed again), keep every comment that isn't in what was deleted,
// and leave the rest of the file as it was.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { editText } from "../../engine/files/suite-file.js";

const BLOCK = `# checkout suite
version: 1
name: Smoke   # shown in reports
provider: providers/mock-json.yml

tests:
  # the first test
  - name: refund for a broken item
    id: t_one
    tags: [smoke]
    turns:
      - user: "Hi, I want a refund"
        extract:
          session: $.session_id
        expect:
          - { type: status, equals: 200 }
          - { path: $.data.reply, contains: "4417" }   # the order
          - type: latency
            max_ms: 5000
      - user: It arrived broken
        expect:
          - { contains: refund }
  - name: second
    id: t_two
    turns:
      - user: Hello
  # the last test
  - name: third
    id: t_three
    provider: providers/other.yml
    turns:
      - user: one
      - user: two
`;

const FLOW = `version: 1
provider: providers/p.yml
tests:
  - { name: a, id: t_a, turns: [ { user: hi, expect: [ { contains: x } ] } ] }
  - name: b
    turns: [ { user: one }, { user: two, expect: [] } ]
`;

const EMPTY_TESTS = `version: 1
provider: providers/p.yml   # the provider
tests: []
`;

const NO_TESTS = `version: 1
provider: providers/p.yml
`;

const JSON_SUITE = `${JSON.stringify({ version: 1, provider: "providers/p.yml", tests: [{ name: "a", turns: [{ user: "hi" }] }, { name: "b", turns: [{ user: "x", expect: [{ contains: "y" }] }] }] }, null, 2)}\n`;

// The edit applied to the data itself: what the file must mean afterwards
function apply(data, { op, path, value }) {
  const out = structuredClone(data);
  const parent = path.slice(0, -1).reduce((o, k) => (o[k] ??= typeof k === "number" ? [] : {}), out);
  const key = path.at(-1);
  if (op === "delete") Array.isArray(parent) ? parent.splice(key, 1) : delete parent[key];
  else if (op === "add") (parent[key] ??= []).push(structuredClone(value));
  else parent[key] = structuredClone(value);
  return out;
}

const comments = (text) => text.split("\n").map((l) => l.match(/#\s.*$/)?.[0]).filter(Boolean);
const NEW_TEST = { id: "t_new", name: "New test", turns: [{ user: "Hello" }] };
const AWKWARD = ["hi: there", "#1 order", "multi\nline", "123", "true", "", "  spaced  ", "quote \" and ' both", "{ not: a map }", "- not a list"];

// What the app does, with the paths it uses (and the data they need)
function editsFor(data) {
  const out = [];
  const tests = data.tests ?? [];
  out.push(["new test (+)", { op: "add", path: ["tests"], value: NEW_TEST }]);
  out.push(["suite name", { op: "set", path: ["name"], value: "Checkout flows" }]);
  out.push(["suite name removed", { op: "delete", path: ["name"] }]);
  out.push(["suite provider", { op: "set", path: ["provider"], value: "providers/ollama.yml" }]);
  tests.forEach((test, t) => {
    out.push([`delete test ${t}`, { op: "delete", path: ["tests", t] }]);
    out.push([`test ${t} name`, { op: "set", path: ["tests", t, "name"], value: "renamed test" }]);
    for (const v of AWKWARD) out.push([`test ${t} name ${JSON.stringify(v)}`, { op: "set", path: ["tests", t, "name"], value: v }]);
    out.push([`test ${t} repeat`, { op: "set", path: ["tests", t, "repeat"], value: 3 }]);
    out.push([`test ${t} pass rate`, { op: "set", path: ["tests", t, "pass_rate"], value: 0.67 }]);
    out.push([`test ${t} history`, { op: "set", path: ["tests", t, "history"], value: "pinned" }]);
    out.push([`test ${t} tags`, { op: "set", path: ["tests", t, "tags"], value: ["smoke", "refunds"] }]);
    out.push([`test ${t} tags removed`, { op: "delete", path: ["tests", t, "tags"] }]);
    out.push([`test ${t} provider`, { op: "set", path: ["tests", t, "provider"], value: "providers/x.yml" }]);
    out.push([`test ${t} provider removed`, { op: "delete", path: ["tests", t, "provider"] }]);
    out.push([`test ${t} data`, { op: "set", path: ["tests", t, "data"], value: "data/rows.csv" }]);
    const turns = test.turns ?? [];
    out.push([`test ${t} add turn`, turns.length ? { op: "add", path: ["tests", t, "turns"], value: { user: "next: one" } } : { op: "set", path: ["tests", t, "turns"], value: [{ user: "next" }] }]);
    turns.forEach((turn, i) => {
      out.push([`delete turn ${t}.${i}`, { op: "delete", path: ["tests", t, "turns", i] }]);
      for (const v of AWKWARD) out.push([`turn ${t}.${i} message ${JSON.stringify(v)}`, { op: "set", path: ["tests", t, "turns", i, "user"], value: v }]);
      out.push([`turn ${t}.${i} fixed reply`, { op: "set", path: ["tests", t, "turns", i, "reply"], value: "a fixed reply" }]);
      out.push([`turn ${t}.${i} extract`, { op: "set", path: ["tests", t, "turns", i, "extract"], value: { session: "$.id", order: "$.order.id" } }]);
      out.push([`turn ${t}.${i} extract removed`, { op: "delete", path: ["tests", t, "turns", i, "extract"] }]);
      const expect = turn.expect ?? [];
      const check = { path: "$.data.order.id", equals: 4417 };
      out.push([`turn ${t}.${i} add check`, expect.length ? { op: "add", path: ["tests", t, "turns", i, "expect"], value: check } : { op: "set", path: ["tests", t, "turns", i, "expect"], value: [check] }]);
      expect.forEach((_, j) => {
        out.push([`delete check ${t}.${i}.${j}`, { op: "delete", path: ["tests", t, "turns", i, "expect", j] }]);
        out.push([`replace check ${t}.${i}.${j}`, { op: "set", path: ["tests", t, "turns", i, "expect", j], value: { type: "latency", max_ms: 2000, first_token_ms: 500 } }]);
      });
    });
  });
  return out;
}

describe("every edit the app makes, on every way a suite is written", () => {
  for (const [label, text, file] of [["block", BLOCK, "a.hafen.yml"], ["flow", FLOW, "a.hafen.yml"], ["empty tests", EMPTY_TESTS, "a.hafen.yml"], ["no tests", NO_TESTS, "a.hafen.yml"], ["JSON", JSON_SUITE, "a.hafen.json"]]) {
    it(`${label}: the file means what the edit says, and keeps its comments`, () => {
      const data = file.endsWith(".json") ? JSON.parse(text) : parse(text);
      const edits = editsFor(data);
      assert.ok(edits.length > 3);
      for (const [name, edit] of edits) {
        const next = editText(text, file, [edit]);
        const got = file.endsWith(".json") ? JSON.parse(next) : parse(next);
        assert.deepEqual(got, apply(data, edit), `${label} · ${name}`);
        if (edit.op !== "delete" && !file.endsWith(".json")) {
          for (const c of comments(text)) assert.ok(next.includes(c), `${label} · ${name}: lost the comment ${c}`);
        }
      }
    });
  }

  it("a series of edits, as a session makes them, ends where the data says", () => {
    let text = BLOCK;
    let data = parse(BLOCK);
    const steps = [
      { op: "add", path: ["tests"], value: NEW_TEST },
      { op: "set", path: ["tests", 3, "name"], value: "placing an order" },
      { op: "add", path: ["tests", 3, "turns"], value: { user: "what is my name?" } },
      { op: "set", path: ["tests", 3, "turns", 0, "expect"], value: [{ contains: "hello" }] },
      { op: "add", path: ["tests", 3, "turns", 0, "expect"], value: { type: "status", equals: 200 } },
      { op: "delete", path: ["tests", 1] },
      { op: "set", path: ["tests", 2, "turns", 1, "user"], value: "my name is ronaldo" },
      { op: "delete", path: ["tests", 0, "turns", 0, "expect", 1] },
      { op: "delete", path: ["tests", 2, "turns", 0, "expect", 0] },
      { op: "delete", path: ["tests", 2, "turns", 0, "expect", 0] },
      { op: "set", path: ["tests", 0, "repeat"], value: 2 },
      { op: "delete", path: ["tests", 0] },
      { op: "delete", path: ["tests", 0] },
      { op: "delete", path: ["tests", 0] },
    ];
    for (const step of steps) {
      text = editText(text, "a.hafen.yml", [step]);
      data = apply(data, step);
      assert.deepEqual(parse(text), data, JSON.stringify(step));
    }
    assert.deepEqual(parse(text).tests, []);
    assert.ok(text.startsWith("# checkout suite\n"));
    assert.ok(text.includes("name: Smoke   # shown in reports"));
  });

  it("comments: a deleted item's own comment lines go with it; a replaced check keeps the comment after it", () => {
    const deleted = editText(BLOCK, "a.hafen.yml", [{ op: "delete", path: ["tests", 2] }]);
    assert.ok(!deleted.includes("# the last test"));
    assert.ok(deleted.includes("# the first test") && deleted.includes("# the order"));
    const replaced = editText(BLOCK, "a.hafen.yml", [{ op: "set", path: ["tests", 0, "turns", 0, "expect", 1], value: { path: "$.data.reply", contains: "4418" } }]);
    assert.ok(replaced.includes('- { path: $.data.reply, contains: "4418" }   # the order') || replaced.includes("- { path: $.data.reply, contains: \"4418\" }   # the order") || /contains: "?4418"? }\s+# the order/.test(replaced), replaced);
    const block = editText(BLOCK, "a.hafen.yml", [{ op: "set", path: ["tests", 0, "turns", 0, "expect", 2], value: { type: "latency", max_ms: 2000 } }]);
    assert.ok(block.includes("          - type: latency\n            max_ms: 2000\n      - user: It arrived broken"), block);
    // Only the lines of the edit change
    const diff = (a, b) => a.split("\n").filter((l, i) => b.split("\n")[i] !== l).length;
    assert.equal(diff(BLOCK, replaced), 1);
  });

  it("an edit it can't make says so, and never writes something else", () => {
    assert.throws(() => editText("version: 1\ntests: [\n", "a.hafen.yml", [{ op: "set", path: ["name"], value: "x" }]), /can't edit/);
  });
});
