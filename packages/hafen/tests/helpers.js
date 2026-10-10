// What the tests share: a host with files in memory, a fake transport that serves recorded
// responses, and the mock endpoint.

import { fetchTransport } from "../engine/transport.js";
import { nodePluginWorker } from "../cli/node-host.js";

export { startMock } from "./fixtures/mock-endpoint.mjs";

export function memoryHost(files = {}, { secrets = {}, transport = fetchTransport() } = {}) {
  const store = new Map(Object.entries(files));
  return {
    root: "",
    transport,
    secrets: (name) => secrets[name],
    now: () => performance.now(),
    clock: () => Date.now(),
    where: { app: "test" },
    files: {
      read: async (p) => {
        if (!store.has(p)) throw new Error(`no file ${p}`);
        return store.get(p);
      },
      write: async (p, t) => { store.set(p, t); },
      exists: async (p) => store.has(p),
      remove: async (p) => {
        if (!store.delete(p)) throw new Error(`no file ${p}`);
      },
    },
    list: async () => [...store.keys()],
    pluginWorker: nodePluginWorker,
    store,
  };
}

// A transport that answers every request with `respond(request)`: { status, headers, chunks: [strings] }
export function fakeTransport(respond) {
  const requests = [];
  return {
    requests,
    async send(request) {
      requests.push(request);
      const r = await respond(request, requests.length);
      async function* body() {
        for (const c of r.chunks ?? [r.body ?? ""]) yield new TextEncoder().encode(c);
      }
      return { status: r.status ?? 200, headers: r.headers ?? { "content-type": "application/json" }, body: body() };
    },
  };
}

// SSE text from JSON events, split in awkward places
export function sseChunks(events, { split = 7 } = {}) {
  const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
  const out = [];
  for (let i = 0; i < text.length; i += split) out.push(text.slice(i, i + split));
  return out;
}

export const MOCK_SSE_PROVIDER = `kind: http
url: "{{base_url}}/{{scenario}}"
body: { message: "{{user}}" }
stream: sse
events:
  - when: { $.type: text_delta }
    text: $.delta
  - when: { $.type: thinking_delta, $.visibility: summary }
    thinking: $.delta
    thinking_visibility: summary
  - when: { $.type: thinking_delta, $.visibility: omitted }
    thinking: $.delta
    thinking_visibility: omitted
  - when: { $.type: thinking_delta }
    thinking: $.delta
  - when: { $.type: tool_call }
    tool_call: { id: $.id, name: $.name, args: $.args }
  - when: { $.type: tool_result }
    tool_result: { id: $.id, name: $.name, result: $.result }
  - when: { $.type: usage }
    usage: { input: $.input_tokens, output: $.output_tokens, thinking: $.thinking_tokens }
`;
