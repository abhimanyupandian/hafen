// What suites use (engine/files/dependencies.js), and the commands the app's Import and Export copy
// with (engine/serve-port.js: suites, dependencies, copyPlan, copy): every file a suite needs, its
// plugins' relative imports too; how each file stands where it would go; and copying, a file that's
// there with another text kept beside it under a free name, the suites copied pointed at it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dependencies, fileRefs, freeName, relativeImports, retarget } from "../../engine/files/dependencies.js";
import { servePort } from "../../engine/serve-port.js";
import { memoryHost } from "../helpers.js";

// A pretend port: call(cmd, args) → the engine's answer
function connect(makeHost, makePlace) {
  let handler;
  const waiting = new Map();
  let next = 1;
  servePort({ receive: (h) => { handler = h; }, send: (m) => { waiting.get(m.id)?.(m); } }, makeHost, makePlace);
  return (cmd, args) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, (m) => (m.ok ? resolve(m.value) : reject(new Error(m.error))));
    handler({ id, cmd, args });
  });
}

const PROVIDER = "kind: http\nurl: http://x\nresponse: { text: $.a }\n";
// A plugin of each kind, by name (each loads in its worker); one imports a helper beside it
const plugin = (kind, name, more = "") => `${more}export default { kind: "${kind}", name: "${name}", version: "1.0.0", hosts: [],
  ${{ provider: "async *send() { yield { type: \"text\", text: \"hi\" }; yield { type: \"done\" }; }", check: "async check() { return { status: \"pass\", reason: \"\" }; }", judge: "async judge() { return { value: 1, reason: \"\" }; }", fixture: "async setup() { return {}; }" }[kind]} };\n`;

const SUITE = `version: 1
provider: providers/main.yml
providers:
  other: providers/other.yml
  inline: { kind: plugin:acme }
prices: prices.yml
plugins: [./plugins/own.js, some-package]
judges:
  mine: { kind: plugin, plugin: grader }
tests:
  - name: a
    provider: other
    data: data/rows.csv
    turns:
      - user: hi
        expect:
          - { type: json, schema: schemas/order.json }
          - { type: json, schema: schemas/off.json, enabled: false }
          - { type: polite }
  - name: b
    provider: openai-chat
    data: { file: data/more.jsonl }
    turns: [ { user: hi } ]
`;

const FOLDER = {
  "shop/checkout.hafen.yml": SUITE.replaceAll("providers/", "../providers/").replace("prices.yml", "../prices.yml").replace("./plugins/own.js", "../plugins/own.js").replaceAll("data/", "../data/").replaceAll("schemas/", "../schemas/"),
  "providers/main.yml": `${PROVIDER}fixtures: { before: [login] }\n`,
  "providers/other.yml": PROVIDER,
  "providers/unused.yml": PROVIDER,
  "prices.yml": "gpt: { input: 1, output: 2 }\n",
  "data/rows.csv": "a\n1\n",
  "data/more.jsonl": "{\"a\": 1}\n",
  "schemas/order.json": "{\"type\": \"object\"}\n",
  "plugins/own.js": plugin("check", "own"),
  "plugins/acme.js": plugin("provider", "acme", 'import { hello } from "./lib/hello.js";\n'),
  "plugins/lib/hello.js": 'export { more as hello } from "../../lib/more.js";\n',
  "lib/more.js": "export const more = 1;\n",
  "plugins/login.js": plugin("fixture", "login"),
  "plugins/grader.js": plugin("judge", "grader"),
  // (named for one name, but it's another's: found by its name, not its file's)
  "plugins/manners.js": plugin("check", "polite"),
  "plugins/unused.js": plugin("check", "unused"),
};

describe("what suites use", () => {
  it("lists every file a suite needs: its providers, data, prices, schemas, plugins and what they import", async () => {
    const host = memoryHost(FOLDER);
    const out = await dependencies(host, ["shop/checkout.hafen.yml"]);
    assert.deepEqual(out.files, [
      "data/more.jsonl", "data/rows.csv", "lib/more.js",
      "plugins/acme.js", "plugins/grader.js", "plugins/lib/hello.js", "plugins/login.js", "plugins/manners.js", "plugins/own.js",
      "prices.yml", "providers/main.yml", "providers/other.yml", "schemas/order.json", "shop/checkout.hafen.yml",
    ]);
    // (a check that's off names a schema that isn't there: not a problem)
    assert.deepEqual(out.problems, []);
    assert.deepEqual(out.packages, ["some-package"]);
  });

  it("says what a suite names that isn't there, and an import outside the folder", async () => {
    const host = memoryHost({
      "a.hafen.yml": "version: 1\nprovider: providers/gone.yml\nplugins: [./plugins/out.js]\ntests:\n  - name: a\n    data: rows.csv\n    turns: [ { user: hi, expect: [ { type: missing-kind } ] } ]\n",
      "plugins/out.js": `import "../../elsewhere.js";\nimport "./nope.js";\n${plugin("check", "out")}`,
    });
    const out = await dependencies(host, ["a.hafen.yml", "b.hafen.yml"]);
    assert.deepEqual(out.files, ["a.hafen.yml", "plugins/out.js"]);
    assert.deepEqual(out.problems.map((p) => `${p.file}: ${p.message}`).sort(), [
      "a.hafen.yml: it uses the plugin \"missing-kind\", which isn't in the folder's plugins/ or the suite's plugins",
      "a.hafen.yml: the data file rows.csv isn't there",
      "a.hafen.yml: the provider file providers/gone.yml isn't there",
      "b.hafen.yml: the suite isn't there",
      "plugins/out.js: it imports ../../elsewhere.js, which isn't in the folder (only files in it are copied)",
      "plugins/out.js: it imports ./nope.js, which isn't there",
    ]);
  });

  it("knows a plugin that can't be loaded by its file's name", async () => {
    const host = memoryHost({
      "a.hafen.yml": "version: 1\nprovider: plugin:broken\ntests:\n  - name: a\n    turns: [ { user: hi } ]\n",
      "plugins/broken.js": "export default {;\n",
    });
    assert.deepEqual((await dependencies(host, ["a.hafen.yml"])).files, ["a.hafen.yml", "plugins/broken.js"]);
  });

  it("reads a script's relative imports, static and dynamic, and not its packages", () => {
    assert.deepEqual(relativeImports([
      'import a from "./a.js";', "import { b, c } from '../b.mjs';", 'import "./side.js";', 'export * from "./re.js";',
      'export { x } from "./x.js";', 'const d = await import("./lazy.js");', 'import fs from "node:fs";', 'import yaml from "yaml";',
      "const nope = require('./cjs.js');", 'imported("./not-an-import.js")',
    ].join("\n")), ["./a.js", "../b.mjs", "./side.js", "./re.js", "./x.js", "./lazy.js"]);
  });

  it("finds the files a suite names, where it names them", () => {
    const refs = fileRefs({ provider: "other", providers: { other: "p/o.yml", x: "openai-chat" }, tests: [{ provider: "plugin:acme" }, { provider: "p/t.yml", data: "d.csv" }] });
    assert.deepEqual(refs.map((r) => [r.path.join("."), r.ref]), [["providers.other", "p/o.yml"], ["tests.1.provider", "p/t.yml"], ["tests.1.data", "d.csv"]]);
  });

  it("names a file kept beside another one free name on, a suite keeping its .hafen.yml", () => {
    const taken = new Set(["a/smoke-2.hafen.yml"]);
    assert.equal(freeName("a/smoke.hafen.yml", (p) => taken.has(p)), "a/smoke-3.hafen.yml");
    assert.equal(freeName("providers/p.yml", () => false), "providers/p-2.yml");
    assert.equal(freeName("data/rows", () => false), "data/rows-2");
  });

  it("points a suite at files written under another name, comments kept", () => {
    const text = "# mine\nversion: 1\nprovider: ../providers/p.yml   # the shop\ntests:\n  - name: a\n    data: { file: rows.csv }\n    turns: [ { user: hi } ]\n";
    const next = retarget(text, "shop/a.hafen.yml", new Map([["providers/p.yml", "providers/p-2.yml"], ["shop/rows.csv", "shop/rows-2.csv"]]));
    assert.equal(next, text.replace("p.yml   #", "p-2.yml   #").replace("rows.csv", "rows-2.csv"));
  });
});

describe("Import and Export's commands", () => {
  // The workspace, and folders picked (by name) to copy from or to
  const asked = [];  // each folder opened: { name, write }
  const setup = (workspace, places) => {
    asked.length = 0;
    const host = memoryHost(workspace);
    const opened = Object.fromEntries(Object.entries(places).map(([name, files]) => [name, memoryHost(files)]));
    const call = connect(async () => host, async ({ name }, { write }) => {
      asked.push({ name, write });
      if (!opened[name]) throw new Error(`no folder ${name}`);
      return opened[name];
    });
    return { host, opened, call };
  };

  it("lists a folder's suites, and what they use", async () => {
    const { call } = setup({}, { src: FOLDER });
    await call("open", {});
    assert.deepEqual(await call("suites", { from: { name: "src" } }), ["shop/checkout.hafen.yml"]);
    const deps = await call("dependencies", { files: ["shop/checkout.hafen.yml"], from: { name: "src" } });
    assert.equal(deps.files.length, 14);
    // (the workspace's, when none is named: it has none)
    assert.deepEqual((await call("dependencies", { files: ["shop/checkout.hafen.yml"] })).files, []);
  });

  it("says how each file stands where it would go: new, the same, or changed", async () => {
    const { call } = setup({ "a.hafen.yml": "same\n", "providers/p.yml": "mine\n", "staging.env": "A=1\n", "staging.secret.env": "S=1\n" }, { src: { "a.hafen.yml": "same\n", "providers/p.yml": "theirs\n", "data/d.csv": "a\n" } });
    await call("open", {});
    const plan = await call("copyPlan", { files: ["a.hafen.yml", "providers/p.yml", "data/d.csv"], from: { name: "src" }, texts: { "staging.env": "A=2\n" }, also: ["staging.secret.env", "prod.secret.env"] });
    assert.deepEqual(plan, [
      { file: "a.hafen.yml", status: "same" }, { file: "providers/p.yml", status: "changed" }, { file: "data/d.csv", status: "new" },
      { file: "staging.env", status: "changed" }, { file: "staging.secret.env", status: "there" }, { file: "prod.secret.env", status: "new" },
    ]);
  });

  it("copies into the workspace, keeping both where asked: the copies renamed, the suites pointed at them, a plugin kept as it was", async () => {
    const src = {
      "smoke.hafen.yml": "# theirs\nversion: 1\nprovider: providers/p.yml\nprices: prices.yml\ntests:\n  - name: theirs\n    turns: [ { user: hi, expect: [ { type: polite } ] } ]\n",
      "providers/p.yml": "kind: http   # theirs\nurl: http://x\nresponse: { text: $.a }\n",
      "prices.yml": "a: 1\n",
      "plugins/polite.js": plugin("check", "polite"),
    };
    const { host, call } = setup({ "smoke.hafen.yml": "mine\n", "smoke-2.hafen.yml": "mine too\n", "providers/p.yml": "mine\n", "plugins/polite.js": "// mine\n" }, { src });
    await call("open", {});
    const files = Object.keys(src).sort();
    const out = await call("copy", { files, from: { name: "src" }, keepBoth: ["smoke.hafen.yml", "providers/p.yml", "plugins/polite.js"] });
    assert.deepEqual(out, {
      written: [{ file: "prices.yml", as: "prices.yml" }, { file: "providers/p.yml", as: "providers/p-2.yml" }, { file: "smoke.hafen.yml", as: "smoke-3.hafen.yml" }],
      kept: ["plugins/polite.js"],
    });
    assert.equal(host.store.get("smoke.hafen.yml"), "mine\n");
    assert.equal(host.store.get("smoke-3.hafen.yml"), src["smoke.hafen.yml"].replace("providers/p.yml", "providers/p-2.yml"));
    assert.equal(host.store.get("providers/p-2.yml"), src["providers/p.yml"]);
    assert.equal(host.store.get("plugins/polite.js"), "// mine\n");
    // The suite copied reads as one, its provider the copy
    const loaded = await call("load", {});
    assert.deepEqual(loaded.suites.find((s) => s.file === "smoke-3.hafen.yml").providerFiles, { "": "providers/p-2.yml" });
  });

  it("copies from the workspace to a folder, with files written as they are given (a scope's .env)", async () => {
    const workspace = { "a.hafen.yml": "version: 1\nprovider: providers/p.yml\ntests: []\n", "providers/p.yml": PROVIDER };
    const { opened, call } = setup(workspace, { out: { "a.hafen.yml": "old\n", "README.md": "theirs\n" } });
    await call("open", {});
    const deps = await call("dependencies", { files: ["a.hafen.yml"] });
    const out = await call("copy", { files: deps.files, to: { name: "out" }, texts: { "staging.env": "base_url=http://x\n" } });
    assert.deepEqual(out.written.map((w) => w.as), ["a.hafen.yml", "providers/p.yml", "staging.env"]);
    assert.deepEqual(Object.fromEntries(opened.out.store), { ...workspace, "README.md": "theirs\n", "staging.env": "base_url=http://x\n" });
    // (a folder to read from is opened to read only; the one written to, to write)
    assert.deepEqual(asked.splice(0), [{ name: "out", write: true }]);
    await call("copyPlan", { files: ["a.hafen.yml"], from: { name: "out" } });
    assert.deepEqual(asked, [{ name: "out", write: false }]);
  });

  it("can't copy where the platform opens no folders", async () => {
    const call = connect(async () => memoryHost({}));
    await call("open", {});
    await assert.rejects(call("dependencies", { files: ["a.hafen.yml"], from: { name: "src" } }), /can't be imported or exported here/);
  });
});
