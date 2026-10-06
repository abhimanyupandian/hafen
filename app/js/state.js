// What the app shows and what it can do: the open folder's suites and providers, what's selected,
// the conversation being explored, the run going on (drawn live from the engine's events), and the
// runs kept in this browser. Views read `app` (a store) and call the actions here; nothing here
// parses, checks or times anything: the engine does (constitution II).

import { parseRun, runFileName, serializeRun } from "../../engine/reports/run-file.js";
import { RUN_KIND } from "../../engine/run-kind.js";
import { testId } from "../../engine/util.js";
import { createStore } from "./design/hooks.js";
import { connectEngine, newToken } from "./host.js";
import { invoke, isApp } from "./lib/app.js";
import { closeDrawer } from "./lib/dom.js";
import { emit } from "./lib/events.js";
import * as idb from "./lib/idb.js";
import { say } from "./lib/log.js";
import { audit, auditCall, auditEngineLog, auditEvent } from "./lib/audit.js";
import { pairTurns, turnsOf } from "./views/derive.js";
import { KEYS, store } from "./lib/store.js";
import { setRoute } from "./lib/url.js";
import { notify } from "./design/toast.jsx";
import { inFront, runEndActions } from "./lib/notifications.js";

// A suite's file: name.hafen.yml (or .yaml, .json), as the engine finds them
const SUITE_FILE = /\.hafen\.(ya?ml|json)$/i;

export const app = createStore({
  ready: false,
  opened: false,         // a folder or files are open
  root: null,            // the folder's path (desktop) or name (browser)
  canWrite: true,        // files can be saved in place (a folder); else they're downloaded
  suites: [],
  providers: [],
  env: store.get(KEYS.env),
  selection: { kind: "conversation" },
  panelOpen: false,      // small screens: the panel shown over the thread (something selected, or asked for)
  conversation: null,    // { id, token, provider, run, title, sending, error }: id is its key where it's kept
  lives: [],             // the runs going on (any number at once): [{ token, run, scope: { file, test, id, untilTurn, onlyTurn } }]
  runs: [],              // runs kept here, newest first (summaries)
  openRun: null,         // a run opened from Runs (the whole of it)
  lastRuns: {},          // test key -> its latest run (whole)
  lastSuiteRuns: {},     // suite file -> its latest run of the whole suite
  conversations: [],     // the conversations kept here: { _id, title, provider, started, updated, turns, size }
  scopes: [],            // the folder's scopes with files: [{ name, file, values, errors }] (environments/<scope>.yml)
  secretScopes: [],      // the scopes that have secrets kept ("" is every scope's)
  scopeSecrets: {},      // scope → the names of its secrets (for the chosen scope, and ""): checked in fields
  relay: null,           // the relay's address, when served by `hafen serve`
  error: null,
});

let engine = null;
let browserOpen = null;  // what the browser build opened: { handle } or { files }

const get = () => app.get();
const set = (changes) => app.set(changes);

/* ---------- starting, opening ---------- */

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
  await loadRuns();
  await loadConversations();
  // The scopes that have secrets (and the one chosen last), known before a folder is open: a
  // conversation can use them, and Settings → Environments choose among them
  await refreshSecrets().catch(() => {});
  if (isApp) {
    const root = store.get(KEYS.root);
    if (root) await openRoot(root).catch((err) => say(`couldn't open ${root}: ${err.message}`, "err"));
  }
  set({ ready: true });
}

const secretsForBrowser = () => store.getJSON(KEYS.secrets, {});

// The desktop app's engine stopped and was started again: what it held (a run going on, the
// conversation) is gone, so it's cleared here, and the folder is opened again
function engineRestarted() {
  say("the engine stopped unexpectedly and was started again", "err");
  notify({ title: "The engine was restarted", text: "A run or message going on was stopped. The folder is open again.", kind: "error" });
  const c = get().conversation;
  set({ lives: [], conversation: c ? { ...c, token: newToken(), sending: false, error: null } : null });
  delete document.documentElement.dataset.running;
  const root = get().root;
  if (isApp && root) openRoot(root).catch((err) => say(`couldn't open ${root} again: ${err.message}`, "err"));
}

// The desktop app: a folder by its path
async function openRoot(root) {
  const loaded = await engine.call("open", { root });
  store.set(KEYS.root, root);
  setLoaded(loaded, { root, canWrite: true });
}

export async function openFolder() {
  try {
    if (isApp) {
      const root = await invoke("open_folder");
      if (root) await openRoot(root);
      return;
    }
    if (!window.showDirectoryPicker) {
      notify({ title: "Open a folder", text: "This browser can't open folders: open suite files instead, or use the desktop app.", kind: "error" });
      return;
    }
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    browserOpen = { handle };
    const loaded = await engine.call("open", { handle, relay: get().relay, secrets: secretsForBrowser() });
    setLoaded(loaded, { root: handle.name, canWrite: true });
  } catch (err) {
    if (err.name !== "AbortError") say(`couldn't open the folder: ${err.message}`, "err");
  }
}

// The browser build without folders: suite and provider files, picked one by one (kept in memory)
export async function openFiles(fileList) {
  const files = {};
  for (const f of fileList) {
    const path = f.webkitRelativePath || (/\.(ya?ml|json)$/i.test(f.name) && !/\.hafen\./i.test(f.name) ? `providers/${f.name}` : f.name);
    files[path] = await f.text();
  }
  browserOpen = { files };
  const loaded = await engine.call("open", { files, relay: get().relay, secrets: secretsForBrowser() });
  setLoaded(loaded, { root: null, canWrite: false });
}

function setLoaded({ suites, providers, scopes = [] }, { root, canWrite }) {
  const envs = scopeNames({ suites, scopes, secretScopes: get().secretScopes });
  const env = envs.includes(get().env) ? get().env : envs[0] ?? null;
  const before = get();
  const fresh = before.opened && before.root !== root;  // another folder: nothing carries over
  if (fresh) changes.length = 0;
  const sel = before.selection;
  const was = !fresh && sel.file !== undefined && sel.test !== undefined ? testOf(sel.file, sel.test) : null;
  set({ opened: true, root, canWrite, suites, providers, env, scopes });
  refreshSecrets().catch(() => {});
  // The selection, where it is now: its test found by id (a file edited as a whole, or elsewhere,
  // may have moved it), its suite, or nothing
  if (fresh || (sel.file !== undefined && !suites.some((s) => s.file === sel.file))) select({ kind: "conversation" });
  else if (was) {
    const index = (suiteOf(sel.file)?.data?.tests ?? []).findIndex((t) => (t.id ?? t.name) === (was.id ?? was.name));
    if (index === -1) select({ kind: "suite", file: sel.file });
    else if (index !== sel.test) set({ selection: { ...sel, test: index } });
  }
  // A conversation (or the remembered provider) whose provider file is gone
  const conversation = get().conversation;
  if (fresh || (conversation?.provider && !providers.some((p) => p.file === conversation.provider))) {
    if (conversation?.token) engine.call("reset", { token: conversation.token }).catch(() => {});
    set({ conversation: null });
  }
  if (store.get(KEYS.provider) && !providers.some((p) => p.file === store.get(KEYS.provider))) store.remove(KEYS.provider);
  emit("suites:changed");
  say(`${root ? `${root}: ` : ""}${suites.length} suite${suites.length === 1 ? "" : "s"}, ${providers.length} provider${providers.length === 1 ? "" : "s"}`, "log");
  for (const s of suites) for (const e of s.errors ?? []) say(`${e.file}${e.line ? `:${e.line}:${e.column}` : ""}  ${e.message}`, "err");
}

export async function reload() {
  if (!get().opened) return;
  setLoaded(await engine.call("load"), { root: get().root, canWrite: get().canWrite });
}

// The browser build gives the open engine new secrets or a new relay (its files, edits and
// conversations stay)
export async function reconfigure() {
  if (isApp || !browserOpen) return;
  await engine.call("configure", { relay: get().relay, secrets: secretsForBrowser() });
}

export const environments = (suites) => [...new Set(suites.flatMap((s) => Object.keys(s.data?.environments ?? {})))];

// Every scope there is to choose (Settings → Environments; --env in CI): the folder's
// scope files (environments/<scope>.yml), the suites' environments, and the scopes with secrets
export function scopeNames({ suites, scopes, secretScopes } = get()) {
  return [...new Set([...(scopes ?? []).map((s) => s.name), ...environments(suites ?? []), ...(secretScopes ?? []).filter(Boolean)])];
}

export function setEnv(env) {
  store.set(KEYS.env, env);
  set({ env });
  audit("config.scope", { scope: env });
  refreshSecrets().catch(() => {});
}

// Which scopes have secrets, and the names of the chosen scope's (and every scope's): for the
// picker, and for the fields' check of {{scope.NAME}} (never a value)
export async function refreshSecrets() {
  const env = get().env ?? "";
  let scopesWithSecrets;
  let names;
  if (isApp) {
    scopesWithSecrets = (await invoke("secrets_scopes")) ?? [];
    names = Object.fromEntries(await Promise.all([...new Set([env, ""])].map(async (e) => [e, Object.keys((await invoke("secrets_list", { env: e })) ?? {})])));
  } else {
    const all = store.getJSON(KEYS.secrets, {});
    scopesWithSecrets = Object.keys(all).filter((e) => Object.keys(all[e] ?? {}).length);
    names = Object.fromEntries([...new Set([env, ""])].map((e) => [e, Object.keys(all[e] ?? {})]));
  }
  set({ secretScopes: scopesWithSecrets, scopeSecrets: names });
  // The scope chosen last, if it's one that has only secrets (not known when the folder was read, so
  // the first one was chosen meanwhile): chosen again
  const remembered = store.get(KEYS.env);
  if (remembered && remembered !== get().env && scopeNames().includes(remembered)) set({ env: remembered });
  // A scope that has only secrets is one to choose too (once a folder is open: before, one is only
  // chosen again, so a folder's own environments come first)
  if (!get().env && get().opened) {
    const first = scopeNames()[0];
    if (first) set({ env: first });
  }
}

// A scope's variables (environments/<scope>.yml, plain YAML): created, changed, deleted
export const scopeFile = (name) => `environments/${name}.yml`;
export async function addScope(name) {
  const next = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(next)) throw new Error("A scope's name is letters, digits, '.', '-' and '_'.");
  await engine.call("create", { file: scopeFile(next), text: `# The "${next}" scope's variables, plain text: use one in any field as {{scope.NAME}}\n# (its secrets are kept apart, in Settings → Secrets)\n` });
  await reload();
  audit("scope.create", { scope: next });
  return next;
}
export async function setScopeVariable(scope, name, value) {
  const known = get().scopes.find((s) => s.name === scope);
  const file = known?.file ?? scopeFile(scope);
  if (!known) await engine.call("create", { file, text: `# The "${scope}" scope's variables, plain text: use one in any field as {{scope.NAME}}\n` });
  await engine.call("editFile", { file, edits: [value === null ? { op: "delete", path: [name] } : { op: "set", path: [name], value }] });
  await reload();
  audit("scope.variable", { scope, name, action: value === null ? "delete" : "set" });
}
export async function deleteScope(scope) {
  const file = get().scopes.find((s) => s.name === scope)?.file;
  if (file) await engine.call("remove", { file });
  await reload();
  audit("scope.delete", { scope });
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
    if (!get().canWrite) offerDownload(file);
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
  if (!get().canWrite) offerDownload(file, text);
  return suite;
}

async function offerDownload(file, text) {
  const content = text ?? (await engine.call("read", { file }));
  const url = URL.createObjectURL(new Blob([content], { type: "text/yaml" }));
  Object.assign(document.createElement("a"), { href: url, download: file.split("/").pop() }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Delete a suite or provider file from the open folder (the design system's confirm-twice delete
// asks first). In the browser build with files opened one by one, it's only closed: the file on disk
// was never the app's to change.
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
  await reload();
  say(get().canWrite ? `deleted ${file}` : `closed ${file} (it stays where it was on your disk)`, "log");
}

// What the thread and timeline show for a suite (file) or one of its tests (test) that's gone:
// their last results, a run of them going on, and the conversation that was saved as it. (Runs
// stay in Runs: they're the record.)
function forget(file, test) {
  const id = test ? test.id ?? test.name : null;
  changes.push({ forget: test ? `${file}#${id}` : file, at: Date.now() });
  set({ lastRuns: Object.fromEntries(Object.entries(get().lastRuns).filter(([k]) => (test ? k !== `${file}#${id}` : !k.startsWith(`${file}#`)))) });
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
// was deleted since it ran. Opening another folder starts it over (its files are its own).
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
// A run kept from another folder (one with the same names isn't this one's)
const fromAnotherFolder = (run) => !!run.folder && !!get().root && run.folder !== get().root;
// A run of a whole suite: no test, tag or turn picked out
const wholeRun = (run) => {
  const f = run.settings?.filters ?? {};
  return !(f.ids?.length || f.tests?.length || f.tags?.length) && (run.settings?.until_turn ?? null) === null;
};

// Each suite's latest run of the whole suite, from the runs kept here
function lastSuiteRunsFrom(all) {
  const out = {};
  for (const run of [...all].sort((a, b) => a.started - b.started)) {
    if (!wholeRun(run) || run.mode !== "test" || fromAnotherFolder(run)) continue;
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
    if (fromAnotherFolder(run)) continue;
    const shown = movedRun(run, new Map((run.suites ?? []).map((x) => [x.file, nameNow(run, x.file, undefined, { names: true })])));
    for (const t of run.tests ?? []) {
      const now = nameNow(run, t.suite, t.id ?? t.name);
      if (now) out[`${now}#${t.id ?? t.name}`] = shown;
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

// Rename a suite's file (name.hafen.yml), in the same folder; its tests' last results follow it.
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
  set({ lastRuns: Object.fromEntries(Object.entries(get().lastRuns).map(([k, v]) => (k.startsWith(`${file}#`) ? [`${to}${k.slice(file.length)}`, movedRun(v, moved)] : [k, v]))) });
  const suiteRuns = { ...get().lastSuiteRuns };
  if (suiteRuns[file]) { suiteRuns[to] = movedRun(suiteRuns[file], moved); delete suiteRuns[file]; }
  set({ lastSuiteRuns: suiteRuns });
  const saved = get().conversation?.savedTo;
  if (saved?.file === file) set({ conversation: { ...get().conversation, savedTo: { ...saved, file: to } } });
  // The selection follows it (set before the folder's read again, which would otherwise let it go)
  const { selection } = get();
  if (selection.file === file) set({ selection: { ...selection, file: to } });
  await reload();
  if (selection.file === file) select({ ...get().selection });
  say(`renamed ${file} to ${to}`, "log");
  if (!get().canWrite) offerDownload(to);
  return to;
}

const newTestValue = () => ({ id: testId(), name: "New test", turns: [{ user: "Hello" }] });

// The next new suite's file: tests.hafen.yml, then tests-2.hafen.yml, …
export function freeSuiteFile() {
  const { suites } = get();
  let n = 1;
  const fileOf = (i) => (i === 1 ? "tests.hafen.yml" : `tests-${i}.hafen.yml`);
  while (suites.some((x) => x.file === fileOf(n))) n++;
  return fileOf(n);
}

// A new suite file with one test, using the first provider, and the environments and variables of a
// suite that already uses it (so what its templates need, {{base_url}} say, is set)
export async function newSuite() {
  const { providers, suites } = get();
  const file = freeSuiteFile();
  const provider = providers[0]?.file;
  const like = provider ? suites.find((s) => Object.values(s.providerFiles ?? {}).includes(provider)) : null;
  try {
    await createSuite(file, {
      name: file.replace(SUITE_FILE, ""), provider: provider ? relativePath(file, provider) : "openai-chat",
      environments: like?.data?.environments, variables: like?.data?.variables, tests: [newTestValue()],
    });
  } catch (err) {
    say(`couldn't add ${file}: ${err.message}`, "err");
    notify({ title: `Couldn't add ${file}`, text: err.message, kind: "error" });
    throw err;
  }
  if (!get().canWrite) offerDownload(file);
  select({ kind: "test", file, test: 0 });
  say(`added ${file}`, "log");
  return file;
}

// A new test at the end of a suite
export async function newTest(file) {
  const suite = await editSuite(file, [{ op: "add", path: ["tests"], value: newTestValue() }]);
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
  if (!get().canWrite) for (const f of [to, ...renamed.suites]) offerDownload(f);
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
  if (!get().canWrite) offerDownload(file, text);
  if (choose) chooseProvider(file);
  say(`added ${file}`, "log");
  return file;
}

// A provider plugin as a provider (Settings → Plugins makes one with each new provider plugin;
// Settings → Providers, for one that has none): providers/<name>.yml, kind: plugin:<name>, its name
// free (acme-2…). Listed in Providers, used as any provider is.
export async function createPluginProvider(plugin, file) {
  const base = plugin.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "plugin";
  let name = base;
  for (let n = 2; get().providers.some((p) => p.file === `providers/${name}.yml`); n++) name = `${base}-${n}`;
  return createProvider(name, pluginProviderText(plugin, file), { choose: false });
}
export const pluginProviderText = (plugin, file) => `# A provider made by the plugin "${plugin}" (${file}), which Hafen loads from the folder's plugins/.
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
    if (c.token) engine.call("reset", { token: c.token }).catch(() => {});
    set({ conversation: { ...c, token: newToken(), provider: providerFile, error: null } });
    return;
  }
  resetConversation();
  set({ conversation: { id: newToken(), token: newToken(), provider: providerFile, run: null, sending: false, error: null } });
}

// A new conversation (the one going on is kept, under Conversations, if it has any turns)
export function resetConversation() {
  const c = get().conversation;
  if (c?.token) engine.call("reset", { token: c.token }).catch(() => {});
  set({ conversation: c ? { id: newToken(), token: newToken(), provider: c.provider, run: null, error: null, sending: false } : null });
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
  if (c?.token) engine.call("reset", { token: c.token }).catch(() => {});
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
  if (c.token) engine.call("reset", { token: c.token }).catch(() => {});
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
function contextSuite(providerFile) {
  const { selection, suites } = get();
  if (selection.file && suites.some((s) => s.file === selection.file)) return selection.file;
  const using = suites.find((s) => Object.values(s.providerFiles ?? {}).includes(providerFile));
  return (using ?? suites[0])?.file;
}

export async function sendMessage(text) {
  let c = get().conversation;
  if (!c?.provider) {
    const first = store.get(KEYS.provider) ?? get().providers[0]?.file;
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
    const call = engine.call("send", { token, providerFile: c.provider, suiteFile: contextSuite(c.provider), env: get().env, message: text, history: "live", seed });
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
  if (!get().canWrite) offerDownload(file);
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
  const options = { env: get().env ?? undefined, load: false };
  if (test && Number.isInteger(onlyTurn)) {
    options.onlyTurn = onlyTurn;
    // The earlier turns' records from its last run, as the file has them now
    const last = runForTest(file, testIndex);
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
    done();
    const failed = run.verdict === "failed" || run.status === "error";
    // As Settings → Notifications says: a sound (when what ran isn't what's open, by default), the
    // system's notification (the window in the background); the toast, or that, clicked opens what ran
    const outcome = run.status === "stopped" ? "stopped" : failed ? "failed" : "passed";
    const actions = runEndActions(outcome, isViewing(file, test));
    notify({
      title: run.status === "error" ? "Couldn't run" : run.status === "stopped" ? "Stopped" : `${failed ? "Failed" : run.verdict === "unsure" ? "Passed, unsure" : "Passed"}: ${test?.name ?? suiteOf(file)?.name ?? file}${options.untilTurn !== undefined ? ` (to turn ${options.untilTurn + 1})` : options.onlyTurn !== undefined ? ` (turn ${options.onlyTurn + 1} only)` : ""}`,
      text: run.error?.message ?? `${run.summary?.checks?.passed ?? 0}/${run.summary?.checks?.total ?? 0} checks · ${((run.ms ?? 0) / 1000).toFixed(1)} s`,
      kind: failed ? "error" : "ok",
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
// its suites whole. What the open folder hasn't got any more is said, not run instead as something else.
export async function runAgain(run) {
  if (!wholeRun(run) && run.tests?.length === 1) {
    const t = run.tests[0];
    const index = (suiteOf(t.suite)?.data?.tests ?? []).findIndex((x) => (x.id ?? x.name) === (t.id ?? t.name));
    if (index < 0) throw new Error(`"${t.name}" isn't in the open folder any more`);
    const s = run.settings ?? {};
    return runTests(t.suite, index, { untilTurn: s.until_turn ?? undefined, onlyTurn: s.only_turn ?? undefined });
  }
  const files = (run.suites ?? []).map((x) => x.file).filter((f) => suiteOf(f));
  if (!files.length) throw new Error("its suites aren't in the open folder");
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

const summaryOf = (run) => ({
  _id: run._id, mode: run.mode, started: run.started, ms: run.ms, status: run.status, verdict: run.verdict,
  name: run.tests.length === 1 ? run.tests[0].name : run.suites.map((s) => s.name).join(", ") || "run",
  // (a run of one test that repeats: how many times, for ×3)
  repeat: run.tests.length === 1 ? run.tests[0].settings?.repeat : undefined,
  suites: run.suites.map((s) => s.file), tests: run.tests.map((t) => ({ id: t.id, name: t.name, suite: t.suite, index: t.index, status: t.status })),
  size: new Blob([JSON.stringify(run)]).size,
});

export async function loadRuns() {
  try {
    const all = await idb.all("runs");
    const usable = all.filter((r) => Array.isArray(r?.tests) && Array.isArray(r?.suites));
    const runs = usable.map(summaryOf).sort((a, b) => b.started - a.started);
    set({ runs, lastRuns: lastRunsFrom(usable), lastSuiteRuns: lastSuiteRunsFrom(usable) });
  } catch (err) {
    say(`couldn't read the runs kept here: ${err.message}`, "err");
  }
}

export async function keepRun(run) {
  if (!run || run.mode === "explore") return;
  // (which folder it's of: another folder's suites by the same names aren't these)
  if (!run.folder && get().root) run = { ...run, folder: get().root };
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

// The run a test's thread shows: the one going on that runs it, or its latest
export function runForTest(file, testIndex) {
  return liveForTest(file, testIndex)?.run ?? get().lastRuns[testKey(file, testIndex)] ?? null;
}

export function compareRuns(run, baseline) {
  return engine.call("compare", { run, baseline, thresholds: { pass_rate: 5, p95: 20, cost: 20 } });
}

export const engineCall = (cmd, args) => engine.call(cmd, args);
