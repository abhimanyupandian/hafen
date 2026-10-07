// What a text, or the open files, take from the scope chosen (contracts/test-file.md, Scopes):
// {{env.NAME}} (one of its environment values) and {{secret.NAME}} or {{secrets.NAME}} (one of its
// secrets). The old ways, {{scope.NAME}} and ${env:NAME}, are found too, only so a field can say what
// to write instead: they don't count as using a name. For the fields' checks as they're typed, and
// Settings → Environments' and Secrets' "used by the open files". Nothing's resolved here: the engine
// does that.

const REF = /\{\{\s*(env|secrets?|scope)\.([A-Za-z_][\w.-]*)\s*\}\}|\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

// A text's references, in order: [{ kind: "env" | "secret" | "old", name, text }] (old, an old way:
// way "env" for ${env:NAME}, "scope" for {{scope.NAME}})
export function referencesIn(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(REF)) {
    if (m[3]) out.push({ kind: "old", way: "env", name: m[3], text: m[0] });
    else if (m[1] === "scope") out.push({ kind: "old", way: "scope", name: m[2], text: m[0] });
    else out.push({ kind: m[1] === "secrets" ? "secret" : m[1], name: m[2], text: m[0] });
  }
  return out;
}

// The presets' keys, which a provider of theirs uses when it names none (engine/providers/presets)
const DEFAULT_KEYS = { "openai-chat": "OPENAI_API_KEY", "openai-responses": "OPENAI_API_KEY", "anthropic-messages": "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" };

// The names the open suites and providers use: { env: Set (values), secret: Set (secrets, with the
// presets' default keys) }. (An old way isn't a use: it's a problem in its file, until it's written anew.)
export function usedNames({ suites = [], providers = [] }) {
  const used = { env: new Set(), secret: new Set() };
  const scan = (value) => {
    for (const r of referencesIn(JSON.stringify(value ?? {}))) if (r.kind !== "old") used[r.kind].add(r.name);
  };
  const keyOf = (config) => { if (DEFAULT_KEYS[config?.kind] && config?.api_key === undefined) used.secret.add(DEFAULT_KEYS[config.kind]); };
  for (const s of suites) {
    scan(s.data);
    for (const p of Object.values(s.providers ?? {})) {
      scan(p);
      keyOf(p);
    }
  }
  for (const p of providers) {
    scan(p.config);
    keyOf(p.config);
  }
  return used;
}

// Whether a scope's values have a name: as it is, or a dotted one reaching into a map (db.host)
export function hasValue(values, name) {
  if (Object.prototype.hasOwnProperty.call(values ?? {}, name)) return true;
  let v = values;
  for (const part of name.split(".")) {
    if (v === null || typeof v !== "object" || !Object.prototype.hasOwnProperty.call(v, part)) return false;
    v = v[part];
  }
  return true;
}
