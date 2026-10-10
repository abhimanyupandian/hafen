// Loading suite and provider files (contracts/test-file.md, contracts/provider.md): a suite with the
// providers, data files, prices and schemas it names, every problem with its file, line and column
// (validate.js). Where things are in a file is places.js; what a suite needs from whoever runs it,
// needs.js; editing one in place, edit.js.
//
// Files come and go through the host: host.files.{read(path), write(path, text), exists(path)}.

import { parseDocument } from "yaml";
import { PRESETS } from "../providers/index.js";
import { validateProviderSchema, validateSuiteSchema } from "../schema.js";
import { basename, closest, isObject, joinPath, missingFile } from "../util.js";
import { readData } from "./data.js";
import { listOf, parseText, placesOf, position, positionIn, refPath, USES, usePlaces } from "./places.js";
import { badNames, bare, deepChecks, providerKeys, reservedNames, rowNameProblems, schemaErrors, testProblems, unexplained, unknownKeys } from "./validate.js";

export const VERSION = 1;
export const SUITE_FILE = /\.hafen\.(ya?ml|json)$/i;
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
  // (where its kind, each secret and {{env.…}}, and each of its values are: a problem with it is said
  // where it's written)
  const places = {
    kind: position(parsed, ["kind"]),
    secret: Object.fromEntries(usePlaces(USES.secret, parsed, text, parsed.data)),
    environment: Object.fromEntries(usePlaces(USES.environment, parsed, text, parsed.data)),
    badName: Object.fromEntries(usePlaces(USES.badName, parsed, text, parsed.data)),
    vars: Object.fromEntries(usePlaces(USES.vars, parsed, text, parsed.data)),
    at: placesOf(parsed, parsed.data),
  };
  return { config: parsed.data, errors: [...unexplained(schemaErrors(validateProviderSchema, parsed.data, parsed, file), keys), ...keys].map(bare), file, places };
}

// A test's provider: its own, else the suite's (a reference that names one under providers: that
// one). { config, file }: file, the provider file it's in (none for a preset, a plugin's or inline)
export function providerOf(suite, index) {
  const own = `test:${index}`;
  const key = suite.providers?.[own] || suite.providerNames?.[own] !== undefined ? own : "";
  const at = suite.providerNames?.[key] ?? key;
  return { config: suite.providers?.[at] ?? null, file: suite.providerFiles?.[at] };
}

// Load a suite: { file, name, data, parsed, providers, provider, providerNames, providerFiles,
// providerPlaces, prices, dataFiles, dataColumns, schemas, errors, warnings }. Problems don't throw:
// they're returned, each with its file, line and column. (dataFiles: each test's data rows, by its
// index; dataColumns: its data file's { columns, header }, as data.js reads them)
export async function loadSuite(host, file, { text } = {}) {
  const suite = { file, name: basename(file).replace(SUITE_FILE, ""), errors: [], warnings: [], providers: {}, providerNames: {}, providerFiles: {}, providerPlaces: {}, dataFiles: {}, dataColumns: {} };
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
      const read = readData(await host.files.read(dataFile), dataFile);
      suite.dataFiles[i] = read.rows;
      suite.dataColumns[i] = { columns: read.columns, header: read.header };
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
    const { errors, missing } = deepChecks(suite, keys);
    suite.errors.push(...errors);
    // Variables nothing in the files sets: a setup error unless the run gives them (--var)
    suite.missing = missing;
  }
  const tests = testProblems(data, parsed, file);
  suite.errors.push(...tests.errors, ...reservedNames(data, parsed, file), ...rowNameProblems(suite));
  if (Array.isArray(data.tests) && !data.tests.length) suite.warnings.push({ file, ...position(parsed, ["tests"]), message: "no tests yet" });
  suite.warnings.push(...tests.warnings);
  // A {{secret.NAME}} or {{env.NAME}} whose NAME isn't a name
  suite.errors.push(...badNames(suite));
  return suite;
}

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

// A new suite file's text
// (environments and variables: a suite's own, when it starts from one that uses the same provider)
export function newSuiteText({ name, provider, environments, variables, tests = [], kind = "yaml" }) {
  const data = { version: VERSION, name, provider, ...(environments ? { environments } : {}), ...(variables ? { variables } : {}), tests };
  if (kind === "json") return `${JSON.stringify(data, null, 2)}\n`;
  const doc = parseDocument("");
  doc.contents = doc.createNode(data);
  return doc.toString({ lineWidth: 0 });
}
