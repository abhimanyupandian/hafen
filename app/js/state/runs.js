// Running suites and tests (any number at once, each drawn live from the engine's events), and the runs
// kept in this browser's storage: opened, imported, exported, compared.

import { parseRun, runFileName, serializeRun } from "hafen/engine/reports/run-file.js";
import { newToken } from "../host.js";
import { closeDrawer } from "../lib/dom.js";
import { emit } from "../lib/events.js";
import * as idb from "../lib/idb.js";
import { say } from "../lib/log.js";
import { audit, auditEvent } from "../lib/audit.js";
import { pairTurns, refusedRun, runName, runOutcome, testResult, turnsOf } from "../views/derive.js";
import { notify } from "../design/toast.jsx";
import { inFront, runEndActions } from "../lib/notifications.js";
import { engine, get, scopeArgs, select, set, suiteOf, testKey, testOf, threadMode } from "../state.js";
import { lastRunsFrom, lastSuiteRunsFrom, lastTriesFrom, wholeRun } from "./suites.js";

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
  const options = scopeArgs();
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
export function createLiveRun(base, from = null) {
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
  const run = parseRun(text);
  if (run.mode === "explore") throw new Error("this is a conversation's run, not a test's: it isn't opened under Runs");
  if (typeof run._id !== "string" || !Array.isArray(run.tests) || !Array.isArray(run.suites) || !Array.isArray(run.turns)) throw new Error("this run file is missing its _id, suites, tests or turns");
  await keepRun(run);
  audit("run.import", { run: run._id });
  await openRun(run._id);
}

export function exportRun(run) {
  const url = URL.createObjectURL(new Blob([serializeRun(run)], { type: "application/json" }));
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
