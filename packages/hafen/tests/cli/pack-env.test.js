// A pack's secrets and environment values (contracts/cli.md, pack): never in the pack, their names in
// the .secret.example and .env.example it writes next to it, and their values from where it runs
// (--env <file>, --secret <file>, then the environment's variables, a .env Node reads included),
// against the mock endpoint. Each test has a folder of its own.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../helpers.js";

const CLI = fileURLToPath(new URL("../../cli/hafen.js", import.meta.url));
let mock;
const dirs = [];

// The secrets' values where it's packed: none of them may end up in a file
const PACKED_WITH = { MOCK_TOKEN: "tok-packing-secret-5150", OPENAI_API_KEY: "sk-packing-secret-8080" };
// And where it runs
const RUN_WITH = { MOCK_TOKEN: "tok-running-secret-2718", OPENAI_API_KEY: "sk-running-secret-3141" };

// A suite with a provider file whose header is a secret ({{secret.MOCK_TOKEN}}), and a test on a
// preset that takes its default key (OPENAI_API_KEY); their address is the environment's
const files = {
  "tests/smoke.hafen.yml": `version: 1
name: Smoke
provider: ../providers/mock.yml
tests:
  - name: refund
    turns:
      - user: I want a refund
        expect:
          - { type: status, equals: 200 }
          - { path: $.data.order.id, equals: 4417 }
  - name: preset
    provider: { kind: openai-chat, model: gpt-test, base_url: "{{env.base_url}}/openai" }
    turns:
      - user: hello
        expect: [ { type: status, equals: 200 } ]
`,
  "providers/mock.yml": `kind: http
url: "{{env.base_url}}/json"
headers: { Authorization: "Bearer {{secret.MOCK_TOKEN}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`,
};

// A folder with these files (paths to text), the mock's address in them
async function project(these) {
  const dir = await mkdtemp(join(tmpdir(), "hafen-pack-env-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(these)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text.replaceAll("MOCK_URL", mock.url));
  }
  return dir;
}

// A node process in `dir` (the command line, or a pack), with only this environment
function node(dir, args, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { cwd: dir, env: { PATH: process.env.PATH, NO_COLOR: "1", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolveRun({ code, stdout, stderr, all: stdout + stderr }));
  });
}
const said = (r) => `exit ${r.code}\n${r.stdout}\n${r.stderr}`;
const exists = (path) => access(path).then(() => true, () => false);

// The suites packed (with their secrets set, as they would be on a developer's machine) and the pack
// copied somewhere empty: { dir, away, packed }
async function packed(these = files) {
  const dir = await project(these);
  const r = await node(dir, [CLI, "pack", "tests", "-o", "out/smoke.hafen-pack.mjs"], PACKED_WITH);
  assert.equal(r.code, 0, said(r));
  const away = await mkdtemp(join(tmpdir(), "hafen-pack-env-run-"));
  dirs.push(away);
  await writeFile(join(away, "smoke.hafen-pack.mjs"), await readFile(join(dir, "out/smoke.hafen-pack.mjs")));
  return { dir, away, packed: r };
}

before(async () => {
  mock = await startMock({ chunkMs: 1 });
});
beforeEach(() => mock.reset());
after(async () => {
  await mock.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("a pack's secrets", () => {
  it("writes their names next to it, in <name>.secret.example, each with what uses it, and the environment's in <name>.env.example; no value in them or in the pack", async () => {
    const { dir, packed: r } = await packed();
    assert.match(r.stdout, /environment values it uses, from --env <file>: base_url \(their names are in smoke\.hafen-pack\.env\.example\)/);
    assert.match(r.stdout, /secrets it needs, from --secret <file> or the environment: MOCK_TOKEN, OPENAI_API_KEY \(their names are in smoke\.hafen-pack\.secret\.example\)/);
    const example = await readFile(join(dir, "out/smoke.hafen-pack.secret.example"), "utf8");
    assert.equal(example, `# The secrets smoke.hafen-pack.mjs needs: their names, never their values. Fill in a copy (never commit
# it) and give it with --secret, or set them as environment variables where it runs:
#   node smoke.hafen-pack.mjs run --env staging.env --secret staging.secrets.env

# used by providers/mock.yml
MOCK_TOKEN=
# used by tests/smoke.hafen.yml (the openai-chat preset's default key)
OPENAI_API_KEY=
`);
    const envExample = await readFile(join(dir, "out/smoke.hafen-pack.env.example"), "utf8");
    assert.match(envExample, /\n\nbase_url=\n$/);
    const pack = await readFile(join(dir, "out/smoke.hafen-pack.mjs"), "utf8");
    for (const value of [...Object.values(PACKED_WITH), mock.url]) {
      assert.ok(!pack.includes(value), `${value} isn't in the pack`);
      assert.ok(!example.includes(value) && !envExample.includes(value), `${value} isn't in the examples`);
    }
    // Its names, as the files name them (never a value)
    assert.ok(pack.includes("Bearer {{secret.MOCK_TOKEN}}"));
    // (the .env.example that once held the secrets' names is the environment's now)
    assert.ok(!envExample.includes("MOCK_TOKEN"));
  });

  it("writes no .secret.example when it needs none, and says so", async () => {
    const dir = await project({ ...files, "providers/mock.yml": files["providers/mock.yml"].replace(/^headers:.*\n/m, ""), "tests/smoke.hafen.yml": files["tests/smoke.hafen.yml"].replace("kind: openai-chat,", "kind: openai-chat, api_key: \"\",") });
    const r = await node(dir, [CLI, "pack", "tests", "-o", "out/smoke.hafen-pack.mjs"], PACKED_WITH);
    assert.equal(r.code, 0, said(r));
    assert.match(r.stdout, /secrets it needs, from --secret <file> or the environment: none\n/);
    assert.ok(!r.stdout.includes(".secret.example"));
    assert.ok(await exists(join(dir, "out/smoke.hafen-pack.mjs")));
    assert.ok(!(await exists(join(dir, "out/smoke.hafen-pack.secret.example"))));
  });

  it("runs with --secret <file>: the file's secrets reach the run; one it leaves empty stops it before anything is sent, unless an environment variable has it", async () => {
    const { dir, away } = await packed();
    for (const where of [dir, away]) await writeFile(join(where, "staging.env"), `base_url=${mock.url}\n`);
    await writeFile(join(away, "staging.secrets.env"), `# staging\nMOCK_TOKEN=${RUN_WITH.MOCK_TOKEN}\nOPENAI_API_KEY=${RUN_WITH.OPENAI_API_KEY}\n`);
    const both = ["--env", "staging.env", "--secret", "staging.secrets.env"];
    const check = await node(away, ["smoke.hafen-pack.mjs", "validate", ...both, "--env-check"]);
    assert.equal(check.code, 0, said(check));
    const run = await node(away, ["smoke.hafen-pack.mjs", "run", ...both, "--report", "run:out/run.json"]);
    assert.equal(run.code, 0, said(run));
    assert.match(run.stdout, /✓ Smoke › refund/);
    assert.match(run.stdout, /✓ Smoke › preset/);
    assert.equal(mock.log.find((x) => x.path === "/json").headers.authorization, `Bearer ${RUN_WITH.MOCK_TOKEN}`);
    assert.equal(mock.log.find((x) => x.path === "/openai/chat/completions").headers.authorization, `Bearer ${RUN_WITH.OPENAI_API_KEY}`);
    const record = await readFile(join(away, "out/run.json"), "utf8");
    for (const value of Object.values(RUN_WITH)) assert.ok(!record.includes(value), `${value} is redacted from the run file`);

    // One the file leaves empty (as the example has it): validate --env-check names it, as the command
    // line does in the project, and run sends nothing
    mock.reset();
    for (const where of [dir, away]) await writeFile(join(where, "staging.secrets.env"), `MOCK_TOKEN=\nOPENAI_API_KEY=${RUN_WITH.OPENAI_API_KEY}\n`);
    const missing = await node(away, ["smoke.hafen-pack.mjs", "validate", ...both, "--env-check"]);
    assert.equal(missing.code, 2, said(missing));
    assert.match(missing.all, /MOCK_TOKEN/);
    assert.ok(!missing.all.includes("OPENAI_API_KEY"));
    const unpacked = await node(dir, [CLI, "validate", "tests", ...both, "--env-check"]);
    assert.equal(unpacked.code, 2, said(unpacked));
    assert.equal(missing.all, unpacked.all);
    const stopped = await node(away, ["smoke.hafen-pack.mjs", "run", ...both]);
    assert.equal(stopped.code, 2, said(stopped));
    assert.match(stopped.all, /MOCK_TOKEN[\s\S]*nothing was sent/);
    assert.equal(mock.log.length, 0);
    // An environment variable fills what the file leaves empty
    const env = await node(away, ["smoke.hafen-pack.mjs", "run", ...both], { MOCK_TOKEN: RUN_WITH.MOCK_TOKEN });
    assert.equal(env.code, 0, said(env));
    // And the secrets from environment variables alone, a .env Node reads included (no --secret)
    await writeFile(join(away, ".env"), `MOCK_TOKEN=${RUN_WITH.MOCK_TOKEN}\nOPENAI_API_KEY=${RUN_WITH.OPENAI_API_KEY}\n`);
    const dotenv = await node(away, ["--env-file=.env", "smoke.hafen-pack.mjs", "run", "--env", "staging.env"]);
    assert.equal(dotenv.code, 0, said(dotenv));
  });

  it("lists a plugin's secret, a System One check's default key and a suite's own secret, each with what uses it; a folder's environments/*.yml isn't packed", async () => {
    const { dir, packed: r } = await packed({
      ...files,
      "environments/staging.yml": "base_url: MOCK_URL\n",
      "tests/smoke.hafen.yml": `${files["tests/smoke.hafen.yml"].replace("I want a refund", "I want a refund {{secret.REGION}}").replace("- { type: status, equals: 200 }\n          - { path:", "- { type: status, equals: 200 }\n          - { type: systemone.noul, question: \"Is it kind?\", min: 0.5 }\n          - { type: signed }\n          - { path:")}`,
      "plugins/signed.js": `export default { kind: "check", name: "signed", version: "1.0.0", async check({ transport }) {
  await transport.fetch({ url: "https://sign.example/", headers: { authorization: "Bearer {{secret.SIGNING_KEY}}" } });
  return { status: "pass", reason: "ok" };
} };
`,
    });
    const example = await readFile(join(dir, "out/smoke.hafen-pack.secret.example"), "utf8");
    assert.match(example, /\n# used by tests\/smoke\.hafen\.yml \(System One's default key\)\nJEV_API_KEY=\n/);
    assert.match(example, /\n# used by providers\/mock\.yml\nMOCK_TOKEN=\n/);
    assert.match(example, /\n# used by plugins\/signed\.js\nSIGNING_KEY=\n/);
    assert.match(example, /\n# used by tests\/smoke\.hafen\.yml\nREGION=\n/);
    assert.equal(example.match(/^[A-Z_]+=$/gm).length, 5);
    assert.match(r.stdout, /1 suite · 1 provider · 1 plugin \(bundled with 1 file\)\n/);
    assert.ok(!(await readFile(join(dir, "out/smoke.hafen-pack.mjs"), "utf8")).includes("environments/staging.yml"));
  });

  it("packs nothing when a plugin names a secret the old way, { secret: \"NAME\" }: a problem where it does, saying the new way", async () => {
    const dir = await project({
      ...files,
      "tests/smoke.hafen.yml": files["tests/smoke.hafen.yml"].replace("- { path:", "- { type: signed }\n          - { path:"),
      "plugins/signed.js": `export default { kind: "check", name: "signed", version: "1.0.0", async check({ transport }) {
  await transport.fetch({ url: "https://sign.example/", headers: { authorization: { secret: "SIGNING_KEY", prefix: "Bearer " } } });
  return { status: "pass", reason: "ok" };
} };
`,
    });
    const r = await node(dir, [CLI, "pack", "tests", "-o", "out/smoke.hafen-pack.mjs"], PACKED_WITH);
    assert.equal(r.code, 2, said(r));
    assert.equal(r.stderr, `plugins/signed.js:2:85  { secret: "SIGNING_KEY" } is the old way to name a secret: write "{{secret.SIGNING_KEY}}" in the request (a header's "Bearer {{secret.SIGNING_KEY}}")\n\n1 problem: nothing was packed.\n`);
    assert.ok(!(await exists(join(dir, "out/smoke.hafen-pack.mjs"))));
  });
});
