// Suite and provider files (contracts/test-file.md, contracts/provider.md): parsing YAML and JSON,
// checking them against their schemas with every problem's file, line and column, resolving what a
// suite names (providers, data files, prices, judges), and editing a suite in place: comments, key
// order and formatting stay as they were, so a one-field change is a one-line diff.
//
// Files come and go through the host: host.files.{read(path), write(path, text), exists(path)}.

import { isMap, isSeq, LineCounter, parseDocument, stringify } from "yaml";
import { problem as pathProblem } from "../jsonpath.js";
import { PRESETS } from "../providers/index.js";
import { validateProviderSchema, validateSuiteSchema } from "../schema.js";
import { basename, closest, isObject, joinPath, missingFile } from "../util.js";
import { missingMessage, OLD_SECRET, oldWay, references, secretsWhere, valueAt } from "../vars.js";
import { parseData } from "./data.js";
import { regex } from "../checks/operators.js";
import { isBuiltIn } from "../checks/index.js";
import suiteSchema from "./schema/suite.js";
import providerSchema from "./schema/provider.js";

export const VERSION = 1;
export const SUITE_FILE = /\.hafen\.(ya?ml|json)$/i;
const BUILTINS = new Set(["user", "messages", "history", "session", "repeat"]);
const BUILTIN_HEADS = new Set(["row", "run", "test", "turn"]);
// The heads of what isn't a test variable: the environment's ({{env.NAME}}), a secret
// ({{secret.NAME}}, {{secrets.NAME}}) and the old way to write either ({{scope.NAME}}: a problem of
// its own, oldSpellings)
const REF_HEADS = new Set(["env", "secret", "secrets", "scope"]);

// Parse a YAML or JSON file's text: { doc, data, lines, kind, errors }
export function parseText(text, file) {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, keepSourceTokens: true, prettyErrors: true });
  const kind = /\.json$/i.test(file) ? "json" : "yaml";
  const errors = doc.errors.map((e) => ({ file, line: e.linePos?.[0]?.line, column: e.linePos?.[0]?.col, message: e.message.split("\n")[0] }));
  return { doc, data: errors.length ? null : doc.toJS(), lines, kind, errors };
}

// Where a value is in a parsed file: { line, column }
// The parts of a suite this version can't run yet (contracts/test-file.md: simulated users, attachments
// and a message's non-text parts): [{ path, message }] (the runner errors them: engine/runner.js)
export function notBuilt(data) {
  const out = [];
  for (const [i, test] of (Array.isArray(data?.tests) ? data.tests : []).entries()) {
    if (test?.simulate) out.push({ path: ["tests", i, "simulate"], message: SIMULATE_NOT_BUILT });
    for (const [j, turn] of (Array.isArray(test?.turns) ? test.turns : []).entries()) {
      const why = turnNotBuilt(turn);
      if (why) out.push({ path: ["tests", i, "turns", j, Array.isArray(turn?.attachments) && turn.attachments.length ? "attachments" : "user"], message: why });
    }
  }
  return out;
}
export const SIMULATE_NOT_BUILT = "simulated users can't run yet (they aren't built): running this test is an error";
// Why a turn can't be sent as written (attachments, an image or other non-text part), or ""
export function turnNotBuilt(turn) {
  if (Array.isArray(turn?.attachments) && turn.attachments.length) return "attachments can't be sent yet (they aren't built): running this turn is an error";
  if (Array.isArray(turn?.user) && turn.user.some((p) => !p || typeof p !== "object" || Object.keys(p).some((k) => k !== "text"))) {
    return "a message's parts other than text (an image, a file) can't be sent yet (they aren't built): running this turn is an error";
  }
  return "";
}

function position(parsed, path) {
  if (!parsed) return {};
  for (let n = path.length; n >= 0; n--) {
    const node = parsed.doc.getIn(path.slice(0, n), true);
    const offset = node?.range?.[0] ?? (n === 0 ? parsed.doc.contents?.range?.[0] : undefined);
    if (offset !== undefined) {
      const { line, col } = parsed.lines.linePos(offset);
      return { line, column: col };
    }
  }
  return {};
}

// Where a path in a loaded suite is: { line, column }, or {}
export const positionIn = (suite, path) => position(suite?.parsed, path);

// Where each value in a parsed file is, by its path ("a\0b\0c"; the top's is ""): what a check of
// a provider file says once the file's text is gone
function placesOf(parsed, value, path = [], out = {}) {
  out[path.join("\u0000")] = position(parsed, path);
  if (Array.isArray(value)) value.forEach((v, i) => placesOf(parsed, v, [...path, i], out));
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) placesOf(parsed, v, [...path, k], out);
  return out;
}

// Where a path in one of a suite's providers is (key: as suite.providers has it): { file, line?,
// column? }, in its provider file, or in the suite for one written there. (The nearest place there is,
// for a path the file hasn't)
export function providerPlace(suite, key, path) {
  const own = suite?.providerFiles?.[key];
  if (!own) return { file: suite?.file, ...positionIn(suite, [...refPath(key), ...path]) };
  const at = suite.providerPlaces?.[own]?.at ?? {};
  for (let n = path.length; n >= 0; n--) {
    const place = at[path.slice(0, n).join("\u0000")];
    if (place?.line !== undefined) return { file: own, ...place };
  }
  return { file: own };
}

// A path from a file that climbs above the opened folder (more ../ than the file is deep): outside it,
// wherever it leads. (joinPath stops at the folder's top, so it would find a file in it instead.) Only
// for a file in the folder, by a path from its top
export function climbsOut(fromFile, ref) {
  if (typeof ref !== "string" || typeof fromFile !== "string" || /^([a-z]+:)?\//i.test(ref) || /^[A-Za-z]:[\\/]/.test(ref) || /^([A-Za-z]:)?[\\/]/.test(fromFile)) return false;
  const folder = fromFile.split(/[\\/]/).slice(0, -1).filter((p) => p && p !== ".");
  if (folder.includes("..")) return false;
  let depth = folder.length;
  for (const part of ref.split(/[\\/]/)) {
    if (part === "..") depth -= 1;
    else if (part && part !== ".") depth += 1;
    if (depth < 0) return true;
  }
  return false;
}

// Why a file a suite (or a plugin entry) names can't be read: it's outside the opened folder (it
// climbs out of it, or the host can tell), or it doesn't exist
export const whyMissing = (host, fromFile, ref, what) => (climbsOut(fromFile, ref) ? `${what} isn't in the opened folder (only files in it are read)` : missingFile(host, joinPath(fromFile, ref), what));
// Whether it can be read: in the folder, and there
export const canRead = async (host, fromFile, ref) => !climbsOut(fromFile, ref) && (await host.files.exists(joinPath(fromFile, ref)));

const pathOf = (instancePath) => instancePath.split("/").slice(1).map((p) => (/^\d+$/.test(p) ? Number(p) : p.replace(/~1/g, "/").replace(/~0/g, "~")));

// (Each schema error also says where it is, `at`, and, for one that's a key missing, which keys
// would do, `needs`: so an unknown key that's one of them misspelled can be the one problem shown.
// loadSuite takes both off.)
function schemaErrors(validate, data, parsed, file) {
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
    const key = `${error.line}:${error.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(error);
  }
  return out;
}

// Read and check a provider file, or an inline provider. (at: where the reference is in the suite;
// names: the suite's providers, when the reference could have named one of them)
async function loadProvider(host, ref, fromFile, label, { at = {}, names } = {}) {
  // Inline providers are checked with the suite (its schema includes the provider's)
  if (isObject(ref)) return { config: ref, errors: [], file: null };
  if (typeof ref !== "string") return { config: null, errors: [{ file: fromFile, message: `${label} isn't a provider` }] };
  if (PRESETS[ref]) return { config: { kind: ref }, errors: [], file: null };
  if (ref.startsWith("plugin:")) return { config: { kind: ref }, errors: [], file: null };
  const file = joinPath(fromFile, ref);
  if (!(await canRead(host, fromFile, ref))) {
    // A name (no folder, no extension) that's none of the suite's providers, no preset and no file:
    // said as a name, with the ones there are
    if (names && !/[\\/.]/.test(ref)) {
      const meant = closest(ref, [...names, ...Object.keys(PRESETS)]);
      const listed = names.length ? `under providers: ${names.join(", ")}` : "the suite has none under providers";
      return { config: null, errors: [{ file: fromFile, ...at, message: `${label}: there's no provider named "${ref}" (${listed}), and it isn't a preset or a file${meant ? ` (did you mean "${meant}"?)` : ""}` }] };
    }
    return { config: null, errors: [{ file: fromFile, ...at, message: `${label}: ${whyMissing(host, fromFile, ref, `the provider file ${ref}`)}` }] };
  }
  const text = await host.files.read(file);
  const parsed = parseText(text, file);
  if (parsed.errors.length) return { config: null, errors: parsed.errors, file };
  const keys = providerKeys(parsed.data, parsed, file);
  // (where its kind, each secret, {{env.…}} and old way (${env:…}, {{scope.…}}), and each of its
  // values are: a problem with it is said where it's written)
  const places = {
    kind: position(parsed, ["kind"]),
    secret: Object.fromEntries(usePlaces(USES.secret, parsed, text, parsed.data)),
    environment: Object.fromEntries(usePlaces(USES.environment, parsed, text, parsed.data)),
    oldSecret: Object.fromEntries(usePlaces(USES.oldSecret, parsed, text, parsed.data)),
    oldScope: Object.fromEntries(usePlaces(USES.oldScope, parsed, text, parsed.data)),
    vars: Object.fromEntries(usePlaces(USES.vars, parsed, text, parsed.data)),
    at: placesOf(parsed, parsed.data),
  };
  return { config: parsed.data, errors: [...unexplained(schemaErrors(validateProviderSchema, parsed.data, parsed, file), keys), ...keys].map(bare), file, places };
}

// Where a provider reference is in a suite: "" its own, test:N a test's, a name one under providers
const refPath = (key) => (key === "" ? ["provider"] : key.startsWith("test:") ? ["tests", Number(key.slice(5)), "provider"] : ["providers", key]);

// A test's provider: its own, else the suite's (a reference that names one under providers: that
// one). { config, file }: file, the provider file it's in (none for a preset, a plugin's or inline)
export function providerOf(suite, index) {
  const own = `test:${index}`;
  const key = suite.providers?.[own] || suite.providerNames?.[own] !== undefined ? own : "";
  const at = suite.providerNames?.[key] ?? key;
  return { config: suite.providers?.[at] ?? null, file: suite.providerFiles?.[at] };
}

// Load a suite: { file, name, data, parsed, providers, provider, providerNames, providerFiles,
// providerPlaces, prices, dataFiles, schemas, errors, warnings }. Problems don't throw: they're
// returned, each with its file, line and column.
export async function loadSuite(host, file, { text } = {}) {
  const suite = { file, name: basename(file).replace(SUITE_FILE, ""), errors: [], warnings: [], providers: {}, providerNames: {}, providerFiles: {}, providerPlaces: {}, dataFiles: {} };
  let source = text;
  if (source === undefined) {
    try {
      source = await host.files.read(file);
    } catch (err) {
      suite.errors.push({ file, message: `couldn't read the file: ${err.message}` });
      return suite;
    }
  }
  suite.text = source;
  const parsed = parseText(source, file);
  suite.parsed = parsed;
  if (parsed.errors.length) {
    suite.errors.push(...parsed.errors);
    return suite;
  }
  const data = parsed.data;
  suite.data = data;
  if (!isObject(data)) {
    suite.errors.push({ file, line: 1, column: 1, message: "a suite file is a map with version and tests" });
    return suite;
  }
  if (typeof data.version === "number" && data.version > VERSION) {
    suite.errors.push({ file, ...position(parsed, ["version"]), message: `this file is version ${data.version}, made by a newer Hafen; this one reads version ${VERSION}` });
    return suite;
  }
  // (unknown keys are problems, but the suite's shape is still sound: its deeper checks still run)
  const keys = unknownKeys(data, parsed, file);
  for (const [name, config] of Object.entries(isObject(data.providers) ? data.providers : {})) keys.push(...providerKeys(config, parsed, file, ["providers", name]));
  if (isObject(data.provider)) keys.push(...providerKeys(data.provider, parsed, file, ["provider"]));
  const keyErrors = keys.map(bare);
  suite.errors.push(...unexplained(schemaErrors(validateSuiteSchema, data, parsed, file), keys).map(bare), ...keyErrors);
  // From here, the suite as it's shaped to be read (a list that isn't one is empty, an item that isn't
  // a map an empty one, in its place): a file written wrong says so (its schema errors, and
  // `malformed`), and nothing reading it breaks
  const shaped = shapeOf(data);
  suite.data = shaped.data;
  suite.malformed = shaped.malformed;
  if (shaped.malformed.length) {
    if (!suite.errors.length) suite.errors.push({ file, ...position(parsed, shaped.malformed[0]), message: `${shaped.malformed[0].join(".")} isn't written as the format has it` });
    return suite;
  }
  if (data.name) suite.name = data.name;
  suite.judges = data.judges ?? {};

  // Providers: named ones, then the suite's; tests may override. The suite's and a test's reference
  // is, in order: a name under providers (that one, not loaded again), a preset, plugin:…, a file
  const named = isObject(data.providers) ? data.providers : {};
  const refs = { ...named };
  if (data.provider !== undefined) refs[""] = data.provider;
  for (const [i, test] of (data.tests ?? []).entries()) if (test.provider !== undefined) refs[`test:${i}`] = test.provider;
  // (the references that are problems already: a test with one isn't "no provider" too)
  const broken = new Set();
  for (const [name, ref] of Object.entries(refs)) {
    const naming = name === "" || name.startsWith("test:");
    if (naming && typeof ref === "string" && Object.prototype.hasOwnProperty.call(named, ref)) {
      suite.providerNames[name] = ref;
      continue;
    }
    const label = name === "" ? "provider" : name.startsWith("test:") ? `tests.${name.slice(5)}.provider` : `providers.${name}`;
    const loaded = await loadProvider(host, ref, file, label, { at: position(parsed, refPath(name)), names: naming ? Object.keys(named) : undefined });
    suite.errors.push(...loaded.errors);
    if (loaded.errors.length) broken.add(name);
    if (loaded.config) {
      suite.providers[name] = loaded.config;
      if (loaded.file) {
        suite.providerFiles[name] = loaded.file;
        suite.providerPlaces[loaded.file] = loaded.places;
      }
    }
  }
  const has = (key) => !!suite.providers[key] || suite.providerNames[key] !== undefined || broken.has(key);
  suite.provider = suite.providers[suite.providerNames[""] ?? ""] ?? null;
  if (!has("") && (data.tests ?? []).some((t, i) => !has(`test:${i}`))) {
    suite.errors.push({ file, ...position(parsed, []), message: "no provider: set provider at the top, or on every test" });
  }

  // Prices
  if (typeof data.prices === "string") {
    const pricesFile = joinPath(file, data.prices);
    if (await canRead(host, file, data.prices)) {
      const p = parseText(await host.files.read(pricesFile), pricesFile);
      if (p.errors.length) suite.errors.push(...p.errors);
      else suite.prices = p.data;
    } else suite.errors.push({ file, ...position(parsed, ["prices"]), message: whyMissing(host, file, data.prices, `the prices file ${data.prices}`) });
  } else suite.prices = data.prices ?? {};

  // Data files
  for (const [i, test] of (data.tests ?? []).entries()) {
    const ref = typeof test.data === "string" ? test.data : test.data?.file;
    if (!ref) continue;
    const dataFile = joinPath(file, ref);
    if (!(await canRead(host, file, ref))) {
      suite.errors.push({ file, ...position(parsed, ["tests", i, "data"]), message: whyMissing(host, file, ref, `the data file ${ref}`) });
      continue;
    }
    try {
      suite.dataFiles[i] = parseData(await host.files.read(dataFile), dataFile);
    } catch (err) {
      suite.errors.push({ file: dataFile, message: err.message });
    }
  }

  // JSON Schemas in files (a check's `schema: schemas/order.json`), by the name the check gives:
  // read now, so one that isn't there is said before anything is sent
  suite.schemas = {};
  for (const [t, test] of listOf(data.tests).entries()) {
    const checks = [...listOf(test?.turns).flatMap((turn, i) => listOf(turn?.expect).map((check, c) => [check, ["tests", t, "turns", i, "expect", c]])), ...listOf(test?.expect_conversation).map((check, c) => [check, ["tests", t, "expect_conversation", c]])];
    for (const [check, path] of checks) {
      const ref = check?.enabled === false ? undefined : check?.schema;
      if (typeof ref !== "string" || ref in suite.schemas) continue;
      const schemaFile = joinPath(file, ref);
      if (!(await canRead(host, file, ref))) {
        suite.errors.push({ file, ...position(parsed, [...path, "schema"]), message: whyMissing(host, file, ref, `the schema file ${ref}`) });
        continue;
      }
      const read = parseText(await host.files.read(schemaFile), schemaFile);
      if (read.errors.length) suite.errors.push(...read.errors);
      else if (!isObject(read.data) && typeof read.data !== "boolean") suite.errors.push({ file: schemaFile, message: "a JSON Schema is an object (or true or false)" });
      else suite.schemas[ref] = read.data;
    }
  }

  if (suite.errors.every((e) => keyErrors.includes(e))) {
    const { errors, missing } = deepChecks(suite);
    suite.errors.push(...errors);
    // Variables nothing in the files sets: a setup error unless the run gives them (--var)
    suite.missing = missing;
  }
  const tests = testProblems(data, parsed, file);
  suite.errors.push(...tests.errors, ...reservedNames(data, parsed, file));
  if (Array.isArray(data.tests) && !data.tests.length) suite.warnings.push({ file, ...position(parsed, ["tests"]), message: "no tests yet" });
  // What the format has, but this version can't run yet: a run says so (the test or the turn is an
  // error), rather than send it without, or not at all, and pass
  suite.warnings.push(...notBuilt(data).map(({ path, message }) => ({ file, ...position(parsed, path), message })));
  suite.warnings.push(...tests.warnings);
  // The old ways to write the environment's values and secrets: problems, each saying the new way
  suite.errors.push(...oldSpellings(suite));
  return suite;
}

// What the schema can't say: every path parses, every pattern compiles, every judge exists, and
// every {{variable}} can be found where it's used.
function deepChecks(suite) {
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
      // ({{env.…}}, {{secret.…}}: the environment's and the secrets, checked when it runs; {{scope.…}},
      // the old way: said as that)
      if (REF_HEADS.has(head) || known.has(name) || BUILTINS.has(name) || (BUILTIN_HEADS.has(head) && head !== "row")) continue;
      if (head === "row") {
        if (!known.has("row")) at(path, `{{${name}}} needs a data file on the test`);
        continue;
      }
      unset(path, name, `{{${name}}} isn't set anywhere before it's used (variables, environments, an extract or a setup step)`);
    }
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
  };
  for (const [name, judge] of Object.entries(data.judges ?? {})) {
    if (judge?.kind === "llm" && !(data.providers ?? {})[judge.provider]) at(["judges", name, "provider"], `the judge "${name}" names the provider "${judge.provider}", which isn't under providers`);
  }
  for (const [s, step] of (data.setup ?? []).entries()) {
    checkVars(step.request, ["setup", s, "request"], new Set([...suiteVars, ...fromSetup]));
    for (const [v, p] of Object.entries(step.extract ?? {})) { const problem = pathProblem(p); if (problem) at(["setup", s, "extract", v], problem); }
  }
  for (const [t, test] of (data.tests ?? []).entries()) {
    const known = new Set([...suiteVars, ...fromSetup]);
    if (test.data) known.add("row");
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

// Every secret a suite will need: in its files ({{secret.NAME}}), and the presets' and System One's
// default keys
const DEFAULT_KEYS = { "openai-chat": "OPENAI_API_KEY", "openai-responses": "OPENAI_API_KEY", "anthropic-messages": "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" };
export const secretsNeeded = (suite) => secretUses(suite).map((use) => use.name);

// The same, each where it's first used: [{ name, file, line?, column? }]. A {{secret.NAME}} where it's
// written (the suite, or the provider file it's in); a preset's default key at its provider's kind (or
// where the suite names the preset); System One's at its judge (with none declared, at the first check
// that asks it)
export function secretUses(suite) {
  const uses = new Map();
  const use = (name, file, at) => { if (!uses.has(name)) uses.set(name, { name, file, ...at }); };
  // (a check turned off doesn't need its key: it's left out, as runningData leaves it out)
  for (const [name, at] of usePlaces(USES.secret, suite.parsed, suite.text, suite.data ?? {})) use(name, suite.file, at);
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
export const envUses = (suite) => usesOf(suite, USES.environment, "environment", (config) => references(config).environment);

function usesOf(suite, uses, key, names) {
  const out = new Map();
  const use = (name, file, at) => { if (!out.has(name)) out.set(name, { name, file, ...at }); };
  for (const [name, at] of usePlaces(uses, suite.parsed, suite.text, suite.data ?? {})) use(name, suite.file, at);
  for (const [k, config] of Object.entries(suite.providers ?? {})) {
    const own = suite.providerFiles?.[k];
    const places = own ? suite.providerPlaces?.[own] : null;
    for (const n of names(config)) use(n, own ?? suite.file, places?.[key]?.[n] ?? {});
  }
  return [...out.values()];
}

// The old ways to write them (${env:NAME}, {{scope.NAME}}), each where it's first written (the
// suite's, then its provider files'): problems that say the new way. Nothing fills them in.
function oldSpellings(suite) {
  const out = [];
  const seen = new Set();
  const say = (file, at, message) => {
    if (seen.has(`${file}\u0000${message}`)) return;
    seen.add(`${file}\u0000${message}`);
    out.push({ file, ...at, message });
  };
  for (const [name, at] of usePlaces(USES.oldSecret, suite.parsed, suite.text, suite.data ?? {})) say(suite.file, at, oldWay("env", name));
  for (const [name, at] of usePlaces(USES.oldScope, suite.parsed, suite.text, suite.data ?? {})) say(suite.file, at, oldWay("scope", name));
  for (const own of new Set(Object.values(suite.providerFiles ?? {}))) {
    const places = suite.providerPlaces?.[own] ?? {};
    for (const [name, at] of Object.entries(places.oldSecret ?? {})) say(own, at, oldWay("env", name));
    for (const [name, at] of Object.entries(places.oldScope ?? {})) say(own, at, oldWay("scope", name));
  }
  return out;
}

// What usePlaces looks for: the names a text uses, and how each is written
const quote = (name) => name.replace(/\./g, "\\.");
const USES = {
  // a secret, either way it's written ({{secret.NAME}}, {{secrets.NAME}})
  secret: { names: (text) => references(text).env, written: (name) => new RegExp(`\\{\\{\\s*secrets?\\.${quote(name)}\\s*\\}\\}`, "g") },
  environment: { names: (text) => references(text).environment, written: (name) => new RegExp(`\\{\\{\\s*env\\.${quote(name)}\\s*\\}\\}`, "g") },
  // the old ways: ${env:NAME} (a secret) and {{scope.NAME}}
  oldSecret: { names: (text) => new Set([...text.matchAll(OLD_SECRET)].map((m) => m[1])), written: (name) => new RegExp(`\\$\\{env:${name}\\}`, "g") },
  oldScope: { names: (text) => new Set([...references(text).vars].filter((n) => n.startsWith("scope.")).map((n) => n.slice(6))), written: (name) => new RegExp(`\\{\\{\\s*scope\\.${quote(name)}\\s*\\}\\}`, "g") },
  vars: { names: (text) => references(text).vars, written: (name) => new RegExp(`\\{\\{\\s*${quote(name)}\\s*\\}\\}`, "g") },
};

// Where each name `uses` looks for (USES.secret, USES.environment, USES.oldSecret, USES.oldScope,
// USES.vars) in a parsed file's value is first written (its "{{" or "${", in the text), in the file's
// order: Map NAME → { line, column }. A check turned off is left out.
function usePlaces(uses, parsed, text, value, path = [], out = new Map()) {
  if (typeof value === "string") {
    for (const name of uses.names(value)) {
      if (out.has(name)) continue;
      const node = parsed?.doc.getIn(path, true);
      let offset = -1;
      if (node?.range && typeof text === "string") {
        const written = uses.written(name);
        written.lastIndex = node.range[0];
        offset = written.exec(text)?.index ?? -1;
      }
      out.set(name, offset !== -1 && offset < node.range[1] ? linePos(parsed, offset) : position(parsed, path));
    }
  } else if (Array.isArray(value)) {
    const checks = path.at(-1) === "expect" || path.at(-1) === "expect_conversation";
    for (const [i, v] of value.entries()) if (!(checks && v?.enabled === false)) usePlaces(uses, parsed, text, v, [...path, i], out);
  } else if (isObject(value)) for (const [k, v] of Object.entries(value)) usePlaces(uses, parsed, text, v, [...path, k], out);
  return out;
}

const linePos = (parsed, offset) => {
  const { line, col } = parsed.lines.linePos(offset);
  return { line, column: col };
};

// A suite's data shaped as it's read: the lists the format has (tests, turns, checks, steps, tags) are
// lists, and their items maps (or strings, for tags), each in its place; what isn't is replaced (an
// empty list, an empty map) and its path is in `malformed`. (Absent or empty stays as it is.)
export function shapeOf(data) {
  const malformed = [];
  const list = (v, path) => {
    if (v === undefined) return undefined;
    if (v === null) return [];
    if (Array.isArray(v)) return v;
    malformed.push(path);
    return [];
  };
  const map = (v, path) => {
    if (isObject(v)) return v;
    malformed.push(path);
    return {};
  };
  const maps = (v, path, inner = (x) => x) => {
    const l = list(v, path);
    return l && l.map((x, i) => inner(map(x, [...path, i]), [...path, i]));
  };
  const step = (st, path) => (st.expect === undefined ? st : { ...st, expect: maps(st.expect, [...path, "expect"]) });
  if (!isObject(data)) return { data, malformed };
  const tests = maps(data.tests, ["tests"], (t, path) => {
    const out = { ...t };
    for (const k of ["turns", "setup", "teardown", "expect_conversation"]) if (t[k] !== undefined) out[k] = maps(t[k], [...path, k], k === "turns" ? (u, up) => (u.expect === undefined ? u : { ...u, expect: maps(u.expect, [...up, "expect"]) }) : k === "expect_conversation" ? (x) => x : step);
    if (t.tags !== undefined) out.tags = (list(t.tags, [...path, "tags"]) ?? []).map((x, i) => (typeof x === "string" ? x : (malformed.push([...path, "tags", i]), String(x))));
    return out;
  });
  const out = { ...data };
  if (tests !== undefined) out.tests = tests;
  for (const k of ["setup", "teardown"]) if (data[k] !== undefined) out[k] = maps(data[k], [k], step);
  return { data: out, malformed };
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

// The problems a run would have: the suite's errors, and the variables nothing sets, unless the run
// gives them (vars: names given at run time, as --var does); with secrets, the secrets it needs; with
// environment (the chosen one, { name, values, suite? }, or null: none), the {{env.NAMES}} it
// hasn't. (Each said where it's first used: the suite, or a provider file)
export function problemsFor(suite, vars = {}, secrets = null, environment = undefined, secretsFrom = undefined) {
  const problems = [...(suite.errors ?? []), ...(suite.missing ?? []).filter((m) => !(m.variable in vars))];
  const set = (value) => value !== undefined && value !== null && value !== "";
  if (environment !== undefined && !problems.length) {
    for (const { name, ...where } of envUses(suite)) {
      if (!environment || !envHas(environment, name)) problems.push({ ...where, variable: `env.${name}`, message: missingMessage(name, "environment", environment ? environment.name ?? "" : null) });
    }
  }
  if (secrets && !problems.length) {
    // (each said where it's first used: the suite, or a provider file)
    for (const { name, ...where } of secretUses(suite)) {
      if (!set(secrets(name))) problems.push({ ...where, variable: name, message: missingMessage(name, "secret", secretsWhere(environment, secretsFrom)) });
    }
  }
  return problems;
}

const KNOWN = {
  top: ["version", "name", "group", "provider", "providers", "environments", "variables", "judges", "defaults", "setup", "teardown", "plugins", "prices", "redact", "tests"],
  test: ["name", "id", "tags", "group", "provider", "data", "setup", "teardown", "turns", "simulate", "expect_conversation", "repeat", "pass_rate", "history", "on_fail", "unsure", "unsure_below", "timeout_ms", "retries", "network", "load"],
  turn: ["user", "attachments", "reply", "extract", "tools", "expect"],
  step: Object.keys(suiteSchema.$defs.step.properties),
  check: Object.keys(suiteSchema.$defs.check.properties),
  provider: Object.keys(providerSchema.properties),
  response: Object.keys(providerSchema.properties.response.properties),
  event: Object.keys(providerSchema.$defs.eventRule.properties),
};

// A key of the user's own, which Hafen keeps and doesn't read: x-owner, x-ticket
const OWN_KEY = /^x-/;
const listOf = (v) => (Array.isArray(v) ? v : []);

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

function unknownKeys(data, parsed, file) {
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
function providerKeys(config, parsed, file, base = []) {
  if (!isObject(config) || String(config.kind ?? "").startsWith("plugin:")) return [];
  const settings = config.fixtures !== undefined || config.fixture !== undefined;
  return [
    ...keyProblems(config, KNOWN.provider, base, parsed, file).filter((p) => !settings || p.suggest),
    ...keyProblems(config.response, KNOWN.response, [...base, "response"], parsed, file),
    ...listOf(config.events).flatMap((rule, i) => keyProblems(rule, KNOWN.event, [...base, "events", i], parsed, file)),
  ];
}

// A problem as it's shown: without what loadSuite sorts them by
const bare = ({ at, needs, suggest, ...problem }) => problem;
// The schema's errors less the ones an unknown key explains (`expcet` for a missing `expect`, say)
const unexplained = (errors, keys) => {
  const meant = new Set(keys.filter((k) => k.suggest).map((k) => `${k.at}\u0000${k.suggest}`));
  return errors.filter((e) => !e.needs?.some((n) => meant.has(`${e.at}\u0000${n}`)));
};

// Every check a test has (turned off ones too)
const checksOf = (test) => [...listOf(test?.turns).flatMap((turn) => listOf(turn?.expect)), ...listOf(test?.expect_conversation)];

// Problems across a suite's tests: two named the same (results, filters and reports find a test by its
// name). And a warning for a test that checks nothing: it passes whenever each turn gets a reply.
function testProblems(data, parsed, file) {
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
function reservedNames(data, parsed, file) {
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

/* ---------- editing in place ---------- */

// Apply edits to a suite's text, keeping comments and formatting: [{ op: "set" | "add" | "delete",
// path: [...], value }]. "add" appends to a list. Returns the new text.
//
// Each edit changes only the lines it's about (found by the parser's source positions), so
// everything else stays byte for byte, and a one-field change is a one-line diff. The result is
// parsed again and compared with the intended data; if they differ (an edit inside a flow
// collection, say), the edit is made through the YAML library instead, which keeps comments.
export function editText(text, file, edits) {
  // A file with Windows line endings keeps them, and one with a byte order mark keeps it: the edit is
  // made to the text without them, and they're put back
  const bom = text.startsWith("\uFEFF");
  const crlf = text.includes("\r\n");
  let work = bom ? text.slice(1) : text;
  if (crlf) work = work.replace(/\r\n/g, "\n");
  const kind = /\.json$/i.test(file) ? "json" : "yaml";
  let out;
  if (kind === "json") {
    const data = JSON.parse(work);
    for (const edit of edits) {
      checkTarget(data, edit, file);
      applyToObject(data, edit);
    }
    out = `${JSON.stringify(data, null, 2)}\n`;
  } else {
    out = work;
    for (const edit of edits) out = editOne(out, file, edit);
  }
  if (crlf) out = out.replace(/\n/g, "\r\n");
  return bom ? `\uFEFF${out}` : out;
}

function editOne(text, file, edit) {
  const doc = parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length) throw new Error(`can't edit ${file}: ${doc.errors[0].message.split("\n")[0]}`);
  const expected = doc.toJS();
  checkTarget(expected, edit, file);
  applyToObject(expected, structuredClone(edit));
  let attempt = null;
  try {
    attempt = surgical(text, doc, edit, expected);
  } catch {
    attempt = null;
  }
  if (attempt !== null) {
    const check = parseDocument(attempt);
    if (!check.errors.length && sameData(check.toJS(), expected)) return attempt;
  }
  // Through the library, checked the same way: an edit is made as meant, or not at all
  const library = viaLibrary(doc, edit);
  const check = parseDocument(library);
  if (check.errors.length || !sameData(check.toJS(), expected)) throw new Error(`can't make this change to ${file} (${edit.op} ${edit.path.join(".")})`);
  return library;
}

const sameData = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lineStart = (text, at) => text.lastIndexOf("\n", at - 1) + 1;
const lineEnd = (text, at) => {
  const n = text.indexOf("\n", at);
  return n === -1 ? text.length : n;
};
const scalarText = (value) => stringify(value).trimEnd();
// A scalar as the value of a key at `column`: a text of several lines as a block (|, its lines
// indented under the key), anything else on the key's line
const scalarAt = (value, column) => {
  if (typeof value !== "string" || !value.includes("\n")) return scalarText(value);
  const [first, ...rest] = stringify({ v: value }, { lineWidth: 0 }).replace(/\n$/, "").split("\n");
  return [first.slice(3), ...rest.map((l) => (l ? " ".repeat(column) + l : l))].join("\n");
};
// A comment in a stretch of YAML: a # after a space (or at its start), outside quotes
const hasComment = (source) => /(^|\s)#/.test(source.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, '""'));
const flowText = (value) => stringify(value, { collectionStyle: "flow", lineWidth: 0 }).trimEnd();
const isCollection = (v) => v !== null && typeof v === "object";

// The outermost { flow } or [flow] collection on the way to `path` (path included): { node, path }
function flowAncestor(doc, path) {
  for (let i = 0; i <= path.length; i++) {
    const node = i === 0 ? doc.contents : doc.getIn(path.slice(0, i), true);
    if ((isMap(node) || isSeq(node)) && node.flow) return { node, path: path.slice(0, i) };
    if (!isMap(node) && !isSeq(node)) return null;
  }
  return null;
}

// The edit as a change to the text's lines, or null when it isn't a simple one. (`expected`: the data
// as the edit is to leave it)
function surgical(text, doc, { op, path, value }, expected) {
  const parentPath = path.slice(0, -1);
  const key = path.at(-1);
  // Inside a { flow } or [flow] collection (a check written on one line, say): that collection is
  // written again where it is, as flow, holding what it's to hold; the rest of the file stays as it was
  // (Only one written on one line with no comment in it: written again, it's one line as it was. One
  // over several lines, or with comments, is left to the library, which keeps them)
  const flow = flowAncestor(doc, op === "add" ? path : parentPath);
  if (flow) {
    const next = flow.path.reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), expected);
    if (next === undefined) return null;
    // An empty one ([] or {}: a list is left as `tests: []` when its last item goes) that now holds
    // maps or lists is written as a block under its key, as the format writes one (not one line that
    // grows with every test)
    const holder = flow.path.length === 0 ? null : flow.path.length === 1 ? doc.contents : doc.getIn(flow.path.slice(0, -1), true);
    if (!flow.node.items.length && isMap(holder) && !holder.flow && isCollection(next) && Object.values(next).some(isCollection)) {
      const pair = holder.items.find((p) => p.value === flow.node);
      const colon = pair?.key?.range ? text.indexOf(":", pair.key.range[1]) : -1;
      if (colon < 0 || colon > flow.node.range[0] || hasComment(text.slice(flow.node.range[1], lineEnd(text, flow.node.range[1])))) return null;
      const indent = pair.key.range[0] - lineStart(text, pair.key.range[0]);
      return replaceRange(text, [colon + 1, flow.node.range[1]], `\n${block(next, indent + 2)}`);
    }
    const source = text.slice(flow.node.range[0], flow.node.range[1]);
    if (/[\n\r]/.test(source) || hasComment(source)) return null;
    return replaceRange(text, flow.node.range, flowText(next));
  }
  if (op === "add") {
    const seq = doc.getIn(path, true);
    if (!isSeq(seq) || seq.flow || !seq.items.length) return null;
    const last = seq.items.at(-1);
    const itemStart = last.range[0];
    const dash = text.lastIndexOf("-", itemStart);
    const indent = dash - lineStart(text, dash);
    const at = lineEnd(text, Math.max(itemStart, last.range[1] - 1));
    const flow = isMap(last) && last.flow;
    let rendered;
    if (!isCollection(value)) rendered = `- ${scalarText(value)}`;
    else if (flow) rendered = `- ${flowText(value)}`;
    else rendered = block(value, indent + 2).replace(/^ */, `${" ".repeat(indent)}- `).slice(indent);
    return `${text.slice(0, at)}\n${" ".repeat(indent)}${rendered}${text.slice(at)}`;
  }
  const parent = doc.getIn(parentPath, true) ?? (parentPath.length === 0 ? doc.contents : undefined);
  if (op === "set") {
    if (isMap(parent) && !parent.flow) {
      const pair = parent.items.find((p) => p.key?.value === key);
      if (pair) {
        const node = pair.value;
        const column = pair.key?.range ? pair.key.range[0] - lineStart(text, pair.key.range[0]) : 0;
        // A key with no value (`name:`; the library gives it an empty one, right after the colon): the
        // value goes after its colon, a space apart
        const empty = !node || (node.range && node.range[0] === node.range[1] && node.value === null);
        if (empty && pair.key?.range && !isCollection(value)) {
          const colon = text.indexOf(":", pair.key.range[1]);
          if (colon < 0 || /[^\s]/.test(text.slice(pair.key.range[1], colon))) return null;
          return `${text.slice(0, colon + 1)} ${scalarAt(value, column)}${text.slice(colon + 1)}`;
        }
        if (!node || isCollection(value) || isMap(node) || isSeq(node)) {
          if (!node) return null;
          if (isCollection(value) && (isMap(node) || isSeq(node)) && node.flow) {
            // An empty one ([], {}) given maps or lists: a block under its key, as the format writes one
            if (!node.items.length && Object.values(value).some(isCollection) && !hasComment(text.slice(node.range[1], lineEnd(text, node.range[1])))) {
              const colon = text.indexOf(":", pair.key.range[1]);
              if (colon < 0 || colon > node.range[0]) return null;
              return replaceRange(text, [colon + 1, node.range[1]], `\n${block(value, column + 2)}`);
            }
            return replaceRange(text, node.range, flowText(value));
          }
          return null;
        }
        // A text of several lines goes as a block under its key (a message, say); a comment on its line
        // stays on the block's first line (`|- # greet`), not in its text
        const rendered = scalarAt(value, column);
        if (rendered.includes("\n")) {
          const end = lineEnd(text, valueEnd(text, node));
          const rest = text.slice(valueEnd(text, node), end);
          const [head, ...lines] = rendered.split("\n");
          return replaceRange(text, [node.range[0], end], [head + rest, ...lines].join("\n"));
        }
        return replaceRange(text, [node.range[0], valueEnd(text, node)], rendered);
      }
      // A new key, after the map's last pair, at its keys' indentation
      const firstKey = parent.items[0]?.key;
      if (!firstKey) return null;
      const indent = firstKey.range[0] - lineStart(text, firstKey.range[0]);
      const lastPair = parent.items.at(-1);
      const at = lineEnd(text, Math.max(lastPair.key.range[0], (lastPair.value?.range?.[1] ?? lastPair.key.range[1]) - 1));
      const line = isCollection(value)
        ? Array.isArray(value) || Object.keys(value).length > 3
          ? `${key}:\n${block(value, indent + 2)}`
          : `${key}: ${flowText(value)}`
        : `${key}: ${scalarText(value)}`;
      return `${text.slice(0, at)}\n${" ".repeat(indent)}${line}${text.slice(at)}`;
    }
    if (isSeq(parent) && !parent.flow && typeof key === "number") {
      const node = parent.items[key];
      if (!node) return null;
      // A list item replaced where it is: a flow one as flow, a block one as block (a comment on its
      // line, after it, stays)
      if (isCollection(value) && (isMap(node) || isSeq(node))) {
        if (node.flow) return replaceRange(text, node.range, flowText(value));
        const dash = text.lastIndexOf("-", node.range[0]);
        const indent = dash - lineStart(text, dash);
        const rendered = block(value, indent + 2).slice(indent + 2);
        return replaceRange(text, [node.range[0], valueEnd(text, node)], rendered);
      }
      if (isCollection(value) || isMap(node) || isSeq(node)) return null;
      return replaceRange(text, node.range, scalarText(value));
    }
    return null;
  }
  if (op === "delete") {
    if (isSeq(parent) && !parent.flow && typeof key === "number") {
      const node = parent.items[key];
      if (!node) return null;
      const dash = text.lastIndexOf("-", node.range[0]);
      // Comment lines just above the item, at its indentation, are about it: they go with it
      let from = lineStart(text, dash);
      const indent = dash - from;
      while (from > 0) {
        const prev = lineStart(text, from - 1);
        const line = text.slice(prev, from - 1);
        if (!new RegExp(`^ {${indent}}#`).test(line)) break;
        from = prev;
      }
      const cut = cutLines(text, from, Math.max(node.range[0], node.range[1] - 1));
      if (parent.items.length > 1) return cut;
      // The last item: the list stays, empty (`tests: []`)
      const holder = doc.getIn(parentPath.slice(0, -1), true) ?? (parentPath.length === 1 ? doc.contents : undefined);
      const pair = isMap(holder) && !holder.flow ? holder.items.find((p) => p.key?.value === parentPath.at(-1)) : null;
      if (!pair) return null;
      const colon = text.indexOf(":", pair.key.range[1]);
      if (colon === -1 || colon >= from) return null;
      return `${cut.slice(0, colon + 1)} []${cut.slice(colon + 1)}`;
    }
    if (isMap(parent) && !parent.flow) {
      const pair = parent.items.find((p) => p.key?.value === key);
      if (!pair) return null;
      return cutLines(text, pair.key.range[0], Math.max(pair.key.range[0], (pair.value?.range?.[1] ?? pair.key.range[1]) - 1));
    }
    return null;
  }
  return null;
}

const replaceRange = (text, range, replacement) => text.slice(0, range[0]) + replacement + text.slice(range[1]);
// Where a block value's own text ends (its range can run on into the blank lines after it)
const valueEnd = (text, node) => {
  let end = node.range[1];
  while (end > node.range[0] && /\s/.test(text[end - 1])) end--;
  return end;
};
function cutLines(text, from, to) {
  const start = lineStart(text, from);
  const end = lineEnd(text, to);
  return text.slice(0, start) + text.slice(end + 1);
}

// A value as block YAML, every line indented by `indent`
function block(value, indent) {
  return stringify(value, { lineWidth: 0 }).trimEnd().split("\n").map((l) => " ".repeat(indent) + l).join("\n");
}

// The edit through the YAML library (keeps comments; may respace them)
function viaLibrary(doc, edit) {
  if (edit.op === "delete") {
    doc.deleteIn(edit.path);
    return doc.toString({ lineWidth: 0 });
  }
  if (edit.op === "add") {
    const seq = doc.getIn(edit.path, true);
    const flow = isSeq(seq) && seq.items.length > 0 && seq.items.every((item) => isMap(item) && item.flow);
    const node = doc.createNode(edit.value, { flow });
    if (isSeq(seq)) seq.items.push(node);
    else doc.setIn(edit.path, doc.createNode([edit.value], { flow: false }));
    return doc.toString({ lineWidth: 0 });
  }
  const old = doc.getIn(edit.path, true);
  const parent = doc.getIn(edit.path.slice(0, -1), true);
  const flow = (old && (isMap(old) || isSeq(old)) && old.flow) || (isMap(parent) && parent.flow);
  doc.setIn(edit.path, typeof edit.value === "object" && edit.value !== null ? doc.createNode(edit.value, { flow: !!flow }) : edit.value);
  return doc.toString({ lineWidth: 0 });
}

// An edit has to find what it's about: the map or list it changes, and in a list, an item that's there
// (to set or delete). Otherwise it's refused, rather than doing nothing, changing another item, or
// filling in the gaps.
function checkTarget(data, { op, path }, file) {
  const where = path.join(".");
  const parent = path.slice(0, -1).reduce((v, k) => (v === null || v === undefined || typeof v !== "object" ? undefined : v[k]), data);
  const key = path.at(-1);
  const isObj = parent !== null && typeof parent === "object";
  if (!isObj) throw new Error(`${file} has nothing at ${path.slice(0, -1).join(".") || "the top"}: open it again`);
  if (Array.isArray(parent)) {
    if (typeof key !== "number" || key < 0) throw new Error(`${where} in ${file} isn't a list item`);
    if (key >= parent.length && !(op === "add" && key === parent.length)) throw new Error(`${file} has nothing at ${where}: open it again`);
  }
  // (Deleting a map key that isn't there changes nothing: it's already gone)
  if (op === "add" && parent[key] !== undefined && parent[key] !== null && !Array.isArray(parent[key])) throw new Error(`${where} in ${file} isn't a list`);
}

function applyToObject(data, { op, path, value }) {
  const parent = path.slice(0, -1).reduce((o, k) => (o[k] ??= typeof k === "number" ? [] : {}), data);
  const key = path.at(-1);
  if (op === "delete") {
    if (Array.isArray(parent)) parent.splice(key, 1);
    else delete parent[key];
  } else if (op === "add") {
    parent[key] ??= [];
    parent[key].push(value);
  } else parent[key] = value;
}

// A new suite file's text
// (environments and variables: a suite's own, when it starts from one that uses the same provider)
export function newSuiteText({ name, provider, environments, variables, tests = [], kind = "yaml" }) {
  const data = { version: VERSION, name, provider, ...(environments ? { environments } : {}), ...(variables ? { variables } : {}), tests };
  if (kind === "json") return `${JSON.stringify(data, null, 2)}\n`;
  const doc = parseDocument("");
  doc.contents = doc.createNode(data);
  return doc.toString({ lineWidth: 0 });
}
