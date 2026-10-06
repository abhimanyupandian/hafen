// The engine behind a message port: what the browser build's Web Worker and the desktop app's
// utility process both run, so the UI talks to the engine the same way in both (research §5).
//
//   UI → engine:  { id, cmd, args }
//   engine → UI:  { id, ok: true, value } | { id, ok: false, error }   (the reply to a command)
//                 { event, token }                                     (progress of a run or a send)
//
// Commands: open, load, edit, create, read, write, remove, rename, validate, run, stop, send, reset, configure,
// saveConversation, compare. `host` is the platform's: { transport, files: { read, write, exists,
// remove }, secrets(NAME, {env}), now, clock, where, sha256?, list() }.

import { createConversation, conversationToTest } from "./explore.js";
import { editText, loadSuite, newSuiteText, parseText, SUITE_FILE } from "./files/suite-file.js";
import { stringify as stringifyYaml } from "yaml";
import { compareRuns } from "./compare.js";
import { hideSeenSecrets } from "./redact.js";
import { listScopes, readScope } from "./scopes.js";
import { loadPlugins, PLUGIN_FILE, pluginNames } from "./plugins.js";
import { runSuites } from "./runner.js";
import { validateProviderSchema } from "./schema.js";
import { describeKind } from "./providers/index.js";
import { basename, iterate, joinPath, testId } from "./util.js";

// An address as it may be logged: no user and password, and the values of query parameters that
// look like keys or tokens hidden
export function safeUrl(url) {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    for (const key of [...u.searchParams.keys()]) if (/key|token|secret|auth|sig|pass|code/i.test(key)) u.searchParams.set(key, "***");
    return u.toString().replace(/%2A%2A%2A/g, "***");
  } catch {
    return String(url).replace(/([?&][^=]*(?:key|token|secret|auth|sig|pass|code)[^=]*=)[^&]*/gi, "$1***");
  }
}

// A suite as the UI sees it: everything but the parsed document
export function suiteView(suite) {
  const { parsed, text, ...rest } = suite;
  return rest;
}

export function servePort(port, makeHost) {
  const running = new Map();        // token -> AbortController
  const conversations = new Map();  // token -> conversation
  let host = null;

  // Commands that read or change files run one after another, so two edits sent together can't
  // both read the file before either writes it (one would be lost)
  let tail = Promise.resolve();
  const serial = (fn) => {
    const done = tail.then(fn, fn);
    tail = done.catch(() => {});
    return done;
  };
  const SERIAL = new Set(["open", "load", "edit", "editFile", "create", "read", "write", "remove", "rename", "validate", "saveConversation"]);

  const emit = (token) => (event) => port.send({ event, token });

  // Each HTTP call the engine makes, logged to the page (no body, no header): its method, its address
  // (sensitive query values hidden), its status, how long it took to the end of its body, its size
  const audited = (inner) => {
    if (!inner || inner.audited) return inner;
    return {
      audited: true,
      async send(request, opts) {
        const t0 = host?.now?.() ?? performance.now();
        // (and any secret the engine filled in, wherever it is in the address: a path's token, say)
        const entry = { name: "http.request", method: request.method ?? "GET", url: hideSeenSecrets(safeUrl(request.url)) };
        const log = (more) => port.send({ log: { ...entry, ms: Math.round((host?.now?.() ?? performance.now()) - t0), ...more } });
        let res;
        try {
          res = await inner.send(request, opts);
        } catch (err) {
          log({ error: err?.name === "AbortError" ? "stopped" : hideSeenSecrets(err?.message ?? String(err)) });
          throw err;
        }
        // Logged once its body has been read (every reader reads it to the end, or stops it)
        const body = res.body;
        if (!body) {
          log({ status: res.status, bytes: 0 });
          return res;
        }
        let bytes = 0;
        async function* counted() {
          try {
            for await (const chunk of iterate(body)) {
              bytes += chunk?.byteLength ?? chunk?.length ?? 0;
              yield chunk;
            }
          } finally {
            log({ status: res.status, bytes });
          }
        }
        return { ...res, body: counted() };
      },
    };
  };
  const watch = () => { if (host) host.transport = audited(host.transport); };

  const commands = {
    // Start with a host's settings: { root } (a folder to read suites from), or files in memory
    async open(args) {
      host = await makeHost(args);
      watch();
      return commands.load({});
    },
    // Every suite and provider under the root
    async load() {
      const files = await host.list();
      const suiteFiles = files.filter((f) => SUITE_FILE.test(f)).sort();
      const suites = [];
      for (const file of suiteFiles) suites.push(suiteView(await loadSuite(host, file)));
      const providerFiles = files.filter((f) => /(^|\/)providers\/[^/]+\.(ya?ml|json)$/i.test(f)).sort();
      const providers = [];
      for (const file of providerFiles) {
        const parsed = parseText(await host.files.read(file), file);
        const errors = parsed.errors.length ? parsed.errors : validateProviderSchema(parsed.data) ? [] : (validateProviderSchema.errors ?? []).map((e) => ({ file, message: `${e.instancePath || "provider"} ${e.message}` }));
        providers.push({ file, name: basename(file).replace(/\.(ya?ml|json)$/i, ""), config: parsed.data, kind: describeKind(parsed.data), errors });
      }
      return { root: host.root ?? null, suites, providers, scopes: await listScopes(host, files) };
    },
    // Change a suite in place (comments kept): { file, edits, guards? }. Each guard, { path, value },
    // says what the app saw there; if the file says otherwise now (it changed underneath), nothing is
    // changed and the edit is refused, rather than made to the wrong test or check.
    async edit({ file, edits, guards = [] }) {
      const text = await host.files.read(file);
      const data = parseText(text, file).data;
      for (const g of guards) {
        const actual = g.path.reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), data);
        if (JSON.stringify(actual) !== JSON.stringify(g.value)) throw new Error(`${file} has changed since it was read: open it again`);
      }
      const next = editText(text, file, edits);
      await host.files.write(file, next);
      return suiteView(await loadSuite(host, file, { text: next }));
    },
    // A new file: { file, text } or a new suite { file, suite: {name, provider, tests} }
    async create({ file, text, suite }) {
      if (await host.files.exists(file)) throw new Error(`${file} already exists`);
      const content = text ?? newSuiteText({ ...suite, kind: /\.json$/i.test(file) ? "json" : "yaml" });
      await host.files.write(file, content);
      return SUITE_FILE.test(file) ? suiteView(await loadSuite(host, file, { text: content })) : { file };
    },
    async read({ file }) {
      return host.files.read(file);
    },
    // The folder's plugins (Settings → Plugins): every file in plugins/, and every plugin a suite
    // names, each loaded (in its worker, then stopped) to read what it is: [{ file, entry?, meta,
    // error, usedBy: [suite files] }]. A suite uses one by naming it, or by its name (a provider's
    // kind: plugin:acme, a judge's plugin, a check's type): any suite may use the folder's.
    async plugins() {
      const files = await host.list();
      const found = new Map();  // file → { file, usedBy }
      for (const f of files.filter((x) => PLUGIN_FILE.test(x))) found.set(f, { file: f, usedBy: [] });
      for (const suiteFile of files.filter((f) => SUITE_FILE.test(f))) {
        const parsed = parseText(await host.files.read(suiteFile), suiteFile);
        for (const entry of parsed.data?.plugins ?? []) {
          const isFile = /^(\.{1,2}\/|\/)/.test(entry) || /\.m?js$/i.test(entry);
          const file = isFile ? joinPath(suiteFile, entry) : entry;
          if (!found.has(file)) found.set(file, { file, usedBy: [], package: !isFile });
          found.get(file).usedBy.push(suiteFile);
        }
      }
      const out = [];
      for (const item of found.values()) {
        const loaded = await loadPlugins(host, [item.file], null);
        const plugin = Object.values(loaded.plugins)[0];
        out.push({ ...item, meta: plugin?.meta ?? null, error: loaded.problems[0]?.message ?? null });
        loaded.close();
      }
      // The suites that use each by its name
      for (const suiteFile of files.filter((f) => SUITE_FILE.test(f))) {
        let names;
        try {
          names = pluginNames(await loadSuite(host, suiteFile));
        } catch {
          continue;
        }
        for (const item of out) if (item.meta && names.has(item.meta.name) && !item.usedBy.includes(suiteFile)) item.usedBy.push(suiteFile);
      }
      for (const item of out) item.usedBy.sort();
      return out.sort((a, b) => a.file.localeCompare(b.file));
    },
    // Change any YAML or JSON file in place, comments kept (a scope's variables): { file, edits }
    async editFile({ file, edits }) {
      const text = await host.files.read(file);
      const parsed = parseText(text, file);
      if (parsed.errors.length) throw new Error(`can't edit ${file}: ${parsed.errors[0].message}`);
      // A file with nothing in it yet (its comments only): its map starts here, the comments kept
      if (parsed.data === null || parsed.data === undefined) {
        const data = {};
        for (const { op, path, value } of edits) {
          const parent = path.slice(0, -1).reduce((o, k) => (o[k] ??= {}), data);
          if (op === "delete") delete parent[path.at(-1)];
          else if (op === "add") (parent[path.at(-1)] ??= []).push(value);
          else parent[path.at(-1)] = value;
        }
        const body = /\.json$/i.test(file) ? `${JSON.stringify(data, null, 2)}\n` : stringifyYaml(data, { lineWidth: 0 });
        await host.files.write(file, /\.json$/i.test(file) ? body : `${text.trimEnd() ? `${text.trimEnd()}\n` : ""}${body}`);
        return { file };
      }
      await host.files.write(file, editText(text, file, edits));
      return { file };
    },
    // Delete a file in the folder (a suite or a provider): { file }
    async remove({ file }) {
      if (!(await host.files.exists(file))) throw new Error(`${file} doesn't exist`);
      await host.files.remove(file);
      return { file };
    },
    // Rename a file in its folder: { file, to, name? }. A suite is moved, and its `name` set to
    // `name` when it has one. A provider is moved, and the suites that use it are pointed at the new
    // name. Comments are kept; only what's named changes.
    async rename({ file, to, name }) {
      if (!(await host.files.exists(file))) throw new Error(`${file} doesn't exist`);
      if (await host.files.exists(to)) throw new Error(`${to} already exists`);
      if (SUITE_FILE.test(file)) {
        if (!SUITE_FILE.test(to)) throw new Error(`${to} isn't a suite's name (*.hafen.yml)`);
        const text = await host.files.read(file);
        const has = parseText(text, file).data?.name !== undefined;
        await host.files.write(to, name && has ? editText(text, to, [{ op: "set", path: ["name"], value: name }]) : text);
        await host.files.remove(file);
        return { file: to, suites: [] };
      }
      // Every suite that uses it, changed in memory first: if one can't be (a reference it can't
      // rewrite), nothing is written, and the provider keeps its name
      const changes = [];
      for (const suiteFile of (await host.list()).filter((f) => SUITE_FILE.test(f)).sort()) {
        const suite = await loadSuite(host, suiteFile);
        const edits = [];
        for (const [name, used] of Object.entries(suite.providerFiles ?? {})) {
          if (used !== file) continue;
          const path = name === "" ? ["provider"] : name.startsWith("test:") ? ["tests", Number(name.slice(5)), "provider"] : ["providers", name];
          const ref = path.reduce((v, k) => v?.[k], suite.data);
          if (typeof ref !== "string") throw new Error(`${suiteFile} names ${file} in a way that can't be changed for it (${path.join(".")}): change it there, then rename`);
          edits.push({ op: "set", path, value: ref.replace(/[^/\\]+$/, basename(to)) });
        }
        if (!edits.length) continue;
        try {
          changes.push({ file: suiteFile, before: suite.text, after: editText(suite.text, suiteFile, edits) });
        } catch (err) {
          throw new Error(`${suiteFile} can't be changed to use ${to} (${err.message}): nothing was renamed`);
        }
      }
      // Then written; a write that fails puts back what was written before it
      const written = [];
      try {
        await host.files.write(to, await host.files.read(file));
        written.push({ file: to, before: null });
        for (const c of changes) {
          await host.files.write(c.file, c.after);
          written.push({ file: c.file, before: c.before });
        }
      } catch (err) {
        for (const w of written.reverse()) await (w.before === null ? host.files.remove(w.file) : host.files.write(w.file, w.before)).catch(() => {});
        throw err;
      }
      await host.files.remove(file);
      return { file: to, suites: changes.map((c) => c.file) };
    },
    async write({ file, text }) {
      await host.files.write(file, text);
      return SUITE_FILE.test(file) ? suiteView(await loadSuite(host, file, { text })) : { file };
    },
    async validate({ files }) {
      const out = [];
      for (const file of files) {
        const suite = await loadSuite(host, file);
        out.push({ file, errors: suite.errors, warnings: suite.warnings });
      }
      return out;
    },
    // Run suites: { token, files, options }. Progress comes as events with the token.
    async run({ token, files, options = {} }) {
      const controller = new AbortController();
      running.set(token, controller);
      try {
        // Read after any edit sent before it (then run, while edits carry on)
        const suites = await serial(async () => {
          const out = [];
          for (const file of files) out.push(await loadSuite(host, file));
          return out;
        });
        const run = await runSuites({ suites, host, options, onEvent: emit(token), signal: controller.signal });
        await host.saveRun?.(run);
        return run;
      } finally {
        running.delete(token);
      }
    },
    async stop({ token }) {
      running.get(token)?.abort();
      conversations.get(token)?.controller?.abort();
      return true;
    },
    // Explore: send one message in a conversation: { token, provider (a config, or a provider file),
    // suite? (for variables and prices), env, message, seed? (a kept conversation's run to carry on,
    // used when the token's conversation starts) }
    async send({ token, provider, providerFile, suiteFile, env, message, history, seed }) {
      let conversation = conversations.get(token);
      // The chosen scope's variables, read for every message (they may have changed, or another scope
      // been chosen)
      const scopeNow = await serial(() => readScope(host, env));
      // A provider file is read for every message, so a change to it applies from the next one
      if (conversation && providerFile && !provider) {
        const parsed = await serial(async () => parseText(await host.files.read(providerFile), providerFile));
        if (parsed.errors.length) throw new Error(`${providerFile}: ${parsed.errors[0].message}`);
        conversation.setProvider(parsed.data);
      }
      if (!conversation) {
        let config = provider;
        if (!config && providerFile) config = await serial(async () => parseText(await host.files.read(providerFile), providerFile).data);
        let variables = {};
        let environment = {};
        let prices = {};
        if (suiteFile) {
          const suite = await serial(() => loadSuite(host, suiteFile));
          variables = suite.data?.variables ?? {};
          // (as a run does: the chosen scope's environment, or with none chosen the first; a scope the
          // suite has no environment for gives none of its variables)
          environment = env ? suite.data?.environments?.[env] ?? {} : Object.values(suite.data?.environments ?? {})[0] ?? {};
          prices = suite.prices ?? {};
          if (!config) config = suite.provider;
        }
        if (!config) throw new Error("choose a provider first");
        // A plugin's provider: the plugins of the suite giving the context, and the folder's own
        let pluginSet = null;
        if (typeof config.kind === "string" && config.kind.startsWith("plugin:")) {
          const files = (await host.list()).filter((f) => PLUGIN_FILE.test(f));
          const suiteData = suiteFile ? parseText(await host.files.read(suiteFile), suiteFile).data : null;
          const entries = [...new Set([...(suiteData?.plugins ?? []).map((e) => (/^(\.{1,2}\/|\/)/.test(e) || /\.m?js$/i.test(e) ? joinPath(suiteFile, e) : e)), ...files])];
          pluginSet = await loadPlugins(host, entries, null, { secrets: (name) => host.secrets(name, { env }), transport: host.transport });
          // (Another plugin in the folder that doesn't load doesn't stop this one)
          const wanted = config.kind.slice("plugin:".length).split("@")[0];
          if (!pluginSet.plugins[wanted]) {
            pluginSet.close();
            throw new Error(pluginSet.problems.find((p) => p.message.includes(wanted))?.message ?? `the provider plugin "${wanted}" isn't in the folder's plugins, or the suite's`);
          }
        }
        try {
          conversation = createConversation({ host, providerConfig: config, variables, environment, envName: env, prices, plugins: pluginSet?.plugins ?? {}, onEvent: emit(token), history, seed, scopeValues: scopeNow });
        } catch (err) {
          pluginSet?.close();
          throw err;
        }
        conversation.closePlugins = () => pluginSet?.close();
        conversations.set(token, conversation);
      }
      conversation.setScope(scopeNow);
      conversation.controller = new AbortController();
      const out = await conversation.send(message, { signal: conversation.controller.signal });
      return out;
    },
    // A conversation let go (another opened, a new one started): a message on its way is stopped too
    async reset({ token }) {
      const conversation = conversations.get(token);
      conversation?.controller?.abort();
      conversation?.closePlugins?.();
      conversations.delete(token);
      return true;
    },
    // New secrets or a new relay for the open host (the browser build), without opening it again:
    // its files (and any edits to files held in memory) and its conversations stay
    async configure(args) {
      host.configure?.(args);
      watch();
      return true;
    },
    // Save a conversation as a test: { token, file (a suite, new or existing), name, providerPath }
    // (run: the conversation as the app has it, for one the engine doesn't hold: kept, and opened again)
    async saveConversation({ token, file, name, providerPath, run }) {
      const mine = conversations.get(token)?.run;
      const source = mine?.turns?.length ? mine : run;
      if (!source?.turns?.length) throw new Error("there's no conversation to save");
      if (await host.files.exists(file)) {
        // Into a suite that uses another provider, the test names this conversation's
        const suite = await loadSuite(host, file);
        const own = providerPath && suite.providerFiles?.[""] !== joinPath(file, providerPath) ? providerPath : undefined;
        const test = { id: testId(), ...conversationToTest(source, { name, providerPath: own }) };
        return commands.edit({ file, edits: [{ op: "add", path: ["tests"], value: test }] });
      }
      const test = { id: testId(), ...conversationToTest(source, { name }) };
      return commands.create({ file, suite: { name: basename(file).replace(SUITE_FILE, ""), provider: providerPath ?? "providers/provider.yml", tests: [test] } });
    },
    async compare({ run, baseline, thresholds }) {
      return compareRuns(run, baseline, thresholds);
    },
    // A path relative to the root, for files the UI names
    async resolve({ from, path }) {
      return joinPath(from, path);
    },
  };

  port.receive(async (message) => {
    const { id, cmd, args } = message ?? {};
    if (!cmd) return;
    try {
      if (cmd !== "open" && !host) throw new Error("open a folder or a file first");
      const fn = commands[cmd];
      if (!fn) throw new Error(`unknown command "${cmd}"`);
      const value = SERIAL.has(cmd) ? await serial(() => fn(args ?? {})) : await fn(args ?? {});
      port.send({ id, ok: true, value });
    } catch (err) {
      port.send({ id, ok: false, error: err?.message ?? String(err) });
    }
  });
}
