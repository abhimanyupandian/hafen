// What a scope is, as the app and the engine agree on it (contracts/ui.md, Head): a scope's name, a
// value's or a secret's name, the names no scope can take, and the values a scope gives once Globals'
// are under its own. No DOM and no storage: the app's tests run it in Node.
//
// Globals are what applies in every scope: values and secrets kept as a scope's are, but in no scope
// (""). A name both have is the scope's (it overrides Globals'); one only Globals has is Globals'; one
// only the scope has, the scope's. With no scope chosen, Globals' are all there is.

import { NAME, NAME_RULE as RULE } from "hafen/engine/env-file.js";

// A value's or a secret's name: the engine's, as a .env file, {{env.NAME}} and {{secret.NAME}} have it
// (engine/env-file.js), so a file the command line reads is one the app reads too; said in its words
export { NAME };
export const NAME_RULE = `A name is ${RULE}.`;

export const SCOPE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const SCOPE_RULE = "A scope's name is letters, digits, '.', '-' and '_'.";

// Names no scope can have: Globals' (its files are globals.env and globals.secret.env), and what it was
// called before (every scope). Nor can one end .secret: its values' file, <name>.env, would be another
// scope's secrets file. (Case aside: a disk that ignores it would have them meet all the same.)
export const RESERVED = ["globals", "global", "every-scope"];

// Why a scope can't have this name (taken: the names the app has already), or "" when it can
export function scopeNameProblem(name, taken = []) {
  if (!SCOPE_NAME.test(name)) return SCOPE_RULE;
  if (RESERVED.includes(name.toLowerCase())) return `"${name}" is Globals' name: a scope can't have it.`;
  if (/\.secret$/i.test(name)) return "A scope's name doesn't end .secret: its values' file would be a secrets file.";
  if (taken.includes(name)) return `There's a scope "${name}" already.`;
  return "";
}

// The values a scope gives ("" or null: none chosen, Globals' alone): Globals', with its own over them.
// What the engine is given, what the fields check, and what "not set" counts, all take them from here.
export function effectiveValues(scope, { globals = {}, scopes = [] } = {}) {
  if (!scope) return { ...globals };
  return { ...globals, ...(scopes.find((s) => s.name === scope)?.values ?? {}) };
}

// Where a name of an entry comes from, as its row says: "own" (only it has it), "override" (Globals has
// it too: the scope's is used), "globals" (only Globals has it: inherited). Globals' own rows are "own".
export function sourceOf(name, { scope, own = {}, globals = {} }) {
  const mine = Object.hasOwn(own, name);
  if (!scope) return "own";
  if (mine) return Object.hasOwn(globals, name) ? "override" : "own";
  return Object.hasOwn(globals, name) ? "globals" : null;
}

// A free name for a copy of a scope: <name>-copy, then <name>-copy-2…
export function copyName(name, taken = []) {
  for (let n = 1; n < 1000; n++) {
    const next = `${name}-copy${n === 1 ? "" : `-${n}`}`;
    if (!scopeNameProblem(next, taken)) return next;
  }
  throw new Error(`no free name for a copy of "${name}"`);
}
