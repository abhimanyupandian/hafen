// Variables in suite and provider files (contracts/test-file.md, Variables):
//
//   {{name}}        a test variable: extractions and setup steps (latest first), then the data row
//                   ({{row.col}}), then the suite's variables, then its environment's (environments.<name>)
//   {{env.NAME}}    a value of the chosen environment: what a provider's fixture set with env.set (for
//                   the rest of the run: engine/fixtures.js), then the values whoever runs the engine
//                   passes (the app's, for its scope; the CLI's --env <file>), then the suite's own
//                   environments.<name>. A dotted name is that key first ({{env.db.host}}: "db.host"),
//                   else it reaches into a value.
//   {{secret.NAME}} a secret (also {{secrets.NAME}}): the host's (the app's keystore for its scope, the
//                   CLI's --secret files, then its process environment). Every value resolved this way
//                   is remembered, so it can be redacted wherever it appears.
//
// A string that is exactly one {{name}} becomes that value with its type (a number stays a number,
// {{messages}} stays a list); inside other text it's text. A name that can't be found is an error
// (a setup error, before anything is sent): nothing is ever sent as written.
//
// {{env.…}} and {{secret.…}} are filled in only in text the files wrote: a template's own text, and
// the values of the variables a file (or --var, or the environment) gives, which are `trusted`. Never
// in what a {{name}} brings in from elsewhere (an extraction from a reply, a data row, the message): a
// reply that says "{{secret.CI_TOKEN}}" mustn't have the secret sent back in the next turn.

import { NAME, NAME_RULE } from "./env-file.js";
import { noteSecret } from "./redact.js";
import { isObject } from "./util.js";

const VAR = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;
const WHOLE = /^\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}$/;
// What trusted text has filled in: {{env.…}}, {{secret.…}}, {{secrets.…}}
const TRUSTED = /\{\{\s*((?:env|secrets?)\.[\w.-]+)\s*\}\}/g;
// What a plugin's request has filled in as it leaves (engine/plugins.js): {{secret.…}} and {{env.…}}
const REQUEST = /\{\{\s*((?:env|secrets?)\.[\w.-]+)\s*\}\}/g;
const REF = /^(env|secrets?)\.(.+)$/;

// What a {{name}} names when it's one of the environment's or a secret: { kind: "env" | "secret",
// name }, or null (a test variable)
export function refOf(name) {
  const m = REF.exec(name);
  return m ? { kind: m[1] === "secrets" ? "secret" : m[1], name: m[2] } : null;
}

// What's wrong with a {{secret.NAME}} or {{env.NAME}} whose NAME isn't a name (env-file.js, NAME:
// {{secret.1KEY}}), or "": a problem where a file writes it, and never looked up
export const badName = (ref) => (ref && !NAME.test(ref.name) ? `{{${ref.kind}.${ref.name}}}: "${ref.name}" isn't a name (${NAME_RULE})` : "");

// Why a name can't be found. kind: "variable" ({{name}}), "secret" ({{secret.NAME}}: where, the
// scope's name) or "environment" ({{env.NAME}}: where, the environment's name, "" one with none, null
// none chosen)
export function missingMessage(name, kind = "variable", where) {
  // (where: the scope's name, or the chosen environment, which may say where its secrets come from:
  // the CLI's "not in the --secret file or the environment")
  if (kind === "secret") {
    const from = where && typeof where === "object" ? where.secretsFrom : undefined;
    const scope = where && typeof where === "object" ? where.name : where;
    return `{{secret.${name}}} isn't set${from ? ` (${from})` : scope ? ` for the scope "${scope}"` : ""}`;
  }
  if (kind === "environment") {
    if (where === null || where === undefined) return `{{env.${name}}} isn't set: no environment is chosen (the app's scope, or --env <file> in the CLI)`;
    return `{{env.${name}}} isn't set: the environment${where ? ` "${where}"` : ""} has no ${name}`;
  }
  return `{{${name}}} isn't set`;
}

// What a missing secret's message says of where it was looked for: the chosen environment (which may
// carry the host's secretsFrom), else the host's secretsFrom alone (the CLI with no --env)
export const secretsWhere = (environment, secretsFrom) => environment ?? (secretsFrom ? { secretsFrom } : undefined);

export class MissingVariable extends Error {
  constructor(name, kind = "variable", where) {
    super(missingMessage(name, kind, where));
    this.name = "MissingVariable";
    // (a secret's by its name, as the host keeps it; an environment's value as env.NAME)
    this.variable = kind === "environment" ? `env.${name}` : name;
    this.kind = kind;
  }
}

// The value at a dotted path in an object ("db.host": that key first, else db's host), or undefined
export const valueAt = (values, path) => {
  if (values && Object.prototype.hasOwnProperty.call(values, path)) return values[path];
  let v = values;
  for (const part of path.split(".")) {
    if (v === null || typeof v !== "object" || !Object.prototype.hasOwnProperty.call(v, part)) return undefined;
    v = v[part];
  }
  return v;
};
const at = valueAt;

const filled = (value) => value !== undefined && value !== null && value !== "";

// A scope: layers of variables looked up in order, the chosen environment, and where secrets come from.
//   layers: [{name: value}], first wins; secrets: (NAME) => value | undefined
//   trusted: the layers a file (or --var) wrote, whose values' {{env.…}}, {{secret.…}} are filled in
//   environment: { name, values, suite } the chosen one (values: what the engine was given; suite: the
//     suite's own environments.<name>), or null (or left out): none chosen
//   overlay: what the fixtures set with env.set ({ NAME: text }, kept by engine/fixtures.js, which
//     adds to it as they run): over the environment, chosen or not. Its values are no template.
export function createScope({ layers = [], secrets = () => undefined, used = new Set(), environment = null, trusted = [], secretsFrom, overlay = null } = {}) {
  const trust = trusted instanceof Set ? trusted : new Set(trusted);
  const chosen = environment ?? null;

  // (a name that isn't one, {{env.1x}}: said, never looked up)
  const named = (kind, name) => {
    const bad = badName({ kind, name });
    if (bad) throw new Error(bad);
  };
  // {{env.NAME}}: the values given, then the suite's environment of that name (both trusted: files and
  // people wrote them)
  const envHit = (path) => {
    named("env", path);
    if (overlay && Object.prototype.hasOwnProperty.call(overlay, path)) return { found: true, value: overlay[path], trusted: false };
    if (!chosen) return { found: false };
    for (const values of [chosen.values, chosen.suite]) {
      const value = at(values ?? {}, path);
      if (value !== undefined && value !== null) return { found: true, value, trusted: true };
    }
    return { found: false };
  };
  // {{secret.NAME}}: remembered, to be redacted (never looked into: a secret is no template). Only
  // text is a secret's value (a host's lookup that finds something else has found none)
  const secretHit = (name) => {
    named("secret", name);
    const value = secrets(name);
    if (typeof value !== "string" || !filled(value)) return { found: false };
    used.add(value);
    noteSecret(value);
    return { found: true, value };
  };
  const refHit = (ref) => (ref.kind === "env" ? envHit(ref.name) : secretHit(ref.name));
  const missingRef = (ref) => (ref.kind === "env"
    ? new MissingVariable(ref.name, "environment", chosen ? chosen.name ?? "" : null)
    : new MissingVariable(ref.name, "secret", secretsWhere(chosen, secretsFrom)));

  const lookup = (name) => {
    const ref = refOf(name);
    if (ref) return refHit(ref);
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

  const missing = (name) => {
    const ref = refOf(name);
    return ref ? missingRef(ref) : new MissingVariable(name);
  };

  // A {{name}} that's one of the environment's or a secret, as text in trusted text; an environment's
  // value has its own filled in too (`seen`: the ones on the way, so one that uses itself is said)
  const refText = (name, seen) => {
    const ref = refOf(name);
    const hit = refHit(ref);
    if (!hit.found) throw missingRef(ref);
    if (!hit.trusted) return typeof hit.value === "string" ? hit.value : JSON.stringify(hit.value);
    if (seen.includes(name)) throw new Error(`{{${name}}} uses itself (${[...seen, name].map((n) => `{{${n}}}`).join(" → ")})`);
    const value = fillValue(hit.value, [...seen, name]);
    return typeof value === "string" ? value : JSON.stringify(value);
  };
  // Trusted text: its {{env.…}}s and {{secret.…}}s filled in, in one pass (what one brings isn't
  // looked at again: a secret's value is no template). Its other {{name}}s stay as they are: a value
  // isn't a template.
  const fill = (text, seen = []) => text.replace(TRUSTED, (_, name) => refText(name, seen));
  const fillValue = (value, seen = []) => {
    if (typeof value === "string") return fill(value, seen);
    if (Array.isArray(value)) return value.map((v) => fillValue(v, seen));
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillValue(v, seen)]));
    return value;
  };
  // A {{name}}'s value: the call's own (`extra`: the message, the history: not a file's), or a layer's
  const hitOf = (name, extra) => (extra && Object.prototype.hasOwnProperty.call(extra, name) ? { found: true, value: extra[name], trusted: false } : lookup(name));
  const valueOf = (name, extra) => {
    const hit = hitOf(name, extra);
    if (!hit.found) throw missing(name);
    return hit.trusted ? fillValue(hit.value, refOf(name) ? [name] : []) : hit.value;
  };
  // Resolve one string: each {{name}} with its value (whose {{env.…}} and {{secret.…}} are filled in
  // only if a file wrote it)
  const string = (text, extra) => {
    const whole = text.match(WHOLE);
    if (whole) return valueOf(whole[1], extra);
    return text.replace(VAR, (_, name) => {
      const value = valueOf(name, extra);
      return typeof value === "string" ? value : JSON.stringify(value);
    });
  };

  // Resolve every string in a value (deeply). `extra`: variables for this call only.
  const resolve = (value, extra) => {
    if (typeof value === "string") return string(value, extra);
    if (Array.isArray(value)) return value.map((v) => resolve(v, extra));
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, extra)]));
    return value;
  };

  // What a plugin may be given (contracts/provider.md, Code plugins): never a secret. Its {{name}}s
  // filled from the variables, and {{env.NAME}} from the environment (one it hasn't is an error, as
  // anywhere); a {{secret.…}} stays as written (filled in when a request of the plugin's has it:
  // engine/plugins.js), in the text and in what a {{name}} brings; any other name not found stays as
  // it's written. keep: an {{env.NAME}} the environment hasn't
  // stays as written too (a fixture's settings: one a fixture sets with env.set isn't set before it's
  // run, and the check before a run has said already of any that nothing sets).
  const plain = (value, { keep = false } = {}) => {
    const plainValue = (v) => {
      if (typeof v === "string") return v.replace(REQUEST, (text, name) => {
        const ref = refOf(name);
        if (ref.kind !== "env") return text;
        const hit = envHit(ref.name);
        if (!hit.found) {
          if (keep) return text;
          throw missingRef(ref);
        }
        const inner = hit.trusted ? plainValue(hit.value) : hit.value;
        return typeof inner === "string" ? inner : JSON.stringify(inner);
      });
      if (Array.isArray(v)) return v.map(plainValue);
      if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plainValue(x)]));
      return v;
    };
    const plainHit = (name) => {
      const ref = refOf(name);
      if (ref?.kind === "secret") return { found: false };
      if (ref) {
        const hit = envHit(ref.name);
        if (!hit.found && !keep) throw missingRef(ref);
        return hit;
      }
      return lookup(name);
    };
    const plainOf = (hit) => (hit.trusted ? plainValue(hit.value) : hit.value);
    const each = (v) => {
      if (typeof v === "string") {
        const whole = v.match(WHOLE);
        if (whole) {
          const hit = plainHit(whole[1]);
          return hit.found ? plainOf(hit) : v;
        }
        return v.replace(VAR, (text, name) => {
          const hit = plainHit(name);
          if (!hit.found) return text;
          const out = plainOf(hit);
          return typeof out === "string" ? out : JSON.stringify(out);
        });
      }
      if (Array.isArray(v)) return v.map(each);
      if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, each(x)]));
      return v;
    };
    return each(value);
  };
  // The variables as a plugin is given them: every layer's (the first one's winning)
  const variables = () => {
    const out = {};
    for (const layer of [...layers].reverse()) if (layer) Object.assign(out, layer);
    return structuredClone(out);
  };
  // The chosen environment's values as a plugin is given them (`env`): the suite's environment of its
  // name, the values given over it, and what the fixtures set over those. As they're written: never a
  // secret.
  const envValues = () => structuredClone({ ...(chosen?.suite ?? {}), ...(chosen?.values ?? {}), ...(overlay ?? {}) });

  // The text in the layers no file wrote (an extraction from a reply, a data row) that has a
  // {{secret.…}} or {{env.…}} in it: what a plugin's request mustn't have filled in
  const tainted = () => {
    const out = [];
    for (const layer of layers) if (layer && !trust.has(layer)) placeholders(layer, out);
    return out;
  };

  // What fills a plugin's request in as it leaves (engine/plugins.js): (text) → the text with each
  // {{secret.NAME}} and {{env.NAME}} filled in (one not set: an error, and the request isn't sent),
  // but not inside `untrusted` text (what the plugin was given from a reply, a row, an extraction:
  // as it was, or escaped in JSON) or what the layers no file wrote have
  const request = (untrusted = []) => {
    const forms = [...new Set([...untrusted, ...tainted()].flatMap((t) => [t, JSON.stringify(t).slice(1, -1)]))];
    return (text) => {
      if (!text.includes("{{")) return text;
      const spans = [];
      for (const form of forms) for (let i = text.indexOf(form); i !== -1; i = text.indexOf(form, i + 1)) spans.push([i, i + form.length]);
      return text.replace(REQUEST, (written, name, offset) => {
        if (spans.some(([start, end]) => offset >= start && offset < end)) return written;
        const ref = refOf(name);
        const hit = refHit(ref);
        if (!hit.found) throw missingRef(ref);
        const value = hit.trusted ? fillValue(hit.value, [name]) : hit.value;
        return typeof value === "string" ? value : JSON.stringify(value);
      });
    };
  };

  return {
    resolve,
    plain,
    variables,
    envValues,
    lookup,
    request,
    tainted,
    secretsUsed: used,
    // The same scope, its secrets looked for in `values` (a Map) first: what a test's before fixtures gave
    withSecrets: (values) => createScope({ layers, secrets: (name) => values.get(name) ?? secrets(name), used, environment: chosen, trusted: trust, secretsFrom, overlay }),
    // A scope with another layer in front (extractions as a test goes on)
    // (what it adds isn't a file's: an extraction, a row, the run's own values)
    with: (layer) => createScope({ layers: [layer, ...layers], secrets, used, environment: chosen, trusted: trust, secretsFrom, overlay }),
    environment: chosen,
    // A message typed in a conversation: its {{env.…}} and {{secret.…}} filled in, its other {{…}} as
    // they are (sent as typed)
    typed: (text) => String(text).replace(TRUSTED, (_, name) => refText(name, [])),
  };
}

// (a {{secret.…}} or {{env.…}} in a text)
const PLACEHOLDER = /\{\{\s*(?:env|secrets?)\./;

// The texts in a value (deeply) that have a {{secret.…}} or {{env.…}} in them
export function placeholders(value, out = []) {
  if (typeof value === "string") {
    if (PLACEHOLDER.test(value)) out.push(value);
  } else if (Array.isArray(value)) value.forEach((v) => placeholders(v, out));
  else if (isObject(value)) Object.values(value).forEach((v) => placeholders(v, out));
  return out;
}

// The names a value uses: { vars: every {{name}} ({{env.…}} and {{secret.…}} too), env: the secrets it
// names ({{secret.NAME}}), environment: its {{env.NAMES}} }
export function references(value, out = { vars: new Set(), env: new Set(), environment: new Set() }) {
  if (typeof value === "string") {
    for (const m of value.matchAll(VAR)) {
      out.vars.add(m[1]);
      const ref = refOf(m[1]);
      if (ref?.kind === "secret") out.env.add(ref.name);
      else if (ref?.kind === "env") out.environment.add(ref.name);
    }
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
