// A check turned off (enabled: false) is skipped and not counted, in turns, conversations and setup
// steps; the schema takes `enabled`. And the rename to Hafen: run files of the old kind are still read
// (as Hafen runs). (The desktop app's old data folder, carried over once, is the app's: tests/app/ in
// Hafen's repository.)

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { parseRun, RUN_FILE, runFileName } from "../../engine/reports/run-file.js";
import { LEGACY_RUN_KIND, RUN_KIND } from "../../engine/run-kind.js";
import { runSuites } from "../../engine/runner.js";
import { memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
after(() => mock.close());
beforeEach(() => mock.reset());

const JSON_PROVIDER = `kind: http
url: "{{base_url}}/json"
body: { message: "{{user}}" }
response:
  text: $.data.reply
`;

async function runYaml(suiteYaml) {
  const host = memoryHost({ "s.hafen.yml": suiteYaml, "providers/json.yml": JSON_PROVIDER });
  const suite = await loadSuite(host, "s.hafen.yml");
  assert.deepEqual(suite.errors, [], JSON.stringify(suite.errors));
  return runSuites({ suites: [suite], host, options: { vars: { base_url: mock.url } } });
}

describe("a check turned off", () => {
  it("is skipped (saying so), doesn't fail its turn or test, and isn't counted", async () => {
    const run = await runYaml(`version: 1
provider: providers/json.yml
tests:
  - name: one
    turns:
      - user: I want a refund
        expect:
          - { type: status, equals: 200 }
          - { contains: "never in the reply", enabled: false }
          - { contains: "{{nowhere}}", enabled: false }
          - { type: judge, rubric: "asks why", enabled: false }
`);
    const results = run.turns[0].results;
    assert.deepEqual(results.map((r) => r.status), ["pass", "skipped", "skipped", "skipped"]);
    // Not looked at: its variable isn't resolved (no error), and the judge it would need isn't asked for
    for (const r of results.slice(1)) assert.equal(r.reason, "turned off (enabled: false)");
    assert.equal(run.verdict, "passed");
    assert.equal(run.tests[0].status, "passed");
    assert.equal(run.turns[0].metrics.accuracy, 1);
    assert.equal(run.turns[0].metrics.checks.skipped, 3);
    // Its span says it was skipped
    const spans = run.spans.filter((s) => s.kind === "check");
    assert.deepEqual(spans.map((s) => s.status), ["pass", "skipped", "skipped", "skipped"]);
  });

  it("on, the same check fails: turning it off is all that changed", async () => {
    const run = await runYaml(`version: 1
provider: providers/json.yml
tests:
  - name: one
    turns:
      - user: I want a refund
        expect:
          - { contains: "never in the reply" }
`);
    assert.equal(run.turns[0].results[0].status, "fail");
    assert.equal(run.verdict, "failed");
  });

  it("is skipped in a test's conversation checks and in a setup step (whose status then decides)", async () => {
    const run = await runYaml(`version: 1
provider: providers/json.yml
tests:
  - name: one
    setup:
      - request: { url: "{{base_url}}/json", method: POST, body: { message: "hi" } }
        expect:
          - { type: status, equals: 500, enabled: false }
    turns:
      - user: hello
    expect_conversation:
      - { on: conversation, contains: "nowhere", enabled: false }
`);
    assert.equal(run.tests[0].status, "passed", JSON.stringify(run.tests[0]));
    const conversation = run.tests[0].instances[0].results;
    assert.deepEqual(conversation.map((r) => r.status), ["skipped"]);
  });

  it("is in the schema: enabled is true or false", async () => {
    const suite = (enabled) => `version: 1\nprovider: providers/json.yml\ntests:\n  - name: a\n    turns:\n      - user: hi\n        expect:\n          - { contains: x, enabled: ${enabled} }\n`;
    const ok = await loadSuite(memoryHost({ "s.hafen.yml": suite("false"), "providers/json.yml": JSON_PROVIDER }), "s.hafen.yml");
    assert.deepEqual(ok.errors, []);
    const bad = await loadSuite(memoryHost({ "s.hafen.yml": suite('"no"'), "providers/json.yml": JSON_PROVIDER }), "s.hafen.yml");
    assert.ok(bad.errors.some((e) => /enabled|boolean/.test(e.message)), JSON.stringify(bad.errors));
  });

  it("can't stop a run: its unknown variable, its environment's value, its secret, an old way and its missing judge aren't asked for", async () => {
    const host = memoryHost({ "s.hafen.yml": `version: 1
provider: providers/json.yml
tests:
  - name: a
    turns:
      - user: hi
        expect:
          - { contains: "{{nowhere}}", enabled: false }
          - { contains: "{{env.missing}}", enabled: false }
          - { contains: "{{secret.NEVER_SET}}", enabled: false }
          - { contains: "{{scope.old}} \${env:OLD}", enabled: false }
          - { type: judge, judge: nobody, rubric: x, enabled: false }
          - { path: "$[", exists: true, enabled: false }
`, "providers/json.yml": JSON_PROVIDER });
    const suite = await loadSuite(host, "s.hafen.yml");
    assert.deepEqual(suite.errors, []);
    assert.deepEqual(suite.missing.filter((m) => m.variable !== "base_url"), []);
    const { envNeeded, problemsFor, secretsNeeded } = await import("../../engine/files/suite-file.js");
    assert.deepEqual(envNeeded(suite), []);
    assert.equal(secretsNeeded(suite).includes("NEVER_SET"), false);
    assert.deepEqual(problemsFor(suite, { base_url: "x" }, () => undefined, { name: "stage", values: {} }), []);
    // On, the same checks are problems
    const on = await loadSuite(memoryHost({ "s.hafen.yml": `version: 1
provider: providers/json.yml
tests:
  - name: a
    turns:
      - user: hi
        expect:
          - { contains: "{{nowhere}}" }
          - { type: judge, judge: nobody, rubric: x }
`, "providers/json.yml": JSON_PROVIDER }), "s.hafen.yml");
    assert.ok(on.errors.some((e) => /no judge named "nobody"/.test(e.message)));
    assert.ok(on.missing.some((m) => m.variable === "nowhere"));
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
    const { editText } = await import("../../engine/files/suite-file.js");
    for (const [j, line] of [[0, "          - { type: status, equals: 200, enabled: false }   # the status"], [1, '          - { path: $.data.reply, contains: "4417", enabled: false }']]) {
      const off = editText(TEXT, "s.hafen.yml", [{ op: "set", path: [...P, j, "enabled"], value: false }]);
      assert.deepEqual(changed(TEXT, off), [line]);
      assert.equal(off.split("\n").length, TEXT.split("\n").length);
      assert.equal(editText(off, "s.hafen.yml", [{ op: "delete", path: [...P, j, "enabled"] }]), TEXT);
    }
  });

  it("turns a check written over lines off and on: one line added, then taken away (its comment kept)", async () => {
    const { editText } = await import("../../engine/files/suite-file.js");
    const off = editText(TEXT, "s.hafen.yml", [{ op: "set", path: [...P, 2, "enabled"], value: false }]);
    assert.equal(off, TEXT.replace("            equals: 1\n", "            equals: 1\n            enabled: false\n"));
    assert.equal(editText(off, "s.hafen.yml", [{ op: "delete", path: [...P, 2, "enabled"] }]), TEXT);
  });

  it("leaves a flow list written over several lines (or with a comment in it) to the library: its comments kept", async () => {
    const { editText } = await import("../../engine/files/suite-file.js");
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
    const { editText } = await import("../../engine/files/suite-file.js");
    const tagged = editText(TEXT, "s.hafen.yml", [{ op: "add", path: ["tests", 0, "tags"], value: "refunds" }]);
    assert.deepEqual(changed(TEXT, tagged), ["    tags: [ smoke, refunds ]"]);
    const based = editText(TEXT, "s.hafen.yml", [{ op: "set", path: ["environments", "local", "base_url"], value: "http://y" }]);
    assert.deepEqual(changed(TEXT, based), ["  local: { base_url: http://y }"]);
  });
});

describe("the rename to Hafen", () => {
  it("writes Hafen runs (*.hafen-run.json), and reads ones from before it as Hafen runs", () => {
    assert.equal(RUN_KIND, "hafen-run");
    assert.equal(runFileName({ _id: "abc" }), "abc.hafen-run.json");
    assert.ok(RUN_FILE.test("abc.hafen-run.json"));
    assert.ok(RUN_FILE.test("abc.hafen-eval-run.json"));
    const old = parseRun(JSON.stringify({ kind: LEGACY_RUN_KIND, version: 1, _id: "x", tests: [] }));
    assert.equal(old.kind, "hafen-run");
    assert.equal(parseRun(JSON.stringify({ kind: "hafen-run", version: 1, _id: "y" })).kind, "hafen-run");
    assert.throws(() => parseRun(JSON.stringify({ kind: "something-else", version: 1 })), /not a Hafen run file/);
    assert.throws(() => parseRun(JSON.stringify({ kind: "hafen-run", version: 99 })), /newer Hafen/);
  });
});
