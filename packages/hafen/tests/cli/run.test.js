// What a run sends and checks, end to end against the mock endpoint: streamed replies, sessions, data
// rows, repeats, setup and teardown, the conversation's checks; judges; plugins and what they import;
// choosing what runs, and stopping; endpoints that misbehave; a reply that's slow, stopped or cut off.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { CLI, JSON_PROVIDER, NO_SIGNALS, cli, dirs, mock, project, readJSON, said, suite, useMock } from "./helpers.js";

useMock();

const results = (run) => run.turns.map((t) => (t.results ?? []).map((r) => r.status));

describe("what a run sends and checks", () => {
  it("a streamed reply (SSE) with thinking and a tool call: tool, thinking and sequence checks pass", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: tools
    turns:
      - user: a refund for 4417
        expect:
          - { type: tool.called, tool: lookup_order, args: { $.order_id: 4417 } }
          - { type: tool.not_called, tool: delete_account }
          - { on: thinking, type: present }
          - { on: thinking, contains: "look the order up" }
          - { type: sequence, value: [thinking, tool_call, text] }
          - { contains: "4417" }
          - { type: tokens, max_tokens: 100 }
`, "provider: providers/sse.yml\nvariables: { scenario: tools }"),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json", "--verbose"]);
    assert.equal(r.code, 0, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.deepEqual(results(run), [["pass", "pass", "pass", "pass", "pass", "pass", "pass"]]);
    assert.equal(run.turns[0].tool_calls[0].name, "lookup_order");
    // --verbose: a line per turn, with its checks
    assert.match(r.stdout, /turn 1 · .* ✓ called lookup_order/);
  });

  it("a session carried between turns (extracted, sent back), and {{variables}} from extractions", async () => {
    const dir = await project({
      "providers/session.yml": `kind: http
url: "{{base_url}}/session"
body: { message: "{{user}}", session_id: "{{session}}" }
history: session
session: { extract: $.session_id }
response: { text: $.reply }
`,
      "s.hafen.yml": suite(`  - name: session
    turns:
      - user: first
        extract: { sid: $.session_id }
        expect: [ { contains: "turn 1" } ]
      - user: "second, in {{sid}}"
        expect: [ { contains: "turn 2" }, { contains: "second, in sess_" } ]
`, "provider: providers/session.yml"),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"]);
    assert.equal(r.code, 0, said(r));
    const sent = mock.log.filter((x) => x.path === "/session");
    assert.equal(sent.length, 2);
    assert.equal(sent[0].body.session_id, "");
    assert.match(sent[1].body.session_id, /^sess_\d+$/);
  });

  it("data rows: a test runs once per row ({{row.col}}, typed), each row reported; a failing row fails the test", async () => {
    const dir = await project({
      "data/orders.csv": "question,order\na refund for 4417,4417\nwhere is my parcel,4417\na refund please,9999\n",
      "s.hafen.yml": suite(`  - name: rows
    data: data/orders.csv
    turns:
      - user: "{{row.question}}"
        expect:
          - { path: $.data.order.id, equals: "{{row.order}}" }
`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json", "--report", "junit:out/junit.xml"]);
    assert.equal(r.code, 1, said(r));
    assert.match(r.stdout, /✗ Flows › rows {3}2\/3 rows {3}2\/3 checks/);
    assert.match(r.stdout, /row 3: a refund please · turn 1/, "the failing row is named, by its first column");
    const run = await readJSON(dir, "out/run.json");
    assert.deepEqual(run.tests[0].instances.map((i) => [i.row, i.status]), [[1, "passed"], [2, "passed"], [3, "failed"]]);
    assert.deepEqual(mock.log.map((x) => x.body.message), ["a refund for 4417", "where is my parcel", "a refund please"]);
    const junit = await readFile(join(dir, "out/junit.xml"), "utf8");
    // A testcase for each row, named by its first column: rows 1 and 2 passed, row 3 failed, and why
    assert.match(junit, /<testsuite [^>]*tests="3" failures="1" errors="0" skipped="0"/);
    assert.match(junit, /<testcase [^>]*name="rows \[row 1: a refund for 4417\]"[^>]*>\s*<system-out>[^<]*<\/system-out>\s*<\/testcase>/);
    assert.match(junit, /<testcase [^>]*name="rows \[row 3: a refund please\]"[^>]*>\s*<failure [^>]*>row 3: a refund please · turn 1 · \$\.data\.order\.id = \{\{row\.order\}\}: 4417 ≠ 9999/);
    assert.deepEqual(run.tests[0].instances.map((i) => i.row_name), ["a refund for 4417", "where is my parcel", "a refund please"]);
    // A data file in JSON lines, and a limit
    await writeFile(join(dir, "data/orders.jsonl"), '{"question":"a refund for 4417","order":4417}\n{"question":"hi","order":4417}\n{"question":"x","order":1}\n');
    await writeFile(join(dir, "s.hafen.yml"), suite(`  - name: rows
    data: { file: data/orders.jsonl, limit: 2 }
    turns:
      - user: "{{row.question}}"
        expect: [ { path: $.data.order.id, equals: "{{row.order}}" } ]
`).replaceAll("MOCK_URL", mock.url));
    const lines = await cli(dir, ["run", "s.hafen.yml", "--report", "junit:out/lines.xml"]);
    assert.equal(lines.code, 0, said(lines));
    assert.match(lines.stdout, /2\/2 rows/);
    // (a JSON line's row named by its first key)
    assert.deepEqual([...(await readFile(join(dir, "out/lines.xml"), "utf8")).matchAll(/<testcase [^>]*name="([^"]*)"/g)].map((m) => m[1]), ["rows [row 1: a refund for 4417]", "rows [row 2: hi]"]);
  });

  it("repeat and pass_rate: a flaky reply passes at its rate; --repeat overrides the file's", async () => {
    const dir = await project({
      "providers/flaky.yml": `kind: http\nurl: "{{base_url}}/flaky?rate=0.5"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
      "s.hafen.yml": suite(`  - name: flaky
    repeat: 4
    pass_rate: 0.25
    turns:
      - user: a refund for 4417
        expect: [ { contains: "refund" } ]
`, "provider: providers/flaky.yml"),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"]);
    assert.equal(r.code, 0, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.tests[0].total, 4);
    assert.ok(run.tests[0].passed >= 1 && run.tests[0].passed < 4, `${run.tests[0].passed}/4 passed`);
    const once = await cli(dir, ["run", "s.hafen.yml", "--repeat", "2", "--report", "run:out/two.json"]);
    assert.equal((await readJSON(dir, "out/two.json")).tests[0].total, 2, said(once));
  });

  it("setup and teardown steps: extracted values reach the turns; a failing setup errors the test, teardown still runs", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: logged in
    setup:
      - name: log in
        request: { url: "{{base_url}}/login", method: POST, body: { user: qa } }
        extract: { token: $.access_token }
        expect: [ { type: status, equals: 200 } ]
    teardown:
      - name: log out
        request: { url: "{{base_url}}/json", method: POST, body: { message: "log out {{token}}" } }
    turns:
      - user: "token {{token}}"
        expect: [ { contains: "token " } ]
  - name: setup fails
    setup:
      - name: broken
        request: { url: "{{base_url}}/error/500", method: POST }
        expect: [ { type: status, equals: 200 } ]
    teardown:
      - name: clean up
        request: { url: "{{base_url}}/json", method: POST, body: { message: "cleaned up" } }
    turns:
      - user: never sent
`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json", "--report", "junit:out/junit.xml"]);
    assert.equal(r.code, 1, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.tests[0].status, "passed");
    assert.equal(run.tests[1].status, "error");
    const messages = mock.log.map((x) => x.body?.message).filter(Boolean);
    assert.ok(messages.some((m) => /^token \S+/.test(m) && !m.includes("{{")), messages.join(" | "));
    assert.ok(messages.some((m) => m.startsWith("log out ")), "teardown ran");
    assert.ok(messages.includes("cleaned up"), "teardown ran after the failed setup");
    assert.ok(!messages.includes("never sent"));
    assert.match(r.stdout, /setup "broken" failed/);
    assert.match(await readFile(join(dir, "out/junit.xml"), "utf8"), /<testcase [^>]*name="setup fails"[^>]*>\s*<error/);
  });

  it("suite setup runs once before the tests, its values reaching every test", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: a
    turns: [ { user: "a {{token}}", expect: [ { contains: "a " } ] } ]
  - name: b
    turns: [ { user: "b {{token}}", expect: [ { contains: "b " } ] } ]
`, `provider: providers/json.yml
setup:
  - name: log in
    request: { url: "{{base_url}}/login", method: POST }
    extract: { token: $.access_token }`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml"]);
    assert.equal(r.code, 0, said(r));
    assert.equal(mock.log.filter((x) => x.path === "/login").length, 1);
    const sent = mock.log.filter((x) => x.path === "/json").map((x) => x.body.message);
    const token = sent[0].split(" ")[1];
    assert.ok(token && !token.includes("{{"));
    assert.deepEqual(sent.sort(), [`a ${token}`, `b ${token}`]);
  });

  it("a suite's setup that fails: exit 2 naming the step, its tests not sent, the reports written; --env that names nothing: exit 2", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: a
    turns: [ { user: never sent } ]
`, `provider: providers/json.yml
setup:
  - name: log in
    request: { url: "{{base_url}}/error/500", method: POST }
    expect: [ { type: status, equals: 200 } ]`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json", "--report", "junit:out/junit.xml"]);
    assert.equal(r.code, 2, said(r));
    assert.match(r.stderr, /setup step "log in" failed/);
    assert.ok(!mock.log.some((x) => x.body?.message === "never sent"));
    assert.equal((await readJSON(dir, "out/run.json")).status, "error");
    await readFile(join(dir, "out/junit.xml"), "utf8");
    const env = await cli(dir, ["run", "s.hafen.yml", "--env", "nowhere"]);
    assert.equal(env.code, 2, said(env));
    assert.match(env.stderr, /there's no environment or scope "nowhere" \(local\)/);
  });

  it("on_fail: stop skips the turns after a failed one; continue (the default) runs them", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: stops
    on_fail: stop
    turns:
      - { user: one, expect: [ { contains: "nope" } ] }
      - { user: two, expect: [ { contains: "two" } ] }
  - name: carries on
    turns:
      - { user: one, expect: [ { contains: "nope" } ] }
      - { user: two, expect: [ { contains: "two" } ] }
`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"]);
    assert.equal(r.code, 1, said(r));
    const run = await readJSON(dir, "out/run.json");
    const byTest = run.tests.map((t) => t.instances[0].turns.map((g) => run.turns[g].results.map((x) => x.status)));
    assert.deepEqual(byTest, [[["fail"], ["skipped"]], [["fail"], ["pass"]]]);
    assert.equal(mock.log.length, 3);
  });

  it("expect_conversation checks the whole conversation after the last turn (its input by default), a judge seeing all of it", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: whole
    turns:
      - { user: a refund for 4417 }
      - { user: second message }
    expect_conversation:
      - { path: "$[*].reply", contains: "You said: second message" }
      - { path: "$[0].reply", contains: "why" }
      - { path: "$[*].user", contains: "never said" }
      - { contains: "never said", enabled: false }
      - { type: systemone.noul, question: "Did the assistant ask why?", min: 0.8 }
`, `provider: providers/json.yml
judges:
  default: { kind: systemone, endpoint: "{{base_url}}/systemone" }`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json", "--report", "junit:out/junit.xml"]);
    assert.equal(r.code, 1, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.deepEqual(run.tests[0].instances[0].conversation_results.map((x) => x.status), ["pass", "pass", "fail", "skipped", "pass"]);
    // The judge was given every turn: the first reply (which asks why) as well as the last
    const asked = mock.log.find((x) => x.path === "/systemone/v1/systemone").body.state;
    assert.match(asked, /Could you tell me why/);
    assert.match(asked, /You said: second message/);
    // Named in the output and the report
    assert.match(r.stdout, /conversation · \$\[\*\]\.user contains never said/);
    assert.match(await readFile(join(dir, "out/junit.xml"), "utf8"), /<failure [^>]*never said/);
  });

  it("a check turned off (enabled: false) is skipped and not counted; the test passes", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: off
    turns:
      - user: hi
        expect:
          - { contains: "You said" }
          - { contains: "nowhere in the reply", enabled: false }
`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"]);
    assert.equal(r.code, 0, said(r));
    assert.match(r.stdout, /1\/1 checks/);
    const run = await readJSON(dir, "out/run.json");
    assert.deepEqual(results(run), [["pass", "skipped"]]);
  });

  it("pinned history: earlier turns are given the file's reply, not the live one", async () => {
    const dir = await project({
      "providers/msgs.yml": `kind: http
url: "{{base_url}}/json"
body: { messages: "{{messages}}" }
history: messages
response: { text: $.data.reply }
`,
      "s.hafen.yml": suite(`  - name: pinned
    history: pinned
    turns:
      - { user: first, reply: "A PINNED REPLY" }
      - { user: second, expect: [ { contains: "second" } ] }
`, "provider: providers/msgs.yml"),
    });
    const r = await cli(dir, ["run", "s.hafen.yml"]);
    assert.equal(r.code, 0, said(r));
    const last = mock.log.at(-1).body.messages;
    assert.ok(JSON.stringify(last).includes("A PINNED REPLY"), JSON.stringify(last));
    assert.ok(!JSON.stringify(last).includes("You said: first"));
  });
});

describe("judges", () => {
  const judges = `provider: providers/json.yml
judges:
  default: { kind: systemone, endpoint: "{{base_url}}/systemone" }
  rubric: { kind: llm, provider: judge, samples: 3 }
providers:
  judge: { kind: openai-chat, base_url: "{{base_url}}/judge", model: mock-judge, api_key: "" }`;

  it("System One (one request per turn, the key from JEV_API_KEY, never written) and an LLM judge", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: judged
    turns:
      - user: a refund for 4417
        expect:
          - { type: systemone.noul, question: "Does the reply ask why?", min: 0.8 }
          - { type: systemone.choice, question: "What does it offer?", options: [refund, replacement], equals: refund }
          - { type: judge, judge: rubric, rubric: ["Mentions the order number"] }
          - { type: judge, judge: rubric, rubric: ["NOT-MET: offers a discount"] }
`, judges),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"]);
    assert.equal(r.code, 1, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.deepEqual(results(run), [["pass", "pass", "pass", "fail"]]);
    assert.equal(mock.log.filter((x) => x.path === "/systemone/v1/systemone").length, 1);
    assert.equal(mock.log.find((x) => x.path === "/systemone/v1/systemone").headers.authorization, "Bearer jev-secret-key-1");
    const text = await readFile(join(dir, "out/run.json"), "utf8");
    assert.ok(!text.includes("jev-secret-key-1"));
    // The judge call's request is kept (its key hidden)
    const call = run.spans.find((s) => s.kind === "judge_call" && s.request);
    assert.equal(call.request.headers.authorization, "[redacted]");
  });

  it("System One's key missing: exit 2 before anything is sent", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: judged
    turns:
      - user: hi
        expect: [ { type: systemone.noul, question: "Is it kind?", min: 0.5 } ]
`, judges),
    });
    const r = await cli(dir, ["run", "s.hafen.yml"], { env: { JEV_API_KEY: "" } });
    assert.equal(r.code, 2, said(r));
    assert.match(r.stderr, /JEV_API_KEY/);
    assert.equal(mock.log.length, 0);
  });

  it("unsure: fail (the default) fails, saying why and how to let it pass; warn passes with a warning line; pass passes quietly; the file's policy is overridden", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: unsure
    turns:
      - user: a refund for 4417
        expect: [ { type: systemone.noul, question: "UNSURE: is it polite?", min: 0.5 } ]
`, judges),
    });
    const fail = await cli(dir, ["run", "s.hafen.yml"]);
    assert.equal(fail.code, 1, said(fail));
    assert.match(fail.stdout, /✗ Flows › unsure .*\n {4}turn 1 · noul 0\.55: unsure: 0\.55 within 0\.5–1, but confidence 0\.1 is below 0\.6 \(unsure counts as failed; --unsure warn to let it pass\)\n/);
    assert.match(fail.stdout, /1 failed · 0 unsure/);
    const warn = await cli(dir, ["run", "s.hafen.yml", "--unsure", "warn"]);
    assert.equal(warn.code, 0, said(warn));
    assert.match(warn.stdout, /! Flows › unsure .*\n {4}unsure: noul 0\.55: 0\.55 within 0\.5–1, but confidence 0\.1 is below 0\.6 \(counted as passed: unsure is warn\)\n/);
    assert.match(warn.stdout, /1 unsure/);
    const failed = await cli(dir, ["run", "s.hafen.yml", "--unsure", "fail"]);
    assert.equal(failed.code, 1, said(failed));
    const pass = await cli(dir, ["run", "s.hafen.yml", "--unsure", "pass"]);
    assert.equal(pass.code, 0, said(pass));
    assert.match(pass.stdout, /✓ Flows › unsure /);
    assert.doesNotMatch(pass.stdout, /unsure:/);
    const bad = await cli(dir, ["run", "s.hafen.yml", "--unsure", "maybe"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--unsure takes pass, warn or fail/);
  });

  it("a judge that's unreachable is an error (exit 1, listed as an error, not a failure)", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: judged
    turns:
      - user: hi
        expect: [ { type: systemone.noul, question: "Is it kind?", min: 0.5 } ]
`, judges.replace('endpoint: "{{base_url}}/systemone"', 'endpoint: "http://127.0.0.1:9/systemone"')),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "junit:out/junit.xml"]);
    assert.equal(r.code, 1, said(r));
    const junit = await readFile(join(dir, "out/junit.xml"), "utf8");
    assert.match(junit, /<error /);
    assert.doesNotMatch(junit, /<failure /);
  });
});

describe("plugins", () => {
  const PROVIDER_PLUGIN = `export default {
  kind: "provider", name: "acme", version: "1.4.0", hosts: ["127.0.0.1"],
  async *send({ message, history, settings, transport, signal }) {
    const res = await transport.fetch({ url: settings.url, method: "POST", headers: { authorization: "Bearer {{secret.ACME_KEY}}" }, body: { message }, signal });
    const data = await res.json();
    yield { type: "text", text: data.data.reply };
    yield { type: "usage", input: 3, output: 5 };
    yield { type: "done" };
  },
};
`;
  const CHECK_PLUGIN = `export default {
  kind: "check", name: "polite", version: "1.0.0",
  async check({ value }) {
    const rude = /\\b(stupid|idiot)\\b/i.test(String(value));
    return { status: rude ? "fail" : "pass", reason: rude ? "found an insult" : "no insults" };
  },
};
`;
  const JUDGE_PLUGIN = `export default {
  kind: "judge", name: "house", version: "2.1.0",
  async judge({ input }) { return { value: input.includes("4417") ? 0.9 : 0.1, confidence: 0.8, reason: "looked" }; },
};
`;

  it("a provider, a check and a judge plugin run from the command line, the secret filled in by the engine", async () => {
    const dir = await project({
      "plugins/acme.js": PROVIDER_PLUGIN,
      "plugins/polite.js": CHECK_PLUGIN,
      "plugins/house.js": JUDGE_PLUGIN,
      "s.hafen.yml": suite(`  - name: plugged
    turns:
      - user: a refund for 4417
        expect:
          - { type: polite }
          - { type: judge, judge: mine, rubric: "mentions the order", min: 0.5 }
`, `provider: { kind: "plugin:acme@^1", url: "{{base_url}}/json" }
plugins: [ ./plugins/acme.js, ./plugins/polite.js, ./plugins/house.js ]
judges:
  mine: { kind: plugin, plugin: house }`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"], { env: { ACME_KEY: "acme-secret-1" } });
    assert.equal(r.code, 0, said(r));
    assert.equal(mock.log[0].headers.authorization, "Bearer acme-secret-1");
    const text = await readFile(join(dir, "out/run.json"), "utf8");
    assert.ok(!text.includes("acme-secret-1"));
    assert.deepEqual(results(JSON.parse(text)), [["pass", "pass"]]);
  });

  it("a plugin that's missing, or doesn't load, is a setup error (exit 2), nothing sent", async () => {
    const dir = await project({
      "plugins/bad.js": "export default { kind: 'check', name: 'bad', version: '1.0.0', check: 42 ",
      "missing.hafen.yml": suite(`  - name: x
    turns: [ { user: hi } ]
`, "provider: providers/json.yml\nplugins: [ ./plugins/nowhere.js ]"),
      "bad.hafen.yml": suite(`  - name: x
    turns: [ { user: hi } ]
`, "provider: providers/json.yml\nplugins: [ ./plugins/bad.js ]"),
    });
    for (const file of ["missing.hafen.yml", "bad.hafen.yml"]) {
      const r = await cli(dir, ["run", file]);
      assert.equal(r.code, 2, `${file}: ${said(r)}`);
    }
    assert.equal(mock.log.length, 0);
  });
});

describe("plugins' imports", () => {
  it("a plugin imports any file (in the project, outside it), a package and JSON: loaded from its file", async () => {
    const dir = await project({
      "project/plugins/polite.js": `import { words } from "../lib/words.js";
import { lower } from "../../shared/text.js";
import { count } from "fake-counter";
import extra from "./extra.json" with { type: "json" };
export default {
  kind: "check",
  name: "polite",
  version: "1.0.0",
  async check({ value }) {
    const text = lower(value);
    const found = [...words, ...extra.words].filter((w) => text.includes(w));
    return { status: found.length ? "pass" : "fail", reason: \`found \${count(found)}: \${found.join(", ")}\` };
  },
};
`,
      "project/plugins/extra.json": `{ "words": ["said"] }`,
      "project/lib/words.js": `export const words = ["please", "sorry"];\n`,
      "shared/text.js": `export const lower = (s) => String(s).toLowerCase();\n`,
      "project/node_modules/fake-counter/package.json": `{ "name": "fake-counter", "type": "module", "exports": "./index.js" }`,
      "project/node_modules/fake-counter/index.js": `export const count = (list) => list.length;\n`,
      "project/providers/json.yml": JSON_PROVIDER,
      "project/s.hafen.yml": `version: 1
provider: providers/json.yml
environments:
  local: { base_url: "MOCK_URL" }
tests:
  - name: polite
    turns: [ { user: hello, expect: [ { type: polite } ] } ]
`,
    });
    const r = await cli(join(dir, "project"), ["run", "s.hafen.yml", "--report", "run:out/run.json"]);
    assert.equal(r.code, 0, said(r));
    const run = await readJSON(join(dir, "project"), "out/run.json");
    assert.equal(run.turns[0].results[0].reason, "found 1: said");
  });
});

describe("choosing what runs, and stopping", () => {
  const three = suite(`  - name: refund one
    tags: [smoke]
    turns: [ { user: a refund, expect: [ { contains: "refund" } ] } ]
  - name: refund two
    tags: [slow]
    turns: [ { user: another refund, expect: [ { contains: "nope" } ] } ]
  - name: greeting
    tags: [smoke]
    turns: [ { user: hello, expect: [ { contains: "hello" } ] } ]
`);

  it("--test (by part of the name, any case) and --tag (any of them); none matching exits 2", async () => {
    const dir = await project({ "s.hafen.yml": three });
    const byName = await cli(dir, ["run", "s.hafen.yml", "--test", "REFUND ONE", "--report", "run:out/a.json"]);
    assert.equal(byName.code, 0, said(byName));
    assert.deepEqual((await readJSON(dir, "out/a.json")).tests.filter((t) => t.status !== "skipped").map((t) => t.name), ["refund one"]);
    const byTag = await cli(dir, ["run", "s.hafen.yml", "--tag", "smoke", "--report", "run:out/b.json"]);
    assert.equal(byTag.code, 0, said(byTag));
    assert.deepEqual((await readJSON(dir, "out/b.json")).tests.map((t) => t.name).sort(), ["greeting", "refund one"]);
    const both = await cli(dir, ["run", "s.hafen.yml", "--tag", "smoke", "--tag", "slow", "--test", "refund"]);
    assert.equal(both.code, 1, said(both));
    const none = await cli(dir, ["run", "s.hafen.yml", "--tag", "nope"]);
    assert.equal(none.code, 2, said(none));
    assert.match(none.stderr, /none match --test \/ --tag/);
  });

  it("--bail stops at the first failed test (exit 3), the reports written for what ran", async () => {
    const dir = await project({ "s.hafen.yml": three });
    const r = await cli(dir, ["run", "s.hafen.yml", "--bail", "--report", "run:out/run.json", "--report", "junit:out/junit.xml"]);
    assert.equal(r.code, 3, said(r));
    assert.match(r.stdout, /stopped: /);
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.status, "stopped");
    assert.deepEqual(run.tests.map((t) => [t.name, t.status]).slice(0, 2), [["refund one", "passed"], ["refund two", "failed"]]);
    assert.ok(!mock.log.some((x) => x.body?.message === "hello"), "the test after it never ran");
    assert.match(await readFile(join(dir, "out/junit.xml"), "utf8"), /<testcase [^>]*name="greeting"[^>]*>\s*<skipped/);
  });

  it("--timeout: a turn slower than it is an error (exit 1); a bad value exits 2", async () => {
    const dir = await project({
      "providers/slow.yml": `kind: http\nurl: "{{base_url}}/slow?ms=1500"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\nretries: 0\n`,
      "s.hafen.yml": suite(`  - name: slow
    retries: 0
    turns: [ { user: hi, expect: [ { contains: "You said" } ] } ]
`, "provider: providers/slow.yml"),
    });
    const started = Date.now();
    const r = await cli(dir, ["run", "s.hafen.yml", "--timeout", "300", "--report", "run:out/run.json"]);
    assert.equal(r.code, 1, said(r));
    assert.ok(Date.now() - started < 5000);
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.tests[0].status, "error");
    assert.match(run.turns[0].error, /time|300/i);
    const bad = await cli(dir, ["run", "s.hafen.yml", "--timeout", "5s"]);
    assert.equal(bad.code, 2);
  });

  it("SIGINT stops the run as SIGTERM does: exit 3, the run file written with what ran", { skip: NO_SIGNALS }, async () => {
    const dir = await project({
      "providers/slow.yml": `kind: http\nurl: "{{base_url}}/slow?ms=400"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
      "s.hafen.yml": suite(`  - name: slow
    repeat: 20
    turns: [ { user: hi } ]
`, "provider: providers/slow.yml"),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json", "--report", "junit:out/junit.xml"], { signalAfterMs: 1500, signal: "SIGINT" });
    assert.equal(r.code, 3, said(r));
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.status, "stopped");
    assert.ok(run.tests[0].total >= 1 && run.tests[0].total < 20, String(run.tests[0].total));
    assert.ok(run.spans.every((s) => s.end !== undefined), "every span ended");
    await readFile(join(dir, "out/junit.xml"), "utf8");
  });
});

describe("choosing what runs", () => {
  const suite = (tests, head = "provider: providers/json.yml") => `version: 1
name: Cover
${head}
environments:
  local: { base_url: "MOCK_URL" }
tests:
${tests}`;

  async function project(files, { withJson = true } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "hafen-cli-"));
    dirs.push(dir);
    const all = { ...(withJson ? { "providers/json.yml": JSON_PROVIDER } : {}), ...files };
    for (const [path, text] of Object.entries(all)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text.replaceAll("MOCK_URL", mock.url));
    }
    return dir;
  }

  // A node process: the command line (or a pack, or another copy of hafen) in `dir`
  function node(dir, args, { env = {}, signalAfterMs, clean = false } = {}) {
    return new Promise((resolve) => {
      const base = clean ? { PATH: process.env.PATH } : process.env;
      const child = spawn(process.execPath, args, { cwd: dir, env: { ...base, NO_COLOR: "1", MOCK_TOKEN: "tok-secret-9876", GITHUB_STEP_SUMMARY: "", ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      if (signalAfterMs) setTimeout(() => child.kill("SIGTERM"), signalAfterMs);
      child.on("close", (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
    });
  }
  const cli = (dir, args, opts) => node(dir, [CLI, ...args], opts);

  it("a folder search leaves out .git and release too (as node_modules, .hafen and dist)", async () => {
    const one = suite("  - name: one\n    turns: [ { user: hi, expect: [ { contains: \"You said\" } ] } ]\n");
    const dir = await project({
      "a.hafen.yml": one.replace("name: Cover", "name: A"),
      ".git/x.hafen.yml": one.replace("name: Cover", "name: GIT"),
      "release/y.hafen.yml": one.replace("name: Cover", "name: RELEASE"),
      "sub/release-notes.hafen.yml": one.replace("name: Cover", "name: NOTES").replace("providers/json.yml", "../providers/json.yml"),
    });
    const r = await cli(dir, ["run", "--report", "run:out/run.json"]);
    assert.equal(r.code, 0, said(r));
    assert.deepEqual((await readJSON(dir, "out/run.json")).suites.map((s) => s.file), ["a.hafen.yml", "sub/release-notes.hafen.yml"]);
  });

  it("--test given more than once: tests whose name contains any of them", async () => {
    const dir = await project({ "s.hafen.yml": suite(["alpha", "beta", "gamma"].map((n) => `  - name: ${n}\n    turns: [ { user: ${n} } ]\n`).join("")) });
    const r = await cli(dir, ["run", "--test", "alp", "--test", "GAMMA", "--report", "run:out/run.json"]);
    assert.equal(r.code, 0, said(r));
    assert.deepEqual(mock.log.map((x) => x.body.message), ["alpha", "gamma"]);
    assert.deepEqual((await readJSON(dir, "out/run.json")).tests.map((t) => [t.name, t.status]), [["alpha", "passed"], ["gamma", "passed"]]);
  });
});

describe("endpoints that misbehave", () => {
  it("an endpoint that's down, a 500, a reply cut mid-stream: errors (exit 1), each said plainly", async () => {
    const dir = await project({
      "providers/down.yml": `kind: http\nurl: "http://127.0.0.1:9/chat"\nbody: { message: "{{user}}" }\nresponse: { text: $.reply }\n`,
      "providers/500.yml": `kind: http\nurl: "{{base_url}}/error/500"\nbody: { message: "{{user}}" }\nresponse: { text: $.reply }\n`,
      "s.hafen.yml": suite(`  - name: down
    provider: providers/down.yml
    retries: 0
    turns: [ { user: hi, expect: [ { contains: "x" } ] } ]
  - name: server error
    provider: providers/500.yml
    retries: 0
    turns: [ { user: hi, expect: [ { type: status, equals: 200 } ] } ]
  - name: cut
    provider: providers/sse.yml
    retries: 0
    turns: [ { user: hi, expect: [ { contains: "x" } ] } ]
`, "provider: providers/json.yml\nvariables: { scenario: cut }"),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json", "--report", "junit:out/junit.xml"]);
    assert.equal(r.code, 1, said(r));
    const run = await readJSON(dir, "out/run.json");
    const status = Object.fromEntries(run.tests.map((t) => [t.name, t.status]));
    assert.equal(status.down, "error");
    assert.equal(status.cut, "error");
    assert.ok(["error", "failed"].includes(status["server error"]), status["server error"]);
    assert.match(r.stdout, /✗ Flows › down/);
    assert.ok(!/TypeError|at .*\.js:\d+/.test(r.all), "no stack traces");
  });

  it("a rate limit (429) is retried, and the turn passes", async () => {
    const dir = await project({
      "providers/rl.yml": `kind: http\nurl: "{{base_url}}/ratelimit"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`,
      "s.hafen.yml": suite(`  - name: limited
    turns: [ { user: a refund, expect: [ { contains: "refund" } ] } ]
`, "provider: providers/rl.yml"),
    });
    const r = await cli(dir, ["run", "s.hafen.yml"]);
    assert.equal(r.code, 0, said(r));
    assert.equal(mock.log.filter((x) => x.path === "/ratelimit").length, 2);
  });
});

describe("a reply that's slow, fails, is stopped or is cut off", () => {
  // A folder with these files (paths to text, MOCK_URL the mock's address); the command runs in `at`
  async function project(files, at = "") {
    const root = await mkdtemp(join(tmpdir(), "hafen-cli-"));
    dirs.push(root);
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text.replaceAll("MOCK_URL", mock.url));
    }
    return join(root, at);
  }

  function cli(dir, args, { env = {}, signalAfterMs } = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "", ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      if (signalAfterMs) setTimeout(() => child.kill("SIGTERM"), signalAfterMs);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  // A JSON provider on one of the mock's paths, with more of its keys
  const provider = (path, more = "") => `kind: http
url: "MOCK_URL${path}"
body: { message: "{{user}}" }
response: { text: $.data.reply }
${more}`;
  const suite = ({ head = "", test = "", expect = "[ { contains: \"You said\" } ]" } = {}) => `version: 1
provider: providers/p.yml
${head}
tests:
  - name: t
${test}    turns: [ { user: "hi", expect: ${expect} } ]
`;

  describe("a provider's timeout_ms and retries", () => {
    it("timeout_ms: 300 on a reply that takes 1.5 s: an error after 300 ms, said so; the suite's defaults win over it", async () => {
      const dir = await project({ "providers/p.yml": provider("/slow?ms=1500", "timeout_ms: 300\nretries: 0\n"), "s.hafen.yml": suite(), "d.hafen.yml": suite({ head: "defaults: { timeout_ms: 5000 }" }) });
      const started = Date.now();
      const r = await cli(dir, ["run", "s.hafen.yml"]);
      assert.equal(r.code, 1, said(r));
      assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
      assert.match(r.stdout, /turn 1 · error: timed out after 300 ms/);
      const d = await cli(dir, ["run", "d.hafen.yml"]);
      assert.equal(d.code, 0, said(d));
    });

    it("retries: 0 on a 500: one request", async () => {
      const dir = await project({ "providers/p.yml": provider("/error/500", "retries: 0\n"), "s.hafen.yml": suite() });
      const r = await cli(dir, ["run", "s.hafen.yml"]);
      assert.equal(r.code, 1, said(r));
      assert.equal(mock.log.filter((x) => x.path === "/error/500").length, 1);
    });
  });

  describe("a turn the stop cut short", () => {
    it("has its latency and status checks skipped too (the run was stopped), exit 3", { skip: NO_SIGNALS }, async () => {
      const dir = await project({ "providers/p.yml": provider("/slow?ms=4000"), "s.hafen.yml": suite({ expect: "[ { type: latency, max_ms: 5000 }, { type: status, equals: 200 }, { contains: \"You said\" } ]" }) });
      const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"], { signalAfterMs: 1000 });
      assert.equal(r.code, 3, said(r));
      const run = await readJSON(dir, "out/run.json");
      assert.deepEqual(run.turns[0].results.map((x) => [x.status, x.reason]), [["skipped", "the run was stopped"], ["skipped", "the run was stopped"], ["skipped", "the run was stopped"]]);
      assert.equal(run.summary.checks.passed, 0);
    });
  });

  describe("a stream cut off mid-reply", () => {
    it("says the response ended early, after how many chunks, and keeps the reply so far", async () => {
      const dir = await project({ "providers/p.yml": `kind: http\nurl: "MOCK_URL/cut"\nbody: { message: "{{user}}" }\nstream: sse\ndone_marker: "[DONE]"\nevents:\n  - when: { $.type: text_delta }\n    text: $.delta\n`, "s.hafen.yml": suite() });
      const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json"]);
      assert.equal(r.code, 1, said(r));
      // (how many chunks the reader saw depends on how the network grouped the mock's writes: 1 or 2)
      assert.match(r.stdout, /turn 1 · error: the response ended early: the connection closed after [12] chunks? \(the reply so far is kept\)/);
      assert.equal((await readJSON(dir, "out/run.json")).turns[0].reply, "This reply is going ");
    });
  });
});
