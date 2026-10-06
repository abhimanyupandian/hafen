// A provider's fixture (contracts/provider.md, Fixtures): a plugin whose setup() runs before the
// provider's first request (a login, say) and gives values by name: cookies, tokens, headers. They're
// kept for the run (or the conversation) only, as secrets: files use them as ${env:NAME} or
// {{scope.NAME}}, plugins name them ({ secret: "NAME" }) for the engine to fill in, and they're
// redacted wherever they'd show. A fixture runs once per run and scope, however many suites and tests
// use a provider that names it, with the settings of the first one.

import { fixtureRef } from "./plugins.js";
import { noteSecret } from "./redact.js";
import { anySignal } from "./util.js";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TIMEOUT_MS = 60000;

// used: the run's Set of secret values, for redaction. value(NAME, envName): a fixture's value, once
// it has run. ensure(config, ctx): run the fixture a provider names (if it hasn't run for this scope),
// ctx { plugins, scope, envName, spans, parent, signal }; it rejects with why it failed. A run keeps a
// failure (every suite using it fails the same way); a conversation (retry) tries again next time.
export function createFixtures({ used = new Set(), retry = false } = {}) {
  const values = new Map();  // scope name → Map(NAME → value)
  const runs = new Map();    // scope name + fixture → its run (a promise)
  return {
    value: (name, envName) => values.get(envName ?? "")?.get(name),
    ensure(config, ctx) {
      const ref = fixtureRef(config);
      if (!ref) return Promise.resolve();
      const env = ctx.envName ?? "";
      const key = `${env}\u0000${ref.name}`;
      if (!runs.has(key)) {
        runs.set(key, runFixture(ref, config, ctx).then((given) => {
          if (!values.has(env)) values.set(env, new Map());
          for (const [name, value] of Object.entries(given)) {
            values.get(env).set(name, value);
            used.add(value);
            noteSecret(value);
          }
        }, (err) => {
          if (retry) runs.delete(key);
          throw err;
        }));
      }
      return runs.get(key);
    },
  };
}

async function runFixture(ref, config, { plugins, scope, spans, parent, signal }) {
  const plugin = plugins?.[ref.name];
  const span = spans?.start("fixture", `fixture ${ref.name}`, { parent });
  const limit = new AbortController();
  const ms = Number.isInteger(config.timeout_ms) && config.timeout_ms > 0 ? config.timeout_ms : TIMEOUT_MS;
  const timer = setTimeout(() => limit.abort(), ms);
  try {
    if (!plugin?.setup) throw new Error(plugin ? `"${ref.name}" is a ${plugin.kind} plugin, not a fixture` : "it isn't in the folder's plugins/ or the suite's plugins");
    // The provider's fields (never a secret: as a provider plugin is given them), and the variables
    const { fixture: _, ...fields } = config;
    let out;
    try {
      out = await plugin.setup({ settings: scope?.plain ? scope.plain(fields) : fields, variables: scope?.variables?.() ?? {} }, { signal: anySignal([signal, limit.signal]) });
    } catch (err) {
      throw limit.signal.aborted ? new Error(`timed out after ${Math.round(ms / 1000)} s`) : err;
    }
    const given = valuesOf(out, plugin.meta.provides ?? []);
    spans?.end(span, "ok", { provides: Object.keys(given) });
    return given;
  } catch (err) {
    spans?.end(span, "error");
    throw new Error(`the fixture "${ref.name}" failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// What a fixture's setup() returned, checked: { NAME: text }, every name it provides and no other
function valuesOf(out, provides) {
  if (!out || typeof out !== "object" || Array.isArray(out)) throw new Error("its setup() returns the values it gives, by name ({ ACME_COOKIE: \"…\" })");
  const given = {};
  for (const [name, value] of Object.entries(out)) {
    if (!NAME.test(name)) throw new Error(`"${name}" isn't a name it can give (letters, digits and _, not starting with a digit)`);
    if (provides.length && !provides.includes(name)) throw new Error(`it gave ${name}, which isn't in its provides (${provides.join(", ")})`);
    if (value === undefined || value === null || value === "") throw new Error(`it gave no value for ${name}`);
    if (typeof value === "object") throw new Error(`${name} isn't text (join a list of cookies into one: "a=1; b=2")`);
    given[name] = String(value);
  }
  const missing = provides.filter((n) => !(n in given));
  if (missing.length) throw new Error(`it didn't give ${missing.join(", ")}`);
  return given;
}
