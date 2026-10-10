// One turn: send a message through a provider, collect what came back as events, time every step as a
// span, give tool results to a model API that asks for them (tool mocks), and build the turn's record
// (data-model.md, TurnRecord) and what its checks look at.

import { callSteps } from "./calls.js";
import { assemble, createCollector } from "./events.js";
import { first } from "./jsonpath.js";
import { withRetries } from "./transport.js";
import { anySignal, isAbort, short } from "./util.js";
import { fmtMs } from "./checks/names.js";
import { same } from "./checks/operators.js";
import { typed } from "./vars.js";

const CHUNK_CAP = 2000;
const BODY_CAP = 5 * 1024 * 1024;
const TOOL_ROUNDS = 5;

// timeoutMs, retries: the turn's (a run gives its test's settings); with none given (a conversation),
// the provider's own, else 120 s and 2
export async function executeTurn({
  provider, message, history = [], scope, transport, signal, wantThinking = false, session,
  spans, parent, timeoutMs = provider?.config?.timeout_ms ?? 120000, retries = provider?.config?.retries ?? 2, tools, price, now, onEvent = () => {}, index = 0,
  secretHeader = () => false, noteSecret = () => {},
}) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const turnSignal = anySignal([signal, timeout.signal]);
  const requestSpan = spans.start("request", "request", { parent, ref: { turn: index } });
  const requestStart = spans.get(requestSpan).start;
  // A provider plugin's own HTTP calls: steps under the request
  const callStep = callSteps(spans, requestSpan);
  const collector = createCollector({ now });
  const record = {
    user: message,
    events: collector.events,
    request: null,
    response: { status: undefined, headers: {}, streamed: false },
    raw_blocks: [],
  };
  const chunks = [];
  let chunksTotal = 0;
  let body;
  let bodyText;
  let newSession;
  let firstByte;
  let error = null;
  // While a response's body is read: how many chunks had come before it (the connection closing now
  // cuts the reply short), else null
  let reading = null;

  const retrying = withRetries(transport, {
    retries,
    onRetry: ({ attempt, status, waitMs }) => {
      spans.record("retry", `retry ${attempt} after ${status}`, { parent: requestSpan, end: spans.at() + waitMs, metrics: { status, wait_ms: waitMs } });
      onEvent({ type: "turn:retry", index, attempt, status, waitMs });
    },
  });

  const take = (item) => {
    switch (item.type) {
      case "request":
        record.request = item.request;
        // A secret header's value (secret_headers, a suite's redact headers, Authorization…) is a
        // secret wherever else it shows: a reply or an error that echoes it
        for (const [name, value] of Object.entries(item.request?.headers ?? {})) if (secretHeader(name)) noteSecret(value);
        spans.update(requestSpan, { name: requestName(item.request) });
        break;
      case "response":
        reading = chunksTotal;
        record.response.status = item.status;
        record.response.headers = item.headers ?? {};
        if (firstByte === undefined) {
          firstByte = spans.at();
          spans.record("first_byte", `first byte · ${item.status}`, { parent: requestSpan, start: requestStart, end: firstByte });
        }
        break;
      case "chunk":
        record.response.streamed = true;
        chunksTotal += 1;
        if (chunks.length < CHUNK_CAP) chunks.push(item.text);
        break;
      case "body":
        body = item.body;
        if (item.text !== undefined) bodyText = item.text;
        break;
      case "session":
        newSession = item.value;
        break;
      case "call":
        callStep(item);
        break;
      case "raw":
        record.raw_blocks.push(item.value);
        break;
      default: {
        const event = collector.add(item);
        if (event) onEvent({ type: "turn:event", index, event: item, at: event.t });
        if (item.type === "error") error = item.message;
      }
    }
  };

  try {
    let extra = [];
    let extraInput = [];
    let previousResponseId;
    for (let round = 0; ; round++) {
      const before = collector.toolCalls().length;
      const stream = provider.send({
        message, history, scope, transport: retrying, signal: turnSignal, wantThinking, session,
        extraMessages: extra, extraContents: extra, extraInput, previousResponseId,
      });
      for await (const item of stream) take(item);
      reading = null;
      if (error || !tools || round >= TOOL_ROUNDS) break;
      const calls = collector.toolCalls().slice(before).filter((c) => !("result" in c));
      if (!calls.length) break;
      const results = calls.map((call) => ({ ...call, result: mockResult(tools, call) }));
      for (const r of results) take({ type: "tool_result", id: r.id, name: r.name, result: r.result, mocked: true });
      const raw = record.raw_blocks.at(-1);
      if (provider.toolMessages) extra = [...extra, ...provider.toolMessages(raw, results)];
      else if (provider.toolContents) extra = [...extra, ...provider.toolContents(raw, results)];
      else if (provider.toolInput) {
        extraInput = provider.toolInput(results);
        previousResponseId = raw?.response_id;
      } else throw new Error(`The ${provider.kind} provider can't be given tool results`);
    }
  } catch (err) {
    if (isAbort(err) || turnSignal.aborted) {
      error = timeout.signal.aborted ? `timed out after ${fmtMs(timeoutMs)}` : "stopped";
    } else if (reading !== null) {
      // The connection closed with the body part read (Node says "terminated", a browser "network
      // error"): said as what happened. What came before it stays in the record
      const n = chunksTotal - reading;
      error = `the response ended early: the connection closed ${n ? `after ${n} chunk${n === 1 ? "" : "s"} (the reply so far is kept)` : "before its body was all in"}`;
    } else {
      error = err.message || String(err);
    }
    collector.add({ type: "error", message: error });
    onEvent({ type: "turn:event", index, event: { type: "error", message: error } });
  } finally {
    clearTimeout(timer);
  }

  // Steps known once they've happened: thinking, tool calls, the answer
  for (const [i, e] of collector.events.entries()) {
    const ref = { turn: index, event: i };
    if (e.type === "thinking") spans.record("thinking", `thinking (${e.visibility})`, { parent: requestSpan, start: requestStart + e.t, end: requestStart + (e.t_end ?? e.t), ref });
    else if (e.type === "text") spans.record("answer", "answer", { parent: requestSpan, start: requestStart + e.t, end: requestStart + (e.t_end ?? e.t), ref });
    else if (e.type === "tool_call") spans.record("tool_call", e.name, { parent: requestSpan, start: requestStart + e.t, end: requestStart + e.t, ref });
    else if (e.type === "tool_result") spans.record("tool_result", `${e.name ?? "tool"} result${e.mocked ? " (mocked)" : ""}`, { parent: requestSpan, start: requestStart + e.t, end: requestStart + e.t, ref });
  }
  const aborted = error === "stopped";
  spans.end(requestSpan, error ? (aborted ? "skipped" : "error") : "ok");

  record.reply = collector.reply();
  record.thinking = collector.thinking();
  record.tool_calls = collector.toolCalls();
  record.usage = collector.usage();
  record.finish = collector.finish();
  if (error) record.error = error;
  if (record.response.streamed) {
    record.response.chunks = chunks;
    record.response.chunks_total = chunksTotal;
    // What `on: response` paths read for a stream, so the app can show it as a tree
    record.response.assembled = assemble(collector, body);
  } else if (body !== undefined) {
    const text = bodyText ?? (typeof body === "string" ? body : JSON.stringify(body));
    if (text.length > BODY_CAP) {
      record.response.body = text.slice(0, BODY_CAP);
      record.response.body_truncated = true;
    } else record.response.body = body;
  }
  record.metrics = metricsOf(collector.events, { ms: spans.get(requestSpan).metrics.ms, firstByte: firstByte === undefined ? undefined : firstByte - requestStart, usage: record.usage, price, provider });

  return {
    record,
    session: newSession ?? session,
    // What `on: response` checks read: the parsed body, or the assembled stream
    response: record.response.streamed ? assemble(collector, body) : body,
    error,
    stopped: aborted,
  };
}

function requestName(request) {
  try {
    const url = new URL(request.url);
    return `${request.method} ${url.pathname}`;
  } catch {
    return `${request.method} ${request.url}`;
  }
}

// A turn's metrics (data-model.md, Metrics): only what applies is set
export function metricsOf(events, { ms, firstByte, usage, price, provider }) {
  const m = { ms };
  const content = events.find((e) => e.type === "thinking" || e.type === "text");
  if (content) m.ttft_ms = content.t;
  else if (firstByte !== undefined) m.ttft_ms = firstByte;
  const thinking = events.filter((e) => e.type === "thinking");
  if (thinking.length) {
    m.first_thinking_ms = thinking[0].t;
    m.thinking_ms = Math.round(Math.max(...thinking.map((e) => e.t_end ?? e.t)) - thinking[0].t);
  }
  const text = events.filter((e) => e.type === "text");
  if (text.length) m.first_answer_ms = text[0].t;
  // Output tokens per second while it generated (data-model.md, Metrics). Output tokens count the
  // thinking (Gemini's apart, as its cost does): with its thinking shown, every token, over the time
  // from the first thinking or answer token to the last; with it hidden (counted, not shown), the
  // answer's own tokens over the answer's time. (Not the answer's time alone for every token: a short
  // answer after long thinking would read thousands a second.)
  const generated = thinking.length ? [...thinking, ...text] : text;
  if (generated.length && usage?.output) {
    const gemini = provider?.kind === "gemini";
    const tokens = thinking.length ? usage.output + (gemini ? usage.thinking ?? 0 : 0) : usage.output - (gemini ? 0 : usage.thinking ?? 0);
    const seconds = (Math.max(...generated.map((e) => e.t_end ?? e.t)) - Math.min(...generated.map((e) => e.t))) / 1000;
    if (tokens > 0 && seconds > 0.05) m.tokens_per_s = Math.round((tokens / seconds) * 10) / 10;
  }
  if (usage && Object.values(usage).some((v) => v !== undefined)) {
    m.tokens = Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== undefined));
    const cost = costOf(usage, price, provider);
    if (cost !== undefined) m.cost = cost;
  }
  return m;
}

// USD, from a price per million tokens; undefined (unknown, never 0) without a price
export function costOf(usage, price, provider) {
  if (!price || !usage) return undefined;
  const input = usage.input ?? 0;
  const cached = usage.cached ?? 0;
  const output = (usage.output ?? 0) + (provider?.kind === "gemini" ? usage.thinking ?? 0 : 0);
  const cost = ((input - cached) * price.input + cached * (price.cached_input ?? price.input) + output * price.output) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}

// A tool's mocked result: fixed, or the first `when` whose paths match the call's arguments
function mockResult(tools, call) {
  const mock = tools[call.name];
  if (mock === undefined) throw new Error(`The model called ${call.name}, and the test has no result for it (add it under the turn's tools)`);
  if (!Array.isArray(mock)) return mock.result;
  const hit = mock.find((m) => !m.when || Object.entries(m.when).every(([path, want]) => same(first(path, call.args ?? {}), typed(want))));
  if (!hit) throw new Error(`No result for ${call.name} matches its arguments ${short(call.args)}`);
  return hit.result;
}

// A provider's reply, collected (for judges and simulated users): { text, usage, error }
export async function collectReply(provider, { message, scope, transport, signal, history = [] }) {
  let text = "";
  const usage = {};
  let error = null;
  try {
    for await (const item of provider.send({ message, history, scope, transport, signal, wantThinking: false })) {
      if (item.type === "text") text += item.text;
      else if (item.type === "usage") for (const [k, v] of Object.entries(item)) if (k !== "type" && v !== undefined) usage[k] = v;
      else if (item.type === "error") error = item.message;
    }
  } catch (err) {
    error = isAbort(err) ? "stopped" : err.message || String(err);
  }
  return { text, usage, error };
}
