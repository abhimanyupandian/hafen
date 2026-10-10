// What the app shows and what it can do: the suites, providers and plugins it keeps (its workspace,
// opened by itself on start: host.js), what's selected, the conversation being explored, the run
// going on (drawn live from the engine's events), and the runs kept in this browser. Views read `app`
// (a store) and call the actions here; nothing here parses, checks or times anything: the engine does
// (constitution II).

import { fixturesOf } from "hafen/engine/fixture-lists.js";
import { createStore } from "./design/hooks.js";
import { connectEngine, newToken } from "./host.js";
import { isApp } from "./lib/app.js";
import { closeDrawer } from "./lib/dom.js";
import { emit } from "./lib/events.js";
import { say } from "./lib/log.js";
import { audit, auditCall, auditEngineLog } from "./lib/audit.js";
import { KEYS, store } from "./lib/store.js";
import * as kept from "./lib/scope-store.js";
import { effectiveValues } from "./lib/scopes.js";
import { setRoute } from "./lib/url.js";
import { notify } from "./design/toast.jsx";
import { letGo, loadConversations } from "./state/conversations.js";
import { loadRuns } from "./state/runs.js";
import { scopesChanged, secretsChanged } from "./state/scopes.js";

// A suite's file: name.hafen.yml (or .yaml, .json), as the engine finds them
export const SUITE_FILE = /\.hafen\.(ya?ml|json)$/i;

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

export let engine = null;
let loaded = false;  // the workspace has been read

export const get = () => app.get();
export const set = (changes) => app.set(changes);

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
export function checkSuites(files) {
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
export const scopeArgs = () => ({ env: get().env ?? undefined, environment: environmentNow() });

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
export function moveExport(from, to) {
  const { [from]: was, ...rest } = get().exports;
  if (!was) return;
  store.setJSON(KEYS.exports, { ...rest, [to]: was });
  set({ exports: { ...rest, [to]: was } });
}
export function forgetExport(file) {
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

export * from "./state/scopes.js";
export * from "./state/suites.js";
export * from "./state/conversations.js";
export * from "./state/runs.js";
