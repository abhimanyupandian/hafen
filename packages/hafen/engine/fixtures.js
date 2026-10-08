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
// A fixture runs only in the lists its phases name (all four when it doesn't say): a provider that
// names it in another is a problem before anything is sent (plugins.js, fixtureIssues).
//
// What run() returns: nothing, or true, goes on; false says to stop (beforeAll: the run stops before
// the provider's tests are sent; before: that test's run, or row, is stopped and the others go on;
// after and afterAll: nothing changes, it's recorded); { NAME: text }, the values it gives, goes on.
// What beforeAll's fixtures give is kept for the run (per scope), before's for that test; both are
// secrets: files and plugins' requests use them as {{secret.NAME}}, and they're redacted wherever
// they'd show. What after and afterAll give is ignored.
//
// What a fixture sets with env.set(NAME, value) (any phase) is the environment's for the rest of the
// run, in its scope (in a conversation, until it's let go): later requests, checks and fixtures have
// it as {{env.NAME}}, over the environment's own. It's kept here, never written anywhere, and gone
// when the run ends. Its values aren't secrets (each is plain text, and redacted only when it's one).
//
// Each run of a fixture is a `fixture` span (its HTTP calls as `call` spans under it) and a record
// (run.fixtures).

import { callSteps } from "./calls.js";
import { NAME, NAME_RULE } from "./env-file.js";
import { fixturesOf, phasesText, runsIn } from "./plugins.js";
import { headerSecrets, noteSecret } from "./redact.js";
import { anySignal } from "./util.js";
import { pluginsWhere } from "./plugin-place.js";

const TIMEOUT_MS = 60000;

// A value a fixture gives is a secret, and so is the credential in it when it's "<scheme>
// <credential>" (Bearer tok_…: tok_…, as its login's answer has it), wherever either shows
const remember = (used, value) => {
  for (const secret of headerSecrets(value)) {
    used?.add(secret);
    noteSecret(secret);
  }
};

// used: the run's Set of secret values, for redaction. record(fixture): each run of one, as it ends
// ({ name, phase, provider, test?, status, ms, provides, sets?, stop?, calls, error? }). retry: a
// conversation tries a failed beforeAll, or one that said to stop, again with its next message (a run
// keeps the failure: every suite using it fails the same way).
//
// Each phase takes ctx { plugins, scope, envName, spans, parent, signal, provider (its file), test? }.
// value(NAME, envName): what beforeAll gave. env(envName): what the fixtures set with env.set in that
// scope, { NAME: text }, the overlay its scopes are made with (vars.js), added to as they run.
export function createFixtures({ used = new Set(), retry = false, record = () => {} } = {}) {
  const values = new Map();  // scope → Map(NAME → value): what beforeAll's fixtures gave
  const sets = new Map();    // scope → { NAME: text }: what the fixtures set with env.set
  const once = new Map();    // phase + scope + fixture → its run (a promise)
  const keep = (into, given) => {
    for (const [name, value] of Object.entries(given)) {
      into.set(name, value);
      remember(used, value);
    }
  };
  const env = (envName) => {
    if (!sets.has(envName ?? "")) sets.set(envName ?? "", {});
    return sets.get(envName ?? "");
  };
  const own = { record, used, env };
  return {
    value: (name, envName) => values.get(envName ?? "")?.get(name),
    env,
    // In order, each once per run and scope; rejects at the first that fails. Resolves with why the
    // run stops when one said to (its run() returned false: the ones after it don't run), else null.
    async beforeAll(config, ctx) {
      const scope = ctx.envName ?? "";
      for (const ref of fixturesOf(config).beforeAll) {
        const key = `beforeAll\u0000${scope}\u0000${ref.name}`;
        if (!once.has(key)) {
          once.set(key, runFixture(ref, config, "beforeAll", ctx, own).then(({ given, stop }) => {
            if (stop) {
              if (retry) once.delete(key);
              return stop;
            }
            if (!values.has(scope)) values.set(scope, new Map());
            keep(values.get(scope), given);
            return null;
          }, (err) => {
            if (retry) once.delete(key);
            throw err;
          }));
        }
        const stop = await once.get(key);
        if (stop) return stop;
      }
      return null;
    },
    // In order, every time: { given: what they gave, for that test (a later one's name wins), stop:
    // why that test stops, when one said to (the ones after it don't run), else null }; rejects at
    // the first that fails
    async before(config, ctx) {
      const given = new Map();
      for (const ref of fixturesOf(config).before) {
        const out = await runFixture(ref, config, "before", ctx, own);
        if (out.stop) return { given, stop: out.stop };
        keep(given, out.given);
      }
      return { given, stop: null };
    },
    // In order, every time, each even when one before it failed: why each that failed did. (One that
    // says to stop changes nothing: it's recorded.)
    async after(config, ctx) {
      const errors = [];
      for (const ref of fixturesOf(config).after) {
        try {
          await runFixture(ref, config, "after", ctx, own);
        } catch (err) {
          errors.push(err.message);
        }
      }
      return errors;
    },
    // In order, each once per run and scope: why each that failed did
    async afterAll(config, ctx) {
      const scope = ctx.envName ?? "";
      const errors = [];
      for (const ref of fixturesOf(config).afterAll) {
        const key = `afterAll\u0000${scope}\u0000${ref.name}`;
        if (once.has(key)) continue;
        const done = runFixture(ref, config, "afterAll", ctx, own);
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

// Why a fixture stops what it runs before, when its run() returns false
export const saidToStop = (name, phase) => `the fixture "${name}" (${phase}) said to stop`;

// One run of a fixture: { given (what it gave, in beforeAll and before), stop (why, when it said to
// stop: its run() returned false), or null }. What it set with env.set is added to its scope's
// overlay (env(envName)) once it's returned. used: where the secrets it sends (a password it names)
// are remembered, so its calls' steps hide them
async function runFixture(ref, config, phase, { plugins, scope, envName, spans, parent, signal, provider, test }, { record, used, env }) {
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
    if (!plugin?.run) throw new Error(plugin ? `"${ref.name}" is a ${plugin.kind} plugin, not a fixture` : `it isn't in ${pluginsWhere()}`);
    // (a provider naming it in a list it doesn't run in is a problem before anything is sent: never
    // run there)
    if (!runsIn(plugin, phase)) throw new Error(`it runs only in ${phasesText(plugin)} (its phases)`);
    // The provider's fields (never a secret, as a provider plugin is given them), the variables and
    // the environment's values (what fixtures have set with env.set too: run() can set more)
    const { fixture: _old, fixtures: _lists, ...fields } = config;
    let out;
    let set = {};
    try {
      out = await plugin.run({
        phase,
        // (an {{env.NAME}} in them that a fixture sets isn't set before it runs: kept as written)
        settings: scope?.plain ? scope.plain(fields, { keep: true }) : fields,
        variables: scope?.variables?.() ?? {},
        env: scope?.envValues?.() ?? {},
        ...(test ? { test } : {}),
      }, { signal: anySignal([signal, limit.signal]), onCall, onSets: (s) => { set = s; }, used, ...(scope?.request ? { scope } : {}) });
    } catch (err) {
      throw limit.signal.aborted ? new Error(`timed out after ${ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`}`) : err;
    }
    // false: stop (whatever it provides isn't needed then); true or nothing: go on
    const stop = out === false;
    const given = !stop && (phase === "beforeAll" || phase === "before") ? valuesOf(out === true ? null : out, plugin.meta.provides ?? []) : {};
    // (known as secrets before its calls' requests and responses are on their steps)
    for (const value of Object.values(given)) remember(used, value);
    // What it set, the environment's for the rest of the run in its scope
    const names = Object.keys(set).filter((name) => NAME.test(name));
    for (const name of names) env(envName)[name] = String(set[name]);
    step?.flush?.();
    const said = { provides: Object.keys(given), ...(names.length ? { sets: names } : {}), ...(stop ? { stop: true } : {}) };
    spans?.end(span, "ok", { ...said, calls });
    record({ ...about, status: "ok", ms: took(), ...said, calls });
    return { given, stop: stop ? saidToStop(ref.name, phase) : null };
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
  if (typeof out !== "object" || Array.isArray(out)) throw new Error("its run() returns the values it gives, by name ({ ACME_COOKIE: \"…\" }), true or nothing to go on, or false to stop");
  const given = {};
  for (const [name, value] of Object.entries(out)) {
    if (!NAME.test(name)) throw new Error(`"${name}" isn't a name it can give (${NAME_RULE})`);
    if (provides.length && !provides.includes(name)) throw new Error(`it gave ${name}, which isn't in its provides (${provides.join(", ")})`);
    if (value === undefined || value === null || value === "") throw new Error(`it gave no value for ${name}`);
    if (typeof value === "object") throw new Error(`${name} isn't text (join a list of cookies into one: "a=1; b=2")`);
    given[name] = String(value);
  }
  const missing = provides.filter((n) => !(n in given));
  if (missing.length) throw new Error(`it didn't give ${missing.join(", ")}`);
  return given;
}
