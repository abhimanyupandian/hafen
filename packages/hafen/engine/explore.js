// Exploring an endpoint (spec US1): a conversation sent turn by turn, recorded as a run in "explore"
// mode, with the same turns, events, spans and metrics as a test. Saved as a test, its messages
// become turns (files/suite-file.js, editText).

import { createFixtures } from "./fixtures.js";
import { fixturesOf } from "./fixture-lists.js";
import { createProvider } from "./providers/index.js";
import { createRedactor, headerSecrets } from "./redact.js";
import { newRun, summarize } from "./runner.js";
import { createSpans } from "./spans.js";
import { executeTurn } from "./turn.js";
import { createScope } from "./vars.js";

// providerConfig: a provider's configuration. variables, environment: what its templates may use (the
// suite's variables, and its environment of the chosen one's name, as {{name}}s).
// seed: a conversation's run to carry on (one kept by the app): its turns are the history the next
// message goes with, and its spans come first on the timeline, the new ones after them.
// scopeValues: the chosen environment ({ name, values }: the app's scope, its values; or null, none),
// for {{env.NAME}} (its values, then the suite's environment of its name) and where {{secret.NAME}}
// comes from (its secrets). setScope changes it between messages, with the suite's variables and
// environment read again for it.
// A provider's fixtures (engine/fixtures.js): beforeAll and before run before the first message, and
// again for another scope (either again after it failed); after and afterAll when the conversation is
// let go (close()), for each scope they ran in. What they give is kept for this conversation and
// that scope only.
export function createConversation({ host, providerConfig, providerFile, variables = {}, environment = {}, envName, prices = {}, plugins = {}, onEvent: emit = () => {}, history: historyMode = "live", seed = null, scopeValues = null }) {
  let chosen = scopeValues;
  // (the scope's name: where its secrets come from)
  let env = scopeValues?.name ?? envName ?? null;
  const run = newRun({ mode: "explore", host, settings: { env: envName ?? null, provider: providerConfig?.kind } });
  run.status = "done";
  const earlier = seed?.turns?.filter(Boolean) ?? [];
  if (seed) {
    if (seed._id) run._id = seed._id;
    if (seed.started) run.started = seed.started;
    run.turns.push(...earlier.map((t, index) => ({ ...t, index })));
  }
  const lastEnd = Math.max(0, ...(seed?.spans ?? []).map((s) => s.end ?? s.start ?? 0));
  const secretsUsed = new Set();
  // (the provider's secret_headers: its own, and each one it's changed to's)
  const secretHeaders = new Set(Array.isArray(providerConfig?.secret_headers) ? providerConfig.secret_headers : []);
  const redactor = createRedactor({ secrets: secretsUsed, headers: secretHeaders });
  // Every event as it goes out redacted, as the record is (a streamed reply can echo a secret)
  const onEvent = (event) => emit(redactor.redact(event));
  const spans = createSpans({ now: host.now, offset: seed?.spans?.length ? lastEnd + 1 : 0, onChange: (action, span) => onEvent({ type: "span", action, span }) });
  spans.adopt(seed?.spans);
  run.spans = spans.list;
  run.settings.redact = redactor.rules();
  run.fixtures = [];
  const fixtures = createFixtures({
    used: secretsUsed,
    retry: true,
    record: (fixture) => {
      run.fixtures.push(fixture);
      onEvent({ type: "fixture:end", fixture });
    },
  });
  // What its before fixtures gave in each scope (once they've run there), and the scope each scope's
  // fixtures last ran with (for after and afterAll)
  const given = new Map();  // scope name ("" none) → Map(NAME → value)
  const ranIn = new Map();  // scope name ("" none) → { scope, env }
  let config = providerConfig;
  let provider = createProvider(providerConfig, { plugins });
  let price = providerConfig.price ?? prices[providerConfig.model];
  let configText = JSON.stringify(providerConfig);
  // A provider whose file changed: the next message goes with its new configuration (the conversation
  // so far stays), and with the plugins it needs now (nextPlugins, loaded again for it: a fixture
  // added since the conversation began). A beforeAll fixture new to it runs then; a before list that
  // changed runs again.
  function setProvider(next, nextPlugins) {
    const text = JSON.stringify(next);
    if (text === configText) return;
    if (nextPlugins) plugins = nextPlugins;
    const befores = (c) => fixturesOf(c).before.map((ref) => ref.entry).join("\u0000");
    if (befores(next) !== befores(config)) given.clear();
    for (const name of Array.isArray(next?.secret_headers) ? next.secret_headers : []) secretHeaders.add(name);
    provider = createProvider(next, { plugins });
    price = next.price ?? prices[next.model];
    config = next;
    configText = text;
    run.settings.provider = next.kind;
  }
  // What later messages are sent with: each earlier turn's message and reply (and what its provider
  // kept to replay)
  const records = earlier.map((t) => ({ user: t.user, reply: t.reply, raw_blocks: t.raw_blocks, variables: t.variables }));
  let session;

  async function send(message, { signal } = {}) {
    // (this message's scope, whatever is chosen while it's on its way)
    const scopeName = env;
    const key = scopeName ?? "";
    const scope = createScope({
      layers: [Object.assign({}, ...records.map((r) => r.variables ?? {})), variables, environment],
      trusted: [variables, environment],
      secrets: (name) => given.get(key)?.get(name) ?? fixtures.value(name, scopeName) ?? host.secrets(name, { env: scopeName }),
      used: secretsUsed,
      environment: chosen ? { name: chosen.name ?? "", values: chosen.values ?? {}, suite: environment } : null,
    });
    // The message's {{env.NAME}}s and {{secret.NAME}}s, filled in (its other {{…}} are sent as typed).
    // As typed, it's kept too (user_template): a test saved from the conversation has the {{env.NAME}},
    // not its value
    const typed = String(message);
    message = scope.typed(message);
    const index = run.turns.length;
    const turnSpan = spans.start("turn", `turn ${index + 1}`, { ref: { turn: index } });
    // (what the page is shown as it starts: redacted, as everything it's shown is)
    onEvent({ type: "turn:start", index, user: redactor.text(message) });
    const history = records.map((r) => (historyMode === "none" ? null : { user: r.user, reply: r.reply, raw: r.raw_blocks?.at(-1) })).filter(Boolean);
    // The provider's beforeAll fixtures, then its before ones, first (each once per scope)
    let failed = null;
    ranIn.set(key, { scope, env: scopeName });
    try {
      await fixtures.beforeAll(config, { plugins, scope, envName: scopeName, spans, parent: turnSpan, signal, provider: providerFile });
      if (!given.has(key)) given.set(key, await fixtures.before(config, { plugins, scope, envName: scopeName, spans, parent: turnSpan, signal, provider: providerFile }));
    } catch (err) {
      failed = err.message;
    }
    const out = failed
      ? { record: { user: message, error: failed, events: [], reply: "", thinking: [], tool_calls: [], metrics: {} }, error: failed, session }
      : await executeTurn({
        provider, message, history, scope, transport: host.transport, signal, session, spans, parent: turnSpan, price, now: host.now, onEvent, index,
        secretHeader: redactor.isSecretHeader, noteSecret: (value) => { for (const secret of headerSecrets(value)) secretsUsed.add(secret); },
      });
    session = out.session;
    spans.end(turnSpan, out.error ? (out.stopped ? "skipped" : "error") : "ok", out.record.metrics);
    const record = { ...out.record, index, results: [], ...(typed !== message ? { user_template: typed } : {}) };
    records.push(record);
    const stored = redactor.redact(record);
    run.turns.push(stored);
    run.ended = host.clock();
    run.ms = run.ended - run.started;
    run.summary = summarize(run);
    onEvent({ type: "turn:end", index, record: stored });
    return { record: stored, run: redactor.redact(run) };
  }

  // The scope chosen now (it can change between messages: none, or another), and what the suite gives
  // with it (context: { variables, environment }, the environment of that scope's name), read again
  // for it. Without a context, the suite's stay as they were.
  function setScope(next, context) {
    chosen = next;
    env = next?.name ?? null;
    if (context) ({ variables = {}, environment = {} } = context);
  }

  // Let go: its provider's after fixtures (where before's ran), then its afterAll ones, in each scope
  // they ran in
  async function close() {
    for (const [key, { scope, env: envName }] of ranIn) {
      const ctx = { plugins, scope, envName, spans, parent: null, provider: providerFile };
      if (given.has(key)) await fixtures.after(config, ctx);
      await fixtures.afterAll(config, ctx);
    }
  }

  return { run, send, records, setProvider, setScope, close };
}

// A conversation as a test (spec US2, Save as test): its messages as turns, and suggested checks to
// keep or drop: the status, and the reply text's path when it came from a JSON body.
export function conversationToTest(run, { name, providerPath }) {
  const turns = run.turns.map((t) => {
    const expect = [];
    if (t.response?.status && t.response.status !== 101) expect.push({ type: "status", equals: t.response.status });
    // (the message as typed: its {{env.NAME}}s and {{secret.NAME}}s, not what they were then)
    return { user: t.user_template ?? t.user, ...(expect.length ? { expect } : {}) };
  });
  return { name, ...(providerPath ? { provider: providerPath } : {}), turns };
}
