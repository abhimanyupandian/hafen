// Running suites: turns in order, extractions, groups, on_fail, repeats and data rows, setup and
// teardown, a run's variables, a provider's timeout and retries, stopping (--max-cost), and metrics.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { parse } from "yaml";
import { loadSuite } from "../../engine/files/suite-file.js";
import { createProvider } from "../../engine/providers/index.js";
import { jsonSummary } from "../../engine/reports/json.js";
import { junit } from "../../engine/reports/junit.js";
import { markdown } from "../../engine/reports/markdown.js";
import { runSuites } from "../../engine/runner.js";
import { createSpans } from "../../engine/spans.js";
import { executeTurn, metricsOf } from "../../engine/turn.js";
import { createScope } from "../../engine/vars.js";
import { fakeTransport, memoryHost, MOCK_SSE_PROVIDER, sseChunks, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
beforeEach(() => mock.reset());
after(() => mock.close());

const JSON_PROVIDER = `kind: http
url: "{{base_url}}/json"
body: { message: "{{user}}" }
response:
  text: $.data.reply
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
price: { input: 1, output: 2 }
`;

async function runYaml(suiteYaml, { files = {}, options = {}, secrets = { JEV_API_KEY: "jev-secret-key-1" }, events } = {}) {
  const host = memoryHost({ "s.hafen.yml": suiteYaml, "providers/json.yml": JSON_PROVIDER, "providers/sse.yml": MOCK_SSE_PROVIDER, ...files }, { secrets });
  const suite = await loadSuite(host, "s.hafen.yml");
  assert.deepEqual(suite.errors, [], JSON.stringify(suite.errors));
  assert.deepEqual(suite.missing.filter((m) => m.variable !== "base_url"), []);
  return runSuites({ suites: [suite], host, options: { vars: { base_url: mock.url }, ...options }, onEvent: events ? (e) => events.push(e) : undefined });
}

const statuses = (run) => run.turns.map((t) => (t.results ?? []).map((r) => r.status));

describe("runner", () => {
  it("runs turns in order, with extractions reaching later turns", async () => {
    const run = await runYaml(`version: 1
provider: providers/json.yml
tests:
  - name: two turns
    turns:
      - user: I want a refund
        extract: { order: $.data.order.id }
        expect:
          - { type: status, equals: 200 }
          - { path: $.data.order.id, equals: 4417 }
      - user: "order {{order}} please"
        expect:
          - { contains: "order 4417" }
`);
    assert.equal(run.status, "done");
    assert.equal(run.verdict, "passed");
    assert.deepEqual(statuses(run), [["pass", "pass"], ["pass"]]);
    assert.equal(run.turns[1].user, "order 4417 please");
    assert.equal(run.turns[0].variables.order, 4417);
    assert.equal(mock.log.length, 2);
    assert.ok(run.summary.cost > 0);
    assert.equal(run.summary.latency.total.n, 2);
  });

  it("untilTurn: each test runs up to that turn (its history first), and no further", async () => {
    const run = await runYaml(`version: 1
provider: providers/json.yml
tests:
  - name: three turns
    turns:
      - user: first
        expect: [ { type: status, equals: 200 } ]
      - user: second
        expect: [ { contains: "second" } ]
      - user: third
    expect_conversation:
      - { type: latency, max_ms: 60000 }
`, { options: { untilTurn: 1 } });
    assert.deepEqual(run.turns.map((t) => [t.index, t.user, t.user_template]), [[0, "first", "first"], [1, "second", "second"]]);
    assert.equal(run.settings.until_turn, 1);
    assert.equal(run.tests[0].until_turn, 1);
    assert.equal(run.tests[0].instances[0].conversation_results, undefined);
    assert.equal(mock.log.length, 2);
    assert.equal(mock.log[1].body.message, "second");
    // Without it, every turn runs
    mock.reset();
    const full = await runYaml(`version: 1
provider: providers/json.yml
tests:
  - name: three turns
    turns: [ { user: first }, { user: second }, { user: third } ]
`);
    assert.equal(full.turns.length, 3);
    assert.equal(full.settings.until_turn, null);
    assert.equal(full.tests[0].until_turn, undefined);
  });

  it("onlyTurn: earlier turns are carried (their last records, or fixed replies) as history, and only that turn is sent", async () => {
    const yaml = `version: 1
provider: providers/json.yml
tests:
  - name: three
    id: t_three000
    turns:
      - user: first
        extract: { first_reply: $.data.reply }
      - user: "second, after {{first_reply}}"
        reply: a fixed second reply
      - user: third
        expect: [ { contains: "third" } ]
`;
    // A full run first: its records are what's carried
    const full = await runYaml(yaml);
    assert.equal(full.turns.length, 3);
    mock.reset();
    const carry = { t_three000: [full.turns[0]] };  // turn 1's record; turn 2 has a fixed reply
    const only = await runYaml(yaml, { options: { onlyTurn: 2, carry } });
    assert.equal(mock.log.length, 1, "only turn 3 is sent");
    assert.equal(mock.log[0].body.message, "third");
    assert.deepEqual(only.turns.map((t) => [t.index, t.carried ?? "sent"]), [[0, "last run"], [1, "fixed reply"], [2, "sent"]]);
    assert.equal(only.turns[1].user, `second, after ${full.turns[0].reply}`, "turn 1's extraction reaches turn 2");
    assert.equal(only.turns[1].reply, "a fixed second reply");
    assert.equal(only.settings.only_turn, 2);
    assert.equal(only.tests[0].only_turn, 2);
    assert.equal(only.tests[0].status, "passed");
    // A turn with nothing to carry is sent
    mock.reset();
    const none = await runYaml(yaml, { options: { onlyTurn: 2 } });
    assert.deepEqual(none.turns.map((t) => t.carried ?? "sent"), ["sent", "fixed reply", "sent"]);
    assert.equal(mock.log.length, 2);
  });

  it("\"this turn only\" counts only the turn it sent: not the turns carried from the last run", async () => {
    const yaml = "version: 1\nprovider: providers/json.yml\ntests:\n  - name: three\n    id: t_three000\n    turns:\n      - user: first\n        expect: [ { contains: nope } ]\n      - user: second\n        expect: [ { contains: nope } ]\n      - user: third\n        expect: [ { contains: third } ]\n";
    const host = memoryHost({ "s.hafen.yml": yaml, "providers/json.yml": JSON_PROVIDER });
    const suite = await loadSuite(host, "s.hafen.yml");
    const full = await runSuites({ suites: [suite], host, options: { vars: { base_url: mock.url } } });
    assert.equal(full.summary.turns, 3);
    mock.reset();
    const only = await runSuites({ suites: [suite], host, options: { vars: { base_url: mock.url }, onlyTurn: 2, carry: { t_three000: [full.turns[0], full.turns[1]] } } });
    assert.equal(mock.log.length, 1);
    assert.equal(only.summary.turns, 1);
    assert.deepEqual([only.summary.checks.total, only.summary.checks.failed], [1, 0]);
    assert.equal(only.summary.latency.total.n, 1);
    assert.equal((junit(only).match(/<failure/g) ?? []).length, 0);
  });

  it("tests in different groups run at once: each turn's record, spans and history stay its own test's", async () => {
    const tests = (grouped) => Array.from({ length: 6 }, (_, k) => `  - name: test ${k}
    id: t_test000${k}${grouped ? `\n    group: ${k + 1}` : ""}
    turns:
      - user: "t${k} one"
        expect: [ { contains: "t${k} one" } ]
      - user: "t${k} two"
        expect: [ { contains: "t${k} two" } ]
      - user: "t${k} three"
        expect: [ { contains: "t${k} three" } ]`).join("\n");
    const yaml = (grouped) => `version: 1\nprovider: providers/json.yml\ntests:\n${tests(grouped)}\n`;
    const events = [];
    const run = await runYaml(yaml(true), { events });
    assert.equal(run.status, "done");
    assert.equal(run.verdict, "passed");
    assert.equal(run.turns.length, 18);
    assert.ok(run.turns.every(Boolean));
    // Each record is in its own place, of its own test, in order within it
    for (const [g, t] of run.turns.entries()) {
      assert.equal(t.user, `t${t.test.slice(-1)} ${["one", "two", "three"][t.index]}`, `turn ${g}`);
      assert.ok(t.results.every((r) => r.status === "pass"), `turn ${g}'s checks`);
      const span = run.spans.find((s) => s.kind === "turn" && s.ref?.turn === g);
      const testSpan = run.spans.find((s) => s.kind === "test" && s.ref?.test === t.test);
      let p = span;
      while (p && p.kind !== "test") p = run.spans.find((s) => s._id === p.parent);
      assert.equal(p?._id, testSpan._id, `turn ${g}'s span is under its test`);
    }
    for (const result of run.tests) {
      const turns = result.instances[0].turns.map((g) => run.turns[g]);
      assert.deepEqual(turns.map((t) => [t.test, t.index]), [[result.id, 0], [result.id, 1], [result.id, 2]]);
    }
    // Each test's later turns were sent with its own earlier ones (the mock's replies name them)
    const byTest = new Map();
    for (const r of mock.log) byTest.set(r.body.message.split(" ")[0], (byTest.get(r.body.message.split(" ")[0]) ?? 0) + 1);
    assert.deepEqual([...byTest.values()], Array(6).fill(3));
    // turn:start / turn:end events agree on each turn's place
    const starts = events.filter((e) => e.type === "turn:start").map((e) => e.index).sort((a, b) => a - b);
    assert.deepEqual(starts, [...Array(18).keys()]);
    // The tests overlapped in time; with no groups (one group) they go one after another, in order
    const overlaps = (r) => {
      const t = r.spans.filter((x) => x.kind === "test");
      return t.some((a2, i) => t.some((b, j) => i !== j && a2.start < b.end && b.start < a2.end));
    };
    assert.ok(overlaps(run), "tests in different groups ran at once");
    const one = await runYaml(yaml(false));
    assert.equal(one.verdict, "passed");
    assert.ok(!overlaps(one), "no groups: one group, no two overlap");
    assert.deepEqual(one.tests.map((t) => t.name), [0, 1, 2, 3, 4, 5].map((k) => `test ${k}`));
  });

  it("groups: the same group one after another, in order; different groups at once; none is one group of its own", async () => {
    const yaml = `version: 1
provider: providers/json.yml
tests:
  - { name: a, group: 1, turns: [ { user: a } ] }
  - { name: b, group: 2, turns: [ { user: b } ] }
  - { name: c, group: 1, turns: [ { user: c } ] }
  - { name: d, turns: [ { user: d } ] }
  - { name: e, group: 2, turns: [ { user: e } ] }
  - { name: f, turns: [ { user: f } ] }
`;
    // (each reply takes 120 ms, so what runs at once overlaps)
    const run = await runYaml(yaml, { options: { vars: { base_url: `${mock.url}/slow?ms=120&x=` } } });
    assert.equal(run.verdict, "passed", JSON.stringify(run.error));
    const span = (name) => run.spans.find((x) => x.kind === "test" && x.name === name);
    const before = (x, y) => span(x).end <= span(y).start;
    const overlap = (x, y) => span(x).start < span(y).end && span(y).start < span(x).end;
    // Within a group: in the file's order, one after another
    assert.ok(before("a", "c"), "group 1: a, then c");
    assert.ok(before("b", "e"), "group 2: b, then e");
    assert.ok(before("d", "f"), "no group: d, then f");
    // Across groups: at once
    assert.ok(overlap("a", "b") && overlap("a", "d") && overlap("b", "d"), "the groups' first tests ran at once");
    assert.ok(overlap("c", "e") && overlap("c", "f"));
  });

  it("suites by group: the same group one after another, different groups at once; a bail or a stop ends them all", async () => {
    const files = (groupA, groupB) => ({
      "a.hafen.yml": `version: 1\n${groupA ? `group: ${groupA}\n` : ""}provider: providers/json.yml\ntests:\n${[0, 1, 2].map((k) => `  - name: a${k}\n    turns: [ { user: "a${k}", expect: [ { contains: "a${k}" } ] } ]`).join("\n")}\n`,
      "b.hafen.yml": `version: 1\n${groupB ? `group: ${groupB}\n` : ""}provider: providers/json.yml\ntests:\n${[0, 1, 2].map((k) => `  - name: b${k}\n    turns: [ { user: "b${k}", expect: [ { contains: "b${k}" } ] } ]`).join("\n")}\n`,
      "providers/json.yml": JSON_PROVIDER,
    });
    const { memoryHost } = await import("../helpers.js");
    const load = async (groupA, groupB) => {
      const host = memoryHost(files(groupA, groupB));
      return { host, suites: [await loadSuite(host, "a.hafen.yml"), await loadSuite(host, "b.hafen.yml")] };
    };
    const vars = { base_url: `${mock.url}/slow?ms=60&x=` };
    const suiteSpans = (r) => r.spans.filter((x) => x.kind === "suite");
    const overlap = ([x, y]) => x.start < y.end && y.start < x.end;
    let most = 0;
    // Different groups: at once (each suite's tests, with none, one after another)
    {
      const { host, suites } = await load(1, 2);
      let running = 0;
      const run = await runSuites({ suites, host, options: { vars }, onEvent: (e) => {
        if (e.type === "test:start") most = Math.max(most, ++running);
        if (e.type === "test:end") running--;
      } });
      assert.equal(run.verdict, "passed");
      assert.equal(run.tests.length, 6);
      assert.ok(overlap(suiteSpans(run)), "the suites overlapped");
      assert.equal(most, 2, "one test of each suite at a time");
      for (const sp of suiteSpans(run)) assert.equal(sp.status, "pass");
    }
    // The same group, or none: one after another, in order
    for (const [ga, gb] of [[3, 3], [null, null]]) {
      const { host, suites } = await load(ga, gb);
      const run = await runSuites({ suites, host, options: { vars } });
      assert.equal(run.verdict, "passed");
      const [sa, sb] = suiteSpans(run);
      assert.ok(sa.end <= sb.start, `groups ${ga}/${gb}: a, then b`);
    }
    // Bail: the first failure stops everything still to run, in every group
    const { host, suites } = await load(1, 2);
    const failing = { ...suites[0], data: { ...suites[0].data, tests: [{ name: "fails", turns: [{ user: "x", expect: [{ contains: "nope" }] }] }, ...suites[0].data.tests] } };
    const bailed = await runSuites({ suites: [failing, suites[1]], host, options: { vars, bail: true } });
    assert.equal(bailed.status, "stopped");
    assert.match(bailed.stopped, /first failure/);
    assert.ok(bailed.tests.some((t) => t.status === "skipped"));
    // Stopped from outside, mid-run (when the first test ends): the rest don't start, every place is filled
    const controller = new AbortController();
    const stopped = await runSuites({ suites, host, options: { vars }, signal: controller.signal, onEvent: (e) => { if (e.type === "test:end") controller.abort(); } });
    assert.equal(stopped.status, "stopped");
    assert.ok(stopped.turns.every(Boolean), "every turn's place holds a record");
    assert.ok(stopped.tests.filter((t) => t.status === "skipped").length >= 3, "the tests still to start were skipped");
  });

  it("a suite whose setup fails doesn't stop the next one in its group; the run is an error after both", async () => {
    const { memoryHost } = await import("../helpers.js");
    const host = memoryHost({
      "a.hafen.yml": `version: 1\nprovider: providers/json.yml\nsetup:\n  - name: broken\n    request: { url: "{{base_url}}/error/500", method: POST }\n    expect: [ { type: status, equals: 200 } ]\ntests:\n  - name: a\n    turns: [ { user: a } ]\n`,
      "b.hafen.yml": "version: 1\nprovider: providers/json.yml\ntests:\n  - name: b\n    turns: [ { user: b } ]\n",
      "providers/json.yml": JSON_PROVIDER,
    });
    const suites = [await loadSuite(host, "a.hafen.yml"), await loadSuite(host, "b.hafen.yml")];
    const run = await runSuites({ suites, host, options: { vars: { base_url: mock.url } } });
    assert.equal(run.status, "error");
    assert.match(run.error.message, /setup step "broken" failed/);
    assert.deepEqual(run.tests.map((t) => [t.name, t.status]), [["b", "passed"]]);
  });

  it("on_fail: stop skips the rest; continue runs them", async () => {
    const suite = (onFail) => `version: 1
provider: providers/json.yml
tests:
  - name: t
    on_fail: ${onFail}
    turns:
      - user: hello
        expect: [ { contains: "refund" } ]
      - user: again
        expect: [ { contains: "again" } ]
`;
    const stopped = await runYaml(suite("stop"));
    assert.deepEqual(statuses(stopped), [["fail"], ["skipped"]]);
    assert.match(stopped.turns[1].skipped, /on_fail: stop/);
    const continued = await runYaml(suite("continue"));
    assert.deepEqual(statuses(continued), [["fail"], ["pass"]]);
    assert.equal(continued.verdict, "failed");
  });

  it("repeats, with a pass rate", async () => {
    const run = await runYaml(`version: 1
provider: { kind: http, url: "{{base_url}}/flaky?rate=0.5", body: { message: "{{user}}" }, response: { text: $.data.reply } }
tests:
  - name: flaky
    repeat: 4
    pass_rate: 0.5
    turns:
      - user: a refund
        expect: [ { contains: refund } ]
`);
    const t = run.tests[0];
    assert.equal(t.total, 4);
    assert.ok(t.passed >= 1 && t.passed <= 3, `passed ${t.passed}`);
    assert.equal(t.status, t.passed / 4 >= 0.5 ? "passed" : "failed");
  });

  it("runs once per data row, reporting accuracy", async () => {
    const run = await runYaml(`version: 1
provider: providers/json.yml
tests:
  - name: rows
    data: rows.csv
    turns:
      - user: "{{row.q}}"
        expect: [ { contains: "{{row.want}}" } ]
`, { files: { "rows.csv": "q,want\nrefund please,4417\nhello,hello\nhi,nope\n" } });
    const t = run.tests[0];
    assert.equal(t.total, 3);
    assert.equal(t.passed, 2);
    assert.equal(t.accuracy, 0.667);
    assert.deepEqual(run.turns.map((x) => x.row), [1, 2, 3]);
  });

  it("setup steps extract values; teardown always runs", async () => {
    const run = await runYaml(`version: 1
provider: { kind: http, url: "{{base_url}}/json", headers: { Authorization: "Bearer {{token}}" }, body: { message: "{{user}}" }, response: { text: $.data.reply } }
tests:
  - name: with login
    setup:
      - name: log in
        request: { url: "{{base_url}}/login", method: POST, body: { user: qa } }
        extract: { token: $.access_token }
    turns:
      - user: hello
        expect: [ { contains: "nope" } ]
    teardown:
      - request: { url: "{{base_url}}/json", method: POST, body: { message: "bye" } }
`);
    assert.equal(run.tests[0].status, "failed");
    const paths = mock.log.map((r) => r.path);
    assert.deepEqual(paths, ["/login", "/json", "/json"]);
    assert.equal(mock.log[1].headers.authorization, "Bearer tok_mock_123");
    assert.ok(run.spans.some((s) => s.kind === "setup" && s.status === "ok"));
    assert.ok(run.spans.some((s) => s.kind === "teardown"));
  });

  it("pinned history sends the fixed replies, live sends the real ones", async () => {
    const yaml = (history) => `version: 1
provider: { kind: http, url: "{{base_url}}/json", body: { messages: "{{messages}}" }, history: messages, response: { text: $.data.reply } }
tests:
  - name: t
    history: ${history}
    turns:
      - user: first
        reply: "FIXED REPLY"
      - user: second
`;
    await runYaml(yaml("pinned"));
    assert.equal(mock.log[1].body.messages[1].content, "FIXED REPLY");
    mock.reset();
    await runYaml(yaml("live"));
    assert.equal(mock.log[1].body.messages[1].content, "You said: first");
  });

  it("conversation checks run after the last turn", async () => {
    const run = await runYaml(`version: 1
provider: providers/json.yml
tests:
  - name: t
    turns:
      - user: a refund
      - user: thanks
    expect_conversation:
      - { on: conversation, path: "$[*].reply", contains: "You said: thanks" }
`);
    assert.equal(run.tests[0].instances[0].conversation_results[0].status, "pass");
  });

  it("a setup error sends nothing", async () => {
    const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider: openai-chat\ntests:\n  - name: a\n    turns:\n      - user: \"{{nope}}\"\n" });
    const suite = await loadSuite(host, "s.hafen.yml");
    const run = await runSuites({ suites: [suite], host });
    assert.equal(run.status, "error");
    assert.match(run.error.message, /\{\{nope\}\}/);
    assert.equal(run.turns.length, 0);
  });

  it("stops at the spending limit", async () => {
    const run = await runYaml(`version: 1
provider: providers/json.yml
tests:
  - name: a
    repeat: 5
    turns: [ { user: hi } ]
`, { options: { maxCost: 0.00001 } });
    assert.equal(run.status, "stopped");
    assert.match(run.stopped, /cost reached the limit/);
    assert.ok(run.turns.length < 5);
  });

  it("emits events for a UI, and records every step as a span", async () => {
    const events = [];
    const run = await runYaml(`version: 1
provider: providers/sse.yml
variables: { scenario: tools }
tests:
  - name: t
    turns:
      - user: a refund
        expect:
          - { type: sequence, value: [thinking, "tool_call:lookup_order", text] }
`, { events });
    const types = new Set(events.map((e) => e.type));
    for (const t of ["run:start", "test:start", "turn:start", "turn:event", "turn:end", "test:end", "run:end", "span"]) assert.ok(types.has(t), t);
    const kinds = new Set(run.spans.map((s) => s.kind));
    for (const k of ["run", "suite", "test", "repeat", "turn", "request", "first_byte", "thinking", "tool_call", "tool_result", "answer", "check"]) assert.ok(kinds.has(k), k);
    assert.ok(run.spans.every((s) => s.end !== undefined));
    assert.equal(statuses(run)[0][0], "pass");
  });

  it("asks for readable thinking only when a test checks it", async () => {
    const run = await runYaml(`version: 1
provider: providers/sse.yml
variables: { scenario: thinking/omitted }
tests:
  - name: t
    turns:
      - user: a refund
        expect:
          - { on: thinking, contains: "window" }
          - { on: thinking, contains: "window", required: true }
          - { on: thinking, type: present }
`);
    assert.deepEqual(statuses(run)[0], ["skipped", "fail", "pass"]);
  });
});

async function runFiles(files, { options = {}, secrets = {}, signal, onEvent } = {}) {
  const host = memoryHost({ "providers/json.yml": JSON_PROVIDER, ...files }, { secrets });
  const suites = [];
  for (const file of Object.keys(files).filter((f) => f.endsWith(".hafen.yml")).sort()) {
    const suite = await loadSuite(host, file);
    assert.deepEqual(suite.errors, [], JSON.stringify(suite.errors));
    suites.push(suite);
  }
  return runSuites({ suites, host, options: { vars: { base_url: mock.url }, ...options }, signal, onEvent });
}
const sent = (path = "/json") => mock.log.filter((x) => x.path === path).map((x) => x.body.message);

describe("variables (docs/test-files.md, Variables)", () => {
  it("{{run.id}}, {{test.name}}, {{repeat}} and {{turn.index}} are the run's", async () => {
    const run = await runFiles({ "s.hafen.yml": `version: 1
provider: providers/json.yml
tests:
  - name: the run's own
    repeat: 2
    turns:
      - user: "run {{run.id}} · {{test.name}} · repeat {{repeat}} · turn {{turn.index}}"
      - user: "turn {{turn.index}} of {{test.name}}"
` });
    assert.equal(run.verdict, "passed", JSON.stringify(run.error));
    assert.deepEqual(sent(), [
      `run ${run._id} · the run's own · repeat 1 · turn 1`, "turn 2 of the run's own",
      `run ${run._id} · the run's own · repeat 2 · turn 1`, "turn 2 of the run's own",
    ]);
  });

  it("a {{name}}: the latest extraction, then a setup step's, then --var, then the suite's variables, then its environment's", async () => {
    const run = await runFiles({ "s.hafen.yml": `version: 1
provider: providers/json.yml
environments:
  local: { who: env-who, only_env: from-env, shadow: env-shadow, given: env-given }
variables: { who: var-who, shadow: var-shadow, given: var-given }
setup:
  - name: log in
    request: { url: "{{base_url}}/login", method: POST }
    extract: { shadow: $.access_token }
tests:
  - name: layers
    turns:
      - user: "1 {{who}} {{only_env}} {{shadow}} {{given}}"
        extract: { who: $.data.order.id }
      - user: "2 {{who}}"
        extract: { who: $.session_id }
      - user: "3 {{who}}"
` }, { options: { vars: { base_url: mock.url, given: "from --var" } } });
    assert.equal(run.verdict, "passed", JSON.stringify(run.error));
    assert.deepEqual(sent(), ["1 var-who from-env tok_mock_123 from --var", "2 4417", "3 sess_1"]);
  });

  it("a value that is exactly one {{name}} keeps its type; inside text, it's text", async () => {
    const run = await runFiles({ "s.hafen.yml": `version: 1
provider: providers/json.yml
variables: { order: 4417 }
tests:
  - name: typed
    turns:
      - user: "order {{order}}"
        expect:
          - { path: $.data.order.id, equals: "{{order}}", type_is: integer }
          - { path: $.data.order.id, equals: "{{order}}" }
` });
    assert.deepEqual(run.turns[0].results.map((r) => r.status), ["pass", "pass"]);
    assert.deepEqual(sent(), ["order 4417"]);
  });
});

describe("a test's settings (docs/test-files.md, Test keys)", () => {
  it("the suite's defaults (repeat, pass_rate) are every test's, and a test's own win", async () => {
    const run = await runFiles({ "s.hafen.yml": `version: 1
provider: providers/json.yml
defaults: { repeat: 3, pass_rate: 0.5 }
tests:
  - name: by default
    turns: [ { user: a } ]
  - name: its own
    repeat: 1
    turns: [ { user: b } ]
` });
    assert.deepEqual(run.tests.map((t) => [t.name, t.total, t.settings.pass_rate]), [["by default", 3, 0.5], ["its own", 1, 0.5]]);
  });
});

describe("timeouts, retries, a stop, and how a turn's error is said", () => {
  const statuses = (record) => record.results.map((r) => [r.name, r.status, r.reason]);

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

  async function runFiles(files, { secrets = {}, transport, signal, options = {} } = {}) {
    const host = memoryHost(files, { secrets, ...(transport ? { transport } : {}) });
    const s = await loadSuite(host, "s.hafen.yml");
    assert.deepEqual(s.errors, [], JSON.stringify(s.errors));
    return runSuites({ suites: [s], host, signal, options: { vars: { base_url: mock.url }, ...options } });
  }

  describe("a provider's timeout_ms and retries: the test's, then the suite's defaults, then the provider's, then Hafen's", () => {
    it("a provider's timeout_ms: 300 times out a reply that takes 1.5 s, saying 300 ms", async () => {
      const started = Date.now();
      const r = await runFiles({ "providers/p.yml": provider("/slow?ms=1500", "timeout_ms: 300\nretries: 0\n"), "s.hafen.yml": suite() });
      assert.ok(Date.now() - started < 1400, `${Date.now() - started} ms`);
      assert.equal(r.tests[0].status, "error");
      assert.equal(r.turns[0].error, "timed out after 300 ms");
      assert.equal(r.tests[0].settings.timeout_ms, 300);
    });

    it("the suite's defaults win over the provider's, and the test's over both", async () => {
      const files = { "providers/p.yml": provider("/slow?ms=600", "timeout_ms: 200\nretries: 0\n") };
      const defaults = await runFiles({ ...files, "s.hafen.yml": suite({ head: "defaults: { timeout_ms: 5000 }" }) });
      assert.equal(defaults.tests[0].status, "passed", JSON.stringify(defaults.turns[0].error));
      assert.equal(defaults.tests[0].settings.timeout_ms, 5000);
      const test = await runFiles({ ...files, "s.hafen.yml": suite({ head: "defaults: { timeout_ms: 5000 }", test: "    timeout_ms: 250\n" }) });
      assert.equal(test.turns[0].error, "timed out after 250 ms");
      // (--timeout, over all of them)
      const option = await runFiles({ ...files, "s.hafen.yml": suite({ test: "    timeout_ms: 250\n" }) }, { options: { timeoutMs: 5000 } });
      assert.equal(option.tests[0].status, "passed");
    });

    it("a provider's retries: 0 sends a 500 once; none, three times; the suite's and the test's win over it", async () => {
      const calls = async (more, s) => {
        const transport = fakeTransport(() => ({ status: 500, headers: { "content-type": "application/json", "retry-after-ms": "1" }, body: "{\"error\":\"down\"}" }));
        const r = await runFiles({ "providers/p.yml": provider("/json", more), "s.hafen.yml": s }, { transport });
        assert.equal(r.tests[0].status, "error");
        return transport.requests.length;
      };
      assert.equal(await calls("retries: 0\n", suite()), 1);
      assert.equal(await calls("", suite()), 3);
      assert.equal(await calls("retries: 0\n", suite({ head: "defaults: { retries: 1 }" })), 2);
      assert.equal(await calls("retries: 3\n", suite({ head: "defaults: { retries: 1 }", test: "    retries: 0\n" })), 1);
    });

    it("a turn given no settings (a conversation) takes the provider's own", async () => {
      const transport = fakeTransport(() => ({ status: 500, headers: { "content-type": "application/json", "retry-after-ms": "1" }, body: "{}" }));
      const spans = createSpans({ now: () => performance.now() });
      const scope = createScope({ layers: [{ base_url: mock.url }] });
      const out = await executeTurn({ provider: createProvider(parse(provider("/json", "retries: 0\n"))), message: "hi", scope, transport, spans, now: () => performance.now() });
      assert.equal(transport.requests.length, 1);
      assert.match(out.error, /^500/);
      const slow = await executeTurn({ provider: createProvider(parse(provider("/slow?ms=1500", "timeout_ms: 1200\n"))), message: "hi", scope, transport: memoryHost().transport, spans, now: () => performance.now() });
      assert.equal(slow.error, "timed out after 1.2 s");
    });
  });

  describe("a turn the stop cut short", () => {
    it("has every check skipped, latency and status too; a turn that failed on its own still has them checked", async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const expect = "[ { type: latency, max_ms: 5000 }, { type: status, equals: 200 }, { contains: \"You said\" } ]";
      const stopped = await runFiles({ "providers/p.yml": provider("/slow?ms=3000"), "s.hafen.yml": suite({ expect }) }, { signal: controller.signal });
      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.turns[0].error, "stopped");
      assert.deepEqual(statuses(stopped.turns[0]), [
        ["latency ≤ 5.0 s", "skipped", "the run was stopped"],
        ["status 200", "skipped", "the run was stopped"],
        ["contains You said", "skipped", "the run was stopped"],
      ]);
      assert.equal(stopped.verdict, null);
      // One that failed on its own (a 500): its latency and status are what it had
      const failed = await runFiles({ "providers/p.yml": provider("/error/500", "retries: 0\n"), "s.hafen.yml": suite({ expect }) });
      assert.deepEqual(statuses(failed.turns[0]).map(([name, status]) => [name, status]), [["latency ≤ 5.0 s", "pass"], ["status 200", "fail"], ["contains You said", "skipped"]]);
    });
  });

  describe("how a turn's error is said", () => {
    const turn = (config, transport, rest = {}) => executeTurn({
      provider: createProvider(typeof config === "string" ? parse(config) : config), message: "hi", scope: createScope({ layers: [{ base_url: mock.url, scenario: "cut" }] }),
      transport, spans: createSpans({ now: () => performance.now() }), now: () => performance.now(), retries: 0, ...rest,
    });

    it("a timeout in ms or s, as latency is", async () => {
      const hang = { send: (req, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) };
      assert.equal((await turn(provider("/json"), hang, { timeoutMs: 300 })).error, "timed out after 300 ms");
      assert.equal((await turn(provider("/json"), hang, { timeoutMs: 1200 })).error, "timed out after 1.2 s");
    });

    it("a stream cut off mid-reply: the response ended early, after how many chunks, and the reply so far is kept", async () => {
      const out = await turn(MOCK_SSE_PROVIDER, memoryHost().transport);
      // (how many chunks the reader saw depends on how the network grouped the mock's writes: 1 or 2)
      assert.match(out.error, /^the response ended early: the connection closed after [12] chunks? \(the reply so far is kept\)$/);
      assert.match(out.record.reply, /^This reply is going /);
      assert.equal(out.stopped, false);
      // A body cut before any of it was read; one cut after its first chunk
      const cut = (chunks) => ({ async send() { return { status: 200, headers: { "content-type": "text/event-stream" }, body: (async function* body() { for (const c of chunks) yield new TextEncoder().encode(c); throw new TypeError("terminated"); })() }; } });
      assert.equal((await turn(provider("/json"), cut([]))).error, "the response ended early: the connection closed before its body was all in");
      assert.equal((await turn(MOCK_SSE_PROVIDER, cut(sseChunks([{ type: "text_delta", delta: "Hello" }], { split: 100 })))).error, "the response ended early: the connection closed after 1 chunk (the reply so far is kept)");
    });

    it("errors before the response, and the turn's own after it, are said as they were", async () => {
      const refused = { send: async () => { throw new TypeError("fetch failed"); } };
      assert.equal((await turn(provider("/json"), refused)).error, "fetch failed");
      // (a tool call the test has no result for: after the stream ended, not a cut)
      const asks = fakeTransport(() => ({ headers: { "content-type": "text/event-stream" }, chunks: sseChunks([{ type: "tool_call", id: "c1", name: "lookup_order", args: { id: 1 } }, "[DONE]"]) }));
      const out = await turn(`${MOCK_SSE_PROVIDER}done_marker: "[DONE]"\n`, asks, { tools: { other: { result: 1 } } });
      assert.match(out.error, /^The model called lookup_order, and the test has no result for it/);
    });
  });
});

describe("a run stopped early (--max-cost)", () => {
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

describe("a turn's metrics", () => {
  it("times the first token, the thinking and the first answer token", () => {
    const m = metricsOf([{ type: "thinking", t: 400, t_end: 2400 }, { type: "text", t: 2500, t_end: 3000 }], { ms: 3100 });
    assert.equal(m.ttft_ms, 400);
    assert.equal(m.first_thinking_ms, 400);
    assert.equal(m.thinking_ms, 2000);
    assert.equal(m.first_answer_ms, 2500);
    assert.equal(m.tokens_per_s, undefined);  // (no usage reported)
  });

  it("with no thinking: the output tokens over the answer's time", () => {
    const m = metricsOf([{ type: "text", t: 500, t_end: 2500 }], { ms: 2500, usage: { output: 100 }, provider: { kind: "openai-chat" } });
    assert.equal(m.tokens_per_s, 50);
  });

  it("with the thinking shown: every output token over the thinking and the answer, not the answer's time alone", () => {
    // 525 tokens (Ollama counts the thinking in them): 16.5 s of thinking, then a short answer
    const events = [{ type: "thinking", t: 1100, t_end: 17600 }, { type: "text", t: 17800, t_end: 18300 }];
    const m = metricsOf(events, { ms: 18300, usage: { input: 425, output: 525 }, provider: { kind: "ollama" } });
    assert.equal(m.tokens_per_s, 30.5);
  });

  it("with the thinking hidden (counted, not shown): the answer's own tokens over its time", () => {
    const m = metricsOf([{ type: "text", t: 9000, t_end: 11000 }], { ms: 11000, usage: { output: 500, thinking: 400 }, provider: { kind: "openai-responses" } });
    assert.equal(m.tokens_per_s, 50);
  });

  it("Gemini reports its thinking tokens apart: they're added (shown) or not taken away (hidden)", () => {
    const shown = metricsOf([{ type: "thinking", t: 1000, t_end: 5000 }, { type: "text", t: 5000, t_end: 6000 }], { ms: 6000, usage: { output: 100, thinking: 300 }, provider: { kind: "gemini" } });
    assert.equal(shown.tokens_per_s, 80);
    const hidden = metricsOf([{ type: "text", t: 5000, t_end: 7000 }], { ms: 7000, usage: { output: 100, thinking: 300 }, provider: { kind: "gemini" } });
    assert.equal(hidden.tokens_per_s, 50);
  });

  it("says nothing for a reply too quick to time, or with no tokens left to count", () => {
    assert.equal(metricsOf([{ type: "text", t: 100, t_end: 120 }], { ms: 120, usage: { output: 5 } }).tokens_per_s, undefined);
    assert.equal(metricsOf([{ type: "text", t: 100, t_end: 2100 }], { ms: 2100, usage: { output: 300, thinking: 300 } }).tokens_per_s, undefined);
  });

  it("keeps only the token counts reported", () => {
    const m = metricsOf([{ type: "text", t: 100, t_end: 2100 }], { ms: 2100, usage: { input: 10, output: 20, thinking: undefined, cached: undefined } });
    assert.deepEqual(m.tokens, { input: 10, output: 20 });
  });
});
