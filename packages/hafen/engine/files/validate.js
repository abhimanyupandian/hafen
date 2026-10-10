// What's wrong with a suite or provider file, beyond whether it parses: its schema's errors, keys Hafen
// doesn't know (each with the one it most likely meant), every path, pattern, judge and {{variable}}
// it uses, and names that can't be used. Each problem has its file, line and column.

import { isMap } from "yaml";
import { problem as pathProblem } from "../jsonpath.js";
import { closest, isObject } from "../util.js";
import { badName, references, refOf } from "../vars.js";
import { regex } from "../checks/operators.js";
import { confidenceProblem, isBuiltIn, lacking } from "../checks/index.js";
import suiteSchema from "./schema/suite.js";
import providerSchema from "./schema/provider.js";
import { BUILTIN_HEADS, BUILTINS, listOf, position, REF_HEADS, refPath, USES, usePlaces } from "./places.js";

export const pathOf = (instancePath) => instancePath.split("/").slice(1).map((p) => (/^\d+$/.test(p) ? Number(p) : p.replace(/~1/g, "/").replace(/~0/g, "~")));

// (Each schema error also says where it is, `at`, and, for a key missing, which keys would do,
// `needs`: so an unknown key that's one of them misspelled can be the one problem shown.
// loadSuite takes both off.)
export function schemaErrors(validate, data, parsed, file) {
  if (validate(data)) return [];
  const all = validate.errors ?? [];
  // anyOf/oneOf report every branch. Branches that each only need a key are one problem ("needs one
  // of: …"); otherwise the most specific error per place is kept
  const folded = new Map();  // a branch's error → its anyOf/oneOf's
  for (const choice of all.filter((e) => ["anyOf", "oneOf"].includes(e.keyword))) {
    const branches = all.filter((e) => e !== choice && e.instancePath === choice.instancePath && e.schemaPath.startsWith(`${choice.schemaPath}/`));
    if (branches.length && branches.every((e) => e.keyword === "required")) {
      choice.needs = [...new Set(branches.map((e) => e.params.missingProperty))];
      for (const e of branches) folded.set(e, choice);
      folded.set(choice, choice);
    }
  }
  const seen = new Set();
  const out = [];
  for (const e of all) {
    const choice = folded.get(e);
    if (choice) {
      if (seen.has(choice)) continue;
      seen.add(choice);
    } else if (["anyOf", "oneOf", "if"].includes(e.keyword) && all.length !== 1) continue;
    const path = pathOf(e.instancePath);
    const where = path.length ? `${path.join(".")}: ` : "";
    const detail = choice ? `needs one of: ${choice.needs.join(", ")}` : e.keyword === "additionalProperties" ? `unknown key "${e.params.additionalProperty}"` : e.keyword === "enum" ? `${e.message} (${e.params.allowedValues.join(", ")})` : e.message;
    const error = { file, ...position(parsed, path), message: `${where}${detail}`, at: path.join(".") };
    if (choice) error.needs = choice.needs;
    else if (e.keyword === "required") error.needs = [e.params.missingProperty];
    const key = `${error.line}:${error.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(error);
  }
  return out;
}

// What the schema can't say: every path parses, every pattern compiles, every judge exists, every
// check has what its type needs, and every {{variable}} can be found where it's used. (keys: the
// unknown keys' problems, so a check's field that one most likely meant isn't said again)
export function deepChecks(suite, keys = []) {
  const { data, parsed, file } = suite;
  const errors = [];
  const missing = [];
  const at = (path, message) => errors.push({ file, ...position(parsed, path), message });
  const unset = (path, name, message) => missing.push({ file, ...position(parsed, path), variable: name.split(".")[0], message });
  const envNames = new Set(Object.values(data.environments ?? {}).flatMap((e) => Object.keys(e ?? {})));
  const suiteVars = new Set([...Object.keys(data.variables ?? {}), ...envNames]);
  const fromSetup = new Set((data.setup ?? []).flatMap((s) => Object.keys(s.extract ?? {})));

  const checkVars = (value, path, known) => {
    for (const name of references(value).vars) {
      const head = name.split(".")[0];
      // ({{env.…}}, {{secret.…}}: the environment's and the secrets, checked when it runs)
      if (REF_HEADS.has(head) || known.has(name) || BUILTINS.has(name) || (BUILTIN_HEADS.has(head) && head !== "row")) continue;
      if (head === "row") {
        if (!known.has("row")) at(path, `{{${name}}} needs a data file on the test`);
        continue;
      }
      unset(path, name, `{{${name}}} isn't set anywhere before it's used (variables, environments, an extract or a setup step)`);
    }
  };
  // A field its type needs (a tool.called's tool, a length's limit): without it, a check would pass
  // having looked at nothing. Said at the check
  const lacks = (check, path) => {
    const why = lacking(check, data.judges, keys.filter((k) => k.at === path.join(".") && k.suggest).map((k) => k.suggest));
    if (why) at(path, why);
    // (a confidence on a check that has none, or with an unsure_below it makes do nothing: at that key)
    const confidence = confidenceProblem(check);
    if (confidence.message) at([...path, confidence.key], confidence.message);
  };
  const checkCheck = (check, path) => {
    if (check.path) {
      const p = pathProblem(check.path);
      if (p) at([...path, "path"], p);
    }
    if (typeof check.matches === "string") {
      try { regex(check.matches); } catch (err) { at([...path, "matches"], err.message); }
    }
    if (check.judge && !(data.judges ?? {})[check.judge]) at([...path, "judge"], `there's no judge named "${check.judge}"`);
    for (const p of Object.keys(check.args ?? {})) {
      const problem = pathProblem(p);
      if (problem) at([...path, "args"], problem);
    }
    lacks(check, path);
  };
  // (a setup or teardown step's checks, on its response: what their types need)
  const stepChecks = (steps, path) => {
    for (const [s, step] of listOf(steps).entries()) for (const [c, check] of listOf(step?.expect).entries()) if (check?.enabled !== false) lacks(check, [...path, s, "expect", c]);
  };
  for (const [name, judge] of Object.entries(data.judges ?? {})) {
    if (judge?.kind === "llm" && !(data.providers ?? {})[judge.provider]) at(["judges", name, "provider"], `the judge "${name}" names the provider "${judge.provider}", which isn't under providers`);
  }
  for (const [s, step] of (data.setup ?? []).entries()) {
    checkVars(step.request, ["setup", s, "request"], new Set([...suiteVars, ...fromSetup]));
    for (const [v, p] of Object.entries(step.extract ?? {})) { const problem = pathProblem(p); if (problem) at(["setup", s, "extract", v], problem); }
  }
  stepChecks(data.setup, ["setup"]);
  stepChecks(data.teardown, ["teardown"]);
  for (const [t, test] of (data.tests ?? []).entries()) {
    const known = new Set([...suiteVars, ...fromSetup]);
    if (test.data) known.add("row");
    // (a row's name is filled in before the test's setup steps: what they extract isn't there yet; one
    // with no data file is said by rowNameProblems)
    if (test.data && test.row_name !== undefined) checkVars(test.row_name, ["tests", t, "row_name"], known);
    stepChecks(test.setup, ["tests", t, "setup"]);
    stepChecks(test.teardown, ["tests", t, "teardown"]);
    for (const [s, step] of (test.setup ?? []).entries()) {
      checkVars(step.request, ["tests", t, "setup", s, "request"], known);
      Object.keys(step.extract ?? {}).forEach((k) => known.add(k));
    }
    for (const [i, turn] of (test.turns ?? []).entries()) {
      checkVars(turn.user, ["tests", t, "turns", i, "user"], known);
      for (const [c, check] of (turn.expect ?? []).entries()) {
        // (A check turned off is never looked at, so it can't stop a run)
        if (check?.enabled === false) continue;
        checkVars(check, ["tests", t, "turns", i, "expect", c], known);
        checkCheck(check, ["tests", t, "turns", i, "expect", c]);
      }
      for (const [v, p] of Object.entries(turn.extract ?? {})) {
        const problem = pathProblem(p);
        if (problem) at(["tests", t, "turns", i, "extract", v], problem);
        known.add(v);
      }
    }
    for (const [c, check] of (test.expect_conversation ?? []).entries()) if (check?.enabled !== false) checkCheck(check, ["tests", t, "expect_conversation", c]);
    for (const [s, step] of (test.teardown ?? []).entries()) checkVars(step.request, ["tests", t, "teardown", s, "request"], known);
  }
  // Providers' templates can use the suite's variables (and their own: user, messages, session)
  for (const [name, config] of Object.entries(suite.providers)) {
    const known = new Set([...suiteVars, ...fromSetup, ...(data.tests ?? []).flatMap((t) => [...(t.turns ?? []).flatMap((u) => Object.keys(u.extract ?? {})), ...(t.setup ?? []).flatMap((s) => Object.keys(s.extract ?? {}))])]);
    if ((data.tests ?? []).some((t) => t.data)) known.add("row");
    const where = suite.providerFiles[name];
    // (each said where it's first written: in the provider file, or in the suite)
    const places = where ? suite.providerPlaces[where]?.vars ?? {} : Object.fromEntries(usePlaces(USES.vars, parsed, suite.text, config, refPath(name)));
    for (const v of references(config).vars) {
      const head = v.split(".")[0];
      if (REF_HEADS.has(head) || known.has(v) || known.has(head) || BUILTINS.has(v) || BUILTIN_HEADS.has(head)) continue;
      missing.push({ file: where ?? file, ...places[v], variable: head, message: `the provider${name && !name.startsWith("test:") ? ` "${name}"` : ""} uses {{${v}}}, which the suite doesn't set` });
    }
  }
  return { errors, missing };
}

// The {{secret.NAME}}s and {{env.NAME}}s whose NAME isn't a name, each where it's first written (the
// suite's, then its provider files')
export function badNames(suite) {
  const out = [];
  const seen = new Set();
  const say = (file, at, message) => {
    if (seen.has(`${file}\u0000${message}`)) return;
    seen.add(`${file}\u0000${message}`);
    out.push({ file, ...at, message });
  };
  for (const [name, at] of usePlaces(USES.badName, suite.parsed, suite.text, suite.data ?? {})) say(suite.file, at, badName(refOf(name)));
  for (const own of new Set(Object.values(suite.providerFiles ?? {}))) {
    const places = suite.providerPlaces?.[own] ?? {};
    for (const [name, at] of Object.entries(places.badName ?? {})) say(own, at, badName(refOf(name)));
  }
  return out;
}

const KNOWN = {
  top: ["version", "name", "group", "provider", "providers", "environments", "variables", "judges", "defaults", "setup", "teardown", "plugins", "prices", "redact", "tests"],
  test: ["name", "id", "tags", "group", "provider", "data", "row_name", "setup", "teardown", "turns", "expect_conversation", "repeat", "pass_rate", "history", "on_fail", "unsure", "unsure_below", "timeout_ms", "retries"],
  turn: ["user", "reply", "extract", "tools", "expect"],
  step: Object.keys(suiteSchema.$defs.step.properties),
  check: Object.keys(suiteSchema.$defs.check.properties),
  provider: Object.keys(providerSchema.properties),
  response: Object.keys(providerSchema.properties.response.properties),
  event: Object.keys(providerSchema.$defs.eventRule.properties),
};

// A key of the user's own, which Hafen keeps and doesn't read: x-owner, x-ticket
const OWN_KEY = /^x-/;

// The keys in a map that Hafen doesn't know, each a problem: one misspelled would do nothing, and say
// nothing (an `expcet:` whose checks never run, and a test that passes). Each says which key it
// most likely meant ({ at: the map's path, suggest }, for loadSuite; it takes them off). The file
// keeps them: they're problems, not deleted.
function keyProblems(obj, known, path, parsed, file) {
  if (!isObject(obj)) return [];
  return Object.keys(obj).filter((key) => !known.includes(key) && !OWN_KEY.test(key)).map((key) => {
    const suggest = closest(key, known);
    const hint = suggest ? `did you mean "${suggest}"?` : `keys of your own start with x-, as x-${key}`;
    return { file, ...keyPosition(parsed, path, key), message: `${path.length ? `${path.join(".")}: ` : ""}unknown key "${key}" (${hint})`, at: path.join("."), suggest };
  });
}

// Where a map's key is (its value can start on the line after it)
function keyPosition(parsed, path, key) {
  const map = parsed?.doc.getIn(path, true) ?? (path.length ? undefined : parsed?.doc.contents);
  const offset = isMap(map) ? map.items.find((pair) => pair.key?.value === key)?.key?.range?.[0] : undefined;
  if (offset === undefined) return position(parsed, [...path, key]);
  const { line, col } = parsed.lines.linePos(offset);
  return { line, column: col };
}

export function unknownKeys(data, parsed, file) {
  if (!isObject(data)) return [];
  const out = keyProblems(data, KNOWN.top, [], parsed, file);
  const checks = (list, path) => {
    for (const [c, check] of listOf(list).entries()) {
      // (a check plugin's checks take what fields it wants)
      if (isObject(check) && isBuiltIn(check)) out.push(...keyProblems(check, KNOWN.check, [...path, c], parsed, file));
    }
  };
  const steps = (list, path) => listOf(list).forEach((step, s) => out.push(...keyProblems(step, KNOWN.step, [...path, s], parsed, file)));
  steps(data.setup, ["setup"]);
  steps(data.teardown, ["teardown"]);
  for (const [t, test] of listOf(data.tests).entries()) {
    out.push(...keyProblems(test, KNOWN.test, ["tests", t], parsed, file));
    if (!isObject(test)) continue;
    steps(test.setup, ["tests", t, "setup"]);
    steps(test.teardown, ["tests", t, "teardown"]);
    for (const [i, turn] of listOf(test.turns).entries()) {
      out.push(...keyProblems(turn, KNOWN.turn, ["tests", t, "turns", i], parsed, file));
      if (isObject(turn)) checks(turn.expect, ["tests", t, "turns", i, "expect"]);
    }
    checks(test.expect_conversation, ["tests", t, "expect_conversation"]);
  }
  return out;
}

// A provider's keys Hafen doesn't know (one of Hafen's kinds: a plugin's provider takes what it
// wants), at the top, in its response, and in its event rules. A provider with fixtures gives them
// its other keys as their settings (login_url, user): there, only a key that's one of Hafen's
// misspelled is a problem.
export function providerKeys(config, parsed, file, base = []) {
  if (!isObject(config) || String(config.kind ?? "").startsWith("plugin:")) return [];
  const settings = config.fixtures !== undefined;
  return [
    ...keyProblems(config, KNOWN.provider, base, parsed, file).filter((p) => !settings || p.suggest),
    ...keyProblems(config.response, KNOWN.response, [...base, "response"], parsed, file),
    ...listOf(config.events).flatMap((rule, i) => keyProblems(rule, KNOWN.event, [...base, "events", i], parsed, file)),
  ];
}

// A problem as it's shown: without what loadSuite sorts them by
export const bare = ({ at, needs, suggest, ...problem }) => problem;

// The schema's errors less the ones an unknown key explains (`expcet` for a missing `expect`, say)
export const unexplained = (errors, keys) => {
  const meant = new Set(keys.filter((k) => k.suggest).map((k) => `${k.at}\u0000${k.suggest}`));
  return errors.filter((e) => !e.needs?.some((n) => meant.has(`${e.at}\u0000${n}`)));
};

// Every check a test has (turned off ones too)
const checksOf = (test) => [...listOf(test?.turns).flatMap((turn) => listOf(turn?.expect)), ...listOf(test?.expect_conversation)];

// Problems across a suite's tests: two named the same (results, filters and reports find a test by its
// name). And a warning for a test that checks nothing: it passes whenever each turn gets a reply.
export function testProblems(data, parsed, file) {
  const errors = [];
  const warnings = [];
  const named = new Map();
  for (const [t, test] of listOf(data.tests).entries()) {
    if (!isObject(test)) continue;
    if (typeof test.name === "string") {
      if (named.has(test.name)) errors.push({ file, ...position(parsed, ["tests", t, "name"]), message: `tests.${t}.name: tests.${named.get(test.name)} is named "${test.name}" too: each test's name is its own` });
      else named.set(test.name, t);
    }
    if (Array.isArray(test.turns) && test.turns.length && !checksOf(test).some((c) => c?.enabled !== false)) {
      warnings.push({ file, ...position(parsed, ["tests", t]), message: `"${test.name ?? `tests.${t}`}" has no checks: it passes whenever each turn gets a reply` });
    }
  }
  return { errors, warnings };
}

// Names a suite can't give its own values: a variable (its own, or an environment's) or an extraction
// named env, secret or secrets (or env.…) would be out of reach, {{env.x}} being the environment's and
// {{secret.x}} a secret. (A data file's columns are {{row.col}}: any name does.)
const RESERVED = new Set(["env", "secret", "secrets"]);

export function reservedNames(data, parsed, file) {
  const out = [];
  const each = (map, path, what) => {
    for (const key of Object.keys(isObject(map) ? map : {})) {
      const head = key.split(".")[0];
      if (!RESERVED.has(head)) continue;
      const means = head === "env" ? "a value of the environment" : "a secret";
      out.push({ file, ...keyPosition(parsed, path, key), message: `${[...path, key].join(".")}: ${what} can't be called "${key}" ({{${head}.NAME}} is ${means}): call it something else` });
    }
  };
  each(data.variables, ["variables"], "a variable");
  for (const [name, values] of Object.entries(isObject(data.environments) ? data.environments : {})) each(values, ["environments", name], "a variable");
  const steps = (list, path) => listOf(list).forEach((step, s) => each(step?.extract, [...path, s, "extract"], "an extraction"));
  steps(data.setup, ["setup"]);
  steps(data.teardown, ["teardown"]);
  for (const [t, test] of listOf(data.tests).entries()) {
    steps(test?.setup, ["tests", t, "setup"]);
    steps(test?.teardown, ["tests", t, "teardown"]);
    for (const [i, turn] of listOf(test?.turns).entries()) each(turn?.extract, ["tests", t, "turns", i, "extract"], "an extraction");
  }
  return out;
}

// A test's row_name (contracts/test-file.md, Data rows): its rows' names, shown in every report, so it
// names a data file's row (a test without one has none), never holds a secret, and fills in only
// columns the data file has (each {{row.<column>}}, when its columns are known)
export function rowNameProblems(suite) {
  const { data, parsed, file } = suite;
  const out = [];
  for (const [t, test] of listOf(data?.tests).entries()) {
    if (!isObject(test) || typeof test.row_name !== "string") continue;
    const path = ["tests", t, "row_name"];
    const say = (at, message) => out.push({ file, ...at, message: `tests.${t}.row_name: ${message}` });
    if (!test.data) {
      say(keyPosition(parsed, ["tests", t], "row_name"), "row_name names a data row: this test has no data file (data)");
      continue;
    }
    for (const [name, at] of usePlaces(USES.secret, parsed, suite.text, test.row_name, path)) say(at, `a row's name can't hold a secret ({{secret.${name}}}): it's shown in every report`);
    const columns = suite.dataColumns?.[t]?.columns ?? [];
    if (!columns.length) continue;
    const ref = typeof test.data === "string" ? test.data : test.data.file;
    for (const [name, at] of usePlaces(USES.vars, parsed, suite.text, test.row_name, path)) {
      const [head, column] = name.split(".");
      if (head !== "row" || column === undefined || columns.includes(column)) continue;
      const meant = closest(column, columns);
      say(at, `{{row.${column}}} isn't a column of ${ref} (${meant ? `did you mean {{row.${meant}}}?` : `its columns: ${columns.join(", ")}`})`);
    }
  }
  return out;
}

/* ---------- editing in place ---------- */
