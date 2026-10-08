// Scopes as the app keeps them (contracts/ui.md, Scopes): a scope is a name, its environment values and
// its secrets, as the command line's --env file and --secret file are; the app keeps any number of them,
// to swap between, and the scope button chooses the one in use. Globals ("" here) are kept as a scope's
// are, for every scope, but are in no scope: lib/scopes.js says which wins.
//
// Environment values are plain text, kept in localStorage in both builds: eval.scopes (the scopes'
// names, in the order they were made), eval.scope.<name> (its values, one key a scope, so two scopes'
// values never mix) and eval.globals (Globals'). Secrets are kept apart, by scope ("" holds Globals'): in
// the desktop app, by its main process, encrypted with the system's keychain (safeStorage) when it can
// be, so the page holds one only while it's shown; in the browser build, in this browser's storage
// (eval.secrets), unencrypted, as the Secrets pane says. Nothing here reaches the engine: state.js passes
// it on.

import { envValueText } from "hafen/engine/env-file.js";
import { invoke, isApp } from "./app.js";
import { NAME, NAME_RULE, SCOPE_RULE, SCOPE_NAME, scopeNameProblem } from "./scopes.js";
import { KEYS, store } from "./store.js";

export { NAME, NAME_RULE, SCOPE_NAME, SCOPE_RULE };

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// A map's own text values only (nothing it inherits, nothing that isn't text)
const texts = (map) => (isMap(map) ? Object.fromEntries(Object.entries(map).filter(([, v]) => typeof v === "string")) : {});
const keyOf = (scope) => (scope ? KEYS.scope(scope) : KEYS.globals);
const badName = (values) => Object.keys(values).find((n) => !NAME.test(n));

/* ---------- environment values (localStorage) ---------- */

export const keptNames = () => store.getJSON(KEYS.scopes, []).filter((n) => typeof n === "string" && SCOPE_NAME.test(n));

// A scope's values ("": Globals'): { NAME: text }
export const valuesOf = (scope) => texts(store.getJSON(keyOf(scope), {}));

// Every scope the app keeps: [{ name, values }]
export const keptScopes = () => keptNames().map((name) => ({ name, values: valuesOf(name) }));

// A new scope, with no values yet
export function makeScope(name) {
  const problem = scopeNameProblem(name, keptNames());
  if (problem) throw new Error(problem);
  store.setJSON(KEYS.scopes, [...keptNames(), name]);
  return name;
}

// Each of `values` set in a scope ("": Globals; null takes one out); a scope's made if it isn't kept
// yet. Names that won't do are refused before anything is written.
export function setValues(scope, values) {
  if (scope && !SCOPE_NAME.test(scope)) throw new Error(SCOPE_RULE);
  const bad = badName(values);
  if (bad !== undefined) throw new Error(`"${bad}": ${NAME_RULE}`);
  if (scope && !keptNames().includes(scope)) store.setJSON(KEYS.scopes, [...keptNames(), scope]);
  const next = valuesOf(scope);
  for (const [name, value] of Object.entries(values)) {
    if (value === null || value === undefined) delete next[name];
    else next[name] = String(value);
  }
  store.setJSON(keyOf(scope), next);
}

// A scope's values ("": Globals') replaced by these (its text edited as a whole)
export function replaceValues(scope, values) {
  const gone = Object.fromEntries(Object.keys(valuesOf(scope)).filter((n) => !Object.hasOwn(values, n)).map((n) => [n, null]));
  setValues(scope, { ...gone, ...values });
}

export function renameKept(from, to) {
  if (!keptNames().includes(from)) return;
  store.setJSON(KEYS.scopes, keptNames().map((n) => (n === from ? to : n)));
  store.setJSON(KEYS.scope(to), valuesOf(from));
  store.remove(KEYS.scope(from));
}

// A new scope with another's values, after it in the list
export function copyKept(from, to) {
  const problem = scopeNameProblem(to, keptNames());
  if (problem) throw new Error(problem);
  const names = keptNames();
  const at = names.indexOf(from);
  store.setJSON(KEYS.scopes, at === -1 ? [...names, to] : [...names.slice(0, at + 1), to, ...names.slice(at + 1)]);
  store.setJSON(KEYS.scope(to), valuesOf(from));
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

// What heads an entry's .env file ("": Globals')
export const valuesComment = (scope, file) => `${scope ? `The "${scope}" scope's` : "Globals'"} environment values, from Hafen.\nIn CI: hafen run … ${scope ? "--env globals.env " : ""}--env ${file}`;

// A file to save, in a browser (and the desktop app's window, which asks where)
export function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- secrets (the desktop app's main process, or this browser's storage) ---------- */

// The browser build's secrets, by scope ("": Globals'): { scope: { NAME: value } }, own text values only
const browserSecrets = () => {
  const all = store.getJSON(KEYS.secrets, {});
  return isMap(all) ? Object.fromEntries(Object.entries(all).map(([env, names]) => [env, texts(names)])) : {};
};

// What's kept, never a value: { names: { scope: [NAME…] } (the ones that can be read; "" Globals'),
// unreadable: { scope: [NAME…] } (the desktop app's that can't be decrypted: under another keychain, or
// the system's gone), storage: { encrypted, plain } (the desktop app's: whether the system encrypts
// them; how many are kept unencrypted) or null (the browser build's, never encrypted) }
export async function secretState() {
  if (isApp) return invoke("secrets_state");
  const names = Object.fromEntries(Object.entries(browserSecrets()).map(([env, values]) => [env, Object.keys(values)]).filter(([, n]) => n.length));
  return { names, unreadable: {}, storage: null };
}

// The names a scope has secrets for (never their values)
export async function secretNames(env) {
  return (await secretState()).names[env] ?? [];
}

// Secrets set in a scope ("" Globals'): { NAME: value }, "" forgetting one
export async function keepSecrets(env, values) {
  const bad = badName(values);
  if (bad !== undefined) throw new Error(`"${bad}": ${NAME_RULE}`);
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

// A scope's secrets replaced by these (its text edited as a whole): the names not in it forgotten
export async function replaceSecrets(env, values) {
  const gone = Object.fromEntries((await secretNames(env)).filter((n) => !Object.hasOwn(values, n)).map((n) => [n, ""]));
  await keepSecrets(env, { ...gone, ...values });
}

// A scope's secrets' values (all of them, or `names`), for the page to show when asked: the desktop app's
// main process decrypts them for it then, and only then
export async function revealSecrets(env, names) {
  if (isApp) return (await invoke("secrets_reveal", { env, names })) ?? {};
  const own = browserSecrets()[env] ?? {};
  return names ? Object.fromEntries(names.filter((n) => Object.hasOwn(own, n)).map((n) => [n, own[n]])) : own;
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

// A scope's secrets kept for another too (the scope duplicated)
export async function copySecrets(from, to) {
  if (isApp) {
    await invoke("secrets_copy", { from, to });
    return;
  }
  const all = browserSecrets();
  if (!Object.keys(all[from] ?? {}).length) return;
  all[to] = { ...(all[to] ?? {}), ...all[from] };
  store.setJSON(KEYS.secrets, all);
}

// An entry's own secrets ("" Globals') written to a .env file, in plain text, as --secret reads it in CI
// (after Globals' file, for a scope). The desktop app's main process asks where and writes it, so the
// values never pass through the page; a browser downloads it. → the path written (desktop), true, or
// null when it was cancelled.
export async function exportSecrets(env, fileName) {
  if (isApp) return invoke("secrets_export", { env, file: fileName });
  download(fileName, envText(await secretValues(env), secretsComment(env)));
  return true;
}

// An entry's own secrets, as --secret reads them: the browser build's only (the desktop app's are
// written by its main process), for a file it writes when asked to, in plain text
export async function secretValues(env) {
  if (isApp) throw new Error("the desktop app's secrets are written by the app itself");
  return browserSecrets()[env] ?? {};
}

export const secretsComment = (env) => `${env ? `The "${env}" scope's own secrets` : "Globals' secrets"}, in plain text, from Hafen.\nKeep this file out of version control. In CI: hafen run … ${env ? "--secret globals.secret.env " : ""}--secret <this file>`;
