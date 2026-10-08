// Settings → Configurations → Secrets (contracts/ui.md, Settings; spec/design/components.md, Additions:
// Scope panes): each scope's secrets and Globals', laid out as Environments is. The files use one as
// {{secret.NAME}}: the scope's own, else Globals'. A value is never on the page until it's shown (show,
// show all, edit as .env), and goes again when it's hidden: the desktop app's main process decrypts it
// for the page then, and only then. The scopes are the ones made in Environments (here too: +, and each
// one's menu); secrets kept for a name that isn't one now (from before the scopes were only those) are
// listed under them by name, to delete.

import { useEffect, useRef, useState } from "react";
import { fixturesOf } from "hafen/engine/fixture-lists.js";
import { ConfirmButton } from "../design/confirm.jsx";
import { Editor } from "../design/editor.jsx";
import { useStore } from "../design/hooks.js";
import { SearchField } from "../design/search.jsx";
import { notify } from "../design/toast.jsx";
import { isApp } from "../lib/app.js";
import { secretFile } from "../lib/ci.js";
import { envText, NAME, NAME_RULE } from "../lib/scope-store.js";
import { app, deleteGoneScopeSecrets, deleteScope, exportSecrets, keepSecrets, revealSecrets, scopeNames } from "../state.js";
import { enterAdds, readEnvFile, ScopeHead, ScopeList, searched, sourceText, useAct, useEntry, VarsHead } from "./environments.jsx";
import { unsetSecrets, usedNames } from "./references.js";

export const JEV = "JEV_API_KEY";  // System One's key: its own pane, not Secrets
const MASK = "••••••••";
const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

// The names the open providers' fixtures give before their requests (beforeAll's and before's: a
// login's cookie, say): set when a run starts, not here. What each gives is what the plugins say they
// provide.
function fixtureNames({ plugins = [], suites = [], providers = [] }) {
  const configs = [...suites.flatMap((s) => Object.values(s.providers ?? {})), ...providers.map((p) => p.config)];
  const named = new Set(configs.flatMap((c) => {
    const lists = fixturesOf(c);
    return [...lists.beforeAll, ...lists.before].map((ref) => ref.name);
  }));
  return [...new Set(plugins.filter((p) => p.kind === "fixture" && named.has(p.name)).flatMap((p) => p.provides ?? []))].sort();
}

// The one line the pane says, and only while they're kept unencrypted: always in the browser build (this
// browser's storage); in the desktop app, on a system that offers it no encryption (until it does)
function storageNote(storage) {
  if (!isApp) return "Kept in this browser's storage, unencrypted: use the desktop app for keys that matter.";
  return storage?.encrypted === false ? "Kept unencrypted: this system offers the app no encryption yet." : "";
}

export function SecretsPane() {
  const state = useStore(app);
  const [entry, setEntry] = useEntry(state);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(new Set());  // the names whose values are shown
  const [values, setValues] = useState({});  // the values shown, as read: { NAME: value }
  const [editing, setEditing] = useState(null);
  const [renameAsk, setRenameAsk] = useState(0);
  const fileRef = useRef(null);
  const act = useAct(setError);
  const show = (next) => {
    setEntry(next);
    setError("");
    setQuery("");
  };
  const stored = state.scopeSecrets;
  const unreadable = state.secretsUnreadable[entry] ?? [];
  const given = fixtureNames(state);
  const used = usedNames(state).secret;
  const skip = (n) => n !== JEV;
  const own = (stored[entry] ?? []).filter(skip);
  const globals = (stored[""] ?? []).filter(skip);
  const unsetIn = (scope) => unsetSecrets(scope, state, [...given, JEV]);
  // Its own (and those it can't read), then the names the open files use that neither it nor Globals
  // has, then (a scope's) Globals' it doesn't override
  const rows = [
    ...own.map((n) => ({ name: n, source: entry && globals.includes(n) ? "override" : "own" })),
    ...unreadable.filter((n) => skip(n) && !own.includes(n)).map((n) => ({ name: n, source: "own", unreadable: true })),
    ...unsetIn(entry).filter((n) => !unreadable.includes(n)).map((n) => ({ name: n, source: "unset" })),
    ...(entry ? globals.filter((n) => !own.includes(n)).map((n) => ({ name: n, source: "globals" })) : []),
  ];
  const visible = searched(rows, query);
  const showable = rows.filter((r) => r.source !== "unset" && !r.unreadable).map((r) => r.name);
  const file = secretFile(entry);

  // Another entry: nothing shown. The values shown read again when the secrets change (here, or
  // elsewhere); one hidden goes from the page.
  useEffect(() => { setShown(new Set()); setValues({}); }, [entry]);
  useEffect(() => {
    let alive = true;
    const names = [...shown];
    if (!names.length) {
      setValues({});
      return undefined;
    }
    const mine = names.filter((n) => own.includes(n));
    const theirs = names.filter((n) => !own.includes(n) && globals.includes(n));
    Promise.all([mine.length ? revealSecrets(entry, mine) : {}, entry && theirs.length ? revealSecrets("", theirs) : {}])
      .then(([a, b]) => { if (alive) setValues({ ...b, ...a }); }, (err) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [entry, [...shown].join("\n"), state.secretsVersion]);
  const toggle = (n) => setShown((was) => {
    const next = new Set(was);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    return next;
  });
  const allShown = showable.length > 0 && showable.every((n) => shown.has(n));

  const save = (n, v, action) => act(async () => {
    if (n === JEV) throw new Error("JEV_API_KEY is System One's key: set it in Connection → System One.");
    if (!NAME.test(n)) throw new Error(NAME_RULE);
    await keepSecrets(entry, { [n]: v }, { action });
  });
  // Its own as text, edited as a whole: saved, they're its secrets (a name taken out forgotten; System
  // One's key, which isn't shown here, kept)
  const editAll = () => act(async () => {
    const all = await revealSecrets(entry, own);
    setEditing({ value: envText(Object.fromEntries(own.filter((n) => Object.hasOwn(all, n)).map((n) => [n, all[n]]))), code: true, spellcheck: false });
  });
  const saveAll = (text) => act(async () => {
    const read = readEnvFile(text, file, { secret: true });
    if (JEV in read) throw new Error(`${file}: JEV_API_KEY is System One's key: set it in Connection → System One. Nothing was changed.`);
    const gone = Object.fromEntries(own.filter((n) => !Object.hasOwn(read, n) || read[n] === "").map((n) => [n, ""]));
    const kept = Object.fromEntries(Object.entries(read).filter(([, v]) => v !== ""));
    await keepSecrets(entry, { ...gone, ...kept });
  });
  // Globals' name in the add row, its value focused: the scope's own value of it
  const override = (n) => {
    setName(n);
    setTimeout(() => document.getElementById("secretValue")?.focus(), 0);
  };
  // The names secrets are kept for that aren't scopes now (they don't make one: a scope made with one's
  // name has them again)
  const envs = scopeNames(state);
  const goneNames = {};
  for (const map of [stored, state.secretsUnreadable]) for (const [scope, names] of Object.entries(map)) if (scope && !envs.includes(scope)) goneNames[scope] = [...new Set([...(goneNames[scope] ?? []), ...names])];
  const gone = Object.entries(goneNames).filter(([, names]) => names.length).sort(([a], [b]) => a.localeCompare(b));
  const note = storageNote(state.secretsStorage);

  return (
    <>
      {note && <p className="note" id="secretsNote">{note}</p>}
      <div className="scope-panes">
        <ScopeList pane="secrets" entry={entry} onShow={show} onRename={() => setRenameAsk((n) => n + 1)} act={act} unset={(scope) => unsetIn(scope).length} />
        <section className="scope-main" aria-label={entry ? `The secrets of ${entry}` : "Globals' secrets"}>
          <ScopeHead pane="secrets" entry={entry} onShow={show} onRename={() => setRenameAsk((n) => n + 1)} renameAsk={renameAsk} act={act} />
          <div className="scope-tools">
            <button className="btn" id="secretsImport" type="button" onClick={() => fileRef.current?.click()}>import .env</button>
            <ConfirmButton className="btn" id="secretsExport" label="export .env" question="write them in plain text?" disabled={!own.length} title={`Write ${file}, in plain text`}
                           onConfirm={() => act(() => exportSecrets(entry))} />
            <button className="btn" id="secretsText" type="button" onClick={editAll}>edit as .env</button>
            <SearchField id="secretsSearch" label="Search secrets" placeholder="Search secrets" value={query} onChange={setQuery} />
          </div>
          <p className="hint error" id="secretsError" role="alert" hidden={!error}>{error}</p>
          <div className="vars" id="secretsList" role="table" aria-label={entry ? `Secrets of ${entry}` : "Globals' secrets"}>
            <VarsHead name="Name" extra={showable.length > 0 && <button className="btn" id="secretsRevealAll" type="button" onClick={() => setShown(allShown ? new Set() : new Set(showable))}>{allShown ? "hide all" : "show all"}</button>} />
            {visible.map((row) => (
              <SecretRow key={`${entry}-${row.name}`} row={row} version={state.secretsVersion} used={used.has(row.name)} value={shown.has(row.name) ? values[row.name] : undefined}
                         shown={shown.has(row.name)} onToggle={() => toggle(row.name)} onSave={(v) => save(row.name, v)} onOverride={() => override(row.name)}
                         sourceText={row.unreadable ? "can't be read here: set it again" : sourceText(row.source, { scope: entry, overriddenIn: entry ? [] : envs.filter((s) => (stored[s] ?? []).includes(row.name)) })} />
            ))}
            {!visible.length && <p className="note vars-none" id="secretsEmpty">{query.trim() ? `No secrets match "${query.trim()}".` : "The open files don't use any secrets yet: add one below, or import a .env file."}</p>}
            {/* (Enter adds it: with no name or no value yet, it goes to the one that's missing) */}
            <form className="vars-row vars-add" role="row" id="secretAdd" onSubmit={async (e) => {
              e.preventDefault();
              if (!name.trim()) return document.getElementById("secretName")?.focus();
              if (!value) return document.getElementById("secretValue")?.focus();
              if (!(await save(name.trim(), value))) return undefined;
              setName("");
              setValue("");
              return document.getElementById("secretName")?.focus();
            }}>
              <span role="cell"><input className="input" id="secretName" type="text" placeholder="New secret" aria-label="Name" autoComplete="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={enterAdds} /></span>
              <span role="cell"><input className="input" id="secretValue" type="password" placeholder="its value, then Enter" aria-label="Value" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={enterAdds} /></span>
              <span role="cell"></span>
            </form>
          </div>
          <input ref={fileRef} id="secretsImportFile" type="file" accept=".env,text/plain" hidden onChange={async (e) => {
            const picked = e.target.files?.[0];
            e.target.value = "";
            if (!picked) return;
            let count = 0;
            const ok = await act(async () => {
              const read = readEnvFile(await picked.text(), picked.name, { secret: true });
              if (JEV in read) throw new Error(`${picked.name}: JEV_API_KEY is System One's key: set it in Connection → System One. Nothing was changed.`);
              const kept = Object.fromEntries(Object.entries(read).filter(([, v]) => v !== ""));
              await keepSecrets(entry, kept, { action: "import" });
              count = Object.keys(kept).length;
            });
            if (ok) notify({ title: `Imported ${plural(count, "secret")} into ${entry || "Globals"}`, text: picked.name, kind: "ok" });
          }} />
          {given.length > 0 && <p className="hint" id="secretsFromFixtures">{`Given by a provider's fixture when a run starts, so not set here: ${given.join(", ")}`}</p>}
          {entry && (
            <div className="panel-foot">
              <ConfirmButton className="btn" id="secretsDelete" label="Delete scope" question="delete its values and secrets?" onConfirm={() => act(async () => { await deleteScope(entry); show(app.get().env ?? ""); })} />
            </div>
          )}
        </section>
      </div>
      {gone.length > 0 && (
        <>
          <div className="field-head"><span className="hint" id="goneScopesLabel">Secrets of scopes that no longer exist</span></div>
          <ul className="list settings-list" id="goneScopes" aria-labelledby="goneScopesLabel">
            {gone.map(([scope, names]) => (
              <li key={scope} className="settings-row" id={`goneScope-${scope}`}>
                <div className="settings-row-text">
                  <span className="settings-row-name">{scope}</span>
                  <span className="hint">{[...names].sort().join(", ")}</span>
                </div>
                <ConfirmButton className="btn" id={`goneScope-${scope}-delete`} aria-label={`Delete the secrets of ${scope}`} label="delete" question="delete its secrets?"
                               onConfirm={() => act(() => deleteGoneScopeSecrets(scope))} />
              </li>
            ))}
          </ul>
        </>
      )}
      {editing && <Editor field={editing} label={file} onClose={() => setEditing(null)} onSave={(next) => { saveAll(next); }} />}
    </>
  );
}

// A secret's row: its name over how a file uses it; its value, never shown until asked (a password
// field, ••••••••; inherited, as text), then show or hide, and forget (asking first) or override; where
// it's from.
// A new value typed in its field is kept when it's left, or on Enter; an empty one changes nothing (forget
// does that).
function SecretRow({ row, version, used, value, shown, onToggle, onSave, onOverride, sourceText: source }) {
  const { name } = row;
  const isSet = row.source !== "unset";
  const showing = shown && value !== undefined;
  const saved = showing ? value : "";
  return (
    <div className="vars-row" role="row" id={`secret-${name}`} data-source={row.source} data-shown={showing ? "" : undefined}>
      <span className="vars-key" role="cell">
        <span className="vars-name" title={name}>{name}</span>
        <span className="hint vars-use">{[`{{secret.${name}}}`, isSet && !used && "not used by the open files"].filter(Boolean).join(" · ")}</span>
      </span>
      <span className="vars-cell" role="cell">
        {row.source === "globals"
          ? <span className="vars-value" title={showing ? undefined : "Hidden: show shows it"}>{showing ? value : MASK}</span>
          /* (drawn afresh when what's kept changes: a value just saved isn't left in it) */
          : <input key={`${showing}-${saved}-${version}`} className="input" type={showing ? "text" : "password"} aria-label={`Value of ${name}`} defaultValue={saved}
                   placeholder={isSet && !row.unreadable ? MASK : "its value"} autoComplete="new-password" spellCheck={false}
                   onBlur={(e) => {
                     const next = e.target.value;
                     if (!next) { e.target.value = saved; return; }
                     if (next !== saved) onSave(next);
                   }}
                   onKeyDown={(e) => {
                     if (e.key === "Enter") e.currentTarget.blur();
                     if (e.key === "Escape" && e.currentTarget.value !== saved) { e.preventDefault(); e.stopPropagation(); e.currentTarget.value = saved; }
                   }} />}
        {isSet && !row.unreadable && <button className="btn vars-reveal" id={`secret-${name}-reveal`} type="button" aria-pressed={shown} aria-label={`${shown ? "Hide" : "Show"} ${name}`} onClick={onToggle}>{shown ? "hide" : "show"}</button>}
        {row.source === "globals" && <button className="btn" id={`secret-${name}-override`} type="button" title="A secret of this scope's own" onClick={onOverride}>override</button>}
        {(row.source === "own" || row.source === "override") && <ConfirmButton className="btn" id={`secret-${name}-forget`} aria-label={`Forget ${name}`} label="forget" question="forget it?" onConfirm={() => onSave("")} />}
      </span>
      <span className={`hint vars-source${row.unreadable ? " error" : ""}`} role="cell">{source}</span>
    </div>
  );
}
