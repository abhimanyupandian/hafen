// Checks (docs/checks.md): every operator and rule check, with the result states it can give; what a
// check looks at; what each type needs (a problem before anything is sent); and a check turned off.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { parse } from "yaml";
import { describe as name, lacking, runRule } from "../../engine/checks/index.js";
import { characters, evaluate, same } from "../../engine/checks/operators.js";
import { problemsFor, secretsNeeded } from "../../engine/files/needs.js";
import { loadSuite } from "../../engine/files/suite-file.js";
import { runJudged } from "../../engine/judges/index.js";
import { runSuites } from "../../engine/runner.js";
import { fakeTransport, memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
beforeEach(() => mock.reset());
after(() => mock.close());

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

describe("docs/checks.md, check by check", () => {
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

    it("status: an operator on the HTTP status (default equals); none is an error", () => {
      assert.equal(status({ type: "status", equals: 200 }), "pass");
      assert.equal(status({ type: "status", equals: 201 }), "fail");
      assert.equal(status({ type: "status", gte: 200, lt: 300 }), "pass");
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
});

describe("lengths in characters", () => {
  const ctx = (reply) => ({ turn: { reply } });

  it("a length check counts what a reader sees: accents, emoji and CJK are one each", () => {
    const reply = "You said: héllo 👋 日本";
    assert.equal(reply.length, 21, "UTF-16 code units");
    const r = runRule({ type: "length", max_length: 20 }, ctx(reply));
    assert.equal(r.status, "pass", r.reason);
    assert.equal(r.reason, "length 20 ≤ 20");
    assert.equal(r.actual, 20);
    const over = runRule({ type: "length", max_length: 19 }, ctx(reply));
    assert.equal(over.status, "fail");
    assert.equal(over.reason, "length 20 > 19");
    assert.equal(runRule({ type: "length", min_length: 21 }, ctx(reply)).status, "fail");
  });

  it("min_length and max_length on a string: grapheme clusters (a skin tone, a flag, a combining accent)", () => {
    assert.equal(characters("👋🏽"), 1);
    assert.equal(characters("🇯🇵"), 1);
    assert.equal(characters("é"), 1);
    assert.equal(characters("👨‍👩‍👧"), 1);
    assert.equal(characters(""), 0);
    assert.equal(evaluate({ max_length: 3 }, ["👋🏽🇯🇵é"]).pass, true);
    assert.equal(evaluate({ min_length: 4 }, ["👋🏽🇯🇵é"]).why, "length 3 < 4");
    assert.equal(evaluate({ max_length: 5 }, ["hello"]).pass, true);
    assert.equal(evaluate({ max_length: 4 }, ["hello"]).pass, false);
  });

  it("an array still counts its items, an object its keys", () => {
    assert.equal(evaluate({ min_length: 2, max_length: 2 }, [["👋🏽", "日本語"]]).why, "length 2 ≥ 2, length 2 ≤ 2");
    assert.equal(evaluate({ max_length: 1 }, [{ a: 1, b: 2 }]).pass, false);
    assert.equal(evaluate({ max_length: 1 }, [42]).why, "has no length (integer)");
  });

  it("a tokens check still reads the reported usage, never the text", () => {
    const r = runRule({ type: "tokens", max_tokens: 3 }, { turn: { reply: "👋".repeat(50), usage: { output: 3 } } });
    assert.equal(r.status, "pass");
    assert.equal(r.reason, "3 output tokens ≤ 3");
  });
});

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

const PROVIDER = "kind: http\nurl: http://endpoint.example/chat\nbody: { message: \"{{user}}\" }\nresponse:\n  text: $.data.reply\n";

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

  it("can't stop a run: its unknown variable, its environment's value, its secret and its missing judge aren't asked for", async () => {
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
          - { type: judge, judge: nobody, rubric: x, enabled: false }
          - { path: "$[", exists: true, enabled: false }
`, "providers/json.yml": JSON_PROVIDER });
    const suite = await loadSuite(host, "s.hafen.yml");
    assert.deepEqual(suite.errors, []);
    assert.deepEqual(suite.missing.filter((m) => m.variable !== "base_url"), []);
    const { envNeeded, problemsFor, secretsNeeded } = await import("../../engine/files/needs.js");
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

  it("a turned-off System One check needs no key", async () => {
    const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    turns:\n      - user: hi\n        expect:\n          - { type: systemone.noul, question: q, enabled: false }\n", "providers/p.yml": PROVIDER });
    const suite = await loadSuite(host, "s.hafen.yml");
    assert.equal(secretsNeeded(suite).includes("JEV_API_KEY"), false);
    assert.deepEqual(problemsFor(suite, {}, () => undefined), []);
  });
});

describe("checks on the whole conversation", () => {
  const SECRET = "sk-very-secret-4242";

  async function run(files, { options = {}, secrets = { MY_KEY: SECRET }, file = "s.hafen.yml" } = {}) {
    const host = memoryHost(files, { secrets });
    const events = [];
    const suite = await loadSuite(host, file);
    assert.deepEqual(suite.errors, [], JSON.stringify(suite.errors));
    const out = await runSuites({ suites: [suite], host, options, onEvent: (e) => events.push(e) });
    return { run: out, events };
  }

  const files = (checks) => ({
    "providers/p.yml": `kind: http\nurl: "${mock.url}/json"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
    "s.hafen.yml": `version: 1
provider: providers/p.yml
judges:
  default: { kind: systemone, endpoint: "${mock.url}/systemone" }
tests:
  - name: t
    turns: [ { user: a refund for 4417 }, { user: thanks } ]
    expect_conversation:
${checks.map((c) => `      - ${c}`).join("\n")}
`,
  });

  it("look at every turn by default (a path into it, a judge given all of it); `on` still picks another input", async () => {
    const { run: r } = await run(files([
      '{ path: "$[*].reply", contains: "You said: thanks" }',
      '{ path: "$[0].user", equals: "a refund for 4417" }',
      '{ path: "$", max_length: 2 }',
      '{ type: systemone.noul, question: "Did it ask why?", min: 0.8 }',
      '{ on: reply, contains: "You said: thanks" }',
      '{ on: reply, contains: "why" }',
    ]), { secrets: { JEV_API_KEY: "jev-key-12345" } });
    const results = r.tests[0].instances[0].conversation_results;
    assert.deepEqual(results.map((x) => x.status), ["pass", "pass", "pass", "pass", "pass", "fail"], JSON.stringify(results));
    const state = mock.log.find((x) => x.path === "/systemone/v1/systemone").body.state;
    assert.match(state, /a refund for 4417/);
    assert.match(state, /You said: thanks/);
  });

  it("a turn's own checks still look at its reply", async () => {
    const { run: r } = await run({
      "providers/p.yml": `kind: http\nurl: "${mock.url}/json"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
      "s.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: t\n    turns:\n      - { user: hello, expect: [ { contains: \"You said: hello\" }, { path: $.data.order.id, equals: 4417 } ] }\n",
    });
    assert.deepEqual(r.turns[0].results.map((x) => x.status), ["pass", "pass"]);
  });
});
