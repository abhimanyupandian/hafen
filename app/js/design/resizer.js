// A handle that resizes something: drag it, or focus it and use the arrow keys (Shift for bigger
// steps, Home and End for the smallest and largest). A double-click puts back the default size.
// The size is remembered under `key`. For screen readers it's a separator with a value.
//
//   makeResizable(handle, { key, label, initial, min, max, apply, axis: "x" | "y", direction })
//
// min() and max() are read each time (they can follow the window). `direction` is 1 when dragging
// right or down makes it bigger, -1 when left or up does.

import { store } from "../lib/store.js";

export function makeResizable(handle, { key, label, initial, min, max, apply, axis = "x", direction = 1 }) {
  let size = Number(store.get(key)) || initial;
  const clamp = (value) => Math.round(Math.max(min(), Math.min(max(), value)));
  const set = (value) => {
    size = clamp(value);
    apply(size);
    handle.setAttribute("aria-valuenow", size);
    handle.setAttribute("aria-valuemin", Math.round(min()));
    handle.setAttribute("aria-valuemax", Math.round(max()));
  };
  const save = () => (size === initial ? store.remove(key) : store.set(key, String(size)));

  Object.assign(handle, { tabIndex: 0, title: `Drag to resize ${label} (double-click resets)` });
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", axis === "x" ? "vertical" : "horizontal");
  handle.setAttribute("aria-label", `Resize ${label}`);

  const at = (e) => (axis === "x" ? e.clientX : e.clientY);
  let start = null;
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    start = { at: at(e), size };
    document.documentElement.classList.add(`resizing-${axis}`);
  });
  handle.addEventListener("pointermove", (e) => { if (start) set(start.size + (at(e) - start.at) * direction); });
  const end = () => {
    if (!start) return;
    start = null;
    document.documentElement.classList.remove(`resizing-${axis}`);
    save();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("dblclick", () => { set(initial); save(); });
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 64 : 16;
    const keys = axis === "x"
      ? { ArrowRight: size + step * direction, ArrowLeft: size - step * direction }
      : { ArrowDown: size + step * direction, ArrowUp: size - step * direction };
    const next = keys[e.key] ?? { Home: min(), End: max() }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    set(next);
    save();
  });
  window.addEventListener("resize", () => set(size));
  set(size);
  return { set, reset: () => { set(initial); save(); } };
}
