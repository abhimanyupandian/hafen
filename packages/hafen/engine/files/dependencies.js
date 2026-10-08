// What suites use (contracts/test-file.md, Files a suite uses): every file they need to run, as paths
// from the host's root: the suites themselves, their provider files, data files, prices files and JSON
// Schemas, and their plugins (the entries they name, and the folder's plugins/ they use by name: a
// provider's kind and fixtures, a judge's, a check's type), each with the files it imports by a
// relative path (read from its text, and theirs in turn). Never a secret or an environment's values:
// they aren't files. The app's Import copies these from a folder into its workspace, its Export from
// the workspace to a folder; hafen pack packs the same files.

import { FIXTURE_PHASES, fixturesOf } from "../fixture-lists.js";
import { folderPluginFiles, loadPlugins, pluginNames } from "../plugins.js";
import { PRESETS } from "../providers/index.js";
import { basename, isObject, joinPath } from "../util.js";
import { climbsOut, editText, loadSuite, parseText, SUITE_FILE } from "./suite-file.js";

const listOf = (v) => (Array.isArray(v) ? v : []);
// A plugin entry that's a file (a path, or a name ending .js), not a package
export const isPluginPath = (entry) => /^(\.{1,2}\/|\/)/.test(entry) || /\.m?js$/i.test(entry);

// The files a suite's text names, each with where (its path in the suite) and what it is: [{ path,
// ref, what }]. A provider reference is a file unless it's a name under the suite's providers, a
// preset or plugin:…; a data file is a test's `data` (or its `file`); a JSON Schema a check's
// `schema` (one that's on); a plugin an entry that's a path.
export function fileRefs(data) {
  const refs = [];
  if (!isObject(data)) return refs;
  const named = isObject(data.providers) ? data.providers : {};
  const provider = (ref, path, naming) => {
    if (typeof ref !== "string" || PRESETS[ref] || ref.startsWith("plugin:")) return;
    if (naming && Object.hasOwn(named, ref)) return;
    refs.push({ path, ref, what: "the provider file" });
  };
  for (const [name, ref] of Object.entries(named)) provider(ref, ["providers", name], false);
  provider(data.provider, ["provider"], true);
  if (typeof data.prices === "string") refs.push({ path: ["prices"], ref: data.prices, what: "the prices file" });
  for (const [t, test] of listOf(data.tests).entries()) {
    if (!isObject(test)) continue;
    provider(test.provider, ["tests", t, "provider"], true);
    if (typeof test.data === "string") refs.push({ path: ["tests", t, "data"], ref: test.data, what: "the data file" });
    else if (typeof test.data?.file === "string") refs.push({ path: ["tests", t, "data", "file"], ref: test.data.file, what: "the data file" });
    const checks = [
      ...listOf(test.turns).flatMap((turn, i) => listOf(turn?.expect).map((check, c) => [check, ["tests", t, "turns", i, "expect", c]])),
      ...listOf(test.expect_conversation).map((check, c) => [check, ["tests", t, "expect_conversation", c]]),
    ];
    for (const [check, path] of checks) {
      if (isObject(check) && check.enabled !== false && typeof check.schema === "string") refs.push({ path: [...path, "schema"], ref: check.schema, what: "the schema file" });
    }
  }
  for (const [i, entry] of listOf(data.plugins).entries()) if (typeof entry === "string" && isPluginPath(entry)) refs.push({ path: ["plugins", i], ref: entry, what: "the plugin" });
  return refs;
}

// The modules a script imports by a relative path (./x.js, ../lib/y.js): static imports and exports
// (`import … from`, `import "…"`, `export … from`) and dynamic imports of a plain string. Read from its
// text, so one in a comment counts too, and one built as it runs doesn't. Packages aren't files here.
const IMPORTS = /(?:^|[^\w$.])(?:import|export)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?["']([^"'\n]+)["']|\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
export function relativeImports(text) {
  const out = new Set();
  for (const m of String(text ?? "").matchAll(IMPORTS)) {
    const spec = m[1] ?? m[2];
    if (/^\.{1,2}\//.test(spec)) out.add(spec);
  }
  return [...out];
}

// A plugin's file and every file it imports by a relative path, theirs too: { files, problems }
// (problems: an import that isn't there, or is outside the folder)
export async function moduleFiles(host, file) {
  const files = [];
  const problems = [];
  const seen = new Set();
  const visit = async (at) => {
    if (seen.has(at)) return;
    seen.add(at);
    files.push(at);
    let text;
    try {
      text = await host.files.read(at);
    } catch {
      return;
    }
    for (const spec of relativeImports(text)) {
      if (climbsOut(at, spec)) {
        problems.push({ file: at, message: `it imports ${spec}, which isn't in the folder (only files in it are copied)` });
        continue;
      }
      const target = joinPath(at, spec);
      // (as a bundler would: the path as it's written, else with .js or .mjs)
      const found = await firstThere(host, /\.[cm]?js$|\.json$/i.test(target) ? [target] : [target, `${target}.js`, `${target}.mjs`]);
      if (found) await visit(found);
      else problems.push({ file: at, message: `it imports ${spec}, which isn't there` });
    }
  };
  await visit(file);
  return { files, problems };
}

async function firstThere(host, paths) {
  for (const p of paths) if (await host.files.exists(p)) return p;
  return null;
}

// Every file the suites use, from the host's root: { files (sorted), problems: [{ file, message }]
// (a file one names that isn't there), packages (plugin packages they name: installed where they run,
// not copied) }. The folder's plugins are loaded (each in its worker, then stopped) only when a suite
// uses a name its own entries don't give, to know each one's name; one that can't be loaded is known
// by its file's name.
export async function dependencies(host, suiteFiles) {
  const files = new Set();
  const problems = [];
  const packages = new Set();
  const said = new Set();
  const problem = (file, message) => {
    const key = `${file}\u0000${message}`;
    if (!said.has(key) && said.add(key)) problems.push({ file, message });
  };
  const addModule = async (file) => {
    const found = await moduleFiles(host, file);
    for (const f of found.files) files.add(f);
    for (const p of found.problems) problem(p.file, p.message);
  };
  let folder = null;  // the folder's plugins by name: name → file
  const folderPlugins = async () => {
    if (folder) return folder;
    folder = new Map();
    const all = (await folderPluginFiles(host)).sort();
    const loaded = await loadPlugins(host, all, null);
    loaded.close();
    for (const plugin of Object.values(loaded.plugins)) folder.set(plugin.meta.name, plugin.file);
    for (const file of all) {
      const name = basename(file).replace(/\.m?js$/i, "");
      if (![...folder.values()].includes(file) && !folder.has(name)) folder.set(name, file);
    }
    return folder;
  };
  for (const file of [...new Set(suiteFiles)]) {
    if (!(await host.files.exists(file))) {
      problem(file, "the suite isn't there");
      continue;
    }
    files.add(file);
    const suite = await loadSuite(host, file);
    const data = suite.data ?? parseText(suite.text ?? "", file).data;
    const own = new Set();  // the names the suite's own plugin entries give
    for (const { ref, what } of fileRefs(data)) {
      if (climbsOut(file, ref)) {
        problem(file, `${what} ${ref} isn't in the folder (only files in it are copied)`);
        continue;
      }
      const target = joinPath(file, ref);
      if (!(await host.files.exists(target))) {
        problem(file, `${what} ${ref} isn't there`);
        continue;
      }
      if (what === "the plugin") {
        await addModule(target);
        const loaded = await loadPlugins(host, [target], null);
        loaded.close();
        for (const plugin of Object.values(loaded.plugins)) own.add(plugin.meta.name);
        own.add(basename(target).replace(/\.m?js$/i, ""));
      } else files.add(target);
    }
    for (const entry of listOf(data?.plugins)) if (typeof entry === "string" && !isPluginPath(entry)) packages.add(entry);
    // The folder's plugins it uses by name (its providers' kinds and fixtures, its judges', its checks'
    // types: pluginNames), less the ones its own entries give
    const wanted = [...namesUsed(suite)].filter((name) => !own.has(name));
    if (!wanted.length) continue;
    const byName = await folderPlugins();
    for (const name of wanted) {
      const at = byName.get(name);
      if (at) await addModule(at);
      else problem(file, `it uses the plugin "${name}", which isn't in the folder's plugins/ or the suite's plugins`);
    }
  }
  return { files: [...files].sort(), problems, packages: [...packages].sort() };
}

// The plugins a suite uses by name: pluginNames (its providers', their fixtures', its judges', its
// checks' types), and for a suite whose providers couldn't all be read, what its text names directly
function namesUsed(suite) {
  const names = pluginNames(suite);
  for (const config of [suite.data?.provider, ...Object.values(isObject(suite.data?.providers) ? suite.data.providers : {})]) {
    if (!isObject(config)) continue;
    const m = typeof config.kind === "string" && config.kind.match(/^plugin:([^@]+)/);
    if (m) names.add(m[1]);
    const lists = fixturesOf(config);
    for (const phase of FIXTURE_PHASES) for (const ref of lists[phase]) names.add(ref.name);
  }
  return names;
}

// A free name for a file beside the one there: name-2.yml, name-3.yml… (a suite keeps its .hafen.yml)
export function freeName(path, taken) {
  const ext = path.match(SUITE_FILE)?.[0] ?? path.match(/\.[^./\\]+$/)?.[0] ?? "";
  const stem = path.slice(0, path.length - ext.length);
  for (let n = 2; ; n++) {
    const next = `${stem}-${n}${ext}`;
    if (!taken(next)) return next;
  }
}

// A suite's text pointed at files written under another name (renames: Map of path → its new path,
// from the root): each reference to one of them names the new file, in the same folder, comments kept
export function retarget(text, file, renames) {
  const data = parseText(text, file).data;
  const edits = [];
  for (const { path, ref } of fileRefs(data)) {
    const to = renames.get(joinPath(file, ref));
    if (to) edits.push({ op: "set", path, value: ref.replace(/[^/\\]+$/, basename(to)) });
  }
  return edits.length ? editText(text, file, edits) : text;
}
