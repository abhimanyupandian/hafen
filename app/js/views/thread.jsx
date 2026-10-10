// The conversation in the centre (contracts/ui.md, Thread): explore (what's been sent), test (a test's
// turns, with the latest run's replies and results) or run (a run, read-only). Each turn is the design
// system's messages: yours, then the reply with its thinking, tool calls, text, stats and check badges.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckBadge } from "../design/check-badge.jsx";
import { GroupBadge, RepeatBadge } from "../design/badges.jsx";
import { useNow, useStore } from "../design/hooks.js";
import { copyText } from "../lib/clipboard.js";
import { ago, sec } from "../lib/format.js";
import { renderMarkdown } from "../lib/markdown.js";
import { ConfirmButton } from "../design/confirm.jsx";
import { openMenu } from "../design/context-menu.jsx";
import { Icon } from "../design/icons.jsx";
import { expandSidebar } from "../design/sidebar.jsx";
import { openDrawer } from "../lib/dom.js";
import { emit, on } from "../lib/events.js";
import { RUN_KEY } from "../lib/keys.js";
import { app, deleteConversationTurn, deleteTurn, liveForSuite, liveForTest, runForTest, runTests, select, stopRun, suiteOf, suiteRunFor, testOf, threadMode } from "../state.js";
import { isOn } from "./check-types.js";
import { checksText, countedResult, describeCheck, instancesOf, pairResults, pairTurns, pickedInstance, refusedRun, repeatOf, rowLabel, runOutcome, spanFor, statsLine, stoppedTurn, testResult, testStatusText, turnChecksText, turnStatus, turnsOf, visibilityText } from "./derive.js";
import { startConversation, TurnIcon } from "./sections.jsx";
import { showProvider } from "./providers.jsx";

// A new suite, from the thread's first steps: the Suites section's form, named first (the sidebar
// shown, and the section opened, so it's seen)
function startSuite() {
  expandSidebar();
  if (matchMedia("(max-width: 860px)").matches) openDrawer();
  const toggle = document.getElementById("suitesToggle");
  if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
  emit("suites:new");
}

function Thinking({ thinking, record, onSelect }) {
  if (!thinking?.length) return null;
  const visible = thinking.map((t) => t.visibility).filter((v, i, a) => a.indexOf(v) === i).map(visibilityText).join(", ");
  const text = thinking.map((t) => t.text).join("\n\n");
  const ms = record?.metrics?.thinking_ms;
  return (
    <details className="msg-sent msg-thinking" onToggle={(e) => e.target.open && onSelect?.()}>
      <summary>{["thinking", visible, ms !== undefined && sec(ms)].filter(Boolean).join(" · ")}</summary>
      {text.trim() ? <pre>{text}</pre> : <span className="hint">The provider didn't return the thinking ({visible}).</span>}
    </details>
  );
}

// A test's turn's menu (right-click): run only it (the turns before it carried from the last run),
// run up to it, run the test, or delete it; while its test runs, stop it
function turnMenu({ file, testIndex, i, going }) {
  if (going) return [{ id: "turn-stop", label: "Stop the run", hint: "Esc", onPick: () => stopRun(going.token) }];
  return [
    { id: "turn-only", label: "Run this turn only", hint: i ? "the turns before it from the last run" : "", onPick: () => runTests(file, testIndex, { onlyTurn: i }).catch(() => {}) },
    { id: "turn-upto", label: "Run up to this turn", hint: i ? `turns 1–${i + 1}` : "", onPick: () => runTests(file, testIndex, { untilTurn: i }).catch(() => {}) },
    { id: "turn-test", label: "Run the test", hint: RUN_KEY, onPick: () => runTests(file, testIndex).catch(() => {}) },
    "-",
    { id: "turn-delete", label: "Delete this turn", hint: "from the file", danger: true, confirm: "Click again to delete it", onPick: () => deleteTurn(file, testIndex, i).catch(() => {}) },
  ];
}

// Copy the reply as it came (raw: its Markdown, not what it looks like)
function CopyReply({ id, text }) {
  const [said, setSaid] = useState("");
  return (
    <button type="button" className="btn btn-ghost msg-copy" id={id} title="Copy the reply as it came (raw)" aria-label="Copy the reply"
            onClick={async () => { setSaid((await copyText(text)) ? "copied" : "couldn't copy"); setTimeout(() => setSaid(""), 1500); }}>
      {said || <><Icon name="copy" size={12} /><span>copy</span></>}
    </button>
  );
}

// A click anywhere in a group selects it, but not one on its own controls (a button, a link, a
// thinking's summary) or one that ends selecting text
function pick(e, select) {
  if (e.defaultPrevented || e.target.closest?.("button, a, input, textarea, select, summary, label")) return;
  if (window.getSelection?.().toString()) return;
  select?.();
}

// A turn that failed: the error, in the danger colour, and what came back folded under it (the
// body). One cut short after some of its text came (a stream cut off) shows that text as a reply's,
// ending …, with the error under it: `cut short: network error`. One stopped on purpose isn't an
// error: what came, ending …, then `stopped`, in the muted colour.
function ErrorReply({ record, reply, index }) {
  const body = record.response?.body;
  const raw = body === undefined || body === null || body === "" ? "" : typeof body === "string" ? body : JSON.stringify(body, null, 2);
  if (stoppedTurn(record)) {
    return reply
      ? <>
          <div className="msg-body md cut" id={`turn-${index}-partial`} dangerouslySetInnerHTML={{ __html: renderMarkdown(reply) }} />
          <div className="msg-body hint msg-cut" id={`turn-${index}-cut`}>stopped</div>
        </>
      : <div className="msg-body hint" id={`turn-${index}-cut`}>Stopped before any reply came.</div>;
  }
  if (reply) {
    return (
      <>
        <div className="msg-body md cut" id={`turn-${index}-partial`} dangerouslySetInnerHTML={{ __html: renderMarkdown(reply) }} />
        <div className="msg-body error msg-cut" id={`turn-${index}-cut`}>{`cut short: ${record.error}`}</div>
        {raw && raw !== reply && <details className="msg-sent msg-response"><summary>show the response</summary><pre>{raw}</pre></details>}
      </>
    );
  }
  return (
    <>
      <div className="msg-body error">{record.error}</div>
      {raw && <details className="msg-sent msg-response"><summary>show the response</summary><pre>{raw}</pre></details>}
    </>
  );
}

// A run that broke off before it reached its tests (spec/design/components.md, Additions: Run error):
// where their turns would be, what stopped it, in the danger colour. One refused before sending
// anything says `couldn't run` and each problem its check found (where it is: a provider's file, say);
// one that broke off (a provider's fixture, the suite's setup) says `error` and why.
function RunError({ run, now }) {
  const said = runOutcome(run);
  const refused = refusedRun(run);
  const problems = refused ? run.error.all : [run.error?.message ? run.error : { message: said.why ?? "the run broke off" }];
  return (
    <section className="run-error" id="runError" aria-label={`The run: ${said.text}`} data-status="error">
      <div className="turn-head">
        <span className="label">Run</span>
        <span className="hint turn-summary" id="runErrorStatus" data-status="error">{[said.text, refused ? "nothing was sent" : sec(run.ms), run.started && ago(run.started, now)].filter(Boolean).join(" · ")}</span>
      </div>
      {problems.map((p, i) => <div key={i} className="msg-body error" id={`runError-${i}`}>{`${p.file && p.line ? `${p.file}:${p.line}: ` : ""}${p.message}`}</div>)}
    </section>
  );
}

// A turn's status and summary for its head: from the record, and the badges (its checks' results; one
// turned off isn't counted). checked: the turn is a test's (or a run's), so it has checks to count: one
// with none says "0 checks", in the unsure colour (a conversation's turns have none to have)
function turnSummary(record, all, checked) {
  const badges = all.filter((b) => b.status !== "off");
  const none = checked && !badges.length;
  if (!record) return { status: none ? "unchecked" : "", text: badges.length ? `not run yet · ${badges.length} check${badges.length === 1 ? "" : "s"}` : none ? "not run yet · 0 checks" : "not run yet" };
  if (record.live) return { status: "running", text: "running…" };
  if (record.carried) return { status: "", text: record.carried === "fixed reply" ? "carried · its fixed reply" : "carried · from the last run" };
  const ms = record.metrics?.ms !== undefined ? sec(record.metrics.ms) : "";
  if (record.skipped) return { status: "skipped", text: "skipped" };
  // (stopped on purpose: not an error, and not coloured as one)
  if (stoppedTurn(record)) return { status: "stopped", text: ["stopped", ms].filter(Boolean).join(" · ") };
  if (record.error) return { status: "error", text: ["error", ms].filter(Boolean).join(" · ") };
  if (none) return { status: "unchecked", text: ["0 checks", ms].filter(Boolean).join(" · ") };
  const ran = badges.filter((b) => b.status);
  const status = ran.some((b) => b.status === "fail" || b.status === "error") ? "failed" : ran.some((b) => b.status === "unsure") ? "unsure" : ran.length ? "passed" : "";
  const checks = badges.length ? `${ran.filter((b) => b.status === "pass").length}/${badges.length} checks` : "";
  return { status, text: [checks, ms].filter(Boolean).join(" · ") || "done" };
}

// A turn: a group with its head (its number, how it went, ▷ to run the test up to it, × to delete it),
// your message, and the reply (with its stats and "copy" under it). badges: one per check shown under
// the reply: { status, name, reason, confidence } (status "off": turned off)
function Turn({ index, label, user, record, badges, checked = false, selectedTurn, selection, onSelectTurn, onSelectCheck, onSelectStep, onRunTo, onDelete, menu, running, run }) {
  const summary = turnSummary(record, badges, checked);
  const live = record?.live;
  const thinking = record?.thinking ?? [];
  const toolCalls = record?.tool_calls ?? [];
  const reply = record?.reply ?? "";
  const failedTurn = record?.error && !live;
  return (
    <section className={`turn-group${selectedTurn ? " selected" : ""}`} id={`turn-${index}`} aria-label={label} data-status={summary.status} onClick={(e) => pick(e, onSelectTurn)}
             onContextMenu={menu ? (e) => openMenu(e, { label: `${label}: what to do`, items: menu }) : undefined}>
      <div className="turn-head">
        <span className="label">{label}</span>
        <span className="hint turn-summary" data-status={summary.status}>{summary.text}</span>
        <span className="turn-actions">
          {onRunTo && (
            <button type="button" className={`btn btn-ghost btn-icon turn-run${running ? " stop" : ""}`} id={`turn-${index}-run`} aria-haspopup="menu"
                    onKeyDown={(e) => { if (menu && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) openMenu(e, { label: `${label}: what to do`, items: menu }); }}
                    onContextMenu={menu ? (e) => openMenu(e, { label: `${label}: what to do`, items: menu }) : undefined}
                    aria-label={running ? "Stop the run" : `Run the test up to ${label}`} title={running ? "Stop (Esc)" : `Run the test up to this turn (${RUN_KEY} with it selected)`}
                    onClick={() => (running ? stopRun(liveForTest(selection.file, selection.test)?.token ?? null) : onRunTo())}>
              <Icon name={running ? "stop" : "run"} size={14} />
            </button>
          )}
          {onDelete && (
            <ConfirmButton className="btn btn-ghost turn-del" id={`turn-${index}-delete`} aria-label={`Delete ${label}`} title="Delete this turn"
                           label="×" question="delete" onConfirm={onDelete} />
          )}
        </span>
      </div>
      <article className="msg user" id={`turn-${index}-user`} aria-label={`User, ${label}`}>
        <div className="msg-body">{user}</div>
      </article>
      {(record || badges.length > 0) && (
        <article className="msg bot" id={`turn-${index}-reply`} aria-label={`Reply, ${label}`}>
          <Thinking thinking={thinking} record={record} onSelect={() => onSelectStep(spanFor(run, { turn: record?.globalIndex, event: (record?.events ?? []).findIndex((e) => e.type === "thinking") }))} />
          {toolCalls.map((c, i) => (
            <button key={c.id ?? i} type="button" className="hint msg-tool" id={`turn-${index}-tool-${i}`} onClick={() => onSelectStep(spanFor(run, { turn: record?.globalIndex, event: (record?.events ?? []).findIndex((e) => e.type === "tool_call" && e.id === c.id) }))}>
              {`↳ ${c.name}${c.args !== undefined ? ` ${JSON.stringify(c.args)}` : ""}${"result" in c ? " · answered" : ""}`}
            </button>
          ))}
          {record
            ? failedTurn
              ? <ErrorReply record={record} reply={reply} index={index} />
              : record.skipped
                ? <div className="msg-body hint">{`Skipped: ${record.skipped}`}</div>
                : <div className={`msg-body md${live ? " streaming" : ""}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(reply) }} />
            : <div className="msg-body hint">Not run yet.</div>}
          {record && !live && (statsLine(record) || reply) && (
            <div className="msg-foot">
              {statsLine(record) && <span className="msg-stats">{statsLine(record)}</span>}
              {reply && <CopyReply id={`turn-${index}-copy`} text={reply} />}
            </div>
          )}
          {badges.length > 0 && (
            <div className="msg-checks">
              {badges.map((r, i) => (
                <CheckBadge key={i} id={`check-${index}-${i}`} status={r.status} name={r.name} reason={r.reason} confidence={r.confidence}
                            selected={selection.kind === "check" && selection.turn === index && selection.check === i}
                            onClick={(e) => { e.stopPropagation(); onSelectCheck(i); }} />
              ))}
            </div>
          )}
        </article>
      )}
    </section>
  );
}

export function Thread() {
  const state = useStore(app);
  const { selection, conversation, providers, openRun, suites, lives } = state;
  const mode = threadMode();
  const now = useNow();
  const scroller = useRef(null);
  const atBottom = useRef(true);
  let content = null;
  let run = null;

  if (mode === "explore") {
    run = conversation?.run;
    const turns = run?.turns ?? [];
    if (!turns.length) {
      // (the first steps as buttons, not only words: a provider, a conversation, a suite; the next one
      // to take, adding a provider while there's none, the primary)
      content = (
        <div className="empty" id="threadEmpty">
          <p>{providers.length ? "Choose a provider, then send a message. Save the conversation as a test when it's worth keeping." : "Add a provider (an endpoint to talk to) to start: then talk to it, and save what's worth keeping as a test."}</p>
          <div className="empty-actions">
            <button className={`btn${providers.length ? "" : " btn-primary"}`} id="threadAddProvider" type="button" onClick={() => showProvider("new")}>Add a provider</button>
            <button className="btn" id="threadNewConversation" type="button" onClick={startConversation}>New conversation</button>
            <button className="btn" id="threadNewSuite" type="button" onClick={startSuite}>New suite</button>
          </div>
        </div>
      );
    } else {
      content = turns.map((record, i) => record && (
        <Turn key={i} index={i} label={`turn ${i + 1}`} user={record.user} record={{ ...record, globalIndex: i }} badges={[]}
              selection={selection} selectedTurn={["turn", "step"].includes(selection.kind) && selection.explore && selection.turn === i} run={run}
              onSelectTurn={() => select({ kind: "turn", explore: true, turn: i }, { route: false })}
              onSelectCheck={() => {}} onSelectStep={(span) => span && select({ kind: "step", span: span._id, explore: true, in: "explore", turn: i }, { route: false })}
              onDelete={conversation?.sending ? null : () => deleteConversationTurn(i)}
              menu={conversation?.sending ? null : [{ id: "turn-delete", label: "Delete this turn", hint: "from the conversation", danger: true, confirm: "Click again to delete it", onPick: () => deleteConversationTurn(i) }]} />
      ));
    }
  } else if (mode === "suite") {
    // A suite: each test a group (its name, how it last went, ▷), with its turns under it
    const file = selection.file;
    const suite = suiteOf(file);
    const tests = suite?.data?.tests ?? [];
    content = tests.length ? tests.map((t, ti) => {
      const r = runForTest(file, ti);
      const going = lives.find((l) => l.scope.file === file && (l.scope.test === undefined || l.scope.id === (t.id ?? t.name)));
      const live = !!going && (!r || r === going.run);
      const { text, status, why } = testStatusText(testResult(r, file, t), { live });
      const paired = pairTurns(turnsOf(r, file, t), t.turns ?? []);
      return (
        <section key={t.id ?? `${ti}-${t.name}`} className="turn-group suite-test" id={`suiteTest-${ti}`} aria-label={t.name} data-status={status}
                 onClick={(e) => pick(e, () => select({ kind: "test", file, test: ti }))}>
          <div className="turn-head">
            <button type="button" className="suite-test-name" id={`suiteTest-${ti}-open`} onClick={() => select({ kind: "test", file, test: ti })}>{t.name}</button>
            <GroupBadge group={t.group} id={`suiteTest-${ti}-group`} />
            <RepeatBadge times={repeatOf(suite, t)} id={`suiteTest-${ti}-repeat`} />
            <span className="hint turn-summary" data-status={status} title={why ? `${text}: ${why}` : undefined}>{text === "—" ? "not run yet" : `${text}${!live && r?.started ? ` · ${ago(r.started, now)}` : ""}`}</span>
            <span className="turn-actions">
              <button type="button" className="btn btn-ghost btn-icon turn-run" id={`suiteTest-${ti}-run`} aria-label={`Run ${t.name}`} title="Run this test"
                      disabled={!!going} onClick={() => runTests(file, ti).catch(() => {})}>
                <Icon name="run" size={14} />
              </button>
            </span>
          </div>
          {(t.turns ?? []).length > 0 ? (
            <ol className="suite-turns">
              {t.turns.map((turn, i) => {
                const record = paired[i]?.record;
                const checks = turn.expect ?? [];
                const tstatus = turnStatus(record, checks);
                const text = typeof turn.user === "string" ? turn.user : JSON.stringify(turn.user);
                return (
                  <li key={i}>
                    <button type="button" className="suite-turn" id={`suiteTest-${ti}-turn-${i}`} aria-label={`turn ${i + 1}: ${text}`} title={`turn ${i + 1}`} onClick={() => select({ kind: "turn", file, test: ti, turn: i })}>
                      <TurnIcon status={tstatus} />
                      <span className="suite-turn-text">{text}</span>
                      <span className="hint turn-summary" data-status={tstatus}>{turnChecksText(record, checks)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : <p className="hint placeholder">No turns yet.</p>}
        </section>
      );
    }) : <p className="empty" id="suiteEmpty">This suite has no tests yet: press + on it under Suites, or Add test in its panel.</p>;
    // Its last run broke off before its tests: why, above them
    const last = suiteRunFor(file);
    if (last?.status === "error" && !liveForSuite(file)) content = <><RunError run={last} now={now} />{content}</>;
  } else {
    // (A run: the test picked in its panel's list, `runTest`, else its first)
    const picked = mode === "run" ? openRun?.tests?.[selection.runTest ?? 0] : null;
    const file = mode === "run" ? selection.file ?? picked?.suite : selection.file;
    let testIndex = selection.test;
    if (mode === "run") {
      run = openRun;
      if (testIndex === undefined) testIndex = picked ? (suites.find((s) => s.file === picked.suite)?.data?.tests ?? []).findIndex((t) => (t.id ?? t.name) === (picked.id ?? picked.name)) : -1;
    } else run = runForTest(file, testIndex);
    const runTest = mode === "run" ? selection.runTest : undefined;
    const test = testOf(file, testIndex) ?? (mode === "run" ? runTestDefinition(openRun, selection) : null);
    const instances = instancesOf(run, file, test);
    // (none picked: the latest, the one going on while it runs)
    const instance = pickedInstance(instances, selection);
    const recorded = turnsOf(run, file, test, instance);
    const defined = test?.turns ?? [];
    // A test: its turns as the file has them, each with the run's record of it (if it ran as it is
    // now). A run: what it recorded, as it recorded it.
    const items = mode === "run"
      ? recorded.map((rec) => ({ rec, user: rec.record.user, badges: (rec.record.results ?? []).map((r) => ({ ...countedResult(r), name: r.name ?? describeCheck(r.check ?? {}) })) }))
      : pairTurns(recorded, defined).map((rec, i) => {
        const checks = defined[i]?.expect ?? [];
        const paired = rec ? pairResults(rec.record.results, checks) : [];
        return {
          rec,
          user: typeof defined[i]?.user === "string" ? defined[i].user : JSON.stringify(defined[i]?.user ?? ""),
          resolvedUser: rec?.record.user,
          badges: checks.map((c, j) => (!isOn(c) ? { status: "off", name: describeCheck(c), reason: "turned off" }
            : paired[j] ? { ...countedResult(paired[j]), name: paired[j].name ?? describeCheck(c) } : { status: "", name: describeCheck(c) })),
        };
      });
    // A run that broke off before the test (refused before sending anything, a provider's fixture or the
    // suite's setup that failed): why, where its turns would be; a test's turns under it as the file has
    // them, none run by it
    const broke = run?.status === "error" && (mode === "run" || testResult(run, file, test)?.unreached) ? <RunError run={run} now={now} /> : null;
    if (!test && !recorded.length) content = broke ?? <p className="empty">This test isn't in your suites.</p>;
    else if (!items.length) content = broke && mode === "run" ? broke : <>{broke}<p className="empty">This test has no turns yet. Type a message below to add one.</p></>;
    else {
      content = items.map(({ rec, user, resolvedUser, badges }, i) => {
        const record = rec ? { ...rec.record, globalIndex: rec.globalIndex } : null;
        return (
          <Turn key={i} index={i} label={`turn ${i + 1}${instance?.row ? ` · ${rowLabel(instance.row, instance.row_name)}` : ""}${instance && instances.length > 1 && !instance.row ? ` · run ${instance.repeat} of ${Math.max(instances.length, repeatOf(suiteOf(file), test))}` : ""}`}
                user={resolvedUser ?? user}
                record={record} badges={badges} checked run={run} selection={selection}
                selectedTurn={["turn", "check", "step"].includes(selection.kind) && selection.turn === i}
                onSelectTurn={() => select({ kind: "turn", file, test: testIndex, turn: i, repeat: instance?.repeat, row: instance?.row, in: mode, run: mode === "run" ? run?._id : undefined, runTest })}
                onSelectCheck={(c) => select({ kind: "check", file, test: testIndex, turn: i, check: c, repeat: instance?.repeat, row: instance?.row, in: mode, run: mode === "run" ? run?._id : undefined, runTest })}
                onSelectStep={(span) => span && select({ kind: "step", span: span._id, file, test: testIndex, turn: i, run: run?._id, in: mode, runTest }, { route: false })}
                onRunTo={mode === "test" ? () => runTests(file, testIndex, { untilTurn: i }).catch(() => {}) : null}
                onDelete={mode === "test" ? () => deleteTurn(file, testIndex, i).catch(() => {}) : null}
                menu={mode === "test" ? turnMenu({ file, testIndex, i, going: liveForTest(file, testIndex) }) : null}
                running={mode === "test" && lives.some((l) => l.scope.file === file && l.scope.id === (test?.id ?? test?.name) && (l.scope.onlyTurn !== undefined ? l.scope.onlyTurn === i : (l.scope.untilTurn ?? Infinity) >= i))} />
        );
      });
      if (broke) content = <>{broke}{content}</>;
    }
  }

  // Following a run (the top bar's Follow): what's running now kept in view as the run goes on: the
  // turn (a test), or the test and its turn (a suite)
  const following = state.follow && (mode === "test" ? !!liveForTest(selection.file, selection.test) : mode === "suite" && !!liveForSuite(selection.file));
  // Follow new text while at the bottom (unless following a run); scroll a selected turn into view.
  // Sending a message (or adding a turn) goes to the bottom, wherever the thread was, and follows the
  // reply from there.
  useEffect(() => on("thread:bottom", () => {
    atBottom.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }), []);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current && !following) el.scrollTop = el.scrollHeight;
  });
  useLayoutEffect(() => {
    if (selection.turn === undefined) return;
    document.getElementById(`turn-${selection.turn}-user`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selection.turn, selection.kind]);
  useLayoutEffect(() => {
    if (!following) return;
    const running = [...(scroller.current?.querySelectorAll('[data-status="running"]') ?? [])].at(-1);
    running?.closest(".turn-group, .suite-turn")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  return (
    <div className="scroller" id="scroller" ref={scroller} onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      <div className="wrap thread" id="thread" role="log" aria-label="Conversation">{content}</div>
    </div>
  );
}

// A run's test that the app doesn't have (a CI run): the one picked in the run's list (or its
// first), whose turns the thread shows as the run recorded them
export function runTestDefinition(run, selection) {
  const t = run?.tests?.[selection?.runTest ?? 0] ?? run?.tests?.[0];
  return t ? { id: t.id, name: t.name, suite: t.suite, turns: [] } : null;
}

export { checksText };
