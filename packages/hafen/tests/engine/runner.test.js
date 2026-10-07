// Running suites (spec US2, US4, US7): turns in order, extractions, on_fail, repeats and pass rates,
// data rows, setup and teardown, conversation checks, pinned history, judges with confidence and
// "unsure", spending limits, and the run record.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { runSuites } from "../../engine/runner.js";
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

describe("judges", () => {
  const judges = `judges:
  default: { kind: systemone, endpoint: "{{base_url}}/systemone" }
  rubric: { kind: llm, provider: judge, samples: 3 }
providers:
  judge: { kind: openai-chat, base_url: "{{base_url}}/judge", model: mock-judge, api_key: "" }
`;

  it("System One: noul, choice and score, one request per turn", async () => {
    const run = await runYaml(`version: 1
provider: providers/json.yml
${judges}
tests:
  - name: t
    turns:
      - user: a refund for 4417
        expect:
          - { type: systemone.noul, question: "Does the reply ask why?", min: 0.8 }
          - { type: systemone.choice, question: "What does it offer?", options: [refund, replacement], equals: refund }
          - { type: systemone.score, question: "How helpful?", rubric: [poor, ok, great], min: 2 }
`);
    const [noul, choice, score] = run.turns[0].results;
    assert.equal(noul.status, "pass");
    assert.equal(noul.value, 0.91);
    assert.equal(noul.confidence, 0.82);
    assert.equal(choice.status, "pass");
    assert.equal(choice.actual, "refund");
    assert.equal(score.status, "pass");
    assert.equal(mock.log.filter((r) => r.path === "/systemone/v1/systemone").length, 1);
    assert.equal(mock.log.find((r) => r.path === "/systemone/v1/systemone").headers.authorization, "Bearer jev-secret-key-1");
    // The key is redacted from the record
    assert.ok(!JSON.stringify(run).includes("jev-secret-key-1"));
  });

  it("low confidence is unsure, which warns by default and fails when asked", async () => {
    const yaml = `version: 1
provider: providers/json.yml
${judges}
tests:
  - name: t
    turns:
      - user: a refund
        expect:
          - { type: systemone.noul, question: "UNSURE: is it polite?", min: 0.5 }
`;
    const warned = await runYaml(yaml);
    assert.equal(warned.turns[0].results[0].status, "unsure");
    assert.equal(warned.tests[0].status, "passed");
    assert.equal(warned.verdict, "unsure");
    const failed = await runYaml(yaml, { options: { unsure: "fail" } });
    assert.equal(failed.verdict, "failed");
  });

  it("an unreachable judge is an error, not a failure", async () => {
    const run = await runYaml(`version: 1
provider: providers/json.yml
judges:
  default: { kind: systemone, endpoint: "http://127.0.0.1:1" }
tests:
  - name: t
    turns:
      - user: hi
        expect: [ { type: systemone.noul, question: "ok?" } ]
`);
    assert.equal(run.turns[0].results[0].status, "error");
    assert.equal(run.tests[0].status, "error");
  });

  it("LLM judges: rubric criteria, sample agreement as confidence", async () => {
    const run = await runYaml(`version: 1
provider: providers/json.yml
${judges}
tests:
  - name: t
    turns:
      - user: a refund
        expect:
          - { type: judge, judge: rubric, rubric: [Asks why, Mentions the order] }
          - { type: judge, judge: rubric, rubric: [Apologises, "NOT-MET: offers a discount"], min: 1 }
          - { type: judge, judge: rubric, rubric: ["FLAKY criterion"] }
`, { options: {} });
    const [good, bad, flaky] = run.turns[0].results;
    assert.equal(good.status, "pass");
    assert.equal(good.confidence, 1);
    assert.equal(bad.status, "fail");
    assert.match(bad.reason, /not met: NOT-MET/);
    assert.ok(flaky.confidence < 1 && flaky.confidence > 0.5, `confidence ${flaky.confidence}`);
    assert.equal(flaky.judge.samples.length, 3);
  });
});
