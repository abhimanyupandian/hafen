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
