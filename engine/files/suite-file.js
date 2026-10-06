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
import { basename, isObject, joinPath, missingFile } from "../util.js";
import { references, scopeReferences } from "../vars.js";
import { parseData } from "./data.js";
import { regex } from "../checks/operators.js";

export const VERSION = 1;
export const SUITE_FILE = /\.hafen\.(ya?ml|json)$/i;
const BUILTINS = new Set(["user", "messages", "session", "repeat"]);
const BUILTIN_HEADS = new Set(["row", "run", "test", "turn"]);

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

const pathOf = (instancePath) => instancePath.split("/").slice(1).map((p) => (/^\d+$/.test(p) ? Number(p) : p.replace(/~1/g, "/").replace(/~0/g, "~")));

function schemaErrors(validate, data, parsed, file) {
  if (validate(data)) return [];
  // anyOf/oneOf report every branch: keep the most specific error per place
  const seen = new Set();
  return (validate.errors ?? [])
    .filter((e) => !["anyOf", "oneOf", "if"].includes(e.keyword) || validate.errors.length === 1)
    .map((e) => {
      const path = pathOf(e.instancePath);
      const where = path.length ? `${path.join(".")}: ` : "";
      const detail = e.keyword === "additionalProperties" ? `unknown key "${e.params.additionalProperty}"` : e.keyword === "enum" ? `${e.message} (${e.params.allowedValues.join(", ")})` : e.message;
      return { file, ...position(parsed, path), message: `${where}${detail}` };
    })
    .filter((e) => {
      const key = `${e.line}:${e.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// Read and check a provider file, or an inline provider
async function loadProvider(host, ref, fromFile, label) {
  // Inline providers are checked with the suite (its schema includes the provider's)
  if (isObject(ref)) return { config: ref, errors: [], file: null };
  if (typeof ref !== "string") return { config: null, errors: [{ file: fromFile, message: `${label} isn't a provider` }] };
  if (PRESETS[ref]) return { config: { kind: ref }, errors: [], file: null };
  if (ref.startsWith("plugin:")) return { config: { kind: ref }, errors: [], file: null };
  const file = joinPath(fromFile, ref);
  if (!(await host.files.exists(file))) return { config: null, errors: [{ file: fromFile, message: `${label}: ${missingFile(host, file, `the provider file ${ref}`)}` }] };
  const parsed = parseText(await host.files.read(file), file);
  if (parsed.errors.length) return { config: null, errors: parsed.errors, file };
  return { config: parsed.data, errors: schemaErrors(validateProviderSchema, parsed.data, parsed, file), file, text: parsed };
}

// Load a suite: { file, name, data, parsed, providers, provider, prices, dataFiles, errors, warnings }.
// Problems don't throw: they're returned, each with its file, line and column.
export async function loadSuite(host, file, { text } = {}) {
  const suite = { file, name: basename(file).replace(SUITE_FILE, ""), errors: [], warnings: [], providers: {}, providerFiles: {}, dataFiles: {} };
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
  suite.errors.push(...schemaErrors(validateSuiteSchema, data, parsed, file));
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

  // Providers: the suite's, then named ones; tests may override
  const refs = { ...(data.providers ?? {}) };
  if (data.provider !== undefined) refs[""] = data.provider;
  for (const [i, test] of (data.tests ?? []).entries()) if (test.provider !== undefined) refs[`test:${i}`] = test.provider;
  for (const [name, ref] of Object.entries(refs)) {
    const label = name === "" ? "provider" : name.startsWith("test:") ? `tests.${name.slice(5)}.provider` : `providers.${name}`;
    const loaded = await loadProvider(host, ref, file, label);
    suite.errors.push(...loaded.errors);
    if (loaded.config) {
      suite.providers[name] = loaded.config;
      if (loaded.file) suite.providerFiles[name] = loaded.file;
    }
  }
  suite.provider = suite.providers[""] ?? null;
  if (!suite.provider && (data.tests ?? []).some((t, i) => !suite.providers[`test:${i}`])) {
    suite.errors.push({ file, ...position(parsed, []), message: "no provider: set provider at the top, or on every test" });
  }

  // Prices
  if (typeof data.prices === "string") {
    const pricesFile = joinPath(file, data.prices);
    if (await host.files.exists(pricesFile)) {
      const p = parseText(await host.files.read(pricesFile), pricesFile);
      if (p.errors.length) suite.errors.push(...p.errors);
      else suite.prices = p.data;
    } else suite.errors.push({ file, ...position(parsed, ["prices"]), message: missingFile(host, joinPath(file, data.prices), `the prices file ${data.prices}`) });
  } else suite.prices = data.prices ?? {};

  // Data files
  for (const [i, test] of (data.tests ?? []).entries()) {
    const ref = typeof test.data === "string" ? test.data : test.data?.file;
    if (!ref) continue;
    const dataFile = joinPath(file, ref);
    if (!(await host.files.exists(dataFile))) {
      suite.errors.push({ file, ...position(parsed, ["tests", i, "data"]), message: missingFile(host, joinPath(file, ref), `the data file ${ref}`) });
      continue;
    }
    try {
      suite.dataFiles[i] = parseData(await host.files.read(dataFile), dataFile);
    } catch (err) {
      suite.errors.push({ file: dataFile, message: err.message });
    }
  }

  if (!suite.errors.length) {
    const { errors, missing } = deepChecks(suite);
    suite.errors.push(...errors);
    // Variables nothing in the files sets: a setup error unless the run gives them (--var)
    suite.missing = missing;
  }
  suite.warnings.push(...unknownKeys(suite));
  if (Array.isArray(data.tests) && !data.tests.length) suite.warnings.push({ file, ...position(parsed, ["tests"]), message: "no tests yet" });
  // What the format has, but this version can't run yet: a run says so (the test or the turn is an
  // error), rather than send it without, or not at all, and pass
  suite.warnings.push(...notBuilt(data).map(({ path, message }) => ({ file, ...position(parsed, path), message })));
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
      // ({{scope.…}}: the chosen scope's, checked when it runs)
      if (head === "scope" || known.has(name) || BUILTINS.has(name) || (BUILTIN_HEADS.has(head) && head !== "row")) continue;
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
    for (const v of references(config).vars) {
      const head = v.split(".")[0];
      if (head === "scope" || known.has(v) || known.has(head) || BUILTINS.has(v) || BUILTIN_HEADS.has(head)) continue;
      missing.push({ file: where ?? file, variable: head, message: `the provider${name && !name.startsWith("test:") ? ` "${name}"` : ""} uses {{${v}}}, which the suite doesn't set` });
    }
  }
  return { errors, missing };
}

// Every ${env:…} a suite will need: in its files, and the presets' and System One's default keys
const DEFAULT_KEYS = { "openai-chat": "OPENAI_API_KEY", "openai-responses": "OPENAI_API_KEY", "anthropic-messages": "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" };
export function secretsNeeded(suite) {
  const names = new Set(references(runningData(suite.data ?? {})).env);
  for (const config of Object.values(suite.providers ?? {})) {
    for (const n of references(config).env) names.add(n);
    if (DEFAULT_KEYS[config.kind] && config.api_key === undefined) names.add(DEFAULT_KEYS[config.kind]);
  }
  // (a check turned off doesn't need its key: runningData leaves it out)
  const running = runningData(suite.data ?? {});
  const usesSystemOne = (running?.tests ?? []).some((t) => [...(t.turns ?? []).flatMap((u) => u.expect ?? []), ...(t.expect_conversation ?? [])].some((c) => String(c?.type ?? "").startsWith("systemone.")));
  if (usesSystemOne) {
    const judges = Object.values(suite.data?.judges ?? {}).filter((j) => j?.kind === "systemone");
    if (!suite.data?.judges?.default || judges.some((j) => j?.api_key === undefined)) names.add("JEV_API_KEY");
  }
  return [...names];
}

// The {{scope.NAMES}} a suite uses, in its file and its providers'
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

export function scopeNeeded(suite) {
  const names = scopeReferences(runningData(suite.data ?? {}));
  for (const config of Object.values(suite.providers ?? {})) scopeReferences(config, names);
  return [...names];
}

// The problems a run would have: the suite's errors, and the variables nothing sets, unless the run
// gives them (vars: names given at run time, as --var does); with secrets, the secrets it needs; with
// scope (the chosen one, { name, values }, or null), the {{scope.NAMES}} it hasn't
export function problemsFor(suite, vars = {}, secrets = null, scope = undefined) {
  const problems = [...(suite.errors ?? []), ...(suite.missing ?? []).filter((m) => !(m.variable in vars))];
  if (scope !== undefined && !problems.length) {
    for (const name of scopeNeeded(suite)) {
      const head = name.split(".")[0];
      const plain = scope?.values && (Object.prototype.hasOwnProperty.call(scope.values, name) || Object.prototype.hasOwnProperty.call(scope.values, head));
      const secret = scope?.name && secrets ? secrets(name) : undefined;
      if (!scope?.name) problems.push({ file: suite.file, variable: `scope.${name}`, message: `{{scope.${name}}} needs a scope: none is chosen (--env in CI)` });
      else if (!plain && (secret === undefined || secret === null || secret === "")) problems.push({ file: suite.file, variable: `scope.${name}`, message: `{{scope.${name}}} isn't in the scope "${scope.name}" (its variables or its secrets)` });
    }
  }
  if (secrets && !problems.length) {
    for (const name of secretsNeeded(suite)) {
      const value = secrets(name);
      if (value === undefined || value === null || value === "") problems.push({ file: suite.file, variable: name, message: `\${env:${name}} isn't set` });
    }
  }
  return problems;
}

const KNOWN = {
  top: ["version", "name", "group", "provider", "providers", "environments", "variables", "judges", "defaults", "setup", "teardown", "plugins", "prices", "redact", "tests"],
  test: ["name", "id", "tags", "group", "provider", "data", "setup", "teardown", "turns", "simulate", "expect_conversation", "repeat", "pass_rate", "history", "on_fail", "unsure", "unsure_below", "timeout_ms", "retries", "network", "load"],
  turn: ["user", "attachments", "reply", "extract", "tools", "expect"],
};

// Keys the app doesn't know are kept, with a warning on their line
function unknownKeys(suite) {
  const { data, parsed, file } = suite;
  if (!isObject(data)) return [];
  const out = [];
  const warn = (obj, known, path) => {
    for (const key of Object.keys(obj ?? {})) if (!known.includes(key)) out.push({ file, ...position(parsed, [...path, key]), message: `unknown key "${key}" (kept)` });
  };
  warn(data, KNOWN.top, []);
  for (const [t, test] of (data.tests ?? []).entries()) {
    warn(test, KNOWN.test, ["tests", t]);
    for (const [i, turn] of (test.turns ?? []).entries()) warn(turn, KNOWN.turn, ["tests", t, "turns", i]);
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
