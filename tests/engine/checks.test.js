// Rule checks (contracts/checks.md): operators, any and all, what `on` selects, and every built-in
// rule check, with the five result states.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describe as name, runRule } from "../../engine/checks/index.js";
import { evaluate, same } from "../../engine/checks/operators.js";

const turn = {
  user: "I want a refund for 4417",
  reply: "I'm sorry. Could you tell me why you want a refund for order 4417?",
  response: { status: 200 },
  thinking: [{ text: "Check the refund window.", visibility: "summary" }],
  tool_calls: [{ id: "c1", name: "lookup_order", args: { order_id: 4417 } }, { id: "c2", name: "issue_refund", args: { amount: 20 } }],
  events: [
    { type: "thinking", t: 1 }, { type: "tool_call", name: "lookup_order", t: 2 }, { type: "tool_call", name: "issue_refund", t: 3 }, { type: "text", t: 4 },
  ],
  usage: { input: 10, output: 52, thinking: 30 },
  metrics: { ms: 1200, ttft_ms: 300, cost: 0.002 },
};
const response = { data: { reply: turn.reply, order: { id: 4417 }, actions: [{ type: "refund" }, { type: "note" }] } };
const ctx = { turn, response, conversation: [turn] };
const run = (check) => runRule(check, ctx);

describe("operators", () => {
  it("compare numbers and numeric strings as numbers", () => {
    assert.ok(same(4417, "4417"));
    assert.ok(!same(4417, "4418"));
    assert.ok(same({ a: [1, "2"] }, { a: [1, 2] }));
  });
  it("pass if any match passes, or every one with all", () => {
    assert.equal(evaluate({ equals: "refund" }, ["refund", "note"]).pass, true);
    assert.equal(evaluate({ equals: "refund", all: true }, ["refund", "note"]).pass, false);
    assert.equal(evaluate({ equals: 1 }, []).why, "no match");
    assert.equal(evaluate({ exists: false }, []).pass, true);
  });
});

describe("rule checks", () => {
  it("path checks on the response", () => {
    assert.equal(run({ path: "$.data.order.id", equals: 4417 }).status, "pass");
    assert.equal(run({ path: "$.data.order.id", equals: 4418 }).status, "fail");
    assert.equal(run({ path: "$.data.actions[*].type", contains: "refund" }).status, "pass");
    assert.equal(run({ path: "$.data.nope", exists: false }).status, "pass");
    assert.equal(run({ path: "$.data.reply", matches: "/REFUND/i" }).status, "pass");
    assert.equal(run({ path: "$.data.order.id", type_is: "integer", gte: 4000, lt: 5000 }).status, "pass");
    assert.equal(run({ path: "$.data.order", schema: { type: "object", required: ["id"] } }).status, "pass");
  });
  it("a path check on a response that isn't JSON is an error", () => {
    const r = runRule({ path: "$.a", equals: 1 }, { turn: { ...turn }, response: "plain text" });
    assert.equal(r.status, "error");
    assert.match(r.reason, /isn't JSON/);
  });
  it("text checks on the reply", () => {
    assert.equal(run({ contains: "refund" }).status, "pass");
    assert.equal(run({ type: "not_contains", value: "I can't help" }).status, "pass");
    assert.equal(run({ contains: "REFUND", ignore_case: true }).status, "pass");
    assert.equal(run({ type: "length", max_length: 10 }).status, "fail");
  });
  it("status, latency, tokens and cost", () => {
    assert.equal(run({ type: "status", equals: 200 }).status, "pass");
    assert.equal(run({ type: "latency", max_ms: 1000 }).status, "fail");
    assert.equal(run({ type: "latency", max_ms: 2000, first_token_ms: 500 }).status, "pass");
    assert.equal(run({ type: "tokens", max_tokens: 50 }).status, "fail");
    assert.equal(run({ type: "tokens", on: "thinking", max_tokens: 50 }).status, "pass");
    assert.equal(run({ type: "cost", max_cost: 0.01 }).status, "pass");
    assert.equal(runRule({ type: "cost", max_cost: 1 }, { turn: { ...turn, metrics: {} } }).status, "error");
  });
  it("thinking: present, and content checks skipped when hidden", () => {
    assert.equal(run({ on: "thinking", type: "present" }).status, "pass");
    assert.equal(run({ on: "thinking", contains: "refund window" }).status, "pass");
    const hidden = { turn: { ...turn, thinking: [{ text: "", visibility: "omitted" }] } };
    assert.equal(runRule({ on: "thinking", contains: "x" }, hidden).status, "skipped");
    assert.equal(runRule({ on: "thinking", contains: "x", required: true }, hidden).status, "fail");
    assert.equal(runRule({ on: "thinking", type: "present" }, { turn: { ...turn, thinking: [] } }).status, "fail");
  });
  it("tool calls", () => {
    assert.equal(run({ type: "tool.called", tool: "lookup_order", args: { "$.order_id": 4417 } }).status, "pass");
    const wrong = run({ type: "tool.called", tool: "lookup_order", args: { "$.order_id": 4418 } });
    assert.equal(wrong.status, "fail");
    assert.match(wrong.reason, /\$\.order_id was 4417, not 4418/);
    assert.equal(run({ type: "tool.not_called", tool: "delete_account" }).status, "pass");
    assert.equal(run({ type: "tool.order", order: ["lookup_order", "issue_refund"], match: "exact" }).status, "pass");
    assert.equal(run({ type: "tool.order", order: ["issue_refund", "lookup_order"], match: "in_order" }).status, "fail");
    assert.equal(run({ type: "tool.order", order: ["issue_refund", "lookup_order"], match: "any_order" }).status, "pass");
  });
  it("the order of events", () => {
    assert.equal(run({ type: "sequence", value: ["thinking", "tool_call:lookup_order", "text"] }).status, "pass");
    const r = run({ type: "sequence", value: ["text", "tool_call"] });
    assert.equal(r.status, "fail");
    assert.match(r.reason, /happened: thinking → tool_call:lookup_order → tool_call:issue_refund → text/);
  });
  it("an unknown type is an error, not a failure", () => {
    assert.equal(run({ type: "nonsense" }).status, "error");
  });
  it("short names for badges", () => {
    assert.equal(name({ path: "$.data.order.id", equals: 4417 }), "$.data.order.id = 4417");
    assert.equal(name({ type: "status", equals: 200 }), "status 200");
    assert.equal(name({ contains: "4417" }), "contains 4417");
    assert.equal(name({ type: "latency", max_ms: 3000 }), "latency ≤ 3.0 s");
    assert.equal(name({ type: "tool.called", tool: "x" }), "called x");
  });
});
