// The engine behind a port (engine/serve-port.js), as the app talks to it: commands answered by id,
// and deleting files in the open folder.

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { nodeHost } from "../../cli/node-host.js";
import { servePort } from "../../engine/serve-port.js";
import { fakeTransport, memoryHost } from "../helpers.js";
import { parse } from "yaml";

// A pretend port: call(cmd, args) → the engine's answer
function connect(makeHost) {
  let handler;
  const waiting = new Map();
  let next = 1;
  servePort({ receive: (h) => { handler = h; }, send: (m) => { waiting.get(m.id)?.(m); } }, makeHost);
  return (cmd, args) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, (m) => (m.ok ? resolve(m.value) : reject(new Error(m.error))));
    handler({ id, cmd, args });
  });
}

const SUITE = "version: 1\nprovider: providers/p.yml\ntests:\n  - name: a\n    turns: [ { user: hi } ]\n";
const PROVIDER = "kind: http\nurl: http://x\nresponse: { text: $.a }\n";

describe("the engine's commands", () => {
  it("deletes a suite and a provider, and the folder's listing follows", async () => {
    const host = memoryHost({ "a.hafen.yml": SUITE, "providers/p.yml": PROVIDER });
    const call = connect(async () => host);
    const opened = await call("open", {});
    assert.equal(opened.suites.length, 1);
    assert.equal(opened.providers.length, 1);
    await call("remove", { file: "providers/p.yml" });
    await call("remove", { file: "a.hafen.yml" });
    const after = await call("load", {});
    assert.deepEqual([after.suites.length, after.providers.length], [0, 0]);
    await assert.rejects(call("remove", { file: "a.hafen.yml" }), /doesn't exist/);
  });

  it("renames a provider and points the suites that use it at the new name, comments kept", async () => {
    const commented = `# the shop's suite\n${SUITE.replace("provider: providers/p.yml", "provider: providers/p.yml   # the shop")}`;
    // A suite in a folder below, naming the provider for one test only
    const other = "version: 1\nprovider: ../providers/other.yml\ntests:\n  - name: b\n    provider: ../providers/p.yml\n    turns: [ { user: hi } ]\n";
    const host = memoryHost({ "a.hafen.yml": commented, "sub/b.hafen.yml": other, "providers/p.yml": PROVIDER, "providers/other.yml": PROVIDER });
    const call = connect(async () => host);
    await call("open", {});
    const renamed = await call("rename", { file: "providers/p.yml", to: "providers/shop.yml" });
    assert.deepEqual(renamed, { file: "providers/shop.yml", suites: ["a.hafen.yml", "sub/b.hafen.yml"] });
    assert.equal(host.store.has("providers/p.yml"), false);
    assert.equal(host.store.get("providers/shop.yml"), PROVIDER);
    assert.equal(host.store.get("a.hafen.yml"), commented.replace("providers/p.yml", "providers/shop.yml"));
    assert.match(host.store.get("sub/b.hafen.yml"), /provider: \.\.\/providers\/other\.yml\n[\s\S]*provider: \.\.\/providers\/shop\.yml/);
    const after = await call("load", {});
    assert.deepEqual(after.suites.map((s) => s.errors), [[], []]);
    await assert.rejects(call("rename", { file: "providers/shop.yml", to: "providers/other.yml" }), /already exists/);
  });

  it("renames a suite: the file moves, and its name follows, comments kept", async () => {
    const text = `# checkout flows\nversion: 1\nname: Smoke   # shown in reports\n${SUITE.replace("version: 1\n", "")}`;
    const host = memoryHost({ "a.hafen.yml": text, "b.hafen.yml": SUITE, "providers/p.yml": PROVIDER });
    const call = connect(async () => host);
    await call("open", {});
    assert.deepEqual(await call("rename", { file: "a.hafen.yml", to: "checkout.hafen.yml", name: "checkout" }), { file: "checkout.hafen.yml", suites: [] });
    assert.equal(host.store.has("a.hafen.yml"), false);
    assert.equal(host.store.get("checkout.hafen.yml"), text.replace("name: Smoke", "name: checkout"));
    // A suite without a name keeps none
    await call("rename", { file: "b.hafen.yml", to: "b2.hafen.yml", name: "b2" });
    assert.equal(host.store.get("b2.hafen.yml"), SUITE);
    await assert.rejects(call("rename", { file: "b2.hafen.yml", to: "checkout.hafen.yml" }), /already exists/);
    await assert.rejects(call("rename", { file: "b2.hafen.yml", to: "b3.yml" }), /isn't a suite's name/);
    assert.deepEqual((await call("load", {})).suites.map((x) => x.file), ["b2.hafen.yml", "checkout.hafen.yml"]);
  });

  it("edits sent together all land: file commands run one after another", async () => {
    const host = memoryHost({ "a.hafen.yml": SUITE, "providers/p.yml": PROVIDER });
    // A slow disk, so the edits would overlap if they could
    const { read, write } = host.files;
    host.files.read = async (p) => { await new Promise((r) => setTimeout(r, 15)); return read(p); };
    host.files.write = async (p, t) => { await new Promise((r) => setTimeout(r, 15)); return write(p, t); };
    const call = connect(async () => host);
    await call("open", {});
    await Promise.all([
      call("edit", { file: "a.hafen.yml", edits: [{ op: "set", path: ["tests", 0, "name"], value: "renamed" }] }),
      call("edit", { file: "a.hafen.yml", edits: [{ op: "add", path: ["tests"], value: { name: "b", turns: [{ user: "x" }] } }] }),
      call("edit", { file: "a.hafen.yml", edits: [{ op: "set", path: ["tests", 0, "repeat"], value: 2 }] }),
    ]);
    const data = parse(host.store.get("a.hafen.yml"));
    assert.deepEqual([data.tests[0].name, data.tests[0].repeat, data.tests[1].name], ["renamed", 2, "b"]);
  });

  it("an edit aimed at a test the file no longer has there is refused, and changes nothing", async () => {
    const two = `${SUITE}  - name: second\n    id: t_2\n    turns: [ { user: yo } ]\n`.replace("  - name: a\n", "  - name: a\n    id: t_1\n");
    const host = memoryHost({ "a.hafen.yml": two, "providers/p.yml": PROVIDER });
    const call = connect(async () => host);
    await call("open", {});
    await assert.rejects(call("edit", { file: "a.hafen.yml", edits: [{ op: "delete", path: ["tests", 0] }], guards: [{ path: ["tests", 0, "id"], value: "t_2" }] }), /has changed since it was read/);
    assert.equal(host.store.get("a.hafen.yml"), two);
    await call("edit", { file: "a.hafen.yml", edits: [{ op: "delete", path: ["tests", 1] }], guards: [{ path: ["tests", 1, "id"], value: "t_2" }] });
    assert.deepEqual(parse(host.store.get("a.hafen.yml")).tests.map((t) => t.id), ["t_1"]);
    // Out of range: refused, for YAML and JSON alike
    await assert.rejects(call("edit", { file: "a.hafen.yml", edits: [{ op: "delete", path: ["tests", 5] }] }), /has nothing at tests\.5/);
    await assert.rejects(call("edit", { file: "a.hafen.yml", edits: [{ op: "set", path: ["tests", 3, "name"], value: "x" }] }), /has nothing at tests\.3/);
    host.store.set("j.hafen.json", JSON.stringify({ version: 1, provider: "providers/p.yml", tests: [{ name: "a", turns: [{ user: "hi" }] }] }));
    await assert.rejects(call("edit", { file: "j.hafen.json", edits: [{ op: "set", path: ["tests", 3, "name"], value: "x" }] }), /has nothing at tests\.3/);
    assert.equal(JSON.parse(host.store.get("j.hafen.json")).tests.length, 1);
  });

  it("a conversation sends with its provider file as it is now; saved into another suite, it keeps its provider", async () => {
    const transport = fakeTransport((req) => ({ body: JSON.stringify({ a: `from ${req.url}` }) }));
    const host = memoryHost({ "a.hafen.yml": SUITE, "providers/p.yml": PROVIDER, "providers/q.yml": PROVIDER.replace("http://x", "http://q") }, { transport });
    const call = connect(async () => host);
    await call("open", {});
    const first = await call("send", { token: "c1", providerFile: "providers/q.yml", message: "hi" });
    assert.equal(first.record.reply, "from http://q");
    host.store.set("providers/q.yml", PROVIDER.replace("http://x", "http://q2"));
    const second = await call("send", { token: "c1", providerFile: "providers/q.yml", message: "again" });
    assert.equal(second.record.reply, "from http://q2");
    assert.equal(second.run.turns.length, 2, "the conversation so far stays");
    await call("saveConversation", { token: "c1", file: "a.hafen.yml", name: "chat", providerPath: "providers/q.yml" });
    const saved = parse(host.store.get("a.hafen.yml")).tests.at(-1);
    assert.equal(saved.provider, "providers/q.yml");
    await call("send", { token: "c2", providerFile: "providers/p.yml", message: "hi" });
    await call("saveConversation", { token: "c2", file: "a.hafen.yml", name: "chat 2", providerPath: "providers/p.yml" });
    assert.equal(parse(host.store.get("a.hafen.yml")).tests.at(-1).provider, undefined, "the suite's own provider isn't repeated");
  });

  it("a kept conversation carries on: its turns are the next message's history, and its steps come first", async () => {
    const transport = fakeTransport((req) => ({ body: JSON.stringify({ a: `reply to ${JSON.parse(req.body).messages?.length ?? "?"} messages` }) }));
    const provider = "kind: http\nurl: http://x\nbody: { messages: \"{{messages}}\" }\nhistory: messages\nresponse: { text: $.a }\n";
    const host = memoryHost({ "a.hafen.yml": SUITE, "providers/p.yml": provider }, { transport });
    const call = connect(async () => host);
    await call("open", {});
    await call("send", { token: "c1", providerFile: "providers/p.yml", message: "my name is ronaldo" });
    const first = await call("send", { token: "c1", providerFile: "providers/p.yml", message: "hello" });
    const kept = first.run;
    assert.equal(kept.turns.length, 2);
    // Later (another session): a new token, the kept run as its seed
    const next = await call("send", { token: "c2", providerFile: "providers/p.yml", message: "what is my name?", seed: kept });
    const sent = JSON.parse(transport.requests.at(-1).body).messages;
    assert.deepEqual(sent.map((m) => m.content), ["my name is ronaldo", "reply to 1 messages", "hello", "reply to 3 messages", "what is my name?"]);
    assert.equal(next.run._id, kept._id);
    assert.deepEqual(next.run.turns.map((t) => [t.index, t.user]), [[0, "my name is ronaldo"], [1, "hello"], [2, "what is my name?"]]);
    // Its steps: the kept ones first, then the new turn's, after them
    const keptEnd = Math.max(...kept.spans.map((s) => s.end));
    const newTurn = next.run.spans.find((s) => s.kind === "turn" && s.ref?.turn === 2);
    assert.ok(newTurn.start > keptEnd);
    assert.equal(next.run.spans.filter((s) => s.kind === "turn").length, 3);
  });

  it("configure gives the open host new secrets, keeping its files and edits", async () => {
    let secrets = {};
    const host = memoryHost({ "a.hafen.yml": SUITE, "providers/p.yml": PROVIDER });
    host.secrets = (name) => secrets[name];
    host.configure = (args) => { secrets = args.secrets[""] ?? {}; };
    const call = connect(async () => host);
    await call("open", {});
    await call("edit", { file: "a.hafen.yml", edits: [{ op: "set", path: ["name"], value: "kept" }] });
    await call("configure", { secrets: { "": { API_KEY: "k" } } });
    assert.equal(host.secrets("API_KEY"), "k");
    assert.equal(parse(host.store.get("a.hafen.yml")).name, "kept");
  });

  it("the Node host deletes only inside the opened folder", async () => {
    const outside = await mkdtemp(join(tmpdir(), "hafen-outside-"));
    const root = await mkdtemp(join(tmpdir(), "hafen-root-"));
    try {
      await writeFile(join(outside, "keep.yml"), "x");
      await writeFile(join(root, "a.hafen.yml"), SUITE);
      const host = nodeHost({ root });
      await assert.rejects(host.files.remove(join("..", outside.split("/").pop(), "keep.yml")), /isn't in the opened folder/);
      await assert.rejects(host.files.remove(join(outside, "keep.yml")), /isn't in the opened folder/);
      await host.files.remove("a.hafen.yml");
      assert.deepEqual(await readdir(root), []);
      assert.deepEqual(await readdir(outside), ["keep.yml"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
