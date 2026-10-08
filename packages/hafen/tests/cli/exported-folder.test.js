// A folder the app exported (its suites, with everything they use beside them: providers/, plugins/,
// data) runs as it is from anywhere: hafen run <folder> finds the plugins in that folder's plugins/,
// as it finds the current folder's (contracts/cli.md, The folder's plugins).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../cli/hafen.js", import.meta.url));
const dirs = [];
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const cli = (cwd, args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: "1" } });
  let all = "";
  child.stdout.on("data", (d) => { all += d; });
  child.stderr.on("data", (d) => { all += d; });
  child.on("close", (code) => resolve({ code, all }));
});

// A provider plugin that answers by itself (no network), and a check plugin, each used by name; the
// provider's helper imported beside it
const FILES = {
  "echo.hafen.yml": "version: 1\nname: Echo\nprovider: providers/echo.yml\ntests:\n  - name: echoes\n    turns:\n      - user: hello\n        expect: [ { contains: \"echo: hello\" }, { type: polite, word: echo } ]\n",
  "providers/echo.yml": "kind: plugin:echo\n",
  "plugins/echo.js": 'import { prefix } from "./lib/prefix.js";\nexport default { kind: "provider", name: "echo", version: "1.0.0", hosts: [], async *send({ message }) { yield { type: "text", text: `${prefix}${message}` }; yield { type: "done" }; } };\n',
  "plugins/lib/prefix.js": 'export const prefix = "echo: ";\n',
  "plugins/polite.js": 'export default { kind: "check", name: "polite", version: "1.0.0", async check({ value, params }) { return { status: String(value).includes(params.word) ? "pass" : "fail", reason: "" }; } };\n',
};

describe("an exported folder", () => {
  it("runs from another folder: its plugins are found in its plugins/, by the folder or a suite in it", async () => {
    const exported = await mkdtemp(join(tmpdir(), "hafen-exported-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "hafen-elsewhere-"));
    dirs.push(exported, elsewhere);
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(exported, path)), { recursive: true });
      await writeFile(join(exported, path), text);
    }
    const byFolder = await cli(elsewhere, ["run", exported, "--report", `run:${join(elsewhere, "run.json")}`]);
    assert.equal(byFolder.code, 0, byFolder.all);
    assert.match(byFolder.all, /echoes/);
    const byFile = await cli(elsewhere, ["run", join(exported, "echo.hafen.yml")]);
    assert.equal(byFile.code, 0, byFile.all);
    const checked = await cli(elsewhere, ["validate", exported]);
    assert.equal(checked.code, 0, checked.all);
    // (from inside it, as before)
    const inside = await cli(exported, ["run", "."]);
    assert.equal(inside.code, 0, inside.all);
  });

  it("packs with the JSON Schemas its checks name, as with its other files (what Export writes, pack takes)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hafen-schemas-"));
    const away = await mkdtemp(join(tmpdir(), "hafen-away-"));
    dirs.push(dir, away);
    const files = {
      "said.hafen.yml": "version: 1\nprovider: plugin:jsonish\ntests:\n  - name: said\n    turns:\n      - user: hello\n        expect: [ { type: json, schema: schemas/said.json } ]\n",
      "plugins/jsonish.js": 'export default { kind: "provider", name: "jsonish", version: "1.0.0", hosts: [], async *send({ message }) { yield { type: "text", text: JSON.stringify({ said: message }) }; yield { type: "done" }; } };\n',
      "schemas/said.json": '{ "type": "object", "required": ["said"] }\n',
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    }
    const packed = await cli(dir, ["pack", ".", "-o", join(away, "said.hafen-pack.mjs")]);
    assert.equal(packed.code, 0, packed.all);
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["said.hafen-pack.mjs", "run", "--report", "md:-"], { cwd: away, env: { ...process.env, NO_COLOR: "1" } });
      let all = "";
      child.stdout.on("data", (d) => { all += d; });
      child.stderr.on("data", (d) => { all += d; });
      child.on("close", (code) => resolve({ code, all }));
    });
    assert.equal(run.code, 0, run.all);
  });
});
