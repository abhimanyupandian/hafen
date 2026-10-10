// A2A agents (kind: a2a; contracts/provider.md, Presets): the Agent2Agent protocol over JSON-RPC, in
// version 1.0 and 0.3, streamed and not, found from the agent card or at its url. Against the mock's
// agent (tests/fixtures/mock-endpoint.mjs, /a2a): a refund it asks about (input-required), then does
// (an artifact in two pieces, completed); a message; a task that fails.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { runSuites } from "../../engine/runner.js";
import { servePort } from "../../engine/serve-port.js";
import { memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
after(() => mock.close());

const ASK = "Could you tell me why you want a refund for order 4417?";
const DONE = "I've started a refund for order 4417.";
// The refund, in two turns: its checks, in the version's spelling of the states
const REFUND = (st) => `  - name: refund
    turns:
      - user: I'd like a refund for order 4417
        expect:
          - { contains: "why you want a refund" }
          - { path: $.last.status.state, equals: ${st("input-required")} }
      - user: It arrived broken
        expect:
          - { contains: "${DONE}" }
          - { path: $.last.status.state, equals: ${st("completed")} }
          - { path: "$.last.artifacts[0].parts[*].text", contains: "for order 4417." }
`;
const V1 = (s) => `TASK_STATE_${s.toUpperCase().replace(/-/g, "_")}`;
const V03 = (s) => s;
const suite = (tests) => `version: 1
provider: providers/agent.yml
environments:
  local: { base_url: "${mock.url}" }
tests:
${tests}`;
async function run(provider, tests, secrets = {}) {
  const host = memoryHost({ "providers/agent.yml": provider, "s.hafen.yml": suite(tests) });
  host.secrets = (name) => secrets[name];
  return runSuites({ suites: [await loadSuite(host, "s.hafen.yml")], host });
}
const calls = (path) => mock.log.filter((x) => x.path === path && x.method === "POST");
const passed = (r) => assert.equal(r.verdict, "passed", JSON.stringify(r.error ?? r.turns.map((t) => [t.reply, t.error, t.results?.filter((x) => x.status !== "pass")])));

describe("A2A agents", () => {
  it("1.0, found from its card, streamed: progress as thinking, its question, then the same task carried on to an artifact", async () => {
    mock.reset();
    const r = await run(`kind: a2a\ncard: "{{base_url}}/a2a"\n`, REFUND(V1));
    passed(r);
    const [first, second] = r.turns;
    assert.equal(first.reply, ASK);
    assert.deepEqual(first.thinking.map((t) => [t.text, t.visibility]), [["Looking up order 4417", "progress"]]);
    assert.equal(second.reply, DONE);
    assert.deepEqual(second.thinking.map((t) => t.text), ["Starting the refund"]);
    // The card read once for the test; every message SendStreamingMessage, as 1.0 writes it
    assert.equal(mock.log.filter((x) => x.path === "/a2a/.well-known/agent-card.json").length, 1);
    const sent = calls("/a2a/v1");
    assert.deepEqual(sent.map((x) => x.body.method), ["SendStreamingMessage", "SendStreamingMessage"]);
    assert.equal(sent[0].headers["a2a-version"], "1.0");
    assert.deepEqual(sent[0].body.params.message.parts, [{ text: "I'd like a refund for order 4417" }]);
    assert.equal(sent[0].body.params.message.role, "ROLE_USER");
    assert.equal(sent[0].body.params.message.contextId, undefined, "the agent makes the context");
    // The next turn carries on the task it asked about, in its context
    const asked = first.response.assembled.last;
    assert.equal(sent[1].body.params.message.taskId, asked.id);
    assert.equal(sent[1].body.params.message.contextId, asked.contextId);
  });

  it("1.0 at its url, not streamed (SendMessage): the same replies, from the task as it ended", async () => {
    mock.reset();
    const r = await run(`kind: a2a\nurl: "{{base_url}}/a2a/v1"\nstreaming: false\n`, REFUND(V1));
    passed(r);
    assert.deepEqual(r.turns.map((t) => t.reply), [ASK, DONE]);
    assert.deepEqual(calls("/a2a/v1").map((x) => x.body.method), ["SendMessage", "SendMessage"]);
    assert.equal(mock.log.filter((x) => x.method === "GET").length, 0, "no card read: the url is given");
  });

  it("0.3, found from its card (which says it doesn't stream), and streamed when asked: kind on every object", async () => {
    mock.reset();
    const fromCard = await run(`kind: a2a\ncard: "{{base_url}}/a2a03/.well-known/agent-card.json"\n`, REFUND(V03));
    passed(fromCard);
    assert.deepEqual(fromCard.turns.map((t) => t.reply), [ASK, DONE]);
    const sent = calls("/a2a03");
    assert.deepEqual(sent.map((x) => x.body.method), ["message/send", "message/send"]);
    assert.deepEqual(sent[0].body.params.message.parts, [{ kind: "text", text: "I'd like a refund for order 4417" }]);
    assert.equal(sent[0].body.params.message.role, "user");
    assert.equal(sent[0].body.params.message.kind, "message");
    assert.equal(sent[0].headers["a2a-version"], undefined, "0.3 has no version header");
    mock.reset();
    const streamed = await run(`kind: a2a\nurl: "{{base_url}}/a2a03"\nversion: "0.3"\nstreaming: true\n`, REFUND(V03));
    passed(streamed);
    assert.deepEqual(streamed.turns[0].thinking.map((t) => t.text), ["Looking up order 4417"]);
    assert.deepEqual(calls("/a2a03").map((x) => x.body.method), ["message/stream", "message/stream"]);
  });

  it("an agent that answers with a message (no task): its text, and the message as `last`", async () => {
    mock.reset();
    const r = await run(`kind: a2a\nurl: "{{base_url}}/a2a/v1"\n`, `  - name: ping
    turns:
      - user: ping
        expect:
          - { contains: pong }
          - { path: "$.last.parts[0].text", equals: pong }
          - { path: $.last.role, equals: ROLE_AGENT }
`);
    passed(r);
  });

  it("a task that fails, a JSON-RPC error, a card that isn't there, and no url or card: errors that say so", async () => {
    mock.reset();
    const turn = `  - name: t\n    turns: [ { user: please break } ]\n`;
    const broke = await run(`kind: a2a\nurl: "{{base_url}}/a2a/v1"\n`, turn);
    assert.equal(broke.turns[0].error, "the task failed: the agent broke");
    // (0.3 at the 1.0 endpoint: no A2A-Version header, which it refuses)
    const version = await run(`kind: a2a\nurl: "{{base_url}}/a2a/v1"\nversion: "0.3"\n`, turn);
    assert.match(version.turns[0].error, /^A2A error -32009 \(VersionNotSupported\): A2A-Version \(none: 0\.3\) isn't supported here$/);
    const card = await run(`kind: a2a\ncard: "{{base_url}}/nowhere"\n`, turn);
    assert.match(card.turns[0].error, /the agent card at .*\/nowhere\/\.well-known\/agent-card\.json answered 404/);
    const none = await run(`kind: a2a\n`, turn);
    assert.match(none.turns[0].error, /an A2A provider needs its url .* or its card/);
  });

  it("its headers are templated (a key from a secret, redacted), and its configuration and metadata go with each message", async () => {
    mock.reset();
    const r = await run(`kind: a2a
url: "{{base_url}}/a2a/v1"
headers: { Authorization: "Bearer {{secret.AGENT_TOKEN}}" }
configuration: { acceptedOutputModes: [text/plain], historyLength: 0 }
metadata: { suite: refunds }
`, `  - name: t\n    turns: [ { user: hello, expect: [ { contains: "You said: hello" } ] } ]\n`, { AGENT_TOKEN: "agent-token-7f3a" });
    passed(r);
    const [sent] = calls("/a2a/v1");
    assert.equal(sent.headers.authorization, "Bearer agent-token-7f3a");
    assert.deepEqual(sent.body.params.configuration, { acceptedOutputModes: ["text/plain"], historyLength: 0 });
    assert.deepEqual(sent.body.params.metadata, { suite: "refunds" });
    assert.ok(!JSON.stringify(r).includes("agent-token-7f3a"));
  });

  it("in a conversation: the next message carries on the agent's task", async () => {
    mock.reset();
    const host = memoryHost({ "providers/agent.yml": `kind: a2a\ncard: "${mock.url}/a2a"\n` });
    const call = connect(async () => host);
    await call("open", {});
    const first = await call("send", { token: "c", providerFile: "providers/agent.yml", message: "I'd like a refund for order 4417" });
    assert.equal(first.record.reply, ASK);
    const second = await call("send", { token: "c", providerFile: "providers/agent.yml", message: "It arrived broken" });
    assert.equal(second.record.reply, DONE);
    const sent = calls("/a2a/v1");
    assert.ok(sent[1].body.params.message.taskId, "the task it asked about");
    await call("reset", { token: "c" });
  });
});

// A pretend port, as serve-port.test.js has
function connect(makeHost) {
  let handler;
  const waiting = new Map();
  let next = 1;
  servePort({ receive: (h) => { handler = h; }, send: (m) => { if (m.id) waiting.get(m.id)?.(m); } }, makeHost);
  return (cmd, args) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, (m) => (m.ok ? resolve(m.value) : reject(new Error(m.error))));
    handler({ id, cmd, args });
  });
}
