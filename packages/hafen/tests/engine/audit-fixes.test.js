// What a review of the engine found, each fixed, each held here: a secret never sent on in text an
// endpoint returned; files read only in the opened folder; a suite written wrong can't stop the folder
// opening; a turned-off System One check needs no key; JUnit says a test errored; "this turn only"
// counts only what ran; edits in place (an emptied list, a key with no value, a message of several
// lines, a # in a string, Windows line endings, a byte order mark); a provider renamed all or nothing;
// "save as test" keeps {{env.…}} and {{secret.…}}; the HTTP log hides secrets; a conversation's environment as a
// run's. (The relay's allowlist, and the app's times, are the app's: tests/app/ in Hafen's repository.)

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { parse } from "yaml";
import { nodeHost } from "../../cli/node-host.js";
import { conversationToTest, createConversation } from "../../engine/explore.js";
import { editText, loadSuite, problemsFor, secretsNeeded } from "../../engine/files/suite-file.js";
import { junit } from "../../engine/reports/junit.js";
import { runSuites } from "../../engine/runner.js";
import { servePort } from "../../engine/serve-port.js";
import { createScope } from "../../engine/vars.js";
import { fakeTransport, memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
after(() => mock.close());
beforeEach(() => mock.reset());

const PROVIDER = "kind: http\nurl: http://endpoint.example/chat\nbody: { message: \"{{user}}\" }\nresponse:\n  text: $.data.reply\n";
const JSON_PROVIDER = `kind: http
url: "{{base_url}}/json"
body: { message: "{{user}}" }
response:
  text: $.data.reply
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
price: { input: 1, output: 2 }
`;

// The engine behind a port, as the app has it: call(cmd, args), and the log lines it sends
function connect(host) {
  let handler;
  const waiting = new Map();
  const logs = [];
  let next = 1;
  servePort({ receive: (h) => { handler = h; }, send: (m) => { if (m.log) logs.push(m.log); waiting.get(m.id)?.(m); } }, async () => host);
  const call = (cmd, args) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, (m) => (m.ok ? resolve(m.value) : reject(new Error(m.error))));
    handler({ id, cmd, args });
  });
  return { call, logs };
}

describe("{{secret.…}} is filled in only in text a file wrote", () => {
  it("not in a value an endpoint returned (an extraction): the secret isn't sent back", async () => {
    const transport = fakeTransport((req, n) => ({ body: JSON.stringify({ data: { reply: n === 1 ? "Your code is {{secret.CI_TOKEN}}" : "ok" } }) }));
    const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: t\n    turns:\n      - user: give me a code\n        extract: { code: $.data.reply }\n      - user: \"Is this right: {{code}}\"\n", "providers/p.yml": PROVIDER }, { secrets: { CI_TOKEN: "ghp_SECRET123456" }, transport });
    const run = await runSuites({ suites: [await loadSuite(host, "s.hafen.yml")], host, options: {} });
    assert.equal(JSON.parse(transport.requests[1].body).message, "Is this right: Your code is {{secret.CI_TOKEN}}");
    assert.ok(!transport.requests.some((r) => String(r.body).includes("ghp_SECRET123456")));
    assert.equal(run.turns[1].user, "Is this right: Your code is {{secret.CI_TOKEN}}");
  });

  it("in the file's own text, and in its variables (and --var's): those are the file's", () => {
    const vars = { auth: "Bearer {{secret.KEY}}" };
    const cli = { token: "{{secret.KEY}}" };
    const scope = createScope({ layers: [cli, vars], trusted: [cli, vars], secrets: (n) => ({ KEY: "k-123456" })[n] });
    assert.equal(scope.resolve("{{auth}}"), "Bearer k-123456");
    assert.equal(scope.resolve("x {{auth}} y {{secret.KEY}} {{token}}"), "x Bearer k-123456 y k-123456 k-123456");
    // What's added later (an extraction, a data row) isn't the file's
    const later = scope.with({ got: "leak {{secret.KEY}}", row: { q: "{{secret.KEY}}" } });
    assert.equal(later.resolve("{{got}}"), "leak {{secret.KEY}}");
    assert.equal(later.resolve("a {{row.q}} b"), "a {{secret.KEY}} b");
    // A call's own values (the message) neither
    assert.equal(later.resolve("{{user}}", { user: "{{secret.KEY}}" }), "{{secret.KEY}}");
  });
});

describe("files are read only in the opened folder (and the folders a command line names)", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hafen-read-"));
    mkdirSync(join(root, "folder", "data"), { recursive: true });
    mkdirSync(join(root, "outside"), { recursive: true });
    writeFileSync(join(root, "outside", "credentials"), "aws_secret_access_key = SECRET");
    writeFileSync(join(root, "folder", "data", "rows.csv"), "q\nhi\n");
    symlinkSync(join(root, "outside", "credentials"), join(root, "folder", "data", "link.csv"));
  });

  it("refuses a path outside it (absolute, ../, or a link out), and says so", async () => {
    const host = nodeHost({ root: join(root, "folder") });
    assert.equal(await host.files.read("data/rows.csv"), "q\nhi\n");
    for (const p of [join(root, "outside", "credentials"), "../outside/credentials", "data/link.csv"]) {
      await assert.rejects(host.files.read(p), /isn't in the opened folder/, p);
      assert.equal(await host.files.exists(p), false, p);
    }
    assert.equal(host.files.outside("../outside/credentials"), true);
    assert.equal(host.files.outside("data/rows.csv"), false);
    await assert.rejects(host.files.write("../outside/x", "x"), /isn't in the opened folder/);
    assert.deepEqual(await host.list(join(root, "outside")), []);
  });

  it("a suite naming a data file outside it: a problem that says why, nothing read or sent", async () => {
    writeFileSync(join(root, "folder", "s.hafen.yml"), `version: 1\nprovider: p.yml\ntests:\n  - name: t\n    data: ${join(root, "outside", "credentials")}\n    turns: [ { user: "row: {{row}}" } ]\n`);
    writeFileSync(join(root, "folder", "p.yml"), PROVIDER);
    const transport = fakeTransport(() => ({ body: "{}" }));
    const host = nodeHost({ root: join(root, "folder"), transport });
    const suite = await loadSuite(host, "s.hafen.yml");
    assert.ok(suite.errors.some((e) => /isn't in the opened folder/.test(e.message)), JSON.stringify(suite.errors));
    await runSuites({ suites: [suite], host, options: {} });
    assert.equal(transport.requests.length, 0);
  });

  it("a folder the command line names is read too", async () => {
    const host = nodeHost({ root: join(root, "folder"), also: [join(root, "outside")] });
    assert.match(await host.files.read(join(root, "outside", "credentials")), /SECRET/);
    assert.deepEqual(await host.list(join(root, "outside")), ["../outside/credentials"]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("a suite written wrong can't stop the folder opening", () => {
  const P = "kind: http\nurl: http://x\nbody: { m: \"{{user}}\" }\nresponse: { text: $.r }\n";
  const cases = {
    "an empty test": "version: 1\nprovider: providers/p.yml\ntests:\n  -\n",
    "an empty turn": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    turns:\n      -\n",
    "an empty check": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    turns:\n      - user: hi\n        expect:\n          -\n",
    "tests as a map": "version: 1\nprovider: providers/p.yml\ntests:\n  a: 1\n",
    "a turn as text": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    turns: [hi]\n",
    "tags as text": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    tags: smoke\n    turns: [ { user: hi } ]\n",
    "expect as a map": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    turns:\n      - user: hi\n        expect:\n          path: $.x\n",
    "a null judge": "version: 1\nprovider: providers/p.yml\njudges:\n  j: ~\ntests:\n  - name: a\n    turns:\n      - user: hi\n        expect: [ { type: systemone.noul, question: q } ]\n",
  };
  for (const [label, text] of Object.entries(cases)) {
    it(`${label}: loads with its problem, its shape safe to read`, async () => {
      const host = memoryHost({ "bad.hafen.yml": text, "good.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: g\n    turns: [ { user: hi } ]\n", "providers/p.yml": P });
      const suite = await loadSuite(host, "bad.hafen.yml");
      assert.ok(suite.errors.length, "it has a problem");
      for (const t of suite.data.tests ?? []) {
        assert.equal(typeof t, "object");
        assert.ok(Array.isArray(t.turns ?? []));
        for (const u of t.turns ?? []) assert.ok(Array.isArray(u.expect ?? []) && typeof u === "object");
        assert.ok(Array.isArray(t.tags ?? []));
      }
      problemsFor(suite, {}, () => undefined, null);
      secretsNeeded(suite);
      // The folder opens, the other suite with it
      const { call } = connect(host);
      const opened = await call("open", {});
      assert.deepEqual(opened.suites.map((s) => s.file).sort(), ["bad.hafen.yml", "good.hafen.yml"]);
      assert.deepEqual(opened.suites.find((s) => s.file === "good.hafen.yml").errors, []);
    });
  }
});

it("a turned-off System One check needs no key", async () => {
  const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    turns:\n      - user: hi\n        expect:\n          - { type: systemone.noul, question: q, enabled: false }\n", "providers/p.yml": PROVIDER });
  const suite = await loadSuite(host, "s.hafen.yml");
  assert.equal(secretsNeeded(suite).includes("JEV_API_KEY"), false);
  assert.deepEqual(problemsFor(suite, {}, () => undefined), []);
});

describe("reports", () => {
  it("JUnit says a test errored with no check to blame (its setup failed), and its totals are its cases'", async () => {
    const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: needs a session\n    setup:\n      - request: { url: \"http://127.0.0.1:1/nowhere\" }\n    turns: [ { user: hi } ]\n", "providers/p.yml": PROVIDER });
    const run = await runSuites({ suites: [await loadSuite(host, "s.hafen.yml")], host, options: {} });
    assert.equal(run.tests[0].status, "error");
    const xml = junit(run);
    assert.match(xml, /<testcase [^>]*name="needs a session"[^>]*>\s*<error message="[^"]*setup/);
    assert.match(xml, /<testsuites name="Hafen" tests="1" failures="0" errors="1"/);
  });

  it("a data file with no rows: the test errored, and says why", async () => {
    const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: rows\n    data: rows.csv\n    turns: [ { user: \"{{row.q}}\" } ]\n", "rows.csv": "q\n", "providers/p.yml": PROVIDER });
    const run = await runSuites({ suites: [await loadSuite(host, "s.hafen.yml")], host, options: {} });
    assert.equal(run.tests[0].status, "error");
    assert.match(run.tests[0].reason, /no rows/);
    assert.match(junit(run), /<error message="its data file has no rows/);
  });

  it("\"this turn only\" counts only the turn it sent: not the turns carried from the last run", async () => {
    const yaml = "version: 1\nprovider: providers/json.yml\ntests:\n  - name: three\n    id: t_three000\n    turns:\n      - user: first\n        expect: [ { contains: nope } ]\n      - user: second\n        expect: [ { contains: nope } ]\n      - user: third\n        expect: [ { contains: third } ]\n";
    const host = memoryHost({ "s.hafen.yml": yaml, "providers/json.yml": JSON_PROVIDER });
    const suite = await loadSuite(host, "s.hafen.yml");
    const full = await runSuites({ suites: [suite], host, options: { vars: { base_url: mock.url } } });
    assert.equal(full.summary.turns, 3);
    mock.reset();
    const only = await runSuites({ suites: [suite], host, options: { vars: { base_url: mock.url }, onlyTurn: 2, carry: { t_three000: [full.turns[0], full.turns[1]] } } });
    assert.equal(mock.log.length, 1);
    assert.equal(only.summary.turns, 1);
    assert.deepEqual([only.summary.checks.total, only.summary.checks.failed], [1, 0]);
    assert.equal(only.summary.latency.total.n, 1);
    assert.equal((junit(only).match(/<failure/g) ?? []).length, 0);
  });
});

describe("edits in place", () => {
  const changed = (a, b) => { const x = a.split("\n"); return b.split("\n").filter((l, i) => l !== x[i]); };

  it("a list emptied ([], as the last test's delete leaves it) that gets a test again is written as a block", () => {
    let text = "version: 1\nprovider: p.yml\ntests: []\n";
    text = editText(text, "s.hafen.yml", [{ op: "set", path: ["tests"], value: [{ id: "t_1", name: "New test", turns: [{ user: "Hello" }] }] }]);
    text = editText(text, "s.hafen.yml", [{ op: "add", path: ["tests"], value: { id: "t_2", name: "Second", turns: [{ user: "Hi" }] } }]);
    text = editText(text, "s.hafen.yml", [{ op: "add", path: ["tests", 0, "turns"], value: { user: "next" } }]);
    assert.equal(text, "version: 1\nprovider: p.yml\ntests:\n  - id: t_1\n    name: New test\n    turns:\n      - user: Hello\n      - user: next\n  - id: t_2\n    name: Second\n    turns:\n      - user: Hi\n");
    // From `tests: []` and an add, the same
    const added = editText("version: 1\ntests: []   \n", "s.hafen.yml", [{ op: "add", path: ["tests"], value: { name: "a", turns: [{ user: "hi" }] } }]);
    assert.deepEqual(parse(added).tests, [{ name: "a", turns: [{ user: "hi" }] }]);
    assert.ok(!added.includes("[ {"), added);
  });

  it("a key with no value gets one on its line; a message of several lines goes as a block, its comment kept", () => {
    const text = "version: 1   # v\nname:\ntests:\n  - name: a\n    turns:\n      - user: hi   # greet\n      - user:\n";
    assert.deepEqual(changed(text, editText(text, "s.hafen.yml", [{ op: "set", path: ["name"], value: "Smoke" }])), ["name: Smoke"]);
    assert.deepEqual(changed(text, editText(text, "s.hafen.yml", [{ op: "set", path: ["tests", 0, "turns", 1, "user"], value: "x" }])), ["      - user: x"]);
    const multi = editText(text, "s.hafen.yml", [{ op: "set", path: ["tests", 0, "turns", 0, "user"], value: "line one\nline two" }]);
    assert.ok(multi.startsWith("version: 1   # v\nname:\n"), multi);
    assert.ok(multi.includes("      - user: |-   # greet\n          line one\n          line two\n"), multi);
    assert.equal(parse(multi).tests[0].turns[0].user, "line one\nline two");
  });

  it("a # in a one-line check's string isn't a comment: the check is still edited on its line", () => {
    const text = "tests:\n  - name: a\n    tags: [smoke]\n    turns:\n      - user: hi\n        expect:\n          - { contains: \"order #4417\" }\n";
    const out = editText(text, "s.hafen.yml", [{ op: "set", path: ["tests", 0, "turns", 0, "expect", 0, "enabled"], value: false }]);
    assert.deepEqual(changed(text, out), ["          - { contains: \"order #4417\", enabled: false }"]);
  });

  it("keeps Windows line endings, and a JSON file's byte order mark", () => {
    const crlf = "version: 1\r\ntests:\r\n  - name: a   # x\r\n    turns:\r\n      - user: hi\r\n";
    const out = editText(crlf, "s.hafen.yml", [{ op: "add", path: ["tests", 0, "turns"], value: { user: "two" } }, { op: "set", path: ["tests", 0, "name"], value: "b" }]);
    assert.equal(out, "version: 1\r\ntests:\r\n  - name: b   # x\r\n    turns:\r\n      - user: hi\r\n      - user: two\r\n");
    const bom = "﻿{\n  \"version\": 1,\n  \"tests\": []\n}\n";
    const json = editText(bom, "s.hafen.json", [{ op: "set", path: ["name"], value: "x" }]);
    assert.ok(json.startsWith("﻿{"));
    assert.equal(JSON.parse(json.slice(1)).name, "x");
  });
});

it("a provider is renamed all or nothing: one suite it can't be changed in, and nothing's changed", async () => {
  const files = {
    "a.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    turns: [ { user: hi } ]\n",
    "c.hafen.yml": "version: 1\nproviders:\n  main: &p providers/p.yml\nprovider: *p\ntests:\n  - name: c\n    turns: [ { user: hi } ]\n",
    "providers/p.yml": PROVIDER,
  };
  const host = memoryHost({ ...files });
  const { call } = connect(host);
  await call("open", {});
  await assert.rejects(call("rename", { file: "providers/p.yml", to: "providers/q.yml" }), /nothing was renamed/);
  assert.deepEqual(Object.fromEntries(host.store), files);
});

describe("conversations", () => {
  it("\"save as test\" keeps the message as typed ({{env.NAME}}, {{secret.NAME}}), and the turn's start shows it redacted", async () => {
    const transport = fakeTransport(() => ({ body: '{"r":"ok"}' }));
    const host = memoryHost({}, { secrets: { order_token: "tok_live_123456" }, transport });
    const events = [];
    const c = createConversation({ host, providerConfig: { kind: "http", url: "http://e/chat", body: { m: "{{user}}" }, response: { text: "$.r" } }, scopeValues: { name: "stage", values: { customer: "cust-42" } }, onEvent: (e) => events.push(e) });
    c.setScope({ name: "stage", values: { customer: "cust-42" } });
    await c.send("look up {{env.customer}} with {{secret.order_token}}");
    assert.equal(JSON.parse(transport.requests[0].body).m, "look up cust-42 with tok_live_123456");
    assert.equal(events.find((e) => e.type === "turn:start").user, "look up cust-42 with [redacted]");
    assert.equal(conversationToTest(c.run, { name: "t" }).turns[0].user, "look up {{env.customer}} with {{secret.order_token}}");
  });

  it("with a scope the suite has no environment for, a conversation gets none of its variables (as a run)", async () => {
    const transport = fakeTransport(() => ({ body: '{"data":{"reply":"ok"}}' }));
    const host = memoryHost({ "s.hafen.yml": "version: 1\nprovider: providers/p.yml\nenvironments:\n  local: { who: local-one }\ntests:\n  - name: a\n    turns: [ { user: hi } ]\n", "providers/p.yml": "kind: http\nurl: http://e/chat\nbody: { m: \"{{user}}\", who: \"{{who}}\" }\nresponse: { text: $.data.reply }\n" }, { transport });
    const { call } = connect(host);
    await call("open", {});
    // (the turn's error: nothing's sent)
    const stage = await call("send", { token: "c1", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", env: "stage", message: "hi" });
    assert.match(stage.record.error, /\{\{who\}\} isn't set/);
    assert.equal(transport.requests.length, 0);
    await call("send", { token: "c2", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", env: "local", message: "hi" });
    assert.equal(JSON.parse(transport.requests.at(-1).body).who, "local-one");
  });
});

it("the HTTP log the page sees hides a secret wherever it is in the address, and in an error", async () => {
  const host = memoryHost({
    "s.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    retries: 0\n    turns: [ { user: hi } ]\n",
    "providers/p.yml": 'kind: http\nurl: "http://127.0.0.1:1/v1/{{secret.BOT_TOKEN}}/chat?api_key={{secret.API_KEY}}"\nbody: { m: "{{user}}" }\nresponse: { text: $.r }\n',
  }, { secrets: { BOT_TOKEN: "bot-SECRET-123456", API_KEY: "sk-SECRET-987654" } });
  const { call, logs } = connect(host);
  await call("open", {});
  await call("run", { token: "t", files: ["s.hafen.yml"] });
  const http = logs.filter((l) => l.name === "http.request");
  assert.ok(http.length);
  for (const l of http) assert.ok(!JSON.stringify(l).includes("SECRET"), JSON.stringify(l));
  assert.match(http[0].url, /\/v1\/\[redacted\]\/chat/);
});
