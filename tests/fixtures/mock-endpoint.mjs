// A local chat endpoint for tests and the quickstart: one scenario per path, so tests are fast, free
// and repeatable (constitution VI; research §27). Run it: node tests/fixtures/mock-endpoint.mjs --port 8791
//
// Every chat scenario reads the message from the request body (`message`, or the last user entry of
// `messages`) and answers deterministically:
//   a message about a refund → "I'm sorry it arrived broken. Could you tell me why you want a refund for order 4417?"
//   anything else            → "You said: <message>"
//
//   POST /json                 one JSON reply: { data: { reply, order: { id: 4417 }, actions }, session_id, usage }
//   POST /sse                  SSE: {type: text_delta, delta}…, {type: usage, …}, then [DONE]
//   POST /ndjson               the same as JSON lines
//   POST /thinking/full        SSE: thinking deltas (full), then text
//   POST /thinking/summary     the same, with visibility "summary"
//   POST /thinking/omitted     an empty thinking event, then text
//   POST /thinking/tags        text with <think>…</think>, tags split across chunks
//   POST /tools                SSE: a tool call (lookup_order 4417), its result, then text
//   POST /tools/answer-first   text first, then the tool call
//   POST /tools/ask/chat/completions   OpenAI-compatible: asks for get_weather, then answers with the result it's given
//   POST /openai/chat/completions      OpenAI-compatible, streamed (echoes; reasoning_content when the model ends in -thinking)
//   POST /session              { reply, session_id }: the session carries a turn count
//   POST /slow?ms=…            /json after a delay (also MOCK_DELAY_MS for every scenario)
//   POST /cut                  SSE that stops after two chunks, mid-reply
//   POST /error/500            a 500 with a JSON error
//   POST /ratelimit            429 (retry-after 0.05 s) on every other call
//   POST /flaky?rate=0.9       /json, but the reply leaves out "refund" 1 - rate of the time
//   POST /nocors               /json without CORS headers
//   POST /login                { access_token }
//   POST /systemone/v1/systemone   a System One API: noul 0.91 when the state asks "why", else 0.12; questions
//                                  whose instructions say UNSURE answer 0.55 (confidence 0.1)
//   GET  /systemone/v1/models
//   POST /judge/chat/completions   an OpenAI-compatible LLM judge (streamed): criteria met unless they say NOT-MET;
//                                  criteria that say FLAKY alternate between met and not
//   GET  /_log, DELETE /_log    the requests received

import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REFUND = "I'm sorry it arrived broken. Could you tell me why you want a refund for order 4417?";
const replyFor = (message) => (/refund/i.test(message ?? "") ? REFUND : `You said: ${message ?? ""}`);

function messageOf(body) {
  if (!body || typeof body !== "object") return "";
  if (typeof body.message === "string") return body.message;
  const list = body.messages ?? body.contents ?? body.input;
  if (Array.isArray(list)) {
    const user = [...list].reverse().find((m) => m.role === "user");
    const content = user?.content ?? user?.parts;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((c) => c.text ?? "").join("");
  }
  return "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunksOf = (text, n = 4) => {
  const words = text.split(/(?<= )/);
  const out = [];
  for (let i = 0; i < words.length; i += n) out.push(words.slice(i, i + n).join(""));
  return out;
};

export function createMock({ delayMs = Number(process.env.MOCK_DELAY_MS ?? 0), chunkMs = 5 } = {}) {
  const log = [];
  let rateCalls = 0;
  let flakyCalls = 0;
  let judgeCalls = 0;
  const sessions = new Map();
  // A FLAKY criterion is met on its 1st and 2nd asking, not its 3rd (per criterion, so judges asked in
  // parallel don't share a count)
  const flakyCounts = new Map();
  const flakyJudge = (criterion) => {
    const n = (flakyCounts.get(criterion) ?? 0) + 1;
    flakyCounts.set(criterion, n);
    return n;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock");
    const cors = url.pathname !== "/nocors";
    if (cors) {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "*");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS, DELETE");
    }
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch {}
    if (url.pathname === "/_log") {
      if (req.method === "DELETE") log.length = 0;
      return json(res, 200, log);
    }
    log.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });
    if (delayMs) await sleep(delayMs);
    const message = messageOf(body);
    const reply = replyFor(message);

    const sse = async (events, { cut = false } = {}) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let n = 0;
      for (const e of events) {
        if (cut && n === 2) return res.destroy();
        const data = typeof e === "string" ? e : JSON.stringify(e);
        // Split some events across writes, as networks do
        const text = `data: ${data}\n\n`;
        const half = Math.floor(text.length / 2);
        res.write(text.slice(0, half));
        await sleep(chunkMs);
        res.write(text.slice(half));
        n++;
      }
      res.end();
    };
    const textEvents = (text) => chunksOf(text).map((delta) => ({ type: "text_delta", delta }));
    const usage = { type: "usage", input_tokens: message.split(/\s+/).length + 10, output_tokens: reply.split(/\s+/).length };

    switch (url.pathname) {
      case "/json":
      case "/nocors":
      case "/slow":
      case "/flaky": {
        if (url.pathname === "/slow") await sleep(Number(url.searchParams.get("ms") ?? 200));
        let text = reply;
        if (url.pathname === "/flaky") {
          flakyCalls++;
          const rate = Number(url.searchParams.get("rate") ?? 0.9);
          if ((flakyCalls * 7919) % 100 >= rate * 100) text = text.replace(/refund/g, "return");
        }
        return json(res, 200, { data: { reply: text, order: { id: 4417 }, actions: [{ type: /refund/.test(text) ? "refund" : "note" }] }, session_id: "sess_1", usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } });
      }
      case "/sse":
        return sse([...textEvents(reply), usage, "[DONE]"]);
      case "/ndjson": {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        for (const e of [...textEvents(reply), usage]) {
          const line = `${JSON.stringify(e)}\n`;
          res.write(line.slice(0, 5));
          await sleep(chunkMs);
          res.write(line.slice(5));
        }
        return res.end();
      }
      case "/thinking/full":
      case "/thinking/summary":
        return sse([
          ...chunksOf("The customer wants a refund. Check the refund window for order 4417 first.").map((delta) => ({ type: "thinking_delta", delta, visibility: url.pathname.endsWith("summary") ? "summary" : "full" })),
          ...textEvents(reply), { ...usage, thinking_tokens: 14 }, "[DONE]",
        ]);
      case "/thinking/omitted":
        return sse([{ type: "thinking_delta", delta: "", visibility: "omitted" }, ...textEvents(reply), usage, "[DONE]"]);
      case "/thinking/tags":
        return sse([...chunksOf(`<think>Check the refund window.</think>${reply}`, 1).map((delta) => ({ type: "text_delta", delta })), usage, "[DONE]"]);
      case "/tools":
        return sse([
          { type: "thinking_delta", delta: "I should look the order up.", visibility: "full" },
          { type: "tool_call", id: "c1", name: "lookup_order", args: { order_id: 4417 } },
          { type: "tool_result", id: "c1", name: "lookup_order", result: { status: "delivered" } },
          ...textEvents(reply), usage, "[DONE]",
        ]);
      case "/tools/answer-first":
        return sse([...textEvents(reply), { type: "tool_call", id: "c1", name: "lookup_order", args: { order_id: 4417 } }, usage, "[DONE]"]);
      case "/tools/ask/chat/completions": {
        const toolMessage = (body?.messages ?? []).find((m) => m.role === "tool");
        if (!toolMessage) {
          return sse([
            { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] } }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, finish_reason: "tool_calls" }] },
            { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } },
            "[DONE]",
          ]);
        }
        const temp = JSON.parse(toolMessage.content).temp;
        return sse([...chunksOf(`It's ${temp} degrees in Paris.`).map((content) => ({ choices: [{ index: 0, delta: { content } }] })), { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 30, completion_tokens: 6 } }, "[DONE]"]);
      }
      case "/openai/chat/completions": {
        const thinking = /-thinking$/.test(body?.model ?? "");
        return sse([
          ...(thinking ? chunksOf("Let me think about the order.").map((t) => ({ choices: [{ index: 0, delta: { reasoning_content: t } }] })) : []),
          ...chunksOf(reply).map((content) => ({ choices: [{ index: 0, delta: { content } }] })),
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 12, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: thinking ? 6 : 0 } } },
          "[DONE]",
        ]);
      }
      case "/session": {
        const id = body?.session_id || `sess_${sessions.size + 1}`;
        const n = (sessions.get(id) ?? 0) + 1;
        sessions.set(id, n);
        return json(res, 200, { reply: `${reply} (session ${id}, turn ${n})`, session_id: id });
      }
      case "/cut":
        return sse([...textEvents("This reply is going to be cut off before it ends, so the turn is an error."), "[DONE]"], { cut: true });
      case "/error/500":
        return json(res, 500, { error: { message: "the mock is having a bad day" } });
      case "/ratelimit":
        rateCalls++;
        if (rateCalls % 2 === 1) {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "0.05" });
          return res.end(JSON.stringify({ error: { message: "slow down" } }));
        }
        return json(res, 200, { data: { reply, order: { id: 4417 } } });
      case "/login":
        return json(res, 200, { access_token: "tok_mock_123" });
      case "/systemone/v1/models":
        return json(res, 200, { models: [{ name: "jev-mock" }] });
      case "/systemone/v1/systemone": {
        if (!req.headers.authorization) return json(res, 401, { error: { message: "no API key" } });
        const state = String(body?.state ?? "");
        const answers = {};
        for (const [name, q] of Object.entries(body?.questions ?? {})) {
          const unsure = /UNSURE/.test(q.instructions ?? "");
          if (q.type === "noul") answers[name] = { noul: unsure ? 0.55 : /why/i.test(state) ? 0.91 : 0.12 };
          else if (q.type === "choice") {
            const options = Object.keys(q.criteria ?? {});
            const picked = options.find((o) => state.toLowerCase().includes(o.toLowerCase())) ?? options[0];
            const p = unsure ? 0.4 : 0.86;
            answers[name] = { choice: picked, confidence: p, probabilities: Object.fromEntries(options.map((o) => [o, o === picked ? p : (1 - p) / Math.max(1, options.length - 1)])) };
          } else if (q.type === "score") {
            const levels = Array.isArray(q.criteria) ? q.criteria : [];
            const score = state.length > 40 ? levels.length - 1 : 0;
            answers[name] = { score, confidence: unsure ? 0.3 : 0.8, legend: levels, probabilities: Object.fromEntries(levels.map((_, i) => [i, i === score ? 0.8 : 0.2 / Math.max(1, levels.length - 1)])) };
          }
        }
        return json(res, 200, { model: body?.model ?? "jev-mock", answers, usage: { input_tokens: state.length, output_tokens: Object.keys(answers).length } });
      }
      case "/judge/chat/completions": {
        judgeCalls++;
        const prompt = messageOf(body);
        const criteria = [...prompt.matchAll(/^\d+\. (.*)$/gm)].map((m) => m[1]);
        const list = (criteria.length ? criteria : ["same meaning as the reference"]).map((c) => ({
          criterion: c,
          met: /NOT-MET/.test(c) ? false : /FLAKY/.test(c) ? flakyJudge(c) % 3 !== 0 : true,
          reason: "the mock judge says so",
        }));
        const text = `Here is my verdict: ${JSON.stringify({ criteria: list })}`;
        return sse([...chunksOf(text, 8).map((content) => ({ choices: [{ index: 0, delta: { content } }] })), { choices: [], usage: { prompt_tokens: 40, completion_tokens: 20 } }, "[DONE]"]);
      }
      default:
        return json(res, 404, { error: { message: `the mock has no scenario at ${url.pathname}` } });
    }
  });
  return { server, log, reset: () => { log.length = 0; rateCalls = 0; flakyCalls = 0; judgeCalls = 0; sessions.clear(); flakyCounts.clear(); } };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Start one on a free port (tests): { url, log, close }
export async function startMock(options) {
  const mock = createMock(options);
  await new Promise((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  const { port } = mock.server.address();
  return { url: `http://127.0.0.1:${port}`, port, log: mock.log, reset: mock.reset, close: () => new Promise((r) => mock.server.close(r)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const at = process.argv.indexOf("--port");
  const port = Number(at > -1 ? process.argv[at + 1] : 8791);
  const mock = createMock();
  mock.server.listen(port, "127.0.0.1", () => process.stdout.write(`mock endpoint: http://127.0.0.1:${port}\n`));
}
