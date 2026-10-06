// A plugin's worker in Node (the CLI, the desktop app's engine): worker_threads, started with no
// environment (process.env is empty here), the plugin loaded from its text as a module.

import { parentPort } from "node:worker_threads";
import { servePlugin } from "./plugin-worker-core.js";

servePlugin({
  receive: (handler) => parentPort.on("message", handler),
  send: (message) => parentPort.postMessage(message),
  importSource: (source) => import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`),
});
