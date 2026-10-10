// A section that its .collapsible-toggle button opens and closes. It starts open or closed as
// `defaultOpen` says until the user toggles it, which is remembered per section id. onToggle(open)
// runs once it has drawn opened or closed, like <details>' toggle event.
//
//   <section class="section collapsible open" id="…">
//     <div class="section-head collapsible-head"><button class="collapsible-toggle">…</button> …</div>
//     <div class="section-body collapsible-body">…</div>
//   </section>

import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { KEYS, store } from "../lib/store.js";

export function useCollapsible(id, defaultOpen, onToggle) {
  const [open, setOpen] = useState(() => {
    const saved = store.get(KEYS.section(id));
    return saved ? saved === "open" : defaultOpen;
  });
  const now = useRef(open);
  now.current = open;
  const toggle = () => {
    store.set(KEYS.section(id), now.current ? "closed" : "open");
    flushSync(() => setOpen(!now.current));
  };
  const drawn = useRef(false);
  useLayoutEffect(() => {
    if (drawn.current) onToggle?.(open);
    drawn.current = true;
  }, [open]);
  return [open, toggle];
}

// A sidebar section: `name` names its toggle (#<name>Toggle) and label (#<name>Label); `actions`
// go in its head after the toggle (or actions(open): ones that show only while it's open). With `icon` (an Addition), a closed section shows its icon where
// the arrow is, and an open one the arrow.
export function NavSection({ id, name, label, bodyId, defaultOpen = false, actions, onToggle, icon, children }) {
  const [open, toggle] = useCollapsible(id, defaultOpen, onToggle);
  return (
    <section className={"section collapsible" + (open ? " open" : "")} id={id} aria-labelledby={`${name}Label`}>
      <div className="section-head collapsible-head">
        <button className="collapsible-toggle" id={`${name}Toggle`} type="button" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
          {icon && !open
            ? <span className="section-icon" aria-hidden="true">{icon}</span>
            : <span className="chev" aria-hidden="true"></span>}
          <span className="label" id={`${name}Label`}>{label}</span>
        </button>
        {typeof actions === "function" ? actions(open) : actions}
      </div>
      <div className="section-body collapsible-body" id={bodyId}>{children}</div>
    </section>
  );
}

// A part of a Settings pane that opens and closes, as a sidebar section does (an Addition: Settings
// sections), remembered by its id the same way. `name` names its toggle (#<name>Toggle), label, summary
// and body (#<name>Body). While it's closed, its head says what's in it (`summary`; with `problem`,
// in --danger). Its body stays in the page while it's closed, only not shown.
export function SettingsSection({ id, name, label, summary, problem = false, defaultOpen = false, children }) {
  const [open, toggle] = useCollapsible(id, defaultOpen);
  return (
    <section className={"settings-section collapsible" + (open ? " open" : "")} id={id} aria-labelledby={`${name}Label`}>
      <div className="settings-section-head collapsible-head">
        <button className="collapsible-toggle" id={`${name}Toggle`} type="button" aria-expanded={open} aria-controls={`${name}Body`} onClick={toggle}>
          <span className="chev" aria-hidden="true"></span>
          <span className="label" id={`${name}Label`}>{label}</span>
          {!open && summary && <span className={`hint settings-section-summary${problem ? " error" : ""}`} id={`${name}Summary`}>{summary}</span>}
        </button>
      </div>
      <div className="settings-section-body collapsible-body" id={`${name}Body`}>{children}</div>
    </section>
  );
}

// A group of a pane's settings under its name, a line above it (an Addition: Settings groups): the
// part of a Settings pane that doesn't close, beside SettingsSection. `state`: what it says about them
// all, at the right of its name
export const SettingsGroup = ({ id, label, state, children }) => (
  <section className="settings-block" id={id} aria-labelledby={`${id}Label`}>
    <div className="settings-block-head"><h3 className="label" id={`${id}Label`}>{label}</h3>{state}</div>
    {children}
  </section>
);

// Open a section from code (`name`, as its toggle's id has it), as a click on its toggle would; nothing
// when it's open already
export function openSection(name) {
  const toggle = document.getElementById(`${name}Toggle`);
  if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
}
