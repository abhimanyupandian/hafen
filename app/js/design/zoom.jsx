// Zoom for a canvas: −, the zoom level (click it for 100%) and + buttons, and Ctrl/⌘ + scroll (or
// a trackpad pinch) over the canvas, which zooms around the pointer. From MIN to MAX.
//
//   createZoom({ area, apply(next, previous, anchor), wheel }) → { get, set, reset, sync }
//   <Zoom zoom={…} id label groupLabel />
//
// `area()` is the element scrolled over; `apply` does the zooming (the canvas decides how), keeping
// `anchor` ({x, y} on screen: the pointer, or the middle of the area for the buttons) where it is.
// A canvas that zooms with the wheel itself (wheel: false) says so with sync(zoom), for the buttons.

import { useLayoutEffect } from "react";
import { createStore, useStore } from "./hooks.js";
import { Icon } from "./icons.jsx";

export const MIN = 0.25;
export const MAX = 2;
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export function createZoom({ area, apply, wheel: ownWheel = true }) {
  let zoom = 1;
  const store = createStore({ zoom });
  const middle = () => {
    const box = area().getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };
  const set = (next, anchor = middle()) => {
    next = Math.min(MAX, Math.max(MIN, Math.round(next * 100) / 100));
    const previous = zoom;
    zoom = next;
    if (next !== previous) apply(next, previous, anchor);
    store.set({ zoom });
  };
  const wheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;  // plain scrolling moves around
    e.preventDefault();                    // not the browser's page zoom
    if (e.buttons) return;                 // not in the middle of a drag
    set(zoom * Math.exp(-e.deltaY * 0.0025), { x: e.clientX, y: e.clientY });
  };
  const sync = (next) => {
    zoom = next;
    if (store.get().zoom !== next) store.set({ zoom });
  };
  return {
    get: () => zoom, set, reset: () => set(1), store, area, wheel: ownWheel ? wheel : null, sync,
    out: () => set(STEPS.findLast((s) => s < zoom - 0.001) ?? MIN),
    in: () => set(STEPS.find((s) => s > zoom + 0.001) ?? MAX),
  };
}

export function Zoom({ zoom, id, label, groupLabel }) {
  const { zoom: level } = useStore(zoom.store);
  useLayoutEffect(() => {
    if (!zoom.wheel) return undefined;
    const area = zoom.area();
    area.addEventListener("wheel", zoom.wheel, { passive: false });
    return () => area.removeEventListener("wheel", zoom.wheel);
  }, []);
  const percent = Math.round(level * 100);
  return (
    <div className="zoom" id={id} role="group" aria-label={groupLabel}>
      <button type="button" className="btn btn-ghost btn-icon" id={`${id}Out`} aria-label={`Zoom ${label} out`} title="Zoom out"
              disabled={level <= MIN} onClick={() => zoom.out()}><Icon name="minus" size={14} /></button>
      <button type="button" className="btn btn-ghost zoom-level" id={`${id}Level`} title="Back to 100%"
              aria-label={`${label} zoom ${percent}%: back to 100%`} onClick={() => zoom.set(1)}>{`${percent}%`}</button>
      <button type="button" className="btn btn-ghost btn-icon" id={`${id}In`} aria-label={`Zoom ${label} in`} title="Zoom in"
              disabled={level >= MAX} onClick={() => zoom.in()}><Icon name="plus" size={14} /></button>
    </div>
  );
}
