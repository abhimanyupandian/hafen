// The app's scopes (lib/scope-store.js): their environment values and their secrets (kept by the
// desktop app, encrypted; or by this browser), made, renamed, copied and deleted.

import { audit } from "../lib/audit.js";
import * as kept from "../lib/scope-store.js";
import { copyName, scopeNameProblem } from "../lib/scopes.js";
import { envFile, secretFile } from "../lib/ci.js";
import { get, reconfigure, refreshSecrets, scopeNames, set, setEnv } from "../state.js";

/* ---------- the app's scopes: their environment values and their secrets ---------- */

// The scopes' values (and Globals') as kept now (after a change here, or in another window)
export function scopesChanged() {
  set({ scopes: kept.keptScopes(), globals: kept.valuesOf("") });
}
const scopeLabel = (scope) => scope || "globals";

// The browser build's engine holds the secrets it was given: it's given them again (the desktop app's
// main process gives its engine them itself, as they change)
export async function secretsChanged() {
  await reconfigure();
  await refreshSecrets();
}

export async function addScope(name) {
  const next = kept.makeScope(name.trim());
  scopesChanged();
  audit("scope.create", { scope: next });
  return next;
}

// A value set in a scope ("": Globals; null deletes it); the scope's kept from then on if it wasn't
export function setScopeValue(scope, name, value) {
  kept.setValues(scope, { [name]: value });
  scopesChanged();
  audit("scope.value", { scope: scopeLabel(scope), name, action: value === null ? "delete" : "set" });
}

// Values from a .env file (or the entry's text edited as a whole: replace), into a scope ("": Globals)
export function importScopeValues(scope, values, { replace = false, from } = {}) {
  if (replace) kept.replaceValues(scope, values);
  else kept.setValues(scope, values);
  scopesChanged();
  audit("scope.import", { scope: scopeLabel(scope), names: Object.keys(values).length, from });
}

// An entry's own values as a .env file (<scope>.env, or globals.env: what --env reads in CI), downloaded
export function exportScopeValues(scope) {
  const values = kept.valuesOf(scope);
  const file = envFile(scope);
  kept.download(file, kept.envText(values, kept.valuesComment(scope, file)));
  audit("scope.export", { scope: scopeLabel(scope), names: Object.keys(values).length });
}

// A scope renamed: its values and its secrets go with it, and it stays chosen if it was
export async function renameScope(from, to) {
  const next = to.trim();
  if (next === from) return from;
  const problem = scopeNameProblem(next, scopeNames());
  if (problem) throw new Error(problem);
  await kept.moveSecrets(from, next);
  kept.renameKept(from, next);
  scopesChanged();
  if (get().env === from) setEnv(next);
  await secretsChanged();
  audit("scope.rename", { scope: from, to: next });
  return next;
}

// A copy of a scope, its values and its secrets, as <name>-copy (or -copy-2…), after it in the list
export async function duplicateScope(from) {
  const to = copyName(from, scopeNames());
  kept.copyKept(from, to);
  scopesChanged();
  await kept.copySecrets(from, to);
  await secretsChanged();
  audit("scope.duplicate", { scope: to, from });
  return to;
}

// A scope deleted, all of it: its secrets first (so one that can't be forgotten, the desktop app's
// secrets file unreadable say, leaves the scope as it was, and says why), then its entry and its
// values. Chosen, no scope is chosen after it. Nothing brings it back: the scopes are only the ones
// made here.
export async function deleteScope(scope) {
  await kept.dropSecrets(scope);
  kept.dropKept(scope);
  scopesChanged();
  if (get().env === scope) setEnv(null);
  await secretsChanged();
  audit("scope.delete", { scope });
}

// The secrets kept for a scope that no longer exists (kept before the scopes were only the ones made
// here: Settings → Secrets lists them by name, and nothing uses them), all forgotten when asked. A
// scope the app has is deleted whole, in Environments.
export async function deleteGoneScopeSecrets(scope) {
  if (!scope || scopeNames().includes(scope)) throw new Error(`"${scope}" is a scope of yours: delete it in Environments.`);
  const { names = {}, unreadable = {} } = await kept.secretState();
  await kept.dropSecrets(scope);
  // (their names and scope only: never a value)
  for (const name of [...(names[scope] ?? []), ...(unreadable[scope] ?? [])]) audit("config.secret", { name, env: scope, action: "forget" });
  await secretsChanged();
}

// Secrets kept in a scope ("" Globals'): { NAME: value }, "" forgetting one
export async function keepSecrets(env, values, { action } = {}) {
  await kept.keepSecrets(env, values);
  // (their names and scope only: never a value)
  for (const name of Object.keys(values)) audit("config.secret", { name, env: scopeLabel(env), action: action ?? (values[name] ? "set" : "forget") });
  await secretsChanged();
}

// A scope's secrets ("" Globals') replaced by these (edited as a whole): a name taken out is forgotten
export async function replaceSecrets(env, values) {
  const had = await kept.secretNames(env);
  await kept.replaceSecrets(env, values);
  for (const name of new Set([...had, ...Object.keys(values)])) audit("config.secret", { name, env: scopeLabel(env), action: Object.hasOwn(values, name) && values[name] ? "set" : "forget" });
  await secretsChanged();
}

// A scope's secrets' values ("" Globals'; all, or `names`), to show in Settings when asked to
export async function revealSecrets(env, names) {
  const values = await kept.revealSecrets(env, names);
  for (const name of Object.keys(values)) audit("config.secret", { name, env: scopeLabel(env), action: "show" });
  return values;
}

// An entry's own secrets ("" Globals') as a file (<scope>.secret.env, globals.secret.env), in plain text
export async function exportSecrets(env) {
  const file = secretFile(env);
  const written = await kept.exportSecrets(env, file);
  if (written) audit("scope.export.secrets", { scope: scopeLabel(env), file: typeof written === "string" ? written : file });
  return written;
}
