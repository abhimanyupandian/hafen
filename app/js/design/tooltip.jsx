// A tooltip that a click opens under an element: toggleTooltip(anchor, text). One shows at a
// time; a click anywhere else, Esc, scrolling or resizing closes it. <Tooltip /> draws it, at the
// end of <body>.

import { useLayoutEffect, useRef } from "react";
import { createPortal, flushSync } from "react-dom";
import { createStore, useStore } from "./hooks.js";

const tip = createStore({ anchor: null, text: "" });

function closeTooltip() {
  const { anchor } = tip.get();
  if (!anchor) return;
  anchor.removeAttribute("aria-describedby");
  flushSync(() => tip.set({ anchor: null, text: "" }));
}

export function toggleTooltip(anchor, text) {
  if (tip.get().anchor === anchor) return closeTooltip();
  closeTooltip();
  flushSync(() => tip.set({ anchor, text }));
}

export function Tooltip() {
  const { anchor, text } = useStore(tip);
  const ref = useRef(null);
  // Under the anchor, its left edge lined up with the anchor's, kept on screen
  useLayoutEffect(() => {
    if (!anchor) return;
    const el = ref.current;
    const box = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(box.left, innerWidth - el.offsetWidth - 8));
    el.style.left = `${left}px`;
    el.style.top = `${box.bottom + 6}px`;
    anchor.setAttribute("aria-describedby", el.id);
  }, [anchor, text]);
  if (!anchor) return null;
  return createPortal(<div className="tooltip" id="tooltip" role="tooltip" ref={ref}>{text}</div>, document.body);
}

// Close on a click outside the tooltip and its anchor (the anchor's own click toggles it).
document.addEventListener("click", (e) => {
  const { anchor } = tip.get();
  if (anchor && !anchor.contains(e.target) && !document.getElementById("tooltip")?.contains(e.target)) closeTooltip();
}, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeTooltip(); });
window.addEventListener("resize", closeTooltip);
document.addEventListener("scroll", closeTooltip, true);
