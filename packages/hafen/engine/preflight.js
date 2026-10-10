// What stops a run before anything is sent: a run's check, and `hafen validate`'s, so the two can't
// disagree.

import { CHECK_TYPES, isBuiltIn, typeOf } from "./checks/index.js";
import { environmentOf, unknownEnvironment } from "./environment.js";
import { problemsFor } from "./files/needs.js";
import { positionIn } from "./files/places.js";
import { fixtureEnvSets, fixtureProvides, folderPluginFiles, loadPlugins, pluginNames, pluginSecretProblems, versionProblems } from "./plugins.js";
import { pluginsWhere } from "./plugin-place.js";
import { basename, closest } from "./util.js";

// Everything that stops a run before anything is sent, for each suite: its files' problems, the
// variables nothing sets, its environment's names ({{env.NAME}}) and its secrets (problemsFor); its
// plugins, loaded (each in its worker), every name it uses that none gives (a provider, a fixture, a
// judge, a check type), and the secrets and environment's names they write in their code; an
// environment or scope --env names that isn't there. A run's check, and
// `validate`'s: so the two can't disagree.
//
// secretsFor(envName) → (NAME) → value: where secrets come from (validate without --env-check gives
// a stand-in for each, to check everything but them). used: the run's secret values, for redaction:
// each one found here is added, so it's hidden from the run's first event. Returns { problems,
// suitePlugins (file → loaded), close() }: close ends the plugins' workers.
export async function preflight({ suites, host, options = {}, plugins = {}, secretsFor = (envName) => (name) => host.secrets(name, { env: envName }), used = new Set() }) {
  // Each suite's plugins, loaded (each in its worker) before anything is sent: the ones it names, and
  // the folder's (plugins/*.js, as Settings → Plugins lists them), which any suite may use by name
  // without naming them. The folder's are loaded once (for each scope's secrets), and only when a
  // suite uses a name its own don't give.
  const suitePlugins = new Map();
  const folderPlugins = new Map();  // scope name → loaded
  const folderFor = async (envName) => {
    if (!folderPlugins.has(envName)) {
      const files = await folderPluginFiles(host);
      folderPlugins.set(envName, await loadPlugins(host, files, null, { secrets: secretsFor(envName), used, transport: host.transport }));
    }
    return folderPlugins.get(envName);
  };
  const close = () => {
    for (const loaded of [...suitePlugins.values(), ...folderPlugins.values()]) loaded.close();
  };

  const problems = [];
  for (const s of suites) {
    const from = problems.length;
    const { envName, environment } = environmentOf(s, options);
    const unknown = await unknownEnvironment(s, options, host);
    if (unknown) problems.push({ file: s.file, ...positionIn(s, ["environments"]), message: unknown });
    const loaded = (s.data?.plugins ?? []).length
      ? await loadPlugins(host, s.data.plugins, s.file, { secrets: secretsFor(envName), used, transport: host.transport })
      : { plugins: {}, problems: [], close: () => {} };
    suitePlugins.set(s.file, loaded);
    // (a plugin that didn't load is said once, as why: not again as a name nothing gives)
    const failed = new Set(loaded.problems.map((p) => pluginFileName(p.file)));
    const missing = [...pluginNames(s)].filter((name) => !loaded.plugins[name] && !plugins[name]);
    if (missing.length) {
      const folder = await folderFor(envName);
      for (const name of missing) {
        if (folder.plugins[name]) loaded.plugins[name] = folder.plugins[name];
        // (one that didn't load, its file named as the plugin: why)
        else {
          const why = folder.problems.filter((p) => pluginFileName(p.file) === name);
          if (why.length) failed.add(name);
          problems.push(...why.map((p) => ({ ...p, file: s.file, message: `${p.file}: ${p.message}` })));
        }
      }
    }
    const all = { ...plugins, ...loaded.plugins };
    // (one of its own that didn't load: said at its entry in plugins)
    const entries = s.data?.plugins ?? [];
    problems.push(...loaded.problems.map(({ entry, ...p }) => ({ ...p, ...(p.file === s.file && entries.includes(entry) ? positionIn(s, ["plugins", entries.indexOf(entry)]) : {}) })), ...versionProblems(s, all), ...namedPluginProblems(s, all, failed));
    // (a name a provider's fixture gives is set, though only once the fixture has run; and so is an
    // {{env.NAME}} one sets with env.set)
    const given = fixtureProvides(Object.values(s.providers ?? {}), all);
    const envGiven = fixtureEnvSets(Object.values(s.providers ?? {}), all);
    // (each secret found is hidden from here on, wherever it shows: what's said before a turn fills it
    // in too, a row's name from its data file)
    const secret = (name) => {
      const value = secretsFor(envName)(name);
      if (typeof value === "string" && value) used.add(value);
      return value;
    };
    problems.push(...problemsFor(s, options.vars ?? {}, (name) => (given.has(name) ? "(a fixture's)" : secret(name)), environment, options.secretsFrom, envGiven));
    // The secrets its plugins name in their code ("{{secret.ACME_PASSWORD}}") and the environment's
    // values they write ({{env.NAME}}), as its files' are: one that isn't set stops the run here, not
    // once a fixture has sent its request
    if (problems.length === from) problems.push(...pluginSecretProblems(s, all, given, secret, environment, options.secretsFrom, envGiven));
    // (each says which suite it's of: its file can be a provider's, a data file's or a plugin's)
    for (let k = from; k < problems.length; k++) problems[k] = { ...problems[k], suite: s.file };
  }
  return { problems, suitePlugins, close };
}

const pluginFileName = (file) => basename(file ?? "").replace(/\.m?js$/i, "");

// A suite's checks whose type is neither Hafen's nor a check plugin's, and its judges whose plugin
// isn't there: said before anything is sent, not once the reply is in. (failed: plugins that
// didn't load, said already.) A check turned off is never looked at.
function namedPluginProblems(suite, plugins, failed) {
  const out = [];
  const checkPlugins = Object.keys(plugins).filter((name) => plugins[name]?.kind === "check");
  const each = (checks, path) => {
    for (const [c, check] of (Array.isArray(checks) ? checks : []).entries()) {
      if (!check || typeof check !== "object" || check.enabled === false || isBuiltIn(check)) continue;
      const type = typeOf(check);
      if (failed.has(type)) continue;
      const plugin = plugins[type];
      if (plugin?.kind === "check") continue;
      const where = { file: suite.file, ...positionIn(suite, [...path, c, "type"]) };
      if (plugin) out.push({ ...where, message: `the plugin "${type}" is a ${plugin.kind}, not a check` });
      else {
        const meant = closest(type, [...CHECK_TYPES, ...checkPlugins]);
        out.push({ ...where, message: `"${type}" isn't a check type${meant ? ` (did you mean "${meant}"?)` : `, or a check plugin in ${pluginsWhere()}`}` });
      }
    }
  };
  for (const [t, test] of (Array.isArray(suite.data?.tests) ? suite.data.tests : []).entries()) {
    for (const [i, turn] of (Array.isArray(test?.turns) ? test.turns : []).entries()) each(turn?.expect, ["tests", t, "turns", i, "expect"]);
    each(test?.expect_conversation, ["tests", t, "expect_conversation"]);
  }
  for (const [name, judge] of Object.entries(suite.data?.judges ?? {})) {
    if (judge?.kind !== "plugin" || !judge.plugin || failed.has(judge.plugin)) continue;
    const plugin = plugins[judge.plugin];
    const where = { file: suite.file, ...positionIn(suite, ["judges", name, "plugin"]) };
    if (!plugin) out.push({ ...where, message: `the judge "${name}" uses the plugin "${judge.plugin}", which isn't in ${pluginsWhere()}` });
    else if (plugin.kind !== "judge") out.push({ ...where, message: `the plugin "${judge.plugin}" is a ${plugin.kind}, not a judge` });
  }
  return out;
}
