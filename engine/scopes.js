// Scopes (contracts/test-file.md, Scopes): named sets of values to switch between, as stage and prod,
// each with its plain variables in the folder (environments/<scope>.yml: a map of names to values,
// kept in version control) and its secrets kept by the app (or the environment, in CI). A suite uses
// them as {{scope.NAME}}; the scope is the one chosen (the app's picker, --env in CI).

import { parseText } from "./files/suite-file.js";
import { isObject } from "./util.js";

export const SCOPE_FILE = /^environments\/([A-Za-z0-9][A-Za-z0-9._-]*)\.(ya?ml|json)$/i;
export const scopeFile = (name) => `environments/${name}.yml`;

// A scope's variables: { name, file, values, errors } (values {} when it has no file: a scope named
// only by suites' environments, or by secrets)
export async function readScope(host, name) {
  if (!name) return null;
  for (const ext of ["yml", "yaml", "json"]) {
    const file = `environments/${name}.${ext}`;
    if (!(await host.files.exists(file))) continue;
    return scopeFrom(file, await host.files.read(file));
  }
  return { name, file: null, values: {}, errors: [] };
}

export function scopeFrom(file, text) {
  const name = file.match(SCOPE_FILE)?.[1] ?? file;
  const parsed = parseText(text, file);
  if (parsed.errors.length) return { name, file, values: {}, errors: parsed.errors };
  const data = parsed.data ?? {};
  if (!isObject(data)) return { name, file, values: {}, errors: [{ file, message: "a scope's file is a map of names to values" }] };
  return { name, file, values: data, errors: [] };
}

// Every scope with a file in the folder
export async function listScopes(host, files) {
  const out = [];
  for (const file of files.filter((f) => SCOPE_FILE.test(f)).sort()) out.push(scopeFrom(file, await host.files.read(file)));
  return out;
}
