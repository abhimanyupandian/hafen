// A read-only field that shows an _id, with a button to copy it: <IdField id label value />.

import { useState } from "react";
import { copyText } from "../lib/clipboard.js";
import { Icon } from "./icons.jsx";

export function IdField({ id, label, value = "" }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    if (!(await copyText(value))) return;
    setDone(true);
    setTimeout(() => setDone(false), 1200);
  };
  return (
    <div className="id-field">
      <label className="hint" htmlFor={id}>{label}</label>
      <input className="input input-id" id={id} type="text" readOnly value={value} aria-label={label} />
      <button type="button" className={"btn btn-ghost btn-icon" + (done ? " done" : "")} id={`${id}Copy`} aria-label={`Copy ${label}`} title="Copy" onClick={copy}>
        <Icon name="copy" size={14} />
      </button>
    </div>
  );
}
