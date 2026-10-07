// System One judges (contracts/checks.md; research §14): TypeSafe's primitives (choice, score, noul)
// asked of a check's input through the System One API:
//
//   POST <endpoint>/v1/systemone  { state, model, questions } → { model, answers, usage }
//
// with the API key as a Bearer token. All the questions a turn asks one judge go in one request
// (they're answered independently). Verify against TypeSafe's current docs (docs.typesafe.ai).

import { textChunks } from "../util.js";

export const DEFAULT_ENDPOINT = "https://api.typesafe.ai";
export const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_SCORE_LEVELS = ["poor", "fair", "good", "excellent"];

// A check as a System One question
export function questionOf(check) {
  const type = check.type.slice("systemone.".length);
  const q = { type, instructions: check.question };
  if (type === "choice") {
    const options = Array.isArray(check.options) ? check.options : Object.keys(check.options ?? {});
    if (options.length < 2) throw new Error("a choice needs at least two options");
    q.criteria = Array.isArray(check.options) ? Object.fromEntries(options.map((o) => [o, o])) : check.options;
  } else if (type === "score") {
    q.criteria = Array.isArray(check.rubric) && check.rubric.length >= 2 ? check.rubric : DEFAULT_SCORE_LEVELS;
  } else if (type === "noul" && check.criteria) {
    q.criteria = check.criteria;
  }
  if (!check.question) throw new Error("a System One check needs a question");
  return q;
}

// The request System One is asked with: { request (as it's sent: the key in it), endpoint, model }
export function systemOneRequest({ judge, scope, state, questions }) {
  const endpoint = (judge.endpoint ? scope.resolve(judge.endpoint) : DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const key = judge.api_key === "" ? "" : scope.resolve(judge.api_key ?? "{{secret.JEV_API_KEY}}");
  const model = judge.model ? scope.resolve(judge.model) : DEFAULT_MODEL;
  const request = {
    url: `${endpoint}/v1/systemone`,
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ state, model, questions }),
  };
  return { request, endpoint, model };
}

// The request as it's shown (on its step, in the run's record, in the app): all of it, its body as
// the JSON it is, but its key: the authorization header hidden, and every secret value the run used
// (`redact`, the run's redactor) wherever it is
export function shownRequest(request, redact = (v) => v) {
  let body = request.body;
  try { body = JSON.parse(request.body); } catch {}
  const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k, k.toLowerCase() === "authorization" ? "[redacted]" : v]));
  return redact({ method: request.method, url: request.url, headers, body });
}

// Ask: { answers, usage, model }. Throws with the API's reason when it fails. (`prepared`: its request,
// made already by systemOneRequest)
export async function ask({ judge, scope, transport, signal, state, questions, prepared }) {
  const { endpoint, model, request } = prepared ?? systemOneRequest({ judge, scope, state, questions });
  const res = await transport.send(request, { signal });
  let text = "";
  for await (const t of textChunks(res.body)) text += t;
  let body = null;
  try { body = JSON.parse(text); } catch {}
  if (res.status >= 400 || !body) {
    const detail = body?.detail?.message ?? body?.detail ?? body?.error?.message ?? body?.error ?? text.slice(0, 200);
    throw new Error(`System One (${new URL(endpoint).host}) answered ${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  return { answers: body.answers ?? {}, usage: { input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0 }, model: body.model ?? model, endpoint };
}

// An answer as a check result: { pass, value, confidence, reason }
export function judgeAnswer(check, answer) {
  if (!answer) throw new Error("System One gave no answer to this question");
  const type = check.type.slice("systemone.".length);
  if (type === "noul") {
    const value = Number(answer.noul);
    if (!Number.isFinite(value)) throw new Error("System One's noul answer has no value");
    const min = check.min ?? 0.5;
    const max = check.max ?? 1;
    const confidence = Number.isFinite(answer.confidence) ? answer.confidence : Math.abs(value - 0.5) * 2;
    const pass = value >= min && value <= max;
    return { pass, value, confidence, reason: `${round(value)} ${pass ? "within" : "outside"} ${min}–${max}` };
  }
  if (type === "choice") {
    const chosen = answer.choice;
    const acceptable = Array.isArray(check.equals) ? check.equals : [check.equals];
    const p = answer.probabilities?.[chosen];
    const confidence = Number.isFinite(answer.confidence) ? answer.confidence : Number.isFinite(p) ? p : undefined;
    const pass = acceptable.includes(chosen);
    return { pass, value: p, confidence, reason: `chose "${chosen}"${pass ? "" : `, not ${acceptable.map((a) => `"${a}"`).join(" or ")}`}`, actual: chosen };
  }
  if (type === "score") {
    const value = Number(answer.score);
    if (!Number.isFinite(value)) throw new Error("System One's score answer has no value");
    const levels = Array.isArray(check.rubric) && check.rubric.length >= 2 ? check.rubric : DEFAULT_SCORE_LEVELS;
    const min = check.min ?? 0;
    const max = check.max ?? levels.length - 1;
    const p = answer.probabilities?.[String(Math.round(value))] ?? answer.probabilities?.[Math.round(value)];
    const confidence = Number.isFinite(answer.confidence) ? answer.confidence : Number.isFinite(p) ? p : undefined;
    const pass = value >= min && value <= max;
    const level = levels[Math.round(value)];
    return { pass, value, confidence, reason: `scored ${round(value)}${level ? ` (${level})` : ""}, ${pass ? "within" : "outside"} ${min}–${max}` };
  }
  throw new Error(`"${check.type}" isn't a System One check`);
}

const round = (n) => Math.round(n * 100) / 100;
