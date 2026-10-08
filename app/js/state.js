// What the app shows and what it can do: the suites, providers and plugins it keeps (its workspace,
// opened by itself on start: host.js), what's selected, the conversation being explored, the run
// going on (drawn live from the engine's events), and the runs kept in this browser. Views read `app`
// (a store) and call the actions here; nothing here parses, checks or times anything: the engine does
// (constitution II).

import { parseRun, runFileName, serializeRun } from "hafen/engine/reports/run-file.js";
import { RUN_KIND } from "hafen/engine/run-kind.js";
import { fixturesOf } from "hafen/engine/fixture-lists.js";
import { freeTestName, testId } from "hafen/engine/util.js";
import { createStore } from "./design/hooks.js";
import { connectEngine, newToken } from "./host.js";
import { isApp } from "./lib/app.js";
import { closeDrawer } from "./lib/dom.js";
import { emit } from "./lib/events.js";
import * as idb from "./lib/idb.js";
import { say } from "./lib/log.js";
import { audit, auditCall, auditEngineLog, auditEvent } from "./lib/audit.js";
import { pairTurns, refusedRun, runName, runOutcome, testResult, turnsOf } from "./views/derive.js";
import { KEYS, store } from "./lib/store.js";
import * as kept from "./lib/scope-store.js";
import { copyName, effectiveValues, scopeNameProblem } from "./lib/scopes.js";
import { envFile, secretFile } from "./lib/ci.js";
import { setRoute } from "./lib/url.js";
import { notify } from "./design/toast.jsx";
import { inFront, runEndActions } from "./lib/notifications.js";

// A suite's file: name.hafen.yml (or .yaml, .json), as the engine finds them
const SUITE_FILE = /\.hafen\.(ya?ml|json)$/i;

export const app = createStore({
  ready: false,
  suites: [],
  providers: [],
  env: kept.keptNames().includes(store.get(KEYS.env)) ? store.get(KEYS.env) : null,  // the scope chosen (null: none): one the app keeps
  selection: { kind: "conversation" },
  panelOpen: false,      // small screens: the panel shown over the thread (something selected, or asked for)
  conversation: null,    // { id, token, provider, run, title, sending, error }: id is its key where it's kept
  lives: [],             // the runs going on (any number at once): [{ token, run, scope: { file, test, id, untilTurn, onlyTurn } }]
  runs: [],              // runs kept here, newest first (summaries)
  openRun: null,         // a run opened from Runs (the whole of it)
  lastRuns: {},          // test key -> its latest run (whole)
  lastTries: {},         // test key -> its latest run that broke off before it (refused, a fixture that failed): no record of it
  lastSuiteRuns: {},     // suite file -> its latest run of the whole suite
  conversations: [],     // the conversations kept here: { _id, title, provider, started, updated, turns, size }
  scopes: kept.keptScopes(),  // the app's scopes and their environment values: [{ name, values }] (lib/scope-store.js)
  globals: kept.valuesOf(""),  // Globals' environment values, for every scope (lib/scopes.js: a scope's own win)
  secretScopes: [],      // the scopes that have secrets kept ("" is Globals')
  scopeSecrets: {},      // scope → the names of its secrets ("" Globals'), never a value: checked in fields, counted in Settings
  secretsUnreadable: {}, // scope → the names of its secrets that can't be decrypted (the desktop app's)
  secretsStorage: null,  // the desktop app's: { encrypted (the system encrypts them), plain (how many are kept unencrypted) }
  secretsVersion: 0,     // counts changes to the secrets (here, or in another tab): what shows their values reads them again
  relay: null,           // the relay's address, when served by `npm run serve`
  plugins: [],           // the plugins kept (plugins/*.js), loaded to say what each is: [{ file, name, kind, version, provides, error }]
  problems: {},          // suite file → what stops a run of it, as a run checks before sending anything (problemsOf)
  warnings: {},          // suite file → what that check warns of, beyond the file's own (warningsOf)
  showFixtures: store.get(KEYS.fixtures) !== "hidden",  // the fixtures' steps (timeline) and lines (console) shown
  exports: store.getJSON(KEYS.exports, {}),  // suite file → where it was last exported to (rememberExport)
  error: null,
});

// The providers a picker offers: the provider files kept, less one whose kind names a plugin that
// isn't a provider (a fixture, a check, a judge: not something to send messages to)
export function providerChoices({ providers, plugins = [] }) {
  const kinds = new Map(plugins.filter((p) => p.name).map((p) => [p.name, p.kind]));
  return providers.filter((p) => {
    const named = String(p.config?.kind ?? "").match(/^plugin:([^@]+)/)?.[1];
    return !named || !kinds.has(named) || kinds.get(named) === "provider";
  });
}

// A provider file's fixtures (the Fixtures field): its lists, written in its file in place (comments
// kept); null, the key goes
export async function setProviderFixtures(file, lists) {
  const had = get().providers.find((p) => p.file === file)?.config?.fixtures !== undefined;
  if (lists === null && !had) return;
  // (a list names each fixture once: never written twice)
  const twice = lists === null ? null : fixturesOf({ fixtures: lists }).duplicates[0];
  if (twice) throw new Error(twice.message);
  await engine.call("editFile", { file, edits: [lists === null ? { op: "delete", path: ["fixtures"] } : { op: "set", path: ["fixtures"], value: lists }] });
  await reload();
  audit("provider.fixtures", { file, fixtures: lists === null ? "none" : Object.entries(lists).filter(([, l]) => l.length).map(([k, l]) => `${k}:${l.join("+")}`).join(",") || "none" });
}

// Show or hide the fixtures, on the timeline and in the console (one choice, remembered)
export function setShowFixtures(show) {
  store.set(KEYS.fixtures, show ? "shown" : "hidden");
  set({ showFixtures: show });
}

let engine = null;
let loaded = false;  // the workspace has been read

const get = () => app.get();
const set = (changes) => app.set(changes);

/* ---------- starting: the workspace ---------- */

export async function start() {
  engine = await connectEngine({ onRestart: engineRestarted, onCall: auditCall, onLog: auditEngineLog });
  if (!isApp) {
    try {
      const res = await fetch("relay/ping");
      if (res.ok && (await res.json()).relay) set({ relay: new URL(".", location.href).href.replace(/\/$/, "") });
    } catch {}
    if (!get().relay) {
      const saved = store.get(KEYS.relay);
      if (saved) set({ relay: saved });
    }
  }
  // (Settings → Running's "tests at once" is gone: groups in the files say what runs at once)
  store.remove("eval.concurrency");
  // (a folder's scope files, the old way, aren't offered for import any more: what was answered goes)
  store.remove("eval.legacyScopes");
  await loadRuns();
  await loadConversations();
  // The scopes that have secrets, and the names of the chosen one's, known before the workspace is
  // read: a conversation's fields are checked against them
  await refreshSecrets().catch(() => {});
  // (another tab or window changed the scopes' values, Globals' or the browser build's secrets: this one
  // follows; the scope chosen here, deleted or renamed there, isn't chosen any more)
  window.addEventListener("storage", (e) => {
    const all = e.key === null;
    if (all || e.key === KEYS.scopes || e.key === KEYS.globals || e.key.startsWith(KEYS.scope(""))) {
      scopesChanged();
      if (get().env && !scopeNames().includes(get().env)) set({ env: null });
    }
    if (!isApp && (all || e.key === KEYS.secrets)) secretsChanged().catch(() => {});
  });
  await openWorkspace().catch((err) => {
    say(`couldn't open the app's workspace: ${err.message}`, "err");
    notify({ title: "Couldn't open your suites", text: err.message, kind: "error" });
  });
  set({ ready: true });
}

const secretsForBrowser = () => store.getJSON(KEYS.secrets, {});

// The desktop app's engine stopped and was started again: what it held (a run going on, the
// conversation) is gone, so it's cleared here, and the workspace is opened again
function engineRestarted() {
  say("the engine stopped unexpectedly and was started again", "err");
  notify({ title: "The engine was restarted", text: "A run or message going on was stopped. Your suites are open again.", kind: "error" });
  const c = get().conversation;
  set({ lives: [], conversation: c ? { ...c, token: newToken(), sending: false, error: null } : null });
  delete document.documentElement.dataset.running;
  openWorkspace().catch((err) => say(`couldn't open the app's workspace again: ${err.message}`, "err"));
}

// The app's workspace, where it keeps the suites, providers, plugins and data files (as plain files,
// as the command line reads them): the desktop app's data folder, or this browser's private file
// system. The engine opens it by itself; the browser build's is given the secrets and the relay.
async function openWorkspace() {
  const opened = await engine.call("open", isApp ? {} : { relay: get().relay, secrets: secretsForBrowser() });
  // (a browser that can't keep files: they're kept until the page closes, and it says so)
  if (!isApp && opened.root === null) {
    say("this browser can't keep files: your suites, providers and plugins are kept until the page closes (use the desktop app, or a browser that keeps them)", "err");
    notify({ title: "Your suites aren't kept", text: "This browser can't keep files: what you add is kept until the page closes.", kind: "error" });
  }
  setLoaded(opened);
}

function setLoaded({ suites, providers, plugins = [] }) {
  const envs = scopeNames();
  // (none chosen on purpose stays none; one never chosen: the first there is)
  const env = envs.includes(get().env) ? get().env : store.get(KEYS.env) === "" ? null : envs[0] ?? null;
  const first = !loaded;
  loaded = true;
  const sel = get().selection;
  const was = sel.file !== undefined && sel.test !== undefined ? testOf(sel.file, sel.test) : null;
  set({ suites, providers, env, plugins });
  refreshSecrets().catch(() => {});
  // The selection, where it is now: its test found by id (a file edited as a whole, or elsewhere,
  // may have moved it), its suite, or nothing
  if (sel.file !== undefined && !suites.some((s) => s.file === sel.file)) select({ kind: "conversation" });
  else if (was) {
    const index = (suiteOf(sel.file)?.data?.tests ?? []).findIndex((t) => (t.id ?? t.name) === (was.id ?? was.name));
    if (index === -1) select({ kind: "suite", file: sel.file });
    else if (index !== sel.test) set({ selection: { ...sel, test: index } });
  }
  // A conversation (or the remembered provider) whose provider file is gone
  const conversation = get().conversation;
  if (conversation?.provider && !providers.some((p) => p.file === conversation.provider)) {
    letGo(conversation?.token);
    set({ conversation: null });
  }
  if (store.get(KEYS.provider) && !providers.some((p) => p.file === store.get(KEYS.provider))) store.remove(KEYS.provider);
  emit("suites:changed");
  say(`${suites.length} suite${suites.length === 1 ? "" : "s"}, ${providers.length} provider${providers.length === 1 ? "" : "s"}`, "log");
  // (each suite's problems are logged once each, as the check finds them, not again with every read)
  set({ problems: Object.fromEntries(Object.entries(get().problems).filter(([file]) => suites.some((s) => s.file === file))) });
  for (const file of [...logged.keys()]) if (!suites.some((s) => s.file === file)) logged.delete(file);
  checkSuites(suites.map((s) => s.file));
  // The runs kept here, each named for the suites it ran (a run that broke off before its test: that
  // test, by its id), once the suites are known
  if (first) loadRuns();
}

/* ---------- a suite's problems, before it's run ---------- */

// Each suite is checked as a run checks it before sending anything (engine/runner.js, preflight: what
// `hafen validate` lists), a moment after it's read or edited, and when another scope is chosen: so a
// check type that isn't one (contians) shows in its Problems before it's run. One check at a time;
// files asked for meanwhile go in the next.
const toCheck = new Set();
let checkTimer = null;
let checking = false;
let checkedEnv;  // the scope (and its values) the last check was for
function checkSuites(files) {
  for (const f of files) toCheck.add(f);
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runChecks, 150);
}
async function runChecks() {
  if (checking || !toCheck.size || !engine) return;
  const files = [...toCheck].filter((f) => suiteOf(f));
  toCheck.clear();
  if (!files.length) return;
  checking = true;
  checkedEnv = scopeKey();
  try {
    const out = await engine.call("preflight", { files, ...scopeArgs() });
    const problems = { ...get().problems };
    const warnings = { ...get().warnings };
    for (const { file, problems: found, warnings: warned } of out) {
      if (!suiteOf(file)) continue;
      problems[file] = found;
      if (warned) warnings[file] = warned;
      logProblems(file, found);
    }
    set({ problems, warnings });
  } catch {
    // (it couldn't be checked: its file's own problems, as read, are what's known)
    for (const f of files) logProblems(f, suiteOf(f)?.errors ?? []);
  } finally {
    checking = false;
    if (toCheck.size) checkTimer = setTimeout(runChecks, 0);
  }
}
// Another scope chosen, or its values (or Globals') changed: what a run would find can differ. (Worked
// out again only when one of them is another object: the store changes far more often than they do.)
let keyFor = { env: undefined, scopes: null, globals: null, key: "" };
const scopeKey = () => {
  const { env, scopes, globals } = get();
  if (keyFor.env !== env || keyFor.scopes !== scopes || keyFor.globals !== globals) keyFor = { env, scopes, globals, key: JSON.stringify(environmentNow()) };
  return keyFor.key;
};
app.subscribe(() => {
  const { suites } = get();
  if (loaded && checkedEnv !== undefined && scopeKey() !== checkedEnv) {
    checkedEnv = scopeKey();
    checkSuites(suites.map((s) => s.file));
  }
});

// What stops a run of a suite: as the check found it, or (until it has) its file's own problems
export function problemsOf(file) {
  const suite = suiteOf(file);
  return get().problems[file] ?? [...(suite?.errors ?? []), ...(suite?.missing ?? [])];
}

// A suite's warnings: the check's (its files' own and what it found), else its files' own, as read
export function warningsOf(file) {
  return get().warnings[file] ?? suiteOf(file)?.warnings ?? [];
}

// A suite's problems in the console, in red, once each: one still there when it's read again isn't
// logged again; one that went and came back is
const logged = new Map();  // suite file → Set of "file|line|message" (a problem can be in a provider file it uses)
function logProblems(file, problems) {
  const before = logged.get(file) ?? new Set();
  const now = new Set();
  for (const e of problems) {
    const key = `${e.file ?? file}|${e.line ?? ""}|${e.message}`;
    now.add(key);
    if (!before.has(key)) say(`${e.file ?? file}${e.line ? `:${e.line}:${e.column}` : ""}  ${e.message}`, "err");
  }
  logged.set(file, now);
}

export async function reload() {
  if (!loaded) return;
  setLoaded(await engine.call("load"));
}

// The browser build gives its engine new secrets or a new relay (its files and conversations stay)
export async function reconfigure() {
  if (isApp || !loaded) return;
  await engine.call("configure", { relay: get().relay, secrets: secretsForBrowser() });
}

// Every scope there is to choose (the scope button, Settings → Environments and Secrets): the ones made
// in the app, in the order they were made, and no others. (A suite's environment of a scope's name
// gives that scope values too, but doesn't make one; nor do secrets.)
export function scopeNames({ scopes } = get()) {
  return (scopes ?? []).map((s) => s.name);
}

// The scope chosen as the engine is given it, with every call that runs or checks something: its name
// (env: the suites' environment of that name, and where its secrets are looked for) and its environment
// values (environment: { name, values }, what {{env.NAME}} is filled from: the scope's over Globals').
// With none chosen, { name: "", values: Globals' }. It's always given, so the engine never reads an
// environment from the files, nor takes a suite's first.
export function environmentNow({ env, scopes, globals } = get()) {
  return { name: env ?? "", values: effectiveValues(env, { globals, scopes }) };
}
const scopeArgs = () => ({ env: get().env ?? undefined, environment: environmentNow() });

// Choose the scope in use (null: none, which is remembered as a choice too)
// (every scope's secret names are known already: nothing to read again)
export function setEnv(env) {
  store.set(KEYS.env, env ?? "");
  set({ env: env || null });
  audit("config.scope", { scope: env || "none" });
}

// Which scopes have secrets, and each one's names (Globals' as ""), never a value: for Settings →
// Secrets, and for the fields' check of {{secret.NAME}}. One read of what's kept (the desktop app's main
// process answers from what it has decrypted already); a later call has the last word.
let secretsAsked = 0;
export async function refreshSecrets() {
  const asked = ++secretsAsked;
  const { names = {}, unreadable = {}, storage = null } = (await kept.secretState()) ?? {};
  if (asked !== secretsAsked) return;
  set({ scopeSecrets: names, secretScopes: Object.keys(names).filter((env) => names[env].length), secretsUnreadable: unreadable, secretsStorage: storage, secretsVersion: get().secretsVersion + 1 });
}

/* ---------- the app's scopes: their environment values and their secrets ---------- */

// The scopes' values (and Globals') as kept now (after a change here, or in another window)
function scopesChanged() {
  set({ scopes: kept.keptScopes(), globals: kept.valuesOf("") });
}
const scopeLabel = (scope) => scope || "globals";

// The browser build's engine holds the secrets it was given: it's given them again (the desktop app's
// main process gives its engine them itself, as they change)
async function secretsChanged() {
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

/* ---------- where suites were last exported to ---------- */

// A suite's last export (transfer.js): { path (the folder's, or its name in a browser), name, ci (its
// path as CI runs it), scope (the one it was for: "" none), env, secret (the .env and secrets files
// written beside it, in the order CI reads them), at }, remembered for Copy CI command, which runs the
// folder it went to with exactly those files. A suite renamed takes it along; deleted, it goes.
export function rememberExport(files, where) {
  const next = { ...get().exports };
  for (const file of files) next[file] = where;
  store.setJSON(KEYS.exports, next);
  set({ exports: next });
}
function moveExport(from, to) {
  const { [from]: was, ...rest } = get().exports;
  if (!was) return;
  store.setJSON(KEYS.exports, { ...rest, [to]: was });
  set({ exports: { ...rest, [to]: was } });
}
function forgetExport(file) {
  const { [file]: was, ...rest } = get().exports;
  if (!was) return;
  store.setJSON(KEYS.exports, rest);
  set({ exports: rest });
}

/* ---------- finding things ---------- */

export const suiteOf = (file) => get().suites.find((s) => s.file === file);
export const testOf = (file, index) => suiteOf(file)?.data?.tests?.[index];
export const testKey = (file, index) => {
  const t = testOf(file, index);
  return `${file}#${t?.id ?? t?.name ?? index}`;
};

/* ---------- selecting ---------- */

export function select(selection, { route = true } = {}) {
  // (on a small screen the panel shows for what's selected; the conversation's, when asked for; and
  // the sidebar's drawer, something picked in it, closes, so what's picked shows)
  set({ selection, panelOpen: selection.kind !== "conversation" });
  closeDrawer();
  emit("select:changed", selection);
  if (!route) return;
  if (selection.in === "run") setRoute("runs", selection.run);
  else if (selection.kind === "test" || selection.kind === "turn" || selection.kind === "check") {
    const t = testOf(selection.file, selection.test);
    // (by id; a test without one, by its name: a place in the list moves when others are deleted)
    if (t) setRoute("suites", t.id ?? `${selection.file}#${t.name}`);
  } else if (selection.kind === "run") setRoute("runs", selection.run);
  else setRoute(null, null);
}

// What the thread shows: "explore", "suite", "test" or "run". A turn, check or step picked in the
// thread or the timeline says which it was picked in (`in`), and the thread stays as it was.
export function threadMode() {
  const { selection, openRun } = get();
  if (selection.kind === "run" && openRun) return "run";
  if (selection.in === "run") return openRun && selection.run === openRun._id ? "run" : "explore";
  if (selection.in === "explore" || selection.explore) return "explore";
  if (selection.in === "suite" || (selection.kind === "suite" && selection.file !== undefined)) return suiteOf(selection.file) ? "suite" : "explore";
  if (["test", "turn", "check", "step"].includes(selection.kind) && selection.file !== undefined && selection.test !== undefined) return "test";
  return "explore";
}

/* ---------- editing suites ---------- */

// What an edit is about, as the app shows it: the test (by id, or name), and what it deletes. The
// engine refuses the edit if the file says otherwise (it changed underneath), so an edit can't land
// on another test, turn or check.
function guardsFor(file, edits) {
  const data = suiteOf(file)?.data;
  const out = [];
  for (const { op, path } of edits) {
    if (path[0] !== "tests" || typeof path[1] !== "number") continue;
    const t = data?.tests?.[path[1]];
    if (!t) continue;
    out.push(t.id !== undefined ? { path: ["tests", path[1], "id"], value: t.id } : { path: ["tests", path[1], "name"], value: t.name });
    if (op === "delete" && path.length > 2) out.push({ path, value: path.reduce((v, k) => v?.[k], data) });
  }
  return out;
}

// `guards`: more of what the file must still have for the edits to be made (as the app shows it)
export async function editSuite(file, edits, guards = []) {
  // A file written where the format has a list or a map as something else is fixed as YAML first: an
  // edit to what the app could only show emptied would write over what's really there
  const malformed = suiteOf(file)?.malformed;
  if (malformed?.length) {
    const why = `${file} has ${malformed[0].join(".")} written in a way the app can't edit: fix it with "Edit the file as YAML" first`;
    notify({ title: `Couldn't save ${file}`, text: why, kind: "error" });
    throw new Error(why);
  }
  try {
    const suite = await engine.call("edit", { file, edits, guards: [...guardsFor(file, edits), ...guards] });
    set({ suites: get().suites.map((s) => (s.file === file ? suite : s)) });
    emit("suites:changed");
    checkSuites([file]);
    return suite;
  } catch (err) {
    say(`couldn't save ${file}: ${err.message}`, "err");
    notify({ title: `Couldn't save ${file}`, text: err.message, kind: "error" });
    // The file isn't what the app showed: show it as it is
    if (/has changed since it was read|has nothing at/.test(err.message)) await reload().catch(() => {});
    throw err;
  }
}

export async function readFile(file) {
  return engine.call("read", { file });
}

export async function writeFile(file, text) {
  const suite = await engine.call("write", { file, text });
  await reload();
  return suite;
}

// Delete a suite, provider or plugin file the app keeps (the design system's confirm-twice delete
// asks first)
export async function deleteFile(file) {
  try {
    await engine.call("remove", { file });
  } catch (err) {
    say(`couldn't delete ${file}: ${err.message}`, "err");
    notify({ title: `Couldn't delete ${file}`, text: err.message, kind: "error" });
    throw err;
  }
  const { selection, conversation } = get();
  if (SUITE_FILE.test(file)) forget(file);
  if (selection.file === file) select({ kind: "conversation" });
  if (conversation?.provider === file) {
    if (store.get(KEYS.provider) === file) store.remove(KEYS.provider);
    set({ conversation: null });
  }
  forgetExport(file);
  await reload();
  say(`deleted ${file}`, "log");
}

// What the thread and timeline show for a suite (file) or one of its tests (test) that's gone:
// their last results, a run of them going on, and the conversation that was saved as it. (Runs
// stay in Runs: they're the record.)
function forget(file, test) {
  const id = test ? test.id ?? test.name : null;
  changes.push({ forget: test ? `${file}#${id}` : file, at: Date.now() });
  const mine = ([k]) => (test ? k === `${file}#${id}` : k.startsWith(`${file}#`));
  set({ lastRuns: Object.fromEntries(Object.entries(get().lastRuns).filter((e) => !mine(e))), lastTries: Object.fromEntries(Object.entries(get().lastTries).filter((e) => !mine(e))) });
  if (!test) set({ lastSuiteRuns: Object.fromEntries(Object.entries(get().lastSuiteRuns).filter(([k]) => k !== file)) });
  const { conversation } = get();
  for (const l of get().lives) if (l.scope.file === file && (!test || l.scope.test === undefined || l.scope.id === id)) stopRun(l.token);
  const saved = conversation?.savedTo;
  if (saved && saved.file === file && (!test || saved.id === test.id)) resetConversation();
}

// What's happened here to suites and tests since runs of them were kept, in order: a suite renamed
// ({ rename: { from, to } }), or a test or suite deleted ({ forget: "file#id" or "file" }), each with
// when (`at`: the clock a run's `started` is on). A run's results show under its suite's name as
// renamed since it ran (not a name another suite has taken since), and not at all if what they're of
// was deleted since it ran.
const changes = [];

// The name `file` (a suite a run ran) has now: each rename since the run, in order; or null if it (or,
// with `id`, that test of it) was deleted since, under the name it had then. names: renames only.
function nameNow(run, file, id, { names = false } = {}) {
  let now = file;
  for (const c of changes) {
    if (c.at < (run.started ?? 0)) continue;
    if (c.rename) {
      if (c.rename.from === now) now = c.rename.to;
    } else if (!names && (c.forget === now || (id !== undefined && c.forget === `${now}#${id}`))) return null;
  }
  return now;
}

// A run as it's shown now: each suite's file by its name now (names: Map of file → its name now)
const movedRun = (run, names) => {
  const to = (f) => names.get(f) || f;
  if (![...names].some(([from, now]) => now && now !== from)) return run;
  return {
    ...run,
    suites: (run.suites ?? []).map((x) => ({ ...x, file: to(x.file) })),
    tests: (run.tests ?? []).map((t) => ({ ...t, suite: to(t.suite) })),
    turns: (run.turns ?? []).map((t) => (t?.suite ? { ...t, suite: to(t.suite) } : t)),
    spans: (run.spans ?? []).map((sp) => (sp.ref?.suite ? { ...sp, ref: { ...sp.ref, suite: to(sp.ref.suite) } } : sp)),
  };
};
// A run of a whole suite: no test, tag or turn picked out
const wholeRun = (run) => {
  const f = run.settings?.filters ?? {};
  return !(f.ids?.length || f.tests?.length || f.tags?.length) && (run.settings?.until_turn ?? null) === null;
};

// Each suite's latest run of the whole suite, from the runs kept here
function lastSuiteRunsFrom(all) {
  const out = {};
  for (const run of [...all].sort((a, b) => a.started - b.started)) {
    if (!wholeRun(run) || run.mode !== "test") continue;
    const names = new Map((run.suites ?? []).map((x) => [x.file, nameNow(run, x.file)]));
    const shown = movedRun(run, names);
    for (const x of run.suites ?? []) {
      const now = names.get(x.file);
      if (now) out[now] = shown;
    }
  }
  return out;
}

// Each test's latest run, from the runs kept here (oldest first, so the latest wins)
function lastRunsFrom(all) {
  const out = {};
  for (const run of [...all].sort((a, b) => a.started - b.started)) {
    const shown = movedRun(run, new Map((run.suites ?? []).map((x) => [x.file, nameNow(run, x.file, undefined, { names: true })])));
    for (const t of run.tests ?? []) {
      const now = nameNow(run, t.suite, t.id ?? t.name);
      if (now) out[`${now}#${t.id ?? t.name}`] = shown;
    }
  }
  return out;
}

// Each test's latest run that broke off before it reached it (refused before sending anything, a
// provider's fixture or the suite's setup that failed): a run of it (by its id, or its name) that has
// no record of it. It's how the test last went all the same (runForTest), though it has nothing to
// carry. (A whole suite's: lastSuiteRuns.)
function lastTriesFrom(all) {
  const out = {};
  for (const run of [...all].sort((a, b) => a.started - b.started)) {
    if (run.status !== "error") continue;
    const shown = movedRun(run, new Map((run.suites ?? []).map((x) => [x.file, nameNow(run, x.file, undefined, { names: true })])));
    const { ids = [], tests: names = [] } = run.settings?.filters ?? {};
    for (const { file } of run.suites ?? []) {
      for (const id of [...ids, ...names]) {
        if ((run.tests ?? []).some((t) => t.suite === file && (t.id ?? t.name) === id)) continue;
        const now = nameNow(run, file, id);
        if (now) out[`${now}#${id}`] = shown;
      }
    }
  }
  return out;
}

// Delete a test from its suite (the file keeps its comments); what was shown for it goes too
export async function deleteTest(file, index) {
  const test = testOf(file, index);
  await editSuite(file, [{ op: "delete", path: ["tests", index] }]);
  forget(file, test);
  afterDelete(file, ["tests", index]);
}

// A turn deleted from its test
export async function deleteTurn(file, test, turn) {
  await editSuite(file, [{ op: "delete", path: ["tests", test, "turns", turn] }]);
  afterDelete(file, ["tests", test, "turns", turn]);
}

// A check deleted from its turn
// Turn a check off (enabled: false: it's skipped when the test runs) or on again. On again, the key
// goes, so the check (and its line in the file) is as it was, and its last result is its own again.
// Made only if the check is still the one the app shows.
// (Clicks on one check's box are made one after another: each reads what the one before saved, so the
// last click is what's in the file)
const toggling = new Map();
export function setCheckOn(file, test, turn, check, on) {
  const key = JSON.stringify([file, test, turn, check]);
  const next = (toggling.get(key) ?? Promise.resolve()).catch(() => {}).then(() => setCheckOnNow(file, test, turn, check, on));
  toggling.set(key, next);
  next.catch(() => {}).finally(() => { if (toggling.get(key) === next) toggling.delete(key); });
  return next;
}
async function setCheckOnNow(file, test, turn, check, on) {
  const path = ["tests", test, "turns", turn, "expect", check];
  const current = suiteOf(file)?.data?.tests?.[test]?.turns?.[turn]?.expect?.[check];
  if (!current || typeof current !== "object" || Array.isArray(current) || on === (current.enabled !== false)) return;
  await editSuite(file, [on ? { op: "delete", path: [...path, "enabled"] } : { op: "set", path: [...path, "enabled"], value: false }], [{ path, value: current }]);
}

export async function deleteCheck(file, test, turn, check) {
  await editSuite(file, [{ op: "delete", path: ["tests", test, "turns", turn, "expect", check] }]);
  afterDelete(file, ["tests", test, "turns", turn, "expect", check]);
}

// After a list item's deleted: a selection in it goes to what held it (the suite, test or turn); a
// selection after it in the same list moves up one; anything else stays as it was
function afterDelete(file, path) {
  const sel = get().selection;
  if (sel.file !== file) return;
  const keys = ["test", "turn", "check"];
  const at = [sel.test, sel.turn, sel.check];
  const depth = path.length / 2 - 1;  // ["tests", t] 0: a test; [..., "turns", i] 1: a turn; [..., "expect", j] 2: a check
  for (let d = 0; d < depth; d++) if (at[d] !== path[2 * d + 1]) return;  // in another test or turn
  const mine = at[depth];
  if (mine === undefined) return;
  if (mine === path.at(-1)) {
    const up = { kind: ["suite", "test", "turn"][depth], file };
    for (let d = 0; d < depth; d++) up[keys[d]] = at[d];
    select(up);
  } else if (mine > path.at(-1)) select({ ...sel, [keys[depth]]: mine - 1 });
}

// Rename a suite's file (name.hafen.yml), in the same folder; its tests' last results follow it, and
// where it was last exported to.
// (Its `name`, shown in reports, is edited on its own.)
export async function renameSuite(file, name) {
  const next = name.trim().replace(SUITE_FILE, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(next)) {
    notify({ title: "That name won't do", text: "A suite's file name is letters, digits, '.', '-' and '_'.", kind: "error" });
    return null;
  }
  const to = `${file.replace(/[^/\\]+$/, "")}${next}${file.match(SUITE_FILE)?.[0] ?? ".hafen.yml"}`;
  if (to === file) return file;
  // (A run of it going on reads it by its name: it's renamed once the run's over)
  if (liveIn(file)) {
    notify({ title: `${file} is running`, text: "Stop its run (or let it end), then rename it.", kind: "error" });
    return null;
  }
  try {
    await engine.call("rename", { file, to });
  } catch (err) {
    say(`couldn't rename ${file}: ${err.message}`, "err");
    notify({ title: `Couldn't rename ${file}`, text: err.message, kind: "error" });
    return null;
  }
  // The last results, shown under the new name (the runs themselves stay as they were recorded); and
  // the conversation saved as one of its tests, which follows it
  changes.push({ rename: { from: file, to }, at: Date.now() });
  const moved = new Map([[file, to]]);
  const follow = (runs) => Object.fromEntries(Object.entries(runs).map(([k, v]) => (k.startsWith(`${file}#`) ? [`${to}${k.slice(file.length)}`, movedRun(v, moved)] : [k, v])));
  set({ lastRuns: follow(get().lastRuns), lastTries: follow(get().lastTries) });
  const suiteRuns = { ...get().lastSuiteRuns };
  if (suiteRuns[file]) { suiteRuns[to] = movedRun(suiteRuns[file], moved); delete suiteRuns[file]; }
  set({ lastSuiteRuns: suiteRuns });
  const saved = get().conversation?.savedTo;
  if (saved?.file === file) set({ conversation: { ...get().conversation, savedTo: { ...saved, file: to } } });
  // The selection follows it (set before the folder's read again, which would otherwise let it go)
  const { selection } = get();
  if (selection.file === file) set({ selection: { ...selection, file: to } });
  moveExport(file, to);
  await reload();
  if (selection.file === file) select({ ...get().selection });
  say(`renamed ${file} to ${to}`, "log");
  return to;
}

const newTestValue = (tests = []) => ({ id: testId(), name: freeTestName(tests, "New test"), turns: [{ user: "Hello" }] });

// The next new suite's file: tests.hafen.yml, then tests-2.hafen.yml, …
export function freeSuiteFile() {
  const { suites } = get();
  let n = 1;
  const fileOf = (i) => (i === 1 ? "tests.hafen.yml" : `tests-${i}.hafen.yml`);
  while (suites.some((x) => x.file === fileOf(n))) n++;
  return fileOf(n);
}

// A new suite file with one test (name: its file's, without .hafen.yml, a folder's path allowed; none,
// the next free one), using the provider in use (the conversation's, or the one used last), and the
// environments and variables of a suite that already uses it (so what its templates need,
// {{base_url}} say, is set)
export async function newSuite(name = "") {
  const { suites } = get();
  const typed = name.trim().replace(SUITE_FILE, "");
  if (typed && !SUITE_NAME.test(typed)) throw new Error("A suite's name is letters, digits, '.', '-' and '_' (and '/' for a folder).");
  const file = typed ? `${typed}.hafen.yml` : freeSuiteFile();
  if (suites.some((s) => s.file === file)) throw new Error(`${file} is there already: choose another name`);
  const provider = providerInUse()?.file;
  const like = provider ? suites.find((s) => Object.values(s.providerFiles ?? {}).includes(provider)) : null;
  try {
    await createSuite(file, {
      name: file.split("/").pop().replace(SUITE_FILE, ""), provider: provider ? relativePath(file, provider) : "openai-chat",
      environments: like?.data?.environments, variables: like?.data?.variables, tests: [newTestValue()],
    });
  } catch (err) {
    say(`couldn't add ${file}: ${err.message}`, "err");
    notify({ title: `Couldn't add ${file}`, text: err.message, kind: "error" });
    throw err;
  }
  select({ kind: "test", file, test: 0 });
  say(`added ${file}`, "log");
  return file;
}

// What a new suite's name may be (its file's, without .hafen.yml): smoke, or support/refunds
export const SUITE_NAME = /^[A-Za-z0-9][\w.-]*(\/[A-Za-z0-9][\w.-]*)*$/;

// A new test at the end of a suite
export async function newTest(file) {
  const suite = await editSuite(file, [{ op: "add", path: ["tests"], value: newTestValue(suiteOf(file)?.data?.tests) }]);
  select({ kind: "test", file, test: (suite.data?.tests ?? []).length - 1 });
}

// A provider's name is its file's: renaming it renames the file (in the same folder, with the same
// extension), and the suites that use it are pointed at the new name.
export async function renameProvider(file, name) {
  const next = name.trim().replace(/\.(ya?ml|json)$/i, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(next)) {
    notify({ title: "That name won't do", text: "A provider's name is its file's: letters, digits, '.', '-' and '_'.", kind: "error" });
    return null;
  }
  const to = `${file.replace(/[^/\\]+$/, "")}${next}${file.match(/\.(ya?ml|json)$/i)?.[0] ?? ".yml"}`;
  if (to === file) return file;
  let renamed;
  try {
    renamed = await engine.call("rename", { file, to });
  } catch (err) {
    say(`couldn't rename ${file}: ${err.message}`, "err");
    notify({ title: `Couldn't rename ${file}`, text: err.message, kind: "error" });
    return null;
  }
  const { conversation } = get();
  if (store.get(KEYS.provider) === file) store.set(KEYS.provider, to);
  if (conversation?.provider === file) set({ conversation: { ...conversation, provider: to } });
  await reload();
  say(`renamed ${file} to ${to}${renamed.suites.length ? `; ${renamed.suites.join(", ")} now use${renamed.suites.length === 1 ? "s" : ""} it` : ""}`, "log");
  return to;
}

export async function createSuite(file, suite) {
  const created = await engine.call("create", { file, suite });
  await reload();
  return created;
}

// A new provider file under providers/, from one of the kinds Settings → Providers lists; it's then
// chosen for the conversation
// (choose: it's the one a new conversation uses, as a provider made in Settings → Providers is)
export async function createProvider(name, text, { choose = true } = {}) {
  const next = name.trim().replace(/\.(ya?ml|json)$/i, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(next)) throw new Error("A provider's name is its file's: letters, digits, '.', '-' and '_'.");
  const file = `providers/${next}.yml`;
  await engine.call("create", { file, text });
  await reload();
  if (choose) chooseProvider(file);
  say(`added ${file}`, "log");
  return file;
}

// A provider plugin as a provider (Settings → Plugins makes one with each new provider plugin;
// Settings → Providers, for one that has none, or a new provider of its kind): providers/<name>.yml,
// kind: plugin:<name>, its name the one given, else free (acme-2…). Listed in Providers, used as any
// provider is. (choose: as createProvider's)
export async function createPluginProvider(plugin, file, { name: given, choose = false } = {}) {
  const base = plugin.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "plugin";
  let name = given ?? base;
  for (let n = 2; given === undefined && get().providers.some((p) => p.file === `providers/${name}.yml`); n++) name = `${base}-${n}`;
  return createProvider(name, pluginProviderText(plugin, file), { choose });
}
export const pluginProviderText = (plugin, file) => `# A provider made by the plugin "${plugin}" (${file}), which Hafen loads from its plugins/.
# Its other fields reach the plugin as its settings ({{name}}s filled in; never a secret): url, model…
kind: plugin:${plugin}
# url: https://api.example.com/chat
`;

/* ---------- exploring ---------- */

// Choose a provider: for a new conversation, or (keep) for the one going on, which then carries on
// with it (its turns so far are the history the next message goes with)
// (While a message is on its way, the conversation's provider isn't changed: its reply would be lost,
// and the conversation left sending. The picker is off meanwhile.)
export function chooseProvider(providerFile, { keep = false } = {}) {
  const c = get().conversation;
  if (keep && c?.sending) return;
  store.set(KEYS.provider, providerFile);
  audit("config.provider", { provider: providerFile, for: keep ? "the conversation going on" : "a new conversation" });
  if (keep && c?.run?.turns?.length) {
    letGo(c.token);
    set({ conversation: { ...c, token: newToken(), provider: providerFile, error: null } });
    return;
  }
  resetConversation();
  set({ conversation: { id: newToken(), token: newToken(), provider: providerFile, run: null, sending: false, error: null } });
}

// A new conversation (the one going on is kept, under Conversations, if it has any turns)
export function resetConversation() {
  const c = get().conversation;
  letGo(c?.token);
  set({ conversation: c ? { id: newToken(), token: newToken(), provider: c.provider, run: null, error: null, sending: false } : null });
}

// A conversation let go in the engine (another opened, a new one started, its provider changed): its
// provider's after and afterAll fixtures run then, and their lines go in the console, as a message's
// fixtures' do (they come with its token, after its messages)
function letGo(token) {
  if (!token || !engine) return;
  const off = engine.on(token, (event) => auditEvent("conversation", event));
  engine.call("reset", { token }).catch(() => {}).finally(off);
}

/* ---------- conversations kept here ---------- */

const conversationSummary = (c) => ({ _id: c._id, title: c.title, provider: c.provider, started: c.started ?? c.run?.started, updated: c.updated, turns: c.run?.turns?.length ?? 0, size: new Blob([JSON.stringify(c)]).size });
const titleOf = (c) => c.title || String(c.run?.turns?.find(Boolean)?.user ?? "Conversation").replace(/\s+/g, " ").trim().slice(0, 60) || "Conversation";

export async function loadConversations() {
  try {
    const all = await idb.all("conversations");
    set({ conversations: all.map(conversationSummary).sort((a, b) => b.updated - a.updated) });
  } catch (err) {
    say(`couldn't read the conversations kept here: ${err.message}`, "err");
  }
}

// Keep the conversation going on (after each message, a rename, a deleted turn); one with no turns
// left isn't kept
async function keepConversation() {
  const c = get().conversation;
  if (!c?.id) return;
  if (!c.run?.turns?.length) {
    await idb.remove("conversations", c.id).catch(() => {});
  } else {
    const kept = { _id: c.id, title: titleOf(c), provider: c.provider ?? null, started: c.run.started, updated: Date.now(), run: c.run };
    await idb.put("conversations", kept);
  }
  await loadConversations();
  emit("conversations:changed");
}

// Open a kept conversation: shown as it was, and the next message carries it on
export async function openConversation(id) {
  const kept = await idb.get("conversations", id);
  if (!kept) {
    say(`there's no conversation ${id}`, "err");
    return;
  }
  const c = get().conversation;
  letGo(c?.token);
  const provider = get().providers.some((p) => p.file === kept.provider) ? kept.provider : null;
  set({ conversation: { id: kept._id, token: newToken(), provider, run: kept.run, title: kept.title, sending: false, error: null } });
  audit("conversation.open", { conversation: kept.title, turns: kept.run?.turns?.length ?? 0 });
  select({ kind: "conversation" }, { route: false });
  setRoute("conversations", kept._id);
}

export async function renameConversation(title) {
  const c = get().conversation;
  if (!c?.run?.turns?.length) return;
  set({ conversation: { ...c, title: title.trim() || undefined } });
  await keepConversation();
}

export async function deleteConversation(id) {
  await idb.remove("conversations", id);
  audit("conversation.delete", { id });
  if (get().conversation?.id === id) {
    resetConversation();
    if (threadMode() === "explore") select({ kind: "conversation" });
  }
  await loadConversations();
  emit("conversations:changed");
}

export async function clearConversations() {
  await idb.clear("conversations");
  audit("conversation.clear", {});
  if (get().conversation?.run) resetConversation();
  await loadConversations();
  emit("conversations:changed");
}

// A turn deleted from the conversation going on: the turns after it move up, and the next message
// goes without it (the engine starts the conversation again from what's left)
export async function deleteConversationTurn(index) {
  const c = get().conversation;
  if (!c?.run?.turns?.[index]) return;
  if (c.sending) stopSending();
  letGo(c.token);
  set({ conversation: { ...c, token: newToken(), run: withoutTurn(c.run, index), error: null } });
  audit("conversation.turn.delete", { turn: index + 1 });
  const sel = get().selection;
  if (sel.explore && sel.turn !== undefined) select(sel.turn === index ? { kind: "conversation" } : sel.turn > index ? { ...sel, turn: sel.turn - 1 } : sel, { route: false });
  await keepConversation();
}

// A run without one of its turns: its spans (the turn's and everything under it) go, and the turns
// after it, and their spans' references, move up one
export function withoutTurn(run, index) {
  const turnSpan = (run.spans ?? []).find((s) => s.kind === "turn" && s.ref?.turn === index);
  const gone = new Set(turnSpan ? [turnSpan._id] : []);
  for (let grew = true; grew;) {
    grew = false;
    for (const s of run.spans ?? []) if (!gone.has(s._id) && s.parent && gone.has(s.parent)) { gone.add(s._id); grew = true; }
  }
  const spans = (run.spans ?? []).filter((s) => !gone.has(s._id)).map((s) => (s.ref?.turn > index ? { ...s, ref: { ...s.ref, turn: s.ref.turn - 1 }, name: s.kind === "turn" ? `turn ${s.ref.turn}` : s.name } : s));
  const turns = run.turns.filter((_, i) => i !== index).map((t, i) => (t ? { ...t, index: i } : t));
  return { ...run, turns, spans };
}

// The suite whose environments and variables an exploring provider uses: the selected one, else the
// first that uses this provider, else the first
export function contextSuite(providerFile) {
  const { selection, suites } = get();
  if (selection.file && suites.some((s) => s.file === selection.file)) return selection.file;
  const using = suites.find((s) => Object.values(s.providerFiles ?? {}).includes(providerFile));
  return (using ?? suites[0])?.file;
}

// The provider a message goes to (and a new suite uses): the conversation's, else the one used last,
// else the first the pickers offer
export function providerInUse() {
  const { conversation, providers } = get();
  const file = conversation?.provider ?? store.get(KEYS.provider);
  return providers.find((p) => p.file === file) ?? providerChoices(get())[0] ?? null;
}

export async function sendMessage(text) {
  let c = get().conversation;
  if (!c?.provider) {
    const first = providerInUse()?.file;
    if (!first) throw new Error("add a provider first");
    chooseProvider(first, { keep: true });
    c = get().conversation;
  }
  if (!c.id) set({ conversation: (c = { ...c, id: newToken() }) });
  const token = c.token;
  const live = createLiveRun({ mode: "explore" }, c.run);
  const off = engine.on(token, (event) => {
    auditEvent("conversation", event);
    live.take(event, (run) => {
      if (get().conversation?.token === token) set({ conversation: { ...get().conversation, run } });
    });
  });
  set({ conversation: { ...c, sending: true, error: null } });
  // The thread goes to the bottom, to the message and its reply
  emit("thread:bottom");
  try {
    // (A kept conversation's turns so far: the engine carries on from them when the token is new to it)
    const seed = c.run?.turns?.length ? c.run : undefined;
    const call = engine.call("send", { token, providerFile: c.provider, suiteFile: contextSuite(c.provider), ...scopeArgs(), message: text, history: "live", seed });
    inFlight = call.catch(() => {});
    const out = await call;
    // (the live copy's last redraw, if one is waiting, doesn't come after the engine's own run)
    live.stop();
    if (get().conversation?.token === token) {
      set({ conversation: { ...get().conversation, run: out.run, sending: false } });
      await keepConversation().catch((err) => say(`couldn't keep the conversation: ${err.message}`, "err"));
    }
    return out.record;
  } catch (err) {
    live.stop();
    // (a conversation let go meanwhile, another opened, isn't this one's to report)
    if (get().conversation?.token === token) {
      set({ conversation: { ...get().conversation, sending: false, error: err.message } });
      say(err.message, "err");
    }
    throw err;
  } finally {
    off();
  }
}

// The message being sent (saving the conversation waits for it)
let inFlight = Promise.resolve();

export function stopSending() {
  const c = get().conversation;
  if (c?.sending) engine.call("stop", { token: c.token });
}

export async function saveConversation({ file, name }) {
  // A message on its way: the test has its reply too
  await inFlight;
  const c = get().conversation;
  if (!c?.run?.turns?.length) throw new Error("send a message first");
  const provider = get().providers.find((p) => p.file === c.provider);
  const providerPath = provider ? relativePath(file, provider.file) : undefined;
  const suite = await engine.call("saveConversation", { token: c.token, file, name, providerPath, run: c.run });
  await reload();
  const index = (suite.data?.tests ?? []).length - 1;
  // Deleting this test (or its suite) clears the conversation too
  if (get().conversation?.token === c.token) set({ conversation: { ...get().conversation, savedTo: { file, id: suite.data?.tests?.[index]?.id } } });
  select({ kind: "test", file, test: index });
  return suite;
}

// `target` as a path relative to `from`'s folder
export function relativePath(from, target) {
  const a = from.split("/").slice(0, -1);
  const b = target.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

/* ---------- running ---------- */

/* ---------- runs going on (any number at once) ---------- */

const idOf = (file, index) => {
  const t = testOf(file, index);
  return t ? t.id ?? t.name : undefined;
};
// The run going on that runs this test (one of it, or of its whole suite)
export const liveForTest = (file, index) => get().lives.find((l) => l.scope.file === file && (l.scope.test === undefined || l.scope.id === idOf(file, index))) ?? null;
// The run of this whole suite going on
export const liveForSuite = (file) => get().lives.find((l) => l.scope.file === file && l.scope.test === undefined) ?? null;
// Any run going on in this suite (of it, or of one of its tests)
export const liveIn = (file) => get().lives.find((l) => l.scope.file === file) ?? null;

const setRunning = () => {
  if (get().lives.length) document.documentElement.dataset.running = "";
  else delete document.documentElement.dataset.running;
};

// Run a test (index) or a whole suite (test undefined): with untilTurn, the test up to that turn; with
// onlyTurn, only that turn (the turns before it carried from the test's last run, as its history).
// Runs go on at once, but not two of the same thing: a test already running (alone, or in its suite's
// run), or a suite with a run going on in it, isn't started again.
export async function runTests(file, testIndex, { untilTurn, onlyTurn } = {}) {
  const test = testIndex === undefined ? null : testOf(file, testIndex);
  if (test ? liveForTest(file, testIndex) : liveIn(file)) return undefined;
  const token = newToken();
  // (what runs at once: the suite's and its tests' groups, as the files say)
  const options = { ...scopeArgs(), load: false };
  if (test && Number.isInteger(onlyTurn)) {
    options.onlyTurn = onlyTurn;
    // The earlier turns' records from its last run, as the file has them now (its latest that has
    // them: one that broke off before it has none)
    const last = get().lastRuns[testKey(file, testIndex)] ?? null;
    const paired = pairTurns(turnsOf(last, file, test), test.turns ?? []);
    options.carry = { [test.id ?? test.name]: paired.slice(0, onlyTurn).map((p) => (p && !p.record.error && !p.record.skipped ? p.record : null)) };
  } else if (test && Number.isInteger(untilTurn)) options.untilTurn = untilTurn;
  if (test) {
    if (test.id) options.ids = [test.id];
    else options.tests = [test.name];
  }
  const live = createLiveRun({ mode: "test" });
  const scope = { file, test: testIndex, id: test ? test.id ?? test.name : undefined, untilTurn: options.untilTurn, onlyTurn: options.onlyTurn };
  const update = (run) => set({ lives: get().lives.map((l) => (l.token === token ? { ...l, run } : l)) });
  set({ lives: [...get().lives, { token, run: live.run, scope }] });
  setRunning();
  audit("run.start", { file, test: test?.name, until_turn: options.untilTurn !== undefined ? options.untilTurn + 1 : undefined, only_turn: options.onlyTurn !== undefined ? options.onlyTurn + 1 : undefined, at_once: options.concurrency });
  const off = engine.on(token, (event) => {
    auditEvent("run", event);
    live.take(event, update);
  });
  const done = () => {
    live.stop();
    set({ lives: get().lives.filter((l) => l.token !== token) });
    setRunning();
  };
  try {
    const run = await engine.call("run", { token, files: [file], options });
    await keepRun(run);
    const lastRuns = { ...get().lastRuns };
    for (const t of run.tests) {
      const index = (suiteOf(t.suite)?.data?.tests ?? []).findIndex((x) => (x.id ?? x.name) === (t.id ?? t.name));
      if (index > -1) lastRuns[testKey(t.suite, index)] = run;
    }
    set({ lastRuns });
    // (one that broke off before the test it ran: its latest try all the same, shown as its error)
    if (test && testResult(run, file, test)?.unreached) set({ lastTries: { ...get().lastTries, [testKey(file, testIndex)]: run } });
    done();
    // How it went, in the words the top bar, the Suites tree and Runs use (a test's run: the test's)
    const said = runOutcome(test ? { ...run, tests: [testResult(run, file, test)].filter(Boolean) } : run);
    const failed = ["failed", "error"].includes(said.status);
    // As Settings → Notifications says: a sound (when what ran isn't what's open, by default), the
    // system's notification (the window in the background); the toast, or that, clicked opens what ran
    const outcome = said.status === "stopped" ? "stopped" : failed ? "failed" : "passed";
    const actions = runEndActions(outcome, isViewing(file, test));
    const word = { passed: "Passed", unsure: "Passed, unsure", failed: "Failed", stopped: "Stopped", error: "Error" }[said.status] ?? said.text;
    notify({
      title: `${refusedRun(run) ? "Couldn't run" : word}: ${test?.name ?? suiteOf(file)?.name ?? file}${options.untilTurn !== undefined ? ` (to turn ${options.untilTurn + 1})` : options.onlyTurn !== undefined ? ` (turn ${options.onlyTurn + 1} only)` : ""}`,
      text: run.error?.message ?? `${run.summary?.checks?.passed ?? 0}/${run.summary?.checks?.total ?? 0} checks · ${((run.ms ?? 0) / 1000).toFixed(1)} s`,
      kind: failed ? "error" : said.status === "stopped" ? "" : "ok",
      sound: actions.sound ?? undefined,
      system: actions.system,
      onClick: () => openWhatRan(file, test),
    });
    if (run.error) say(`${run.error.file ?? ""}${run.error.line ? `:${run.error.line}` : ""} ${run.error.message}`, "err");
    return run;
  } catch (err) {
    done();
    say(err.message, "err");
    throw err;
  } finally {
    off();
  }
}

// Whether what ran is what's open, the window in front: a suite's run, the suite's view or one of its
// tests; a test's, the test (a turn or a check of it) or its suite's view
function isViewing(file, test) {
  if (!inFront()) return false;
  const { selection } = get();
  if (selection.file !== file) return false;
  const mode = threadMode();
  if (mode === "suite") return true;
  if (mode !== "test") return false;
  const shown = testOf(file, selection.test);
  return !test || (!!shown && (shown.id ?? shown.name) === (test.id ?? test.name));
}

// Open what ran: a test (found by its id or name, where it is now), else its suite's view
function openWhatRan(file, test) {
  if (!suiteOf(file)) return;
  const index = test ? (suiteOf(file).data?.tests ?? []).findIndex((t) => (t.id ?? t.name) === (test.id ?? test.name)) : -1;
  select(index > -1 ? { kind: "test", file, test: index } : { kind: "suite", file });
  closeDrawer();
}

// Stop a run going on (its token), or every one (Esc)
// A run again, as it went: its one test as it was run (up to its turn, or only its turn), or each of
// its suites whole. What the app hasn't got any more is said, not run instead as something else.
export async function runAgain(run) {
  if (!wholeRun(run) && run.tests?.length === 1) {
    const t = run.tests[0];
    const index = (suiteOf(t.suite)?.data?.tests ?? []).findIndex((x) => (x.id ?? x.name) === (t.id ?? t.name));
    if (index < 0) throw new Error(`"${t.name}" isn't in your suites any more`);
    const s = run.settings ?? {};
    return runTests(t.suite, index, { untilTurn: s.until_turn ?? undefined, onlyTurn: s.only_turn ?? undefined });
  }
  const files = (run.suites ?? []).map((x) => x.file).filter((f) => suiteOf(f));
  if (!files.length) throw new Error("its suites aren't in your suites any more");
  await Promise.all(files.map((f) => runTests(f)));
  return undefined;
}

export function stopRun(token) {
  for (const l of get().lives) if (token === undefined || l.token === token) engine.call("stop", { token: l.token });
}

// A run as the engine's events build it, drawn at most once a frame
function createLiveRun(base, from = null) {
  let run = from ? structuredClone(from) : { ...base, spans: [], turns: [], tests: [], status: "running" };
  let queued = false;
  let notify = null;
  let stopped = false;
  const flush = () => {
    queued = false;
    if (!stopped) notify?.({ ...run, spans: [...run.spans], turns: [...run.turns], tests: [...run.tests] });
  };
  return {
    get run() { return run; },
    // No more redraws: the run's over (one waiting for the next frame is dropped)
    stop() { stopped = true; },
    take(event, onChange) {
      notify = onChange;
      switch (event.type) {
        case "run:start":
          run = { ...event.run, spans: run.spans ?? [], turns: run.turns ?? [], tests: [] };
          break;
        case "span": {
          const at = run.spans.findIndex((s) => s._id === event.span._id);
          if (at === -1) run.spans.push({ ...event.span });
          else run.spans[at] = { ...event.span };
          break;
        }
        case "test:start":
          run.tests.push({ ...event.test, status: "running", instances: [] });
          break;
        case "test:end": {
          const at = run.tests.findIndex((t) => t.suite === event.test.suite && t.index === event.test.index);
          if (at === -1) run.tests.push(event.test);
          else run.tests[at] = event.test;
          break;
        }
        case "turn:start":
          run.turns[event.index] = { ...(event.key ?? {}), index: event.key?.index ?? event.index, user: event.user, events: [], reply: "", thinking: [], tool_calls: [], results: [], live: true };
          break;
        case "turn:event": {
          const t = run.turns[event.index];
          if (!t) break;
          const e = event.event;
          const turn = { ...t, events: [...t.events, { ...e, t: event.at }] };
          if (e.type === "text") turn.reply = (turn.reply ?? "") + e.text;
          else if (e.type === "thinking") {
            const thinking = [...(turn.thinking ?? [])];
            const last = thinking.at(-1);
            if (last && last.visibility === (e.visibility ?? "full")) thinking[thinking.length - 1] = { ...last, text: last.text + (e.text ?? "") };
            else thinking.push({ text: e.text ?? "", visibility: e.visibility ?? "full" });
            turn.thinking = thinking;
          } else if (e.type === "tool_call") turn.tool_calls = [...(turn.tool_calls ?? []), { id: e.id, name: e.name, args: e.args }];
          else if (e.type === "error") turn.error = e.message;
          run.turns[event.index] = turn;
          break;
        }
        case "turn:end":
          run.turns[event.index] = { ...event.record, index: event.record.index ?? event.index };
          break;
        case "run:end":
          run = event.run;
          break;
        default:
          break;
      }
      if (!queued) {
        queued = true;
        requestAnimationFrame(flush);
      }
    },
  };
}

/* ---------- runs kept here ---------- */

// (its error and why it stopped, so Runs says how it went in the words used everywhere: runOutcome)
const summaryOf = (run) => ({
  _id: run._id, mode: run.mode, started: run.started, ms: run.ms, status: run.status, verdict: run.verdict, error: run.error ?? null, stopped: run.stopped,
  name: runName(run, get().suites),
  // (a run of one test that repeats: how many times, for ×3)
  repeat: run.tests.length === 1 ? run.tests[0].settings?.repeat : undefined,
  suites: run.suites.map((s) => s.file), tests: run.tests.map((t) => ({ id: t.id, name: t.name, suite: t.suite, index: t.index, status: t.status, unsure: t.unsure, reason: t.reason })),
  size: new Blob([JSON.stringify(run)]).size,
});

export async function loadRuns() {
  try {
    const all = await idb.all("runs");
    const usable = all.filter((r) => Array.isArray(r?.tests) && Array.isArray(r?.suites));
    const runs = usable.map(summaryOf).sort((a, b) => b.started - a.started);
    set({ runs, lastRuns: lastRunsFrom(usable), lastTries: lastTriesFrom(usable), lastSuiteRuns: lastSuiteRunsFrom(usable) });
  } catch (err) {
    say(`couldn't read the runs kept here: ${err.message}`, "err");
  }
}

export async function keepRun(run) {
  if (!run || run.mode === "explore") return;
  await idb.put("runs", run);
  await loadRuns();
  emit("runs:changed");
}

export async function openRun(id) {
  const run = await idb.get("runs", id);
  if (!run) {
    say(`there's no run with _id ${id}`, "err");
    return;
  }
  set({ openRun: run });
  select({ kind: "run", run: id });
}

export async function deleteRun(id) {
  await idb.remove("runs", id);
  audit("run.delete", { run: id });
  const sel = get().selection;
  if (get().openRun?._id === id) set({ openRun: null });
  if (sel.run === id && (sel.kind === "run" || sel.in === "run")) select({ kind: "conversation" });
  await loadRuns();
  emit("runs:changed");
}

export async function clearRuns() {
  await idb.clear("runs");
  audit("run.clear", {});
  const sel = get().selection;
  set({ openRun: null, runs: [] });
  if (sel.kind === "run" || sel.in === "run") select({ kind: "conversation" });
  await loadRuns();
  emit("runs:changed");
}

// A run file from CI (or anywhere): kept here, then opened
export async function importRun(text) {
  // (One from before the app was Hafen is read as a Hafen run: run-file.js)
  const run = parseRun(text);
  if (run.mode === "explore") throw new Error("this is a conversation's run, not a test's: it isn't opened under Runs");
  if (typeof run._id !== "string" || !Array.isArray(run.tests) || !Array.isArray(run.suites) || !Array.isArray(run.turns)) throw new Error("this run file is missing its _id, suites, tests or turns");
  await keepRun(run);
  audit("run.import", { run: run._id });
  await openRun(run._id);
}

export function exportRun(run) {
  // (A run kept from before the app was Hafen goes out as a Hafen run)
  const url = URL.createObjectURL(new Blob([serializeRun({ ...run, kind: RUN_KIND })], { type: "application/json" }));
  Object.assign(document.createElement("a"), { href: url, download: runFileName(run) }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The run a suite's view shows: a run of the whole suite going on, or its latest
export function suiteRunFor(file) {
  return liveForSuite(file)?.run ?? get().lastSuiteRuns[file] ?? null;
}

// Run what's selected (⌘/Ctrl+Enter, and the top bar's play button): the turn's test up to that turn,
// the test, or the suite; or, if that's running, stop it
export function runSelection() {
  const mode = threadMode();
  const { selection } = get();
  if (mode === "suite") {
    const going = liveForSuite(selection.file);
    return going ? stopRun(going.token) : runTests(selection.file).catch(() => {});
  }
  if (mode !== "test") return undefined;
  const going = liveForTest(selection.file, selection.test);
  if (going) return stopRun(going.token);
  const upTo = ["turn", "check", "step"].includes(selection.kind) && Number.isInteger(selection.turn) ? selection.turn : undefined;
  return runTests(selection.file, selection.test, { untilTurn: upTo }).catch(() => {});
}

// The run a test's thread shows: the one going on that runs it, or its latest try: its latest run, or
// a later one of it or of its whole suite that broke off before it reached it (refused before sending
// anything, a provider's fixture or the suite's setup that failed), which has no record of it but is
// how it last went all the same
export function runForTest(file, testIndex) {
  const live = liveForTest(file, testIndex)?.run;
  if (live) return live;
  const key = testKey(file, testIndex);
  const whole = get().lastSuiteRuns[file];
  const broke = whole?.status === "error" && testResult(whole, file, testOf(file, testIndex))?.unreached ? whole : null;
  const tries = [get().lastRuns[key], get().lastTries[key], broke].filter(Boolean);
  return tries.reduce((latest, run) => ((run.started ?? 0) > (latest.started ?? 0) ? run : latest), tries[0] ?? null);
}

export function compareRuns(run, baseline) {
  return engine.call("compare", { run, baseline, thresholds: { pass_rate: 5, p95: 20, cost: 20 } });
}

export const engineCall = (cmd, args) => engine.call(cmd, args);
