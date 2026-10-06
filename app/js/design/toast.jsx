// Notifications at the top right: notify({ title, text, kind, sound, onClick, system }) slides one in,
// with a sound if asked (lib/sound.js), and it slides out after a few seconds of being seen, or when
// clicked (doing onClick first: one with it says so, and points). `kind` is "ok" or "error" (its
// accent). <Toasts /> draws them, in the top layer (a popover), so they show above an open modal too.
// A page in the background (another tab; the desktop app's window behind others) doesn't run its
// animations, so one given then waits, and slides in on the way back; the system shows it then too
// (system: as given, else as Settings → Notifications says), silently: the sound is the page's.

import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { inFront, notifySettings, systemNotify } from "../lib/notifications.js";
import { chime } from "../lib/sound.js";
import { createStore, useStore } from "./hooks.js";

const SHOWN_MS = 5000;   // how long one stays
const LEAVE_MS = 250;    // its slide out (as in components.css)

const toasts = createStore({ list: [], added: 0 });
let nextId = 0;

function leave(id) {
  toasts.set(({ list }) => ({ list: list.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
  setTimeout(() => toasts.set(({ list }) => ({ list: list.filter((t) => t.id !== id) })), LEAVE_MS);
}

const seen = () => document.visibilityState === "visible";

// Its few seconds start once the page can be seen
function leaveLater(id) {
  if (seen()) return setTimeout(() => leave(id), SHOWN_MS);
  document.addEventListener("visibilitychange", function shown() {
    if (!seen()) return;
    document.removeEventListener("visibilitychange", shown);
    setTimeout(() => leave(id), SHOWN_MS);
  });
}

export function notify({ title, text = "", kind = "", sound, onClick, system }) {
  const id = nextId++;
  toasts.set(({ list, added }) => ({ list: [...list, { id, title, text, kind, onClick, leaving: false }], added: added + 1 }));
  if (sound) chime(sound);
  if (system ?? (notifySettings().system && !inFront())) systemNotify({ title, text, onClick });
  leaveLater(id);
}

export function Toasts() {
  const { list, added } = useStore(toasts);
  const ref = useRef(null);
  // Shown while there are any; shown again as one comes in while a modal is open, to be above it
  useLayoutEffect(() => {
    const layer = ref.current;
    if (!layer?.showPopover) return;
    const shown = layer.matches(":popover-open");
    if (shown && (!list.length || document.querySelector("dialog:modal"))) layer.hidePopover();
    if (list.length && !layer.matches(":popover-open")) layer.showPopover();
  }, [added, list.length > 0]);
  return createPortal(
    <div className="toasts" id="toasts" popover="manual" ref={ref} aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast${t.kind ? ` ${t.kind}` : ""}${t.leaving ? " leaving" : ""}${t.onClick ? " clickable" : ""}`} role="status"
             title={t.onClick ? "Open it" : undefined} onClick={() => { t.onClick?.(); leave(t.id); }}>
          <span className="toast-title">{t.title}</span>
          {t.text && <span className="toast-text">{t.text}</span>}
        </div>
      ))}
    </div>,
    document.body);
}
