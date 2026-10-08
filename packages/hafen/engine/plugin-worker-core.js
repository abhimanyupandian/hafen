// What a plugin's worker runs (contracts/provider.md, Code plugins): it loads one plugin module and
// answers the engine's calls to it, by messages. The plugin reaches the network through `transport`,
// whose requests the engine makes (to the plugin's hosts, filling in each {{secret.NAME}} and
// {{env.NAME}} in them as they leave), so the plugin never holds a secret's value. The worker's own
// fetch, WebSocket, XMLHttpRequest and EventSource are taken away first, so one used by mistake says
// so rather than going around the hosts. (That's no sandbox: a plugin is trusted code, and in Node it
// can still import node:http or read files. docs/plugins.md says so.)
// Platform-free: the Node and browser workers (plugin-worker-node.js, app/js/plugin-worker.js) give it
// their messaging and module loading.
//
//   engine → worker  { type: "load", id, source, url? }           → { type: "loaded", id, meta } | { type: "error", id, message }
//                    (url: its file, where the host has one: loaded from there, so its imports resolve)
//                    { type: "call", id, method, args }           → send: { type: "event", id, event }…, { type: "done", id }
//                                                                    check/judge/run: { type: "result", id, value }
//                                                                    (run: and sets, what it set with env.set)
//                    { type: "abort", id }
//                    { type: "fetch:res", fid, status, headers } { type: "fetch:chunk", fid, text } { type: "fetch:end", fid } { type: "fetch:error", fid, message }
//   worker → engine  { type: "fetch", fid, id, request }

import { NAME, NAME_RULE } from "./env-file.js";
import { FIXTURE_PHASES } from "./fixture-lists.js";

// The worker's own ways to the network: each, used, throws saying what to use instead
export const NETWORK_GLOBALS = ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"];
export const noNetwork = (name) => `a plugin has no ${name} (use transport.fetch: it's the one that reaches the plugin's hosts)`;
function withoutNetwork(scope = globalThis) {
  for (const name of NETWORK_GLOBALS) {
    // (a browser worker's are its prototype's: taken from there too, then shadowed here)
    for (let at = Object.getPrototypeOf(scope); at; at = Object.getPrototypeOf(at)) {
      if (Object.getOwnPropertyDescriptor(at, name)?.configurable) delete at[name];
    }
    const refuse = function refuse() { throw new Error(noNetwork(name)); };
    try {
      Object.defineProperty(scope, name, { value: refuse, writable: false, enumerable: false, configurable: false });
    } catch {}
  }
}

// A fixture's phases (contracts/provider.md, Fixtures): the lists it can be in, any of the four (all
// of them when it doesn't say). One that isn't a list of them: why, for its load to fail with.
export function phasesOf(plugin) {
  if (plugin.phases === undefined) return { phases: [...FIXTURE_PHASES] };
  const list = plugin.phases;
  const said = `its phases is a list of when it runs: any of ${FIXTURE_PHASES.join(", ")}`;
  if (!Array.isArray(list) || !list.length) return { error: `${said} (phases: ["beforeAll", "afterAll"])` };
  const odd = list.find((p) => !FIXTURE_PHASES.includes(p));
  if (odd !== undefined) return { error: `${said}, and ${JSON.stringify(odd)} isn't one` };
  // (in the lists' own order, each once)
  return { phases: FIXTURE_PHASES.filter((p) => list.includes(p)) };
}

// A fixture's env: the environment's values, as they are now, and set(NAME, value), which sets one
// for the rest of the run (or the conversation) and no longer: never written anywhere. The env it's
// given shows what it's set; what it set goes back with what it returned. (A value of the
// environment's named set is behind the method.)
function envWith(values) {
  const sets = {};
  const env = { ...(values ?? {}) };
  Object.defineProperty(env, "set", {
    enumerable: false,
    value(name, value) {
      if (typeof name !== "string" || !NAME.test(name)) throw new Error(`env.set: ${JSON.stringify(name)} isn't a name (${NAME_RULE})`);
      if (value === undefined || value === null || typeof value === "object" || typeof value === "function") throw new Error(`env.set("${name}", …) takes text (a number or true/false is made text)`);
      sets[name] = String(value);
      if (name !== "set") env[name] = sets[name];
    },
  });
  return { env, sets };
}

export function servePlugin({ receive, send, importSource }) {
  withoutNetwork();
  let plugin = null;
  const calls = new Map();    // id → AbortController
  const fetches = new Map();  // fid → { resolve, reject, chunks, waiting, ended, error }
  let nextFetch = 1;

  // A response the plugin reads: status, headers, and its body as text chunks
  const response = (f) => {
    const body = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (f.chunks.length) {
            yield f.chunks.shift();
            continue;
          }
          if (f.error) throw new Error(f.error);
          if (f.ended) return;
          await new Promise((r) => { f.waiting = r; });
        }
      },
    };
    const text = async () => {
      let all = "";
      for await (const t of body) all += t;
      return all;
    };
    return {
      status: f.status,
      headers: f.headers,
      body,
      text,
      json: async () => JSON.parse(await text()),
      async *lines() {
        let buffer = "";
        for await (const t of body) {
          buffer += t;
          let at;
          while ((at = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, at).replace(/\r$/, "");
            buffer = buffer.slice(at + 1);
            if (line) yield line;
          }
        }
        if (buffer.trim()) yield buffer;
      },
      async *sse() {
        let data = [];
        let event;
        for await (const line of this.linesWithBlanks()) {
          if (line === "") {
            if (data.length) yield { event, data: data.join("\n") };
            data = [];
            event = undefined;
          } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          else if (line.startsWith("event:")) event = line.slice(6).trim();
        }
        if (data.length) yield { event, data: data.join("\n") };
      },
      async *linesWithBlanks() {
        let buffer = "";
        for await (const t of body) {
          buffer += t;
          let at;
          while ((at = buffer.indexOf("\n")) !== -1) {
            yield buffer.slice(0, at).replace(/\r$/, "");
            buffer = buffer.slice(at + 1);
          }
        }
        if (buffer) yield buffer;
      },
    };
  };

  // The transport a call gets: its requests go to the engine
  const transportFor = (id) => ({
    fetch(request) {
      const fid = nextFetch++;
      return new Promise((resolve, reject) => {
        fetches.set(fid, { resolve, reject, chunks: [], waiting: null, ended: false, error: null, status: 0, headers: {} });
        send({ type: "fetch", fid, id, request: { ...request, signal: undefined } });
      });
    },
  });

  const wake = (f) => {
    const w = f.waiting;
    f.waiting = null;
    w?.();
  };

  receive(async (m) => {
    if (!m) return;
    if (m.type === "load") {
      try {
        const mod = await importSource(m.source, m.url);
        plugin = mod?.default ?? mod;
        if (!plugin || typeof plugin !== "object") throw new Error("its default export isn't a plugin");
        if (!["provider", "check", "judge", "fixture"].includes(plugin.kind)) throw new Error(`its kind is "${plugin.kind}": a plugin is a provider, a check, a judge or a fixture`);
        if (typeof plugin.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(plugin.name)) throw new Error("it has no name (letters, digits, '.', '-' and '_')");
        // (a fixture's run() was setup() at first: either is its method)
        const method = { provider: "send", check: "check", judge: "judge", fixture: typeof plugin.run === "function" ? "run" : "setup" }[plugin.kind];
        if (typeof plugin[method] !== "function") throw new Error(plugin.kind === "fixture" ? "a fixture plugin has run()" : `a ${plugin.kind} plugin has ${method}()`);
        // A fixture's names: the values its run() returns, which files and plugins use by name; when
        // it runs (phases); and the environment's names it sets with env.set (sets: those its code
        // doesn't write as env.set("NAME", …), for the check before a run)
        const provides = plugin.kind === "fixture" && plugin.provides !== undefined ? plugin.provides : [];
        if (!Array.isArray(provides) || provides.some((n) => typeof n !== "string" || !NAME.test(n))) throw new Error(`its provides is a list of names (${NAME_RULE})`);
        const sets = plugin.kind === "fixture" && plugin.sets !== undefined ? plugin.sets : [];
        if (!Array.isArray(sets) || sets.some((n) => typeof n !== "string" || !NAME.test(n))) throw new Error(`its sets is a list of the environment's names it sets with env.set (${NAME_RULE})`);
        const { phases, error } = plugin.kind === "fixture" ? phasesOf(plugin) : {};
        if (error) throw new Error(error);
        send({ type: "loaded", id: m.id, meta: { kind: plugin.kind, name: plugin.name, version: String(plugin.version ?? "0.0.0"), hosts: Array.isArray(plugin.hosts) ? plugin.hosts.map(String) : [], ...(plugin.kind === "fixture" ? { provides, phases, sets } : {}) } });
      } catch (err) {
        send({ type: "error", id: m.id, message: err?.message ?? String(err) });
      }
      return;
    }
    if (m.type === "abort") {
      calls.get(m.id)?.abort();
      return;
    }
    if (m.type?.startsWith("fetch:")) {
      const f = fetches.get(m.fid);
      if (!f) return;
      if (m.type === "fetch:res") {
        f.status = m.status;
        f.headers = m.headers ?? {};
        f.resolve(response(f));
      } else if (m.type === "fetch:chunk") {
        f.chunks.push(m.text);
        wake(f);
      } else if (m.type === "fetch:end") {
        f.ended = true;
        fetches.delete(m.fid);
        wake(f);
      } else if (m.type === "fetch:error") {
        f.error = m.message;
        f.reject(new Error(m.message));
        fetches.delete(m.fid);
        wake(f);
      }
      return;
    }
    if (m.type === "call") {
      const controller = new AbortController();
      calls.set(m.id, controller);
      const args = { ...m.args, transport: transportFor(m.id), signal: controller.signal };
      try {
        if (m.method === "send") {
          for await (const event of plugin.send(args)) send({ type: "event", id: m.id, event: JSON.parse(JSON.stringify(event)) });
          send({ type: "done", id: m.id });
        } else {
          // (a fixture's env can set the environment's values: what it set goes back with its result)
          const own = m.method === "run" ? envWith(m.args?.env) : null;
          if (own) args.env = own.env;
          const value = await (plugin[m.method] ?? (m.method === "run" ? plugin.setup : undefined)).call(plugin, args);
          send({ type: "result", id: m.id, value: JSON.parse(JSON.stringify(value ?? null)), ...(own && Object.keys(own.sets).length ? { sets: own.sets } : {}) });
        }
      } catch (err) {
        send({ type: "error", id: m.id, message: controller.signal.aborted ? "stopped" : err?.message ?? String(err) });
      } finally {
        calls.delete(m.id);
      }
    }
  });
}
