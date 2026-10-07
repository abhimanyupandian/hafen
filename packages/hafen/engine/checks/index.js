// Checks (contracts/checks.md): what a check looks at (`on`, `path`), the built-in rule checks, and a
// short name for each (its badge). Judged checks (System One, LLM judges) are in ../judges/.

import { first, select } from "../jsonpath.js";
import { short } from "../util.js";
import { typed } from "../vars.js";
import { describe, fmtMs, hasOperator, typeOf } from "./names.js";
import { characters, evaluate, OPERATORS, regex, same } from "./operators.js";

// (What names a check, its type and its short name, is in names.js, which the app's page uses on its
// own: it has none of the libraries running a check needs)
export { describe, typeOf } from "./names.js";

export const JUDGED = ["systemone.noul", "systemone.choice", "systemone.score", "judge", "reference"];

export const isJudged = (check) => JUDGED.includes(typeOf(check));

// Whether a check's type is one of Hafen's own (else a check plugin's, by its name)
export const isBuiltIn = (check) => {
  const type = typeOf(check);
  return type === null || Object.prototype.hasOwnProperty.call(RULES, type) || JUDGED.includes(type);
};

export class Skip extends Error {}
export class CheckError extends Error {}

// What `on` selects (contracts/checks.md, What a check looks at). A test's checks on the whole
// conversation (ctx.whole: expect_conversation) look at the conversation unless they say otherwise.
export function inputOf(check, ctx) {
  const on = check.on ?? (ctx.whole ? "conversation" : check.path ? "response" : "reply");
  const { turn } = ctx;
  switch (on) {
    case "reply":
      return turn.reply ?? "";
    case "response":
      // The parsed body (one JSON reply), or the assembled response (a stream)
      return ctx.response ?? turn.reply ?? "";
    case "thinking":
      return thinkingText(check, turn);
    case "turn":
      return {
        user: turn.user,
        reply: turn.reply,
        thinking: (turn.thinking ?? []).map((t) => t.text).join(""),
        tool_calls: turn.tool_calls ?? [],
        usage: turn.usage ?? null,
        metrics: turn.metrics ?? {},
      };
    case "events":
      return turn.events ?? [];
    case "tools":
      return turn.tool_calls ?? [];
    case "conversation":
      return (ctx.conversation ?? []).map((t) => ({ user: t.user, reply: t.reply, thinking: (t.thinking ?? []).map((x) => x.text).join(""), tool_calls: t.tool_calls ?? [] }));
    default:
      throw new CheckError(`"${on}" isn't something a check can look at`);
  }
}

// Thinking a check can read: skipped (or failed, when required) if it was hidden or never returned
function thinkingText(check, turn) {
  const readable = (turn.thinking ?? []).filter((t) => !["omitted", "redacted"].includes(t.visibility) && t.text);
  if (!readable.length) {
    const why = (turn.thinking ?? []).length ? `thinking ${(turn.thinking ?? []).map((t) => t.visibility).filter((v, i, a) => a.indexOf(v) === i).join(" and ")}` : "thinking not returned";
    if (check.required) throw Object.assign(new CheckError(why), { fail: true });
    throw new Skip(why);
  }
  return readable.map((t) => t.text).join("");
}

// The values a check tests: its path's matches in the input, or the input itself
export function valuesOf(check, ctx) {
  const input = inputOf(check, ctx);
  if (!check.path) return [input];
  if (input === null || typeof input !== "object") {
    throw new CheckError(check.on === "response" || check.on === undefined ? "the response isn't JSON" : `${check.on ?? "the input"} isn't JSON`);
  }
  return select(check.path, input);
}

// Run one rule check: { status, reason, actual?, expected? }
export function runRule(check, ctx) {
  const type = typeOf(check);
  try {
    const rule = RULES[type];
    if (!rule) throw new CheckError(type ? `"${type}" isn't a check type` : "the check has no type and no operator");
    const out = rule(check, ctx);
    return { status: out.pass ? "pass" : "fail", reason: out.why, ...(out.actual !== undefined ? { actual: out.actual } : {}), ...(out.expected !== undefined ? { expected: out.expected } : {}) };
  } catch (err) {
    if (err instanceof Skip) return { status: "skipped", reason: err.message };
    if (err.fail) return { status: "fail", reason: err.message };
    return { status: "error", reason: err.message };
  }
}

const expectedOf = (check) => {
  const ops = OPERATORS.filter((op) => check[op] !== undefined);
  return ops.length === 1 ? check[ops[0]] : Object.fromEntries(ops.map((op) => [op, check[op]]));
};

const RULES = {
  path(check, ctx) {
    return { ...evaluate(check, valuesOf(check, ctx)), expected: expectedOf(check) };
  },
  text(check, ctx) {
    return { ...evaluate(check, valuesOf(check, ctx)), expected: expectedOf(check) };
  },
  status(check, ctx) {
    const status = ctx.turn.response?.status;
    if (status === undefined || status === 101) throw new CheckError(status === 101 ? "a WebSocket turn has no HTTP status" : "there's no response status");
    const ops = hasOperator(check) ? check : { equals: check.value ?? 200 };
    return { ...evaluate(ops, [status]), expected: expectedOf(ops) };
  },
  contains: (check, ctx) => textRule(check, ctx, "contains"),
  not_contains: (check, ctx) => textRule(check, ctx, "not_contains"),
  matches: (check, ctx) => textRule(check, ctx, "matches"),
  latency(check, ctx) {
    const m = ctx.turn.metrics ?? {};
    const parts = [];
    let pass = true;
    if (check.max_ms !== undefined) {
      const ok = m.ms <= check.max_ms;
      pass &&= ok;
      parts.push(`${fmtMs(m.ms)} ${ok ? "≤" : ">"} ${fmtMs(check.max_ms)}`);
    }
    if (check.first_token_ms !== undefined) {
      if (m.ttft_ms === undefined) throw new CheckError("no time to first token was measured");
      const ok = m.ttft_ms <= check.first_token_ms;
      pass &&= ok;
      parts.push(`first token ${fmtMs(m.ttft_ms)} ${ok ? "≤" : ">"} ${fmtMs(check.first_token_ms)}`);
    }
    if (!parts.length) throw new CheckError("a latency check needs max_ms or first_token_ms");
    return { pass, why: parts.join(", "), actual: m.ms, expected: check.max_ms ?? check.first_token_ms };
  },
  length(check, ctx) {
    const text = ctx.turn.reply ?? "";
    return { ...evaluate({ min_length: check.min_length, max_length: check.max_length }, [text]), actual: characters(text) };
  },
  json(check, ctx) {
    let parsed;
    try {
      parsed = JSON.parse(ctx.turn.reply ?? "");
    } catch (err) {
      return { pass: false, why: `the reply isn't JSON: ${err.message}` };
    }
    if (!check.schema) return { pass: true, why: "the reply is JSON" };
    return evaluate({ schema: check.schema }, [parsed]);
  },
  tokens(check, ctx) {
    const usage = ctx.turn.usage ?? {};
    const field = check.on === "thinking" ? "thinking" : "output";
    const n = usage[field];
    if (n === undefined) throw new CheckError(`the provider didn't report ${field} tokens`);
    if (check.max_tokens === undefined) throw new CheckError("a tokens check needs max_tokens");
    const pass = n <= check.max_tokens;
    return { pass, why: `${n} ${field} tokens ${pass ? "≤" : ">"} ${check.max_tokens}`, actual: n, expected: check.max_tokens };
  },
  cost(check, ctx) {
    const cost = ctx.turn.metrics?.cost;
    if (cost === undefined) throw new CheckError("no price is set for this model, so the cost is unknown");
    const pass = cost <= check.max_cost;
    return { pass, why: `${usd(cost)} ${pass ? "≤" : ">"} ${usd(check.max_cost)}`, actual: cost, expected: check.max_cost };
  },
  "thinking.present"(check, ctx) {
    const thinking = ctx.turn.thinking ?? [];
    if (!thinking.length) return { pass: false, why: "the model didn't think (no thinking was reported)" };
    const kinds = [...new Set(thinking.map((t) => t.visibility))].join(" and ");
    if (check.required && thinking.every((t) => ["omitted", "redacted"].includes(t.visibility))) return { pass: false, why: `thinking happened but was ${kinds}` };
    return { pass: true, why: `thinking returned (${kinds})` };
  },
  "tool.called"(check, ctx) {
    const calls = (ctx.turn.tool_calls ?? []).filter((c) => c.name === check.tool);
    if (!calls.length) return { pass: false, why: `${check.tool} wasn't called${ctx.turn.tool_calls?.length ? ` (called: ${ctx.turn.tool_calls.map((c) => c.name).join(", ")})` : ""}` };
    const matching = check.args ? calls.filter((c) => argsMatch(check.args, c.args)) : calls;
    if (check.args && !matching.length) {
      const [path, want] = Object.entries(check.args).find(([p, v]) => !calls.some((c) => same(first(p, c.args ?? {}), typed(v)))) ?? Object.entries(check.args)[0];
      return { pass: false, why: `${check.tool} was called, but ${path} was ${short(first(path, calls[0].args ?? {}))}, not ${short(want)}`, actual: calls.map((c) => c.args) };
    }
    if (check.times !== undefined && matching.length !== check.times) return { pass: false, why: `${check.tool} was called ${matching.length} times, not ${check.times}` };
    return { pass: true, why: `${check.tool} was called${check.args ? " with those arguments" : ""}${matching.length > 1 ? ` (${matching.length} times)` : ""}` };
  },
  "tool.not_called"(check, ctx) {
    const n = (ctx.turn.tool_calls ?? []).filter((c) => c.name === check.tool).length;
    return { pass: n === 0, why: n ? `${check.tool} was called ${n} time${n === 1 ? "" : "s"}` : `${check.tool} wasn't called` };
  },
  "tool.order"(check, ctx) {
    const names = (ctx.turn.tool_calls ?? []).map((c) => c.name);
    const want = check.order ?? [];
    const match = check.match ?? "in_order";
    let pass;
    if (match === "exact") pass = names.length === want.length && names.every((n, i) => n === want[i]);
    else if (match === "any_order") pass = want.every((n) => names.includes(n));
    else pass = isSubsequence(want, names);
    return { pass, why: `called ${names.length ? names.join(" → ") : "no tools"}${pass ? "" : `; wanted ${want.join(" → ")} (${match.replace("_", " ")})`}`, actual: names, expected: want };
  },
  sequence(check, ctx) {
    const kinds = (ctx.turn.events ?? []).filter((e) => ["thinking", "text", "tool_call", "tool_result"].includes(e.type));
    const want = Array.isArray(check.value) ? check.value : [];
    const had = kinds.map((e) => (e.type === "tool_call" ? `tool_call:${e.name}` : e.type));
    let at = 0;
    for (const item of had) if (at < want.length && (item === want[at] || (want[at] === "tool_call" && item.startsWith("tool_call:")))) at++;
    const pass = at === want.length;
    const seen = had.filter((k, i) => k !== had[i - 1]);
    return { pass, why: `happened: ${seen.join(" → ") || "nothing"}${pass ? "" : `; wanted ${want.join(" → ")}`}`, actual: seen, expected: want };
  },
};

// Every check type Hafen has (a type that isn't one is a check plugin's, or a mistake)
export const CHECK_TYPES = [...Object.keys(RULES), ...JUDGED];

// A cost in a reason: every digit it has (a cost is to the millionth of a dollar), at least to the
// cent: $0.000017 > $0.000001, never $0.0000
function usd(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return `$${n}`;
  const text = n.toFixed(Math.min(20, Math.max(6, 1 - Math.floor(Math.log10(Math.abs(n) || 1))))).replace(/0+$/, "");
  return `$${text.replace(/\.(\d?)$/, (_, d) => `.${d.padEnd(2, "0")}`)}`;
}

function textRule(check, ctx, op) {
  const value = check.value ?? check[op];
  return { ...evaluate({ [op]: value, ignore_case: check.ignore_case, all: check.all }, valuesOf(check, ctx)), expected: value };
}

function argsMatch(args, actual) {
  return Object.entries(args).every(([path, want]) => same(first(path, actual ?? {}), typed(want)));
}

function isSubsequence(want, have) {
  let at = 0;
  for (const item of have) if (item === want[at]) at++;
  return at === want.length;
}



export { regex };
