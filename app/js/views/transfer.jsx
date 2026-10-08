// Import and Export's dialogs (spec/design/components.md, Additions: Question dialog and Export
// dialog): a question asked part way (files that are there already: what's done with them; the
// folder the app opened before: import its suites?), and Export (what the suites take with them, and
// the scope's files written beside them). transfer.js does the work.

import { useEffect, useRef, useState } from "react";
import { ConfirmButton } from "../design/confirm.jsx";
import { useNow, useStore } from "../design/hooks.js";
import { CloseButton, Modal } from "../design/modal.jsx";
import { ciFiles, envFile } from "../lib/ci.js";
import { ago } from "../lib/format.js";
import { app, engineCall } from "../state.js";
import { exporting, exportSuites, questions } from "../transfer.js";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// What each question says, and its answers (the first: what closing it any other way answers)
const ASKED = {
  collisions: ({ name, files }) => ({
    label: "Import",
    note: `${plural(files.length, "file")} from ${name} ${files.length === 1 ? "is" : "are"} here already, with another text:`,
    hint: "Replace writes theirs over yours. Keep both imports theirs beside yours (name-2.yml), the suites imported using them; a plugin is used by its name, so yours stays. Skip keeps yours and leaves theirs out.",
    answers: [["cancel", "Cancel"], ["skip", "Skip"], ["both", "Keep both"], ["replace", "Replace", true]],
  }),
  overwrite: ({ name, files }) => ({
    label: "Export",
    note: `${plural(files.length, "file")} ${files.length === 1 ? "is" : "are"} in ${name} already, and exporting writes over ${files.length === 1 ? "it" : "them"}:`,
    answers: [["cancel", "Cancel"], ["overwrite", "Overwrite", true]],
  }),
  legacy: ({ name, path }) => ({
    label: "Your suites",
    note: `Import the suites from ${name}?`,
    hint: `Hafen keeps your suites in the app now, not in a folder. Import copies the suites in ${path}, and what they use, into it; the folder stays as it is. Suites → Import a folder… does it any time.`,
    answers: [["later", "Not now"], ["import", "Import", true]],
  }),
};

const answerId = (choice) => `question${{ cancel: "Cancel", skip: "Skip", both: "Both", replace: "Replace", overwrite: "Overwrite", later: "Later", import: "Import" }[choice]}`;

// The question being asked, if any
export function Question() {
  const { open } = useStore(questions);
  const ref = useRef(null);
  if (!open) return null;
  const asked = ASKED[open.kind](open);
  return (
    <Modal id="question" label={asked.note} className="question" dialogRef={ref} onClose={() => open.answer(asked.answers[0][0])}>
      <div className="modal-head"><span className="label">{asked.label}</span><CloseButton dialogRef={ref} id="questionClose" /></div>
      <div className="question-body">
        <p className="note" id="questionNote">{asked.note}</p>
        {open.files && <pre className="panel-code question-files" id="questionFiles">{open.files.join("\n")}</pre>}
        {asked.hint && <p className="hint" id="questionHint">{asked.hint}</p>}
      </div>
      <div className="modal-foot">
        {asked.answers.map(([choice, text, primary]) => (
          <button key={choice} type="button" className={primary ? "btn btn-primary" : "btn"} id={answerId(choice)} autoFocus={primary} onClick={() => open.answer(choice)}>{text}</button>
        ))}
      </div>
    </Modal>
  );
}

// Export: the suites asked for, everything they use (as the engine lists it), Globals' and the scope's
// values written beside them or not, then a folder to put them in (Export, or Export with secrets, which
// asks first: they're written in plain text)
export function ExportDialog() {
  const { files } = useStore(exporting);
  const state = useStore(app);
  const now = useNow();
  const ref = useRef(null);
  const [uses, setUses] = useState(null);
  const [withEnv, setWithEnv] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!files) return undefined;
    let alive = true;
    setUses(null);
    setBusy(false);
    setWithEnv(true);
    engineCall("dependencies", { files }).then((out) => { if (alive) setUses(out); }, (err) => { if (alive) setUses({ files: [], problems: [{ file: "", message: err.message }], packages: [] }); });
    return () => { alive = false; };
  }, [files]);
  if (!files) return null;
  const scope = state.env;
  // (the files each would write: only the ones with something in them)
  const { env: envFiles, secret: secretFiles } = ciFiles(state);
  const last = files.length === 1 ? state.exports[files[0]] : null;
  const whose = [envFiles.includes(envFile("")) && "Globals", scope && envFiles.includes(envFile(scope)) && `the ${scope} scope`].filter(Boolean).join(" and of ");
  const close = () => exporting.set({ files: null });
  const go = async (withSecrets) => {
    setBusy(true);
    const where = await exportSuites(files, { env: withEnv && envFiles.length > 0, secrets: withSecrets });
    setBusy(false);
    if (where) ref.current?.close();
  };
  const what = files.length === 1 ? files[0] : `your ${plural(files.length, "suite")}`;
  return (
    <Modal id="exportDialog" label={`Export ${what}`} className="question" dialogRef={ref} onClose={close}>
      <div className="modal-head"><span className="label">Export</span><CloseButton dialogRef={ref} id="exportClose" /></div>
      <div className="question-body">
        <p className="note" id="exportNote">{`Writes ${what} and everything ${files.length === 1 ? "it uses" : "they use"} to a folder you pick, as plain files with the same paths: commit the folder, and CI runs it as it is with npx hafen run.`}</p>
        <div className="field-head"><span className="hint">{uses ? `${plural(uses.files.length, "file")}, never a secret` : "Files"}</span></div>
        <pre className="panel-code question-files" id="exportFiles">{uses ? uses.files.join("\n") : "Reading what they use…"}</pre>
        {uses?.problems.map((p, i) => <p key={i} className="hint error" id={`exportProblem-${i}`} role="alert">{`${p.file ? `${p.file}: ` : ""}${p.message}`}</p>)}
        {uses?.packages.length > 0 && <p className="hint" id="exportPackages">{`The plugin package${uses.packages.length === 1 ? "" : "s"} ${uses.packages.join(", ")} ${uses.packages.length === 1 ? "isn't a file: install it" : "aren't files: install them"} where the suites run.`}</p>}
        {envFiles.length
          ? <label className="check"><input type="checkbox" id="exportEnv" checked={withEnv} onChange={(e) => setWithEnv(e.target.checked)} /> {`Also write ${envFiles.join(" and ")}: the values of ${whose}`}</label>
          : <p className="hint" id="exportNoScope">{scope ? `Neither Globals nor the ${scope} scope has values, so none go with them.` : "Globals has no values, and no scope is chosen, so none go with them: choose one with the scope button to write its .env beside them."}</p>}
        {secretFiles.length > 0 && <p className="hint" id="exportSecretsHint">{`Export with secrets also writes ${secretFiles.join(" and ")}, the secrets in plain text: keep ${secretFiles.length === 1 ? "it" : "them"} out of version control.`}</p>}
        {last && <p className="hint" id="exportLast">{`Last exported to ${last.path} ${ago(last.at, now)}.`}</p>}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" id="exportCancel" onClick={() => ref.current?.close()}>Cancel</button>
        {secretFiles.length > 0 && <ConfirmButton className="btn" id="exportWithSecrets" label="Export with secrets" question="write them in plain text?" disabled={busy || !uses} onConfirm={() => go(true)} />}
        <button type="button" className="btn btn-primary" id="exportGo" disabled={busy || !uses} onClick={() => go(false)}>Export</button>
      </div>
    </Modal>
  );
}
