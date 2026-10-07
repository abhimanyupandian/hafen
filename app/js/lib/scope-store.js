// Scopes as the app keeps them (contracts/ui.md, Scopes): a scope is a name, its environment values and
// its secrets, as the command line's --env file and --secret file are; the app keeps any number of them,
// to swap between, and the scope button chooses the one in use.
//
// Environment values are plain text, kept in localStorage in both builds: eval.scopes (the scopes'
// names, in the order they were made) and eval.scope.<name> (its values), one key a scope, so two
// scopes' values never mix. Secrets are kept apart, by scope ("" holds the ones for every scope): in
// the desktop app, by its main process, encrypted with the system's keychain (safeStorage), so the page
// never holds them; in the browser build, in this browser's storage (eval.secrets), unencrypted, as the
// Secrets pane says. Nothing here reaches the engine: state.js passes it on.

import { envValueText } from "hafen/engine/env-file.js";
import { invoke, isApp } from "./app.js";
import { KEYS, store } from "./store.js";

// A scope's name; a value's name (as a .env file's: engine/env-file.js); a secret's (as an environment
// variable's, so CI can set it as one)
export const SCOPE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const VALUE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SCOPE_RULE = "A scope's name is letters, digits, '.', '-' and '_'.";
export const VALUE_RULE = "A value's name is letters, digits, '_', '.' and '-', and doesn't start with a digit.";
export const SECRET_RULE = "A secret's name is letters, digits and _, and doesn't start with a digit.";

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/* ---------- environment values (localStorage) ---------- */

export const keptNames = () => store.getJSON(KEYS.scopes, []).filter((n) => typeof n === "string" && SCOPE_NAME.test(n));

// A scope's values: { NAME: text }
export function valuesOf(name) {
  const values = store.getJSON(KEYS.scope(name), {});
  if (!isMap(values)) return {};
  return Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === "string"));
}

// Every scope the app keeps: [{ name, values }]
export const keptScopes = () => keptNames().map((name) => ({ name, values: valuesOf(name) }));

// A new scope, with no values yet
export function makeScope(name) {
  if (!SCOPE_NAME.test(name)) throw new Error(SCOPE_RULE);
  if (keptNames().includes(name)) throw new Error(`There's a scope "${name}" already.`);
  store.setJSON(KEYS.scopes, [...keptNames(), name]);
  return name;
}

// Each of `values` set in a scope (null takes one out); the scope's made if it isn't kept yet. Names
// that won't do are refused before anything is written.
export function setValues(scope, values) {
  if (!SCOPE_NAME.test(scope)) throw new Error(SCOPE_RULE);
  const bad = Object.keys(values).find((n) => !VALUE_NAME.test(n));
  if (bad !== undefined) throw new Error(`"${bad}": ${VALUE_RULE}`);
  if (!keptNames().includes(scope)) store.setJSON(KEYS.scopes, [...keptNames(), scope]);
  const next = valuesOf(scope);
  for (const [name, value] of Object.entries(values)) {
    if (value === null || value === undefined) delete next[name];
    else next[name] = String(value);
  }
  store.setJSON(KEYS.scope(scope), next);
}

// A scope's values replaced by these (its text edited as a whole)
export function replaceValues(scope, values) {
  const gone = Object.fromEntries(Object.keys(valuesOf(scope)).filter((n) => !(n in values)).map((n) => [n, null]));
  setValues(scope, { ...gone, ...values });
}

export function renameKept(from, to) {
  if (!keptNames().includes(from)) return;
  store.setJSON(KEYS.scopes, keptNames().map((n) => (n === from ? to : n)));
  store.setJSON(KEYS.scope(to), valuesOf(from));
  store.remove(KEYS.scope(from));
}

export function dropKept(name) {
  store.setJSON(KEYS.scopes, keptNames().filter((n) => n !== name));
  store.remove(KEYS.scope(name));
}

// Values as a .env file has them (engine/env-file.js reads it back the same): a comment, then a line each
export function envText(values, comment) {
  const lines = Object.entries(values).map(([name, value]) => `${name}=${envValueText(value)}`);
  return `${comment ? `${comment.split("\n").map((l) => `# ${l}`).join("\n")}\n` : ""}${lines.join("\n")}${lines.length ? "\n" : ""}`;
}

// A file to save, in a browser (and the desktop app's window, which asks where)
export function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- secrets (the desktop app's main process, or this browser's storage) ---------- */

const browserSecrets = () => {
  const all = store.getJSON(KEYS.secrets, {});
  return isMap(all) ? all : {};
};

// The scopes that have secrets ("" when some are kept for every scope)
export async function secretScopes() {
  if (isApp) return (await invoke("secrets_scopes")) ?? [];
  const all = browserSecrets();
  return Object.keys(all).filter((env) => Object.keys(all[env] ?? {}).length);
}

// The names a scope has secrets for (never their values)
export async function secretNames(env) {
  if (isApp) return Object.keys((await invoke("secrets_list", { env })) ?? {});
  return Object.keys(browserSecrets()[env] ?? {});
}

// Secrets set in a scope ("" every scope's): { NAME: value }, "" forgetting one
export async function keepSecrets(env, values) {
  const bad = Object.keys(values).find((n) => !SECRET_NAME.test(n));
  if (bad !== undefined) throw new Error(`"${bad}": ${SECRET_RULE}`);
  if (isApp) {
    await invoke("secrets_set_many", { env, values });
    return;
  }
  const all = browserSecrets();
  all[env] = { ...(all[env] ?? {}) };
  for (const [name, value] of Object.entries(values)) {
    if (value) all[env][name] = String(value);
    else delete all[env][name];
  }
  if (!Object.keys(all[env]).length && env) delete all[env];
  store.setJSON(KEYS.secrets, all);
}

// Every secret of a scope forgotten (the scope deleted)
export async function dropSecrets(env) {
  if (isApp) {
    await invoke("secrets_drop", { env });
    return;
  }
  const all = browserSecrets();
  delete all[env];
  store.setJSON(KEYS.secrets, all);
}

// A scope's secrets kept under its new name
export async function moveSecrets(from, to) {
  if (isApp) {
    await invoke("secrets_move", { from, to });
    return;
  }
  const all = browserSecrets();
  if (!all[from]) return;
  all[to] = { ...(all[to] ?? {}), ...all[from] };
  delete all[from];
  store.setJSON(KEYS.secrets, all);
}

// A scope's secrets written to a .env file, in plain text: what the scope uses (its own, over every
// scope's), as --secret reads it in CI. The desktop app's main process asks where and writes it, so the
// values never pass through the page; a browser downloads it. → the path written (desktop), true, or
// null when it was cancelled.
export async function exportSecrets(env, fileName) {
  if (isApp) return invoke("secrets_export", { env, file: fileName });
  const all = browserSecrets();
  const values = { ...(env ? all[""] ?? {} : {}), ...(all[env] ?? {}) };
  download(fileName, envText(values, secretsComment(env)));
  return true;
}

export const secretsComment = (env) => `${env ? `The "${env}" scope's secrets (with the ones kept for every scope)` : "The secrets kept for every scope"}, in plain text, from Hafen.\nKeep this file out of version control. In CI: hafen run … --secret <this file>`;
