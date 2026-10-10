// The panel for a suite: its name and file, provider, problems, last results and CI command.

import { useState } from "react";
import { ConfirmButton } from "../../design/confirm.jsx";
import { useNow, useStore } from "../../design/hooks.js";
import { ago, when } from "../../lib/format.js";
import { app, deleteFile, editSuite, newTest, problemsOf, warningsOf, renameSuite, runForTest, runTests, liveForSuite, liveIn, stopRun, suiteOf } from "../../state.js";
import { openExport } from "../../transfer.js";
import { Facts, NumberField, Problems, TextField } from "../fields.jsx";
import { CiHint, CopyCi, EditFile, Head, Missing, ProviderPicker, stem } from "./parts.jsx";

export function SuiteView({ file, close }) {
  useStore(app);
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
        <ProviderPicker id="suiteProvider" label="Provider" file={file} current={d.provider} resolved={suite.providerFiles?.[""]} named={suite.providerNames?.[""]}
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
        <Problems problems={problemsOf(file)} file={file} />
        {warningsOf(file).length > 0 && <p className="hint panel-note">{warningsOf(file).map((w) => w.message).join(" · ")}</p>}
        <div className="controls">
          <button className={"btn btn-primary" + (running ? " stop" : "")} id="suiteRun" type="button" disabled={busy} title={busy ? "A test of it is running" : undefined} onClick={() => (running ? stopRun(going.token) : runTests(file).catch(() => {}))}>{running ? "Stop" : "Run suite"}</button>
          <button className="btn" id="suiteAddTest" type="button" onClick={() => newTest(file).catch(() => {})}>Add test</button>
        </div>
        <div className="controls">
          <button className="btn" id="suiteExport" type="button" title="Write it, with everything it uses, to a folder: for git and npx hafen run" onClick={() => openExport([file])}>Export…</button>
          <CopyCi id="suiteCopyCi" file={file} />
        </div>
        <CiHint id="suiteCiHint" file={file} />
        <div className="controls"><EditFile file={file} id="suiteYaml" label="Edit the file as YAML" /></div>
        <div className="panel-foot">
          <p className="hint">{suite.file}</p>
          <ConfirmButton className="btn btn-ghost panel-delete" id="suiteDelete" label="Delete suite file" question="delete this file?" onConfirm={() => deleteFile(file).catch(() => {})} />
        </div>
      </div>
    </>
  );
}
