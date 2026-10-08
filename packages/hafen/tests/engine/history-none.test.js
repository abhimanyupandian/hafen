// A provider's history: none (contracts/provider.md, History): each turn sends only its own message,
// with no conversation. {{messages}} is that message alone and {{history}} is empty; no session goes
// back ({{session}}, an A2A agent's contextId); the presets send that one message. In a run, and in a
// conversation (the app's Try it), which takes it from the provider too.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { createConversation } from "../../engine/explore.js";
import { runSuites } from "../../engine/runner.js";
import { fakeTransport, memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
after(() => mock.close());

// Two turns through a provider written inline: the requests it sent
async function twoTurns(provider, transport) {
  const host = memoryHost({ "s.hafen.yml": `version: 1
provider: ${provider}
tests:
  - name: t
    turns: [ { user: first }, { user: second } ]
` }, { transport });
  const suite = await loadSuite(host, "s.hafen.yml");
  assert.deepEqual(suite.errors, []);
  const run = await runSuites({ suites: [suite], host });
  assert.equal(run.status, "done", JSON.stringify(run.error));
  return run;
}
const replying = () => fakeTransport((req, n) => ({ body: JSON.stringify({ reply: `reply ${n}`, session_id: `sess-${n}` }) }));
const HTTP = (history) => `{ kind: http, url: "http://x.example/chat"${history ? `, history: ${history}` : ""}, body: { messages: "{{messages}}", history: "{{history}}", session: "{{session}}" }, session: { extract: $.session_id }, response: { text: $.reply } }`;

describe("history: none", () => {
  it("the second turn sends only its own message ({{messages}} one message, {{history}} empty)", async () => {
    const transport = replying();
    await twoTurns(HTTP("none"), transport);
    const second = JSON.parse(transport.requests[1].body);
    assert.deepEqual(second.messages, [{ role: "user", content: "second" }]);
    assert.deepEqual(second.history, []);
    // (and no session to carry the conversation on)
    assert.equal(second.session, "");
  });

  it("without it, the second turn sends the conversation (as before)", async () => {
    const transport = replying();
    await twoTurns(HTTP(""), transport);
    const second = JSON.parse(transport.requests[1].body);
    assert.deepEqual(second.messages, [{ role: "user", content: "first" }, { role: "assistant", content: "reply 1" }, { role: "user", content: "second" }]);
    assert.deepEqual(second.history, [{ query: "first", response: "reply 1" }]);
    assert.equal(second.session, "sess-1");
  });

  it("messages_format text: this turn's message alone", async () => {
    const transport = replying();
    await twoTurns(`{ kind: http, url: "http://x.example/chat", history: none, messages_format: text, body: { prompt: "{{messages}}" }, response: { text: $.reply } }`, transport);
    assert.equal(JSON.parse(transport.requests[1].body).prompt, "User: second");
  });

  it("a preset (openai-chat) sends only this turn's message", async () => {
    mock.reset();
    await twoTurns(`{ kind: openai-chat, base_url: "${mock.url}/openai", model: m, api_key: "", history: none }`);
    const sent = mock.log.filter((x) => x.path === "/openai/chat/completions");
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].body.messages, [{ role: "user", content: "second" }]);
  });

  it("an A2A agent: the next turn goes without its contextId (a conversation of its own)", async () => {
    mock.reset();
    await twoTurns(`{ kind: a2a, url: "${mock.url}/a2a/v1", streaming: false, history: none }`);
    const sent = mock.log.filter((x) => x.path === "/a2a/v1" && x.method === "POST");
    assert.equal(sent.length, 2);
    assert.equal(sent[1].body.params.message.contextId, undefined);
    assert.equal(sent[1].body.params.message.taskId, undefined);
  });

  it("a conversation (Try it) with the provider's history: none sends each message alone", async () => {
    const transport = replying();
    const host = memoryHost({}, { transport });
    const c = createConversation({ host, providerConfig: { kind: "http", url: "http://x.example/chat", history: "none", body: { messages: "{{messages}}", history: "{{history}}" }, response: { text: "$.reply" } } });
    await c.send("first");
    await c.send("second");
    const second = JSON.parse(transport.requests[1].body);
    assert.deepEqual(second.messages, [{ role: "user", content: "second" }]);
    assert.deepEqual(second.history, []);
    await c.close();
  });
});
