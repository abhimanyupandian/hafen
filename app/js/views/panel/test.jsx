// The panel for a test: its name, provider, settings, data rows, results across runs and CI command.

import { useEffect, useState } from "react";
import { Chart } from "../../design/chart.jsx";
import { ConfirmButton } from "../../design/confirm.jsx";
import { useNow, useStore } from "../../design/hooks.js";
import { IdField } from "../../design/id-field.jsx";
import { Select } from "../../design/select.jsx";
import { ago, money, sec, tokens as tokenText, when } from "../../lib/format.js";
import * as idb from "../../lib/idb.js";
import { app, deleteTest, editSuite, problemsOf, runForTest, runTests, liveForTest, select, stopRun, suiteOf, testOf } from "../../state.js";
import { Facts, FieldHead, NumberField, Problems, TextField } from "../fields.jsx";
import { testResult, testStatusText, turnsOf } from "../derive.js";
import { CiHint, CopyCi, EditFile, Head, InstancePicker, Missing, ProviderPicker, refName } from "./parts.jsx";

export function TestView({ file, index, close }) {
  const state = useStore(app);
  const now = useNow();
  const { runs } = state;
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
        <ProviderPicker id="testProvider" label="Provider" file={file} current={test.provider} resolved={suite.providerFiles?.[`test:${index}`]} named={suite.providerNames?.[`test:${index}`]}
                        used={test.provider === undefined ? suite.providerFiles?.[""] : suite.providerFiles?.[`test:${index}`]}
                        inherit={`the suite's (${refName(suite.data?.provider) || "none"})`}
                        onChange={(ref) => editSuite(file, [ref ? { op: "set", path: ["tests", index, "provider"], value: ref } : { op: "delete", path: ["tests", index, "provider"] }]).catch(() => {})} />
        <TextField id="testTags" label="Tags (comma-separated)" single value={tags} placeholder="No tags yet" onSave={(v) => {
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
        <label className="select"><Select id="testUnsure" value={test.unsure ?? suite.data?.defaults?.unsure ?? "fail"} options={[["fail", "fail (count as failed)"], ["warn", "warn (count as passed, with a warning)"], ["pass", "pass"]]} onChange={(e) => set("unsure", e.target.value)} /></label>
        <TextField id="testData" label="Data file (CSV or JSON lines)" single value={typeof test.data === "string" ? test.data : test.data?.file ?? ""} placeholder="data/rows.csv" onSave={(v) => (!v.trim() ? unset("data") : test.data && typeof test.data === "object" ? editSuite(file, [{ op: "set", path: ["tests", index, "data", "file"], value: v.trim() }]) : set("data", v.trim()))} />
        {/* (each data row's name: shown with a data file, or while the file has one; empty removes it) */}
        {(test.data || test.row_name !== undefined) && (
          <>
            <TextField id="testRowName" label="Row names" single value={test.row_name ?? ""} placeholder="first column" onSave={(v) => (!v.trim() ? unset("row_name") : set("row_name", v.trim()))} />
            <p className="hint" id="testRowNameHint">{"Each row's name in the reports and the thread (row 3: …): its first column's value, or a template such as {{row.question}} ({{row.order}}). Cut at 60 characters; never a secret."}</p>
          </>
        )}
        <div className="controls">
          <button className={"btn btn-primary" + (isLive ? " stop" : "")} id="testRun" type="button" onClick={() => (isLive ? stopRun(going.token) : runTests(file, index).catch(() => {}))}>{isLive ? "Stop" : "Run"}</button>
          <CopyCi id="testCopyCi" file={file} test={test} />
        </div>
        <CiHint id="testCiHint" file={file} />
        <Problems problems={problemsOf(file)} file={file} />
        <InstancePicker run={run} file={file} test={test} selection={state.selection} id="testInstance" />
        {/* (its last run broke off before it: how, and why, each problem its check found for one that
            couldn't run; nothing of it ran, so nothing else to count) */}
        {result?.unreached && (
          <>
            <FieldHead label="Last run" actions={<span className="hint error" id="testLastStatus">{testStatusText(result).text}</span>} />
            <Facts id="testFacts" facts={[
              ["status", testStatusText(result).text],
              ["when", run?.started ? `${when(run.started)} · ${ago(run.started, now)}` : undefined],
            ]} />
            <ul className="problems" id="testRunError">{(result.refused ? run.error.all : [{ message: result.reason }]).map((p, i) => (
              <li key={i}>{`${p.file && p.line ? `${p.file}:${p.line}: ` : ""}${p.message}`}</li>
            ))}</ul>
          </>
        )}
        {result && !result.unreached && (
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
            {result.reason && <p className={`hint panel-note${result.status === "error" ? " error" : ""}`}>{result.reason}</p>}
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
