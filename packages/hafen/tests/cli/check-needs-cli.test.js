// A check without what its type needs, from the command line (contracts/checks.md): validate and run
// say each at its file, line and column and exit 2, and nothing is sent to the endpoint. Against the
// mock's /json: the checks that passed every run before ({ type: tool.not_called, name: … },
// { type: length }) and the ones written with another type's key.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../helpers.js";

const CLI = fileURLToPath(new URL("../../cli/hafen.js", import.meta.url));
let mock;
const dirs = [];

async function project(files) {
  const root = await mkdtemp(join(tmpdir(), "hafen-check-needs-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text.replaceAll("MOCK_URL", mock.url));
  }
  return root;
}

function cli(dir, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "", HAFEN_CONCURRENCY: "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const said = (r) => `exit ${r.code}\n${r.stdout}\n${r.stderr}`;

const FILES = {
  "providers/p.yml": `kind: http
url: "MOCK_URL/json"
body: { message: "{{user}}" }
response: { text: $.data.reply }
`,
  "checks.hafen.yml": `version: 1
provider: providers/p.yml
tests:
  - name: refund
    turns:
      - user: I want a refund
        expect:
          - { type: tool.not_called, name: lookup_order }
          - { type: length }
          - { type: tool.order, value: [lookup_order, refund] }
          - { type: sequence, order: [thinking, text] }
          - { type: length, enabled: false }
          - { contains: refund }
`,
};
const PROBLEMS = [
  "checks.hafen.yml:8:13  a tool.not_called check needs tool (the tool's name): \"name\" is the check's own label (did you mean \"tool\"?)",
  "checks.hafen.yml:9:13  a length check needs min_length or max_length (a limit in characters)",
  "checks.hafen.yml:10:13  a tool.order check needs order (the tools' names, in order): \"value\" is for contains, not_contains, matches and sequence checks (did you mean \"order\"?)",
  "checks.hafen.yml:11:13  a sequence check needs value (a list of event kinds, in order): \"order\" is for tool.order checks (did you mean \"value\"?)",
];

before(async () => { mock = await startMock({ chunkMs: 1 }); });
beforeEach(() => mock.reset());
after(async () => {
  mock.close();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("a check without what its type needs, from the command line", () => {
  it("validate: each at its file, line and column, exit 2", async () => {
    const dir = await project(FILES);
    const r = await cli(dir, ["validate"]);
    assert.equal(r.code, 2, said(r));
    for (const line of PROBLEMS) assert.ok(r.stdout.includes(line) || r.stderr.includes(line), `${line}\n---\n${said(r)}`);
    assert.match(said(r), /4 problems/);
  });

  it("run: the same problems, exit 2, and nothing sent", async () => {
    const dir = await project(FILES);
    const r = await cli(dir, ["run"]);
    assert.equal(r.code, 2, said(r));
    for (const line of PROBLEMS) assert.ok(r.stderr.includes(line), `${line}\n---\n${said(r)}`);
    assert.match(r.stderr, /4 problems: nothing was sent\./);
    assert.deepEqual(mock.log, []);
  });

  it("written as each type needs it, the same suite runs and passes", async () => {
    const dir = await project({ ...FILES, "checks.hafen.yml": `version: 1
provider: providers/p.yml
tests:
  - name: refund
    turns:
      - user: I want a refund
        expect:
          - { type: tool.not_called, tool: lookup_order }
          - { type: length, max_length: 2000 }
          - { type: tool.order, order: [lookup_order, refund], enabled: false }
          - { type: sequence, value: [text] }
          - { type: length, enabled: false }
          - { contains: refund }
` });
    const r = await cli(dir, ["run"]);
    assert.equal(r.code, 0, said(r));
    assert.equal(mock.log.filter((x) => x.path === "/json").length, 1);
  });
});
