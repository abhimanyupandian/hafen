// Where things are in a parsed suite or provider file (line and column, for every problem), and the
// names its text uses ({{name}}, {{env.NAME}}, {{secret.NAME}}), each where it's first written.

import { LineCounter, parseDocument } from "yaml";
import { isObject } from "../util.js";
import { badName, references, refOf } from "../vars.js";

export const BUILTINS = new Set(["user", "messages", "history", "session", "repeat"]);

export const BUILTIN_HEADS = new Set(["row", "run", "test", "turn"]);

// The heads of what isn't a test variable: the environment's ({{env.NAME}}) and a secret
// ({{secret.NAME}}, {{secrets.NAME}})
export const REF_HEADS = new Set(["env", "secret", "secrets"]);

// Parse a YAML or JSON file's text: { doc, data, lines, kind, errors }
export function parseText(text, file) {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, keepSourceTokens: true, prettyErrors: true });
  const kind = /\.json$/i.test(file) ? "json" : "yaml";
  const errors = doc.errors.map((e) => ({ file, line: e.linePos?.[0]?.line, column: e.linePos?.[0]?.col, message: e.message.split("\n")[0] }));
  return { doc, data: errors.length ? null : doc.toJS(), lines, kind, errors };
}

// Where a value is in a parsed file: { line, column }
export function position(parsed, path) {
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
export function placesOf(parsed, value, path = [], out = {}) {
  out[path.join("\u0000")] = position(parsed, path);
  if (Array.isArray(value)) value.forEach((v, i) => placesOf(parsed, v, [...path, i], out));
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) placesOf(parsed, v, [...path, k], out);
  return out;
}

// Where a provider reference is in a suite: "" its own, test:N a test's, a name one under providers
export const refPath = (key) => (key === "" ? ["provider"] : key.startsWith("test:") ? ["tests", Number(key.slice(5)), "provider"] : ["providers", key]);

// What usePlaces looks for: the names a text uses, and how each is written
const quote = (name) => name.replace(/\./g, "\\.");

export const USES = {
  // a secret, either way it's written ({{secret.NAME}}, {{secrets.NAME}})
  secret: { names: (text) => references(text).env, written: (name) => new RegExp(`\\{\\{\\s*secrets?\\.${quote(name)}\\s*\\}\\}`, "g") },
  environment: { names: (text) => references(text).environment, written: (name) => new RegExp(`\\{\\{\\s*env\\.${quote(name)}\\s*\\}\\}`, "g") },
  // a {{secret.NAME}} or {{env.NAME}} whose NAME isn't a name ({{secret.1KEY}}), by the whole of it
  badName: { names: (text) => new Set([...references(text).vars].filter((n) => badName(refOf(n)))), written: (name) => new RegExp(`\\{\\{\\s*${quote(name)}\\s*\\}\\}`, "g") },
  vars: { names: (text) => references(text).vars, written: (name) => new RegExp(`\\{\\{\\s*${quote(name)}\\s*\\}\\}`, "g") },
};

// Where each name `uses` looks for (USES.secret, USES.environment, USES.vars) in a parsed file's value
// is first written (its "{{", in the text), in the file's order: Map NAME → { line, column }. A check
// turned off is left out.
export function usePlaces(uses, parsed, text, value, path = [], out = new Map()) {
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

export const listOf = (v) => (Array.isArray(v) ? v : []);
