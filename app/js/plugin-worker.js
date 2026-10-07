// A plugin's worker in the browser build: a Web Worker of its own (started by the engine's worker), the
// plugin loaded from its text as a module. It has nothing of the page's or the engine's. A page can't
// resolve what a plugin imports from the folder, so here a plugin is one module (the desktop app and
// the CLI load it from its file, imports and all).

import { servePlugin } from "../../engine/plugin-worker-core.js";

servePlugin({
  receive: (handler) => { self.onmessage = (e) => handler(e.data); },
  send: (message) => self.postMessage(message),
  importSource: (source) => {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    return import(/* @vite-ignore */ url)
      .catch((err) => {
        const spec = String(err?.message ?? "").match(/specifier ["']?([^"'\s]+)/)?.[1];
        throw /resolve module specifier|Failed to fetch dynamically imported module|Cannot find module/i.test(String(err?.message))
          ? new Error(`it imports ${spec ?? "another file"}, and the browser build loads a plugin as one module: use the desktop app or the CLI, or bundle it`)
          : err;
      })
      .finally(() => URL.revokeObjectURL(url));
  },
});
