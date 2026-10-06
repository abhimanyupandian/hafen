// LLM judges (contracts/checks.md, LLM judge): a model asked, for each criterion of a rubric, whether
// the input meets it and why, answering in JSON. Sampled N times; the confidence is how many samples
// agree with the majority. An answer that isn't JSON is asked again once, then the check is an error.

import { collectReply } from "../turn.js";

export function rubricPrompt({ criteria, input, context }) {
  return [
    "You are grading text against criteria. For each criterion, decide whether the text meets it, and say why in one sentence.",
    'Answer with JSON only, exactly in this shape: {"criteria": [{"criterion": "<the criterion>", "met": true, "reason": "<why>"}]}',
    "",
    "Criteria:",
    ...criteria.map((c, i) => `${i + 1}. ${c}`),
    "",
    ...(context ? ["The message the text replies to:", "<<<", context, ">>>", ""] : []),
    "The text to grade:",
    "<<<",
    input,
    ">>>",
  ].join("\n");
}

export function referencePrompt({ reference, input }) {
  return [
    "Decide whether the text means the same as the reference answer: the same facts and the same conclusion, in any wording.",
    'Answer with JSON only, exactly in this shape: {"criteria": [{"criterion": "same meaning as the reference", "met": true, "reason": "<why>"}]}',
    "",
    "Reference answer:",
    "<<<",
    reference,
    ">>>",
    "",
    "The text:",
    "<<<",
    input,
    ">>>",
  ].join("\n");
}

// The first JSON object in a model's reply
export function parseVerdict(text, count) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("the judge didn't answer with JSON");
  const parsed = JSON.parse(text.slice(start, end + 1));
  const list = Array.isArray(parsed.criteria) ? parsed.criteria : null;
  if (!list || list.length !== count || list.some((c) => typeof c.met !== "boolean")) throw new Error(`the judge's JSON doesn't have ${count} criteria with "met"`);
  return list;
}

// Ask the judge `samples` times: { value, confidence, pass, reason, samples, usage }
export async function judgeWithModel({ provider, prompt, count, min, samples = 3, scope, transport, signal, onCall }) {
  const runs = [];
  const usage = { input: 0, output: 0 };
  for (let s = 0; s < samples; s++) {
    let verdict = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2 && !verdict; attempt++) {
      const reply = await onCall(() => collectReply(provider, { message: prompt, scope, transport, signal }), s, attempt);
      usage.input += reply.usage.input ?? 0;
      usage.output += reply.usage.output ?? 0;
      if (reply.error) throw new Error(`the judge failed: ${reply.error}`);
      try {
        verdict = parseVerdict(reply.text, count);
      } catch (err) {
        lastError = err;
      }
    }
    if (!verdict) throw lastError;
    const met = verdict.filter((c) => c.met).length;
    runs.push({ value: met / count, criteria: verdict });
  }
  // Each sample passes when its share of criteria met reaches `min`; the verdict is the majority's
  // (a tie fails), and the confidence is how many samples agree with it
  const value = runs.reduce((sum, r) => sum + r.value, 0) / runs.length;
  const verdicts = runs.map((r) => r.value >= min);
  const passing = verdicts.filter(Boolean).length;
  const pass = passing > runs.length / 2;
  const agreeing = pass ? passing : runs.length - passing;
  const unmet = runs.at(-1).criteria.filter((c) => !c.met);
  const reason = unmet.length ? unmet.map((c) => `not met: ${c.criterion} (${c.reason})`).join("; ") : `all ${count} criteria met`;
  return { value: Math.round(value * 100) / 100, confidence: agreeing / runs.length, pass, reason: `${agreeing}/${runs.length} samples agree · ${reason}`, samples: runs, usage };
}
