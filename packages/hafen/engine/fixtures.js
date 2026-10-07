// A provider's fixtures (contracts/provider.md, Fixtures): plugins that run around its requests, by
// the lists in its `fixtures`, each list in its order:
//
//   beforeAll  once per run and scope, before the provider's first request: in a run, at the start of
//              the first suite whose chosen tests use it, before that suite's setup steps; in a
//              conversation, before its first message
//   before     before each test that uses it (each repeat and data row), before the test's setup
//              steps; in a conversation, once, after beforeAll
//   after      after each test, however it went (its teardown steps first); in a conversation, when
//              it's let go
//   afterAll   once per run and scope, when the run ends (stopped or not); in a conversation, when
//              it's let go
//
// What beforeAll's fixtures give is kept for the run (per scope), before's for that test; both are
// secrets: files and plugins' requests use them as {{secret.NAME}}, and they're redacted wherever
// they'd show. What after and afterAll return is ignored. Each run of a fixture is a `fixture` span
// (its HTTP calls as `call` spans under it) and a record (run.fixtures).

import { callSteps } from "./calls.js";
import { fixturesOf } from "./plugins.js";
import { noteSecret } from "./redact.js";
import { anySignal } from "./util.js";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TIMEOUT_MS = 60000;

// used: the run's Set of secret values, for redaction. record(fixture): each run of one, as it ends
// ({ name, phase, provider, test?, status, ms, provides, calls, error? }). retry: a conversation tries
// a failed beforeAll again with its next message (a run keeps the failure: every suite using it fails
// the same way).
//
// Each phase takes ctx { plugins, scope, envName, spans, parent, signal, provider (its file), test? }.
// value(NAME, envName): what beforeAll gave.
export function createFixtures({ used = new Set(), retry = false, record = () => {} } = {}) {
  const values = new Map();  // scope → Map(NAME → value): what beforeAll's fixtures gave
  const once = new Map();    // phase + scope + fixture → its run (a promise)
  const keep = (into, given) => {
    for (const [name, value] of Object.entries(given)) {
      into.set(name, value);
      used.add(value);
      noteSecret(value);
    }
  };
  return {
    value: (name, envName) => values.get(envName ?? "")?.get(name),
    // In order, each once per run and scope; rejects at the first that fails
    async beforeAll(config, ctx) {
      const env = ctx.envName ?? "";
      for (const ref of fixturesOf(config).beforeAll) {
        const key = `beforeAll\u0000${env}\u0000${ref.name}`;
        if (!once.has(key)) {
          once.set(key, runFixture(ref, config, "beforeAll", ctx, record, used).then((given) => {
            if (!values.has(env)) values.set(env, new Map());
            keep(values.get(env), given);
          }, (err) => {
            if (retry) once.delete(key);
            throw err;
          }));
        }
        await once.get(key);
      }
    },
    // In order, every time: what they gave, for that test (a later one's name wins); rejects at the
    // first that fails
    async before(config, ctx) {
      const given = new Map();
      for (const ref of fixturesOf(config).before) keep(given, await runFixture(ref, config, "before", ctx, record, used));
      return given;
    },
    // In order, every time, each even when one before it failed: why each that failed did
    async after(config, ctx) {
      const errors = [];
      for (const ref of fixturesOf(config).after) {
        try {
          await runFixture(ref, config, "after", ctx, record, used);
        } catch (err) {
          errors.push(err.message);
        }
      }
      return errors;
    },
    // In order, each once per run and scope: why each that failed did
    async afterAll(config, ctx) {
      const env = ctx.envName ?? "";
      const errors = [];
      for (const ref of fixturesOf(config).afterAll) {
        const key = `afterAll\u0000${env}\u0000${ref.name}`;
        if (once.has(key)) continue;
        const done = runFixture(ref, config, "afterAll", ctx, record, used);
        once.set(key, done.catch(() => {}));
        try {
          await done;
        } catch (err) {
          errors.push(err.message);
        }
      }
      return errors;
    },
  };
}

// used: where the secrets it sends (a password it names) are remembered, so its calls' steps hide them
async function runFixture(ref, config, phase, { plugins, scope, spans, parent, signal, provider, test }, record, used) {
  const plugin = plugins?.[ref.name];
  const span = spans?.start("fixture", `${ref.name} · ${phase}`, { parent });
  spans?.update(span, { fixture: { name: ref.name, phase, ...(provider ? { provider } : {}) } });
  let calls = 0;
  // (its calls' bodies kept back until what it gives is known, and so redacted in them too)
  const step = spans ? callSteps(spans, span, { hold: true }) : null;
  const onCall = (call) => {
    if (call.phase !== "end") calls += 1;
    step?.(call);
  };
  const limit = new AbortController();
  const ms = Number.isInteger(config.timeout_ms) && config.timeout_ms > 0 ? config.timeout_ms : TIMEOUT_MS;
  const timer = setTimeout(() => limit.abort(), ms);
  const took = () => {
    const s = span && spans.get(span);
    return s?.end !== undefined ? Math.round((s.end - s.start) * 10) / 10 : undefined;
  };
  const about = { name: ref.name, phase, ...(provider ? { provider } : {}), ...(test ? { test } : {}) };
  try {
    if (!plugin?.run) throw new Error(plugin ? `"${ref.name}" is a ${plugin.kind} plugin, not a fixture` : "it isn't in the folder's plugins/ or the suite's plugins");
    // The provider's fields (never a secret, as a provider plugin is given them), the variables and
    // the environment's values
    const { fixture: _old, fixtures: _lists, ...fields } = config;
    let out;
    try {
      out = await plugin.run({
        phase,
        settings: scope?.plain ? scope.plain(fields) : fields,
        variables: scope?.variables?.() ?? {},
        env: scope?.envValues?.() ?? {},
        ...(test ? { test } : {}),
      }, { signal: anySignal([signal, limit.signal]), onCall, used, ...(scope?.request ? { scope } : {}) });
    } catch (err) {
      throw limit.signal.aborted ? new Error(`timed out after ${ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`}`) : err;
    }
    const given = phase === "beforeAll" || phase === "before" ? valuesOf(out, plugin.meta.provides ?? []) : {};
    for (const value of Object.values(given)) {
      used?.add(value);
      noteSecret(value);
    }
    step?.flush?.();
    spans?.end(span, "ok", { provides: Object.keys(given), calls });
    record({ ...about, status: "ok", ms: took(), provides: Object.keys(given), calls });
    return given;
  } catch (err) {
    step?.flush?.();
    spans?.update(span, { error: err.message });
    spans?.end(span, "error", { calls });
    record({ ...about, status: "error", ms: took(), provides: [], calls, error: err.message });
    throw new Error(`the fixture "${ref.name}" (${phase}) failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// What a fixture's run() returned, checked: { NAME: text }, every name it provides and no other
function valuesOf(out, provides) {
  if (out === undefined || out === null) out = {};
  if (typeof out !== "object" || Array.isArray(out)) throw new Error("its run() returns the values it gives, by name ({ ACME_COOKIE: \"…\" }), or nothing");
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
