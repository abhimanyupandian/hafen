// Coverage of docs/test-files.md and docs/plugins.md that the runner's own tests don't reach: the run's
// variables ({{run.id}}, {{test.name}}, {{repeat}}), which layer a {{name}} comes from (an extraction
// before a setup step's, before --var, before the suite's variables, before its environment's; the
// latest extraction winning), the suite's defaults, a test's own network profile, an environment's
// values left as they are in the record while secrets are redacted, a provider's afterAll fixtures
// running however the run ends (a beforeAll that failed, a run stopped, two suites), and what JUnit
// says of the run (its properties) and of a fixture that failed (<system-err>). Against the mock.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { junit } from "../../engine/reports/junit.js";
import { markdown } from "../../engine/index.js";
import { runSuites } from "../../engine/runner.js";
import { memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
after(() => mock.close());
beforeEach(() => mock.reset());

const JSON_PROVIDER = `kind: http
url: "{{base_url}}/json"
body: { message: "{{user}}" }
response:
  text: $.data.reply
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
price: { input: 1, output: 2 }
`;

async function runFiles(files, { options = {}, secrets = {}, signal, onEvent } = {}) {
  const host = memoryHost({ "providers/json.yml": JSON_PROVIDER, ...files }, { secrets });
  const suites = [];
  for (const file of Object.keys(files).filter((f) => f.endsWith(".hafen.yml")).sort()) {
    const suite = await loadSuite(host, file);
    assert.deepEqual(suite.errors, [], JSON.stringify(suite.errors));
    suites.push(suite);
  }
  return runSuites({ suites, host, options: { vars: { base_url: mock.url }, ...options }, signal, onEvent });
}
const sent = (path = "/json") => mock.log.filter((x) => x.path === path).map((x) => x.body.message);

describe("variables (docs/test-files.md, Variables)", () => {
  it("{{run.id}}, {{test.name}}, {{repeat}} and {{turn.index}} are the run's", async () => {
    const run = await runFiles({ "s.hafen.yml": `version: 1
provider: providers/json.yml
tests:
  - name: the run's own
    repeat: 2
    turns:
      - user: "run {{run.id}} · {{test.name}} · repeat {{repeat}} · turn {{turn.index}}"
      - user: "turn {{turn.index}} of {{test.name}}"
` });
    assert.equal(run.verdict, "passed", JSON.stringify(run.error));
    assert.deepEqual(sent(), [
      `run ${run._id} · the run's own · repeat 1 · turn 1`, "turn 2 of the run's own",
      `run ${run._id} · the run's own · repeat 2 · turn 1`, "turn 2 of the run's own",
    ]);
  });

  it("a {{name}}: the latest extraction, then a setup step's, then --var, then the suite's variables, then its environment's", async () => {
    const run = await runFiles({ "s.hafen.yml": `version: 1
provider: providers/json.yml
environments:
  local: { who: env-who, only_env: from-env, shadow: env-shadow, given: env-given }
variables: { who: var-who, shadow: var-shadow, given: var-given }
setup:
  - name: log in
    request: { url: "{{base_url}}/login", method: POST }
    extract: { shadow: $.access_token }
tests:
  - name: layers
    turns:
      - user: "1 {{who}} {{only_env}} {{shadow}} {{given}}"
        extract: { who: $.data.order.id }
      - user: "2 {{who}}"
        extract: { who: $.session_id }
      - user: "3 {{who}}"
` }, { options: { vars: { base_url: mock.url, given: "from --var" } } });
    assert.equal(run.verdict, "passed", JSON.stringify(run.error));
    assert.deepEqual(sent(), ["1 var-who from-env tok_mock_123 from --var", "2 4417", "3 sess_1"]);
  });

  it("a value that is exactly one {{name}} keeps its type; inside text, it's text", async () => {
    const run = await runFiles({ "s.hafen.yml": `version: 1
provider: providers/json.yml
variables: { order: 4417 }
tests:
  - name: typed
    turns:
      - user: "order {{order}}"
        expect:
          - { path: $.data.order.id, equals: "{{order}}", type_is: integer }
          - { path: $.data.order.id, equals: "{{order}}" }
` });
    assert.deepEqual(run.turns[0].results.map((r) => r.status), ["pass", "pass"]);
    assert.deepEqual(sent(), ["order 4417"]);
  });
});

describe("a test's settings (docs/test-files.md, Test keys)", () => {
  it("the suite's defaults (repeat, pass_rate) are every test's, and a test's own win", async () => {
    const run = await runFiles({ "s.hafen.yml": `version: 1
provider: providers/json.yml
defaults: { repeat: 3, pass_rate: 0.5 }
tests:
  - name: by default
    turns: [ { user: a } ]
  - name: its own
    repeat: 1
    turns: [ { user: b } ]
` });
    assert.deepEqual(run.tests.map((t) => [t.name, t.total, t.settings.pass_rate]), [["by default", 3, 0.5], ["its own", 1, 0.5]]);
  });

  it("network: a test's own profile delays its requests; the other test's aren't", async () => {
    const run = await runFiles({ "s.hafen.yml": `version: 1
provider: providers/json.yml
tests:
  - name: slow network
    network: { delay_ms: 400 }
    turns: [ { user: a, expect: [ { type: latency, max_ms: 5000 } ] } ]
  - name: plain
    turns: [ { user: b, expect: [ { type: latency, max_ms: 300 } ] } ]
` });
    assert.equal(run.verdict, "passed", JSON.stringify(run.turns.map((t) => t.results)));
    assert.ok(run.turns[0].metrics.ms >= 390, `${run.turns[0].metrics.ms} ms`);
    assert.ok(run.turns[1].metrics.ms < 300, `${run.turns[1].metrics.ms} ms`);
  });
});

describe("what's redacted, and what isn't", () => {
  it("an environment's values aren't secret, so they stay in the record; a secret beside them is redacted", async () => {
    const run = await runFiles({
      "providers/env.yml": `kind: http\nurl: "{{env.base}}/json"\nheaders: { X-Region: "{{env.region}}", X-Key: "{{secret.API_KEY}}" }\nbody: { message: "{{user}} in {{env.region}}" }\nresponse: { text: $.data.reply }\n`,
      "s.hafen.yml": "version: 1\nprovider: providers/env.yml\ntests:\n  - name: t\n    turns: [ { user: hello } ]\n",
    }, { options: { env: "stage", environment: { name: "stage", values: { base: mock.url, region: "eu-west-77" } } }, secrets: { API_KEY: "sk-redact-me-1234" } });
    assert.equal(run.verdict, "passed", JSON.stringify(run.error));
    assert.equal(mock.log[0].headers["x-key"], "sk-redact-me-1234");
    const text = JSON.stringify(run);
    assert.ok(!text.includes("sk-redact-me-1234"));
    assert.equal(run.turns[0].request.headers["X-Region"], "eu-west-77");
    assert.equal(run.turns[0].reply, "You said: hello in eu-west-77");
  });
});

describe("a provider's afterAll fixtures run however the run ends (docs/plugins.md, Fixtures)", () => {
  const fixture = (name, { provides = [], fail = false } = {}) => `export default {
  kind: "fixture", name: "${name}", version: "1.0.0", hosts: ["127.0.0.1"], provides: ${JSON.stringify(provides)},
  async run({ phase, settings, transport, signal }) {
    await transport.fetch({ url: settings.log_url, method: "POST", body: { message: "${name} " + phase }, signal });
    if (${fail}) throw new Error("${name} broke");
    return { ${provides.map((p) => `${p}: "v-${name}-1234"`).join(", ")} };
  },
};
`;
  const provider = (lists) => `kind: http
fixtures: ${lists}
url: "{{base_url}}/slow?ms=150"
log_url: "{{base_url}}/fixture-log"
headers: { x-token: "{{secret.TOKEN}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`;
  const suite = (n = 3) => `version: 1\nprovider: providers/p.yml\ntests:\n${Array.from({ length: n }, (_, k) => `  - name: t${k}\n    turns: [ { user: "chat ${k}" } ]\n`).join("")}`;
  const files = (over = {}) => ({
    "plugins/login.js": fixture("login", { provides: ["TOKEN"] }),
    "plugins/logout.js": fixture("logout"),
    "providers/p.yml": provider("{ beforeAll: [login], afterAll: [logout] }"),
    "s.hafen.yml": suite(),
    ...over,
  });
  const said = () => mock.log.filter((x) => x.path === "/fixture-log").map((x) => x.body.message);
  const chats = () => mock.log.filter((x) => x.path === "/slow");

  it("a beforeAll that fails: the suite is a setup error, nothing of it is sent, and the afterAll logout is still sent", async () => {
    const run = await runFiles(files({ "plugins/login.js": fixture("login", { provides: ["TOKEN"], fail: true }) }));
    assert.equal(run.status, "error");
    assert.match(run.error.message, /the fixture "login" \(beforeAll\) failed: login broke/);
    assert.deepEqual(said(), ["login beforeAll", "logout afterAll"]);
    assert.equal(chats().length, 0);
    assert.deepEqual(run.fixtures.map((f) => [f.name, f.phase, f.status]), [["login", "beforeAll", "error"], ["logout", "afterAll", "ok"]]);
  });

  it("a run stopped part way (cancelled): its afterAll still runs, after what was sent", async () => {
    const controller = new AbortController();
    const run = await runFiles(files(), { signal: controller.signal, onEvent: (e) => { if (e.type === "test:end") controller.abort(); } });
    assert.equal(run.status, "stopped");
    assert.ok(chats().length < 3, `${chats().length} chats`);
    assert.deepEqual(said(), ["login beforeAll", "logout afterAll"]);
  });

  it("two suites of one scope: beforeAll once at the start, afterAll once at the end", async () => {
    const run = await runFiles(files({ "t.hafen.yml": suite(1).replace("t0", "u0") }));
    assert.equal(run.verdict, "passed", JSON.stringify(run.error));
    assert.deepEqual(said(), ["login beforeAll", "logout afterAll"]);
    assert.equal(chats().length, 4);
    assert.ok(chats().every((c) => c.headers["x-token"] === "v-login-1234"));
    assert.ok(!JSON.stringify(run).includes("v-login-1234"), "what it gave is redacted");
  });
});

describe("JUnit and Markdown on fixtures that failed, and the run's numbers", () => {
  const fixture = (name, fail) => `export default { kind: "fixture", name: "${name}", version: "1.0.0", hosts: [], provides: [],
  async run() { if (${fail}) throw new Error("${name} broke"); } };`;

  it("a test's after fixture that failed is in its <system-err> (and <system-out>); the run's afterAll in its suite's; the Markdown table says failed", async () => {
    const run = await runFiles({
      "plugins/cleanup.js": fixture("cleanup", true),
      "plugins/logout.js": fixture("logout", true),
      "plugins/warm.js": fixture("warm", false),
      "providers/p.yml": `kind: http\nfixtures: { beforeAll: [warm], after: [cleanup], afterAll: [logout] }\nurl: "{{base_url}}/json"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
      "s.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: t\n    turns: [ { user: hi, expect: [ { contains: hi } ] } ]\n",
    });
    assert.equal(run.verdict, "passed", "a failed after or afterAll changes no result");
    const xml = junit(run);
    const testcase = xml.match(/<testcase [^>]*name="t"[^>]*>[\s\S]*?<\/testcase>/)[0];
    assert.match(testcase, /<system-out>[^<]*fixture cleanup \(after\)[^<]*failed: cleanup broke/);
    assert.match(testcase, /<system-err>fixture cleanup \(after\) · providers\/p\.yml · t · failed: cleanup broke/);
    assert.match(xml, /<\/testcase>\n {4}<system-out>fixture warm \(beforeAll\)[^<]*ok[^<]*\nfixture logout \(afterAll\)[^<]*failed: logout broke[^<]*<\/system-out>\n {4}<system-err>fixture logout \(afterAll\) · providers\/p\.yml · failed: logout broke/);
    assert.match(xml, /<property name="fixtures" value="3"\/>\n {6}<property name="fixtures_failed" value="2"\/>/);
    const md = markdown(run);
    assert.match(md, /### Fixtures/);
    assert.match(md, /\| ✗ \| cleanup \| after \|/);
    assert.match(md, /\| ✗ \| logout \| afterAll \|/);
  });

  it("JUnit's properties carry the run's latency, tokens and cost", async () => {
    const run = await runFiles({ "s.hafen.yml": "version: 1\nprovider: providers/json.yml\ntests:\n  - name: t\n    turns: [ { user: hi, expect: [ { contains: hi } ] }, { user: again } ]\n" });
    const xml = junit(run);
    const prop = (name) => xml.match(new RegExp(`<property name="${name}" value="([^"]*)"/>`))?.[1];
    assert.equal(prop("verdict"), "passed");
    assert.equal(prop("checks"), "1/1");
    assert.ok(Number(prop("latency_p50_ms")) > 0 && Number(prop("latency_p95_ms")) >= Number(prop("latency_p50_ms")));
    assert.equal(Number(prop("tokens_in")), run.summary.tokens.input);
    assert.equal(Number(prop("tokens_out")), run.summary.tokens.output);
    assert.ok(Number(prop("tokens_out")) > 0);
    assert.equal(Number(prop("cost_usd")), run.summary.cost);
    assert.ok(run.summary.cost > 0);
  });
});
