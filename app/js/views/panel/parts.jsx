// Parts the panel's views share: the head, provider pickers, CI hints and copy buttons, the file editor,
// the run instance picker, a judge's request, and the record of a turn as a run has it.

import { useState } from "react";
import { Editor } from "../../design/editor.jsx";
import { useNow, useStore } from "../../design/hooks.js";
import { Icon } from "../../design/icons.jsx";
import { Select } from "../../design/select.jsx";
import { notify } from "../../design/toast.jsx";
import { copyText } from "../../lib/clipboard.js";
import { ago } from "../../lib/format.js";
import { app, providerChoices, relativePath, readFile, runForTest, writeFile } from "../../state.js";
import { ciCommand, ciFiles, written } from "../../lib/ci.js";
import { openExport } from "../../transfer.js";
import { Facts, FieldHead, Pre } from "../fields.jsx";
import { showProvider } from "../providers.jsx";
import { FixturesSummary } from "../fixtures-field.jsx";
import { instancesOf, pairResults, pairTurns, pickedInstance, rowLabel, testResult, turnsOf } from "../derive.js";

// The run a turn or check is shown from (the open run when picked in its thread, else the test's
// latest), its record of turn i, and each of the turn's checks' results as the file has them now
export function turnRecordOf(selection, test, i) {
  const { file, test: t } = selection;
  const inRun = selection.in === "run";
  const run = inRun ? app.get().openRun : runForTest(file, t);
  const instance = pickedInstance(instancesOf(run, file, test), selection);
  const recorded = turnsOf(run, file, test, instance);
  const record = (inRun ? recorded.find(({ record: r }) => r.index === i) : pairTurns(recorded, test.turns ?? [])[i])?.record ?? null;
  const checks = test.turns?.[i]?.expect ?? [];
  return { run, record, results: record ? pairResults(record.results, checks) : checks.map(() => null) };
}

// onBack: what holds this (a check's or a step's turn, a turn's test, a test's suite). On a small
// screen, where the panel covers the thread, hide (before ×) puts it away and keeps what's selected
// open; × closes it (spec/design/components.md, Additions: The panel on a small screen)
export const Head = ({ icon, label, onClose, onBack, backLabel }) => (
  <div className="panel-head">
    {onBack && (
      <button className="btn btn-ghost btn-icon panel-back" id="panelBack" type="button" aria-label={backLabel} title={backLabel} onClick={onBack}>
        <Icon name="back" size={16} />
      </button>
    )}
    <span className="block-label"><Icon name={icon} size={16} /><span className="label">{label}</span></span>
    <button className="btn btn-ghost btn-icon panel-hide" id="panelHide" type="button" aria-label="Hide the details" aria-controls="panel"
            title="Hide the details (what's open stays open)" onClick={() => app.set({ panelOpen: false })}>
      <Icon name="sidebar" size={16} />
    </button>
    <button className="btn btn-ghost btn-icon" id="panelClose" type="button" aria-label={`Close ${label.toLowerCase()}`} title="Close" onClick={onClose}>
      <Icon name="close" size={16} />
    </button>
  </div>
);

export const stem = (file) => file.split("/").pop().replace(/\.hafen\.(ya?ml|json)$/i, "");

// A provider reference's name: a file's (providers/ollama.yml → ollama), a preset's, or "inline"
export const refName = (ref) => (typeof ref === "string" ? ref.split("/").pop().replace(/\.(ya?ml|json)$/i, "") : ref ? "inline" : "");

// Which provider a suite (or one test) runs on: the providers kept, by name. The file says it as
// a path relative to itself. A reference that isn't one of them (a missing file, a preset, an inline
// provider, one of the suite's named providers) shows as it is, so it can be seen and replaced.
// used: the provider file the test or suite runs with (its own, or the one it inherits): its fixtures.
// named: the name under the suite's providers: the reference is, when it's one
export function ProviderPicker({ id, label, file, current, resolved, used, named, inherit, onChange }) {
  const providers = providerChoices(useStore(app));
  const value = current === undefined ? "" : resolved && providers.some((p) => p.file === resolved) ? resolved : "?";
  const options = [
    ...(inherit ? [["", inherit]] : current === undefined ? [["", "choose a provider", true]] : []),
    ...(value === "?" ? [["?", named ? `${named} (in this suite's providers)` : `${refName(current)}${typeof current === "string" && !resolved ? " (missing)" : ""}`, true]] : []),
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
      <FixturesSummary id={`${id}Fixtures`} providerFile={value === "?" ? null : used ?? resolved ?? null} />
    </>
  );
}

// Under Copy CI command: the folder CI runs (where the suite was last exported to), with the files that
// export wrote there (the ones the command names); not exported yet, it says so, and offers Export
export function CiHint({ id, file }) {
  const state = useStore(app);
  const now = useNow();
  const where = state.exports[file];
  if (!where) {
    return (
      <p className="hint panel-note" id={id}>
        {"Not exported yet: CI runs the folder it's exported to. "}
        <button className="btn btn-ghost inline-link" id={`${id}Export`} type="button" onClick={() => openExport([file])}>Export it</button>
        {" first."}
      </p>
    );
  }
  const envs = written(where.env);
  const files = [...envs, ...written(where.secret)];
  // (values there are now, that no .env file went with: CI runs without them)
  const missing = !envs.length && ciFiles(state).env.length > 0;
  return (
    <p className="hint panel-note" id={id}>
      {`Runs ${where.path}, exported ${ago(where.at, now)}${files.length ? ` with ${files.join(", ").replace(/, ([^,]*)$/, " and $1")}` : ""}: export again after a change.`}
      {missing && " No .env file went with it: CI runs without your values, unless you export them too."}
    </p>
  );
}

export function CopyButton({ id, text, label = "Copy CI command", className = "btn" }) {
  const [said, setSaid] = useState(label);
  return (
    <button className={className} id={id} type="button" onClick={async () => {
      setSaid((await copyText(text)) ? "copied" : "couldn't copy");
      setTimeout(() => setSaid(label), 1500);
    }}>{said}</button>
  );
}

// Copy CI command, for a suite (or one of its tests): the command that runs the folder it was last
// exported to; never exported, the button offers Export instead (CI runs an exported folder)
export function CopyCi({ id, file, test }) {
  const state = useStore(app);
  const text = ciCommand(file, test, state);
  if (text) return <CopyButton id={id} text={text} />;
  return <button className="btn" id={id} type="button" title="Export it first: CI runs the folder it's exported to" onClick={() => openExport([file])}>Copy CI command</button>;
}

// Edit a YAML file in the large editor: a button that reads the file as it is when it's pressed (so the
// editor never opens on an older text), and saves through the engine (which checks it)
export function EditFile({ file, id, label }) {
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

// Which repeat and data row the thread shows, when a run has more than one: "run 2 of 3 · passed", a
// row by its name, "row 3: a refund please · run 2 · failed"
export function InstancePicker({ run, file, test, selection, id }) {
  const instances = instancesOf(run, file, test);
  if (instances.length < 2) return null;
  const key = (x) => `${x.repeat}|${x.row ?? ""}`;
  // (none picked: the latest, as the thread shows)
  const current = pickedInstance(instances, selection);
  const result = testResult(run, file, test);
  const statusOf = (x) => result?.instances?.find((i) => i.repeat === x.repeat && (i.row ?? null) === (x.row ?? null))?.status;
  // Failed ones first, so they're easy to find (by status: a row's name may say "failed")
  const failedFirst = [...instances].sort((a, b) => (statusOf(a) === "failed" ? -1 : 0) - (statusOf(b) === "failed" ? -1 : 0));
  const options = failedFirst.map((x) => [key(x), `${x.row ? `${rowLabel(x.row, x.row_name)}${instances.some((y) => y.repeat > 1) ? ` · run ${x.repeat}` : ""}` : `run ${x.repeat} of ${instances.length}`}${statusOf(x) ? ` · ${statusOf(x)}` : ""}`]);
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
export function JudgeRequest({ request, id, running }) {
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
export function judgeCallOf(run, record, k) {
  if (!run?.spans || !record || k < 0) return null;
  const turnSpan = run.spans.find((x) => x.kind === "turn" && x.ref?.turn === run.turns.indexOf(record));
  if (!turnSpan) return null;
  const checks = new Set(run.spans.filter((x) => x.kind === "check" && x.parent === turnSpan._id).map((x) => x._id));
  return run.spans.find((x) => x.kind === "judge_call" && checks.has(x.parent) && x.ref?.checks?.includes(k)) ?? null;
}

// A plugin's (or a fixture's) HTTP call: what it sent and what came back, as the run kept them
// (redacted: a secret header or value shows as [redacted]; the body's start, when it's long)

export function Missing({ close, what }) {
  return (
    <>
      <Head icon="test" label={what[0].toUpperCase() + what.slice(1)} onClose={close} />
      <div className="panel-body"><p className="note placeholder">{`This ${what} isn't here any more.`}</p></div>
    </>
  );
}
