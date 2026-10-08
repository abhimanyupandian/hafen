// Judged checks (contracts/checks.md): System One questions and LLM judges, with values, confidence
// and "unsure". A turn's System One questions that use the same judge are asked in one request. What
// a judge sees is exactly what the check selects, never shortened.

import { lacking, Skip, typeOf, valuesOf } from "../checks/index.js";
import { costOf } from "../turn.js";
import { createProvider } from "../providers/index.js";
import { judgeWithModel, referencePrompt, rubricPrompt } from "./llm.js";
import { ask, judgeAnswer, questionOf, shownRequest, systemOneRequest } from "./systemone.js";
import { callSteps } from "../calls.js";
import { pluginsWhere } from "../plugin-place.js";

export const DEFAULT_JUDGE = { kind: "systemone" };

// The judge a check names, from the suite's judges (default: `default`, else System One)
export function judgeFor(check, suite) {
  const name = check.judge ?? "default";
  const judge = suite?.judges?.[name];
  if (judge) return { name, ...judge };
  if (name === "default") {
    // Rubric and reference checks need a model; System One checks need System One
    return typeOf(check).startsWith("systemone.") ? { name, ...DEFAULT_JUDGE } : null;
  }
  return undefined;
}

// What a judge is given as text
function stateOf(check, ctx) {
  const values = valuesOf(check, ctx);
  const present = values.filter((v) => v !== undefined);
  if (!present.length) throw new Error(check.path ? "no match" : "nothing to judge");
  const one = present.length === 1 ? present[0] : present;
  return typeof one === "string" ? one : JSON.stringify(one, null, 2);
}

// Judge a turn's judged checks: [{ index, check }] → Map(index → result)
// (redact: the run's redactor, for what's shown of a judge's request)
export async function runJudged(items, ctx, { suite, scope, transport, signal, spans, parentFor, prices, plugins, redact }) {
  const out = new Map();
  const unsureBelow = (check) => check.unsure_below ?? ctx.settings?.unsure_below ?? 0.6;
  // A check's own confidence (contracts/checks.md, Confidence): it passes only when its value does and
  // the judge's confidence is above it, and it's never unsure (a judge that gave none: an error, as
  // the check can't say). Without one, a value that passes with a confidence below unsure_below is
  // unsure. A value that misses fails, whatever the confidence (low confidence never makes a failing
  // value unsure).
  const finish = (index, check, r) => {
    let status = r.pass ? "pass" : "fail";
    let reason = r.reason;
    const confidence = r.confidence !== undefined ? Math.round(r.confidence * 1000) / 1000 : undefined;
    if (typeof check.confidence === "number") {
      if (typeof r.confidence !== "number" || !Number.isFinite(r.confidence)) {
        status = "error";
        reason = `the judge gave no confidence, so confidence: ${check.confidence} can't be checked (${r.reason})`;
      } else if (confidence <= check.confidence) {
        status = "fail";
        reason = `${r.reason}${r.pass ? ", but" : ", and"} confidence ${confidence} isn't above ${check.confidence}`;
      }
    } else if (r.pass && r.confidence !== undefined && r.confidence < unsureBelow(check)) {
      status = "unsure";
      reason = `${r.reason}, but confidence ${confidence} is below ${unsureBelow(check)}`;
    }
    out.set(index, { status, reason, value: r.value, ...(confidence !== undefined ? { confidence } : {}), ...(r.actual !== undefined ? { actual: r.actual } : {}), judge: r.judge, ...(r.usage ? { usage: r.usage } : {}), ...(r.cost !== undefined ? { cost: r.cost } : {}) });
  };
  const fail = (index, message) => out.set(index, { status: "error", reason: message });

  // System One: grouped by judge
  const groups = new Map();
  for (const item of items) {
    const type = typeOf(item.check);
    if (!type.startsWith("systemone.")) continue;
    // (one without what its type needs isn't asked: an error, saying what)
    const lacks = lacking(item.check, suite?.judges);
    if (lacks) { fail(item.index, lacks); continue; }
    const judge = judgeFor(item.check, suite);
    if (!judge) { fail(item.index, `there's no judge named "${item.check.judge}"`); continue; }
    if (judge.kind !== "systemone") { fail(item.index, `the judge "${judge.name}" isn't a System One judge`); continue; }
    let state;
    try {
      state = stateOf(item.check, ctx);
      questionOf(item.check);
    } catch (err) {
      if (err instanceof Skip) out.set(item.index, { status: "skipped", reason: err.message });
      else if (err.fail) out.set(item.index, { status: "fail", reason: err.message });
      else fail(item.index, err.message);
      continue;
    }
    // Checks with the same input and judge share a request
    const key = `${judge.name}\u0000${state}`;
    if (!groups.has(key)) groups.set(key, { judge, state, items: [] });
    groups.get(key).items.push(item);
  }
  await Promise.all([...groups.values()].map(async ({ judge, state, items: group }) => {
    const questions = Object.fromEntries(group.map((it) => [`c${it.index}`, questionOf(it.check)]));
    // (ref.checks: the turn's checks it asks for, as the run has them)
    const callSpan = spans.start("judge_call", `system one · ${group.length} question${group.length === 1 ? "" : "s"}`, { parent: parentFor(group[0].index), ref: { checks: group.map((it) => it.index) } });
    try {
      // What's sent, all of it (its key hidden), on the call's step as it's sent: seen while it's asked
      const prepared = systemOneRequest({ judge, scope, state, questions });
      spans.update(callSpan, { request: shownRequest(prepared.request, redact) });
      const reply = await ask({ judge, scope, transport, signal, state, questions, prepared });
      spans.end(callSpan, "ok", { tokens: reply.usage });
      for (const it of group) {
        try {
          const r = judgeAnswer(it.check, reply.answers[`c${it.index}`]);
          finish(it.index, it.check, { ...r, judge: { kind: "systemone", endpoint: reply.endpoint, model: reply.model, raw: reply.answers[`c${it.index}`] } });
        } catch (err) {
          fail(it.index, err.message);
        }
      }
      const price = prices?.[reply.model];
      if (group.length) {
        const first = out.get(group[0].index);
        if (first) Object.assign(first, { usage: reply.usage, ...(price ? { cost: costOf(reply.usage, price) } : {}) });
      }
    } catch (err) {
      spans.end(callSpan, "error");
      for (const it of group) fail(it.index, err.message);
    }
  }));

  // LLM judges and reference checks: one at a time per check, in parallel across checks
  await Promise.all(items.filter((it) => ["judge", "reference"].includes(typeOf(it.check))).map(async ({ index, check }) => {
    const type = typeOf(check);
    const lacks = lacking(check, suite?.judges);
    if (lacks) return fail(index, lacks);
    const judge = judgeFor(check, suite);
    if (!judge) return fail(index, check.judge ? `there's no judge named "${check.judge}"` : "this check needs a judge: name an LLM judge (judges: { default: { kind: llm, provider: … } })");
    if (judge.kind !== "llm" && judge.kind !== "plugin") return fail(index, `the judge "${judge.name}" can't grade a rubric (it's ${judge.kind})`);
    let input;
    try {
      input = stateOf(check, ctx);
    } catch (err) {
      if (err instanceof Skip) return out.set(index, { status: "skipped", reason: err.message });
      if (err.fail) return out.set(index, { status: "fail", reason: err.message });
      return fail(index, err.message);
    }
    if (judge.kind === "plugin") {
      const plugin = plugins?.[judge.plugin];
      if (!plugin?.judge) return fail(index, `the judge plugin "${judge.plugin}" isn't in ${pluginsWhere()}`);
      const callSpan = spans.start("judge_call", judge.plugin, { parent: parentFor(index) });
      try {
        const r = await plugin.judge({ input, question: check.question ?? check.rubric, params: check, env: scope?.envValues?.() ?? {}, signal, onCall: callSteps(spans, callSpan), scope });
        spans.end(callSpan, "ok", r.usage ? { tokens: r.usage } : undefined);
        const min = check.min ?? 0.5;
        const pass = r.value >= min && r.value <= (check.max ?? Infinity);
        return finish(index, check, { pass, value: r.value, confidence: r.confidence, reason: r.reason ?? "", judge: { kind: "plugin", plugin: judge.plugin, raw: r.raw }, usage: r.usage });
      } catch (err) {
        spans.end(callSpan, "error");
        return fail(index, err.message);
      }
    }
    const providerConfig = suite?.providers?.[judge.provider];
    if (!providerConfig) return fail(index, `the judge "${judge.name}" names the provider "${judge.provider}", which the suite doesn't have`);
    let provider;
    try {
      const config = judge.temperature !== undefined && providerConfig.kind !== "http" ? { ...providerConfig, params: { ...(providerConfig.params ?? {}), temperature: judge.temperature } } : providerConfig;
      provider = createProvider(config, { plugins });
    } catch (err) {
      return fail(index, err.message);
    }
    const criteria = type === "reference" ? ["same meaning as the reference"] : Array.isArray(check.rubric) ? check.rubric : [check.rubric].filter(Boolean);
    const prompt = type === "reference"
      ? referencePrompt({ reference: scope.resolve(check.reference), input })
      : rubricPrompt({ criteria, input, context: (check.on ?? "reply") === "reply" ? ctx.turn.user : null });
    const min = check.min ?? (type === "reference" ? 0.8 : 1);
    try {
      const r = await judgeWithModel({
        provider, prompt, count: criteria.length, min, samples: check.samples ?? judge.samples ?? 3, scope, transport, signal,
        onCall: async (call, sample, attempt) => {
          const span = spans.start("judge_call", `${judge.provider} · sample ${sample + 1}${attempt ? " (again)" : ""}`, { parent: parentFor(index) });
          const reply = await call();
          spans.end(span, reply.error ? "error" : "ok", { tokens: reply.usage });
          return reply;
        },
      });
      const price = providerConfig.price ?? prices?.[providerConfig.model];
      finish(index, check, { ...r, judge: { kind: "llm", provider: judge.provider, model: providerConfig.model, samples: r.samples }, ...(price ? { cost: costOf(r.usage, price) } : {}) });
    } catch (err) {
      fail(index, err.message);
    }
  }));

  return out;
}
