// The panel on the right (contracts/ui.md, Panel): one view for what's selected, in the design
// system's panel (a 52px head with an icon and a label, the body, the foot with ids and Delete).
// Edits go to the suite's file through the engine, which keeps its comments.

import { Fragment, useEffect, useRef, useState } from "react";
import { parse as parseYaml, stringify as yaml } from "yaml";
import { Chart } from "../design/chart.jsx";
import { ConfirmButton } from "../design/confirm.jsx";
import { Editor } from "../design/editor.jsx";
import { useNow, useStore } from "../design/hooks.js";
import { Icon } from "../design/icons.jsx";
import { IdField } from "../design/id-field.jsx";
import { JsonTree } from "../design/json-tree.jsx";
import { Select } from "../design/select.jsx";
import { notify } from "../design/toast.jsx";
import { copyText } from "../lib/clipboard.js";
import { ago, money, sec, tokens as tokenText, when } from "../lib/format.js";
import * as idb from "../lib/idb.js";
import {
  app, chooseProvider, compareRuns, deleteCheck, deleteConversation, deleteFile, deleteRun, deleteTest, deleteTurn, editSuite, freeSuiteFile, newTest, relativePath, renameSuite, exportRun, openRun, readFile, renameConversation, runForTest, runTests,
  liveForSuite, liveForTest, liveIn, runAgain, saveConversation, select, setCheckOn, stopRun, suiteOf, suiteRunFor, testOf, writeFile,
} from "../state.js";
import { CheckCard, CheckOnBox } from "./check-card.jsx";
import { runTestDefinition } from "./thread.jsx";
import { isOn, kindOf } from "./check-types.js";
import { Facts, FieldHead, NumberField, Pre, Problems, TextField } from "./fields.jsx";
import { showProvider } from "./providers.jsx";
import { instancesOf, pairResults, pairTurns, pickedInstance, spanFor, statsLine, testResult, testStatusText, turnsOf, visibilityText } from "./derive.js";

// The run a turn or check is shown from (the open run when picked in its thread, else the test's
// latest), its record of turn i, and each of the turn's checks' results as the file has them now
function turnRecordOf(selection, test, i) {
  const { file, test: t } = selection;
  const inRun = selection.in === "run";
  const run = inRun ? app.get().openRun : runForTest(file, t);
  const instance = pickedInstance(instancesOf(run, file, test), selection);
  const recorded = turnsOf(run, file, test, instance);
  const record = (inRun ? recorded.find(({ record: r }) => r.index === i) : pairTurns(recorded, test.turns ?? [])[i])?.record ?? null;
  const checks = test.turns?.[i]?.expect ?? [];
  return { run, record, results: record ? pairResults(record.results, checks) : checks.map(() => null) };
}

/* ---------- parts ---------- */

// onBack: what holds this (a check's or a step's turn, a turn's test, a test's suite)
const Head = ({ icon, label, onClose, onBack, backLabel }) => (
  <div className="panel-head">
    {onBack && (
      <button className="btn btn-ghost btn-icon panel-back" id="panelBack" type="button" aria-label={backLabel} title={backLabel} onClick={onBack}>
        <Icon name="back" size={16} />
      </button>
    )}
    <span className="block-label"><Icon name={icon} size={16} /><span className="label">{label}</span></span>
    <button className="btn btn-ghost btn-icon" id="panelClose" type="button" aria-label={`Close ${label.toLowerCase()}`} title="Close" onClick={onClose}>
      <Icon name="close" size={16} />
    </button>
  </div>
);

const stem = (file) => file.split("/").pop().replace(/\.hafen\.(ya?ml|json)$/i, "");
// A provider reference's name: a file's (providers/ollama.yml → ollama), a preset's, or "inline"
const refName = (ref) => (typeof ref === "string" ? ref.split("/").pop().replace(/\.(ya?ml|json)$/i, "") : ref ? "inline" : "");

// Which provider a suite (or one test) runs on: the folder's providers, by name. The file says it as
// a path relative to itself. A reference that isn't one of them (a missing file, a preset, an inline
// provider) shows as it is, so it can be seen and replaced.
function ProviderPicker({ id, label, file, current, resolved, inherit, onChange }) {
  const { providers } = useStore(app);
  const value = current === undefined ? "" : resolved && providers.some((p) => p.file === resolved) ? resolved : "?";
  const options = [
    ...(inherit ? [["", inherit]] : current === undefined ? [["", "choose a provider", true]] : []),
    ...(value === "?" ? [["?", `${refName(current)}${typeof current === "string" && !resolved ? " (missing)" : ""}`, true]] : []),
    ...providers.map((p) => [p.file, p.name]),
  ];
  return (
    <>
      <FieldHead label={label} htmlFor={id} actions={
        <button className="btn btn-ghost" id={`${id}Manage`} type="button" title="Settings → Providers" onClick={() => showProvider(resolved && value !== "?" ? resolved : providers.length ? null : "new")}>{providers.length ? "manage" : "add one"}</button>
      } />
      <label className="select">
        <Select id={id} value={value} options={options} onChange={(e) => {
          const next = e.target.value;
          if (next === "?") return;
          onChange(next ? relativePath(file, next) : null);
        }} />
      </label>
    </>
  );
}

const ciCommand = (file, test, env) => [
  "npx hafen run", JSON.stringify(file),
  env && `--env ${env}`,
  test && (test.id ? `--test ${JSON.stringify(test.name)}` : `--test ${JSON.stringify(test.name)}`),
  "--report junit:results/junit.xml", "--report run:results/run.hafen-run.json",
].filter(Boolean).join(" ");

function CopyButton({ id, text, label = "Copy CI command", className = "btn" }) {
  const [said, setSaid] = useState(label);
  return (
    <button className={className} id={id} type="button" onClick={async () => {
      setSaid((await copyText(text)) ? "copied" : "couldn't copy");
      setTimeout(() => setSaid(label), 1500);
    }}>{said}</button>
  );
}

// Edit a YAML file in the large editor: a button that reads the file as it is when it's pressed (so the
// editor never opens on an older text), and saves through the engine (which checks it)
function EditFile({ file, id, label }) {
  const [open, setOpen] = useState(null);  // the text the editor opened on
  const [reading, setReading] = useState(false);
  const start = async () => {
    setReading(true);
    try {
      setOpen({ value: await readFile(file), code: true, spellcheck: false });
    } catch (err) {
      notify({ title: `Couldn't read ${file}`, text: err.message, kind: "error" });
    } finally {
      setReading(false);
    }
  };
  return (
    <>
      <button type="button" className="btn" id={`${id}Edit`} disabled={reading} onClick={start}>{label}</button>
      {open && <Editor field={open} label={file} onClose={() => setOpen(null)} onSave={async (next) => {
        try {
          const suite = await writeFile(file, next);
          if (suite?.errors?.length) notify({ title: `${file} has problems`, text: suite.errors[0].message, kind: "error" });
        } catch (err) {
          notify({ title: `Couldn't save ${file}`, text: err.message, kind: "error" });
        }
      }} />}
    </>
  );
}

// Which repeat and data row the thread shows, when a run has more than one
function InstancePicker({ run, file, test, selection, id }) {
  const instances = instancesOf(run, file, test);
  if (instances.length < 2) return null;
  const key = (x) => `${x.repeat}|${x.row ?? ""}`;
  // (none picked: the latest, as the thread shows)
  const current = pickedInstance(instances, selection);
  const result = testResult(run, file, test);
  const statusOf = (x) => result?.instances?.find((i) => i.repeat === x.repeat && (i.row ?? null) === (x.row ?? null))?.status;
  const options = instances.map((x) => [key(x), `${x.row ? `row ${x.row}` : `run ${x.repeat}`}${x.row && instances.some((y) => y.repeat > 1) ? ` · run ${x.repeat}` : ""} of ${instances.length}${statusOf(x) ? ` · ${statusOf(x)}` : ""}`]);
  // Failed ones first, so they're easy to find
  options.sort((a, b) => (a[1].includes("failed") ? -1 : 0) - (b[1].includes("failed") ? -1 : 0));
  return (
    <>
      <FieldHead label="Showing" htmlFor={id} />
      <label className="select"><Select id={id} value={key(current)} options={options} onChange={(e) => {
        const [repeat, row] = e.target.value.split("|");
        app.set({ selection: { ...selection, repeat: Number(repeat), row: row ? Number(row) : null } });
      }} /></label>
    </>
  );
}

// A System One call's request, all of it: its address, its headers (its key hidden), and its body as it
// was sent (the state, the model, the questions). While it's being asked, it says so.
function JudgeRequest({ request, id, running }) {
  const body = typeof request.body === "string" ? request.body : JSON.stringify(request.body, null, 2);
  return (
    <>
      <FieldHead label="Request to System One" id={`${id}Label`} actions={
        <>
          {running && <span className="hint judge-asking" id={`${id}Asking`}>asking…</span>}
          <CopyButton id={`${id}Copy`} text={body} label="copy" className="btn btn-ghost" />
        </>
      } />
      <p className="hint judge-request-url" id={`${id}Url`}>{`${request.method} ${request.url}`}</p>
      <Facts className="panel-facts" id={`${id}Headers`} facts={Object.entries(request.headers ?? {})} />
      <Pre id={id} className="judge-request" value={body} />
    </>
  );
}

// The System One call that judged a turn's check (or is judging it): from the run's steps. k: the
// check's place in the run's record of the turn
function judgeCallOf(run, record, k) {
  if (!run?.spans || !record || k < 0) return null;
  const turnSpan = run.spans.find((x) => x.kind === "turn" && x.ref?.turn === run.turns.indexOf(record));
  if (!turnSpan) return null;
  const checks = new Set(run.spans.filter((x) => x.kind === "check" && x.parent === turnSpan._id).map((x) => x._id));
  return run.spans.find((x) => x.kind === "judge_call" && checks.has(x.parent) && x.ref?.checks?.includes(k)) ?? null;
}

/* ---------- views ---------- */

function ConversationView({ close }) {
  const { conversation, providers, suites, selection } = useStore(app);
  const [chosenSuite, setSuiteFile] = useState("");
  const suiteFile = suites.some((s) => s.file === chosenSuite) ? chosenSuite : "";
  const [name, setName] = useState("");
  const run = conversation?.run;
  const turns = run?.turns ?? [];
  const selected = selection.explore && selection.turn !== undefined ? turns[selection.turn] : turns.at(-1);
  // Totals from the turns it has now (a deleted turn isn't counted)
  const metrics = turns.filter(Boolean).map((t) => t.metrics ?? {});
  const times = metrics.map((m) => m.ms).filter(Number.isFinite).sort((a, b) => a - b);
  const totals = {
    tokens: metrics.some((m) => m.tokens) ? { input: metrics.reduce((n, m) => n + (m.tokens?.input ?? 0), 0), output: metrics.reduce((n, m) => n + (m.tokens?.output ?? 0), 0) } : undefined,
    cost: metrics.length && metrics.every((m) => m.cost !== undefined) ? metrics.reduce((n, m) => n + m.cost, 0) : undefined,
    p50: times.length ? times[Math.ceil(times.length / 2) - 1] : undefined,
  };
  return (
    <>
      <Head icon="provider" label="Conversation" onClose={close} />
      <div className="panel-body">
        <FieldHead label="Provider" htmlFor="convProvider" actions={
          <button className="btn btn-ghost" id="convProviders" type="button" title="Settings → Providers" onClick={() => showProvider(providers.length ? conversation?.provider ?? null : "new")}>{providers.length ? "manage" : "add one"}</button>
        } />
        <label className="select">
          <Select id="convProvider" value={conversation?.provider ?? ""} options={[["", providers.length ? "Choose a provider" : "No providers yet", true], ...providers.map((p) => [p.file, p.name])]}
                  disabled={!!conversation?.sending} title={conversation?.sending ? "Wait for the reply (or stop it) to change the provider" : undefined}
                  onChange={(e) => chooseProvider(e.target.value, { keep: true })} />
        </label>
        {turns.length > 0 && <p className="hint">Another provider carries this conversation on: the turns so far are its history.</p>}
        {turns.length > 0 && (
          <TextField key={conversation.id} id="convTitle" label="Name" single value={conversation.title ?? ""} placeholder={String(turns.find(Boolean)?.user ?? "").replace(/\s+/g, " ").slice(0, 60)}
                     onSave={(v) => renameConversation(v)} />
        )}
        {conversation?.error && <p className="hint error panel-note" role="alert">{conversation.error}</p>}
        <Facts className="panel-facts" id="convFacts" facts={[
          ["turns", turns.length ? String(turns.length) : undefined],
          ["tokens", tokenText(totals.tokens) || undefined],
          ["cost", totals.cost !== undefined ? money(totals.cost) : undefined],
          ["p50", totals.p50 !== undefined ? sec(totals.p50) : undefined],
        ]} />
        {selected && <TurnRecord record={selected} index={turns.indexOf(selected)} />}
        <FieldHead label="Save as test" />
        <label className="select">
          <Select id="saveSuite" value={suiteFile} options={[["", `New suite (${freeSuiteFile()})`], ...suites.map((s) => [s.file, s.file])]} onChange={(e) => setSuiteFile(e.target.value)} />
        </label>
        <div className="field-head"><label className="hint" htmlFor="saveName">Name</label></div>
        <input className="input" id="saveName" type="text" placeholder="What this conversation tests" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        <div className="controls">
          <button className="btn btn-primary" id="saveTest" type="button" disabled={!turns.length || !name.trim()} onClick={async () => {
            try {
              await saveConversation({ file: suiteFile || freeSuiteFile(), name: name.trim() });
              setName("");
            } catch (err) {
              notify({ title: "Couldn't save the test", text: err.message, kind: "error" });
            }
          }}>Save as test</button>
        </div>
        {run && (
          <div className="panel-foot">
            <div className="panel-ids"><IdField id="convRunId" label="Run _id" value={run._id ?? ""} /></div>
            {turns.length > 0 && <ConfirmButton className="btn btn-ghost panel-delete" id="convDelete" label="Delete conversation" question="delete it?" onConfirm={() => deleteConversation(conversation.id)} />}
          </div>
        )}
      </div>
    </>
  );
}

function SuiteView({ file, close }) {
  const { env } = useStore(app);
  const now = useNow();
  const [tries, setTries] = useState(0);  // a rename that didn't happen puts the name back
  const suite = suiteOf(file);
  if (!suite) return <Missing close={close} what="suite" />;
  const d = suite.data ?? {};
  const going = liveForSuite(file);
  const running = !!going;
  const busy = !going && !!liveIn(file);  // a test of it running alone
  return (
    <>
      <Head icon="suite" label="Suite" onClose={close} />
      <div className="panel-body">
        <TextField id="suiteName" label="Name (in reports)" single value={d.name ?? ""} placeholder={stem(file)}
                   onSave={(v) => editSuite(file, [v.trim() ? { op: "set", path: ["name"], value: v.trim() } : { op: "delete", path: ["name"] }]).catch(() => {})} />
        <TextField key={`${file}-${tries}`} id="suiteFile" label="File name" single value={stem(file)} onSave={async (v) => {
          if (!v.trim() || !(await renameSuite(file, v))) setTries((n) => n + 1);
        }} />
        <p className="hint">{file}</p>
        <ProviderPicker id="suiteProvider" label="Provider" file={file} current={d.provider} resolved={suite.providerFiles?.[""]}
                        onChange={(ref) => editSuite(file, [{ op: "set", path: ["provider"], value: ref }]).catch(() => {})} />
        <div className="controls">
          <NumberField id="suiteGroup" label="Group" min="1" step="1" value={d.group}
                       onSave={(n) => editSuite(file, [n === null ? { op: "delete", path: ["group"] } : { op: "set", path: ["group"], value: n }]).catch(() => {})}
                       valid={(n) => n === null || (Number.isInteger(n) && n >= 1)} />
        </div>
        <p className="hint" id="suiteGroupHint">Suites in the same group run one after another; different groups run at the same time. Suites with no group are one group.</p>
        <Facts id="suiteFacts" facts={[
          ["tests", String((d.tests ?? []).length)],
          ["environments", Object.keys(d.environments ?? {}).join(", ") || undefined],
          ["judges", Object.keys(d.judges ?? {}).join(", ") || undefined],
          ["defaults", d.defaults ? Object.entries(d.defaults).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(" · ") : undefined],
          ["last run", (() => {
            const at = Math.max(0, ...(d.tests ?? []).map((_, i) => runForTest(file, i)?.started ?? 0));
            return at ? `${when(at)} · ${ago(at, now)}` : undefined;
          })()],
        ]} />
        <Problems problems={[...(suite.errors ?? []), ...(suite.missing ?? [])]} />
        {suite.warnings?.length > 0 && <p className="hint panel-note">{suite.warnings.map((w) => w.message).join(" · ")}</p>}
        <div className="controls">
          <button className={"btn btn-primary" + (running ? " stop" : "")} id="suiteRun" type="button" disabled={busy} title={busy ? "A test of it is running" : undefined} onClick={() => (running ? stopRun(going.token) : runTests(file).catch(() => {}))}>{running ? "Stop" : "Run suite"}</button>
          <button className="btn" id="suiteAddTest" type="button" onClick={() => newTest(file).catch(() => {})}>Add test</button>
          <CopyButton id="suiteCopyCi" text={ciCommand(file, null, env)} />
        </div>
        <div className="controls"><EditFile file={file} id="suiteYaml" label="Edit the file as YAML" /></div>
        <div className="panel-foot">
          <p className="hint">{suite.file}</p>
          <ConfirmButton className="btn btn-ghost panel-delete" id="suiteDelete" label="Delete suite file" question="delete this file?" onConfirm={() => deleteFile(file).catch(() => {})} />
        </div>
      </div>
    </>
  );
}

function TestView({ file, index, close }) {
  const state = useStore(app);
  const now = useNow();
  const { env, runs } = state;
  const suite = suiteOf(file);
  const test = testOf(file, index);
  const [history, setHistory] = useState([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const mine = runs.filter((r) => r.tests.some((t) => t.suite === file && (t.id ?? t.name) === (test?.id ?? test?.name))).slice(0, 20);
      const full = [];
      for (const r of mine.reverse()) full.push(await idb.get("runs", r._id));
      if (alive) setHistory(full.filter(Boolean));
    })();
    return () => { alive = false; };
  }, [runs, file, test?.id, test?.name]);
  if (!suite || !test) return <Missing close={close} what="test" />;
  const run = runForTest(file, index);
  const result = testResult(run, file, test);
  const going = liveForTest(file, index);
  const isLive = !!going;
  const set = (key, value) => editSuite(file, [{ op: "set", path: ["tests", index, key], value }]);
  const unset = (key) => (test[key] === undefined ? null : editSuite(file, [{ op: "delete", path: ["tests", index, key] }]));
  const tags = (test.tags ?? []).join(", ");
  const turns = turnsOf(run, file, test).map(({ record }) => record);
  const results = result?.instances?.flatMap((i) => i.results) ?? [];
  const p = (xs, q) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)] : undefined; };
  const allTurns = (run?.turns ?? []).filter((t) => t && t.suite === file && t.test === (test.id ?? test.name));
  const points = (fn) => history.map((r) => ({ value: fn(r), failed: testResult(r, file, test)?.status === "failed" }));
  return (
    <>
      <Head icon="test" label="Test" onClose={close} onBack={() => select({ kind: "suite", file })} backLabel="Back to the suite" />
      <div className="panel-body">
        <TextField id="testName" label="Name" value={test.name} single onSave={(v) => v.trim() && set("name", v.trim())} />
        <ProviderPicker id="testProvider" label="Provider" file={file} current={test.provider} resolved={suite.providerFiles?.[`test:${index}`]}
                        inherit={`the suite's (${refName(suite.data?.provider) || "none"})`}
                        onChange={(ref) => editSuite(file, [ref ? { op: "set", path: ["tests", index, "provider"], value: ref } : { op: "delete", path: ["tests", index, "provider"] }]).catch(() => {})} />
        <TextField id="testTags" label="Tags (comma-separated)" single value={tags} placeholder="smoke, refunds" onSave={(v) => {
          const list = v.split(",").map((x) => x.trim()).filter(Boolean);
          return list.length ? set("tags", list) : unset("tags");
        }} />
        <Facts className="panel-facts" facts={[["file", file]]} />
        <FieldHead label="Runs" />
        <div className="controls">
          <NumberField id="testRepeat" label="Repeat" min="1" value={test.repeat ?? suite.data?.defaults?.repeat ?? 1}
                       onSave={(n) => (n === null ? unset("repeat") : n >= 1 ? set("repeat", Math.round(n)) : null)} />
          <NumberField id="testPassRate" label="Pass rate" min="0" max="1" step="0.01" value={test.pass_rate ?? suite.data?.defaults?.pass_rate ?? 1}
                       onSave={(n) => (n === null ? unset("pass_rate") : n >= 0 && n <= 1 ? set("pass_rate", n) : null)} />
          <NumberField id="testGroup" label="Group" min="1" step="1" value={test.group}
                       onSave={(n) => (n === null ? unset("group") : set("group", n))} valid={(n) => n === null || (Number.isInteger(n) && n >= 1)} />
        </div>
        <p className="hint" id="testGroupHint">Tests in the same group run one after another; different groups run at the same time. Tests with no group are one group.</p>
        <FieldHead label="History" htmlFor="testHistory" />
        <label className="select"><Select id="testHistory" value={test.history ?? suite.data?.defaults?.history ?? "live"} options={[["live", "live: earlier turns are the real replies"], ["pinned", "pinned: earlier turns use their fixed replies"]]} onChange={(e) => set("history", e.target.value)} /></label>
        <FieldHead label="On failure" htmlFor="testOnFail" />
        <label className="select"><Select id="testOnFail" value={test.on_fail ?? suite.data?.defaults?.on_fail ?? "continue"} options={[["continue", "continue with the next turn"], ["stop", "stop the test"]]} onChange={(e) => set("on_fail", e.target.value)} /></label>
        <FieldHead label="Unsure results" htmlFor="testUnsure" />
        <label className="select"><Select id="testUnsure" value={test.unsure ?? suite.data?.defaults?.unsure ?? "warn"} options={[["warn", "warn (count as passed)"], ["pass", "pass"], ["fail", "fail"]]} onChange={(e) => set("unsure", e.target.value)} /></label>
        <TextField id="testData" label="Data file (CSV or JSON lines)" single value={typeof test.data === "string" ? test.data : test.data?.file ?? ""} placeholder="data/rows.csv" onSave={(v) => (!v.trim() ? unset("data") : test.data && typeof test.data === "object" ? editSuite(file, [{ op: "set", path: ["tests", index, "data", "file"], value: v.trim() }]) : set("data", v.trim()))} />
        <div className="controls">
          <button className={"btn btn-primary" + (isLive ? " stop" : "")} id="testRun" type="button" onClick={() => (isLive ? stopRun(going.token) : runTests(file, index).catch(() => {}))}>{isLive ? "Stop" : "Run"}</button>
          <CopyButton id="testCopyCi" text={ciCommand(file, test, env)} />
        </div>
        <Problems problems={[...(suite.errors ?? []), ...(suite.missing ?? [])]} />
        <InstancePicker run={run} file={file} test={test} selection={state.selection} id="testInstance" />
        {result && (
          <>
            <FieldHead label="Last run" actions={<span className="hint">{testStatusText(result).text}</span>} />
            <Facts id="testFacts" facts={[
              ["status", result.status + (result.unsure ? " (unsure)" : "")],
              // (While it runs, only its status and when it started: its counts aren't in yet)
              ...(result.status === "running" ? [] : [
                ["passed", result.total !== undefined ? `${result.passed}/${result.total}` : undefined],
                // (A skipped check, turned off or not reached, isn't counted: as a turn's aren't)
                ["checks", `${results.filter((r) => r.status === "pass").length}/${results.filter((r) => r.status !== "skipped").length}`],
                ["accuracy", result.accuracy !== undefined ? `${Math.round(result.accuracy * 100)}%` : undefined],
                ["p50", sec(p(allTurns.map((t) => t.metrics?.ms), 0.5))],
                ["p95", sec(p(allTurns.map((t) => t.metrics?.ms), 0.95))],
                ["tokens", tokenText(allTurns.reduce((a, t) => ({ input: (a.input ?? 0) + (t.metrics?.tokens?.input ?? 0), output: (a.output ?? 0) + (t.metrics?.tokens?.output ?? 0) }), {}))],
                ["cost", allTurns.length && allTurns.every((t) => t.metrics?.cost !== undefined) ? money(allTurns.reduce((a, t) => a + t.metrics.cost, 0)) : undefined],
              ]),
              ["when", run?.started ? `${when(run.started)} · ${ago(run.started, now)}` : undefined],
            ]} />
            {result.reason && <p className="hint panel-note">{result.reason}</p>}
          </>
        )}
        {history.length >= 2 && (
          <>
            <Chart id="testChartPass" label="Pass rate" points={points((r) => { const t = testResult(r, file, test); return t?.total ? t.passed / t.total : undefined; })} format={(v) => `${Math.round(v * 100)}%`} />
            <Chart id="testChartP95" label="p95" points={points((r) => p((r.turns ?? []).filter((t) => t?.test === (test.id ?? test.name)).map((t) => t.metrics?.ms), 0.95))} format={sec} />
            <Chart id="testChartCost" label="Cost" points={points((r) => r.summary?.cost)} format={money} />
          </>
        )}
        <p className="hint">Click a turn for its checks and response.</p>
        <div className="controls"><EditFile file={file} id="testYaml" label="Edit the suite as YAML" /></div>
        <div className="panel-foot">
          <div className="panel-ids"><IdField id="testId" label="Test id" value={test.id ?? ""} /></div>
          <ConfirmButton className="btn btn-ghost panel-delete" id="testDelete" label="Delete test" question="delete this test?"
                         onConfirm={() => deleteTest(file, index).catch(() => {})} />
        </div>
      </div>
    </>
  );
}

// What a turn sent and got: response (as a tree), request, thinking, metrics
function TurnRecord({ record, index, onAddCheck }) {
  const [picked, setPicked] = useState(null);
  const [op, setOp] = useState("equals");
  const [value, setValue] = useState("");
  // A value picked in one response isn't carried to another turn's
  useEffect(() => { setPicked(null); setValue(""); }, [record]);
  const response = record.response?.assembled ?? record.response?.body;
  const isJson = response !== null && typeof response === "object";
  const m = record.metrics ?? {};
  return (
    <>
      <FieldHead label="Response" id="turnResponseLabel" actions={<span className="hint">{[record.response?.status, m.ms !== undefined && sec(m.ms)].filter(Boolean).join(" · ")}</span>} />
      {picked && onAddCheck && (
        <>
          <div className="json-path"><code>{picked}</code></div>
          <div className="path-form">
            <label className="select"><Select id="pathOp" aria-label="Operator" value={op} options={[["equals", "equals"], ["not_equals", "doesn't equal"], ["contains", "contains"], ["matches", "matches"], ["exists", "exists"], ["type_is", "type is"], ["lt", "<"], ["gt", ">"]]} onChange={(e) => setOp(e.target.value)} /></label>
            {op !== "exists" && <input className="input" id="pathValue" aria-label="Value" value={value} onChange={(e) => setValue(e.target.value)} />}
            <button className="btn" id="pathAdd" type="button" onClick={() => {
              let v = value;
              try { v = JSON.parse(value); } catch {}
              if (op === "lt" || op === "gt") v = Number(value);
              onAddCheck({ path: picked, [op]: op === "exists" ? true : v });
              setPicked(null);
            }}>Add check</button>
          </div>
        </>
      )}
      {isJson
        ? <JsonTree id="turnResponse" value={response} selected={picked} label={`Response of turn ${index + 1}`} onSelect={(path, v) => { setPicked(path); setValue(typeof v === "string" ? v : JSON.stringify(v)); setOp(typeof v === "string" ? "contains" : "equals"); }} />
        : <Pre id="turnResponse" value={response ?? record.reply ?? "—"} />}
      {onAddCheck && isJson && !picked && <p className="hint panel-note">Click a value to check it.</p>}
      {(record.thinking ?? []).length > 0 && (
        <>
          <FieldHead label="Thinking" actions={<span className="hint">{[...new Set(record.thinking.map((t) => visibilityText(t.visibility)))].join(", ")}</span>} />
          <Pre className="panel-thinking" id="turnThinking" value={record.thinking.map((t) => t.text).join("\n\n") || "(not returned)"} />
        </>
      )}
      <details className="panel-template" id="turnRequest"><summary>Request</summary><Pre value={record.request ?? "—"} /></details>
      {record.response?.chunks?.length > 0 && <details className="panel-template" id="turnStream"><summary>{`Raw stream · ${record.response.chunks_total} chunk${record.response.chunks_total === 1 ? "" : "s"}`}</summary><Pre value={record.response.chunks.join("")} /></details>}
      <Facts className="panel-facts" id="turnFacts" facts={[
        ["first token", m.ttft_ms !== undefined ? sec(m.ttft_ms) : undefined],
        ["thinking", m.thinking_ms !== undefined ? sec(m.thinking_ms) : undefined],
        ["first answer", m.first_answer_ms !== undefined ? sec(m.first_answer_ms) : undefined],
        ["total", m.ms !== undefined ? sec(m.ms) : undefined],
        ["tokens", tokenText(m.tokens) || undefined],
        ["tokens/s", m.tokens_per_s],
        ["cost", m.cost !== undefined ? money(m.cost) : undefined],
        ["checks", m.checks ? `${m.checks.passed}/${m.checks.total - m.checks.skipped}` : undefined],
        ["confidence", m.confidence !== undefined ? `lowest ${m.confidence}` : undefined],
        ["finish", record.finish],
        ["error", record.error],
      ]} />
    </>
  );
}

// A turn (or a check) of a run's test the open folder doesn't have (a CI run, say): as the run recorded
// it, read-only. (record: the run's record of the turn, or null)
function recordedTurn(selection) {
  const run = app.get().openRun;
  if (selection.in !== "run" || !run || run._id !== selection.run) return null;
  // (the test selected, if the folder has it; else the one picked in the run's list)
  const inFolder = selection.test !== undefined ? testOf(selection.file, selection.test) : null;
  const test = inFolder ? { id: inFolder.id, name: inFolder.name, turns: [] } : runTestDefinition(run, selection);
  const instance = pickedInstance(instancesOf(run, selection.file ?? test?.suite, test), selection);
  return turnsOf(run, selection.file ?? test?.suite, test, instance).find(({ record }) => record.index === selection.turn)?.record ?? null;
}
const backToRun = (selection) => select({ kind: "run", run: selection.run, file: selection.file, test: selection.test, runTest: selection.runTest });

function RunTurnView({ selection, record, close }) {
  const i = selection.turn;
  return (
    <>
      <Head icon="test" label={`Turn ${i + 1}`} onClose={close} backLabel="Back to the run" onBack={() => backToRun(selection)} />
      <div className="panel-body">
        <p className="hint panel-note" id="turnFromRun">As the run recorded it: its test isn't in the open folder.</p>
        <FieldHead label="Message" />
        <Pre id="turnUser" value={typeof record.user === "string" ? record.user : JSON.stringify(record.user, null, 2)} />
        <FieldHead label="Checks" />
        {(record.results ?? []).length > 0
          ? <ul className="check-cards" id="turnChecks" aria-label="Checks">{record.results.map((r, j) => <CheckCard key={j} id={`turnCheck-${j}`} check={r.check ?? {}} result={r} onOpen={() => select({ ...selection, kind: "check", check: j })} />)}</ul>
          : <p className="note placeholder">No checks.</p>}
        <TurnRecord record={record} index={i} />
      </div>
    </>
  );
}

function RunCheckView({ selection, record, close }) {
  const r = record.results?.[selection.check];
  if (!r) return <Missing close={close} what="check" />;
  return (
    <>
      <Head icon="check" label={`Check · ${kindOf(r.check ?? {}).name}`} onClose={close} backLabel="Back to its turn" onBack={() => select({ ...selection, kind: "turn", check: undefined })} />
      <div className="panel-body">
        <p className="hint panel-note">As the run recorded it: its test isn't in the open folder.</p>
        {r.check && <><FieldHead label="The check" /><Pre id="checkYaml" value={yaml(r.check).trimEnd()} /></>}
        <FieldHead label="Last result" />
        <ul className="check-cards" id="checkResult" aria-label="Result"><CheckCard id="checkResultCard" check={r.check ?? {}} result={r} /></ul>
        <Facts className="panel-facts" id="checkFacts" facts={[
          ["status", r.status], ["value", r.value !== undefined ? String(r.value) : undefined], ["confidence", r.confidence !== undefined ? String(r.confidence) : undefined],
          ["expected", r.expected !== undefined ? JSON.stringify(r.expected) : undefined], ["actual", r.actual !== undefined ? JSON.stringify(r.actual).slice(0, 400) : undefined],
          ["reason", r.reason],
        ]} />
      </div>
    </>
  );
}

function TurnView({ selection, close }) {
  const { file, test: t, turn: i } = selection;
  const test = testOf(file, t);
  const turn = test?.turns?.[i];
  if (!turn) {
    const recorded = recordedTurn(selection);
    return recorded ? <RunTurnView selection={selection} record={recorded} close={close} /> : <Missing close={close} what="turn" />;
  }
  const { record, results: paired } = turnRecordOf(selection, test, i);
  const set = (key, value) => editSuite(file, [{ op: "set", path: ["tests", t, "turns", i, key], value }]);
  const add = async (check) => {
    const existing = turn.expect ?? [];
    try {
      await editSuite(file, [existing.length ? { op: "add", path: ["tests", t, "turns", i, "expect"], value: check } : { op: "set", path: ["tests", t, "turns", i, "expect"], value: [check] }]);
    } catch {
      return;  // (editSuite has said why)
    }
    select({ kind: "check", file, test: t, turn: i, check: existing.length });
  };
  return (
    <>
      <Head icon="test" label={`Turn ${i + 1}`} onClose={close} backLabel={selection.in === "run" ? "Back to the run" : "Back to the test"}
            onBack={() => select(selection.in === "run" ? { kind: "run", run: selection.run, file, test: t, runTest: selection.runTest } : { kind: "test", file, test: t })} />
      <div className="panel-body">
        <TextField id="turnUser" label={typeof turn.user === "string" ? "Message" : "Message (JSON)"} code={typeof turn.user !== "string"}
                   value={typeof turn.user === "string" ? turn.user : JSON.stringify(turn.user, null, 2)} onSave={(v) => {
                     if (typeof turn.user === "string") return set("user", v);
                     try {
                       return set("user", JSON.parse(v));
                     } catch (err) {
                       notify({ title: "That message isn't JSON", text: err.message, kind: "error" });
                       return null;
                     }
                   }} />
        {(test.history ?? suiteOf(file)?.data?.defaults?.history ?? "live") === "pinned" && <TextField id="turnReply" label="Fixed reply (pinned history)" value={turn.reply ?? ""} onSave={(v) => set("reply", v)} />}
        <TextField id="turnExtract" label="Extract (variable: path)" code rows={2} value={turn.extract ? yaml(turn.extract).trimEnd() : ""} placeholder="session: $.session_id"
                   onSave={(v) => {
                     try {
                       const parsed = v.trim() ? parseYaml(v) : null;
                       if (parsed) set("extract", parsed);
                       else editSuite(file, [{ op: "delete", path: ["tests", t, "turns", i, "extract"] }]);
                     } catch (err) {
                       notify({ title: "That isn't YAML", text: err.message, kind: "error" });
                     }
                   }} />
        <FieldHead label="Checks" actions={(turn.expect ?? []).some((c) => !isOn(c)) ? <span className="hint">{`${(turn.expect ?? []).filter((c) => !isOn(c)).length} off`}</span> : null} />
        {(turn.expect ?? []).length > 0 && (
          <ul className="check-cards" id="turnChecks" aria-label="Checks">
            {(turn.expect ?? []).map((c, j) => (
              <CheckCard key={j} id={`turnCheck-${j}`} check={c} result={paired[j]}
                         onOpen={() => select({ kind: "check", file, test: t, turn: i, check: j, repeat: selection.repeat, row: selection.row, in: selection.in, run: selection.run })}
                         onToggle={(on) => setCheckOn(file, t, i, j, on)}
                         onDelete={() => deleteCheck(file, t, i, j).catch(() => {})} />
            ))}
          </ul>
        )}
        {!(turn.expect ?? []).length && <p className="note placeholder" id="turnChecksEmpty">No checks yet: add one from Checks in the sidebar, or click a value of the response.</p>}
        {record ? <TurnRecord record={record} index={i} onAddCheck={add} /> : <p className="note placeholder" id="turnNotRun">Run the test to see this turn's response.</p>}
        <div className="panel-foot">
          <ConfirmButton className="btn btn-ghost panel-delete" id="turnDelete" label="Delete turn" question="delete this turn?"
                         onConfirm={() => deleteTurn(file, t, i).catch(() => {})} />
        </div>
      </div>
    </>
  );
}

function CheckView({ selection, close }) {
  const { file, test: t, turn: i, check: j } = selection;
  const test = testOf(file, t);
  const check = test?.turns?.[i]?.expect?.[j];
  if (!check) {
    const recorded = !test ? recordedTurn(selection) : null;
    return recorded ? <RunCheckView selection={selection} record={recorded} close={close} /> : <Missing close={close} what="check" />;
  }
  const { run: from, record, results } = turnRecordOf(selection, test, i);
  const r = results[j];
  const type = check.type ?? (check.path ? "path" : "text");
  // A System One check: the request it was judged with, or is being judged with as the run goes on
  // (a turn running has no results yet: its checks are the file's, in order)
  const call = String(check.type ?? "").startsWith("systemone.") ? judgeCallOf(from, record, r ? (record?.results ?? []).indexOf(r) : record?.live ? j : -1) : null;
  const judging = !!call && call.end === undefined;
  return (
    <>
      <Head icon="check" label={`Check · ${type}`} onClose={close} backLabel="Back to its turn"
            onBack={() => select({ kind: "turn", file, test: t, turn: i, repeat: selection.repeat, row: selection.row, in: selection.in, run: selection.run })} />
      <div className="panel-body">
        <TextField id="checkYaml" label="The check (YAML)" code rows={5} value={yaml(check).trimEnd()} onSave={(v) => {
          try {
            const parsed = parseYaml(v);
            if (!parsed || typeof parsed !== "object") throw new Error("a check is a map of fields");
            return editSuite(file, [{ op: "set", path: ["tests", t, "turns", i, "expect", j], value: parsed }]);
          } catch (err) {
            notify({ title: "That check isn't valid YAML", text: err.message, kind: "error" });
          }
        }} />
        <CheckOnBox id="checkOn" on={isOn(check)} onToggle={(on) => setCheckOn(file, t, i, j, on)} className="check panel-check" title="Off, it's skipped when the test runs (enabled: false)">On: run this check</CheckOnBox>
        <FieldHead label="Last result" />
        {r || !isOn(check) ? (
          <>
            <ul className="check-cards" id="checkResult" aria-label="Last result"><CheckCard id="checkResultCard" check={check} result={r} /></ul>
            {r && <Facts className="panel-facts" id="checkFacts" facts={[
              ["status", r.status], ["value", r.value !== undefined ? String(r.value) : undefined], ["confidence", r.confidence !== undefined ? String(r.confidence) : undefined],
              ["expected", r.expected !== undefined ? JSON.stringify(r.expected) : undefined], ["actual", r.actual !== undefined ? JSON.stringify(r.actual).slice(0, 400) : undefined],
              ["reason", r.reason], ["judge", r.judge ? [r.judge.kind, r.judge.model ?? r.judge.provider].filter(Boolean).join(" · ") : undefined],
              ["tokens", r.usage ? tokenText(r.usage) : undefined], ["cost", r.cost !== undefined ? money(r.cost) : undefined],
            ]} />}
            {r?.judge?.raw && <><FieldHead label="The judge's answer" /><Pre value={r.judge.raw} /></>}
            {r?.judge?.samples && <><FieldHead label="The judge's samples" /><Pre value={r.judge.samples} /></>}
          </>
        ) : <p className="note placeholder" id="checkNotRun">{judging ? "Judging…" : "Not run yet."}</p>}
        {call?.request && <JudgeRequest request={call.request} id="checkJudgeRequest" running={judging} />}
        <div className="panel-foot">
          <ConfirmButton className="btn btn-ghost panel-delete" id="checkDelete" label="Delete check" question="delete this check?"
                         onConfirm={() => deleteCheck(file, t, i, j).catch(() => {})} />
        </div>
      </div>
    </>
  );
}

function StepView({ span, run, close, back }) {
  if (!span) return <Missing close={close} what="step" />;
  const m = span.metrics ?? {};
  const turn = span.ref?.turn !== undefined ? run?.turns?.[span.ref.turn] : null;
  const event = span.ref?.event !== undefined ? turn?.events?.[span.ref.event] : null;
  return (
    <>
      <Head icon="timeline" label={`Step · ${span.kind.replace("_", " ")}`} onClose={close} onBack={back?.go} backLabel={back?.label} />
      <div className="panel-body">
        <Facts id="stepFacts" facts={[
          ["name", span.name], ["kind", span.kind], ["starts", sec(span.start)], ["takes", span.end !== undefined ? sec(span.end - span.start) : "running…"], ["status", span.status],
          ["first token", m.ttft_ms !== undefined ? sec(m.ttft_ms) : undefined], ["tokens", tokenText(m.tokens) || undefined], ["confidence", m.confidence],
          ["cost", m.cost !== undefined ? money(m.cost) : undefined], ["checks", m.checks ? `${m.checks.passed}/${m.checks.total - (m.checks.skipped ?? 0)}` : undefined],
        ]} />
        {event?.type === "thinking" && <><FieldHead label="Thinking" actions={<span className="hint">{visibilityText(event.visibility)}</span>} /><Pre className="panel-thinking" value={event.text || "(not returned)"} /></>}
        {event?.type === "text" && <><FieldHead label="Answer" /><Pre value={event.text} /></>}
        {event?.type === "tool_call" && <><FieldHead label="Arguments" /><JsonTree id="stepArgs" value={event.args ?? null} label="Arguments" /></>}
        {event?.type === "tool_result" && <><FieldHead label="Result" /><JsonTree id="stepResult" value={event.result ?? null} label="Result" /></>}
        {span.kind === "request" && turn?.request && <><FieldHead label="Request" /><Pre value={turn.request} /></>}
        {span.kind === "judge_call" && span.request && <JudgeRequest request={span.request} id="stepJudgeRequest" running={span.end === undefined} />}
      </div>
    </>
  );
}

function RunView({ close }) {
  const { openRun: run, runs, env } = useStore(app);
  const [baseline, setBaseline] = useState("");
  const [comparison, setComparison] = useState(null);
  useEffect(() => {
    setComparison(null);
    if (!baseline || !run) return;
    idb.get("runs", baseline).then((b) => (b ? compareRuns(run, b) : null)).then(setComparison).catch(() => setComparison(null));
  }, [baseline, run?._id]);
  if (!run) return <Missing close={close} what="run" />;
  const s = run.summary ?? {};
  const earlier = runs.filter((r) => r._id !== run._id && r.suites.some((f) => run.suites.some((x) => x.file === f)));
  return (
    <>
      <Head icon="run" label="Run" onClose={close} />
      <div className="panel-body">
        <Facts id="runFacts" facts={[
          ["status", run.status], ["verdict", run.verdict], ["mode", run.mode], ["where", [run.where?.app, run.where?.version].filter(Boolean).join(" ")],
          ["environment", run.settings?.env], ["started", when(run.started)], ["took", sec(run.ms)],
          ["tests", s.tests ? `${s.tests.passed}/${s.tests.total} passed${s.tests.unsure ? ` · ${s.tests.unsure} unsure` : ""}` : undefined],
          ["checks", s.checks ? `${s.checks.passed}/${s.checks.total - (s.checks.skipped ?? 0)}` : undefined],
          ["latency", s.latency?.total?.n ? `p50 ${sec(s.latency.total.p50)} · p95 ${sec(s.latency.total.p95)} · p99 ${sec(s.latency.total.p99)} (n=${s.latency.total.n})` : undefined],
          ["tokens", tokenText(s.tokens) || undefined], ["cost", s.cost !== undefined ? money(s.cost) : undefined],
          ["stopped", run.stopped], ["error", run.error?.message],
        ]} />
        {(() => {
          // (for the test the thread shows: the one picked in the list below, or the run's first)
          const sel = app.get().selection;
          const shown = runTestDefinition(run, sel);
          const file = sel.file ?? shown?.suite;
          const t = (sel.test !== undefined ? testOf(file, sel.test) : null) ?? shown;
          return t ? <InstancePicker run={run} file={file} test={t} selection={sel} id="runInstance" /> : null;
        })()}
        <FieldHead label="Tests" />
        <ul className="list" id="runTests" aria-label="Tests in this run">
          {run.tests.map((t, i) => {
            const index = (suiteOf(t.suite)?.data?.tests ?? []).findIndex((x) => (x.id ?? x.name) === (t.id ?? t.name));
            const { text, status } = testStatusText(t);
            return (
              <li key={i} className="list-row" data-status={status} id={`runTest-${i}`}>
                <button type="button" className="list-open" onClick={() => app.set({ selection: { kind: "run", run: run._id, file: t.suite, test: index > -1 ? index : undefined, runTest: i } })}>{t.name}</button>
                <span className="list-size">{text}</span>
              </li>
            );
          })}
        </ul>
        {earlier.length > 0 && (
          <>
            <FieldHead label="Compare with" htmlFor="runBaseline" />
            <label className="select"><Select id="runBaseline" value={baseline} options={[["", "a run to compare with"], ...earlier.map((r) => [r._id, `${r.name} · ${when(r.started)}`])]} onChange={(e) => setBaseline(e.target.value)} /></label>
            {comparison && (
              <>
                <Facts className="panel-facts" id="runComparison" facts={[
                  ["pass rate", `${pct(comparison.pass_rate.run)} · was ${pct(comparison.pass_rate.baseline)} · ${comparison.pass_rate.change ?? "—"}`],
                  ["p50", `${sec(comparison.p50.run)} · was ${sec(comparison.p50.baseline)} · ${comparison.p50.change ?? "—"}`],
                  ["p95", `${sec(comparison.p95.run)} · was ${sec(comparison.p95.baseline)} · ${comparison.p95.change ?? "—"}`],
                  ["cost", `${money(comparison.cost.run)} · was ${money(comparison.cost.baseline)} · ${comparison.cost.change ?? "—"}`],
                ]} />
                {comparison.flipped.length > 0 && <p className="hint panel-note">{comparison.flipped.map((f) => `${f.test} · turn ${f.turn + 1} · ${f.check}: ${f.from} → ${f.to}`).join("\n")}</p>}
                {comparison.regressed.length > 0 && <p className="hint error panel-note">{`Regressed: ${comparison.regressed.join("; ")}`}</p>}
              </>
            )}
          </>
        )}
        <div className="controls panel-actions">
          <button className="btn" id="exportRun" type="button" onClick={() => exportRun(run)}>export JSON</button>
          <button className="btn" id="runAgain" type="button" disabled={!(run.suites ?? []).some((x) => suiteOf(x.file))}
                  onClick={() => runAgain(run).catch((err) => notify({ title: "Couldn't run it again", text: err.message, kind: "error" }))}>run again</button>
        </div>
        <div className="panel-foot">
          <div className="panel-ids"><IdField id="runId" label="Run _id" value={run._id} /></div>
          <ConfirmButton className="btn btn-ghost panel-delete" id="runDelete" label="Delete run" question="delete this run?" onConfirm={() => deleteRun(run._id)} />
        </div>
      </div>
    </>
  );
}
const pct = (v) => (v === undefined ? "—" : `${Math.round(v * 100)}%`);

function Missing({ close, what }) {
  return (
    <>
      <Head icon="test" label={what[0].toUpperCase() + what.slice(1)} onClose={close} />
      <div className="panel-body"><p className="note placeholder">{`This ${what} isn't here any more.`}</p></div>
    </>
  );
}

export function Panel() {
  const state = useStore(app);
  const { selection, openRun: run, conversation, lives } = state;
  const close = () => select({ kind: "conversation" });
  let view;
  switch (selection.kind) {
    case "suite": view = <SuiteView file={selection.file} close={close} />; break;
    case "test": view = <TestView file={selection.file} index={selection.test} close={close} />; break;
    case "turn": view = selection.explore ? <ConversationView close={close} /> : <TurnView selection={selection} close={close} />; break;
    case "check": view = <CheckView selection={selection} close={close} />; break;
    case "run": view = <RunView close={close} />; break;
    case "step": {
      const source = selection.explore ? conversation?.run
        : selection.in === "suite" ? suiteRunFor(selection.file)
          : selection.run && run?._id === selection.run ? run
            : lives.find((l) => l.run?._id === selection.run)?.run ?? (selection.file !== undefined ? runForTest(selection.file, selection.test) : run);
      const span = source?.spans?.find((s) => s._id === selection.span);
      // Back: to the step's turn by default (else its test)
      const turnIndex = selection.turn ?? (span?.ref?.turn !== undefined ? source?.turns?.[span.ref.turn]?.index : undefined);
      const back = Number.isInteger(turnIndex)
        ? { label: "Back to its turn", go: () => select(selection.explore ? { kind: "turn", explore: true, turn: turnIndex, in: "explore" } : { kind: "turn", file: selection.file, test: selection.test, turn: turnIndex, in: selection.in, run: selection.run }) }
        : selection.file !== undefined && selection.test !== undefined ? { label: "Back to the test", go: () => select({ kind: "test", file: selection.file, test: selection.test }) } : null;
      view = <StepView span={span} run={source} back={back} close={() => select(selection.explore ? { kind: "conversation" } : selection.in === "suite" ? { kind: "suite", file: selection.file } : selection.file !== undefined && selection.test !== undefined ? { kind: "test", file: selection.file, test: selection.test } : { kind: "conversation" })} />;
      break;
    }
    default: view = <ConversationView close={close} />;
  }
  // One view per thing selected (by what it is, not where it sits), so nothing typed or picked in
  // one is carried to another
  const t = selection.file !== undefined && selection.test !== undefined ? testOf(selection.file, selection.test) : null;
  const viewKey = [selection.kind, selection.file, t ? t.id ?? t.name : selection.test, selection.turn, selection.check, selection.span, selection.run].join("|");
  // (`shown`: on a small screen it covers the thread only when something's selected, or it's asked for)
  return <aside className={`panel${state.panelOpen ? " shown" : ""}`} id="panel" aria-label="Details"><Fragment key={viewKey}>{view}</Fragment></aside>;
}

export { spanFor, statsLine };
