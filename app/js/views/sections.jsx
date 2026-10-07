// The sidebar's sections (contracts/ui.md, Sidebar): Suites (a tree of suites, tests and turns), Runs,
// and Checks (palette cards, by group, that add a check to the selected turn). Providers are in Settings.

import { useEffect, useRef, useState } from "react";
import { GroupBadge, RepeatBadge, Spinner } from "../design/badges.jsx";
import { NavSection } from "../design/collapsible.jsx";
import { ConfirmButton } from "../design/confirm.jsx";
import { openMenu } from "../design/context-menu.jsx";
import { useNow, useStore } from "../design/hooks.js";
import { Icon } from "../design/icons.jsx";
import { List, ListRow } from "../design/list.jsx";
import { isApp } from "../lib/app.js";
import { ago, sec, when, whenFull } from "../lib/format.js";
import { matches, searchWords } from "../lib/search.js";
import { SearchField } from "../design/search.jsx";
import { KEYS, store } from "../lib/store.js";
import { notify } from "../design/toast.jsx";
import {
  app, chooseProvider, clearRuns, deleteConversation, deleteFile, deleteRun, deleteTest, deleteTurn, editSuite, freeSuiteFile, importRun, newSuite, newTest, openFiles, openFolder, openRun,
  openConversation, problemsOf, providerInUse, resetConversation, runForTest, runTests, select, stopRun, SUITE_NAME,
} from "../state.js";
import { CHECK_GROUPS, CHECK_TYPES } from "./check-types.js";
import { pairTurns, repeatOf, testResult, testStatusText, turnChecksText, turnStatus, turnsOf } from "./derive.js";

// A turn's icon (a box with a tick), coloured by how it last went: passed, failed, unsure; while it
// runs, a circle going round
export const TurnIcon = ({ status }) => (
  <span className="turn-icon" data-status={status || undefined} aria-hidden="true">{status === "running" ? <Spinner /> : <Icon name="test" size={14} />}</span>
);

// What a suite is called in lists: its name, if the file gives one, else its file
export const suiteLabel = (suite) => (typeof suite?.data?.name === "string" && suite.data.name.trim() ? suite.data.name.trim() : suite?.file ?? "");

const short = (text, n = 48) => {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

// Open a folder (or, in a browser that can't, suite and provider files): the first step, wherever it's
// offered (the Suites section's note, the thread's)
export function OpenButton({ id, className, children }) {
  const input = useRef(null);
  const folders = isApp || !!window.showDirectoryPicker;
  return (
    <>
      <button className={className} id={id} type="button" onClick={() => (folders ? openFolder() : input.current.click())}>{children ?? (folders ? "Open a folder" : "Open files")}</button>
      {!folders && <input ref={input} type="file" multiple accept=".yml,.yaml,.json,.csv,.jsonl" hidden onChange={(e) => openFiles([...e.target.files])} />}
    </>
  );
}

// A new suite, named first (as Save as test's Suite name: its file's name, without .hafen.yml; none,
// the next free one), using the provider in use: + opens it at the top of Suites, Enter adds it, Esc
// closes it (spec/design/components.md, Additions: New suite form)
function NewSuiteForm({ onDone }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const typed = name.trim().replace(/\.hafen\.(ya?ml|json)$/i, "");
  const bad = typed !== "" && !SUITE_NAME.test(typed);
  const file = typed && !bad ? `${typed}.hafen.yml` : freeSuiteFile();
  const provider = providerInUse();
  const add = async (e) => {
    e.preventDefault();
    if (bad) return;
    setError("");
    try {
      await newSuite(typed);
      onDone();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <>
      <form className="controls new-suite-form" id="newSuiteForm" aria-label="New suite" onSubmit={add}>
        <input className="input grow" id="newSuiteName" ref={ref} type="text" aria-label="The new suite's name" placeholder={freeSuiteFile().replace(/\.hafen\.yml$/, "")}
               value={name} autoComplete="off" spellCheck={false}
               onChange={(e) => { setName(e.target.value); setError(""); }}
               onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onDone(); } }} />
        <button className="btn" id="newSuiteAdd" type="submit" disabled={bad}>add</button>
      </form>
      {bad || error
        ? <p className="hint error field-problem new-suite-hint" id="newSuiteProblem" role="alert">{bad ? "A suite's name is letters, digits, '.', '-' and '_' (and '/' for a folder)." : error}</p>
        : <p className="hint new-suite-hint" id="newSuiteNote">{`${file} · ${provider ? `provider ${provider.name}` : "no provider yet"}`}</p>}
    </>
  );
}

/* ---------- Suites ---------- */

export function SuitesSection() {
  const { suites, opened, selection, lives } = useStore(app);
  const now = useNow();
  const [query, setQuery] = useState("");
  const [naming, setNaming] = useState(false);  // the new suite form is open
  const words = searchWords(query);
  const [folded, setFolded] = useState(() => store.getJSON(KEYS.collapsed, {}));
  const fileInput = useRef(null);
  // Fold (or unfold) these rows, by their keys
  const setFold = (keys, fold) => {
    const next = { ...folded };
    for (const key of keys) {
      if (fold) next[key] = true;
      else delete next[key];
    }
    store.setJSON(KEYS.collapsed, next);
    setFolded(next);
  };
  const fold = (key) => setFold([key], !folded[key]);
  // (folded by what it is, a suite's file or a test's id, not where it is in the list: a suite added
  // above another doesn't take its folding)
  const toggle = (id, key, open) => (
    <button className="tree-toggle" id={`${id}-toggle`} type="button" aria-expanded={String(open)} aria-label={`${open ? "Collapse" : "Expand"}`} onClick={() => fold(key)}>
      <span className="chev" aria-hidden="true"></span>
    </button>
  );
  const leaf = <span className="tree-toggle" aria-hidden="true"></span>;
  const suiteKey = (suite) => `suite:${suite.file}`;
  const testKey = (suite, test) => `test:${suite.file}#${test.id ?? test.name}`;
  // Right-click on a suite or a test: expand or collapse it all (a suite, it and its tests; a test, its
  // suite's tests)
  const treeMenu = (suite, which) => (e) => {
    const tests = (suite.data?.tests ?? []).filter((t) => (t.turns ?? []).length);
    const keys = [...(which === "suite" ? [suiteKey(suite)] : []), ...tests.map((t) => testKey(suite, t))];
    openMenu(e, {
      label: `${which === "suite" ? suiteLabel(suite) : "Its suite's tests"}: expand or collapse`,
      items: [
        { id: "expand-all", label: "Expand all", onPick: () => setFold(which === "suite" ? keys : [suiteKey(suite), ...keys], false) },
        { id: "collapse-all", label: "Collapse all", onPick: () => setFold(keys, true) },
      ],
    });
  };
  // The latest run of a test (or of any of a suite's tests): when it started, for "2 mins ago"
  const lastRunAt = (suite, indices) => Math.max(0, ...indices.map((i) => runForTest(suite.file, i)?.started ?? 0)) || null;

  const rows = [];
  suites.forEach((suite, n) => {
    const id = `suite-${n}`;
    const key = suiteKey(suite);
    const allTests = suite.data?.tests ?? [];
    const results = allTests.map((t, i) => testResult(runForTest(suite.file, i), suite.file, t));
    // A search: a suite whose name or file matches shows whole; else only its tests that match (by
    // name, tags, how each last went, failed or stopped, or when it last ran), opened so they're seen;
    // else it's left out
    const suiteHit = matches(words, { texts: [suiteLabel(suite), suite.file, suite.name] }, now);
    const testHits = words.length && !suiteHit
      ? allTests.map((t, i) => matches(words, { texts: [t.name, ...(t.tags ?? []), results[i] ? testStatusText(results[i]).text : "not run"], times: [runForTest(suite.file, i)?.started] }, now))
      : allTests.map(() => true);
    if (!suiteHit && !testHits.some(Boolean)) return;
    const open = !folded[key] || (words.length > 0 && !suiteHit);
    const tests = allTests;
    // (what stops a run of it, as the run itself checks: a check type that isn't one, say)
    const problems = problemsOf(suite.file).length;
    const failed = results.filter((r) => r && (r.status === "failed" || r.status === "error")).length;
    const label = suiteLabel(suite);
    const last = lastRunAt(suite, tests.map((_, i) => i));
    rows.push(
      <ListRow key={id} id={id} label={label} title={[label !== suite.file ? `${label} · ${suite.file}` : suite.file, last ? `last run ${ago(last, now)}` : "not run yet"].join(" · ")}
               active={selection.kind === "suite" && selection.file === suite.file}
               size={problems ? `${problems} problem${problems === 1 ? "" : "s"}` : `${tests.length} test${tests.length === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}`}
               data={{ status: problems ? "error" : failed ? "failed" : "", file: suite.file }}
               extra={suite.data?.group !== undefined ? <GroupBadge group={suite.data.group} of="suite" id={`${id}-group`} /> : undefined}
               before={tests.length ? toggle(id, key, open) : leaf}
               onOpen={() => select({ kind: "suite", file: suite.file })}
               onContextMenu={treeMenu(suite, "suite")}
               actions={<>
                 <button className="btn btn-ghost btn-icon list-add" id={`${id}-run`} type="button" aria-label={`Run ${label}`} title="Run the suite"
                         disabled={lives.some((l) => l.scope.file === suite.file)} onClick={() => { select({ kind: "suite", file: suite.file }); runTests(suite.file).catch(() => {}); }}><Icon name="run" size={14} /></button>
                 <button className="btn btn-ghost btn-icon list-add" id={`${id}-add`} type="button" aria-label={`New test in ${label}`} title="New test"
                         onClick={() => newTest(suite.file).catch(() => {})}><Icon name="plus" size={14} /></button>
               </>}
               onDelete={() => deleteFile(suite.file).catch(() => {})}
               deleteLabel="Delete suite file" deleteQuestion="delete file?" />,
    );
    if (!open) return;
    tests.forEach((test, t) => {
      if (!testHits[t]) return;
      const tid = `test-${test.id ?? `${n}-${t}`}`;
      const tkey = testKey(suite, test);
      const topen = !folded[tkey];
      const run = runForTest(suite.file, t);
      const result = results[t];
      const isLive = lives.some((l) => l.scope.file === suite.file && (l.scope.test === undefined || l.scope.id === (test.id ?? test.name))) && (!result || result.status === "running");
      const { text, status } = testStatusText(result, { live: isLive });
      const busy = lives.some((l) => l.scope.file === suite.file && (l.scope.test === undefined || l.scope.id === (test.id ?? test.name)));
      const times = repeatOf(suite, test);
      const name = test.name ?? `test ${t + 1}`;
      rows.push(
        <ListRow key={tid} id={tid} label={name} title={[name, times > 1 ? `runs ${times} times` : "", run?.started ? `last run ${ago(run.started, now)}` : "not run yet"].filter(Boolean).join(" · ")}
                 active={["test"].includes(selection.kind) && selection.file === suite.file && selection.test === t}
                 size={text} data={{ status }} style={{ paddingLeft: "14px" }} before={(test.turns ?? []).length ? toggle(tid, tkey, topen) : leaf}
                 extra={test.group !== undefined || times > 1 ? <><GroupBadge group={test.group} id={`${tid}-group`} /><RepeatBadge times={times} id={`${tid}-repeat`} /></> : undefined}
                 onOpen={() => select({ kind: "test", file: suite.file, test: t })}
                 onContextMenu={treeMenu(suite, "test")}
                 actions={
                   <button className="btn btn-ghost btn-icon list-add" id={`${tid}-run`} type="button" aria-label={`Run ${name}`} title="Run the test"
                           disabled={busy} onClick={() => { select({ kind: "test", file: suite.file, test: t }); runTests(suite.file, t).catch(() => {}); }}><Icon name="run" size={14} /></button>
                 }
                 onDelete={() => deleteTest(suite.file, t).catch(() => {})}
                 deleteLabel="Delete test" />,
      );
      if (!topen) return;
      const paired = pairTurns(turnsOf(run, suite.file, test), test.turns ?? []);
      (test.turns ?? []).forEach((turn, i) => {
        const record = paired[i]?.record;
        const status = turnStatus(record, turn.expect ?? []);
        const text = short(typeof turn.user === "string" ? turn.user : JSON.stringify(turn.user ?? ""));
        rows.push(
          <ListRow key={`${tid}-${i}`} id={`turn-${test.id ?? `${n}-${t}`}-${i}`} label={text} ariaLabel={`turn ${i + 1}: ${text}`} title={`turn ${i + 1} · ${text}`}
                   active={["turn", "check"].includes(selection.kind) && selection.file === suite.file && selection.test === t && selection.turn === i}
                   size={turnChecksText(record, turn.expect ?? [])} data={{ status }} style={{ paddingLeft: "28px" }} before={leaf} icon={<TurnIcon status={status} />}
                   onOpen={() => select({ kind: "turn", file: suite.file, test: t, turn: i })}
                   onDelete={() => deleteTurn(suite.file, t, i).catch(() => {})}
                   deleteLabel="Delete turn" />,
        );
      });
    });
  });

  return (
    <NavSection id="suitesSection" name="suites" label="Suites" bodyId="suitesBody" defaultOpen icon={<Icon name="suite" size={14} />} actions={(sectionOpen) => (
      <>
        <button id="newSuite" className="btn btn-ghost btn-icon" type="button" aria-label="New suite" aria-expanded={naming} aria-controls="newSuiteForm" title="New suite" disabled={!opened}
                onClick={() => setNaming(!naming)}>
          <Icon name="plus" />
        </button>
        {/* (opening a folder or files: only while the section's open) */}
        {sectionOpen && (isApp || window.showDirectoryPicker
          ? <button className="btn btn-ghost btn-icon" id="openFolder" type="button" aria-label="Open a folder" title="Open a folder" onClick={openFolder}><Icon name="import" /></button>
          : <button className="btn btn-ghost btn-icon" id="openFile" type="button" aria-label="Open files" title="Open files" onClick={() => fileInput.current.click()}><Icon name="import" /></button>)}
        <input ref={fileInput} type="file" multiple accept=".yml,.yaml,.json,.csv,.jsonl" hidden onChange={(e) => openFiles([...e.target.files])} />
      </>
    )}>
      {naming && opened && <NewSuiteForm onDone={() => { setNaming(false); document.getElementById("newSuite")?.focus(); }} />}
      {suites.length > 0 && <SearchField id="suitesSearch" label="Search suites and tests" value={query} onChange={setQuery} placeholder="Search by name, status or last run" />}
      <p className="note placeholder" id="suitesEmpty" hidden={suites.length > 0 || naming}>
        {opened
          ? "No suites here yet: press + to start one, or add files named *.hafen.yml."
          : isApp || window.showDirectoryPicker
            ? <><OpenButton id="suitesOpenFolder" className="btn btn-ghost inline-link" />{" with your suites (*.hafen.yml) to start."}</>
            : <><OpenButton id="suitesOpenFolder" className="btn btn-ghost inline-link" />{": your suite and provider files, to start."}</>}
      </p>
      {suites.length > 0 && words.length > 0 && !rows.length && <p className="note placeholder" id="suitesNoMatch">{`No suite or test matches “${query.trim()}”.`}</p>}
      <List id="suiteList" aria-label="Suites, tests and turns">{rows}</List>
    </NavSection>
  );
}

/* ---------- Conversations ---------- */

// Every conversation sent from here is kept (after each message), newest first: open one to see it
// and carry it on, delete it, or start a new one
export function ConversationsSection() {
  const { conversations, conversation, providers, selection } = useStore(app);
  const now = useNow();
  const [query, setQuery] = useState("");
  const words = searchWords(query);
  const nameOf = (file) => providers.find((p) => p.file === file)?.name ?? (file ? file.split("/").pop().replace(/\.(ya?ml|json)$/i, "") : "no provider");
  // A search: by its name, its provider, and when it was last carried on (or started)
  const shown = conversations.filter((c) => matches(words, { texts: [c.title, nameOf(c.provider)], times: [c.updated, c.started] }, now));
  const start = () => {
    resetConversation();
    if (!app.get().conversation && providers.length) chooseProvider(providers[0].file);
    select({ kind: "conversation" });
    setTimeout(() => document.getElementById("input")?.focus(), 0);
  };
  return (
    <NavSection id="conversationsSection" name="conversations" label="Conversations" bodyId="conversationsBody" defaultOpen icon={<Icon name="chat" size={14} />} actions={
      <button id="newConversation" className="btn btn-ghost btn-icon" type="button" aria-label="New conversation" title="New conversation" onClick={start}><Icon name="plus" /></button>
    }>
      {conversations.length > 0 && <SearchField id="conversationsSearch" label="Search conversations" value={query} onChange={setQuery} />}
      <p className="note placeholder" id="conversationsEmpty" hidden={conversations.length > 0}>No conversations yet. Send a message to start one: each is kept here.</p>
      {words.length > 0 && conversations.length > 0 && !shown.length && <p className="note placeholder" id="conversationsNoMatch">{`No conversation matches “${query.trim()}”.`}</p>}
      <List id="conversationList" aria-label="Conversations">
        {shown.map((c) => (
          <ListRow key={c._id} id={`conversation-${c._id}`} label={c.title} detail={`${nameOf(c.provider)} · ${whenFull(c.updated)} · ${c.turns} turn${c.turns === 1 ? "" : "s"}`}
                   title={c.title} active={conversation?.id === c._id && selection.kind !== "suite" && !["test", "turn", "check", "run"].includes(selection.kind)}
                   onOpen={() => openConversation(c._id)} onDelete={() => deleteConversation(c._id)} deleteLabel="Delete conversation" deleteQuestion="delete?" />
        ))}
      </List>
    </NavSection>
  );
}

/* ---------- Runs ---------- */

export function RunsSection() {
  const { runs, selection, lives, suites } = useStore(app);
  const now = useNow();
  const input = useRef(null);
  const status = (r) => (r.status === "done" ? r.verdict : r.status);
  return (
    <NavSection id="runsSection" name="runs" label="Runs" bodyId="runsBody" defaultOpen icon={<Icon name="runs" size={14} />} actions={
      <>
        <button className="btn btn-ghost when-open" id="openRun" type="button" onClick={() => input.current.click()}>open</button>
        <input ref={input} type="file" accept=".json" hidden onChange={async (e) => {
          const f = e.target.files[0];
          e.target.value = "";
          if (!f) return;
          try {
            await importRun(await f.text());
          } catch (err) {
            notify({ title: "Couldn't open the run", text: err.message, kind: "error" });
          }
        }} />
        <ConfirmButton id="clearRuns" className="btn btn-ghost when-open" hidden={!runs.length} label="clear all" question="delete every run?" onConfirm={clearRuns} />
      </>
    }>
      <p className="note placeholder" id="runsEmpty" hidden={runs.length > 0 || lives.length > 0}>No runs yet. Each run is recorded here.</p>
      <List id="runList" aria-label="Runs">
        {lives.map((live) => (
          <ListRow key={live.token} id={`run-live-${live.token}`} label={live.scope.id !== undefined ? live.run.tests?.find((t) => (t.id ?? t.name) === live.scope.id)?.name ?? live.scope.id : suites.find((s) => s.file === live.scope.file)?.name ?? live.scope.file}
                   detail={`${ago(live.run.started ?? Date.now(), now)} · running…`} size="running…" data={{ status: "running" }}
                   onOpen={() => {
                     const index = (suites.find((s) => s.file === live.scope.file)?.data?.tests ?? []).findIndex((t) => (t.id ?? t.name) === live.scope.id);
                     select(live.scope.id !== undefined && index > -1 ? { kind: "test", file: live.scope.file, test: index } : { kind: "suite", file: live.scope.file });
                   }}
                   onDelete={() => stopRun(live.token)} deleteLabel="Stop the run" deleteQuestion="stop?" />
        ))}
        {runs.map((r) => (
          <ListRow key={r._id} id={`run-${r._id}`} label={`${r.name}${r.repeat > 1 ? ` ×${r.repeat}` : ""}${r.mode !== "test" ? ` · ${r.mode}` : ""}`} detail={`${ago(r.started, now)} · ${sec(r.ms)}`}
                   title={`${r.name} · ${status(r)} · ${when(r.started)} · _id ${r._id}`} active={selection.kind === "run" && selection.run === r._id}
                   size={status(r)} data={{ status: status(r) }} onOpen={() => openRun(r._id)} onDelete={() => deleteRun(r._id)} deleteLabel="Delete run" />
        ))}
      </List>
    </NavSection>
  );
}

/* ---------- Checks ---------- */

// A check added to a turn (from the palette); then it's selected
export async function addCheck(check, target) {
  const { file, test, turn } = target;
  const t = app.get().suites.find((s) => s.file === file)?.data?.tests?.[test]?.turns?.[turn];
  const path = ["tests", test, "turns", turn, "expect"];
  const existing = t?.expect ?? [];
  try {
    await editSuite(file, [existing.length ? { op: "add", path, value: check } : { op: "set", path, value: [check] }]);
  } catch {
    return;  // (editSuite has said why)
  }
  select({ kind: "check", file, test, turn, check: existing.length });
}

export function ChecksSection() {
  const { selection } = useStore(app);
  const target = ["turn", "check"].includes(selection.kind) && selection.file !== undefined && !selection.explore ? selection : null;
  return (
    <NavSection id="checksSection" name="checks" label="Checks" bodyId="checksBody" icon={<Icon name="check" size={14} />}>
      <p className="note" id="checksHelp">{target ? `Click a check to add it to turn ${target.turn + 1}.` : "Select a turn, then click a check to add it."}</p>
      {CHECK_GROUPS.map((group) => (
        <div key={group.id} className="palette-group" id={`palette-group-${group.id}`} role="group" aria-labelledby={`palette-group-${group.id}-label`}>
          <p className="palette-heading" id={`palette-group-${group.id}-label`}>{group.label}</p>
          <div className="palette" role="list" aria-label={`${group.label} checks to add`}>
            {CHECK_TYPES.filter((k) => k.group === group.id).map((k) => (
              <div key={k.id} className="palette-item" role="listitem" tabIndex={0} id={`palette-${k.id}`} aria-label={`${k.name} check`}
                   aria-disabled={!target || undefined} title={target ? "Click to add it to the selected turn" : "Select a turn first"}
                   onClick={() => target && addCheck(k.check, target)}
                   onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && target) { e.preventDefault(); addCheck(k.check, target); } }}>
                <span className="block-label"><Icon name="check" size={16} /><span className="label">{k.short ?? k.name}</span></span>
                <span className="palette-text">{k.text}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </NavSection>
  );
}
