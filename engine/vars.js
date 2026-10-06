// Variables in suite and provider files (contracts/test-file.md, Variables):
//
//   {{name}}      a test variable: extractions and setup steps (latest first), then the data row
//                 ({{row.col}}), then the suite's variables, then the chosen environment's
//   ${env:NAME}   the process's environment (CI) or the app's stored secrets: secrets. Every value
//                 resolved this way is remembered, so it can be redacted wherever it appears.
//   {{scope.NAME}} the chosen scope's (stage, prod: --env, the app's Settings → Environments): its plain
//                 variables (environments/<scope>.yml), else its secrets (a secret's value is
//                 remembered for redaction, as ${env:…}'s are). Dotted names reach into a variable
//                 ({{scope.db.host}}).
//
// A string that is exactly one {{name}} becomes that value with its type (a number stays a number,
// {{messages}} stays a list); inside other text it's text. A name that can't be found is an error
// (a setup error, before anything is sent).
//
// ${env:NAME} is filled in only in text the files wrote: a template's own text, and the values of the
// variables a file (or --var) gives, which are `trusted`. Never in what a {{name}} brings in from
// elsewhere (an extraction from a reply, a data row, the message): a reply that says
// "${env:CI_TOKEN}" mustn't have the secret sent back in the next turn.

import { noteSecret } from "./redact.js";
import { isObject } from "./util.js";

const VAR = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;
const WHOLE = /^\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}$/;
const ENV = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

export class MissingVariable extends Error {
  constructor(name, kind = "variable", scopeName) {
    super(kind === "env" ? `\${env:${name}} isn't set`
      : kind === "scope" ? (scopeName ? `{{${name}}} isn't in the scope "${scopeName}" (its variables or its secrets)` : `{{${name}}} needs a scope: none is chosen (--env in CI)`)
        : `{{${name}}} isn't set`);
    this.name = "MissingVariable";
    this.variable = name;
    this.kind = kind;
  }
}

// The value at a dotted path in an object ("db.host"), or undefined
const at = (values, path) => {
  if (values && Object.prototype.hasOwnProperty.call(values, path)) return values[path];
  let v = values;
  for (const part of path.split(".")) {
    if (v === null || typeof v !== "object" || !Object.prototype.hasOwnProperty.call(v, part)) return undefined;
    v = v[part];
  }
  return v;
};

// A scope: layers of variables looked up in order, and where secrets come from.
//   layers: [{name: value}], first wins; secrets: (NAME) => value | undefined
//   trusted: the layers a file (or --var) wrote, whose values' ${env:…} are filled in
//   scope: { name, values } the chosen scope, for {{scope.NAME}} (or null: none chosen)
export function createScope({ layers = [], secrets = () => undefined, used = new Set(), scope = null, trusted = [] } = {}) {
  const trust = trusted instanceof Set ? trusted : new Set(trusted);
  // {{scope.NAME}}: its plain variable (the scope's file: trusted), else its secret
  const scoped = (path) => {
    if (!scope?.name) return { found: false };
    const plain = at(scope.values ?? {}, path);
    if (plain !== undefined && plain !== null) return { found: true, value: plain, trusted: true };
    const value = secrets(path);
    if (value === undefined || value === null || value === "") return { found: false };
    used.add(String(value));
    noteSecret(value);
    return { found: true, value: String(value) };
  };
  const lookup = (name) => {
    if (name.startsWith("scope.")) return scoped(name.slice(6));
    for (const layer of layers) {
      if (!layer) continue;
      if (Object.prototype.hasOwnProperty.call(layer, name)) return { found: true, value: layer[name], trusted: trust.has(layer) };
      // Dotted names reach into objects ({{row.question}}, {{run.id}})
      const dot = name.indexOf(".");
      if (dot > 0) {
        const head = name.slice(0, dot);
        if (Object.prototype.hasOwnProperty.call(layer, head)) {
          let value = layer[head];
          for (const part of name.slice(dot + 1).split(".")) value = value?.[part];
          if (value !== undefined) return { found: true, value, trusted: trust.has(layer) };
        }
      }
    }
    return { found: false };
  };

  const secret = (name) => {
    const value = secrets(name);
    if (value === undefined || value === null || value === "") throw new MissingVariable(name, "env");
    used.add(String(value));
    noteSecret(value);
    return String(value);
  };

  const missing = (name) => (name.startsWith("scope.") ? new MissingVariable(name, "scope", scope?.name) : new MissingVariable(name));

  // The ${env:…}s in text a file wrote
  const env = (text) => text.replace(ENV, (_, name) => secret(name));
  // A {{name}}'s value: the call's own (`extra`: the message, the history: not a file's), or a layer's
  const hitOf = (name, extra) => (extra && Object.prototype.hasOwnProperty.call(extra, name) ? { found: true, value: extra[name], trusted: false } : lookup(name));
  // Resolve one string: its own text's ${env:…}s, and each {{name}} with its value (whose ${env:…}s
  // only if a file wrote it)
  const string = (text, extra) => {
    const whole = text.match(WHOLE);
    if (whole) {
      const hit = hitOf(whole[1], extra);
      if (!hit.found) throw missing(whole[1]);
      return typeof hit.value === "string" && hit.trusted ? env(hit.value) : hit.value;
    }
    let out = "";
    let last = 0;
    for (const m of text.matchAll(VAR)) {
      out += env(text.slice(last, m.index));
      const hit = hitOf(m[1], extra);
      if (!hit.found) throw missing(m[1]);
      out += typeof hit.value === "string" ? (hit.trusted ? env(hit.value) : hit.value) : JSON.stringify(hit.value);
      last = m.index + m[0].length;
    }
    return out + env(text.slice(last));
  };

  // Resolve every string in a value (deeply). `extra`: variables for this call only.
  const resolve = (value, extra) => {
    if (typeof value === "string") return string(value, extra);
    if (Array.isArray(value)) return value.map((v) => resolve(v, extra));
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, extra)]));
    return value;
  };

  // What a plugin may be given (contracts/provider.md, Code plugins): never a secret. Its {{name}}s
  // filled from the variables and the scope's plain ones only (a scope's secret isn't looked up, and a
  // ${env:…} stays as written, in the text and in what a {{name}} brings); a name not found stays as
  // it's written.
  const plainHit = (name) => {
    if (name.startsWith("scope.")) {
      const value = scope?.name ? at(scope.values ?? {}, name.slice(6)) : undefined;
      return value === undefined || value === null ? { found: false } : { found: true, value };
    }
    return lookup(name);
  };
  const plain = (value) => {
    if (typeof value === "string") {
      const whole = value.match(WHOLE);
      if (whole) {
        const hit = plainHit(whole[1]);
        return hit.found ? hit.value : value;
      }
      return value.replace(VAR, (text, name) => {
        const hit = plainHit(name);
        return !hit.found ? text : typeof hit.value === "string" ? hit.value : JSON.stringify(hit.value);
      });
    }
    if (Array.isArray(value)) return value.map(plain);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
    return value;
  };
  // The variables as a plugin is given them: every layer's (the first one's winning), and the
  // scope's plain values as `scope`
  const variables = () => {
    const out = {};
    for (const layer of [...layers].reverse()) if (layer) Object.assign(out, layer);
    if (scope?.name) out.scope = { ...(scope.values ?? {}) };
    return structuredClone(out);
  };

  return {
    resolve,
    plain,
    variables,
    lookup,
    secretsUsed: used,
    // A secret's value by its name, or undefined (what a plugin's { secret: NAME } is filled from)
    secretValue: (name) => secrets(name),
    // A scope with another layer in front (extractions as a test goes on)
    // (what it adds isn't a file's: an extraction, a row, the run's own values)
    with: (layer) => createScope({ layers: [layer, ...layers], secrets, used, scope, trusted: trust }),
    scope,
    // Only the {{scope.NAME}}s in a text (a message typed in a conversation): its other {{…}} stay
    // as they are
    scopeOnly: (text) => String(text).replace(SCOPE_VAR, (_, name) => {
      const hit = scoped(name);
      if (!hit.found) throw missing(`scope.${name}`);
      return typeof hit.value === "string" ? hit.value : JSON.stringify(hit.value);
    }),
  };
}

const SCOPE_VAR = /\{\{\s*scope\.([A-Za-z_][\w.-]*)\s*\}\}/g;

// The {{scope.NAMES}} a value uses (the names after "scope.")
export function scopeReferences(value, out = new Set()) {
  for (const name of references(value).vars) if (name.startsWith("scope.")) out.add(name.slice(6));
  return out;
}

// The {{names}} and ${env:NAMES} a value uses: {vars: Set, env: Set}
export function references(value, out = { vars: new Set(), env: new Set() }) {
  if (typeof value === "string") {
    for (const m of value.matchAll(VAR)) out.vars.add(m[1]);
    for (const m of value.matchAll(ENV)) out.env.add(m[1]);
  } else if (Array.isArray(value)) value.forEach((v) => references(v, out));
  else if (isObject(value)) Object.values(value).forEach((v) => references(v, out));
  return out;
}

// Typed comparison values: "4417" from a data row compares as a number when it parses as one
export function typed(value) {
  if (typeof value !== "string") return value;
  if (/^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}
