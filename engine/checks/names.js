// A check's type and its short name (its badge), and the operators a check can have: all the app's page
// needs of checks to show them, so it doesn't carry what runs them (JSONPath, JSON Schema: the engine's,
// in its worker). checks/index.js gives these too.

import { short } from "../util.js";

export const OPERATORS = ["equals", "not_equals", "contains", "not_contains", "matches", "exists", "type_is", "min_length", "max_length", "lt", "lte", "gt", "gte", "schema"];

export const hasOperator = (check) => OPERATORS.some((op) => check[op] !== undefined);

// A check's type: its own, or `path` (a path and an operator), or `text` (an operator on the reply)
export function typeOf(check) {
  if (check.type === "present" && check.on === "thinking") return "thinking.present";
  if (check.type) return check.type;
  if (check.path) return "path";
  if (hasOperator(check)) return "text";
  return null;
}

export const fmtMs = (ms) => (ms === undefined ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

// A check's short name, for its badge and reports
export function describe(check) {
  if (check.name) return check.name;
  const type = typeOf(check);
  const op = () => {
    const parts = [];
    if (check.equals !== undefined) parts.push(`= ${short(check.equals, 30)}`);
    if (check.not_equals !== undefined) parts.push(`≠ ${short(check.not_equals, 30)}`);
    if (check.contains !== undefined) parts.push(`contains ${short(check.contains, 30)}`);
    if (check.not_contains !== undefined) parts.push(`doesn't contain ${short(check.not_contains, 30)}`);
    if (check.matches !== undefined) parts.push(`matches ${short(check.matches, 30)}`);
    if (check.exists !== undefined) parts.push(check.exists ? "exists" : "missing");
    if (check.type_is !== undefined) parts.push(`is ${check.type_is}`);
    if (check.min_length !== undefined) parts.push(`length ≥ ${check.min_length}`);
    if (check.max_length !== undefined) parts.push(`length ≤ ${check.max_length}`);
    for (const [k, s] of [["lt", "<"], ["lte", "≤"], ["gt", ">"], ["gte", "≥"]]) if (check[k] !== undefined) parts.push(`${s} ${check[k]}`);
    if (check.schema !== undefined) parts.push("matches schema");
    return parts.join(" ");
  };
  switch (type) {
    case "path": return `${check.path} ${op()}`;
    case "text": return `${check.on && check.on !== "reply" ? `${check.on} ` : ""}${op()}`;
    case "status": return `status ${check.equals ?? check.value ?? op()}`;
    case "contains": case "not_contains": case "matches":
      return `${check.on && check.on !== "reply" ? `${check.on} ` : ""}${type.replace("_", " ")} ${short(check.value ?? check[type], 30)}`;
    case "latency": return check.max_ms !== undefined ? `latency ≤ ${fmtMs(check.max_ms)}` : `first token ≤ ${fmtMs(check.first_token_ms)}`;
    case "length": return `length ${[check.min_length !== undefined && `≥ ${check.min_length}`, check.max_length !== undefined && `≤ ${check.max_length}`].filter(Boolean).join(" ")}`;
    case "json": return check.schema ? "JSON matching schema" : "is JSON";
    case "tokens": return `${check.on === "thinking" ? "thinking" : "output"} ≤ ${check.max_tokens} tokens`;
    case "cost": return `cost ≤ $${check.max_cost}`;
    case "thinking.present": return "thinking present";
    case "tool.called": return `called ${check.tool}`;
    case "tool.not_called": return `didn't call ${check.tool}`;
    case "tool.order": return `tools ${(check.order ?? []).join(" → ")}`;
    case "sequence": return `order ${(check.value ?? []).join(" → ")}`;
    case "systemone.noul": return "noul";
    case "systemone.choice": return "choice";
    case "systemone.score": return "score";
    case "judge": return Array.isArray(check.rubric) ? `judge: ${short(check.rubric[0], 24)}` : `judge: ${short(check.rubric ?? "", 24)}`;
    case "reference": return "same as reference";
    default: return type ?? "check";
  }
}
