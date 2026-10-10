// A context menu (an Addition: spec/design/components.md, Context menu): opened at the pointer by a
// right-click, or under a control from the keyboard (the menu key, Shift+F10). Its items are buttons:
// ↑/↓ move between them, Enter or a click picks one, Esc, Tab, a click elsewhere, the window resized
// or left close it. (Not a scroll: the thread scrolls by itself while a run streams.) An item with `confirm` asks first: its first pick changes its label to the question, the
// second does it. <ContextMenu /> is drawn once, in the page; opened while a modal is open (Settings),
// it's drawn inside the modal's dialog, which is in the top layer: anywhere else, it would be under the
// modal, and couldn't be used.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createStore, useStore } from "./hooks.js";

// open: { x, y, label, items: [{ id, label, hint?, onPick, danger?, confirm?, disabled? } | "-"] }
const menu = createStore({ open: null });
let returnFocus = null;

// From an event: at the pointer, or (from the keyboard) under the element it came from
export function openMenu(e, { label, items }) {
  e.preventDefault?.();
  e.stopPropagation?.();
  let x = e.clientX;
  let y = e.clientY;
  if (!x && !y && e.currentTarget?.getBoundingClientRect) {
    const r = e.currentTarget.getBoundingClientRect();
    x = r.left;
    y = r.bottom;
  }
  returnFocus = document.activeElement;
  menu.set({ open: { x, y, label, items, inside: document.querySelector("dialog[open]:modal") ?? document.body } });
}

export const closeMenu = () => {
  if (!menu.get().open) return;
  menu.set({ open: null });
  returnFocus?.focus?.();
  returnFocus = null;
};

export function ContextMenu() {
  const { open } = useStore(menu);
  const ref = useRef(null);
  const [asking, setAsking] = useState(null);  // the id of an item asking to be picked again
  const [at, setAt] = useState({ x: 0, y: 0 });

  // Kept inside the window, then the first item focused
  useLayoutEffect(() => {
    setAsking(null);
    if (!open || !ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    setAt({ x: Math.max(4, Math.min(open.x, innerWidth - width - 4)), y: Math.max(4, Math.min(open.y, innerHeight - height - 4)) });
    ref.current.querySelector("button:not(:disabled)")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) closeMenu(); };
    const gone = () => closeMenu();
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", gone);
    window.addEventListener("blur", gone);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", gone);
      window.removeEventListener("blur", gone);
    };
  }, [open]);

  if (!open) return null;
  const keydown = (e) => {
    const buttons = [...ref.current.querySelectorAll("button:not(:disabled)")];
    const now = buttons.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); buttons[(now + 1) % buttons.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); buttons[(now - 1 + buttons.length) % buttons.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); buttons[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); buttons.at(-1)?.focus(); }
    else if (e.key === "Tab") { e.preventDefault(); closeMenu(); }
  };
  return createPortal(
    <div className="context-menu" id="contextMenu" role="menu" aria-label={open.label} ref={ref} style={{ left: at.x, top: at.y }} onKeyDown={keydown}
         onContextMenu={(e) => e.preventDefault()}>
      {open.items.map((item, i) => (item === "-"
        ? <div key={`-${i}`} className="context-menu-line" role="separator"></div>
        : (
          <button key={item.id} type="button" role="menuitem" id={`menu-${item.id}`} disabled={item.disabled}
                  className={`context-menu-item${item.danger ? " danger" : ""}${asking === item.id ? " confirm" : ""}`}
                  onClick={() => {
                    if (item.confirm && asking !== item.id) {
                      setAsking(item.id);
                      return;
                    }
                    closeMenu();
                    item.onPick();
                  }}>
            <span>{asking === item.id ? item.confirm : item.label}</span>
            {item.hint && <span className="hint">{item.hint}</span>}
          </button>
        )))}
    </div>,
    open.inside.isConnected ? open.inside : document.body);
}
