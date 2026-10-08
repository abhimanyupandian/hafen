// What each check type needs (contracts/checks.md): a check without it would pass having looked at
// nothing ({ type: tool.not_called, name: lookup_order } passed every run: "undefined wasn't
// called"). So it's a problem at the check's line and column, naming the type and what it needs (and
// the key most likely meant for it), and nothing is sent; a check turned off is never looked at. Run
// anyway (a run's own guard), it's an error with the same reason, never a pass.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { loadSuite } from "../../engine/files/suite-file.js";
import { lacking, runRule } from "../../engine/checks/index.js";
import { runJudged } from "../../engine/judges/index.js";
import { runSuites } from "../../engine/runner.js";
import { fakeTransport, memoryHost } from "../helpers.js";

// Each type without what it needs: the check as written, and the problem
const CASES = [
  ["{ type: path, equals: 1 }", "a path check needs path (a JSONPath, as $.order.id)"],
  ["{ type: path, path: $.data.reply }", "a path check needs an operator (equals, contains, exists, lt, …)"],
  ["{ type: text }", "a text check needs an operator (equals, contains, matches, …)"],
  ["{ type: contains }", "a contains check needs value or contains (the text to find)"],
  ["{ type: contains, value: \"\" }", "a contains check needs value or contains (the text to find)"],
  ["{ type: not_contains }", "a not_contains check needs value or not_contains (the text that mustn't be there)"],
  ["{ type: matches }", "a matches check needs value or matches (a regular expression)"],
  ["{ type: latency }", "a latency check needs max_ms or first_token_ms (a limit in milliseconds)"],
  ["{ type: length }", "a length check needs min_length or max_length (a limit in characters)"],
  ["{ type: tokens }", "a tokens check needs max_tokens (the most tokens)"],
  ["{ type: cost }", "a cost check needs max_cost (the most it can cost, in USD)"],
  ["{ type: tool.called }", "a tool.called check needs tool (the tool's name)"],
  ["{ type: tool.called, tool: \"\", times: 1 }", "a tool.called check needs tool (the tool's name)"],
  ["{ type: tool.not_called }", "a tool.not_called check needs tool (the tool's name)"],
  ["{ type: tool.order }", "a tool.order check needs order (the tools' names, in order)"],
  ["{ type: tool.order, order: [], match: in_order }", "a tool.order check needs order (the tools' names, in order)"],
  ["{ type: sequence }", "a sequence check needs value (a list of event kinds, in order)"],
  ["{ type: sequence, value: thinking }", "a sequence check needs value (a list of event kinds, in order)"],
  ["{ type: systemone.noul }", "a systemone.noul check needs question (what to ask of the reply)"],
  ["{ type: systemone.choice, question: q, options: [a, b] }", "a systemone.choice check needs equals (the option that passes, or a list of them)"],
  ["{ type: systemone.choice, question: q, equals: a }", "a systemone.choice check needs options (2 or more to choose from)"],
  ["{ type: systemone.choice }", "a systemone.choice check needs question (what to ask of the reply), options (2 or more to choose from) and equals (the option that passes, or a list of them)"],
  ["{ type: systemone.score }", "a systemone.score check needs question (what to ask of the reply)"],
  ["{ type: judge }", "a judge check needs rubric (one criterion or a list)"],
  ["{ type: reference }", "a reference check needs reference (the expected answer)"],
];

// A suite with these checks on its one turn, each on a line of its own (the first on line 8, at
// column 13): its problems
const suite = (checks, { more = "", head = "" } = {}) => `version: 1
provider: { kind: http, url: "http://x.example/chat", body: { message: "{{user}}" }, response: { text: $.data.reply } }
${head}tests:
  - name: t
    turns:
      - user: hi
        expect:
${checks.map((c) => `          - ${c}\n`).join("")}${more}`;
async function load(text) {
  const transport = fakeTransport(() => ({ body: JSON.stringify({ data: { reply: "hello" } }) }));
  const host = memoryHost({ "s.hafen.yml": text }, { transport });
  return { suite: await loadSuite(host, "s.hafen.yml"), host, transport };
}

describe("what a check's type needs", () => {
  it("each type without it: a problem at the check, naming the type and what it needs", async () => {
    const { suite: s } = await load(suite(CASES.map(([check]) => check)));
    assert.deepEqual(s.errors, CASES.map(([, message], i) => ({ file: "s.hafen.yml", line: 8 + i, column: 13, message })));
  });

  it("nothing is sent: the run stops with every problem", async () => {
    const { suite: s, host, transport } = await load(suite(["{ type: tool.not_called, name: lookup_order }", "{ type: length }", "{ contains: hello }"]));
    const run = await runSuites({ suites: [s], host });
    assert.equal(run.status, "error");
    assert.deepEqual(run.error.all.map((p) => [p.line, p.message]), [
      [8, "a tool.not_called check needs tool (the tool's name): \"name\" is the check's own label (did you mean \"tool\"?)"],
      [9, "a length check needs min_length or max_length (a limit in characters)"],
    ]);
    assert.equal(transport.requests.length, 0);
  });

  it("a key written in place of the one it needs: what that key is, and the one meant", async () => {
    const { suite: s } = await load(suite([
      "{ type: tool.not_called, name: lookup_order }",
      "{ type: tool.called, value: lookup_order }",
      "{ type: tool.order, value: [lookup_order, refund] }",
      "{ type: sequence, order: [thinking, text] }",
      "{ type: length, max: 200 }",
      "{ type: length, gte: 20 }",
      "{ type: latency, lte: 3000 }",
      "{ type: cost, max: 0.01 }",
      "{ type: systemone.choice, question: q, options: [a, b], value: a }",
      "{ type: judge, question: \"Is it polite?\" }",
      "{ type: reference, equals: \"The answer\" }",
    ]));
    assert.deepEqual(s.errors.map((e) => e.message), [
      "a tool.not_called check needs tool (the tool's name): \"name\" is the check's own label (did you mean \"tool\"?)",
      "a tool.called check needs tool (the tool's name): \"value\" is for contains, not_contains, matches and sequence checks (did you mean \"tool\"?)",
      "a tool.order check needs order (the tools' names, in order): \"value\" is for contains, not_contains, matches and sequence checks (did you mean \"order\"?)",
      "a sequence check needs value (a list of event kinds, in order): \"order\" is for tool.order checks (did you mean \"value\"?)",
      "a length check needs min_length or max_length (a limit in characters): \"max\" is for judged checks (did you mean \"max_length\"?)",
      "a length check needs min_length or max_length (a limit in characters): \"gte\" is an operator, for path and text checks (did you mean \"min_length\"?)",
      "a latency check needs max_ms or first_token_ms (a limit in milliseconds): \"lte\" is an operator, for path and text checks (did you mean \"max_ms\"?)",
      "a cost check needs max_cost (the most it can cost, in USD): \"max\" is for judged checks (did you mean \"max_cost\"?)",
      "a systemone.choice check needs equals (the option that passes, or a list of them): \"value\" is for contains, not_contains, matches and sequence checks (did you mean \"equals\"?)",
      "a judge check needs rubric (one criterion or a list): \"question\" is for System One checks (did you mean \"rubric\"?)",
      "a reference check needs reference (the expected answer): \"equals\" is an operator, for path and text checks (did you mean \"reference\"?)",
    ]);
  });

  it("an unknown key that's the one it needs misspelled: said once, as that key", async () => {
    const { suite: s } = await load(suite(["{ type: tool.called, tol: lookup_order }", "{ type: length, max_lenght: 20 }"]));
    assert.deepEqual(s.errors.map((e) => e.message), [
      "tests.0.turns.0.expect.0: unknown key \"tol\" (did you mean \"tool\"?)",
      "tests.0.turns.0.expect.1: unknown key \"max_lenght\" (did you mean \"max_length\"?)",
    ]);
  });

  it("everything it needs: no problem (every type, the way the docs write it)", async () => {
    const { suite: s } = await load(suite([
      "{ path: $.data.reply, exists: true }",
      "{ type: path, path: $.data.reply, equals: hello }",
      "{ contains: hello }",
      "{ type: contains, value: hello }",
      "{ type: not_contains, not_contains: bye }",
      "{ type: matches, value: \"^h\" }",
      "{ type: status }",
      "{ type: status, equals: 200 }",
      "{ type: latency, first_token_ms: 800 }",
      "{ type: length, max_length: 2000 }",
      "{ type: json }",
      "{ type: tokens, max_tokens: 1000, on: thinking }",
      "{ type: cost, max_cost: 0.01 }",
      "{ on: thinking, type: present }",
      "{ type: thinking.present, required: true }",
      "{ type: tool.called, tool: lookup_order, args: { $.order_id: 4417 } }",
      "{ type: tool.not_called, tool: refund }",
      "{ type: tool.order, order: [lookup_order, refund], match: exact }",
      "{ type: sequence, value: [thinking, tool_call, text] }",
      "{ type: systemone.noul, question: \"Does it ask why?\", min: 0.8 }",
      "{ type: systemone.choice, question: q, options: [a, b], equals: [a, b] }",
      "{ type: systemone.score, question: q, rubric: [poor, good] }",
      "{ type: judge, judge: rubric, rubric: polite }",
      "{ type: reference, judge: rubric, reference: \"The answer\" }",
    ], { head: "providers:\n  j: { kind: http, url: \"http://j.example\", body: { p: \"{{user}}\" }, response: { text: $.t } }\njudges:\n  rubric: { kind: llm, provider: j }\n" }));
    assert.deepEqual(s.errors, []);
  });

  it("a judge plugin's check can ask its question instead of a rubric", async () => {
    const { suite: s } = await load(suite(["{ type: judge, judge: mine, question: \"Is it polite?\" }", "{ type: judge, judge: mine, min: 0.5 }"], { head: "judges:\n  mine: { kind: plugin, plugin: house }\n" }));
    assert.deepEqual(s.errors.map((e) => [e.line, e.message]), [[11, "a judge check needs rubric or question (one criterion or a list, or the question its plugin is asked)"]]);
  });

  it("a check turned off is never looked at", async () => {
    const { suite: s } = await load(suite(["{ type: length, enabled: false }", "{ type: tool.called, name: x, enabled: false }", "{ contains: hello }"]));
    assert.deepEqual(s.errors, []);
  });

  it("a setup or teardown step's checks too, and the whole conversation's", async () => {
    const { suite: s } = await load(`version: 1
provider: { kind: http, url: "http://x.example/chat", body: { message: "{{user}}" }, response: { text: $.data.reply } }
setup:
  - request: { url: "http://x.example/login" }
    expect: [ { type: status }, { type: contains } ]
tests:
  - name: t
    teardown:
      - request: { url: "http://x.example/logout" }
        expect: [ { type: matches, enabled: false }, { type: not_contains } ]
    turns: [ { user: hi, expect: [ { contains: hello } ] } ]
    expect_conversation: [ { type: judge } ]
`);
    assert.deepEqual(s.errors.map((e) => [e.line, e.column, e.message]), [
      [5, 33, "a contains check needs value or contains (the text to find)"],
      [10, 54, "a not_contains check needs value or not_contains (the text that mustn't be there)"],
      [12, 28, "a judge check needs rubric (one criterion or a list)"],
    ]);
  });
});

describe("a run's own guard: what a check lacks is an error, never a pass", () => {
  // A turn every check above would pass on, had it what it needs
  const turn = { user: "hi", reply: "hello", response: { status: 200 }, events: [{ type: "text", text: "hello" }], thinking: [], tool_calls: [], usage: { output: 5, thinking: 0 }, metrics: { ms: 10, ttft_ms: 5, cost: 0.000001 } };

  it("each rule check: status error, with the problem's reason", () => {
    for (const [text, message] of CASES) {
      const check = parse(text);
      if (/^(systemone\.|judge|reference)/.test(check.type)) continue;
      assert.deepEqual(runRule(check, { turn, response: { data: { reply: "hello" } } }), { status: "error", reason: message }, text);
    }
  });

  it("each judged check: status error, with the problem's reason, and no judge asked", async () => {
    const asked = [];
    const transport = { send: async (req) => { asked.push(req); throw new Error("not asked"); } };
    const judged = CASES.map(([text, message]) => [parse(text), message]).filter(([check]) => /^(systemone\.|judge|reference)/.test(check.type));
    const out = await runJudged(judged.map(([check], index) => ({ index, check })), { turn }, { suite: { judges: { default: { kind: "llm", provider: "p" } }, providers: { p: { kind: "http", url: "http://j.example" } } }, transport, spans: null, parentFor: () => null });
    assert.deepEqual(judged.map((_, index) => out.get(index)), judged.map(([, message]) => ({ status: "error", reason: message })));
    assert.equal(asked.length, 0);
  });

  it("a whole suite run without loading's check (its problems left out): those checks are errors, the test isn't passed", async () => {
    const { suite: s, host, transport } = await load(suite(["{ type: tool.not_called, name: lookup_order }", "{ type: length }", "{ contains: hello }"]));
    const run = await runSuites({ suites: [{ ...s, errors: [] }], host });
    const results = run.turns[0].results;
    assert.deepEqual(results.map((r) => r.status), ["error", "error", "pass"]);
    assert.equal(results[0].reason, "a tool.not_called check needs tool (the tool's name): \"name\" is the check's own label (did you mean \"tool\"?)");
    assert.equal(run.tests[0].status, "error");
    assert.equal(transport.requests.length, 1);
  });

  it("lacking() says nothing of a check plugin's type, or of something that isn't a check", () => {
    assert.equal(lacking({ type: "polite" }), "");
    assert.equal(lacking(null), "");
    assert.equal(lacking({ type: "status" }), "");
  });
});
