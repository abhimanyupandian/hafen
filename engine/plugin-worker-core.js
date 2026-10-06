// What a plugin's worker runs (contracts/provider.md, Code plugins): it loads one plugin module and
// answers the engine's calls to it, by messages. The plugin reaches the network only through
// `transport`, whose requests the engine makes (to the plugin's hosts, filling in any secret a header
// names), so the plugin never holds a secret's value. Platform-free: the Node and browser workers
// (plugin-worker-node.js, app/js/plugin-worker.js) give it their messaging and module loading.
//
//   engine → worker  { type: "load", id, source }                 → { type: "loaded", id, meta } | { type: "error", id, message }
//                    { type: "call", id, method, args }           → send: { type: "event", id, event }…, { type: "done", id }
//                                                                    check/judge/setup: { type: "result", id, value }
//                    { type: "abort", id }
//                    { type: "fetch:res", fid, status, headers } { type: "fetch:chunk", fid, text } { type: "fetch:end", fid } { type: "fetch:error", fid, message }
//   worker → engine  { type: "fetch", fid, id, request }

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function servePlugin({ receive, send, importSource }) {
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
        const mod = await importSource(m.source);
        plugin = mod?.default ?? mod;
        if (!plugin || typeof plugin !== "object") throw new Error("its default export isn't a plugin");
        if (!["provider", "check", "judge", "fixture"].includes(plugin.kind)) throw new Error(`its kind is "${plugin.kind}": a plugin is a provider, a check, a judge or a fixture`);
        if (typeof plugin.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(plugin.name)) throw new Error("it has no name (letters, digits, '.', '-' and '_')");
        const method = { provider: "send", check: "check", judge: "judge", fixture: "setup" }[plugin.kind];
        if (typeof plugin[method] !== "function") throw new Error(`a ${plugin.kind} plugin has ${method}()`);
        // A fixture's names: the values its setup() returns, which files and plugins use by name
        const provides = plugin.kind === "fixture" && plugin.provides !== undefined ? plugin.provides : [];
        if (!Array.isArray(provides) || provides.some((n) => typeof n !== "string" || !SECRET_NAME.test(n))) throw new Error("its provides is a list of names (letters, digits and '_', not starting with a digit)");
        send({ type: "loaded", id: m.id, meta: { kind: plugin.kind, name: plugin.name, version: String(plugin.version ?? "0.0.0"), hosts: Array.isArray(plugin.hosts) ? plugin.hosts.map(String) : [], ...(plugin.kind === "fixture" ? { provides } : {}) } });
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
          const value = await plugin[m.method](args);
          send({ type: "result", id: m.id, value: JSON.parse(JSON.stringify(value ?? null)) });
        }
      } catch (err) {
        send({ type: "error", id: m.id, message: controller.signal.aborted ? "stopped" : err?.message ?? String(err) });
      } finally {
        calls.delete(m.id);
      }
    }
  });
}
