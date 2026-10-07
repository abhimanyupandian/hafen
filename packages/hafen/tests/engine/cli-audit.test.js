// What checking every runner flow from the command line found, each fixed and held here: every event
// a run or a conversation sends out is redacted (a check's reason, a streamed reply, a step: a CI log
// or the page never sees a secret); a provider plugin is given the test's variables and its settings
// filled in, never a secret; a test's checks on the whole conversation look at the conversation; a
// load test asked to run (load mode isn't built) is a setup error, nothing sent.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createConversation } from "../../engine/explore.js";
import { loadSuite } from "../../engine/files/suite-file.js";
import { runSuites } from "../../engine/runner.js";
import { createScope } from "../../engine/vars.js";
import { fakeTransport, memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
beforeEach(() => mock.reset());
after(() => mock.close());

const SECRET = "sk-very-secret-4242";

async function run(files, { options = {}, secrets = { MY_KEY: SECRET }, file = "s.hafen.yml" } = {}) {
  const host = memoryHost(files, { secrets });
  const events = [];
  const suite = await loadSuite(host, file);
  assert.deepEqual(suite.errors, [], JSON.stringify(suite.errors));
  const out = await runSuites({ suites: [suite], host, options, onEvent: (e) => events.push(e) });
  return { run: out, events };
}

describe("every event a run sends out is redacted", () => {
  it("a check's reason, the message, the streamed reply, a test's end, a span: none holds the secret (it was sent)", async () => {
    const { run: r, events } = await run({
      "providers/p.yml": `kind: http\nurl: "${mock.url}/sse"\nheaders: { Authorization: "Bearer {{secret.MY_KEY}}" }\nbody: { message: "{{user}}" }\nstream: sse\nevents:\n  - when: { $.type: text_delta }\n    text: $.delta\n`,
      "s.hafen.yml": `version: 1
provider: providers/p.yml
tests:
  - name: leaks
    turns:
      - user: "echo {{secret.MY_KEY}}"
        expect:
          - { contains: "not {{secret.MY_KEY}} here" }
          - { not_contains: "{{secret.MY_KEY}}" }
    teardown:
      - name: "tell {{secret.MY_KEY}}"
        request: { url: "${mock.url}/json", method: POST, body: { message: "bye" } }
`,
    });
    // The secret went where it was meant to
    assert.equal(mock.log[0].headers.authorization, `Bearer ${SECRET}`);
    assert.equal(mock.log[0].body.message, `echo ${SECRET}`);
    // The reasons name it (redacted)
    assert.deepEqual(r.turns[0].results.map((x) => x.status), ["fail", "fail"]);
    const kinds = new Set(events.map((e) => e.type));
    for (const kind of ["test:start", "test:end", "turn:start", "turn:event", "turn:end", "span", "run:end"]) assert.ok(kinds.has(kind), kind);
    const leaked = events.filter((e) => JSON.stringify(e).includes(SECRET)).map((e) => e.type);
    assert.deepEqual(leaked, []);
    // The test's end still says why it failed, the secret hidden
    const end = events.find((e) => e.type === "test:end");
    assert.match(end.test.instances[0].results[0].reason, /\[redacted\]/);
  });

  it("a turn skipped after a failure (on_fail: stop), and a turn whose message can't be made: redacted too", async () => {
    const { events } = await run({
      "providers/p.yml": `kind: http\nurl: "${mock.url}/json"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
      "s.hafen.yml": `version: 1
provider: providers/p.yml
tests:
  - name: stops
    on_fail: stop
    turns:
      - { user: "first {{secret.MY_KEY}}", expect: [ { contains: "nope" } ] }
      - { user: "second {{secret.MY_KEY}}" }
`,
    });
    const skipped = events.find((e) => e.type === "turn:end" && e.record.skipped);
    assert.ok(skipped);
    assert.equal(skipped.record.user, "second [redacted]");
    assert.ok(!JSON.stringify(events).includes(SECRET));
  });

  it("a conversation's events too (a reply that echoes the secret)", async () => {
    const transport = fakeTransport((req) => ({ body: JSON.stringify({ r: `you sent ${JSON.parse(req.body).m}` }) }));
    const host = memoryHost({}, { secrets: { MY_KEY: SECRET }, transport });
    const events = [];
    const c = createConversation({ host, providerConfig: { kind: "http", url: "http://e/chat", body: { m: "{{user}}" }, response: { text: "$.r" } }, scopeValues: { name: "stage", values: {} }, onEvent: (e) => events.push(e) });
    c.setScope({ name: "stage", values: {} });
    await c.send("my key is {{secret.MY_KEY}}");
    assert.equal(JSON.parse(transport.requests[0].body).m, `my key is ${SECRET}`);
    assert.ok(events.some((e) => e.type === "turn:event"));
    assert.deepEqual(events.filter((e) => JSON.stringify(e).includes(SECRET)).map((e) => e.type), []);
  });
});

describe("a provider plugin is given the variables and its settings filled in, never a secret", () => {
  // (what it's given goes in base64: a {{secret.…}} in its request would be filled in as it leaves)
  const PLUGIN = `export default {
  kind: "provider", name: "echo", version: "1.0.0", hosts: ["127.0.0.1"],
  async *send({ message, variables, settings, env, transport, signal }) {
    const given = btoa(JSON.stringify({ variables, settings, env }));
    const res = await transport.fetch({ url: settings.url, method: "POST", body: { message, given }, signal });
    const data = await res.json();
    yield { type: "text", text: data.data.reply };
    yield { type: "done" };
  },
};
`;

  it("settings' {{name}}s are filled from the variables and {{env.NAME}} from the environment; a {{secret.…}} isn't", async () => {
    const { run: r } = await run({
      "plugins/echo.js": PLUGIN,
      "s.hafen.yml": `version: 1
provider: { kind: "plugin:echo", url: "{{base_url}}/json", region: "{{env.region}}", team: "{{team}}", key: "{{secret.MY_KEY}}", port: "{{port}}" }
plugins: [ ./plugins/echo.js ]
environments:
  stage: { base_url: "${mock.url}", port: 8080 }
variables: { team: refunds, token: "{{secret.MY_KEY}}" }
tests:
  - name: t
    data: data/rows.csv
    turns:
      - user: "hi {{row.who}}"
        extract: { said: $.text }
      - user: again
`,
      "data/rows.csv": "who\npriya\n",
    }, { options: { environment: { name: "stage", values: { region: "eu-1" } } } });
    assert.equal(r.status, "done", JSON.stringify(r.error));
    assert.equal(r.verdict, "passed", JSON.stringify(r.turns.map((t) => t.error)));
    const [first, second] = mock.log.map((x) => JSON.parse(atob(x.body.given)));
    assert.equal(first.settings.url, `${mock.url}/json`);
    assert.equal(first.settings.region, "eu-1");
    assert.equal(first.settings.team, "refunds");
    assert.equal(first.settings.port, 8080, "a whole {{name}} keeps its type");
    assert.equal(first.settings.key, "{{secret.MY_KEY}}", "a secret isn't filled in for a plugin");
    assert.equal(first.variables.team, "refunds");
    assert.equal(first.variables.base_url, mock.url);
    assert.equal(first.variables.token, "{{secret.MY_KEY}}");
    assert.deepEqual(first.variables.row, { who: "priya" });
    assert.equal(first.variables.scope, undefined);
    assert.deepEqual(first.env, { base_url: mock.url, port: 8080, region: "eu-1" });
    assert.equal(first.variables.test.name, "t");
    // An extraction (from the reply the plugin gave) reaches the next turn's variables
    assert.equal(second.variables.said, "You said: hi priya");
    assert.ok(!JSON.stringify(mock.log).includes(SECRET));
  });

  it("scope.plain and scope.variables on their own", () => {
    const used = new Set();
    const scope = createScope({
      layers: [{ a: 1, s: "x {{secret.K}}" }, { a: 2, b: "two" }],
      trusted: [],
      secrets: (n) => ({ K: "kkkk-secret", P: "pppp-secret" })[n],
      used,
      environment: { name: "stage", values: { db: { host: "h" } } },
    });
    assert.deepEqual(scope.plain({ x: "{{a}}", y: "{{b}}/{{a}}", z: "{{env.db.host}}", s: "{{s}}", e: "{{secret.K}}", p: "Bearer {{secrets.P}}", m: "{{missing}}" }),
      { x: 1, y: "two/1", z: "h", s: "x {{secret.K}}", e: "{{secret.K}}", p: "Bearer {{secrets.P}}", m: "{{missing}}" });
    assert.deepEqual(scope.variables(), { a: 1, b: "two", s: "x {{secret.K}}" });
    assert.deepEqual(scope.envValues(), { db: { host: "h" } });
    assert.equal(used.size, 0, "no secret was looked up");
  });
});

describe("checks on the whole conversation", () => {
  const files = (checks) => ({
    "providers/p.yml": `kind: http\nurl: "${mock.url}/json"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
    "s.hafen.yml": `version: 1
provider: providers/p.yml
judges:
  default: { kind: systemone, endpoint: "${mock.url}/systemone" }
tests:
  - name: t
    turns: [ { user: a refund for 4417 }, { user: thanks } ]
    expect_conversation:
${checks.map((c) => `      - ${c}`).join("\n")}
`,
  });

  it("look at every turn by default (a path into it, a judge given all of it); `on` still picks another input", async () => {
    const { run: r } = await run(files([
      '{ path: "$[*].reply", contains: "You said: thanks" }',
      '{ path: "$[0].user", equals: "a refund for 4417" }',
      '{ path: "$", max_length: 2 }',
      '{ type: systemone.noul, question: "Did it ask why?", min: 0.8 }',
      '{ on: reply, contains: "You said: thanks" }',
      '{ on: reply, contains: "why" }',
    ]), { secrets: { JEV_API_KEY: "jev-key-12345" } });
    const results = r.tests[0].instances[0].conversation_results;
    assert.deepEqual(results.map((x) => x.status), ["pass", "pass", "pass", "pass", "pass", "fail"], JSON.stringify(results));
    const state = mock.log.find((x) => x.path === "/systemone/v1/systemone").body.state;
    assert.match(state, /a refund for 4417/);
    assert.match(state, /You said: thanks/);
  });

  it("a turn's own checks still look at its reply", async () => {
    const { run: r } = await run({
      "providers/p.yml": `kind: http\nurl: "${mock.url}/json"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
      "s.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: t\n    turns:\n      - { user: hello, expect: [ { contains: \"You said: hello\" }, { path: $.data.order.id, equals: 4417 } ] }\n",
    });
    assert.deepEqual(r.turns[0].results.map((x) => x.status), ["pass", "pass"]);
  });
});

describe("load tests", () => {
  const files = () => ({
    "providers/p.yml": `kind: http\nurl: "${mock.url}/json"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
    "s.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: heavy\n    load: { concurrency: 4, requests: 8 }\n    turns: [ { user: hi } ]\n  - name: light\n    turns: [ { user: hi } ]\n",
  });

  it("skipped unless asked for; asked for (load mode isn't built), a setup error naming the test, nothing sent", async () => {
    const plain = await run(files());
    assert.deepEqual(plain.run.tests.map((t) => [t.name, t.status]), [["heavy", "skipped"], ["light", "passed"]]);
    assert.equal(mock.log.length, 1);
    mock.reset();
    const asked = await run(files(), { options: { load: true } });
    assert.equal(asked.run.status, "error");
    assert.match(asked.run.error.message, /"heavy" is a load test, and load tests can't run yet/);
    assert.equal(mock.log.length, 0);
    // Not chosen (--test light): no problem
    const other = await run(files(), { options: { load: true, tests: ["light"] } });
    assert.equal(other.run.status, "done");
    assert.equal(other.run.verdict, "passed");
  });
});

describe("what the format has but can't run yet: said, never sent without it or passed", () => {
  it("a simulated user is a test error; attachments and an image part are turn errors, nothing sent; text parts are sent", async () => {
    const files = {
      "providers/p.yml": `kind: http\nurl: "${mock.url}/json"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
      "docs/invoice.pdf": "%PDF",
      "s.hafen.yml": `version: 1
provider: providers/p.yml
providers:
  user_model: providers/p.yml
tests:
  - name: simulated
    simulate: { user: user_model, scenario: "a refund", max_turns: 3 }
  - name: attached
    turns:
      - { user: here is my invoice, attachments: [ { file: docs/invoice.pdf } ], expect: [ { contains: invoice } ] }
      - { user: after it }
  - name: image
    turns:
      - user: [ { text: "look" }, { image: docs/invoice.pdf } ]
  - name: text parts
    turns:
      - user: [ { text: "one" }, { text: "two" } ]
        expect: [ { contains: "one\\ntwo" } ]
`,
    };
    const host = memoryHost(files);
    const suite = await loadSuite(host, "s.hafen.yml");
    // Loaded with a warning for each, where it is
    assert.deepEqual(suite.warnings.map((w) => [w.line, w.message.split(" (")[0]]), [
      [7, "simulated users can't run yet"], [10, "attachments can't be sent yet"], [14, "a message's parts other than text"],
      [12, '"image" has no checks: it passes whenever each turn gets a reply'],
    ]);
    const r = await runSuites({ suites: [suite], host, options: {} });
    const status = Object.fromEntries(r.tests.map((t) => [t.name, [t.status, t.reason ?? t.instances[0]?.reason]]));
    assert.deepEqual(status.simulated, ["error", "simulated users can't run yet (they aren't built)"]);
    assert.deepEqual(status.attached, ["error", "attachments can't be sent yet (they aren't built)"]);
    assert.equal(status.image[0], "error");
    assert.deepEqual(status["text parts"][0], "passed");
    assert.equal(r.verdict, "failed");
    // Only the text parts were sent; the turn after the attachment wasn't
    assert.deepEqual(mock.log.map((x) => x.body.message), ["one\ntwo"]);
    const attached = r.turns.find((t) => t.user === "here is my invoice");
    assert.match(attached.error, /attachments can't be sent yet/);
    assert.deepEqual(attached.results.map((x) => x.status), ["error"]);
    assert.equal(r.turns.find((t) => t.user === "look").error.startsWith("a message's parts"), true);
  });
});
