// Coverage of docs/checks.md, check by check: every operator in its table passes and fails as the
// table says (on a path, and on the reply), and every rule check type it lists, with the result
// states it promises (pass, fail, skipped, error) and their reasons. What checks.test.js samples,
// held here row by row.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRule } from "../../engine/checks/index.js";

const turn = {
  user: "I want a refund for 4417",
  reply: "Sure: your refund for order 4417 is on its way.",
  response: { status: 200 },
  thinking: [{ text: "Look the order up first.", visibility: "full" }],
  tool_calls: [
    { id: "c1", name: "lookup_order", args: { order_id: 4417 } },
    { id: "c2", name: "notify", args: { channel: "email" } },
    { id: "c3", name: "lookup_order", args: { order_id: 4418 } },
  ],
  events: [{ type: "thinking" }, { type: "tool_call", name: "lookup_order" }, { type: "tool_result" }, { type: "text" }],
  usage: { input: 11, output: 40, thinking: 12 },
  metrics: { ms: 900, ttft_ms: 200, cost: 0.0004 },
};
const response = {
  data: {
    reply: turn.reply,
    order: { id: 4417, total: 19.5, paid: true, note: null, tags: ["fragile", "gift"], items: [{ sku: "a", qty: 1 }, { sku: "b", qty: 3 }] },
    name: "Ünïcödé 👋🏽",
  },
};
const ctx = { turn, response, conversation: [turn] };
const status = (check, c = ctx) => runRule(check, c).status;
const reason = (check, c = ctx) => runRule(check, c).reason;

describe("every operator (docs/checks.md, Operators): passes when it should, fails when it shouldn't", () => {
  const rows = [
    // [operator check, passes?]
    [{ path: "$.data.order.id", equals: 4417 }, true],
    [{ path: "$.data.order.id", equals: "4417" }, true],                  // numbers compare as numbers
    [{ path: "$.data.order.tags", equals: ["fragile", "gift"] }, true],   // deep equality for arrays
    [{ path: "$.data.order.items[0]", equals: { sku: "a", qty: 1 } }, true], // and objects
    [{ path: "$.data.order.id", equals: 4418 }, false],
    [{ path: "$.data.order.id", not_equals: 4418 }, true],
    [{ path: "$.data.order.id", not_equals: 4417 }, false],
    [{ path: "$.data.reply", contains: "refund" }, true],
    [{ path: "$.data.reply", contains: "REFUND" }, false],
    [{ path: "$.data.reply", contains: "REFUND", ignore_case: true }, true],
    [{ path: "$.data.order.tags", contains: "gift" }, true],               // an array has an element equal to it
    [{ path: "$.data.order.tags", contains: "gif" }, false],
    [{ path: "$.data.reply", not_contains: "sorry" }, true],
    [{ path: "$.data.reply", not_contains: "refund" }, false],
    [{ path: "$.data.reply", matches: "order \\d{4}" }, true],
    [{ path: "$.data.reply", matches: "^ORDER" }, false],
    [{ path: "$.data.reply", matches: "/^SURE/i" }, true],                 // flags as /…/i
    [{ path: "$.data.order.id", exists: true }, true],
    [{ path: "$.data.nope", exists: true }, false],
    [{ path: "$.data.nope", exists: false }, true],
    [{ path: "$.data.order.id", exists: false }, false],
    [{ path: "$.data.reply", type_is: "string" }, true],
    [{ path: "$.data.order.id", type_is: "integer" }, true],
    [{ path: "$.data.order.id", type_is: "number" }, true],
    [{ path: "$.data.order.total", type_is: "number" }, true],
    [{ path: "$.data.order.total", type_is: "integer" }, false],
    [{ path: "$.data.order.paid", type_is: "boolean" }, true],
    [{ path: "$.data.order", type_is: "object" }, true],
    [{ path: "$.data.order.tags", type_is: "array" }, true],
    [{ path: "$.data.order.note", type_is: "null" }, true],
    [{ path: "$.data.order.tags", type_is: "object" }, false],
    [{ path: "$.data.name", min_length: 9, max_length: 9 }, true],         // characters as a reader counts them
    [{ path: "$.data.name", max_length: 8 }, false],
    [{ path: "$.data.order.tags", min_length: 2 }, true],                   // an array's items
    [{ path: "$.data.order.tags", min_length: 3 }, false],
    [{ path: "$.data.order.id", lt: 5000 }, true],
    [{ path: "$.data.order.id", lt: 4417 }, false],
    [{ path: "$.data.order.id", lte: 4417 }, true],
    [{ path: "$.data.order.id", lte: 4416 }, false],
    [{ path: "$.data.order.id", gt: 4416 }, true],
    [{ path: "$.data.order.id", gt: 4417 }, false],
    [{ path: "$.data.order.id", gte: 4417 }, true],
    [{ path: "$.data.order.id", gte: 4418 }, false],
    [{ path: "$.data.order.total", gt: 10, lt: 20 }, true],                // combined for a range
    [{ path: "$.data.order.total", gt: 20, lt: 30 }, false],
    [{ path: "$.data.order", schema: { type: "object", required: ["id", "paid"] } }, true],
    [{ path: "$.data.order", schema: { type: "object", required: ["refunded"] } }, false],
  ];
  for (const [check, passes] of rows) {
    const [op] = Object.keys(check).filter((k) => k !== "path" && k !== "ignore_case");
    it(`${op}: ${JSON.stringify(check)} ${passes ? "passes" : "fails"}`, () => {
      assert.equal(status(check), passes ? "pass" : "fail", reason(check));
    });
  }

  it("a path that matches nothing fails with \"no match\", except with exists: false", () => {
    assert.deepEqual([status({ path: "$.data.nope", equals: 1 }), reason({ path: "$.data.nope", equals: 1 })], ["fail", "no match"]);
    assert.equal(status({ path: "$.data.nope", contains: "x" }), "fail");
    assert.equal(status({ path: "$.data.nope", exists: false }), "pass");
  });

  it("several matches: any one passing passes; all: true needs every one", () => {
    assert.equal(status({ path: "$.data.order.items[*].qty", gt: 2 }), "pass");
    assert.equal(status({ path: "$.data.order.items[*].qty", gt: 2, all: true }), "fail");
    assert.equal(status({ path: "$.data.order.items[*].qty", gte: 1, all: true }), "pass");
  });

  it("an operator on a value that isn't the right kind fails, saying why (a number test on text, a length of a number)", () => {
    assert.equal(status({ path: "$.data.reply", lt: 5 }), "fail");
    assert.match(reason({ path: "$.data.reply", lt: 5 }), /isn't a number/);
    assert.match(reason({ path: "$.data.order.id", min_length: 1 }), /has no length/);
  });

  it("a regular expression that doesn't compile is an error, not a failure", () => {
    assert.equal(status({ path: "$.data.reply", matches: "(" }), "error");
    assert.match(reason({ path: "$.data.reply", matches: "(" }), /isn't a valid regular expression/);
  });
});

describe("every rule check (docs/checks.md, Rule checks)", () => {
  it("text checks on the reply, shorthand and with value: contains, not_contains, matches", () => {
    assert.equal(status({ contains: "4417" }), "pass");
    assert.equal(status({ type: "contains", value: "4418" }), "fail");
    assert.equal(status({ not_contains: "sorry" }), "pass");
    assert.equal(status({ type: "not_contains", value: "refund" }), "fail");
    assert.equal(status({ matches: "/on its WAY/i" }), "pass");
    assert.equal(status({ type: "matches", value: "^nope" }), "fail");
  });

  it("status: an operator on the HTTP status (default equals); none, or a WebSocket's, is an error", () => {
    assert.equal(status({ type: "status", equals: 200 }), "pass");
    assert.equal(status({ type: "status", equals: 201 }), "fail");
    assert.equal(status({ type: "status", gte: 200, lt: 300 }), "pass");
    const ws = { turn: { ...turn, response: { status: 101 } } };
    assert.equal(status({ type: "status", equals: 200 }, ws), "error");
    assert.match(reason({ type: "status", equals: 200 }, ws), /WebSocket turn has no HTTP status/);
    assert.equal(status({ type: "status", equals: 200 }, { turn: { ...turn, response: {} } }), "error");
  });

  it("latency: max_ms and first_token_ms, each within limits or not; no time to first token is an error", () => {
    assert.equal(status({ type: "latency", max_ms: 1000 }), "pass");
    assert.equal(status({ type: "latency", max_ms: 800 }), "fail");
    assert.equal(status({ type: "latency", max_ms: 1000, first_token_ms: 100 }), "fail");
    assert.match(reason({ type: "latency", max_ms: 1000, first_token_ms: 100 }), /first token 200 ms > 100 ms/);
    assert.equal(status({ type: "latency", first_token_ms: 100 }, { turn: { ...turn, metrics: { ms: 50 } } }), "error");
  });

  it("length: the reply's characters within min_length and max_length", () => {
    assert.equal(status({ type: "length", min_length: 10, max_length: 100 }), "pass");
    assert.equal(status({ type: "length", min_length: 100 }), "fail");
    assert.equal(status({ type: "length", max_length: 10 }), "fail");
    assert.equal(status({ type: "length", max_length: 1 }, { turn: { ...turn, reply: "👋🏽" } }), "pass", "an emoji with its skin tone is one");
  });

  it("json: the reply text parses as JSON, and validates against a schema when given one", () => {
    const json = { turn: { ...turn, reply: '{"order":4417,"status":"refunded"}' } };
    assert.equal(status({ type: "json" }, json), "pass");
    assert.equal(status({ type: "json", schema: { type: "object", required: ["order"] } }, json), "pass");
    assert.equal(status({ type: "json", schema: { type: "object", required: ["tracking"] } }, json), "fail");
    assert.equal(status({ type: "json" }), "fail");
    assert.match(reason({ type: "json" }), /the reply isn't JSON/);
  });

  it("tokens: output tokens (or thinking, with on: thinking) within max_tokens; not reported is an error", () => {
    assert.equal(status({ type: "tokens", max_tokens: 40 }), "pass");
    assert.equal(status({ type: "tokens", max_tokens: 39 }), "fail");
    assert.equal(status({ type: "tokens", on: "thinking", max_tokens: 12 }), "pass");
    assert.equal(status({ type: "tokens", on: "thinking", max_tokens: 11 }), "fail");
    const unreported = { turn: { ...turn, usage: {} } };
    assert.equal(status({ type: "tokens", max_tokens: 1 }, unreported), "error");
    assert.match(reason({ type: "tokens", max_tokens: 1 }, unreported), /didn't report output tokens/);
  });

  it("cost: the turn's cost within max_cost; no price is an error, never a pass", () => {
    assert.equal(status({ type: "cost", max_cost: 0.001 }), "pass");
    assert.equal(status({ type: "cost", max_cost: 0.0001 }), "fail");
    assert.equal(status({ type: "cost", max_cost: 1 }, { turn: { ...turn, metrics: { ms: 1 } } }), "error");
  });

  it("thinking.present (and { on: thinking, type: present }): returned or not; required with hidden thinking fails", () => {
    assert.equal(status({ type: "thinking.present" }), "pass");
    assert.equal(status({ on: "thinking", type: "present" }), "pass");
    assert.equal(status({ type: "thinking.present" }, { turn: { ...turn, thinking: [] } }), "fail");
    const hidden = { turn: { ...turn, thinking: [{ text: "", visibility: "redacted" }] } };
    assert.equal(status({ type: "thinking.present" }, hidden), "pass");
    assert.equal(status({ type: "thinking.present", required: true }, hidden), "fail");
  });

  it("tool.called: the tool, with those arguments, that many times", () => {
    assert.equal(status({ type: "tool.called", tool: "lookup_order" }), "pass");
    assert.equal(status({ type: "tool.called", tool: "refund" }), "fail");
    assert.match(reason({ type: "tool.called", tool: "refund" }), /refund wasn't called \(called: lookup_order, notify, lookup_order\)/);
    assert.equal(status({ type: "tool.called", tool: "lookup_order", args: { "$.order_id": 4418 } }), "pass", "any call with those arguments");
    assert.equal(status({ type: "tool.called", tool: "lookup_order", times: 2 }), "pass");
    assert.equal(status({ type: "tool.called", tool: "lookup_order", times: 1 }), "fail");
    assert.match(reason({ type: "tool.called", tool: "lookup_order", times: 1 }), /called 2 times, not 1/);
    assert.equal(status({ type: "tool.called", tool: "lookup_order", args: { "$.order_id": 4417 }, times: 1 }), "pass", "times counts the calls with those arguments");
    assert.equal(status({ type: "tool.called", tool: "notify", times: 2 }), "fail");
  });

  it("tool.not_called: it wasn't (and says how many times it was)", () => {
    assert.equal(status({ type: "tool.not_called", tool: "delete_account" }), "pass");
    assert.equal(status({ type: "tool.not_called", tool: "lookup_order" }), "fail");
    assert.match(reason({ type: "tool.not_called", tool: "lookup_order" }), /called 2 times/);
  });

  it("tool.order: exact, in_order (others allowed between) and any_order", () => {
    assert.equal(status({ type: "tool.order", order: ["lookup_order", "notify", "lookup_order"], match: "exact" }), "pass");
    assert.equal(status({ type: "tool.order", order: ["lookup_order", "notify"], match: "exact" }), "fail");
    assert.equal(status({ type: "tool.order", order: ["lookup_order", "lookup_order"], match: "in_order" }), "pass", "notify between is allowed");
    assert.equal(status({ type: "tool.order", order: ["lookup_order", "lookup_order"] }), "pass", "in_order is the default");
    assert.equal(status({ type: "tool.order", order: ["notify", "notify"], match: "in_order" }), "fail");
    assert.equal(status({ type: "tool.order", order: ["notify", "lookup_order"], match: "any_order" }), "pass");
    assert.equal(status({ type: "tool.order", order: ["notify", "refund"], match: "any_order" }), "fail");
  });

  it("sequence: the events in that order, others between ignored; tool_call:<name> and tool_result", () => {
    assert.equal(status({ type: "sequence", value: ["thinking", "tool_call:lookup_order", "tool_result", "text"] }), "pass");
    assert.equal(status({ type: "sequence", value: ["thinking", "text"] }), "pass");
    assert.equal(status({ type: "sequence", value: ["tool_call:notify"] }), "fail");
    assert.equal(status({ type: "sequence", value: ["text", "thinking"] }), "fail");
  });

  it("an unknown type, or a check with neither a type nor an operator, is an error", () => {
    assert.equal(status({ type: "contians", value: "x" }), "error");
    assert.match(reason({ type: "contians", value: "x" }), /"contians" isn't a check type/);
  });
});

describe("what a check looks at (docs/checks.md, on)", () => {
  it("on: turn is { user, reply, thinking, tool_calls, usage, metrics }", () => {
    assert.equal(status({ on: "turn", path: "$.user", contains: "4417" }), "pass");
    assert.equal(status({ on: "turn", path: "$.usage.output", equals: 40 }), "pass");
    assert.equal(status({ on: "turn", path: "$.metrics.ms", lt: 1000 }), "pass");
    assert.equal(status({ on: "turn", path: "$.thinking", contains: "order up" }), "pass");
    assert.equal(status({ on: "turn", path: "$.tool_calls[*].name", contains: "notify" }), "pass");
  });

  it("on: tools is the tool calls in order; on: events is the events in order", () => {
    assert.equal(status({ on: "tools", path: "$[0].name", equals: "lookup_order" }), "pass");
    assert.equal(status({ on: "tools", path: "$[*].args.channel", equals: "email" }), "pass");
    assert.equal(status({ on: "events", path: "$[1].name", equals: "lookup_order" }), "pass");
    assert.equal(status({ on: "events", path: "$[*].type", contains: "tool_result" }), "pass");
  });

  it("on: thinking reads its text; hidden or missing thinking skips it (fails when required)", () => {
    assert.equal(status({ on: "thinking", contains: "order up" }), "pass");
    assert.equal(status({ on: "thinking", contains: "x" }, { turn: { ...turn, thinking: [] } }), "skipped");
    assert.match(reason({ on: "thinking", contains: "x" }, { turn: { ...turn, thinking: [] } }), /thinking not returned/);
    assert.equal(status({ on: "thinking", contains: "x", required: true }, { turn: { ...turn, thinking: [] } }), "fail");
  });

  it("on: something that isn't an input is an error", () => {
    assert.equal(status({ on: "headers", contains: "x" }), "error");
    assert.match(reason({ on: "headers", contains: "x" }), /"headers" isn't something a check can look at/);
  });
});
