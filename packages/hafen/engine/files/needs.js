// What a suite needs from whoever runs it: the secrets it uses ({{secret.NAME}}, and a preset's own
// key), the environment's values ({{env.NAME}}), and the variables nothing in its files sets; and the
// problems with each that stop a run before anything is sent (problemsFor).

import { isObject } from "../util.js";
import { missingMessage, references, secretsWhere, valueAt } from "../vars.js";
import { BUILTIN_HEADS, BUILTINS, listOf, positionIn, REF_HEADS, refPath, USES, usePlaces } from "./places.js";

// Every secret a suite will need: in its files ({{secret.NAME}}), and the presets' and System One's
// default keys
const DEFAULT_KEYS = { "openai-chat": "OPENAI_API_KEY", "openai-responses": "OPENAI_API_KEY", "anthropic-messages": "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" };

export const secretsNeeded = (suite, environment) => secretUses(suite, environment).map((use) => use.name);

// A suite's data as a run with this environment reads it: of its environments, only the chosen one's
// (environment: { name } the chosen one, null none; undefined, all of them: every name any could need)
function chosenData(suite, environment) {
  const data = suite.data ?? {};
  if (environment === undefined || !isObject(data.environments)) return data;
  const name = environment?.name;
  return { ...data, environments: name && Object.prototype.hasOwnProperty.call(data.environments, name) ? { [name]: data.environments[name] } : {} };
}

// The same, each where it's first used: [{ name, file, line?, column? }]. A {{secret.NAME}} where it's
// written (the suite, or the provider file it's in); a preset's default key at its provider's kind (or
// where the suite names the preset); System One's at its judge (with none declared, at the first check
// that asks it). environment: the chosen one (its block of environments only), as chosenData
export function secretUses(suite, environment = undefined) {
  const uses = new Map();
  const use = (name, file, at) => { if (!uses.has(name)) uses.set(name, { name, file, ...at }); };
  // (a check turned off doesn't need its key: it's left out, as runningData leaves it out)
  for (const [name, at] of usePlaces(USES.secret, suite.parsed, suite.text, chosenData(suite, environment))) use(name, suite.file, at);
  for (const [key, config] of Object.entries(suite.providers ?? {})) {
    const own = suite.providerFiles?.[key];
    const places = own ? suite.providerPlaces?.[own] : null;
    for (const n of references(config).env) use(n, own ?? suite.file, places?.secret?.[n] ?? {});
    if (DEFAULT_KEYS[config.kind] && config.api_key === undefined) use(DEFAULT_KEYS[config.kind], own ?? suite.file, own ? places?.kind ?? {} : positionIn(suite, [...refPath(key), "kind"]));
  }
  const asks = [];
  for (const [t, test] of listOf(suite.data?.tests).entries()) {
    for (const [i, turn] of listOf(test?.turns).entries()) for (const [c, check] of listOf(turn?.expect).entries()) asks.push([check, ["tests", t, "turns", i, "expect", c]]);
    for (const [c, check] of listOf(test?.expect_conversation).entries()) asks.push([check, ["tests", t, "expect_conversation", c]]);
  }
  const asked = asks.find(([check]) => check?.enabled !== false && String(check?.type ?? "").startsWith("systemone."));
  if (asked) {
    const keyless = Object.entries(suite.data?.judges ?? {}).find(([, j]) => j?.kind === "systemone" && j?.api_key === undefined);
    if (!suite.data?.judges?.default || keyless) use("JEV_API_KEY", suite.file, positionIn(suite, keyless ? ["judges", keyless[0], "kind"] : [...asked[1], "type"]));
  }
  return [...uses.values()];
}

// The {{env.NAMES}} a suite uses, each where it's first used: [{ name, file, line?, column? }]
// (environment: the chosen one, as secretUses)
export const envUses = (suite, environment = undefined) => usesOf(suite, USES.environment, "environment", (config) => references(config).environment, environment);

function usesOf(suite, uses, key, names, environment) {
  const out = new Map();
  const use = (name, file, at) => { if (!out.has(name)) out.set(name, { name, file, ...at }); };
  for (const [name, at] of usePlaces(uses, suite.parsed, suite.text, chosenData(suite, environment))) use(name, suite.file, at);
  for (const [k, config] of Object.entries(suite.providers ?? {})) {
    const own = suite.providerFiles?.[k];
    const places = own ? suite.providerPlaces?.[own] : null;
    for (const n of names(config)) use(n, own ?? suite.file, places?.[key]?.[n] ?? {});
  }
  return [...out.values()];
}

// A suite's data as it runs: its checks turned off (enabled: false) left out, as they're never looked at
export function runningData(data) {
  if (!isObject(data)) return data;
  const on = (list) => (Array.isArray(list) ? list.filter((c) => c?.enabled !== false) : list);
  const steps = (list) => (Array.isArray(list) ? list.map((step) => (isObject(step) && Array.isArray(step.expect) ? { ...step, expect: on(step.expect) } : step)) : list);
  const tests = Array.isArray(data.tests) ? data.tests.map((t) => (!isObject(t) ? t : {
    ...t,
    setup: steps(t.setup),
    teardown: steps(t.teardown),
    expect_conversation: on(t.expect_conversation),
    turns: Array.isArray(t.turns) ? t.turns.map((u) => (isObject(u) && Array.isArray(u.expect) ? { ...u, expect: on(u.expect) } : u)) : t.turns,
  })) : data.tests;
  return { ...data, setup: steps(data.setup), teardown: steps(data.teardown), tests };
}

// The {{env.NAMES}} a suite uses, in its file and its providers'
export function envNeeded(suite) {
  const names = references(runningData(suite.data ?? {})).environment;
  for (const config of Object.values(suite.providers ?? {})) references(config, { vars: new Set(), env: new Set(), environment: names });
  return [...names];
}

// Whether the chosen environment has a value for {{env.NAME}}: in the values given, else the suite's
// environment of its name. environment: { name, values, suite? }
export const envHas = (environment, name) => [environment?.values, environment?.suite].some((values) => {
  const value = valueAt(values ?? {}, name);
  return value !== undefined && value !== null;
});

// The {{name}}s a suite uses that only its environments' values give (none of its variables, no
// extraction or setup step's, not one the run gives: vars), the chosen one's lacking it (environment:
// { name, suite? }, or null), each where it's first used: [{ name, file, line?, column? }]
function envOnlyUses(suite, environment, vars = {}) {
  const data = suite.data ?? {};
  const blocks = isObject(data.environments) ? Object.values(data.environments).filter(isObject) : [];
  const given = new Set(blocks.flatMap((b) => Object.keys(b)));
  if (!given.size) return [];
  const extracted = (steps) => listOf(steps).flatMap((s) => Object.keys(s?.extract ?? {}));
  const set = new Set([...Object.keys(isObject(data.variables) ? data.variables : {}), ...Object.keys(vars), ...extracted(data.setup), ...listOf(data.tests).flatMap((t) => [...extracted(t?.setup), ...extracted(t?.turns)])]);
  const chosen = isObject(environment?.suite) ? environment.suite : {};
  const only = (name) => {
    const head = name.split(".")[0];
    return !REF_HEADS.has(head) && !BUILTINS.has(name) && !BUILTIN_HEADS.has(head) && given.has(head) && !set.has(head) && !Object.prototype.hasOwnProperty.call(chosen, head);
  };
  const out = new Map();
  const use = (name, file, at) => { if (!out.has(name.split(".")[0])) out.set(name.split(".")[0], { name: name.split(".")[0], file, ...at }); };
  const { environments: _all, ...rest } = runningData(data);
  for (const [name, at] of usePlaces(USES.vars, suite.parsed, suite.text, rest)) if (only(name)) use(name, suite.file, at);
  for (const [key, config] of Object.entries(suite.providers ?? {})) {
    const own = suite.providerFiles?.[key];
    const places = own ? suite.providerPlaces?.[own]?.vars ?? {} : Object.fromEntries(usePlaces(USES.vars, suite.parsed, suite.text, config, refPath(key)));
    for (const name of references(config).vars) if (only(name)) use(name, own ?? suite.file, places[name] ?? {});
  }
  return [...out.values()];
}

const envOnlyMessage = (suite, name, environment) => {
  const which = Object.entries(suite.data.environments).filter(([, b]) => isObject(b) && Object.prototype.hasOwnProperty.call(b, name)).map(([n]) => `"${n}"`);
  const give = `of the suite's environments, ${which.join(", ")} ${which.length === 1 ? "gives" : "give"} it`;
  return `{{${name}}} isn't set: ${give}, ${environment?.name ? `not "${environment.name}"` : "and none of them is chosen"}`;
};

// The problems a run would have: the suite's errors, and the variables nothing sets, unless the run
// gives them (vars: names given at run time, as --var does); with secrets, the secrets it needs; with
// environment (the chosen one, { name, values, suite? }, or null: none), the {{env.NAMES}} it
// hasn't, less those its providers' fixtures set with env.set (envGiven: a Set). (Each said where
// it's first used: the suite, or a provider file)
export function problemsFor(suite, vars = {}, secrets = null, environment = undefined, secretsFrom = undefined, envGiven = new Set()) {
  const problems = [...(suite.errors ?? []), ...(suite.missing ?? []).filter((m) => !(m.variable in vars))];
  const set = (value) => value !== undefined && value !== null && value !== "";
  // (of the suite's environments, only the chosen one's values are read: a name only another's
  // uses isn't this run's)
  if (environment !== undefined && !problems.length) {
    for (const { name, ...where } of envUses(suite, environment)) {
      if (!envGiven.has(name) && (!environment || !envHas(environment, name))) problems.push({ ...where, variable: `env.${name}`, message: missingMessage(name, "environment", environment ? environment.name ?? "" : null) });
    }
  }
  // A {{name}} only the suite's environments give: the chosen one's must have it (with no scope, or
  // another, none of theirs is read: it would stop the turn that uses it, so it's said here)
  if (environment !== undefined && !problems.length) {
    for (const { name, ...where } of envOnlyUses(suite, environment, vars)) problems.push({ ...where, variable: name, message: envOnlyMessage(suite, name, environment) });
  }
  if (secrets && !problems.length) {
    // (each said where it's first used: the suite, or a provider file)
    for (const { name, ...where } of secretUses(suite, environment)) {
      if (!set(secrets(name))) problems.push({ ...where, variable: name, message: missingMessage(name, "secret", secretsWhere(environment, secretsFrom)) });
    }
  }
  return problems;
}
