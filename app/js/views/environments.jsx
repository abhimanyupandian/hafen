// Settings → Configurations → Environments (contracts/ui.md, Settings): the app's scopes (stage,
// prod…) and each one's environment values, as Postman and other API clients keep them. A scope works
// as the command line's --env file does, the app keeping any number of them to swap between: its values
// are plain text, kept by the app (lib/scope-store.js), not in the folder; its secrets are kept apart
// (Settings → Secrets). Any field takes a value as {{env.NAME}}, for the scope chosen (the scope button
// at the top of the sidebar opens this pane). The scopes are only the ones made here: deleting one
// deletes all of it, its values and its secrets, and nothing brings it back.

import { useEffect, useRef, useState } from "react";
import { parseEnvText } from "hafen/engine/env-file.js";
import { ConfirmButton } from "../design/confirm.jsx";
import { Editor } from "../design/editor.jsx";
import { useStore } from "../design/hooks.js";
import { Select } from "../design/select.jsx";
import { notify } from "../design/toast.jsx";
import { envText, VALUE_NAME, VALUE_RULE } from "../lib/scope-store.js";
import { addScope, app, deleteScope, exportScopeValues, importScopeValues, renameScope, scopeNames, setEnv, setScopeValue } from "../state.js";
import { hasValue, usedNames } from "./references.js";

const shown = (v) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

// A .env file's values, or why it can't be read (its first problem, and where)
export function readEnvFile(text, name) {
  const { values, errors } = parseEnvText(text, name);
  if (!errors.length) return values;
  const e = errors[0];
  throw new Error(`${name}: ${/^line \d/.test(e.message) ? e.message : `line ${e.line}: ${e.message}`}. Nothing was changed.`);
}

export function EnvironmentsPane() {
  const state = useStore(app);
  const names = scopeNames(state);
  const [scope, setScope] = useState(state.env ?? names[0] ?? "");
  const [error, setError] = useState("");
  const [newScope, setNewScope] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(null);
  const fileRef = useRef(null);
  // (a scope gone, deleted or renamed elsewhere: the one chosen, else the first)
  useEffect(() => { if (scope && !names.includes(scope)) setScope(state.env ?? names[0] ?? ""); }, [names.join()]);
  const values = state.scopes.find((s) => s.name === scope)?.values ?? {};
  const used = usedNames(state);
  const usedHere = (n) => used.env.has(n);
  // The names the open files use that this scope has no value for, after the ones it has
  // (one a suite's environment of this name gives isn't unset: the engine takes it from there)
  const fromSuites = Object.assign({}, ...state.suites.map((s) => s.data?.environments?.[scope]).filter((e) => e && typeof e === "object"));
  const unset = [...used.env].filter((n) => !(n in values) && !hasValue(fromSuites, n)).sort();
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
  const importText = (text, file, { replace = false } = {}) => {
    const read = readEnvFile(text, file);
    importScopeValues(scope, read, { replace, from: file });
    return Object.keys(read).length;
  };

  return (
    <>
      {names.length ? (
        <>
          <div className="field-head">
            <label className="hint" htmlFor="envScope">Scope</label>
            {scope === (state.env ?? "") ? <span className="hint" id="envChosen">chosen now</span>
              : <button className="btn btn-ghost" id="envChoose" type="button" onClick={() => setEnv(scope || null)}>choose it</button>}
          </div>
          <label className="select"><Select id="envScope" value={scope} options={[["", "no scope"], ...names.map((n) => [n, n])]} onChange={(e) => { setScope(e.target.value); setError(""); }} /></label>
        </>
      ) : <p className="note placeholder" id="environmentsEmpty">No scopes yet: add one (stage, prod…).</p>}
      <form className="controls" id="newScopeForm" onSubmit={async (e) => {
        e.preventDefault();
        if (await act(async () => setScope(await addScope(newScope)))) setNewScope("");
      }}>
        <input className="input grow" id="newScopeName" type="text" placeholder="a new scope: stage, prod…" aria-label="A new scope's name" autoComplete="off" spellCheck={false} value={newScope} onChange={(e) => setNewScope(e.target.value)} />
        <button className="btn" type="submit" disabled={!newScope.trim()}>add scope</button>
      </form>
      <p className="hint error" id="environmentsError" role="alert" hidden={!error}>{error}</p>
      {!scope && names.length > 0 && <p className="note" id="envNone">{"With no scope, {{env.NAME}} has nothing to fill it, and {{secret.NAME}} only what's kept for every scope (Secrets). Choose a scope here, or the scope button at the top of the sidebar."}</p>}
      {scope && (
        <>
          <div className="field-head"><label className="hint" htmlFor="envScopeName">Name</label></div>
          <input key={scope} className="input" id="envScopeName" type="text" autoComplete="off" spellCheck={false} defaultValue={scope}
                 onBlur={(e) => {
                   const next = e.target.value.trim();
                   if (!next || next === scope) { e.target.value = scope; return; }
                   act(async () => setScope(await renameScope(scope, next))).then((ok) => { if (!ok) e.target.value = scope; });
                 }}
                 onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.currentTarget.value = scope; } }} />
          <div className="field-head"><span className="hint">{`Values of ${scope}`}</span></div>
          {Object.keys(values).length || unset.length
            ? (
              <ul className="list settings-list" id="envVars" aria-label={`Values of ${scope}`}>
                {[...Object.entries(values), ...unset.map((n) => [n, null])].map(([key, v]) => (
                  <li key={`${scope}-${key}`} className="settings-row" id={`envVar-${key}`}>
                    <div className="settings-row-text">
                      <span className="settings-row-name">{key}</span>
                      <span className={`hint${v === null ? " error" : ""}`}>{[`{{env.${key}}}`, v === null ? "not set" : !usedHere(key) && "not used by the open files"].filter(Boolean).join(" · ")}</span>
                    </div>
                    {/* (keyed by the value kept: changed elsewhere, in another window say, the field shows it,
                        rather than keep what was typed before and write it back when it's left) */}
                    <input key={shown(v)} className="input" aria-label={`Value of ${key}`} defaultValue={shown(v)} placeholder={v === null ? "its value" : undefined} style={{ width: 220 }}
                           onBlur={(e) => { if (e.target.value !== shown(v) && (v !== null || e.target.value)) act(() => setScopeValue(scope, key, e.target.value)); }}
                           onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
                    {v !== null && <ConfirmButton className="btn btn-ghost list-del" id={`envVar-${key}-delete`} aria-label={`Delete ${key}`} label="×" question="delete" onConfirm={() => act(() => setScopeValue(scope, key, null))} />}
                  </li>
                ))}
              </ul>
            )
            : <p className="note placeholder" id="envVarsEmpty">No values in this scope yet.</p>}
          <form className="controls" id="envVarAdd" onSubmit={async (e) => {
            e.preventDefault();
            if (!VALUE_NAME.test(name.trim())) return setError(VALUE_RULE);
            if (await act(() => setScopeValue(scope, name.trim(), value))) {
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
            <button className="btn" id="envImport" type="button" onClick={() => fileRef.current?.click()}>Import .env</button>
            <button className="btn" id="envExport" type="button" disabled={!Object.keys(values).length} onClick={() => exportScopeValues(scope)}>Export .env</button>
            <button className="btn" id="envText" type="button" onClick={() => setEditing({ value: envText(values), code: true, spellcheck: false })}>Edit as .env</button>
            <ConfirmButton className="btn btn-ghost" id="envDelete" label="Delete scope" question="delete its values and secrets?" onConfirm={() => act(async () => { await deleteScope(scope); setScope(""); })} />
          </div>
          <input ref={fileRef} id="envImportFile" type="file" accept=".env,text/plain" hidden onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            let count = 0;
            if (await act(async () => { count = importText(await file.text(), file.name); })) notify({ title: `Imported ${plural(count, "value")} into ${scope}`, text: file.name, kind: "ok" });
          }} />
          <p className="hint" id="envCiHint">{`Use one in any field as {{env.NAME}}, for the scope chosen; its secrets are in Secrets, as {{secret.NAME}}. In CI: Export writes ${scope}.env, which runs with --env ${scope}.env.`}</p>
        </>
      )}
      {editing && <Editor field={editing} label={`${scope}.env`} onClose={() => setEditing(null)} onSave={(next) => { act(async () => importText(next, `${scope}.env`, { replace: true })); }} />}
    </>
  );
}
