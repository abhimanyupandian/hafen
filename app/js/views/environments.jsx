// Settings → Configurations → Environments (contracts/ui.md, Settings), and what it shares with Secrets
// (spec/design/components.md, Additions: Scope panes): the app's scopes (stage, prod…) and Globals down
// the left, the one picked on the right, as Postman and other API clients keep environments. A scope
// works as the command line's --env file does, the app keeping any number of them to swap between: its
// values are plain text, kept by the app (lib/scope-store.js), not in its files; its secrets are kept
// apart (Settings → Secrets). Globals are values for every scope: a scope's own of a name win
// (lib/scopes.js). Any field takes a value as {{env.NAME}}, for the scope chosen (the scope button at
// the top of the sidebar opens this pane). The scopes are only the ones made here: deleting one deletes
// all of it, its values and its secrets, and nothing brings it back.

import { useEffect, useRef, useState } from "react";
import { parseEnvText } from "hafen/engine/env-file.js";
import { ConfirmButton } from "../design/confirm.jsx";
import { openMenu } from "../design/context-menu.jsx";
import { Editor } from "../design/editor.jsx";
import { useStore } from "../design/hooks.js";
import { Icon } from "../design/icons.jsx";
import { List, ListRow } from "../design/list.jsx";
import { SearchField } from "../design/search.jsx";
import { notify } from "../design/toast.jsx";
import { envFile } from "../lib/ci.js";
import { envText, NAME, NAME_RULE } from "../lib/scope-store.js";
import { effectiveValues, scopeNameProblem, sourceOf } from "../lib/scopes.js";
import { addScope, app, deleteScope, duplicateScope, exportScopeValues, importScopeValues, renameScope, scopeNames, setEnv, setScopeValue } from "../state.js";
import { unsetValues, usedNames } from "./references.js";

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

// A .env file's values, or why it can't be read (its first problem, and where). A secrets file's
// problem never shows what's in its lines, as the command line's doesn't: a name that isn't one, or what
// follows a quoted value, could be part of a secret.
export function readEnvFile(text, name, { secret = false } = {}) {
  const { values, errors } = parseEnvText(text, name);
  if (!errors.length) return values;
  const e = errors[0];
  const message = secret ? e.message.replace(/^".*" isn't a name/, "that isn't a name").replace(/^(after a quoted value, only a # comment): not .*$/, "$1") : e.message;
  throw new Error(`${name}: ${/^line \d/.test(message) ? message : `line ${e.line}: ${message}`}. Nothing was changed.`);
}

// Work that may fail, its error said in the pane (and nothing else changed): → whether it went
export function useAct(setError) {
  return async (work) => {
    setError("");
    try {
      await work();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  };
}

// The entry a pane shows: "" (Globals) or a scope. It opens on the scope chosen (Globals with none), and
// goes back there when the one shown is renamed or deleted elsewhere.
export function useEntry(state) {
  const names = scopeNames(state);
  const [entry, setEntry] = useState(state.env ?? "");
  const gone = !!entry && !names.includes(entry);
  useEffect(() => { if (gone) setEntry(state.env && names.includes(state.env) ? state.env : ""); }, [gone]);
  return [gone ? "" : entry, setEntry];
}

// A scope's menu (its row's more, a right-click on it, its head's more): choose it, rename it (its name
// field, in the head), duplicate it, delete it (asking first)
export function scopeMenu(scope, { onShow, onRename, act }) {
  return {
    label: `${scope}: what to do`,
    items: [
      { id: "scope-choose", label: "Choose it", disabled: app.get().env === scope, onPick: () => setEnv(scope) },
      { id: "scope-rename", label: "Rename", onPick: () => { onShow(scope); onRename(); } },
      { id: "scope-duplicate", label: "Duplicate", onPick: () => act(async () => onShow(await duplicateScope(scope))) },
      "-",
      { id: "scope-delete", label: "Delete", danger: true, confirm: "Click again to delete its values and secrets", onPick: () => act(() => deleteScope(scope)) },
    ],
  };
}

// Opened under the control (a click on more), or at the pointer (a right-click)
const under = (e) => ({ currentTarget: e.currentTarget, preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() });

// The entries down the left: Globals, a line, then the scopes, with + to add one. pane: "env" or
// "secrets" (their ids); unset(scope): how many names the open files use that it hasn't got.
export function ScopeList({ pane, entry, onShow, onRename, act, unset }) {
  const state = useStore(app);
  const names = scopeNames(state);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [problem, setProblem] = useState("");
  const open = adding || !names.length;
  const close = () => { setAdding(false); setName(""); setProblem(""); };
  const row = (scope, label) => {
    const id = scope ? `${pane}Scope-${scope}` : `${pane}Globals`;
    const missing = unset(scope);
    const chosen = !!scope && state.env === scope;
    const menu = (e) => openMenu(e, scopeMenu(scope, { onShow, onRename, act }));
    return (
      <ListRow key={id} id={id} label={label} active={entry === scope} onOpen={() => onShow(scope)} title={`${label}${chosen ? " · chosen now" : ""}${missing ? ` · ${missing} not set` : ""}`}
               extra={chosen ? <span title="Chosen now"><Icon name="check" size={14} /></span> : undefined}
               size={missing ? `${missing} not set` : undefined} data={{ status: missing ? "error" : "" }}
               onContextMenu={scope ? menu : undefined}
               actions={scope && <button className="btn btn-icon list-more" id={`${id}-more`} type="button" aria-label={`More for ${scope}`} title="More" aria-haspopup="menu" onClick={(e) => menu(under(e))}><Icon name="more" size={14} /></button>} />
    );
  };
  return (
    <nav className="scope-list" aria-label={pane === "env" ? "Environments" : "Secrets"}>
      <div className="scope-list-head"><span className="label">Globals</span></div>
      <List aria-label="Globals">{row("", "Globals")}</List>
      <div className="scope-list-line" role="separator"></div>
      <div className="scope-list-head">
        <span className="label" id={`${pane}ScopesLabel`}>Scopes</span>
        <button className="btn btn-icon" id="newScope" type="button" aria-label="Add a scope" title="Add a scope" aria-expanded={open} onClick={() => (adding ? close() : setAdding(true))}><Icon name="plus" size={14} /></button>
      </div>
      {open && (
        <form className="controls new-scope-form" id="newScopeForm" onSubmit={async (e) => {
          e.preventDefault();
          const next = name.trim();
          const why = scopeNameProblem(next, names);
          if (why) return setProblem(why);
          try {
            const made = await addScope(next);
            close();
            onShow(made);
          } catch (err) {
            setProblem(err.message);
          }
          return undefined;
        }}>
          <input className="input grow" id="newScopeName" type="text" placeholder="stage, prod…" aria-label="A new scope's name" autoComplete="off" spellCheck={false} autoFocus={adding}
                 value={name} onChange={(e) => { setName(e.target.value); setProblem(""); }}
                 onKeyDown={(e) => { if (e.key === "Escape" && (adding || name)) { e.preventDefault(); e.stopPropagation(); close(); } }} />
          <button className="btn" type="submit" disabled={!name.trim()}>add</button>
        </form>
      )}
      {problem && <p className="hint error field-problem" id="newScopeProblem" role="alert">{problem}</p>}
      {names.length
        ? <List id={`${pane}Scopes`} aria-labelledby={`${pane}ScopesLabel`}>{names.map((scope) => row(scope, scope))}</List>
        : <p className="note" id="environmentsEmpty">No scopes yet: add one (stage, prod…).</p>}
    </nav>
  );
}

// The entry's head: a scope's name (a field: Enter or leaving it renames; Esc puts it back), or Globals';
// choose it, or, when it's the one chosen, the same button saying so (disabled); a scope's menu.
// renameAsk: counts asks to rename it (its menu's Rename): its name is focused, and selected.
export function ScopeHead({ pane, entry, onShow, onRename, renameAsk, act }) {
  const state = useStore(app);
  const ref = useRef(null);
  const chosen = (state.env ?? "") === entry;
  useEffect(() => {
    if (renameAsk && ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, [renameAsk]);
  return (
    <div className="scope-head">
      {entry
        ? <input key={entry} ref={ref} className="input scope-name-field" id={`${pane}ScopeName`} type="text" aria-label="Scope name" autoComplete="off" spellCheck={false} defaultValue={entry}
                 onBlur={(e) => {
                   const next = e.target.value.trim();
                   if (!next || next === entry) { e.target.value = entry; return; }
                   act(async () => onShow(await renameScope(entry, next))).then((ok) => { if (!ok && ref.current) ref.current.value = entry; });
                 }}
                 onKeyDown={(e) => {
                   if (e.key === "Enter") e.currentTarget.blur();
                   if (e.key === "Escape" && e.currentTarget.value !== entry) { e.preventDefault(); e.stopPropagation(); e.currentTarget.value = entry; }
                 }} />
        : <h3 className="scope-title" id={`${pane}GlobalsTitle`}>Globals</h3>}
      {chosen
        ? <button className="btn" id={`${pane}Chosen`} type="button" disabled>{entry ? "chosen now" : "no scope chosen"}</button>
        : <button className="btn" id={`${pane}Choose`} type="button" onClick={() => setEnv(entry || null)}>{entry ? "choose it" : "choose no scope"}</button>}
      {entry && <button className="btn btn-icon" id={`${pane}More`} type="button" aria-label={`More for ${entry}`} title="More" aria-haspopup="menu"
                        onClick={(e) => openMenu(under(e), scopeMenu(entry, { onShow, onRename, act }))}><Icon name="more" size={14} /></button>}
    </div>
  );
}

// The table's head row: a label a column (extra: after the value's). A row's buttons are in its value's
// column, after the value, so where it's from is last, and only as wide as its words.
export const VarsHead = ({ name, extra }) => (
  <div className="vars-head" role="row">
    <span className="label" role="columnheader">{name}</span>
    <span role="columnheader"><span className="label">Value</span>{extra}</span>
    <span className="label" role="columnheader">Source</span>
  </div>
);

// What a row's Source says (on Globals' own rows, the scopes that have their own of the name)
export function sourceText(source, { scope, overriddenIn = [] }) {
  if (source === "own") return scope ? "this scope" : ["Globals", overriddenIn.length && `overridden in ${overriddenIn.join(", ")}`].filter(Boolean).join(" · ");
  return { override: "overrides Globals", globals: "from Globals", unset: "not set" }[source] ?? "";
}

// A field that saves when it's left or on Enter; Esc puts back what's saved (and, when nothing was
// changed, closes Settings, as Esc does)
const keys = (saved) => (e) => {
  if (e.key === "Enter") e.currentTarget.blur();
  if (e.key === "Escape" && e.currentTarget.value !== saved) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.value = saved;
  }
};

// The last row has no button: Enter in either of its fields adds it (submits its form)
export const enterAdds = (e) => {
  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
  e.preventDefault();
  e.currentTarget.form.requestSubmit();
};

// The rows a search keeps: the ones whose name (or, with values, value) has its text, case aside
export const searched = (rows, query, { values = false } = {}) => {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(q) || (values && String(r.value ?? "").toLowerCase().includes(q)));
};

export function EnvironmentsPane() {
  const state = useStore(app);
  const [entry, setEntry] = useEntry(state);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(null);
  const [renameAsk, setRenameAsk] = useState(0);
  const [focusRow, setFocusRow] = useState(null);  // a row whose field takes focus once it's drawn (one just overridden)
  const fileRef = useRef(null);
  const act = useAct(setError);
  const show = (next) => {
    setEntry(next);
    setError("");
    setQuery("");
  };
  const { globals, scopes } = state;
  const own = entry ? scopes.find((s) => s.name === entry)?.values ?? {} : globals;
  const used = usedNames(state).env;
  const unsetIn = (scope) => unsetValues(scope, effectiveValues(scope, state), state);
  // Its own, then the names the open files use that neither it nor Globals has, then (a scope's) Globals'
  // it doesn't override
  const rows = [
    ...Object.entries(own).map(([n, v]) => ({ name: n, value: v, source: sourceOf(n, { scope: entry, own, globals }) })),
    ...unsetIn(entry).map((n) => ({ name: n, value: null, source: "unset" })),
    ...(entry ? Object.entries(globals).filter(([n]) => !Object.hasOwn(own, n)).map(([n, v]) => ({ name: n, value: v, source: "globals" })) : []),
  ];
  const visible = searched(rows, query, { values: true });
  const file = envFile(entry);
  const importText = (text, from, { replace = false } = {}) => {
    const read = readEnvFile(text, from);
    importScopeValues(entry, read, { replace, from });
    return Object.keys(read).length;
  };
  const override = (n) => act(() => {
    setScopeValue(entry, n, globals[n]);
    setFocusRow(n);
  });

  return (
    <>
      <div className="scope-panes">
        <ScopeList pane="env" entry={entry} onShow={show} onRename={() => setRenameAsk((n) => n + 1)} act={act} unset={(scope) => unsetIn(scope).length} />
        <section className="scope-main" aria-label={entry ? `The scope ${entry}` : "Globals"}>
          <ScopeHead pane="env" entry={entry} onShow={show} onRename={() => setRenameAsk((n) => n + 1)} renameAsk={renameAsk} act={act} />
          <div className="scope-tools">
            <button className="btn" id="envImport" type="button" onClick={() => fileRef.current?.click()}>import .env</button>
            <button className="btn" id="envExport" type="button" disabled={!Object.keys(own).length} title={`Download ${file}`} onClick={() => exportScopeValues(entry)}>export .env</button>
            <button className="btn" id="envText" type="button" onClick={() => setEditing({ value: envText(own), code: true, spellcheck: false })}>edit as .env</button>
            <SearchField id="envSearch" label="Search variables" placeholder="Search variables" value={query} onChange={setQuery} />
          </div>
          <p className="hint error" id="environmentsError" role="alert" hidden={!error}>{error}</p>
          <div className="vars" id="envVars" role="table" aria-label={entry ? `Values of ${entry}` : "Globals' values"}>
            <VarsHead name="Variable" />
            {visible.map((row) => (
              <VarRow key={`${entry}-${row.name}`} entry={entry} row={row} used={used.has(row.name)} focus={focusRow === row.name} act={act}
                      sourceText={sourceText(row.source, { scope: entry, overriddenIn: entry ? [] : scopes.filter((s) => Object.hasOwn(s.values, row.name)).map((s) => s.name) })}
                      onOverride={() => override(row.name)} />
            ))}
            {!visible.length && <p className="note vars-none" id="envVarsEmpty">{query.trim() ? `No variables match "${query.trim()}".` : entry ? "No values in this scope yet: add one below, or import a .env file." : "No values in Globals yet: add one below, or import a .env file."}</p>}
            {/* (Enter adds it: with no name yet, it goes to the name; a value may be empty) */}
            <form className="vars-row vars-add" role="row" id="envVarAdd" onSubmit={async (e) => {
              e.preventDefault();
              if (!name.trim()) return document.getElementById("envVarName")?.focus();
              if (!NAME.test(name.trim())) return setError(NAME_RULE);
              if (await act(() => setScopeValue(entry, name.trim(), value))) {
                setName("");
                setValue("");
                document.getElementById("envVarName")?.focus();
              }
              return undefined;
            }}>
              <span role="cell"><input className="input" id="envVarName" type="text" placeholder="New variable" aria-label="Name" autoComplete="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={enterAdds} /></span>
              <span role="cell"><input className="input" id="envVarValue" type="text" placeholder="its value, then Enter" aria-label="Value" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={enterAdds} /></span>
              <span role="cell"></span>
            </form>
          </div>
          <input ref={fileRef} id="envImportFile" type="file" accept=".env,text/plain" hidden onChange={async (e) => {
            const picked = e.target.files?.[0];
            e.target.value = "";
            if (!picked) return;
            let count = 0;
            if (await act(async () => { count = importText(await picked.text(), picked.name); })) notify({ title: `Imported ${plural(count, "value")} into ${entry || "Globals"}`, text: picked.name, kind: "ok" });
          }} />
          {entry && (
            <div className="panel-foot">
              <ConfirmButton className="btn" id="envDelete" label="Delete scope" question="delete its values and secrets?" onConfirm={() => act(async () => { await deleteScope(entry); show(app.get().env ?? ""); })} />
            </div>
          )}
        </section>
      </div>
      {editing && <Editor field={editing} label={file} onClose={() => setEditing(null)} onSave={(next) => { act(async () => importText(next, file, { replace: true })); }} />}
    </>
  );
}

// A value's row: its name over how a file uses it; its value (a field, or Globals' as text when it's
// inherited), then × (asking first) or override; where it's from
function VarRow({ entry, row, used, focus, act, sourceText: source, onOverride }) {
  const { name, value } = row;
  const saved = value ?? "";
  const ref = useRef(null);
  useEffect(() => {
    if (focus && ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, [focus]);
  return (
    <div className="vars-row" role="row" id={`envVar-${name}`} data-source={row.source}>
      <span className="vars-key" role="cell">
        <span className="vars-name" title={name}>{name}</span>
        <span className="hint vars-use">{[`{{env.${name}}}`, row.source !== "unset" && !used && "not used by the open files"].filter(Boolean).join(" · ")}</span>
      </span>
      <span className="vars-cell" role="cell">
        {row.source === "globals"
          ? <span className="vars-value" title={saved}>{saved}</span>
          /* (keyed by the value kept: changed elsewhere, in another window say, the field shows it, rather
             than keep what was typed before and write it back when it's left) */
          : <input key={saved} ref={ref} className="input" type="text" aria-label={`Value of ${name}`} defaultValue={saved} placeholder={row.source === "unset" ? "its value" : undefined} autoComplete="off" spellCheck={false}
                   onBlur={(e) => { if (e.target.value !== saved && (row.source !== "unset" || e.target.value)) act(() => setScopeValue(entry, name, e.target.value)); }}
                   onKeyDown={keys(saved)} />}
        {row.source === "globals" && <button className="btn" id={`envVar-${name}-override`} type="button" title={`A value of ${entry}'s own, from Globals'`} onClick={onOverride}>override</button>}
        {(row.source === "own" || row.source === "override") && <ConfirmButton className="btn btn-icon" id={`envVar-${name}-delete`} aria-label={`Delete ${name}`} label="×" question="delete" onConfirm={() => act(() => setScopeValue(entry, name, null))} />}
      </span>
      <span className="hint vars-source" role="cell">{source}</span>
    </div>
  );
}
