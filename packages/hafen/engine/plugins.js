// Plugins (contracts/provider.md, Code plugins and Fixtures; contracts/checks.md, Plugins): ES modules
// that add a provider, a check, a judge or a fixture (a provider's login: engine/fixtures.js). A suite
// names them (`plugins: [./plugins/acme.js]`, a path from the suite, or a package name, in Node), and
// each runs in a worker of its own (engine/plugin-worker-core.js): a Web Worker in the browser build,
// worker_threads with no environment in Node. A plugin reaches the network only through the engine, to
// the hosts it names; its address, its headers and its body can have {{secret.NAME}} and {{env.NAME}}
// in them ("Bearer {{secret.ACME_KEY}}"), which the engine fills in as the request leaves, so the
// plugin never holds a secret's value. (The old way, a header or a value in a JSON body naming one,
// { secret: "ACME_KEY", prefix: "Bearer " }, is a problem where its code writes it, and a request
// that has one fails, saying the new way.) Where the host loads it from its file
// (Node: the desktop app, the CLI), a plugin imports other files and packages as any module does; in
// the browser build it's one module.
//
// host.pluginWorker(): a new worker: { post(message), onMessage(handler), onError(handler), terminate() }

import { isBuiltIn, typeOf } from "./checks/index.js";
import { FIXTURE_PHASES, fixturesOf } from "./fixture-lists.js";
import { canRead, envHas, providerPlace, whyMissing } from "./files/suite-file.js";
import { joinPath, missingFile, textChunks } from "./util.js";
import { createScope, missingMessage, oldWay, placeholders, secretsWhere } from "./vars.js";
import { pluginsWhere } from "./plugin-place.js";

export const PLUGIN_FILE = /^plugins\/[^/]+\.m?js$/i;
// The folder's plugins (plugins/*.js), which any suite may use by name without naming them: the
// host's own list where it has one (the command line's: the plugins/ of each folder it names too),
// else the files in plugins/ at its root
export async function folderPluginFiles(host) {
  if (host.pluginFiles) return host.pluginFiles();
  return host.list ? (await host.list()).filter((f) => PLUGIN_FILE.test(f)) : [];
}
// How much of a plugin call's response body is kept for its step (the plugin reads all of it)
const CALL_CAP = 64 * 1024;
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

// The secrets a plugin's code names, as the engine fills them in ("{{secret.ACME_PASSWORD}}"), each
// where it's first written: [{ name, line, column }]. Read from its text (a pack's: bundled with what
// it imports), so a name it builds as it runs isn't seen.
const SECRET_TEXT = /\{\{\s*secrets?\.([A-Za-z_][\w.-]*)\s*\}\}/g;
const ENV_TEXT = /\{\{\s*env\.([A-Za-z_][\w.-]*)\s*\}\}/g;
// (the old way to name one: { secret: "ACME_PASSWORD" }, with a prefix or not)
const SECRET_OBJECT = /\bsecret\s*:\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g;
// (a fixture's env.set("NAME", …): a name it sets in the environment, written as it is)
const ENV_SET = /\benv\s*\??\.\s*set\s*\(\s*["'`]([A-Za-z_][A-Za-z0-9_.-]*)["'`]/g;
const namedBy = (pattern) => (source) => namedAt(String(source ?? ""), [...String(source ?? "").matchAll(pattern)]);
export const secretsNamed = namedBy(SECRET_TEXT);
// The {{env.NAMES}} its code writes, each where it's first written: [{ name, line, column }]
export const envNamed = namedBy(ENV_TEXT);
// The environment's names a fixture's code sets, as env.set("NAME", …), each where it's first written
export const envSetNamed = namedBy(ENV_SET);
// The secrets its code names the old way ({ secret: "NAME" }), each where it's first written
export const oldSecretsNamed = namedBy(SECRET_OBJECT);
function namedAt(text, found) {
  const out = new Map();
  for (const m of found) {
    if (out.has(m[1])) continue;
    const before = text.slice(0, m.index);
    out.set(m[1], { name: m[1], line: before.split("\n").length, column: m.index - before.lastIndexOf("\n") });
  }
  return [...out.values()];
}

// Where a plugin entry is, and its text: { file, source } (or { error })
async function readEntry(host, entry, fromFile) {
  if (isPath(entry)) {
    const file = fromFile ? joinPath(fromFile, entry) : entry;
    // (a path from a suite that climbs out of the folder is outside it, wherever it leads)
    if (!(fromFile ? await canRead(host, fromFile, entry) : await host.files.exists(file))) return { file, error: fromFile ? whyMissing(host, fromFile, entry, `the plugin ${entry}`) : missingFile(host, file, `the plugin ${entry}`) };
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

  // A request the plugin makes: to its hosts only, its {{secret.…}}s and {{env.…}}s (and secret
  // headers) filled in here. Each is told to the call's onCall (start, then end: its status, headers
  // and body, the first CALL_CAP of it), so the run can show it as a step, and tagged with the plugin
  // (`via`) for the app's log.
  const fetchFor = async (m, meta) => {
    const w = waiting.get(m.id);
    const reply = (msg) => worker.post({ ...msg, fid: m.fid });
    const onCall = w?.opts?.onCall;
    let started = false;
    let got = "";
    try {
      const { request } = m;
      // (its address first: the host it's for is the one it's checked against)
      const fill = w?.fill ?? ((text) => text);
      const url = typeof request.url === "string" ? fill(request.url) : request.url;
      let hostName;
      try {
        hostName = new URL(url).hostname;
      } catch {
        throw new Error(`${url} isn't an address`);
      }
      const allowed = (meta.hosts ?? []).some((h) => h === hostName || (h.startsWith("*.") && (hostName === h.slice(2) || hostName.endsWith(h.slice(1)))));
      if (!allowed) throw new Error(`${hostName} isn't one of the plugin's hosts (${(meta.hosts ?? []).join(", ") || "it names none"})`);
      // (a secret named the old way, { secret: "NAME" }, as it's built: refused, saying the new way)
      const headers = {};
      for (const [k, v] of Object.entries(request.headers ?? {})) {
        if (v && typeof v === "object" && typeof v.secret === "string") throw new Error(oldWay("plugin", v.secret));
        headers[k] = fill(String(v));
      }
      let body = request.body;
      if (typeof body === "string") body = fill(body);
      else if (body !== undefined && body !== null) {
        body = JSON.stringify(fillBody(body, fill));
        if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
      }
      const transport = w?.opts?.transport ?? host.transport;
      const redirect = ["follow", "manual", "error"].includes(request.redirect) ? request.redirect : undefined;
      const sent = { url, method: request.method ?? (body === undefined ? "GET" : "POST"), headers, body, ...(redirect ? { redirect } : {}) };
      onCall?.({ phase: "start", id: m.fid, plugin: `${meta.kind} ${meta.name}`, request: { method: sent.method, url: sent.url, headers, ...(body !== undefined ? { body } : {}) } });
      started = true;
      const res = await transport.send({ ...sent, via: `${meta.kind}:${meta.name}` }, { signal: w?.opts?.signal });
      reply({ type: "fetch:res", status: res.status, headers: res.headers ?? {} });
      for await (const text of textChunks(res.body)) {
        if (got.length < CALL_CAP) got += text;
        reply({ type: "fetch:chunk", text });
      }
      reply({ type: "fetch:end" });
      onCall?.({ phase: "end", id: m.fid, status: res.status, headers: res.headers ?? {}, body: got.length > CALL_CAP ? `${got.slice(0, CALL_CAP)}…` : got });
    } catch (err) {
      const message = err?.name === "AbortError" ? "stopped" : err?.message ?? String(err);
      reply({ type: "fetch:error", message });
      if (started) onCall?.({ phase: "end", id: m.fid, error: message, ...(got ? { body: got } : {}) });
      else onCall?.({ phase: "refused", id: m.fid, plugin: `${meta.kind} ${meta.name}`, request: { method: m.request?.method ?? "GET", url: m.request?.url }, error: message });
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
      // (a fixture's run: its value and what it set, sets)
      w.resolve(w.whole ? m : m.meta ?? m.value);
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
    // (the secrets and the environment's values its code names, and the secrets it names the old way,
    // each where: for the check before a run)
    secrets: secretsNamed(source),
    envNamed: envNamed(source),
    envSets: envSetNamed(source),
    oldSecrets: oldSecretsNamed(source),
    // A method of it: opts { signal, transport, scope (the turn's, the run's or the conversation's:
    // where its requests' {{secret.…}}s and {{env.…}}s come from), secrets(NAME) (with no scope, where
    // its {{secret.…}}s come from), used (a Set for redaction), onEvent, whole (the result's message:
    // { value, sets? }) }
    call: (method, args, opts = {}) => request({ type: "call", method, args }, { opts, onEvent: opts.onEvent, fill: fillerFor(args, opts), whole: opts.whole }),
    close: () => worker.terminate(),
  };
}

// What a call's requests are filled in from: its scope's {{secret.…}}s and {{env.…}}s (without one,
// the secrets alone), never inside what the call gave it from elsewhere (a message, a reply, a
// check's value: the arguments that aren't its settings, its variables, its environment or its
// check's fields)
const OWN_ARGS = new Set(["settings", "variables", "env", "params", "question", "phase", "test"]);
function fillerFor(args, opts) {
  const untrusted = placeholders(Object.entries(args ?? {}).filter(([key]) => !OWN_ARGS.has(key)).map(([, value]) => value));
  const scope = opts.scope?.request ? opts.scope : createScope({ secrets: opts.secrets ?? (() => undefined), used: opts.used ?? new Set(), environment: null });
  return scope.request(untrusted);
}

// What the engine uses: a provider, a check or a judge, by its plugin's kind
function adapter(running, defaults) {
  const { meta } = running;
  const base = { meta, file: running.file, kind: meta.kind, secrets: running.secrets ?? [], envNamed: running.envNamed ?? [], envSets: running.envSets ?? [], oldSecrets: running.oldSecrets ?? [], close: running.close };
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
            // (no secret in any: a request has {{secret.NAME}}, and the engine fills it in)
            variables: scope?.variables?.() ?? {},
            env: scope?.envValues?.() ?? {},
            attachments: [],
            settings: scope?.plain ? scope.plain(config) : config,
          }, {
            signal, transport: transport ?? defaults.transport, onEvent: push, onCall: (call) => push({ type: "call", ...call }),
            // (its secrets from the turn's scope: the run's or the conversation's, a fixture's values first)
            scope, secrets: defaults.secrets, used: scope?.secretsUsed ?? defaults.used,
          })
            .then(() => { finished = true; push(null); }, (err) => { failure = err; finished = true; push(null); });
          // Its events are its stream: each is kept as a raw line too (as a JSON-lines endpoint's would be),
          // and the reply is assembled from them for `on: response` checks
          for (;;) {
            if (!queue.length) await new Promise((r) => { wake = r; });
            const item = queue.shift();
            if (item?.type === "call") yield item;
            else if (item) {
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
  // (what a fixture's run set with env.set, told to opts.onSets({ NAME: text }) as it returns)
  if (meta.kind === "fixture") {
    return {
      ...base,
      run: async (args, opts = {}) => {
        const out = await running.call("run", args, { ...defaults, ...opts, whole: true });
        if (out.sets) opts.onSets?.(out.sets);
        return out.value;
      },
    };
  }
  return {
    ...base,
    judge: ({ input, question, params, env = {}, signal, onCall, scope }) => running.call("judge", { input, question, params, env }, { ...defaults, signal, onCall, ...(scope ? { scope } : {}) }),
  };
}

// A suite's plugins (or any entries): { plugins: { name: adapter }, problems: [{ file, message, entry? }],
// close() }. (entry: a suite's entry the problem is with, so a check can say where the suite has it)
// defaults: { secrets(NAME), used, transport } for the requests they make
export async function loadPlugins(host, entries = [], fromFile = null, defaults = {}) {
  const plugins = {};
  const problems = [];
  const running = [];
  for (const entry of entries) {
    const read = await readEntry(host, entry, fromFile);
    const of = fromFile ? { file: fromFile, entry } : { file: read.file };
    if (read.error) {
      problems.push({ ...of, message: read.error });
      continue;
    }
    try {
      const plugin = await startPlugin(host, read);
      running.push(plugin);
      if (plugins[plugin.meta.name]) problems.push({ ...of, message: `two plugins are named "${plugin.meta.name}" (${plugins[plugin.meta.name].file} and ${read.file})` });
      else plugins[plugin.meta.name] = adapter(plugin, { transport: host.transport, ...defaults });
    } catch (err) {
      problems.push({ ...of, message: err.message });
    }
  }
  return { plugins, problems, close: () => { for (const p of running) p.close(); } };
}

export { FIXTURE_PHASES, fixturesOf } from "./fixture-lists.js";
const hasFixtures = (config) => config?.fixtures !== undefined || config?.fixture !== undefined;

// The plugins a suite uses by name: its providers' (kind: plugin:acme) and their fixtures (in any
// of their lists), its judges' (kind: plugin), and its checks' types that aren't Hafen's own
export function pluginNames(suite) {
  const names = new Set();
  for (const config of Object.values(suite.providers ?? {})) {
    const m = typeof config?.kind === "string" && config.kind.match(/^plugin:([^@]+)/);
    if (m) names.add(m[1]);
    const lists = fixturesOf(config);
    for (const phase of FIXTURE_PHASES) for (const ref of lists[phase]) names.add(ref.name);
  }
  for (const judge of Object.values(suite.data?.judges ?? {})) if (judge?.kind === "plugin" && judge.plugin) names.add(judge.plugin);
  for (const test of Array.isArray(suite.data?.tests) ? suite.data.tests : []) {
    const checks = [...(Array.isArray(test?.turns) ? test.turns : []).flatMap((t) => (Array.isArray(t?.expect) ? t.expect : [])), ...(Array.isArray(test?.expect_conversation) ? test.expect_conversation : [])];
    for (const check of checks) if (check && typeof check === "object" && !isBuiltIn(check)) names.add(typeOf(check));
  }
  return names;
}

// The plugins a suite uses with a version range (kind: plugin:acme@^1): each must satisfy it. Each
// problem is said where it's fixed: at the provider's kind, or at the fixture in its list, in the
// provider file (or the suite, for a provider written there)
export function versionProblems(suite, plugins) {
  const out = [];
  for (const [key, config] of Object.entries(suite.providers ?? {})) {
    const m = typeof config?.kind === "string" && config.kind.match(/^plugin:([^@]+)(?:@(.+))?$/);
    if (!m) continue;
    const plugin = plugins[m[1]];
    const where = providerPlace(suite, key, ["kind"]);
    if (!plugin) out.push({ ...where, message: `the provider plugin "${m[1]}" isn't in ${pluginsWhere()}` });
    else if (plugin.kind !== "provider") out.push({ ...where, message: `the plugin "${m[1]}" is a ${plugin.kind}, not a provider` });
    else if (m[2] && !satisfies(plugin.meta.version, m[2])) out.push({ ...where, message: `the plugin "${m[1]}" is version ${plugin.meta.version}, not ${m[2]}` });
  }
  for (const [key, config] of Object.entries(suite.providers ?? {})) out.push(...fixtureIssues(config, plugins).map(({ message, path }) => ({ ...providerPlace(suite, key, path), message })));
  // (a provider file two of its references load is said once)
  const seen = new Set();
  return out.filter((p) => {
    const key = `${p.file}\u0000${p.line}\u0000${p.message}`;
    return !seen.has(key) && seen.add(key);
  });
}

// What's wrong with a provider's fixtures, given the plugins there are: [{ message, path }] (path: where
// in the provider, as ["fixtures", "before", 1]), each said once
export function fixtureIssues(config, plugins) {
  const lists = fixturesOf(config);
  const out = lists.problems.map((message, i) => ({ message, path: lists.at[i] ?? ["fixtures"] }));
  for (const phase of FIXTURE_PHASES) {
    for (const [i, ref] of lists[phase].entries()) {
      const plugin = plugins[ref.name];
      const path = ["fixtures", phase, i];
      if (!plugin) out.push({ path, message: `the fixture "${ref.name}" (fixtures.${phase}) isn't in ${pluginsWhere()}` });
      else if (plugin.kind !== "fixture") out.push({ path, message: `the plugin "${ref.name}" (fixtures.${phase}) is a ${plugin.kind}, not a fixture` });
      else if (ref.range && !satisfies(plugin.meta.version, ref.range)) out.push({ path, message: `the fixture "${ref.name}" is version ${plugin.meta.version}, not ${ref.range}` });
      else if (!runsIn(plugin, phase)) out.push({ path, message: notIn(ref.name, plugin, phase) });
    }
  }
  const seen = new Set();
  return out.filter(({ message }) => !seen.has(message) && seen.add(message));
}

// The same, as messages
export const fixtureProblems = (config, plugins) => fixtureIssues(config, plugins).map((p) => p.message);

// Whether a fixture runs in a list (its phases: all four when it doesn't say), and what's said when
// a provider names it in one it doesn't: "the fixture "acme-login" runs only in beforeAll and afterAll:
// it can't be in fixtures.after"
export const runsIn = (plugin, phase) => (plugin.meta?.phases ?? FIXTURE_PHASES).includes(phase);
export function phasesText(plugin) {
  const phases = plugin.meta?.phases ?? FIXTURE_PHASES;
  return phases.length > 1 ? `${phases.slice(0, -1).join(", ")} and ${phases.at(-1)}` : phases[0];
}
export const notIn = (name, plugin, phase) => `the fixture "${name}" runs only in ${phasesText(plugin)}: it can't be in fixtures.${phase}`;

// The secrets the plugins a suite uses name in their code ("{{secret.NAME}}"): each must be set, or be
// one its providers' fixtures give (given); and the {{env.NAMES}} it writes, each the environment's
// (environment: the chosen one, { name, values, suite }, or null), or one its providers' fixtures set
// (envGiven). One that isn't is a problem where the plugin's file names it. secret(NAME): where
// secrets come from (the run's)
export function pluginSecretProblems(suite, plugins, given, secret, environment, secretsFrom, envGiven = new Set()) {
  const out = [];
  for (const name of pluginNames(suite)) {
    const plugin = plugins[name];
    const where = (use) => ({ file: plugin.file, line: use.line, column: use.column });
    const said = new Set();
    for (const use of plugin?.secrets ?? []) {
      // (once a name, where it's first written)
      if (given.has(use.name) || said.has(use.name)) continue;
      said.add(use.name);
      const value = secret(use.name);
      if (value !== undefined && value !== null && value !== "") continue;
      out.push({ ...where(use), variable: use.name, message: `${missingMessage(use.name, "secret", secretsWhere(environment, secretsFrom))} (the ${plugin.kind} plugin "${name}" names it)` });
    }
    for (const use of environment === undefined ? [] : plugin?.envNamed ?? []) {
      if ((environment && envHas(environment, use.name)) || envGiven.has(use.name)) continue;
      out.push({ ...where(use), variable: `env.${use.name}`, message: `${missingMessage(use.name, "environment", environment ? environment.name ?? "" : null)} (the ${plugin.kind} plugin "${name}" names it)` });
    }
  }
  return out;
}

// The plugins a suite uses that name a secret the old way ({ secret: "NAME" }): a problem for each,
// where its file names it, that says the new way
export function pluginOldSpellings(suite, plugins) {
  const out = [];
  for (const name of pluginNames(suite)) {
    const plugin = plugins[name];
    for (const use of plugin?.oldSecrets ?? []) out.push({ file: plugin.file, line: use.line, column: use.column, message: oldWay("plugin", use.name) });
  }
  return out;
}

// The names the fixtures that run before these providers' requests give (beforeAll's and before's
// plugins' provides): a Set
export function fixtureProvides(configs, plugins) {
  const names = new Set();
  for (const config of configs) {
    const lists = fixturesOf(config);
    for (const ref of [...lists.beforeAll, ...lists.before]) {
      const plugin = plugins[ref.name];
      if (plugin?.kind === "fixture") for (const n of plugin.meta.provides ?? []) names.add(n);
    }
  }
  return names;
}

// The environment's names the fixtures that run before these providers' requests set with env.set
// (beforeAll's and before's plugins'): the names their code writes as env.set("NAME", …), and their
// sets (for a name it builds as it runs). A Set: {{env.NAME}}s of them count as set before a run.
export function fixtureEnvSets(configs, plugins) {
  const names = new Set();
  for (const config of configs) {
    const lists = fixturesOf(config);
    for (const ref of [...lists.beforeAll, ...lists.before]) {
      const plugin = plugins[ref.name];
      if (plugin?.kind === "fixture") for (const n of fixtureSets(plugin)) names.add(n);
    }
  }
  return names;
}
// A fixture's names it sets in the environment: its sets, and what its code writes as env.set("NAME", …)
export const fixtureSets = (plugin) => [...new Set([...(plugin.meta?.sets ?? []), ...(plugin.envSets ?? []).map((use) => use.name)])];

// The names a suite's fixtures give, for checking its {{secret.…}}s before a run (when a fixture is
// what sets them): its providers' fixtures, loaded from its plugins and the folder's, then closed
export const suiteFixtureNames = async (host, suite) => (await suiteFixtureGives(host, suite)).secrets;
// The same, with the environment's names they set with env.set: { secrets: Set, env: Set }
export async function suiteFixtureGives(host, suite) {
  const configs = Object.values(suite.providers ?? {}).filter(hasFixtures);
  if (!configs.length) return { secrets: new Set(), env: new Set() };
  const own = await loadPlugins(host, suite.data?.plugins ?? [], suite.file);
  const folder = await loadPlugins(host, await folderPluginFiles(host), null);
  const all = { ...folder.plugins, ...own.plugins };
  const gives = { secrets: fixtureProvides(configs, all), env: fixtureEnvSets(configs, all) };
  own.close();
  folder.close();
  return gives;
}

// A JSON body with its texts' {{secret.…}}s and {{env.…}}s filled in (fill). A value that names a
// secret the old way ({ secret: "NAME", prefix? }: only those keys) is refused, saying the new way.
function fillBody(value, fill) {
  if (typeof value === "string") return fill(value);
  if (Array.isArray(value)) return value.map((v) => fillBody(v, fill));
  if (!value || typeof value !== "object") return value;
  if (isOldSecret(value)) throw new Error(oldWay("plugin", value.secret));
  return Object.fromEntries(Object.keys(value).map((k) => [k, fillBody(value[k], fill)]));
}
const isOldSecret = (value) => !!value && typeof value === "object" && typeof value.secret === "string" && Object.keys(value).every((k) => k === "secret" || k === "prefix");
