// Editing suites in place (engine/files/edit.js): every edit the app makes, on suites written every
// way, changes only what it means to, keeping comments, line endings and a byte order mark.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { editText } from "../../engine/files/edit.js";
import { newSuiteText } from "../../engine/files/suite-file.js";

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

describe("edits in place", () => {
  const changed = (a, b) => { const x = a.split("\n"); return b.split("\n").filter((l, i) => l !== x[i]); };

  it("a list emptied ([], as the last test's delete leaves it) that gets a test again is written as a block", () => {
    let text = "version: 1\nprovider: p.yml\ntests: []\n";
    text = editText(text, "s.hafen.yml", [{ op: "set", path: ["tests"], value: [{ id: "t_1", name: "New test", turns: [{ user: "Hello" }] }] }]);
    text = editText(text, "s.hafen.yml", [{ op: "add", path: ["tests"], value: { id: "t_2", name: "Second", turns: [{ user: "Hi" }] } }]);
    text = editText(text, "s.hafen.yml", [{ op: "add", path: ["tests", 0, "turns"], value: { user: "next" } }]);
    assert.equal(text, "version: 1\nprovider: p.yml\ntests:\n  - id: t_1\n    name: New test\n    turns:\n      - user: Hello\n      - user: next\n  - id: t_2\n    name: Second\n    turns:\n      - user: Hi\n");
    // From `tests: []` and an add, the same
    const added = editText("version: 1\ntests: []   \n", "s.hafen.yml", [{ op: "add", path: ["tests"], value: { name: "a", turns: [{ user: "hi" }] } }]);
    assert.deepEqual(parse(added).tests, [{ name: "a", turns: [{ user: "hi" }] }]);
    assert.ok(!added.includes("[ {"), added);
  });

  it("a key with no value gets one on its line; a message of several lines goes as a block, its comment kept", () => {
    const text = "version: 1   # v\nname:\ntests:\n  - name: a\n    turns:\n      - user: hi   # greet\n      - user:\n";
    assert.deepEqual(changed(text, editText(text, "s.hafen.yml", [{ op: "set", path: ["name"], value: "Smoke" }])), ["name: Smoke"]);
    assert.deepEqual(changed(text, editText(text, "s.hafen.yml", [{ op: "set", path: ["tests", 0, "turns", 1, "user"], value: "x" }])), ["      - user: x"]);
    const multi = editText(text, "s.hafen.yml", [{ op: "set", path: ["tests", 0, "turns", 0, "user"], value: "line one\nline two" }]);
    assert.ok(multi.startsWith("version: 1   # v\nname:\n"), multi);
    assert.ok(multi.includes("      - user: |-   # greet\n          line one\n          line two\n"), multi);
    assert.equal(parse(multi).tests[0].turns[0].user, "line one\nline two");
  });

  it("a # in a one-line check's string isn't a comment: the check is still edited on its line", () => {
    const text = "tests:\n  - name: a\n    tags: [smoke]\n    turns:\n      - user: hi\n        expect:\n          - { contains: \"order #4417\" }\n";
    const out = editText(text, "s.hafen.yml", [{ op: "set", path: ["tests", 0, "turns", 0, "expect", 0, "enabled"], value: false }]);
    assert.deepEqual(changed(text, out), ["          - { contains: \"order #4417\", enabled: false }"]);
  });

  it("keeps Windows line endings, and a JSON file's byte order mark", () => {
    const crlf = "version: 1\r\ntests:\r\n  - name: a   # x\r\n    turns:\r\n      - user: hi\r\n";
    const out = editText(crlf, "s.hafen.yml", [{ op: "add", path: ["tests", 0, "turns"], value: { user: "two" } }, { op: "set", path: ["tests", 0, "name"], value: "b" }]);
    assert.equal(out, "version: 1\r\ntests:\r\n  - name: b   # x\r\n    turns:\r\n      - user: hi\r\n      - user: two\r\n");
    const bom = "﻿{\n  \"version\": 1,\n  \"tests\": []\n}\n";
    const json = editText(bom, "s.hafen.json", [{ op: "set", path: ["name"], value: "x" }]);
    assert.ok(json.startsWith("﻿{"));
    assert.equal(JSON.parse(json.slice(1)).name, "x");
  });
});

describe("editing inside a { flow } or [flow] collection: only its line changes", () => {
  const TEXT = `version: 1
environments:
  local: { base_url: "http://x" }
tests:
  - name: a
    tags: [smoke]
    turns:
      - user: hi
        expect:
          - { type: status, equals: 200 }   # the status
          - { path: $.data.reply, contains: "4417" }
          - path: $.x   # x
            equals: 1
`;
  const P = ["tests", 0, "turns", 0, "expect"];
  const changed = (a, b) => { const x = a.split("\n"); const y = b.split("\n"); return y.filter((l, i) => l !== x[i]); };

  it("turns a check written on one line off and on again: that line, its comment kept; then the file as it was", async () => {
    const { editText } = await import("../../engine/files/edit.js");
    for (const [j, line] of [[0, "          - { type: status, equals: 200, enabled: false }   # the status"], [1, '          - { path: $.data.reply, contains: "4417", enabled: false }']]) {
      const off = editText(TEXT, "s.hafen.yml", [{ op: "set", path: [...P, j, "enabled"], value: false }]);
      assert.deepEqual(changed(TEXT, off), [line]);
      assert.equal(off.split("\n").length, TEXT.split("\n").length);
      assert.equal(editText(off, "s.hafen.yml", [{ op: "delete", path: [...P, j, "enabled"] }]), TEXT);
    }
  });

  it("turns a check written over lines off and on: one line added, then taken away (its comment kept)", async () => {
    const { editText } = await import("../../engine/files/edit.js");
    const off = editText(TEXT, "s.hafen.yml", [{ op: "set", path: [...P, 2, "enabled"], value: false }]);
    assert.equal(off, TEXT.replace("            equals: 1\n", "            equals: 1\n            enabled: false\n"));
    assert.equal(editText(off, "s.hafen.yml", [{ op: "delete", path: [...P, 2, "enabled"] }]), TEXT);
  });

  it("leaves a flow list written over several lines (or with a comment in it) to the library: its comments kept", async () => {
    const { editText } = await import("../../engine/files/edit.js");
    const text = "tests:\n  - name: a\n    turns:\n      - user: hi\n        expect: [\n          { type: status, equals: 200 },   # the status\n          { contains: x }\n        ]\n";
    const out = editText(text, "s.hafen.yml", [{ op: "set", path: ["tests", 0, "turns", 0, "expect", 1, "enabled"], value: false }]);
    assert.ok(out.includes("# the status"), out);
    const { parse } = await import("yaml");
    assert.deepEqual(parse(out).tests[0].turns[0].expect, [{ type: "status", equals: 200 }, { contains: "x", enabled: false }]);
    // One line with a comment after it is the line's, not the list's: still edited in place
    const one = "tests:\n  - name: a\n    tags: [smoke]   # why\n";
    assert.equal(editText(one, "s.hafen.yml", [{ op: "add", path: ["tests", 0, "tags"], value: "b" }]), "tests:\n  - name: a\n    tags: [ smoke, b ]   # why\n");
  });

  it("adds to a [flow] list, and sets a key of a { flow } map, on their own lines", async () => {
    const { editText } = await import("../../engine/files/edit.js");
    const tagged = editText(TEXT, "s.hafen.yml", [{ op: "add", path: ["tests", 0, "tags"], value: "refunds" }]);
    assert.deepEqual(changed(TEXT, tagged), ["    tags: [ smoke, refunds ]"]);
    const based = editText(TEXT, "s.hafen.yml", [{ op: "set", path: ["environments", "local", "base_url"], value: "http://y" }]);
    assert.deepEqual(changed(TEXT, based), ["  local: { base_url: http://y }"]);
  });
});

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
