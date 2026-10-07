// Plugins (contracts/provider.md, Code plugins and Fixtures; contracts/checks.md, Plugins): ES modules
// that add a provider, a check, a judge or a fixture (a provider's login: engine/fixtures.js). A suite
// names them (`plugins: [./plugins/acme.js]`, a path from the suite, or a package name, in Node), and
// each runs in a worker of its own (engine/plugin-worker-core.js): a Web Worker in the browser build,
// worker_threads with no environment in Node. A plugin reaches the network only through the engine, to
// the hosts it names; a header, or a value in a JSON body, can name a secret
// ({ secret: "ACME_KEY", prefix: "Bearer " }), which the engine fills in, so the plugin never holds a
// secret's value. Where the host loads it from its file (Node: the desktop app, the CLI), a plugin
// imports other files and packages as any module does; in the browser build it's one module.
//
// host.pluginWorker(): a new worker: { post(message), onMessage(handler), onError(handler), terminate() }

import { isBuiltIn, typeOf } from "./checks/index.js";
import { joinPath, missingFile, textChunks } from "./util.js";

export const PLUGIN_FILE = /^plugins\/[^/]+\.m?js$/i;
const isPath = (entry) => /^(\.{1,2}\/|\/)/.test(entry) || /\.m?js$/i.test(entry);

// A version against a range: "1.2.3", "^1.2", "~1.2.0", "1", "*"
export function satisfies(version, range) {
  if (!range || range === "*" || range === "latest") return true;
  const parse = (v) => String(v).replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [a, b, c] = parse(version);
  const kind = range[0] === "^" || range[0] === "~" ? range[0] : "";
  const parts = String(range).replace(/^[\^~]/, "").split(".");
  const [x, y = 0, z = 0] = parse(parts.join("."));
  const given = parts.length;
  const atLeast = a > x || (a === x && (b > y || (b === y && c >= z)));
  if (kind === "^") return x > 0 ? a === x && atLeast : y > 0 || given < 2 ? a === 0 && b === y && atLeast : a === 0 && b === 0 && c === z;
  if (kind === "~") return a === x && (given < 2 || b === y) && atLeast;
  if (given === 1) return a === x;
  if (given === 2) return a === x && b === y;
  return a === x && b === y && c === z;
}

// Where a plugin entry is, and its text: { file, source } (or { error })
async function readEntry(host, entry, fromFile) {
  if (isPath(entry)) {
    const file = fromFile ? joinPath(fromFile, entry) : entry;
    if (!(await host.files.exists(file))) return { file, error: missingFile(host, file, `the plugin ${entry}`) };
    return { file, source: await host.files.read(file) };
  }
  if (!host.resolvePackage) return { file: entry, error: `the plugin package "${entry}" can't be loaded here (the browser build loads plugins from files in the folder)` };
  try {
    const file = await host.resolvePackage(entry);
    return { file, source: await host.files.read(file) };
  } catch (err) {
    return { file: entry, error: `the plugin package "${entry}" can't be found: ${err.message}` };
  }
}

// One plugin, running: { meta, file, call(method, args, opts), close() }
export async function startPlugin(host, { file, source }) {
  if (!host.pluginWorker) throw new Error("plugins can't run here");
  const worker = host.pluginWorker();
  const waiting = new Map();  // id → { resolve, reject, onEvent, opts }
  let next = 1;
  let broken = null;
  const fail = (err) => {
    broken = err;
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
  };
  worker.onError?.((err) => fail(new Error(`the plugin ${file} stopped: ${err?.message ?? err}`)));

  // A request the plugin makes: to its hosts only, its secret headers filled in here
  const fetchFor = async (m, meta) => {
    const w = waiting.get(m.id);
    const reply = (msg) => worker.post({ ...msg, fid: m.fid });
    try {
      const { request } = m;
      let hostName;
      try {
        hostName = new URL(request.url).hostname;
      } catch {
        throw new Error(`${request.url} isn't an address`);
      }
      const allowed = (meta.hosts ?? []).some((h) => h === hostName || (h.startsWith("*.") && (hostName === h.slice(2) || hostName.endsWith(h.slice(1)))));
      if (!allowed) throw new Error(`${hostName} isn't one of the plugin's hosts (${(meta.hosts ?? []).join(", ") || "it names none"})`);
      // A secret it names, filled in (and remembered, to be redacted)
      const secretOf = (ref) => {
        const value = w?.opts?.secrets?.(ref.secret);
        if (value === undefined || value === null || value === "") throw new Error(`the secret ${ref.secret} isn't set`);
        w?.opts?.used?.add(String(value));
        return `${ref.prefix ?? ""}${value}`;
      };
      const headers = {};
      for (const [k, v] of Object.entries(request.headers ?? {})) {
        headers[k] = v && typeof v === "object" && typeof v.secret === "string" ? secretOf(v) : String(v);
      }
      let body = request.body;
      if (body !== undefined && body !== null && typeof body !== "string") {
        body = JSON.stringify(fillSecrets(body, secretOf));
        if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
      }
      const transport = w?.opts?.transport ?? host.transport;
      const redirect = ["follow", "manual", "error"].includes(request.redirect) ? request.redirect : undefined;
      const res = await transport.send({ url: request.url, method: request.method ?? (body === undefined ? "GET" : "POST"), headers, body, ...(redirect ? { redirect } : {}) }, { signal: w?.opts?.signal });
      reply({ type: "fetch:res", status: res.status, headers: res.headers ?? {} });
      for await (const text of textChunks(res.body)) reply({ type: "fetch:chunk", text });
      reply({ type: "fetch:end" });
    } catch (err) {
      reply({ type: "fetch:error", message: err?.name === "AbortError" ? "stopped" : err?.message ?? String(err) });
    }
  };

  let meta = null;
  worker.onMessage((m) => {
    if (m?.type === "fetch") {
      fetchFor(m, meta ?? {});
      return;
    }
    const w = waiting.get(m?.id);
    if (!w) return;
    if (m.type === "event") w.onEvent?.(m.event);
    else if (m.type === "loaded" || m.type === "result" || m.type === "done") {
      waiting.delete(m.id);
      w.resolve(m.meta ?? m.value);
    } else if (m.type === "error") {
      waiting.delete(m.id);
      w.reject(new Error(m.message));
    }
  });
  const request = (message, extra = {}) => {
    if (broken) return Promise.reject(broken);
    const id = next++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject, ...extra });
      worker.post({ ...message, id });
      extra.opts?.signal?.addEventListener("abort", () => worker.post({ type: "abort", id }), { once: true });
    });
  };
  try {
    meta = await request({ type: "load", source, url: host.moduleUrl?.(file) });
  } catch (err) {
    worker.terminate();
    throw new Error(`the plugin ${file} can't be loaded: ${err.message}`);
  }
  return {
    meta,
    file,
    // A method of it: opts { signal, transport, secrets(NAME), used (a Set for redaction), onEvent }
    call: (method, args, opts = {}) => request({ type: "call", method, args }, { opts, onEvent: opts.onEvent }),
    close: () => worker.terminate(),
  };
}

// What the engine uses: a provider, a check or a judge, by its plugin's kind
function adapter(running, defaults) {
  const { meta } = running;
  const base = { meta, file: running.file, kind: meta.kind, close: running.close };
  if (meta.kind === "provider") {
    return {
      ...base,
      // A provider of it, for a configuration naming it (kind: plugin:<name>)
      provider: (config) => ({
        kind: config.kind,
        config,
        async *send({ message, history = [], scope, transport, signal }) {
          const queue = [];
          let wake = null;
          let finished = false;
          let failure = null;
          const push = (item) => {
            queue.push(item);
            const w = wake;
            wake = null;
            w?.();
          };
          running.call("send", {
            message,
            history: history.map((h) => ({ user: h.user, reply: h.reply, raw: h.raw })),
            // (no secret in either: a header names one, and the engine fills it in)
            variables: scope?.variables?.() ?? {},
            attachments: [],
            settings: scope?.plain ? scope.plain(config) : config,
          }, {
            signal, transport: transport ?? defaults.transport, onEvent: push,
            // (its { secret: NAME }s from the turn's scope: the run's or the conversation's, a fixture's values first)
            secrets: scope?.secretValue ?? defaults.secrets, used: scope?.secretsUsed ?? defaults.used,
          })
            .then(() => { finished = true; push(null); }, (err) => { failure = err; finished = true; push(null); });
          // Its events are its stream: each is kept as a raw line too (as a JSON-lines endpoint's would be),
          // and the reply is assembled from them for `on: response` checks
          for (;;) {
            if (!queue.length) await new Promise((r) => { wake = r; });
            const item = queue.shift();
            if (item) {
              yield { type: "chunk", text: `${JSON.stringify(item)}\n` };
              yield item;
            } else if (finished && !queue.length) break;
          }
          if (failure) yield { type: "error", message: failure.message };
        },
      }),
    };
  }
  if (meta.kind === "check") {
    return { ...base, check: (args, opts = {}) => running.call("check", args, { ...defaults, ...opts }) };
  }
  if (meta.kind === "fixture") {
    return { ...base, setup: (args, opts = {}) => running.call("setup", args, { ...defaults, ...opts }) };
  }
  return {
    ...base,
    judge: ({ input, question, params, signal }) => running.call("judge", { input, question, params }, { ...defaults, signal }),
  };
}

// A suite's plugins (or any entries): { plugins: { name: adapter }, problems: [{ file, message }], close() }
// defaults: { secrets(NAME), used, transport } for the requests they make
export async function loadPlugins(host, entries = [], fromFile = null, defaults = {}) {
  const plugins = {};
  const problems = [];
  const running = [];
  for (const entry of entries) {
    const read = await readEntry(host, entry, fromFile);
    if (read.error) {
      problems.push({ file: fromFile ?? read.file, message: read.error });
      continue;
    }
    try {
      const plugin = await startPlugin(host, read);
      running.push(plugin);
      if (plugins[plugin.meta.name]) problems.push({ file: fromFile ?? read.file, message: `two plugins are named "${plugin.meta.name}" (${plugins[plugin.meta.name].file} and ${read.file})` });
      else plugins[plugin.meta.name] = adapter(plugin, { transport: host.transport, ...defaults });
    } catch (err) {
      problems.push({ file: fromFile ?? read.file, message: err.message });
    }
  }
  return { plugins, problems, close: () => { for (const p of running) p.close(); } };
}

// A provider's fixture (fixture: acme-login, or acme-login@^1): { name, range } or null
export function fixtureRef(config) {
  const m = typeof config?.fixture === "string" && config.fixture.match(/^([^@]+)(?:@(.+))?$/);
  return m ? { name: m[1], range: m[2] } : null;
}

// The plugins a suite uses by name: its providers' (kind: plugin:acme) and their fixtures
// (fixture: acme-login), its judges' (kind: plugin), and its checks' types that aren't Hafen's own
export function pluginNames(suite) {
  const names = new Set();
  for (const config of Object.values(suite.providers ?? {})) {
    const m = typeof config?.kind === "string" && config.kind.match(/^plugin:([^@]+)/);
    if (m) names.add(m[1]);
    const fixture = fixtureRef(config);
    if (fixture) names.add(fixture.name);
  }
  for (const judge of Object.values(suite.data?.judges ?? {})) if (judge?.kind === "plugin" && judge.plugin) names.add(judge.plugin);
  for (const test of Array.isArray(suite.data?.tests) ? suite.data.tests : []) {
    const checks = [...(Array.isArray(test?.turns) ? test.turns : []).flatMap((t) => (Array.isArray(t?.expect) ? t.expect : [])), ...(Array.isArray(test?.expect_conversation) ? test.expect_conversation : [])];
    for (const check of checks) if (check && typeof check === "object" && !isBuiltIn(check)) names.add(typeOf(check));
  }
  return names;
}

// The plugins a suite uses with a version range (kind: plugin:acme@^1): each must satisfy it
export function versionProblems(suite, plugins) {
  const out = [];
  for (const config of Object.values(suite.providers ?? {})) {
    const m = typeof config?.kind === "string" && config.kind.match(/^plugin:([^@]+)(?:@(.+))?$/);
    if (!m) continue;
    const plugin = plugins[m[1]];
    if (!plugin) out.push({ file: suite.file, message: `the provider plugin "${m[1]}" isn't in the folder's plugins/ or the suite's plugins` });
    else if (plugin.kind !== "provider") out.push({ file: suite.file, message: `the plugin "${m[1]}" is a ${plugin.kind}, not a provider` });
    else if (m[2] && !satisfies(plugin.meta.version, m[2])) out.push({ file: suite.file, message: `the plugin "${m[1]}" is version ${plugin.meta.version}, not ${m[2]}` });
  }
  for (const config of Object.values(suite.providers ?? {})) out.push(...fixtureProblems(config, plugins).map((message) => ({ file: suite.file, message })));
  return out;
}

// What's wrong with a provider's fixture, given the plugins there are: [messages]
export function fixtureProblems(config, plugins) {
  const ref = fixtureRef(config);
  if (!ref) return config?.fixture !== undefined ? ["a provider's fixture is the name of a fixture plugin (fixture: acme-login)"] : [];
  const plugin = plugins[ref.name];
  if (!plugin) return [`the fixture "${ref.name}" isn't in the folder's plugins/ or the suite's plugins`];
  if (plugin.kind !== "fixture") return [`the plugin "${ref.name}" is a ${plugin.kind}, not a fixture`];
  if (ref.range && !satisfies(plugin.meta.version, ref.range)) return [`the fixture "${ref.name}" is version ${plugin.meta.version}, not ${ref.range}`];
  return [];
}

// The names the fixtures of these providers give (their plugins' provides): a Set
export function fixtureProvides(configs, plugins) {
  const names = new Set();
  for (const config of configs) {
    const plugin = plugins[fixtureRef(config)?.name];
    if (plugin?.kind === "fixture") for (const n of plugin.meta.provides ?? []) names.add(n);
  }
  return names;
}

// The names a suite's fixtures give, for checking its ${env:…}s before a run (when a fixture is what
// sets them): its providers' fixtures, loaded from its plugins and the folder's, then closed
export async function suiteFixtureNames(host, suite) {
  const configs = Object.values(suite.providers ?? {}).filter((c) => fixtureRef(c));
  if (!configs.length) return new Set();
  const own = await loadPlugins(host, suite.data?.plugins ?? [], suite.file);
  const folder = await loadPlugins(host, host.list ? (await host.list()).filter((f) => PLUGIN_FILE.test(f)) : [], null);
  const names = fixtureProvides(configs, { ...folder.plugins, ...own.plugins });
  own.close();
  folder.close();
  return names;
}

// Values in a JSON body that name a secret ({ secret: "NAME", prefix? }: only those keys), filled in
function fillSecrets(value, secretOf) {
  if (Array.isArray(value)) return value.map((v) => fillSecrets(v, secretOf));
  if (!value || typeof value !== "object") return value;
  const keys = Object.keys(value);
  if (typeof value.secret === "string" && keys.every((k) => k === "secret" || k === "prefix")) return secretOf(value);
  return Object.fromEntries(keys.map((k) => [k, fillSecrets(value[k], secretOf)]));
}
