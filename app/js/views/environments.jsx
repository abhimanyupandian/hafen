// Settings → Configurations → Environments (contracts/ui.md, Settings): each scope's plain variables,
// as Postman and other API clients keep them: stage, prod… Each scope's are a plain YAML file in the
// open folder (environments/<scope>.yml: names to values, kept in version control, used as they are
// in CI with --env); its secrets are kept apart (Settings → Secrets). Any field takes them as
// {{scope.NAME}}, for the scope chosen here (the scope button at the top of the sidebar opens this pane).

import { useEffect, useState } from "react";
import { ConfirmButton } from "../design/confirm.jsx";
import { Editor } from "../design/editor.jsx";
import { useStore } from "../design/hooks.js";
import { Select } from "../design/select.jsx";
import { notify } from "../design/toast.jsx";
import { addScope, app, deleteScope, readFile, scopeFile, scopeNames, setEnv, setScopeVariable, writeFile } from "../state.js";

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const shown = (v) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

export function EnvironmentsPane() {
  const state = useStore(app);
  const names = scopeNames(state);
  const [scope, setScope] = useState(state.env ?? names[0] ?? "");
  const [error, setError] = useState("");
  const [newScope, setNewScope] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(null);
  useEffect(() => { if (!scope && names[0]) setScope(names[0]); }, [names.join()]);
  const kept = state.scopes.find((s) => s.name === scope);
  const values = kept?.values ?? {};
  const act = async (work) => {
    setError("");
    try {
      await work();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  };

  // The scope to choose: any there is (a suite's environment, or one that has only secrets, can be
  // chosen with no folder open)
  const picker = names.length > 0 && (
    <>
      <div className="field-head"><label className="hint" htmlFor="envScope">Scope</label>{scope && scope === state.env ? <span className="hint" id="envChosen">chosen now</span> : scope ? <button className="btn btn-ghost" id="envChoose" type="button" onClick={() => setEnv(scope)}>choose it</button> : null}</div>
      <label className="select"><Select id="envScope" value={scope} options={names.map((n) => [n, n])} onChange={(e) => setScope(e.target.value)} /></label>
    </>
  );
  if (!state.opened || !state.canWrite) {
    return (
      <>
        {picker}
        <p className="note placeholder" id="environmentsClosed">{names.length ? "Open a folder to add scopes and their variables: they're kept in its environments/ folder, as plain YAML." : "Open a folder first: a scope's variables are kept in its environments/ folder, as plain YAML."}</p>
      </>
    );
  }
  return (
    <>
      {picker || <p className="note placeholder" id="environmentsEmpty">No scopes yet: add one (stage, prod…).</p>}
      <form className="controls" id="newScopeForm" onSubmit={async (e) => {
        e.preventDefault();
        if (await act(async () => setScope(await addScope(newScope)))) setNewScope("");
      }}>
        <input className="input grow" id="newScopeName" type="text" placeholder="a new scope: stage, prod…" autoComplete="off" spellCheck={false} value={newScope} onChange={(e) => setNewScope(e.target.value)} />
        <button className="btn" type="submit" disabled={!newScope.trim()}>add scope</button>
      </form>
      <p className="hint error" id="environmentsError" role="alert" hidden={!error}>{error}</p>
      {scope && (
        <>
          <div className="field-head"><span className="hint">{`Variables of ${scope}`}</span><span className="hint">{kept?.file ?? scopeFile(scope)}</span></div>
          {kept?.errors?.length ? <p className="hint error" role="alert">{kept.errors[0].message}</p> : null}
          {Object.keys(values).length
            ? (
              <ul className="list settings-list" id="envVars" aria-label={`Variables of ${scope}`}>
                {Object.entries(values).map(([key, v]) => (
                  <li key={`${scope}-${key}`} className="settings-row" id={`envVar-${key}`}>
                    <div className="settings-row-text"><span className="settings-row-name">{key}</span><span className="hint">{`{{scope.${key}}}`}</span></div>
                    {/* (keyed by the file's value: changed elsewhere, as YAML say, the field shows it, rather than
                        keep what was typed before and write it back when it's left) */}
                    <input key={shown(v)} className="input" aria-label={`Value of ${key}`} defaultValue={shown(v)} readOnly={typeof v === "object" && v !== null} style={{ width: 220 }}
                           onBlur={(e) => { if (e.target.value !== shown(v)) act(() => setScopeVariable(scope, key, e.target.value)); }}
                           onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
                    <ConfirmButton className="btn btn-ghost list-del" aria-label={`Delete ${key}`} label="×" question="delete" onConfirm={() => act(() => setScopeVariable(scope, key, null))} />
                  </li>
                ))}
              </ul>
            )
            : <p className="note placeholder" id="envVarsEmpty">No variables in this scope yet.</p>}
          <form className="controls" id="envVarAdd" onSubmit={async (e) => {
            e.preventDefault();
            if (!NAME.test(name.trim())) return setError("A variable's name is letters, digits, '_', '.' and '-', and doesn't start with a digit.");
            if (await act(() => setScopeVariable(scope, name.trim(), value))) {
              setName("");
              setValue("");
              document.getElementById("envVarName")?.focus();
            }
            return undefined;
          }}>
            <input className="input grow" id="envVarName" type="text" placeholder="NAME" aria-label="Name" autoComplete="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
            <input className="input grow" id="envVarValue" type="text" placeholder="its value (plain text)" aria-label="Value" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
            <button className="btn" type="submit" disabled={!name.trim()}>add</button>
          </form>
          <div className="controls">
            <button className="btn" id="envYaml" type="button" disabled={!kept?.file} onClick={async () => setEditing({ value: await readFile(kept.file), code: true, spellcheck: false })}>Edit the scope as YAML</button>
            {kept?.file && <ConfirmButton className="btn btn-ghost" id="envDelete" label="Delete scope" question="delete its file?" onConfirm={() => act(async () => { await deleteScope(scope); setScope(""); })} />}
          </div>
          <p className="hint">{`Use one in any field as {{scope.NAME}}, for the scope chosen here. Secrets are per scope too, in Secrets. In CI: npx hafen run … --env ${scope}.`}</p>
        </>
      )}
      {editing && kept?.file && <Editor field={editing} label={kept.file} onClose={() => setEditing(null)} onSave={async (next) => {
        try {
          await writeFile(kept.file, next);
        } catch (err) {
          notify({ title: `Couldn't save ${kept.file}`, text: err.message, kind: "error" });
        }
      }} />}
    </>
  );
}
