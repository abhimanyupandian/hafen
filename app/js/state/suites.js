// Editing suites: every change goes to the suite's file through the engine, which keeps its comments;
// and what a rename or a delete does to the runs kept of it.

import { freeTestName, testId } from "hafen/engine/util.js";
import { emit } from "../lib/events.js";
import { say } from "../lib/log.js";
import { KEYS, store } from "../lib/store.js";
import { notify } from "../design/toast.jsx";
import { checkSuites, engine, forgetExport, get, moveExport, reload, select, set, SUITE_FILE, suiteOf, testOf } from "../state.js";
import { chooseProvider, providerInUse, relativePath, resetConversation } from "./conversations.js";
import { liveIn, stopRun } from "./runs.js";

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
export const wholeRun = (run) => {
  const f = run.settings?.filters ?? {};
  return !(f.ids?.length || f.tests?.length || f.tags?.length) && (run.settings?.until_turn ?? null) === null;
};

// Each suite's latest run of the whole suite, from the runs kept here
export function lastSuiteRunsFrom(all) {
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
export function lastRunsFrom(all) {
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
export function lastTriesFrom(all) {
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
