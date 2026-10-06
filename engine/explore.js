// Exploring an endpoint (spec US1): a conversation sent turn by turn, recorded as a run in "explore"
// mode, with the same turns, events, spans and metrics as a test. Saved as a test, its messages
// become turns (files/suite-file.js, editText).

import { createProvider } from "./providers/index.js";
import { createRedactor } from "./redact.js";
import { newRun, summarize } from "./runner.js";
import { createSpans } from "./spans.js";
import { executeTurn } from "./turn.js";
import { createScope } from "./vars.js";

// providerConfig: a provider's configuration. variables, env: what its templates may use.
// seed: a conversation's run to carry on (one kept by the app): its turns are the history the next
// message goes with, and its spans come first on the timeline, the new ones after them.
// scopeValues: the chosen scope ({ name, values }, or null), for {{scope.NAME}} (setScope changes it)
export function createConversation({ host, providerConfig, variables = {}, environment = {}, envName, prices = {}, plugins = {}, onEvent: emit = () => {}, history: historyMode = "live", seed = null, scopeValues = null }) {
  let chosen = scopeValues;
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
  const redactor = createRedactor({ secrets: secretsUsed });
  // Every event as it goes out redacted, as the record is (a streamed reply can echo a secret)
  const onEvent = (event) => emit(redactor.redact(event));
  const spans = createSpans({ now: host.now, offset: seed?.spans?.length ? lastEnd + 1 : 0, onChange: (action, span) => onEvent({ type: "span", action, span }) });
  spans.adopt(seed?.spans);
  run.spans = spans.list;
  run.settings.redact = redactor.rules();
  let provider = createProvider(providerConfig, { plugins });
  let price = providerConfig.price ?? prices[providerConfig.model];
  let configText = JSON.stringify(providerConfig);
  // A provider whose file changed: the next message goes with its new configuration (the conversation
  // so far stays)
  function setProvider(config) {
    const text = JSON.stringify(config);
    if (text === configText) return;
    provider = createProvider(config, { plugins });
    price = config.price ?? prices[config.model];
    configText = text;
    run.settings.provider = config.kind;
  }
  // What later messages are sent with: each earlier turn's message and reply (and what its provider
  // kept to replay)
  const records = earlier.map((t) => ({ user: t.user, reply: t.reply, raw_blocks: t.raw_blocks, variables: t.variables }));
  let session;

  async function send(message, { signal } = {}) {
    const scope = createScope({
      layers: [Object.assign({}, ...records.map((r) => r.variables ?? {})), variables, environment],
      trusted: [variables, environment],
      secrets: (name) => host.secrets(name, { env: chosen?.name ?? envName }),
      used: secretsUsed,
      scope: chosen,
    });
    // The message's {{scope.NAME}}s, filled in (its other {{…}} are sent as typed). As typed, it's
    // kept too (user_template): a test saved from the conversation has the {{scope.NAME}}, not its value
    const typed = String(message);
    message = scope.scopeOnly(message);
    const index = run.turns.length;
    const turnSpan = spans.start("turn", `turn ${index + 1}`, { ref: { turn: index } });
    // (what the page is shown as it starts: redacted, as everything it's shown is)
    onEvent({ type: "turn:start", index, user: redactor.text(message) });
    const history = records.map((r) => (historyMode === "none" ? null : { user: r.user, reply: r.reply, raw: r.raw_blocks?.at(-1) })).filter(Boolean);
    const out = await executeTurn({ provider, message, history, scope, transport: host.transport, signal, session, spans, parent: turnSpan, price, now: host.now, onEvent, index });
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

  // The scope chosen now (it can change between messages)
  const setScope = (next) => { chosen = next; };

  return { run, send, records, setProvider, setScope };
}

// A conversation as a test (spec US2, Save as test): its messages as turns, and suggested checks to
// keep or drop: the status, and the reply text's path when it came from a JSON body.
export function conversationToTest(run, { name, providerPath }) {
  const turns = run.turns.map((t) => {
    const expect = [];
    if (t.response?.status && t.response.status !== 101) expect.push({ type: "status", equals: t.response.status });
    // (the message as typed: its {{scope.NAME}}s, not what they were then)
    return { user: t.user_template ?? t.user, ...(expect.length ? { expect } : {}) };
  });
  return { name, ...(providerPath ? { provider: providerPath } : {}), turns };
}
