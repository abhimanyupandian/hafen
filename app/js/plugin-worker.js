// A plugin's worker in the browser build: a Web Worker of its own (started by the engine's worker), the
// plugin loaded from its text as a module. It has nothing of the page's or the engine's.

import { servePlugin } from "../../engine/plugin-worker-core.js";

servePlugin({
  receive: (handler) => { self.onmessage = (e) => handler(e.data); },
  send: (message) => self.postMessage(message),
  importSource: (source) => {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    return import(/* @vite-ignore */ url).finally(() => URL.revokeObjectURL(url));
  },
});
