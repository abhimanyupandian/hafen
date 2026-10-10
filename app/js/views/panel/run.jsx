// The panels for a run opened from Runs, and for one step of a run's timeline (a request, a judge call,
// a fixture's call).

import { useEffect, useState } from "react";
import { ConfirmButton } from "../../design/confirm.jsx";
import { useStore } from "../../design/hooks.js";
import { IdField } from "../../design/id-field.jsx";
import { JsonTree } from "../../design/json-tree.jsx";
import { Select } from "../../design/select.jsx";
import { notify } from "../../design/toast.jsx";
import { money, sec, tokens as tokenText, when } from "../../lib/format.js";
import * as idb from "../../lib/idb.js";
import { app, compareRuns, deleteRun, exportRun, runAgain, suiteOf, testOf } from "../../state.js";
import { runTestDefinition } from "../thread.jsx";
import { Facts, FieldHead, Pre } from "../fields.jsx";
import { showPlugin } from "../plugins.jsx";
import { refusedRun, testStatusText, visibilityText } from "../derive.js";
import { Head, InstancePicker, JudgeRequest, Missing } from "./parts.jsx";

const pct = (v) => (v === undefined ? "—" : `${Math.round(v * 100)}%`);

const pretty = (body) => {
  if (typeof body !== "string") return JSON.stringify(body, null, 2);
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
};

export function StepView({ span, run, close, back }) {
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
        {span.kind === "fixture" && (
          <Facts className="panel-facts" id="stepFixture" facts={[
            ["fixture", span.fixture?.name && <button className="btn btn-ghost inline-link" type="button" id="stepFixtureCode" title="Its code (Settings → Plugins)" onClick={() => showPlugin(span.fixture.name)}>{span.fixture.name}</button>],
            ["when", span.fixture?.phase], ["provider", span.fixture?.provider],
            ["gave", m.provides?.length ? m.provides.join(", ") : undefined],
            // (the environment's names it set with env.set, for the rest of the run; and whether its run() said to stop)
            ["set", m.sets?.length ? m.sets.join(", ") : undefined], ["stop", m.stop ? "said to stop" : undefined],
            ["calls", m.calls ? String(m.calls) : undefined], ["error", span.error],
          ]} />
        )}
        {span.kind === "call" && <CallDetails span={span} />}
      </div>
    </>
  );
}

function CallDetails({ span }) {
  const req = span.request ?? {};
  const res = span.response;
  return (
    <>
      {/* (the plugin that made it, "fixture acme-login": a link to its code) */}
      <FieldHead label="Request" id="stepCallRequestLabel" actions={span.plugin ? (
        <button className="btn btn-ghost" type="button" id="stepCallPlugin" title="Its code (Settings → Plugins)" onClick={() => showPlugin(span.plugin.split(" ").slice(1).join(" "))}>{span.plugin}</button>
      ) : null} />
      <p className="hint judge-request-url" id="stepCallUrl">{`${req.method ?? "GET"} ${req.url ?? ""}`}</p>
      {Object.keys(req.headers ?? {}).length > 0 && <Facts className="panel-facts" id="stepCallHeaders" facts={Object.entries(req.headers)} />}
      {req.body !== undefined && <Pre id="stepCallBody" className="judge-request" value={pretty(req.body)} />}
      <FieldHead label="Response" id="stepCallResponseLabel" actions={<span className="hint" id="stepCallStatus">{res?.status !== undefined ? String(res.status) : span.end === undefined ? "waiting…" : "no response"}</span>} />
      {span.error && <p className="hint error" id="stepCallError">{span.error}</p>}
      {Object.keys(res?.headers ?? {}).length > 0 && <Facts className="panel-facts" id="stepCallResponseHeaders" facts={Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join("; ") : v])} />}
      {res?.body ? <Pre id="stepCallResponseBody" className="judge-request" value={pretty(res.body)} /> : null}
    </>
  );
}

export function RunView({ close }) {
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
        {/* (one that broke off before its tests ran none: the thread says why) */}
        {!run.tests.length && run.status === "error" && <p className="note placeholder" id="runTestsNone">{refusedRun(run) ? "None ran: it was refused before anything was sent." : "None ran: it broke off before its tests."}</p>}
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
