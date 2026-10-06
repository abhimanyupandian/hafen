// The engine, from the page: in the desktop app, a port to its utility process (desktop/engine-host.js,
// which runs the engine in Node, as CI does); in a browser, a Web Worker (worker.js). Either way the
// same commands and events (engine/serve-port.js).
//
//   const engine = await connectEngine();
//   await engine.call("open", { root }) → { suites, providers }
//   engine.on(token, (event) => …)      → stop listening

import { isApp } from "./lib/app.js";

let client = null;

// onRestart: called when the desktop app's engine was started again (after it stopped unexpectedly):
// calls waiting on the old one fail, and the page opens its folder again. onCall(cmd, args, {ok,
// error, value, ms}): each command, once it's answered; onLog(entry): a log the engine sent (its
// HTTP calls).
export async function connectEngine({ onRestart, onCall, onLog } = {}) {
  if (client) return client;
  const pending = new Map();
  const listeners = new Map();  // token -> Set(handler)
  let next = 1;
  let port = isApp ? await desktopPort((fresh) => {
    for (const waiting of pending.values()) waiting.reject(new Error("the engine stopped and was started again"));
    pending.clear();
    attach(fresh);
    onRestart?.();
  }) : workerPort();
  const attach = (p) => {
    port = p;
    p.onmessage = receive;
  };
  const receive = (e) => {
    const m = e.data;
    if (m?.log) {
      onLog?.(m.log);
      return;
    }
    if (m?.event) {
      for (const handler of listeners.get(m.token) ?? []) handler(m.event);
      return;
    }
    const waiting = pending.get(m?.id);
    if (!waiting) return;
    pending.delete(m.id);
    if (m.ok) waiting.resolve(m.value);
    else waiting.reject(new Error(m.error));
  };
  attach(port);
  client = {
    call(cmd, args = {}) {
      const id = next++;
      const t0 = performance.now();
      const done = (ok, value, error) => { try { onCall?.(cmd, args, { ok, value, error, ms: performance.now() - t0 }); } catch {} };
      return new Promise((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => { done(true, value); resolve(value); },
          reject: (err) => { done(false, undefined, err.message); reject(err); },
        });
        port.postMessage({ id, cmd, args });
      });
    },
    on(token, handler) {
      if (!listeners.has(token)) listeners.set(token, new Set());
      listeners.get(token).add(handler);
      return () => listeners.get(token)?.delete(handler);
    },
  };
  return client;
}

function workerPort() {
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  return {
    postMessage: (m) => worker.postMessage(m),
    set onmessage(fn) { worker.onmessage = fn; },
  };
}

// The port the desktop app hands the page (desktop/preload.cjs forwards it with window.postMessage);
// a later one (the engine started again) goes to `onLater`
function desktopPort(onLater) {
  return new Promise((resolve) => {
    let first = true;
    window.addEventListener("message", (e) => {
      if (e.data !== "hafen:port" || !e.ports?.[0]) return;
      const port = e.ports[0];
      port.start?.();
      if (first) {
        first = false;
        resolve(port);
      } else onLater(port);
    });
    window.hafen.invoke("engine_port").catch(() => {});
  });
}

// A token for a run or a conversation, so its events find their way back
export const newToken = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
