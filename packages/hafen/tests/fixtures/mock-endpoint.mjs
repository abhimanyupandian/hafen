// A local chat endpoint for tests and the quickstart: one scenario per path, so tests are fast, free
// and repeatable (constitution VI; research §27). Run it: npm run mock, in Hafen's repository (node
// packages/hafen/tests/fixtures/mock-endpoint.mjs --port 8791)
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
//   POST /auth/login           { user, password }: with the password qa-pass-1234, two cookies (Set-Cookie: sid, region)
//                              and { csrf_token }; else 401
//   POST /auth/chat            /json, behind that login: the sid cookie and x-csrf-token, or 401
//   GET  /a2a/.well-known/agent-card.json    an A2A agent's card, version 1.0 (supportedInterfaces: /a2a/v1, streaming)
//   POST /a2a/v1               that agent, JSON-RPC: SendMessage, SendStreamingMessage (needs A2A-Version: 1.0)
//   GET  /a2a03/.well-known/agent-card.json  the same agent in version 0.3 (url: /a2a03, no streaming)
//   POST /a2a03                JSON-RPC: message/send, message/stream
//                              The agent: a refund (no task yet) → working ("Looking up order 4417"), then
//                              input-required (it asks why); the answer (with that taskId) → an artifact in two
//                              pieces, completed. "ping" → a Message (no task). "break" → failed. Else → an
//                              artifact "You said: …", completed. contextId: the one sent, else a new one.
//   POST /systemone/v1/systemone   a System One API: noul 0.91 when the state asks "why", else 0.12; questions
//                                  whose instructions say UNSURE answer 0.55 (confidence 0.1); CONFIDENCE=0.42
//                                  in them, that confidence (any type); a choice's NO-CONFIDENCE, none (and no
//                                  probabilities)
//   GET  /systemone/v1/models
//   POST /judge/chat/completions   an OpenAI-compatible LLM judge (streamed): criteria met unless they say NOT-MET;
//                                  criteria that say FLAKY alternate between met and not
//   GET  /_log, DELETE /_log    the requests received

import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The login behind /auth/chat: the password it takes, and the session and CSRF token it gives
export const AUTH = { password: "qa-pass-1234", sid: "sess-5f2a9c71", csrf: "csrf-0b7e41d2" };
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

  // An A2A agent (https://a2a-protocol.org), the same in version 1.0 and 0.3: what it does, as
  // version-free steps, written out in the version asked for
  const a2aTasks = new Map();  // taskId → { contextId, state }
  let a2aCount = 0;
  const a2aAgent = async ({ url, req, res, body, sse }) => {
    const host = `http://${req.headers.host}`;
    if (req.method === "GET" && url.pathname === "/a2a/.well-known/agent-card.json") {
      return json(res, 200, { name: "Mock refunds agent", version: "1.0.0", supportedInterfaces: [{ url: `${host}/a2a/v1`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }], capabilities: { streaming: true }, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills: [] });
    }
    if (req.method === "GET" && url.pathname === "/a2a03/.well-known/agent-card.json") {
      return json(res, 200, { name: "Mock refunds agent", version: "1.0.0", protocolVersion: "0.3.0", url: `${host}/a2a03`, preferredTransport: "JSONRPC", capabilities: { streaming: false }, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills: [] });
    }
    const v1 = url.pathname === "/a2a/v1";
    if (!v1 && url.pathname !== "/a2a03") return json(res, 404, { error: { message: `no A2A agent at ${url.pathname}` } });
    const id = body?.id ?? null;
    const fail = (code, message) => json(res, 200, { jsonrpc: "2.0", id, error: { code, message } });
    if (v1 && req.headers["a2a-version"] !== "1.0") return fail(-32009, `A2A-Version ${req.headers["a2a-version"] ?? "(none: 0.3)"} isn't supported here`);
    const methods = v1 ? { SendMessage: false, SendStreamingMessage: true } : { "message/send": false, "message/stream": true };
    if (!(body?.method in methods)) return fail(-32601, `no method ${body?.method}`);
    const streaming = methods[body.method];
    const m = body.params?.message ?? {};
    const text = (m.parts ?? []).map((p) => p.text ?? "").join("");
    // What the agent does: steps { task } { status, said? } { artifact, text, append? } { message }
    let taskId = m.taskId;
    let steps;
    if (taskId && !a2aTasks.has(taskId)) return fail(-32001, `there's no task ${taskId}`);
    const contextId = m.contextId ?? (taskId ? a2aTasks.get(taskId).contextId : `ctx-${++a2aCount}`);
    if (/^ping$/i.test(text.trim())) steps = [{ message: "pong" }];
    else if (taskId) steps = [{ status: "working", said: "Starting the refund" }, { artifact: "refund", text: "I've started a refund " }, { artifact: "refund", text: "for order 4417.", append: true }, { status: "completed" }];
    else if (/refund/i.test(text)) steps = [{ task: true }, { status: "working", said: "Looking up order 4417" }, { status: "input-required", said: "Could you tell me why you want a refund for order 4417?" }];
    else if (/break/i.test(text)) steps = [{ task: true }, { status: "failed", said: "the agent broke" }];
    else steps = [{ task: true }, { artifact: "echo", text: `You said: ${text}` }, { status: "completed" }];
    if (!steps[0].message) {
      taskId ??= `task-${++a2aCount}`;
      a2aTasks.set(taskId, { contextId, state: "submitted" });
    }
    // Written in the version asked for
    const state = (st) => (v1 ? `TASK_STATE_${st.toUpperCase().replace(/-/g, "_")}` : st);
    const msg = (t) => (v1 ? { messageId: `m-${++a2aCount}`, role: "ROLE_AGENT", parts: [{ text: t }], contextId, ...(taskId ? { taskId } : {}) }
      : { kind: "message", messageId: `m-${++a2aCount}`, role: "agent", parts: [{ kind: "text", text: t }], contextId, ...(taskId ? { taskId } : {}) });
    const status = (step) => ({ state: state(step.status), ...(step.said ? { message: msg(step.said) } : {}) });
    const artifacts = new Map();
    const task = () => ({ ...(v1 ? {} : { kind: "task" }), id: taskId, contextId, status: { state: state(a2aTasks.get(taskId).state) }, ...(artifacts.size ? { artifacts: [...artifacts.values()] } : {}) });
    const events = [];
    let last = null;
    for (const step of steps) {
      if (step.message) { last = msg(step.message); events.push(v1 ? { message: last } : last); continue; }
      if (step.task) { events.push(v1 ? { task: task() } : task()); continue; }
      if (step.status) {
        a2aTasks.get(taskId).state = step.status;
        last = status(step);
        const ends = !["working", "submitted"].includes(step.status);
        events.push(v1 ? { statusUpdate: { taskId, contextId, status: last } } : { kind: "status-update", taskId, contextId, status: last, final: ends });
        continue;
      }
      const part = v1 ? { text: step.text } : { kind: "text", text: step.text };
      const kept = artifacts.get(step.artifact);
      artifacts.set(step.artifact, { artifactId: step.artifact, parts: [...(step.append && kept ? kept.parts : []), part] });
      const artifact = { artifactId: step.artifact, parts: [part] };
      events.push(v1 ? { artifactUpdate: { taskId, contextId, artifact, ...(step.append ? { append: true } : {}) } } : { kind: "artifact-update", taskId, contextId, artifact, ...(step.append ? { append: true } : {}) });
    }
    if (streaming) return sse(events.map((result) => ({ jsonrpc: "2.0", id, result })));
    // SendMessage: the task as it ended (its last status, its artifacts), or the message
    const result = steps[0].message ? (v1 ? { message: last } : last) : (() => { const t = task(); t.status = last ?? t.status; return v1 ? { task: t } : t; })();
    return json(res, 200, { jsonrpc: "2.0", id, result });
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
    if (url.pathname.startsWith("/a2a")) return a2aAgent({ url, req, res, body, sse });
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
      case "/auth/login":
        if (body?.password !== AUTH.password) return json(res, 401, { error: { message: "wrong user or password" } });
        res.writeHead(200, { "content-type": "application/json", "set-cookie": [`sid=${AUTH.sid}; Path=/; HttpOnly`, "region=eu; Path=/"] });
        return res.end(JSON.stringify({ csrf_token: AUTH.csrf }));
      case "/auth/chat":
        if (!String(req.headers.cookie ?? "").includes(`sid=${AUTH.sid}`) || req.headers["x-csrf-token"] !== AUTH.csrf) return json(res, 401, { error: { message: "log in first" } });
        return json(res, 200, { data: { reply } });
      case "/systemone/v1/models":
        return json(res, 200, { models: [{ name: "jev-mock" }] });
      case "/systemone/v1/systemone": {
        if (!req.headers.authorization) return json(res, 401, { error: { message: "no API key" } });
        const state = String(body?.state ?? "");
        const answers = {};
        for (const [name, q] of Object.entries(body?.questions ?? {})) {
          const unsure = /UNSURE/.test(q.instructions ?? "");
          const said = (q.instructions ?? "").match(/CONFIDENCE=([\d.]+)/);
          if (q.type === "noul") answers[name] = { noul: unsure ? 0.55 : /why/i.test(state) ? 0.91 : 0.12 };
          else if (q.type === "choice") {
            const options = Object.keys(q.criteria ?? {});
            const picked = options.find((o) => state.toLowerCase().includes(o.toLowerCase())) ?? options[0];
            const p = unsure ? 0.4 : 0.86;
            answers[name] = /NO-CONFIDENCE/.test(q.instructions ?? "")
              ? { choice: picked }
              : { choice: picked, confidence: p, probabilities: Object.fromEntries(options.map((o) => [o, o === picked ? p : (1 - p) / Math.max(1, options.length - 1)])) };
          } else if (q.type === "score") {
            const levels = Array.isArray(q.criteria) ? q.criteria : [];
            const score = state.length > 40 ? levels.length - 1 : 0;
            answers[name] = { score, confidence: unsure ? 0.3 : 0.8, legend: levels, probabilities: Object.fromEntries(levels.map((_, i) => [i, i === score ? 0.8 : 0.2 / Math.max(1, levels.length - 1)])) };
          }
          if (said && answers[name]) answers[name].confidence = Number(said[1]);
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
  return { server, log, reset: () => { log.length = 0; rateCalls = 0; flakyCalls = 0; judgeCalls = 0; sessions.clear(); flakyCounts.clear(); a2aTasks.clear(); a2aCount = 0; } };
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
