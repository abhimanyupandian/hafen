// Running a turn's checks (contracts/checks.md): rule checks at once, a check plugin's in its worker,
// judged ones together; each a span on the timeline, and a result with a reason.

import { callSteps } from "../calls.js";
import { runJudged } from "../judges/index.js";
import { short } from "../util.js";
import { describe, isJudged, runRule, typeOf, valuesOf } from "./index.js";

// A turn failed when a check did, or an unsure result counts as failed (its unsure: fail, the default).
// One that counts as passed with a warning (warn) makes the test unsure; with pass, it passes quietly.
export const turnFailed = (results) => results.some((r) => r.status === "fail" || (r.status === "unsure" && r.unsure === "fail"));

export const warned = (results) => results.some((r) => r.status === "unsure" && r.unsure === "warn");

// A check turned off (enabled: false) is skipped, and says so (contracts/checks.md)
export const isOff = (check) => check?.enabled === false;

export const OFF = { status: "skipped", reason: "turned off (enabled: false)" };

// A turn's checks: rule checks at once, judged ones together (contracts/checks.md)
export async function runChecks(checks, checkCtx, ctx) {
  const { spans, parent } = ctx;
  const results = new Array(checks.length);
  const spanIds = [];
  const judged = [];
  const pluginChecks = [];
  // Variables in checks resolve first ({{row.want}}); one that can't is that check's error (one
  // turned off isn't looked at)
  const resolved = checks.map((check) => {
    if (isOff(check)) return { check };
    try {
      const out = ctx.scope ? ctx.scope.resolve(check) : check;
      // (a schema in a file: the one the suite read for it)
      const schema = typeof out.schema === "string" ? ctx.suite?.schemas?.[check.schema] : undefined;
      return { check: schema === undefined ? out : { ...out, schema } };
    } catch (err) {
      return { check, error: err.message };
    }
  });
  for (const [index, check] of checks.entries()) {
    const name = describe(check);
    spanIds[index] = spans.start("check", name, { parent, ref: { check: index } });
    if (isOff(check)) {
      results[index] = { ...OFF };
      continue;
    }
    // A turn the stop cut short: none of its checks can say anything of it (its latency and status
    // aren't the endpoint's). One that failed on its own still has its latency, status and events checked
    if (ctx.stopped) {
      results[index] = { status: "skipped", reason: "the run was stopped" };
      continue;
    }
    if (resolved[index].error) {
      results[index] = { status: "error", reason: resolved[index].error };
      continue;
    }
    if (ctx.error && !(check.on === "events" || typeOf(check) === "latency" || typeOf(check) === "status")) {
      results[index] = { status: "skipped", reason: `the turn failed: ${short(ctx.error, 120)}` };
      continue;
    }
    const plugin = ctx.plugins?.[typeOf(check)];
    if (plugin?.check) pluginChecks.push({ index, check: resolved[index].check, plugin });
    else if (isJudged(check)) judged.push({ index, check: resolved[index].check });
    else results[index] = runRule(resolved[index].check, checkCtx);
  }
  // A check plugin's checks (in its worker): given what the check's on/path selects
  for (const { index, check, plugin } of pluginChecks) {
    try {
      let value;
      try {
        const values = valuesOf(check, checkCtx);
        value = values.length === 1 ? values[0] : values;
      } catch (err) {
        results[index] = { status: "error", reason: err.message };
        continue;
      }
      const t = checkCtx.turn ?? {};
      const turn = { user: t.user, reply: t.reply, thinking: t.thinking, tool_calls: t.tool_calls, usage: t.usage, metrics: t.metrics, status: t.response?.status };
      const conversation = (checkCtx.conversation ?? []).map((x) => ({ user: x.user, reply: x.reply }));
      // (its HTTP calls: steps under the check)
      // (and the environment's values; its requests' {{secret.…}}s and {{env.…}}s from the turn's scope)
      const out = await plugin.check({ value, turn, conversation, params: check, env: ctx.scope?.envValues?.() ?? {} }, { signal: ctx.signal, onCall: callSteps(spans, spanIds[index]), ...(ctx.scope?.request ? { scope: ctx.scope } : {}) });
      const status = ["pass", "fail", "unsure", "skipped", "error"].includes(out?.status) ? out.status : "error";
      results[index] = {
        status, reason: out?.reason ?? (status === "error" ? "the plugin's check gave no status" : ""),
        ...(out?.value !== undefined ? { value: out.value } : {}), ...(out?.confidence !== undefined ? { confidence: out.confidence } : {}),
        ...(out?.actual !== undefined ? { actual: out.actual } : {}), ...(out?.expected !== undefined ? { expected: out.expected } : {}),
      };
    } catch (err) {
      results[index] = { status: "error", reason: err.message };
    }
  }
  if (judged.length) {
    const judgedResults = await runJudged(judged, checkCtx, {
      suite: ctx.suite, scope: ctx.scope, transport: ctx.host.transport, signal: ctx.signal, spans,
      parentFor: (index) => spanIds[index], prices: ctx.suitePrices, plugins: ctx.plugins, redact: ctx.redactor?.redact,
    });
    for (const [index, r] of judgedResults) results[index] = r;
  }
  // How an unsure result counts (unsure: fail, warn or pass), kept on it: the most specific says it,
  // --unsure over all, then the check's own, then the test's (its suite's defaults, Hafen's: fail)
  const unsureOf = (check) => ctx.options?.unsure || check?.unsure || checkCtx.settings?.unsure || "fail";
  return checks.map((check, index) => {
    const r = results[index] ?? { status: "error", reason: "the check didn't run" };
    const name = r.value !== undefined && typeof r.value === "number" && isJudged(check) ? `${describe(check)} ${round2(r.value)}` : describe(check);
    spans.end(spanIds[index], r.status, { ...(r.confidence !== undefined ? { confidence: r.confidence } : {}) });
    spans.update(spanIds[index], { name });
    return { check, name, ...r, ...(r.status === "unsure" ? { unsure: unsureOf(check) } : {}) };
  });
}

const round2 = (n) => Math.round(n * 100) / 100;

export function countChecks(results) {
  const c = { passed: 0, failed: 0, unsure: 0, skipped: 0, error: 0, total: results.length };
  for (const r of results) {
    if (r.status === "pass") c.passed++;
    else if (r.status === "fail") c.failed++;
    else if (r.status === "unsure") c.unsure++;
    else if (r.status === "skipped") c.skipped++;
    else c.error++;
  }
  return c;
}
