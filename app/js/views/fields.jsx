// Parts of a form, as the panel and Settings draw them (the design system's fields): a field's head,
// facts, a box of text, problems, and a text field that saves on blur.

import { useEffect, useRef, useState } from "react";
import { MaxButton } from "../design/editor.jsx";
import { oldWay } from "hafen/engine/vars.js";
import { useStore } from "../design/hooks.js";
import { app } from "../state.js";
import { hasValue, referencesIn } from "./references.js";

// What's wrong with what a text takes from the scope chosen now (references.js): an old way to write
// one (${env:NAME}, {{scope.NAME}}: what to write instead, as the engine says it, which fills in
// neither), an {{env.NAME}} its values haven't got, a {{secret.NAME}} neither it nor every scope has a
// secret for (or a fixture gives), or a scope needed and none chosen. "" when nothing is. As the engine
// looks: the scope's values, then a suite's environment of its name (any open suite's: a field doesn't
// always know which suite it's for).
export function scopeProblem(text, { env, scopes = [], scopeSecrets = {}, plugins = [], suites = [] } = {}) {
  const refs = referencesIn(text);
  if (!refs.length) return "";
  const old = refs.find((r) => r.kind === "old");
  if (old) return oldWay(old.way, old.name);
  const own = scopes.find((s) => s.name === env)?.values ?? {};
  const fromSuites = env ? suites.map((s) => s.data?.environments?.[env]).filter((e) => e && typeof e === "object") : [];
  const values = Object.assign({}, ...fromSuites, own);
  const secrets = new Set([...(scopeSecrets[env ?? ""] ?? []), ...(scopeSecrets[""] ?? []), ...plugins.filter((p) => p.kind === "fixture").flatMap((p) => p.provides ?? [])]);
  const missing = { env: [], secret: [] };
  for (const r of refs) {
    const ok = r.kind === "env" ? !!env && hasValue(values, r.name) : secrets.has(r.name);
    if (!ok && !missing[r.kind].includes(r.name)) missing[r.kind].push(r.name);
  }
  const list = (kind, names) => names.map((n) => `{{${kind}.${n}}}`).join(", ");
  const are = (names) => (names.length === 1 ? "isn't" : "aren't");
  const them = (names) => (names.length === 1 ? "it" : "them");
  if (missing.env.length) {
    if (!env) return `${list("env", missing.env)} ${missing.env.length === 1 ? "needs" : "need"} a scope: choose one in Settings → Environments`;
    return `${list("env", missing.env)} ${are(missing.env)} in the scope "${env}": add ${them(missing.env)} in Settings → Environments`;
  }
  if (missing.secret.length) {
    return env
      ? `${list("secret", missing.secret)} ${are(missing.secret)} a secret of the scope "${env}" (or of every scope): add ${them(missing.secret)} in Settings → Secrets`
      : `${list("secret", missing.secret)} ${are(missing.secret)} set for every scope, and no scope is chosen: add ${them(missing.secret)} in Settings → Secrets`;
  }
  return "";
}

// The problem, under a field: shown as it's typed
export function ScopeProblem({ id, value }) {
  const state = useStore(app);
  const problem = scopeProblem(value, state);
  return problem ? <p className="hint error field-problem" id={id} role="alert">{problem}</p> : null;
}

export const FieldHead = ({ label, htmlFor, actions, id }) => (
  <div className="field-head">
    {htmlFor ? <label className="hint" htmlFor={htmlFor}>{label}</label> : <span className="hint" id={id}>{label}</span>}
    {actions && <span className="field-actions">{actions}</span>}
  </div>
);

export const Facts = ({ facts, id, className = "" }) => {
  const list = facts.filter((f) => f && f[1] !== undefined && f[1] !== null && f[1] !== "");
  if (!list.length) return null;
  return <dl className={`trace-facts ${className}`} id={id}>{list.flatMap(([k, v]) => [<dt key={`${k}-k`}>{k}</dt>, <dd key={k}>{v}</dd>])}</dl>;
};

export const Pre = ({ value, id, className = "" }) => <pre className={`panel-output ${className}`} id={id} tabIndex={0}>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>;

// file: the file shown (a problem of another, a provider file the suite uses, says which)
export const Problems = ({ problems, file }) => (problems?.length ? (
  <>
    <FieldHead label="Problems" />
    <ul className="problems" role="alert">{problems.map((p, i) => <li key={i}>{`${p.file && file && p.file !== file ? `${p.file}${p.line ? `:${p.line}` : ""}: ` : p.line ? `line ${p.line}: ` : ""}${p.message}`}</li>)}</ul>
  </>
) : null);

// A text field that saves on blur (or ⌘/Ctrl+Enter in the large editor), as the design system's fields do
// What it takes from the scope ({{env.NAME}}, {{secret.NAME}}) is checked as it's typed (ScopeProblem,
// under it): it can use the chosen scope's values and secrets anywhere. problem: why what's in it wasn't saved, said under it (#<id>Error);
// onDraft(text): each change as it's typed.
export function TextField({ id, label, value, onSave, code = false, rows = 3, placeholder, single = false, problem = "", onDraft }) {
  const ref = useRef(null);
  const latest = useRef(value);
  latest.current = value;
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current) {
      ref.current.value = value ?? "";
      setDraft(value ?? "");
    }
  }, [value]);
  // A one-line field shows what's saved once it's done with: a value it refused (empty, say) goes back.
  // (A save that fails says so itself, as editSuite does; it's not left unhandled here.)
  const settle = () => setTimeout(() => {
    if (single && ref.current && document.activeElement !== ref.current) {
      ref.current.value = latest.current ?? "";
      setDraft(latest.current ?? "");
    }
  }, 0);
  const save = () => {
    if ((ref.current.value ?? "") === (value ?? "")) return;
    Promise.resolve(onSave(ref.current.value)).catch(() => {}).finally(settle);
  };
  return (
    <>
      <FieldHead label={label} htmlFor={id} actions={!single && <MaxButton fieldRef={ref} fieldId={id} label={label} onSave={(text) => { ref.current.value = text; Promise.resolve(onSave(text)).catch(() => {}); }} />} />
      {single
        ? <input className="input" id={id} type="text" defaultValue={value ?? ""} placeholder={placeholder} ref={ref} onBlur={save} onInput={(e) => { setDraft(e.currentTarget.value); onDraft?.(e.currentTarget.value); }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} autoComplete="off" />
        : <textarea className={`textarea${code ? " textarea-code" : ""}`} id={id} rows={rows} defaultValue={value ?? ""} placeholder={placeholder} ref={ref} onBlur={save} onInput={(e) => { setDraft(e.currentTarget.value); onDraft?.(e.currentTarget.value); }} spellCheck={!code} />}
      {problem && <p className="hint error field-problem" id={`${id}Error`} role="alert">{problem}</p>}
      <ScopeProblem id={`${id}Problem`} value={draft} />
    </>
  );
}

// A number field that saves on blur or Enter, and shows the value it's given whenever it isn't being
// typed in (another test chosen, or the file edited elsewhere). An empty field saves `null`.
// valid(n): whether a value may be saved (null: emptied); one that may not goes back to the file's
export function NumberField({ id, label, value, onSave, min, max, step, valid = () => true }) {
  const ref = useRef(null);
  const shown = value === undefined || value === null ? "" : String(value);
  const latest = useRef(shown);
  latest.current = shown;
  useEffect(() => { if (ref.current && document.activeElement !== ref.current) ref.current.value = shown; }, [shown]);
  // Once saved (or refused), it shows what's in the file
  const settle = () => setTimeout(() => { if (ref.current && document.activeElement !== ref.current) ref.current.value = latest.current; }, 0);
  const save = () => {
    const raw = ref.current.value.trim();
    if (raw === shown) return;
    const n = raw === "" ? null : Number(raw);
    if ((n !== null && !Number.isFinite(n)) || !valid(n)) return settle();
    Promise.resolve(onSave(n)).catch(() => {}).finally(settle);
  };
  return (
    <div className="grow">
      <label className="hint" htmlFor={id}>{label}</label>
      <input className="input" id={id} type="number" min={min} max={max} step={step} defaultValue={shown} ref={ref} onBlur={save}
             onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
    </div>
  );
}
