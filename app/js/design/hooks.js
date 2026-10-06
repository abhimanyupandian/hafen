// React helpers for state that lives outside React. The services keep their data in their modules
// and say when it changes on the event bus (lib/events.js); a store holds what a part of the page
// shows, so code outside React can change it and the components that show it draw again.

import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { on } from "../lib/events.js";

// createStore(initial) → { get, set(changes | (state) => changes), subscribe }
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set(changes) {
      state = { ...state, ...(typeof changes === "function" ? changes(state) : changes) };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const useStore = (store) => useSyncExternalStore(store.subscribe, store.get);

// A store that only counts: draw() has the components that use it draw again, from data they
// read from its module.
export function createDraw() {
  const store = createStore({ n: 0 });
  return { ...store, draw: () => store.set(({ n }) => ({ n: n + 1 })) };
}
export const useDraw = (draw) => useStore(draw).n;

// Draw again whenever this bus event fires (lib/events.js).
export function useEvent(name) {
  const [, redraw] = useReducer((n) => n + 1, 0);
  useEffect(() => on(name, redraw), [name]);
}

// The time now, again every `ms` (so "2 mins ago" stays right while it's shown)
export function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
