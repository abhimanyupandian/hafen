// A fixture's phases, what its run() returns, and env.set (contracts/provider.md, Fixtures):
//   phases: ["beforeAll", "afterAll"]  the lists it can be in (all four when it doesn't say): a provider
//                                      naming it in another is a problem before anything is sent
//   run() → false                      stop: beforeAll stops the run before the provider's tests are
//                                      sent; before stops that test's run (or row); after and afterAll
//                                      change nothing. true, nothing or { NAME: value } go on
//   env.set(NAME, value)               the environment's for the rest of the run (or the conversation,
//                                      until it's let go), never written; {{env.NAME}} after it
// Against the mock: each fixture says what it saw (its phase, its test, its env) to /fixture-log.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { loadPlugins } from "../../engine/plugins.js";
import { runSuites } from "../../engine/runner.js";
import { servePort } from "../../engine/serve-port.js";
import { casesOf, tally } from "../../engine/reports/outcome.js";
import { jsonSummary, junit, markdown } from "../../engine/index.js";
import { memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
after(() => mock.close());
beforeEach(() => mock.reset());

// A fixture that tells the mock what it saw (its phase, the test and its status, the env as it was
// given), then does `body` (its run()'s own lines: what it sets, what it returns)
const fixture = (name, { phases, sets, provides, body = "" } = {}) => `let calls = 0;
export default {
  kind: "fixture",
  name: "${name}",
  version: "1.0.0",
  hosts: ["127.0.0.1"],${phases ? `\n  phases: ${JSON.stringify(phases)},` : ""}${sets ? `\n  sets: ${JSON.stringify(sets)},` : ""}${provides ? `\n  provides: ${JSON.stringify(provides)},` : ""}
  async run({ phase, settings, env, test, signal, transport }) {
    calls += 1;
    const at = test ? " " + test.name + " " + test.repeat + (test.status ? " " + test.status : "") : "";
    await transport.fetch({ url: settings.log_url, method: "POST", body: { said: "${name} " + phase + at, env: { ...env } }, signal });
    ${body}
  },
};
`;
const PROVIDER = (lists, url = "{{env.base_url}}/json") => `kind: http
fixtures: ${lists}
url: "${url}"
log_url: "{{env.base_url}}/fixture-log"
body: { message: "{{user}}" }
response: { text: $.data.reply }
`;
const SUITE = (tests = `  - name: a
    turns: [ { user: hello, expect: [ { contains: "You said: hello" } ] } ]
  - name: b
    turns: [ { user: again, expect: [ { contains: "You said: again" } ] } ]
`, env = "") => `version: 1
name: S
provider: providers/p.yml
environments:
  local: { base_url: "${mock.url}"${env} }
tests:
${tests}`;

async function runWith(files, { options = {}, suites = ["s.hafen.yml"], host = memoryHost(files) } = {}) {
  host.secrets = () => undefined;
  const loaded = [];
  for (const file of suites) loaded.push(await loadSuite(host, file));
  return { run: await runSuites({ suites: loaded, host, options }), host };
}
const fixtureLog = () => mock.log.filter((x) => x.path === "/fixture-log").map((x) => x.body);
const said = () => fixtureLog().map((b) => b.said);
const chats = () => mock.log.filter((x) => x.path === "/json");

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

describe("a fixture's phases", () => {
  it("it runs only in the lists its phases name, with no check of its phase in run(); a provider may list it in each", async () => {
    const { run } = await runWith({
      "plugins/gate.js": fixture("gate", { phases: ["beforeAll", "afterAll"] }),
      "plugins/audit.js": fixture("audit", { phases: ["after"] }),
      "providers/p.yml": PROVIDER("{ beforeAll: [gate], after: [audit], afterAll: [gate] }"),
      "s.hafen.yml": SUITE(),
    });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.equal(run.verdict, "passed");
    assert.deepEqual(said(), ["gate beforeAll", "audit after a 1 passed", "audit after b 1 passed", "gate afterAll"]);
  });

  it("a provider naming it in a list it isn't for: a problem at that name in the provider's file, before anything is sent (a run, validate, a conversation)", async () => {
    const files = {
      "plugins/gate.js": fixture("gate", { phases: ["beforeAll", "afterAll"] }),
      "providers/p.yml": PROVIDER("{ beforeAll: [gate], after: [gate] }"),
      "s.hafen.yml": SUITE(),
    };
    const { run, host } = await runWith(files);
    assert.equal(run.status, "error");
    assert.deepEqual(run.error.all.map((p) => [p.file, p.line, p.column, p.message]), [
      ["providers/p.yml", 2, 40, 'the fixture "gate" runs only in beforeAll and afterAll: it can\'t be in fixtures.after'],
    ]);
    assert.equal(mock.log.length, 0, "nothing was sent");
    const call = connect(async () => host);
    await call("open", {});
    await assert.rejects(call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", message: "hi" }), /the fixture "gate" runs only in beforeAll and afterAll: it can't be in fixtures\.after/);
    assert.equal(mock.log.length, 0);
  });

  it("phases that aren't a list of the four: the plugin doesn't load, saying why", async () => {
    const host = memoryHost({
      "plugins/a.js": fixture("a", { phases: ["beforeEach"] }),
      "plugins/b.js": fixture("b", { phases: [] }),
      "plugins/c.js": fixture("c").replace('hosts: ["127.0.0.1"],', 'hosts: ["127.0.0.1"], phases: "beforeAll",'),
      "plugins/d.js": fixture("d", { phases: ["before", "before", "beforeAll"] }),
    });
    const loaded = await loadPlugins(host, ["plugins/a.js", "plugins/b.js", "plugins/c.js", "plugins/d.js"]);
    assert.deepEqual(loaded.problems.map((p) => p.message), [
      'the plugin plugins/a.js can\'t be loaded: its phases is a list of when it runs: any of beforeAll, before, after, afterAll, and "beforeEach" isn\'t one',
      'the plugin plugins/b.js can\'t be loaded: its phases is a list of when it runs: any of beforeAll, before, after, afterAll (phases: ["beforeAll", "afterAll"])',
      'the plugin plugins/c.js can\'t be loaded: its phases is a list of when it runs: any of beforeAll, before, after, afterAll (phases: ["beforeAll", "afterAll"])',
    ]);
    // (each once, in the lists' order)
    assert.deepEqual(loaded.plugins.d.meta.phases, ["beforeAll", "before"]);
    loaded.close();
  });

  it("the app's lists say each fixture's phases (all four when it doesn't say) and the environment's names it sets", async () => {
    const host = memoryHost({
      "plugins/gate.js": fixture("gate", { phases: ["beforeAll", "afterAll"], body: 'env.set("chat_path", "json");' }),
      "plugins/any.js": fixture("any", { sets: ["region"], body: 'const n = "reg" + "ion"; env.set(n, "eu");' }),
      "plugins/polite.js": 'export default { kind: "check", name: "polite", version: "1.0.0", async check() { return { status: "pass", reason: "" }; } };\n',
      "s.hafen.yml": SUITE(),
      "providers/p.yml": PROVIDER("{ beforeAll: [gate] }"),
    });
    const call = connect(async () => host);
    const opened = await call("open", {});
    assert.deepEqual(opened.plugins.map((p) => [p.name, p.phases, p.sets]), [
      ["any", ["beforeAll", "before", "after", "afterAll"], ["region"]],
      ["gate", ["beforeAll", "afterAll"], ["chat_path"]],
      ["polite", undefined, undefined],
    ]);
    const listed = await call("plugins", {});
    assert.deepEqual(listed.map((p) => [p.meta.name, p.meta.phases, p.meta.sets]), [
      ["any", ["beforeAll", "before", "after", "afterAll"], ["region"]],
      ["gate", ["beforeAll", "afterAll"], ["chat_path"]],
      ["polite", undefined, undefined],
    ]);
  });
});

describe("what a fixture's run() returns", () => {
  it("false in beforeAll: the run stops before the provider's tests are sent, each skipped saying why; the lists after it don't run, afterAll does; the reports say so", async () => {
    const files = {
      "plugins/warm.js": fixture("warm"),
      "plugins/gate.js": fixture("gate", { body: "return false;" }),
      "plugins/later.js": fixture("later"),
      "plugins/logout.js": fixture("logout"),
      "providers/p.yml": PROVIDER("{ beforeAll: [warm, gate, later], before: [later], afterAll: [logout] }"),
      "s.hafen.yml": SUITE(),
      "t.hafen.yml": SUITE().replace("name: S", "name: T"),
    };
    const { run } = await runWith(files, { suites: ["s.hafen.yml", "t.hafen.yml"] });
    const why = 'the fixture "gate" (beforeAll) said to stop';
    assert.equal(run.status, "stopped");
    assert.equal(run.stopped, why);
    assert.equal(run.verdict, null);
    assert.deepEqual(run.tests.map((t) => [t.suite, t.name, t.status, t.reason]), [["s.hafen.yml", "a", "skipped", why], ["s.hafen.yml", "b", "skipped", why]]);
    assert.deepEqual(said(), ["warm beforeAll", "gate beforeAll", "logout afterAll"]);
    assert.equal(chats().length, 0);
    assert.deepEqual(run.fixtures.map((f) => [f.name, f.phase, f.status, f.stop ?? false]), [["warm", "beforeAll", "ok", false], ["gate", "beforeAll", "ok", true], ["logout", "afterAll", "ok", false]]);
    assert.equal(run.spans.find((s) => s.kind === "suite").status, "skipped");
    assert.deepEqual(run.spans.find((s) => s.name === "gate · beforeAll").metrics.stop, true);
    // Each report: the tests skipped, why; the suite the run never reached, not run
    const cases = casesOf(run);
    assert.deepEqual(cases.map((c) => [c.suiteName, c.name, c.status, c.reason]), [
      ["S", "a", "skipped", why], ["S", "b", "skipped", why], ["T", "(not run)", "skipped", `not run: ${why}`],
    ]);
    assert.deepEqual(tally(run, cases), { passed: 0, failed: 0, unsure: 0, error: 0, skipped: 3, stopped: 0, total: 3 });
    const xml = junit(run);
    assert.equal(xml.match(/<skipped message="the fixture &quot;gate&quot; \(beforeAll\) said to stop"\/>/g).length, 2);
    assert.match(xml, /fixture gate \(beforeAll\) · providers\/p\.yml · ok · [\d.]+ s · said to stop · 1 call/);
    assert.match(markdown(run), /- \*\*S › a\*\* · the fixture "gate" \(beforeAll\) said to stop/);
    assert.match(markdown(run), /\| ✓ \| gate \| beforeAll \| providers\/p\.yml \|  \| [\d.]+ s \| 1 \| said to stop \|/);
    assert.equal(JSON.parse(jsonSummary(run)).fixtures.find((f) => f.name === "gate").stop, true);
  });

  it("false in before: that run (or row) is stopped saying why (no setup, no turns), its after fixtures still run, and the others go on", async () => {
    const { run } = await runWith({
      "plugins/session.js": fixture("session", { body: 'if (test.name === "b" || test.repeat === 2) return false;' }),
      "plugins/cleanup.js": fixture("cleanup"),
      "providers/p.yml": PROVIDER("{ before: [session], after: [cleanup] }"),
      "s.hafen.yml": SUITE(`  - name: a
    repeat: 2
    turns: [ { user: hello, expect: [ { contains: "You said: hello" } ] } ]
  - name: b
    setup: [ { request: { url: "${mock.url}/json", body: { message: setup } } } ]
    turns: [ { user: again, expect: [ { contains: "You said: again" } ] } ]
  - name: c
    turns: [ { user: third } ]
`),
    });
    const why = 'the fixture "session" (before) said to stop';
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.deepEqual(run.tests.map((t) => [t.name, t.status, t.reason, t.instances.map((i) => i.status)]), [
      ["a", "stopped", why, ["passed", "stopped"]], ["b", "stopped", why, ["stopped"]], ["c", "passed", undefined, ["passed"]],
    ]);
    assert.equal(run.tests[1].instances[0].reason, why);
    // Its turns aren't sent: each skipped, saying why, its checks too
    const skipped = run.turns.filter((t) => t.skipped);
    assert.deepEqual(skipped.map((t) => [t.test, t.skipped, t.results.map((r) => [r.status, r.reason])]), [
      ["a", why, [["skipped", why]]], ["b", why, [["skipped", why]]],
    ]);
    assert.deepEqual(chats().map((x) => x.body.message), ["hello", "third"], "b's setup step wasn't sent either");
    assert.deepEqual(said(), ["session before a 1", "cleanup after a 1 passed", "session before a 2", "cleanup after a 2 stopped", "session before b 1", "cleanup after b 1 stopped", "session before c 1", "cleanup after c 1 passed"]);
    // (a test stopped by its fixture is skipped in the reports, saying why; the run isn't stopped)
    assert.equal(run.verdict, "passed");
    assert.equal(junit(run).match(/<skipped message="the fixture &quot;session&quot; \(before\) said to stop"\/>/g).length, 2);
  });

  it("false in after or afterAll changes nothing: it's recorded", async () => {
    const { run } = await runWith({
      "plugins/cleanup.js": fixture("cleanup", { body: "return false;" }),
      "plugins/logout.js": fixture("logout", { body: "return false;" }),
      "providers/p.yml": PROVIDER("{ after: [cleanup], afterAll: [logout] }"),
      "s.hafen.yml": SUITE(),
    });
    assert.equal(run.status, "done");
    assert.equal(run.verdict, "passed");
    assert.deepEqual(run.fixtures.map((f) => [f.name, f.phase, f.status, f.stop]), [["cleanup", "after", "ok", true], ["cleanup", "after", "ok", true], ["logout", "afterAll", "ok", true]]);
    assert.deepEqual(run.tests[0].instances[0].after_errors, undefined);
  });

  it("true or nothing goes on; one that provides names still gives them; anything else is a failure saying what it returns", async () => {
    const ok = await runWith({
      "plugins/yes.js": fixture("yes", { body: "return true;" }),
      "plugins/quiet.js": fixture("quiet"),
      "providers/p.yml": PROVIDER("{ beforeAll: [yes], before: [quiet, yes] }"),
      "s.hafen.yml": SUITE(),
    });
    assert.equal(ok.run.verdict, "passed", JSON.stringify(ok.run.error));
    assert.equal(chats().length, 2);
    const owes = await runWith({
      "plugins/yes.js": fixture("yes", { provides: ["TOKEN"], body: "return true;" }),
      "providers/p.yml": PROVIDER("{ beforeAll: [yes] }"),
      "s.hafen.yml": SUITE(),
    });
    assert.match(owes.run.error.message, /the fixture "yes" \(beforeAll\) failed: it didn't give TOKEN/);
    const odd = await runWith({
      "plugins/yes.js": fixture("yes", { body: 'return "yes";' }),
      "providers/p.yml": PROVIDER("{ before: [yes] }"),
      "s.hafen.yml": SUITE(),
    });
    assert.equal(odd.run.tests[0].status, "error");
    assert.equal(odd.run.tests[0].instances[0].reason, 'the fixture "yes" (before) failed: its run() returns the values it gives, by name ({ ACME_COOKIE: "…" }), true or nothing to go on, or false to stop');
  });

  it("in a conversation: false in beforeAll or before refuses the message (sent to no one, not its history); they run again with the next", async () => {
    // (each says to stop the first time it's asked, and to go on after that)
    const host = memoryHost({
      "plugins/gate.js": fixture("gate", { body: "return calls > 1;" }),
      "plugins/session.js": fixture("session", { body: "return calls > 1;" }),
      "providers/p.yml": PROVIDER("{ beforeAll: [gate], before: [session] }"),
      "s.hafen.yml": SUITE(),
    });
    host.secrets = () => undefined;
    const call = connect(async () => host);
    await call("open", {});
    const send = (message) => call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", message });
    const first = await send("one");
    assert.deepEqual([first.record.skipped, first.record.error, first.record.reply], ['the fixture "gate" (beforeAll) said to stop', undefined, ""]);
    assert.equal(first.run.spans.find((s) => s.kind === "turn").status, "skipped");
    const second = await send("two");
    assert.equal(second.record.skipped, 'the fixture "session" (before) said to stop');
    const third = await send("three");
    assert.equal(third.record.reply, "You said: three");
    assert.deepEqual(said(), ["gate beforeAll", "gate beforeAll", "session before", "session before"]);
    assert.deepEqual(chats().map((x) => x.body.message), ["three"], "the refused messages were sent to no one");
    await call("reset", { token: "c" });
  });
});

describe("env.set: the environment's values, for the rest of the run", () => {
  const SETTER = fixture("setter", { phases: ["beforeAll"], body: `env.set("chat_path", "json");
    env.set("greeting", "hello from the fixture");
    env.set("count", 3);
    // (the env it was given shows what it set)
    await transport.fetch({ url: settings.log_url, method: "POST", body: { said: "setter sees", env: { ...env } }, signal });` });
  const FILES = (over = {}) => ({
    "plugins/setter.js": SETTER,
    "plugins/watcher.js": fixture("watcher"),
    "providers/p.yml": PROVIDER("{ beforeAll: [setter], before: [watcher] }", "{{env.base_url}}/{{env.chat_path}}"),
    "s.hafen.yml": SUITE(`  - name: a
    turns: [ { user: "{{env.greeting}}", expect: [ { contains: "You said: {{env.greeting}}" }, { contains: "hello from the fixture" } ] } ]
  - name: b
    turns: [ { user: "{{env.count}} more" } ]
`, ', greeting: "from the file"'),
    ...over,
  });

  it("later requests, checks and fixtures have it as {{env.NAME}}, over the environment's own; recorded by name; never written; not a secret", async () => {
    const environment = { name: "local", values: { base_url: mock.url } };
    const before = JSON.stringify(environment);
    const files = FILES();
    const { run, host } = await runWith(files, { options: { environment } });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.equal(run.verdict, "passed", JSON.stringify(run.tests.map((t) => t.instances.map((i) => i.reason))));
    assert.deepEqual(chats().map((x) => x.body.message), ["hello from the fixture", "3 more"]);
    const logs = fixtureLog();
    assert.equal(logs[0].env.chat_path, undefined, "not set before it ran");
    assert.deepEqual([logs[1].said, logs[1].env.chat_path, logs[1].env.greeting, logs[1].env.count], ["setter sees", "json", "hello from the fixture", "3"]);
    assert.deepEqual([logs[2].said, logs[2].env.chat_path, logs[2].env.greeting], ["watcher before a 1", "json", "hello from the fixture"]);
    assert.deepEqual(run.fixtures[0].sets, ["chat_path", "greeting", "count"]);
    assert.deepEqual(run.spans.find((s) => s.name === "setter · beforeAll").metrics.sets, ["chat_path", "greeting", "count"]);
    // Never written: the environment passed is as it was, and so is every file
    assert.equal(JSON.stringify(environment), before);
    for (const [file, text] of Object.entries(files)) assert.equal(host.store.get(file), text, file);
    assert.deepEqual([...host.store.keys()].sort(), Object.keys(files).sort());
    // Not a secret: shown as it is
    assert.equal(run.turns[0].user, "hello from the fixture");
    assert.match(run.turns[0].request.url, /\/json$/);
  });

  it("gone when the run ends: a second run doesn't have it; within the run, each fixture after it does", async () => {
    const files = {
      "plugins/counter.js": fixture("counter", { phases: ["before"], body: 'env.set("visits", Number(env.visits ?? 0) + 1);' }),
      "providers/p.yml": PROVIDER("{ before: [counter] }"),
      "s.hafen.yml": SUITE(),
    };
    const host = memoryHost(files);
    await runWith(files, { host });
    await runWith(files, { host });
    assert.deepEqual(fixtureLog().map((b) => [b.said, b.env.visits]), [
      ["counter before a 1", undefined], ["counter before b 1", "1"],
      ["counter before a 1", undefined], ["counter before b 1", "1"],
    ]);
  });

  it("the check before a run: an {{env.NAME}} only a fixture sets isn't missing (env.set(\"NAME\", …) in its code, or its sets); one nothing sets still is", async () => {
    const dynamic = (sets) => fixture("dyn", { sets, body: 'const name = ["dyn", "path"].join("_"); env.set(name, "json");' });
    const files = (sets) => ({
      "plugins/setter.js": SETTER,
      "plugins/dyn.js": dynamic(sets),
      // (a check plugin whose code writes {{env.dyn_path}}: checked as the files are)
      "plugins/echo.js": 'export default { kind: "check", name: "echo", version: "1.0.0", hosts: ["127.0.0.1"], async check() { return { status: "pass", reason: "{{env.dyn_path}}" }; } };\n',
      "providers/p.yml": PROVIDER("{ beforeAll: [setter], before: [dyn] }", "{{env.base_url}}/{{env.chat_path}}"),
      "s.hafen.yml": SUITE(`  - name: a
    turns: [ { user: "{{env.dyn_path}}", expect: [ { type: echo } ] } ]
`),
    });
    const ok = await runWith(files(["dyn_path"]));
    assert.equal(ok.run.status, "done", JSON.stringify(ok.run.error));
    assert.equal(ok.run.turns[0].user, "json");
    mock.reset();
    const missing = await runWith(files(undefined));
    assert.equal(missing.run.status, "error");
    assert.deepEqual(missing.run.error.all.map((p) => [p.file, p.line, p.message]), [["s.hafen.yml", 8, '{{env.dyn_path}} isn\'t set: the environment "local" has no dyn_path']]);
    assert.equal(mock.log.length, 0);
    // (only beforeAll's and before's count: one after the requests sets it too late)
    const late = await runWith({ ...files(["dyn_path"]), "providers/p.yml": PROVIDER("{ beforeAll: [setter], after: [dyn] }", "{{env.base_url}}/{{env.chat_path}}") });
    assert.match(late.run.error.all.map((p) => p.message).join("\n"), /\{\{env\.dyn_path\}\} isn't set/);
  });

  it("a name that isn't one, or a value that isn't text: the fixture fails, saying so", async () => {
    const files = (body) => ({ "plugins/setter.js": fixture("setter", { body }), "providers/p.yml": PROVIDER("{ beforeAll: [setter] }"), "s.hafen.yml": SUITE() });
    const bad = await runWith(files('env.set("1bad", "x");'));
    assert.equal(bad.run.status, "error");
    assert.equal(bad.run.error.message, 's.hafen.yml: the fixture "setter" (beforeAll) failed: env.set: "1bad" isn\'t a name (letters, digits, _ . -, not starting with a digit)');
    const object = await runWith(files('env.set("chat_path", { a: 1 });'));
    assert.equal(object.run.error.message, 's.hafen.yml: the fixture "setter" (beforeAll) failed: env.set("chat_path", …) takes text (a number or true/false is made text)');
  });

  it("in a conversation: it's there for every message after, until the conversation's let go; a first message's own {{env.NAME}} is filled in after its fixtures", async () => {
    const files = {
      "plugins/counter.js": fixture("counter", { phases: ["beforeAll"], body: 'env.set("visits", Number(env.visits ?? 0) + 1); env.set("chat_path", "json");' }),
      "providers/p.yml": PROVIDER("{ beforeAll: [counter] }", "{{env.base_url}}/{{env.chat_path}}"),
      "s.hafen.yml": SUITE(),
    };
    const host = memoryHost(files);
    host.secrets = () => undefined;
    const call = connect(async () => host);
    await call("open", {});
    const environment = { name: "local", values: { base_url: mock.url } };
    const send = (message) => call("send", { token: "c", providerFile: "providers/p.yml", suiteFile: "s.hafen.yml", env: "local", environment, message });
    const first = await send("visit {{env.visits}} via {{env.chat_path}}");
    assert.equal(first.record.reply, "You said: visit 1 via json");
    assert.equal(first.record.user_template, "visit {{env.visits}} via {{env.chat_path}}");
    const second = await send("still {{env.visits}}");
    assert.equal(second.record.reply, "You said: still 1");
    // (once its fixtures have run, a name nothing sets is refused, as ever)
    await assert.rejects(send("{{env.nope}}"), /\{\{env\.nope\}\} isn't set: the environment "local" has no nope/);
    // Let go: the next conversation starts without it
    await call("reset", { token: "c" });
    const again = await send("visit {{env.visits}}");
    assert.equal(again.record.reply, "You said: visit 1");
    assert.deepEqual(fixtureLog().map((b) => b.env.visits), [undefined, undefined]);
    assert.deepEqual(environment.values, { base_url: mock.url }, "never written into the environment passed");
    await call("reset", { token: "c" });
  });
});
