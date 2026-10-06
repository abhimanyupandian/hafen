// A check as a card (spec/design/components.md, Additions: Check card): the sidebar's palette card,
// coloured by how the check last went. Its head names its kind (an icon and a label) and says its
// status; under it, what it checks and why it went as it did. In a turn's list it opens the check, and
// has its own on/off box and ×; as a check's last result it only shows.
//
//   <CheckCard id check result onOpen onToggle onDelete />   result: { status, name, reason, confidence } or null

import { useRef, useState } from "react";
import { ConfirmButton } from "../design/confirm.jsx";
import { Icon } from "../design/icons.jsx";
import { describeCheck } from "./derive.js";
import { isOn, kindOf } from "./check-types.js";

const WORDS = { pass: "pass", fail: "fail", error: "error", unsure: "unsure", running: "running…", skipped: "skipped" };

// A check's on/off box: it shows what's asked for at once, and what the file says once it's saved (or
// what it said, if the save failed). onToggle(on) returns the save.
export function CheckOnBox({ id, on, onToggle, className = "check", title, children }) {
  const [asked, setAsked] = useState(null);
  const waiting = useRef(0);  // saves not done yet: what's asked shows until the last is
  return (
    <label className={className} title={title}>
      <input type="checkbox" id={id} checked={asked ?? on} onChange={(e) => {
        const next = e.target.checked;
        setAsked(next);
        waiting.current++;
        Promise.resolve(onToggle(next)).catch(() => {}).finally(() => { if (--waiting.current === 0) setAsked(null); });
      }} />
      <span>{children}</span>
    </label>
  );
}

export function CheckCard({ id, check, result, onOpen, onToggle, onDelete }) {
  const on = isOn(check);
  const kind = kindOf(check);
  const status = on ? result?.status ?? "" : "off";
  const word = on ? WORDS[status] ?? (status || "not run") : "off";
  const text = result?.name ?? describeCheck(check);
  const reason = on ? [result?.reason, result?.confidence !== undefined ? `confidence ${result.confidence}` : ""].filter(Boolean).join(" · ") : "Turned off: it's skipped when the test runs.";
  // A click anywhere on the card opens the check (but not one on its own controls)
  const open = (e) => {
    if (!onOpen || e.target.closest("button, input, label, a")) return;
    onOpen();
  };
  return (
    <li className={`check-card${onOpen ? " openable" : ""}`} id={id} data-status={status} onClick={open}>
      <div className="check-card-head">
        <span className="block-label"><Icon name="check" size={16} /><span className="label">{kind.name}</span></span>
        <span className="check-card-status" id={id && `${id}-status`}>{word}</span>
        {onToggle && (
          <CheckOnBox id={id && `${id}-on`} on={on} onToggle={onToggle} className="check check-card-on" title={on ? "Turn this check off: it's skipped when the test runs" : "Turn this check on"}>on</CheckOnBox>
        )}
        {onDelete && <ConfirmButton className="btn btn-ghost list-del" label="×" question="delete" aria-label={`Delete check ${describeCheck(check)}`} onConfirm={onDelete} />}
      </div>
      {onOpen
        ? <button type="button" className="check-card-text" id={id && `${id}-open`} aria-label={`${text}: ${word}`} onClick={onOpen}>{text}</button>
        : <span className="check-card-text">{text}</span>}
      {reason && <span className="check-card-reason">{reason}</span>}
    </li>
  );
}
