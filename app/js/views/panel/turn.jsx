// The panels for a turn and a check: as the file has them, or as a run recorded them.

import { useEffect, useState } from "react";
import { parse as parseYaml, stringify as yaml } from "yaml";
import { ConfirmButton } from "../../design/confirm.jsx";
import { JsonTree } from "../../design/json-tree.jsx";
import { Select } from "../../design/select.jsx";
import { notify } from "../../design/toast.jsx";
import { money, sec, tokens as tokenText } from "../../lib/format.js";
import { app, deleteCheck, deleteTurn, editSuite, select, setCheckOn, suiteOf, testOf } from "../../state.js";
import { CheckCard, CheckOnBox } from "../check-card.jsx";
import { runTestDefinition } from "../thread.jsx";
import { isOn, kindOf } from "../check-types.js";
import { Facts, FieldHead, Pre, TextField } from "../fields.jsx";
import { countedResult, instancesOf, pickedInstance, stoppedTurn, turnsOf, visibilityText } from "../derive.js";
import { Head, JudgeRequest, judgeCallOf, Missing, turnRecordOf } from "./parts.jsx";

// What a turn sent and got: response (as a tree), request, thinking, metrics
export function TurnRecord({ record, index, onAddCheck }) {
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
        // (a turn that failed before any text came had no first token)
        ["first token", m.ttft_ms !== undefined && (!record.error || record.reply) ? sec(m.ttft_ms) : undefined],
        ["thinking", m.thinking_ms !== undefined ? sec(m.thinking_ms) : undefined],
        ["first answer", m.first_answer_ms !== undefined ? sec(m.first_answer_ms) : undefined],
        ["total", m.ms !== undefined ? sec(m.ms) : undefined],
        ["tokens", tokenText(m.tokens) || undefined],
        ["tokens/s", m.tokens_per_s],
        ["cost", m.cost !== undefined ? money(m.cost) : undefined],
        ["checks", m.checks ? `${m.checks.passed}/${m.checks.total - m.checks.skipped}` : undefined],
        ["confidence", m.confidence !== undefined ? `lowest ${m.confidence}` : undefined],
        // (a request stopped on purpose finished that way: it isn't an error)
        ["finish", record.finish ?? (stoppedTurn(record) ? "stopped" : undefined)],
        ["error", stoppedTurn(record) ? undefined : record.error],
      ]} />
    </>
  );
}

// A turn (or a check) of a run's test the app doesn't have (a CI run, say): as the run recorded
// it, read-only. (record: the run's record of the turn, or null)
function recordedTurn(selection) {
  const run = app.get().openRun;
  if (selection.in !== "run" || !run || run._id !== selection.run) return null;
  // (the test selected, if the app has it; else the one picked in the run's list)
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
        <p className="hint panel-note" id="turnFromRun">As the run recorded it: its test isn't in your suites.</p>
        <FieldHead label="Message" />
        <Pre id="turnUser" value={typeof record.user === "string" ? record.user : JSON.stringify(record.user, null, 2)} />
        <FieldHead label="Checks" />
        {(record.results ?? []).length > 0
          ? <ul className="check-cards" id="turnChecks" aria-label="Checks">{record.results.map((r, j) => <CheckCard key={j} id={`turnCheck-${j}`} check={r.check ?? {}} result={countedResult(r)} onOpen={() => select({ ...selection, kind: "check", check: j })} />)}</ul>
          : <p className="note placeholder">No checks.</p>}
        <TurnRecord record={record} index={i} />
      </div>
    </>
  );
}

function RunCheckView({ selection, record, close }) {
  const r = countedResult(record.results?.[selection.check]);
  if (!r) return <Missing close={close} what="check" />;
  return (
    <>
      <Head icon="check" label={`Check · ${kindOf(r.check ?? {}).name}`} onClose={close} backLabel="Back to its turn" onBack={() => select({ ...selection, kind: "turn", check: undefined })} />
      <div className="panel-body">
        <p className="hint panel-note">As the run recorded it: its test isn't in your suites.</p>
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

export function TurnView({ selection, close }) {
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
              <CheckCard key={j} id={`turnCheck-${j}`} check={c} result={countedResult(paired[j])}
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

export function CheckView({ selection, close }) {
  const { file, test: t, turn: i, check: j } = selection;
  const test = testOf(file, t);
  const check = test?.turns?.[i]?.expect?.[j];
  if (!check) {
    const recorded = !test ? recordedTurn(selection) : null;
    return recorded ? <RunCheckView selection={selection} record={recorded} close={close} /> : <Missing close={close} what="check" />;
  }
  const { run: from, record, results } = turnRecordOf(selection, test, i);
  const r = results[j];
  const counted = countedResult(r);  // (shown as it counted; r, as recorded, finds its judge's request)
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
            <ul className="check-cards" id="checkResult" aria-label="Last result"><CheckCard id="checkResultCard" check={check} result={counted} /></ul>
            {r && <Facts className="panel-facts" id="checkFacts" facts={[
              ["status", counted.status], ["value", r.value !== undefined ? String(r.value) : undefined], ["confidence", r.confidence !== undefined ? String(r.confidence) : undefined],
              ["expected", r.expected !== undefined ? JSON.stringify(r.expected) : undefined], ["actual", r.actual !== undefined ? JSON.stringify(r.actual).slice(0, 400) : undefined],
              ["reason", counted.reason], ["judge", r.judge ? [r.judge.kind, r.judge.model ?? r.judge.provider].filter(Boolean).join(" · ") : undefined],
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
