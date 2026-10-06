// Parts of a form, as the panel and Settings draw them (the design system's fields): a field's head,
// facts, a box of text, problems, and a text field that saves on blur.

import { useEffect, useRef, useState } from "react";
import { MaxButton } from "../design/editor.jsx";
import { useStore } from "../design/hooks.js";
import { app } from "../state.js";

const SCOPE_REF = /\{\{\s*scope\.([A-Za-z_][\w.-]*)\s*\}\}/g;

// What's wrong with a text's {{scope.NAME}}s, for the scope chosen now: a name its variables and its
// secrets (or every scope's) don't have, or no scope chosen. "" when nothing is.
export function scopeProblem(text, { env, scopes = [], scopeSecrets = {} } = {}) {
  const names = [...new Set([...String(text ?? "").matchAll(SCOPE_REF)].map((m) => m[1]))];
  if (!names.length) return "";
  if (!env) return `{{scope.${names[0]}}} needs a scope: choose one in Settings → Environments`;
  const values = scopes.find((s) => s.name === env)?.values ?? {};
  const secrets = new Set([...(scopeSecrets[env] ?? []), ...(scopeSecrets[""] ?? [])]);
  const has = (name) => {
    if (Object.prototype.hasOwnProperty.call(values, name) || secrets.has(name)) return true;
    let v = values;
    for (const part of name.split(".")) {
      if (v === null || typeof v !== "object" || !Object.prototype.hasOwnProperty.call(v, part)) return false;
      v = v[part];
    }
    return true;
  };
  const missing = names.filter((n) => !has(n));
  if (!missing.length) return "";
  return `${missing.map((n) => `{{scope.${n}}}`).join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} in the scope "${env}": add ${missing.length === 1 ? "it" : "them"} in Settings → Environments (or Secrets)`;
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

export const Problems = ({ problems }) => (problems?.length ? (
  <>
    <FieldHead label="Problems" />
    <ul className="problems" role="alert">{problems.map((p, i) => <li key={i}>{`${p.line ? `line ${p.line}: ` : ""}${p.message}`}</li>)}</ul>
  </>
) : null);

// A text field that saves on blur (or ⌘/Ctrl+Enter in the large editor), as the design system's fields do
// Its {{scope.NAME}}s are checked as it's typed (ScopeProblem, under it): it can use the chosen scope's
// variables and secrets anywhere.
export function TextField({ id, label, value, onSave, code = false, rows = 3, placeholder, single = false }) {
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
        ? <input className="input" id={id} type="text" defaultValue={value ?? ""} placeholder={placeholder} ref={ref} onBlur={save} onInput={(e) => setDraft(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} autoComplete="off" />
        : <textarea className={`textarea${code ? " textarea-code" : ""}`} id={id} rows={rows} defaultValue={value ?? ""} placeholder={placeholder} ref={ref} onBlur={save} onInput={(e) => setDraft(e.currentTarget.value)} spellCheck={!code} />}
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
