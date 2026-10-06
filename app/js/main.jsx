// Hafen: end-to-end tests for chat endpoints. The app's entry point: draws the frame (React, into
// #app) from hafen's design system (spec/design/), connects to the engine, and follows the address.
//
//   design/   the design system's components, copied from hafen, and its Additions (check badge, JSON
//             tree, timeline, charts)
//   lib/      helpers (storage, events, DOM, formatting, the address, the desktop bridge, IndexedDB)
//   views/    the sidebar's sections, the thread, the message box, the panel, settings
//   state.js  what's open and selected; the engine's commands; runs
//   host.js   the engine: a Web Worker (browser) or the desktop app's utility process
//   ../../engine/  the engine itself (no DOM): the same code the CLI runs

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import "./lib/prefs.js";
import { useNow, useStore } from "./design/hooks.js";
import { GroupBadge, RepeatBadge, Spinner } from "./design/badges.jsx";
import { Console, write } from "./design/console.jsx";
import { ContextMenu } from "./design/context-menu.jsx";
import { Icon } from "./design/icons.jsx";
import { Logo } from "./design/logo.jsx";
import { initSettings, openSettings, SettingsModal } from "./design/settings-modal.jsx";
import { Guard } from "./views/guard.jsx";
import { expandSidebar, initSidebar, MenuButton, NavFoot, NavHead, NavResizer, Scrim } from "./design/sidebar.jsx";
import { TimelineDock } from "./design/timeline.jsx";
import { Toasts } from "./design/toast.jsx";
import { Tooltip } from "./design/tooltip.jsx";
import { $, closeDrawer, pageReady } from "./lib/dom.js";
import { attachLog, say } from "./lib/log.js";
import { onRouteChange, readRoute } from "./lib/url.js";
import { app, liveForSuite, liveForTest, liveIn, openConversation, openRun, runForTest, runSelection, runTests, select, start, stopRun, stopSending, suiteOf, suiteRunFor, testOf, threadMode } from "./state.js";
import { isRunKey, RUN_KEY } from "./lib/keys.js";
import { Composer } from "./views/composer.jsx";
import { Panel } from "./views/panel.jsx";
import { ChecksSection, ConversationsSection, RunsSection, SuitesSection } from "./views/sections.jsx";
import { panes, usage } from "./views/settings.jsx";
import { Thread } from "./views/thread.jsx";
import { repeatOf, testResult, testStatusText } from "./views/derive.js";
import { ago, sec } from "./lib/format.js";

// The scope chosen (stage, prod…: its variables and secrets fill {{scope.NAME}}; a suite's environment
// of that name applies too): a button that names it and opens Settings → Environments, where it's chosen
function ScopeButton() {
  const { env } = useStore(app);
  const label = env ? `Scope: ${env}` : "Scope: none chosen";
  return (
    <button id="scopeButton" className="btn btn-ghost scope-button" type="button" aria-haspopup="dialog" aria-label={`${label}. Choose a scope`}
            title={`${label}: its variables and secrets fill {{scope.NAME}}. Click to choose one, or edit them`} onClick={() => openSettings("environments")}>
      <Icon name="scope" /><span className="scope-name">{env || "no scope"}</span>
    </button>
  );
}

function TopBar() {
  const state = useStore(app);
  const now = useNow();
  const { selection, conversation, openRun: run } = state;
  const mode = threadMode();
  let badges = null;  // a test's or a suite's group, and ×3 for a test that repeats
  let title = "New conversation";
  let status = "";
  let error = false;
  let play = null;  // the test's or suite's run (or stop) button: { running, run, what }
  if (mode === "explore") {
    const turns = conversation?.run?.turns?.length ?? 0;
    if (turns) title = conversation.title || String(conversation.run.turns.find(Boolean)?.user ?? "Conversation").replace(/\s+/g, " ").trim().slice(0, 60);
    status = conversation?.sending ? "sending…" : conversation?.error ?? (turns ? `${turns} turn${turns === 1 ? "" : "s"}` : "");
    error = !!conversation?.error;
  } else if (mode === "test") {
    const test = testOf(selection.file, selection.test);
    title = test?.name ?? "Test";
    const r = runForTest(selection.file, selection.test);
    const result = testResult(r, selection.file, test);
    const going = liveForTest(selection.file, selection.test);
    const isLive = !!going;
    play = { running: isLive, stop: () => stopRun(going?.token), run: () => runTests(selection.file, selection.test).catch(() => {}), what: "test" };
    status = isLive ? "running…" : result ? `${testStatusText(result).text}${r?.ms ? ` · ${sec(r.ms)}` : ""}${r?.started ? ` · ${ago(r.started, now)}` : ""}` : "not run yet";
    error = result?.status === "failed" || result?.status === "error";
    badges = <><GroupBadge group={test?.group} id="evalGroup" /><RepeatBadge times={repeatOf(suiteOf(selection.file), test)} id="evalRepeat" /></>;
  } else if (mode === "suite") {
    const suite = suiteOf(selection.file);
    title = suite?.name ?? selection.file;
    const r = suiteRunFor(selection.file);
    const going = liveForSuite(selection.file);
    const isLive = !!going;
    // (A test of it running alone: the whole suite waits for it)
    play = { running: isLive, stop: () => stopRun(going?.token), run: () => runTests(selection.file).catch(() => {}), what: "suite", busy: !isLive && !!liveIn(selection.file) };
    const s = r?.summary?.tests;
    status = isLive ? "running…" : r ? `${r.status === "done" ? r.verdict : r.status} ${s ? `${s.passed}/${s.total}` : ""}${r.ms ? ` · ${sec(r.ms)}` : ""}${r.started ? ` · ${ago(r.started, now)}` : ""}` : "not run yet";
    error = r?.verdict === "failed" || r?.status === "error";
    badges = <GroupBadge group={suite?.data?.group} of="suite" id="evalGroup" />;
  } else if (mode === "run") {
    const t = run?.tests?.[0];
    title = `${run?.tests?.length === 1 ? t?.name : "Run"} · run`;
    status = `${run?.status === "done" ? run?.verdict : run?.status} · ${sec(run?.ms)}${run?.started ? ` · ${ago(run.started, now)}` : ""}`;
    error = run?.verdict === "failed" || run?.status === "error";
  }
  return (
    <header className="topbar" id="topbar">
      <MenuButton className="btn btn-ghost btn-icon" />
      <Logo className="brand-icon topbar-brand" id="topbarBrand" />
      {/* (while what's shown runs, a circle going round in place of its icon) */}
      <span className="topbar-icon" id="evalIcon" data-mode={mode} data-running={play?.running ? "" : undefined} aria-hidden="true">
        {play?.running ? <Spinner size={16} /> : <Icon name={{ explore: "chat", suite: "suite", test: "test", run: "runs" }[mode] ?? "chat"} size={16} />}
      </span>
      <h1 className="title" id="evalTitle">{title}</h1>
      {badges && <span className="topbar-badges">{badges}</span>}
      <div className="model-status">
        {play && (
          <button id="testHeaderRun" className={`btn btn-ghost btn-icon topbar-run${play.running ? " stop" : ""}`} type="button" disabled={play.busy}
                  aria-label={play.running ? "Stop the run" : `Run this ${play.what}`} title={play.running ? "Stop" : play.busy ? "A test of it is running" : `Run this ${play.what} (${RUN_KEY})`}
                  onClick={() => (play.running ? play.stop() : play.run())}>
            <Icon name={play.running ? "stop" : "run"} size={16} />
          </button>
        )}
        <span id="status" role="status" className={error ? "error" : undefined} title={status}>{status}</span>
      </div>
      {/* (small screens only, as the menu's button: the panel, over the thread) */}
      <button id="panelToggle" className="btn btn-ghost btn-icon topbar-panel" type="button" aria-label={state.panelOpen ? "Hide the details" : "Show the details"}
              aria-expanded={state.panelOpen} aria-controls="panel" title="Details" onClick={() => app.set({ panelOpen: !state.panelOpen })}>
        <Icon name="sidebar" size={16} />
      </button>
    </header>
  );
}

// The collapsed sidebar (a rail) shows its sections as icons; one expands it, open on that section
const RAIL = [["conversations", "chat", "Conversations"], ["suites", "suite", "Suites"], ["checks", "check", "Checks"], ["runs", "runs", "Runs"]];
function NavRail() {
  const show = (name) => {
    expandSidebar();
    requestAnimationFrame(() => {
      const toggle = document.getElementById(`${name}Toggle`);
      if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
      toggle?.scrollIntoView({ block: "nearest" });
      toggle?.focus();
    });
  };
  return (
    <div className="nav-rail" id="navRail" role="toolbar" aria-label="Sections" aria-orientation="vertical">
      {RAIL.map(([name, icon, label]) => (
        <button key={name} id={`rail-${name}`} className="btn btn-ghost btn-icon" type="button" aria-label={label} title={label} onClick={() => show(name)}>
          <Icon name={icon} />
        </button>
      ))}
    </div>
  );
}

function Timeline() {
  const state = useStore(app);
  const { selection, conversation, lives, openRun: run } = state;
  const mode = threadMode();
  const source = mode === "explore" ? conversation?.run : mode === "run" ? run : mode === "suite" ? suiteRunFor(selection.file) : runForTest(selection.file, selection.test);
  const running = mode === "explore" ? !!conversation?.sending : lives.some((l) => l.run === source);
  const suiteView = mode === "suite";
  return (
    // A suite's view: its last whole run, at the suite's and its tests' level (a test opens to its steps)
    <TimelineDock spans={source?.spans ?? []} running={running} selected={selection.span}
                  show={suiteView ? ["suite"] : []} collapse={suiteView ? ["test"] : []}
                  empty={suiteView ? "Run the suite to see its tests here." : undefined}
                  onSelect={(span) => {
                    // The suite's bar opens the suite; a test's, the test
                    if (span.kind === "suite" && span.ref?.suite && suiteOf(span.ref.suite)) return select({ kind: "suite", file: span.ref.suite });
                    if (span.kind === "test" && span.ref?.suite) {
                      const index = (suiteOf(span.ref.suite)?.data?.tests ?? []).findIndex((t) => (t.id ?? t.name) === span.ref.test);
                      if (index > -1) return select({ kind: "test", file: span.ref.suite, test: index });
                    }
                    const turn = span.ref?.turn !== undefined ? source?.turns?.[span.ref.turn] : null;
                    // A step of another test (a suite's run, shown in a test's view): that test, at its turn,
                    // not this test's turn of the same number
                    const shown = mode === "test" ? testOf(selection.file, selection.test) : null;
                    if (turn && shown && (turn.suite !== selection.file || turn.test !== (shown.id ?? shown.name))) {
                      const index = (suiteOf(turn.suite)?.data?.tests ?? []).findIndex((t) => (t.id ?? t.name) === turn.test);
                      return select(index > -1
                        ? { kind: "step", span: span._id, file: turn.suite, test: index, turn: turn.index, in: "test", run: source?._id }
                        : { kind: "step", span: span._id, file: selection.file, test: selection.test, in: "test", run: source?._id }, { route: false });
                    }
                    select({ ...selection, kind: "step", span: span._id, explore: mode === "explore" || undefined, in: mode, turn: turn ? turn.index ?? span.ref.turn : selection.turn, run: source?._id }, { route: false });
                  }} />
  );
}

function EvalApp() {
  return (
    <>
      <aside className="nav" id="nav" aria-label="Sidebar">
        <NavHead><ScopeButton /></NavHead>
        <div className="nav-body" id="navBody">
          <Guard what="Conversations"><ConversationsSection /></Guard>
          <Guard what="Suites"><SuitesSection /></Guard>
          <Guard what="Checks"><ChecksSection /></Guard>
          <Guard what="Runs"><RunsSection /></Guard>
        </div>
        <NavRail />
        <NavFoot />
        <NavResizer />
      </aside>
      <Scrim />
      <main className="main" id="main">
        <div className="work-area" id="workArea">
          <div className="work" id="work">
            <TopBar />
            <Guard what="The thread" id="threadCrash" fallbackClass="scroller"><Thread /></Guard>
            <Composer />
          </div>
          <Guard what="The panel" id="panelCrash" fallbackClass="panel"><Panel /></Guard>
        </div>
        <Guard what="The timeline"><Timeline /></Guard>
        <Console />
      </main>
      <Tooltip />
      <ContextMenu />
      <SettingsModal />
      <Toasts />
    </>
  );
}

attachLog(write);
initSettings({ panes: panes(), usage });
flushSync(() => createRoot($("app")).render(<EvalApp />));
initSidebar();
document.addEventListener("keydown", (e) => {
  // ⌘↵ / Ctrl+Enter: run what's selected (a turn: its test up to it; a test; a suite). Not in a
  // dialog (the large editor saves with it), nor in the message box while exploring (it sends)
  if (isRunKey(e)) {
    // (A dialog's own: the large editor saves with it, and may have closed by now)
    if (e.defaultPrevented || e.target?.closest?.("dialog") || document.querySelector("dialog[open]")) return;
    const mode = threadMode();
    if (mode !== "test" && mode !== "suite") return;
    e.preventDefault();
    // A field being typed in is saved first (on blur); the run reads the file after it
    const field = document.activeElement;
    if (field && /^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName) && field.id !== "input") field.blur();
    runSelection();
    return;
  }
  if (e.key !== "Escape") return;
  // (Esc in a dialog closes it, Settings or the large editor, and does nothing else: the dialog is
  // still open as the key comes here; a menu's Esc closes the menu, and isn't passed on)
  if (e.defaultPrevented || e.target?.closest?.("dialog") || document.querySelector("dialog[open]")) return;
  stopRun();
  stopSending();
  closeDrawer();
});

// Open what the address asks for (a test, a run)
async function followRoute({ tab, _id }) {
  // The plain address: the conversation (Back to it from a test or a run goes there)
  if (!tab || !_id) {
    const sel = app.get().selection;
    if (sel.kind !== "conversation" || sel.explore) select({ kind: "conversation" }, { route: false });
    return;
  }
  if (tab === "runs") return openRun(_id);
  if (tab === "conversations") return openConversation(_id);
  if (tab === "suites") {
    for (const s of app.get().suites) {
      const index = (s.data?.tests ?? []).findIndex((t) => t.id === _id);
      if (index > -1) return select({ kind: "test", file: s.file, test: index }, { route: false });
    }
    // A test without an id: <file>#<its name>
    const at = _id.indexOf("#");
    const file = _id.slice(0, at);
    const index = (app.get().suites.find((s) => s.file === file)?.data?.tests ?? []).findIndex((t) => t.id === undefined && t.name === _id.slice(at + 1));
    if (at > 0 && index > -1) return select({ kind: "test", file, test: index }, { route: false });
    say(`there's no test ${_id} in the open folder`, "err");
  }
}

start()
  .then(() => followRoute(readRoute()))
  .catch((err) => say(`couldn't start: ${err.message}`, "err"))
  .finally(pageReady);
onRouteChange(followRoute);
