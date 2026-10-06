// The operators any check can use on the values it selects (contracts/checks.md, Operators). Each
// value passes when every operator on the check passes for it.

import { schemaProblem } from "../schema.js";
import { isObject, short } from "../util.js";
import { typed } from "../vars.js";

// (The operators' names, and whether a check has one, are in names.js, which the app's page uses)
import { hasOperator, OPERATORS } from "./names.js";

export { hasOperator, OPERATORS };

// Deep equality, where a number and a numeric string compare as numbers
export function same(a, b) {
  if (typeof a === "number" && typeof b === "string") return a === typed(b);
  if (typeof a === "string" && typeof b === "number") return typed(a) === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => same(a[k], b[k]));
  }
  return a === b;
}

export function regex(pattern) {
  const m = /^\/(.*)\/([dgimsuvy]*)$/s.exec(pattern);
  try {
    return m ? new RegExp(m[1], m[2]) : new RegExp(pattern);
  } catch (err) {
    throw new Error(`"${pattern}" isn't a valid regular expression: ${err.message}`);
  }
}

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const lengthOf = (v) => (typeof v === "string" || Array.isArray(v) ? v.length : isObject(v) ? Object.keys(v).length : undefined);
const asText = (v) => (typeof v === "string" ? v : JSON.stringify(v) ?? "");

// One value against one operator: { pass, why }
export function test(op, expected, value, { ignoreCase = false } = {}) {
  const fold = (s) => (ignoreCase ? s.toLowerCase() : s);
  switch (op) {
    case "equals":
      return { pass: same(value, expected), why: `${short(value)} ${same(value, expected) ? "=" : "≠"} ${short(expected)}` };
    case "not_equals":
      return { pass: !same(value, expected), why: `${short(value)} ${same(value, expected) ? "=" : "≠"} ${short(expected)}` };
    case "contains":
    case "not_contains": {
      let found;
      if (Array.isArray(value)) found = value.some((v) => same(v, expected) || (typeof v === "string" && typeof expected === "string" && fold(v) === fold(expected)));
      else found = fold(asText(value)).includes(fold(asText(expected)));
      const pass = op === "contains" ? found : !found;
      return { pass, why: `${found ? "found" : "didn't find"} ${short(expected)}` };
    }
    case "matches": {
      const pass = regex(expected).test(asText(value));
      return { pass, why: `${pass ? "matches" : "doesn't match"} ${expected}` };
    }
    case "type_is": {
      const t = typeOf(value);
      const pass = t === expected || (expected === "number" && t === "integer");
      return { pass, why: `is ${t}` };
    }
    case "min_length":
    case "max_length": {
      const n = lengthOf(value);
      if (n === undefined) return { pass: false, why: `has no length (${typeOf(value)})` };
      const pass = op === "min_length" ? n >= expected : n <= expected;
      return { pass, why: `length ${n} ${op === "min_length" ? (pass ? "≥" : "<") : pass ? "≤" : ">"} ${expected}` };
    }
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const n = typeof value === "number" ? value : typed(value);
      if (typeof n !== "number" || Number.isNaN(n)) return { pass: false, why: `${short(value)} isn't a number` };
      const pass = { lt: n < expected, lte: n <= expected, gt: n > expected, gte: n >= expected }[op];
      const sign = { lt: "<", lte: "≤", gt: ">", gte: "≥" }[op];
      return { pass, why: `${n} ${pass ? sign : `not ${sign}`} ${expected}` };
    }
    case "schema": {
      const problem = schemaProblem(expected, value);
      return { pass: !problem, why: problem ?? "matches the schema" };
    }
    default:
      throw new Error(`"${op}" isn't an operator`);
  }
}

// Every operator on `check` against a list of values (a path's matches): any value passing all of
// them passes, or with `all: true`, every value must. `exists` is about the list itself.
export function evaluate(check, values) {
  const ops = OPERATORS.filter((op) => op !== "exists" && check[op] !== undefined);
  const present = values.filter((v) => v !== undefined);
  if (check.exists !== undefined) {
    const exists = present.length > 0;
    if (exists !== check.exists) return { pass: false, why: exists ? `found ${present.length} match${present.length === 1 ? "" : "es"}` : "no match" };
    if (!ops.length) return { pass: true, why: exists ? `found ${present.length} match${present.length === 1 ? "" : "es"}` : "no match, as expected" };
  }
  if (!present.length) return { pass: false, why: "no match", actual: undefined };
  const results = present.map((value) => {
    const outcomes = ops.map((op) => test(op, check[op], value, { ignoreCase: check.ignore_case }));
    return { value, pass: outcomes.every((o) => o.pass), why: outcomes.map((o) => o.why).join(", ") };
  });
  const pass = check.all ? results.every((r) => r.pass) : results.some((r) => r.pass);
  const shown = check.all ? results.find((r) => !r.pass) ?? results[0] : results.find((r) => r.pass) ?? results[0];
  const many = present.length > 1 ? ` (${results.filter((r) => r.pass).length} of ${present.length} matches pass)` : "";
  return { pass, why: shown.why + many, actual: present.length === 1 ? present[0] : present };
}
