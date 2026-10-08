// hafen pack (contracts/cli.md, pack): suites, and everything they need to run, in one file that runs
// them with Node 22 alone (cli/pack-runtime.js). In it: hafen's command line, bundled with its
// packages; the suites; the files they name (providers, data files, prices, JSON Schemas); and their
// plugins (the ones they name, and the folder's they use by name, fixtures too), each bundled with
// what it imports, files anywhere and packages.
//
// Never an environment's values or a secret: they're given where it runs (--env <file>, --secret
// <file>, or the secrets as environment variables). Their names go next to it: the environment's
// ({{env.NAME}}) in <name>.env.example, the secrets' (never their values), each with what uses it, in
// <name>.secret.example, to fill in copies of.
//
// Bundled with rolldown (an optional dependency of hafen: only packing needs it, and it's a native
// binary, so an install where it can't be had, or one with --omit=optional, still runs suites). The
// bundler's region comments are left out (they'd carry this machine's paths).

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileRefs, isPluginPath as isPath } from "../engine/files/dependencies.js";
import { loadSuite, runningData, secretsNeeded } from "../engine/files/suite-file.js";
import { folderPluginFiles, loadPlugins, pluginNames, suiteFixtureGives } from "../engine/plugins.js";
import { joinPath } from "../engine/util.js";
import { oldWay } from "../engine/vars.js";
import { VERSION } from "./node-host.js";

const RUNTIME = fileURLToPath(new URL("./pack-runtime.js", import.meta.url));
// What a pack hasn't (packing): a stand-in that says so, rather than an import of this machine's files
const STAND_IN = "\0hafen:not-in-a-pack";
const NOT_PACKED = {
  name: "hafen-not-in-a-pack",
  resolveId: (id) => (/(^|[\\/])pack\.js$/.test(id) ? STAND_IN : null),
  load: (id) => (id === STAND_IN ? 'const no = () => { throw new Error("a pack runs its suites: pack needs hafen itself"); };\nexport const pack = no;\n' : null),
};
const REGION = /^[ \t]*\/\/#(end)?region\b.*\n?/gm;
const size = (n) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// What a value uses (each string in it, deeply): secrets ({{secret.NAME}}, {{secrets.NAME}}) and its
// environment's values ({{env.NAME}})
const SECRET_USE = /\{\{\s*secrets?\.([A-Za-z_][\w.-]*)\s*\}\}/g;
const ENV_USE = /\{\{\s*env\.([A-Za-z_][\w.-]*)\s*\}\}/g;
function uses(value, found = { secrets: new Set(), env: new Set() }) {
  if (typeof value === "string") {
    for (const m of value.matchAll(SECRET_USE)) found.secrets.add(m[1]);
    for (const m of value.matchAll(ENV_USE)) found.env.add(m[1]);
  } else if (Array.isArray(value)) value.forEach((v) => uses(v, found));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => uses(v, found));
  return found;
}

export async function pack(paths, values, { cliHost, findSuites, out, err, red, dim }) {
  let rolldown;
  try {
    ({ rolldown } = await import("rolldown"));
  } catch {
    err(red("hafen pack bundles with rolldown, an optional dependency of hafen that isn't installed: npm install rolldown (or install hafen without --omit=optional)"));
    return 2;
  }
  const host = cliHost(paths);
  let files;
  try {
    files = await findSuites(host, paths);
  } catch (e) {
    err(red(e.message));
    return 2;
  }
  if (!files.length) {
    err(red("no suites found (files named *.hafen.yml, *.hafen.yaml or *.hafen.json)"));
    return 2;
  }
  const suites = [];
  for (const file of files) suites.push(await loadSuite(host, file));
  const problems = suites.flatMap((s) => s.errors ?? []);
  if (problems.length) {
    for (const p of problems) err(`${red(`${p.file ?? ""}${p.line ? `:${p.line}:${p.column}` : ""}`)}  ${p.message}`);
    err(red(`\n${plural(problems.length, "problem")}: nothing was packed.`));
    return 2;
  }

  // The files the suites need, as they are (the ones a suite names: files/dependencies.js; its plugins
  // are bundled below)
  const packed = new Map();  // path → text
  const add = async (p) => { if (!packed.has(p)) packed.set(p, await host.files.read(p)); };
  for (const s of suites) {
    await add(s.file);
    for (const { ref, what } of fileRefs(s.data)) if (what !== "the plugin") await add(joinPath(s.file, ref));
  }

  // Their plugins, each bundled with what it imports (and loaded first: one that doesn't load isn't
  // packed; one that names a secret the old way, { secret: "NAME" }, is a problem where it does)
  const plugins = {};   // pack path → { kind, name, version, files }
  const packages = {};  // a package a suite names → its pack path
  const oldWays = [];   // [{ file, line, column, message }]
  const bundle = async (input, label) => {
    const b = await rolldown({ input, platform: "node", logLevel: "silent" });
    let chunk;
    try {
      chunk = (await b.generate({ format: "esm", codeSplitting: false })).output.find((o) => o.type === "chunk");
    } finally {
      await b.close?.();
    }
    const missing = (chunk.imports ?? []).filter((i) => !isBuiltin(i));
    if (missing.length) throw new Error(`${label} imports ${missing.join(", ")}, which can't be found to pack (is it installed?)`);
    return { code: chunk.code.replace(REGION, ""), files: chunk.moduleIds?.length ?? 1 };
  };
  const packPlugin = async (at, input, entry, fromFile) => {
    if (plugins[at]) return;
    const loaded = await loadPlugins(host, [entry], fromFile);
    const plugin = Object.values(loaded.plugins)[0];
    loaded.close();
    if (!plugin) throw new Error(loaded.problems[0]?.message ?? `the plugin ${entry} can't be loaded`);
    for (const use of plugin.oldSecrets) oldWays.push({ file: plugin.file, line: use.line, column: use.column, message: oldWay("plugin", use.name) });
    const { code, files: count } = await bundle(input, `the plugin ${entry}`);
    packed.set(at, code);
    plugins[at] = { kind: plugin.meta.kind, name: plugin.meta.name, version: plugin.meta.version, files: count };
  };
  const folder = await loadPlugins(host, await folderPluginFiles(host), null);
  try {
    for (const s of suites) {
      for (const entry of s.data?.plugins ?? []) {
        if (isPath(entry)) {
          const at = joinPath(s.file, entry);
          await packPlugin(at, resolve(host.root, at), entry, s.file);
        } else {
          const at = `.hafen-pack/packages/${entry.replace(/[^A-Za-z0-9@._-]/g, "_")}.js`;
          packages[entry] = at;
          await packPlugin(at, await host.resolvePackage(entry), entry, s.file);
        }
      }
      // The folder's it uses by name; one it uses that isn't there (or doesn't load) stops the pack
      const own = new Set((s.data?.plugins ?? []).map((entry) => plugins[isPath(entry) ? joinPath(s.file, entry) : packages[entry]]?.name));
      for (const name of pluginNames(s)) {
        if (own.has(name)) continue;
        const plugin = folder.plugins[name];
        if (plugin) {
          await packPlugin(plugin.file, resolve(host.root, plugin.file), plugin.file, null);
          continue;
        }
        const why = folder.problems.find((p) => basename(p.file ?? "").replace(/\.m?js$/i, "") === name);
        throw new Error(`${s.file} uses the plugin "${name}", ${why ? `but ${why.file}: ${why.message}` : "which isn't in the folder's plugins/ or the suite's plugins"}`);
      }
    }
  } catch (e) {
    err(red(e.message));
    err(red("nothing was packed."));
    return 2;
  } finally {
    folder.close();
  }
  if (oldWays.length) {
    for (const p of oldWays) err(`${red(`${p.file}:${p.line}:${p.column}`)}  ${p.message}`);
    err(red(`\n${plural(oldWays.length, "problem")}: nothing was packed.`));
    return 2;
  }

  // The environment's values it uses ({{env.NAME}}: in the suites, their providers and their plugins)
  const envNames = new Set();
  // The secrets it needs (never their values): what the files name, less what a fixture gives; and
  // what its plugins name in their code ({{secret.NAME}}). Each with what uses it, for the
  // .secret.example
  const secrets = new Set();
  const given = new Set();
  const usedBy = new Map();  // NAME → [what uses it]
  const use = (name, what) => {
    secrets.add(name);
    const list = usedBy.get(name) ?? [];
    if (!list.includes(what)) list.push(what);
    usedBy.set(name, list);
  };
  // (an {{env.NAME}} a fixture sets with env.set isn't one to pass: the run has it once it's run)
  const setByFixtures = new Set();
  for (const s of suites) {
    const gives = await suiteFixtureGives(host, s);
    const fixtures = gives.secrets;
    for (const name of fixtures) given.add(name);
    for (const name of gives.env) setByFixtures.add(name);
    const inSuite = uses(runningData(s.data ?? {}));
    const providers = Object.entries(s.providers ?? {}).map(([key, config]) => [key, config, uses(config)]);
    for (const name of [...inSuite.env, ...providers.flatMap(([, , u]) => [...u.env])]) envNames.add(name);
    for (const name of new Set([...secretsNeeded(s), ...inSuite.secrets, ...providers.flatMap(([, , u]) => [...u.secrets])])) {
      if (fixtures.has(name)) continue;
      let known = inSuite.secrets.has(name);
      if (known) use(name, s.file);
      // A provider's (its file's, or the suite's when it's written inline), or a preset's default key
      for (const [key, config, used] of providers) {
        const own = used.secrets.has(name);
        if (!own && !secretsNeeded({ providers: { [key]: config } }).includes(name)) continue;
        const where = s.providerFiles?.[key] ?? s.file;
        use(name, own ? where : `${where} (the ${config.kind} preset's default key)`);
        known = true;
      }
      if (!known) use(name, name === "JEV_API_KEY" ? `${s.file} (System One's default key)` : s.file);
    }
  }
  const pluginSecrets = {};
  for (const at of Object.keys(plugins)) {
    const used = uses(packed.get(at));
    for (const name of used.secrets) {
      if (given.has(name)) continue;
      pluginSecrets[name] ??= at;
      use(name, at);
    }
    for (const name of used.env) envNames.add(name);
  }

  const outFile = resolve(values.out ?? `${basename(resolve(paths[0] ?? ".")).replace(/\.hafen\.(ya?ml|json)$/i, "") || "suites"}.hafen-pack.mjs`);
  const data = {
    name: basename(outFile),
    created: new Date().toISOString(),
    hafen: VERSION,
    from: basename(resolve(host.root)),
    suites: suites.map((s) => s.file),
    files: Object.fromEntries([...packed].sort(([a], [b]) => a.localeCompare(b))),
    packages,
    plugins,
    environment: [...envNames].filter((name) => !setByFixtures.has(name)).sort(),
    secrets: [...secrets].sort(),
    pluginSecrets,
  };

  // Hafen's command line, with the pack, bundled into one module (pack isn't in it)
  const dir = await mkdtemp(join(tmpdir(), "hafen-pack-"));
  let code;
  try {
    const entry = join(dir, "entry.mjs");
    await writeFile(entry, `import { runPack } from ${JSON.stringify(RUNTIME.replace(/\\/g, "/"))};\nrunPack(${JSON.stringify(data)});\n`);
    const b = await rolldown({ input: entry, platform: "node", logLevel: "silent", plugins: [NOT_PACKED] });
    try {
      const chunk = (await b.generate({ format: "esm", codeSplitting: false })).output.find((o) => o.type === "chunk");
      code = chunk.code.replace(REGION, "");
    } finally {
      await b.close?.();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const head = `#!/usr/bin/env node\n// A hafen pack: ${plural(data.suites.length, "suite")}, packed ${data.created} with hafen ${VERSION}. It runs with\n// Node 22 alone: node ${data.name} --help\n`;
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, head + code);
  await chmod(outFile, 0o755);

  const all = Object.keys(data.files);
  const providers = new Set(suites.flatMap((s) => Object.values(s.providerFiles ?? {})));
  const pluginList = Object.values(plugins);
  const dataFiles = all.filter((f) => /\.(csv|jsonl|ndjson)$/i.test(f));
  // How to run it: with an environment file (named for the suites' first environment) when it uses
  // {{env.…}}, else the environment's name when there's one to choose; and a secrets file when it
  // needs secrets
  const envName = suites.flatMap((s) => Object.keys(s.data?.environments ?? {}))[0];
  const runIt = `${data.name} run${data.environment.length ? ` --env ${envName ?? "staging"}.env` : envName ? ` --env ${envName}` : ""}${data.secrets.length ? ` --secret ${envName ?? "staging"}.secrets.env` : ""}`;

  // Next to it, the names to fill in copies of (never a value): the environment's, and the secrets'
  // with what uses each. None needed: no file
  const stem = basename(outFile).replace(/\.m?js$/i, "");
  const envExample = `${stem}.env.example`;
  const secretExample = `${stem}.secret.example`;
  if (data.environment.length) {
    await writeFile(join(dirname(outFile), envExample), [
      `# The environment values ${data.name} uses ({{env.NAME}}): their names. Fill in a copy for each`,
      "# environment (staging.env, prod.env: its name picks the suites' environment of that name), and",
      "# give it with --env:",
      `#   node ${runIt}`,
      "",
      ...data.environment.map((name) => `${name}=`),
      "",
    ].join("\n"));
  }
  if (data.secrets.length) {
    await writeFile(join(dirname(outFile), secretExample), [
      `# The secrets ${data.name} needs: their names, never their values. Fill in a copy (never commit`,
      "# it) and give it with --secret, or set them as environment variables where it runs:",
      `#   node ${runIt}`,
      "",
      ...data.secrets.flatMap((name) => [`# used by ${usedBy.get(name).join(", ")}`, `${name}=`]),
      "",
    ].join("\n"));
  }

  out(`packed ${data.name} (${size(Buffer.byteLength(head + code))})`);
  out(dim(`  ${[
    plural(suites.length, "suite"), plural(providers.size, "provider"),
    pluginList.length ? `${plural(pluginList.length, "plugin")} (bundled with ${plural(pluginList.reduce((n, p) => n + p.files, 0), "file")})` : null,
    dataFiles.length ? plural(dataFiles.length, "data file") : null,
  ].filter(Boolean).join(" · ")}`));
  out(dim(`  environment values it uses, from --env <file>: ${data.environment.length ? `${data.environment.join(", ")} (their names are in ${envExample})` : "none"}`));
  out(dim(`  secrets it needs, from --secret <file> or the environment: ${data.secrets.length ? `${data.secrets.join(", ")} (their names are in ${secretExample})` : "none"}`));
  out(dim(`  run it: node ${runIt}`));
  return 0;
}
