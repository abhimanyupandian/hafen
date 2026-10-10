// Environments, variables and secrets from the command line, against the mock endpoint: a suite's
// environments, --var, --env <name> or <file> and --secret <file> (each as often as wanted, merged in
// order) in run, validate and a pack's run; secrets never printed or written; a suite's redact, --redact.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { envFileName, environmentOptions, isEnvFile } from "../../cli/commands.js";
import { secretsFrom } from "../../cli/node-host.js";
import { CLI, JSON_PROVIDER, cli, dirs, mock, project, readJSON, said, suite, useMock } from "./helpers.js";

useMock();

// A node process in `cwd` (the command line, or a pack), with only this environment
function node(cwd, args, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { cwd, env: { PATH: process.env.PATH, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolveRun({ code, stdout, stderr, all: stdout + stderr }));
  });
}
const read = (dir, path) => readFile(join(dir, path), "utf8");

describe("scopes, variables and secrets", () => {
  it("--env <file> fills {{env.NAME}}, the secrets come from the job's environment, the secret redacted", async () => {
    const dir = await project({
      "stage.env": "who=stage-crew\nbase=MOCK_URL\n",
      "providers/scoped.yml": `kind: http
url: "{{env.base}}/json"
headers: { Authorization: "Bearer {{secret.API_KEY}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`,
      "s.hafen.yml": `version: 1
name: Scoped
provider: providers/scoped.yml
tests:
  - name: scoped
    turns:
      - user: "hi from {{env.who}}"
        expect: [ { contains: "hi from stage-crew" } ]
`,
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--env", "stage.env", "--report", "run:out/run.json"], { env: { API_KEY: "sk-stage-777" } });
    assert.equal(r.code, 0, said(r));
    assert.equal(mock.log[0].headers.authorization, "Bearer sk-stage-777");
    assert.ok(!(await readFile(join(dir, "out/run.json"), "utf8")).includes("sk-stage-777"));
    // No environment chosen, or a secret not set: exit 2, nothing sent
    mock.reset();
    const none = await cli(dir, ["run", "s.hafen.yml"], { env: { API_KEY: "sk-stage-777" } });
    assert.equal(none.code, 2, said(none));
    assert.match(none.stderr, /\{\{env\.base\}\} isn't set: no environment is chosen/);
    const missing = await cli(dir, ["run", "s.hafen.yml", "--env", "stage.env"], { env: { API_KEY: "" } });
    assert.equal(missing.code, 2, said(missing));
    assert.match(missing.stderr, /\{\{secret\.API_KEY\}\} isn't set/);
    assert.equal(mock.log.length, 0);
    // validate takes --env too
    const valid = await cli(dir, ["validate", "s.hafen.yml", "--env", "stage.env"]);
    assert.equal(valid.code, 0, said(valid));
  });

  it("--env <name> only names the environment: a folder's environments/<name>.yml isn't read, so its values aren't set", async () => {
    const dir = await project({
      "environments/stage.yml": "base: MOCK_URL\n",
      "s.hafen.yml": `version: 1
provider: { kind: http, url: "{{env.base}}/json", body: { message: "{{user}}" }, response: { text: $.data.reply } }
tests:
  - name: a
    turns: [ { user: hi } ]
`,
    });
    for (const command of ["validate", "run"]) {
      const r = await cli(dir, [command, "s.hafen.yml", "--env", "stage"]);
      assert.equal(r.code, 2, said(r));
      assert.match(r.stderr, /s\.hafen\.yml:2:31 {2}\{\{env\.base\}\} isn't set: the environment "stage" has no base/);
    }
    assert.equal(mock.log.length, 0);
  });

  it("--env picks a suite's environment by name; the first is the default; --var overrides a variable", async () => {
    const dir = await project({
      "s.hafen.yml": `version: 1
name: Envs
provider: providers/json.yml
environments:
  local: { base_url: "MOCK_URL", who: local }
  other: { base_url: "MOCK_URL", who: other }
variables: { greeting: hello }
tests:
  - name: env
    turns: [ { user: "{{greeting}} from {{who}}" } ]
`,
    });
    await cli(dir, ["run", "s.hafen.yml"]);
    await cli(dir, ["run", "s.hafen.yml", "--env", "other"]);
    await cli(dir, ["run", "s.hafen.yml", "--var", "greeting=hey", "--var", "who=me=too"]);
    assert.deepEqual(mock.log.map((x) => x.body.message), ["hello from local", "hello from other", "hey from me=too"]);
    const bad = await cli(dir, ["run", "s.hafen.yml", "--var", "nothing"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--var takes name=value/);
  });

  it("a secret in a check's reason, a message or a reply never reaches the output (a CI log), even with --verbose", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: secretive
    turns:
      - user: "echo {{secret.MOCK_TOKEN}}"
        expect:
          - { contains: "not {{secret.MOCK_TOKEN}} at all" }
          - { not_contains: "{{secret.MOCK_TOKEN}}" }
`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--verbose", "--report", "md:-", "--report", "junit:out/junit.xml"]);
    assert.equal(r.code, 1, said(r));
    assert.equal(mock.log[0].body.message, "echo tok-secret-9876", "it was sent");
    assert.ok(!r.all.includes("tok-secret-9876"), r.all);
    assert.match(r.stdout, /contains not \{\{secret\.MOCK_TOKEN\}\} at …: didn't find not \[redacted\] at all/);
    assert.ok(!(await readFile(join(dir, "out/junit.xml"), "utf8")).includes("tok-secret-9876"));
  });

  it("--redact email: an address in a reply is hidden in the run file and reports", async () => {
    const dir = await project({
      "s.hafen.yml": suite(`  - name: email
    turns: [ { user: "write to priya@example.com", expect: [ { contains: "nothing like this" } ] } ]
`),
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--redact", "email", "--report", "run:out/run.json", "--report", "junit:out/junit.xml", "--report", "md:out/s.md", "--report", "json:out/s.json"]);
    assert.equal(r.code, 1, said(r));
    for (const f of ["out/run.json", "out/junit.xml", "out/s.md", "out/s.json"]) {
      assert.ok(!(await readFile(join(dir, f), "utf8")).includes("priya@example.com"), f);
    }
    assert.ok(!r.stdout.includes("priya@example.com"), "nor in the output");
  });

  it("a suite's redact (patterns and headers) and a provider's secret_headers are redacted, the header's value wherever it shows", async () => {
    const dir = await project({
      "providers/tokens.yml": `kind: http
url: "MOCK_URL/json"
headers: { X-Session-Token: "tok-plain-12345", X-Tenant: "Bearer tenant-key-777", X-Trace: "trace-visible-1" }
secret_headers: [x-session-token]
body: { message: "{{user}}" }
response: { text: $.data.reply }
`,
      "s.hafen.yml": `version: 1
provider: providers/tokens.yml
redact: { patterns: [email], headers: [x-tenant] }
tests:
  - name: a
    turns:
      - user: "write to priya@example.com about tok-plain-12345 and tenant-key-777"
        expect: [ { contains: "nothing like this" } ]
`,
    });
    const r = await cli(dir, ["run", "s.hafen.yml", "--report", "run:out/run.json", "--report", "junit:out/junit.xml", "--report", "md:out/s.md", "--report", "json:out/s.json"]);
    assert.equal(r.code, 1, said(r));
    // (it was sent as written: redaction is of what's kept and shown)
    assert.equal(mock.log[0].headers["x-session-token"], "tok-plain-12345");
    for (const f of ["out/run.json", "out/junit.xml", "out/s.md", "out/s.json"]) {
      const text = await readFile(join(dir, f), "utf8");
      // The headers, and their values echoed in the message and its reply ("You said: …")
      for (const secret of ["tok-plain-12345", "tenant-key-777", "priya@example.com"]) assert.ok(!text.includes(secret), `${secret} in ${f}`);
    }
    const run = await readJSON(dir, "out/run.json");
    assert.equal(run.turns[0].request.headers["X-Session-Token"], "[redacted]");
    assert.equal(run.turns[0].request.headers["X-Tenant"], "[redacted]");
    // A header no one named stays as it was
    assert.equal(run.turns[0].request.headers["X-Trace"], "trace-visible-1");
    assert.ok(!r.all.includes("tok-plain-12345") && !r.all.includes("tenant-key-777"), "nor in the output");
  });

  it("--redact takes only the patterns there are", async () => {
    const dir = await project({ "s.hafen.yml": suite("  - name: a\n    turns: [ { user: hi, expect: [ { contains: hi } ] } ]\n") });
    const r = await cli(dir, ["run", "s.hafen.yml", "--redact", "emails,card"]);
    assert.equal(r.code, 2, said(r));
    assert.match(r.stderr, /--redact takes email, card, phone, not "emails"/);
    assert.equal(mock.log.length, 0);
  });
});

describe("--redact", () => {
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

  it("phone and card: a number in a reply is hidden in the output, the run file and every report", async () => {
    const dir = await project({ "s.hafen.yml": suite('  - name: a\n    turns: [ { user: "call +44 20 7946 0958 or pay with 4242 4242 4242 4242", expect: [ { contains: nothing-like-this } ] } ]\n') });
    const reports = ["run:out/run.json", "junit:out/j.xml", "md:out/s.md", "json:out/s.json"].flatMap((x) => ["--report", x]);
    const r = await cli(dir, ["run", "--redact", "phone,card", "--verbose", ...reports]);
    assert.equal(r.code, 1, said(r));
    assert.equal(mock.log[0].body.message, "call +44 20 7946 0958 or pay with 4242 4242 4242 4242", "sent as written");
    for (const [where, text] of [["the output", r.all], ...await Promise.all(["run.json", "j.xml", "s.md", "s.json"].map(async (f) => [f, await readFile(join(dir, "out", f), "utf8")]))]) {
      assert.ok(!text.includes("7946 0958") && !text.includes("4242 4242"), `in ${where}`);
    }
    assert.match((await readJSON(dir, "out/run.json")).turns[0].reply, /You said: call \[phone\] or pay with \[card\]/);
  });
});

describe("--env <file> and --secret <file>", () => {
  // The secrets file's values: none of them may be printed or written
  const TOKEN = "tok-file-secret-4242";
  const WORD = "word-secret-7777";
  const UNUSED = "unused-secret-8888";

  // A provider whose address is the environment's ({{env.base_url}}) and whose header is a secret
  const PROVIDER = `kind: http
url: "{{env.base_url}}/json"
headers: { Authorization: "Bearer {{secret.MOCK_TOKEN}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`;
  // A suite with two environments; its message is the environment file's greeting and its
  // environment's label (the mock answers "You said: <message>")
  const SUITE = `version: 1
name: Files
provider: ../providers/mock.yml
environments:
  staging: { label: from staging }
  prod: { label: from prod }
tests:
  - name: echo
    turns:
      - user: "{{env.greeting}} {{label}}"
        expect:
          - { type: status, equals: 200 }
          - { contains: " from " }
`;
  const files = {
    "proj/package.json": "{}",
    "proj/providers/mock.yml": PROVIDER,
    "proj/tests/files.hafen.yml": SUITE,
    "elsewhere/staging.env": "# staging\nbase_url=MOCK_URL\ngreeting=hello\n",
    "elsewhere/staging.secrets.env": `MOCK_TOKEN=${TOKEN}\n`,
  };

  // A folder with these files (paths to text), the mock's address in them (its path as a process
  // there sees it: links followed)
  async function project(these = files) {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "hafen-env-files-")));
    dirs.push(dir);
    for (const [path, text] of Object.entries(these)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text.replaceAll("MOCK_URL", mock.url));
    }
    return dir;
  }
  const cli = (dir, args, env) => node(join(dir, "proj"), [CLI, ...args], env);
  const exists = (path) => access(path).then(() => true, () => false);
  // The --env and --secret files, from the project's folder
  const ENV = ["--env", "../elsewhere/staging.env"];
  const SECRET = ["--secret", "../elsewhere/staging.secrets.env"];

  describe("--env and --secret, read", () => {
    it("--env is a file when it looks like a path (a / or \\ in it, or .env at its end) or a file of that name exists; else an environment's name", async () => {
      for (const value of ["./staging.env", "staging.env", "envs/prod", "C:\\envs\\prod", "/abs/prod.properties", "PROD.ENV"]) assert.equal(isEnvFile(value), true, value);
      for (const value of ["staging", "prod.yml", "env"]) assert.equal(isEnvFile(value), false, value);
      // (a file of that name, in the current folder, without an extension; a folder of that name isn't one)
      const dir = await project({ "here/staging": "A=1\n", "here/prod/x": "" });
      const was = process.cwd();
      process.chdir(join(dir, "here"));
      try {
        assert.equal(isEnvFile("staging"), true);
        assert.equal(isEnvFile("prod"), false);
      } finally {
        process.chdir(was);
      }
    });

    it("an environment file's name is its file's, without its extension", () => {
      assert.equal(envFileName("staging.env"), "staging");
      assert.equal(envFileName("../elsewhere/prod.properties"), "prod");
      assert.equal(envFileName("staging"), "staging");
      assert.equal(envFileName("staging.secrets.env"), "staging.secrets");
      assert.equal(envFileName(".env"), "env");
    });

    it("gives the engine the environment's name, and its file's values; the secrets file's values; nothing more", async () => {
      const dir = await project();
      const at = (p) => join(dir, "elsewhere", p);
      assert.deepEqual(await environmentOptions({}), { env: undefined, secrets: {}, secretValues: [], secretFiles: [] });
      assert.deepEqual(await environmentOptions({ env: ["staging"] }), { env: "staging", secrets: {}, secretValues: [], secretFiles: [] });
      assert.deepEqual(await environmentOptions({ env: [at("staging.env")], secret: [at("staging.secrets.env")] }), {
        env: "staging",
        environment: { name: "staging", values: { base_url: mock.url, greeting: "hello" } },
        secrets: { MOCK_TOKEN: TOKEN },
        secretValues: [TOKEN],
        // (which files, for where a missing secret was looked for)
        secretFiles: [at("staging.secrets.env")],
      });
      assert.deepEqual((await environmentOptions({ secrets: [at("staging.secrets.env")] })).secrets, { MOCK_TOKEN: TOKEN });
    });

    it("a file that doesn't exist, is a folder, or has lines that aren't NAME=value: a setup error, each at its file:line:column; a secrets file's never shows what's in its lines", async () => {
      const dir = await project({
        "elsewhere/bad.env": "base_url=x\nno equals here\n1x=2\n",
        "elsewhere/bad.secrets.env": `OK=1\n"sk-leaky-9999"\nTOKEN="abc"sk-tail-5555\n9sk-start-3333=x\nOK=2\n`,
      });
      const at = (p) => join(dir, "elsewhere", p);
      await assert.rejects(environmentOptions({ env: [at("nope.env")] }), (e) => e.setup && e.message === `the environment file ${at("nope.env")} doesn't exist`);
      await assert.rejects(environmentOptions({ secret: [at("nope.env")] }), (e) => e.setup && e.message === `the secrets file ${at("nope.env")} doesn't exist`);
      await assert.rejects(environmentOptions({ secret: [join(dir, "elsewhere")] }), (e) => e.setup && e.message === `the secrets file ${join(dir, "elsewhere")} can't be read: it's a folder`);
      await assert.rejects(environmentOptions({ env: [at("bad.env")] }), (e) => {
        assert.deepEqual(e.problems.map((p) => `${p.file}:${p.line}:${p.column} ${p.message}`), [
          `${at("bad.env")}:2:1 line 2 isn't NAME=value`,
          `${at("bad.env")}:3:1 "1x" isn't a name (letters, digits, _ . -, not starting with a digit)`,
        ]);
        return true;
      });
      await assert.rejects(environmentOptions({ secret: [at("bad.secrets.env")] }), (e) => {
        assert.deepEqual(e.problems.map((p) => `${p.file}:${p.line}:${p.column} ${p.message}`), [
          `${at("bad.secrets.env")}:2:1 line 2 isn't NAME=value`,
          `${at("bad.secrets.env")}:3:7 after a quoted value, only a # comment`,
          `${at("bad.secrets.env")}:4:1 that isn't a name (letters, digits, _ . -, not starting with a digit)`,
          `${at("bad.secrets.env")}:5:1 OK is on line 1 too: a name is set once`,
        ]);
        for (const part of ["sk-leaky", "sk-tail", "sk-start"]) assert.ok(!JSON.stringify(e.problems).includes(part), part);
        return true;
      });
    });

    it("takes several secrets files (--secret twice, or with --secrets): merged in order, a later one's winning", async () => {
      const dir = await project({ "elsewhere/a.secret.env": "A=a1\nB=b1\n", "elsewhere/b.secret.env": "B=b2\nC=c2\n" });
      const at = (p) => join(dir, "elsewhere", p);
      const given = await environmentOptions({ secret: [at("a.secret.env")], secrets: [at("b.secret.env")] });
      assert.deepEqual(given.secrets, { A: "a1", B: "b2", C: "c2" });
      assert.deepEqual(given.secretFiles, [at("a.secret.env"), at("b.secret.env")]);
    });

    it("a secret is the file's, else the environment variable of its name; one the file leaves empty (NAME=) isn't set by it", () => {
      const env = { HAFEN_TEST_A: process.env.HAFEN_TEST_A, HAFEN_TEST_B: process.env.HAFEN_TEST_B };
      process.env.HAFEN_TEST_A = "from-env-a";
      process.env.HAFEN_TEST_B = "from-env-b";
      try {
        const secrets = secretsFrom({ HAFEN_TEST_A: "from-file-a", HAFEN_TEST_B: "", ONLY_FILE: "f" });
        assert.equal(secrets("HAFEN_TEST_A"), "from-file-a");
        assert.equal(secrets("HAFEN_TEST_B"), "from-env-b");
        assert.equal(secrets("ONLY_FILE"), "f");
        assert.equal(secrets("HAFEN_TEST_NONE"), undefined);
        assert.equal(secretsFrom()("HAFEN_TEST_A"), "from-env-a");
      } finally {
        for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    });
  });

  describe("run --env <file>", () => {
    it("its values fill {{env.NAME}} (the suite's and its provider's), from a file outside the project; its name picks the suites' environment of that name", async () => {
      const dir = await project({ ...files, "elsewhere/prod.env": "base_url=MOCK_URL\ngreeting=hi\n" });
      const r = await cli(dir, ["run", "tests", ...ENV, ...SECRET, "--report", "run:out/run.json"]);
      assert.equal(r.code, 0, said(r));
      assert.match(r.stdout, /✓ Files › echo/);
      assert.equal(mock.log.length, 1);
      assert.equal(mock.log[0].path, "/json");
      assert.deepEqual(mock.log[0].body, { message: "hello from staging" });
      const run = JSON.parse(await read(dir, "proj/out/run.json"));
      assert.equal(run.settings.env, "staging");
      // prod.env: the prod environment, and its values
      mock.reset();
      const prod = await cli(dir, ["run", "tests", "--env", join(dir, "elsewhere/prod.env"), ...SECRET]);
      assert.equal(prod.code, 0, said(prod));
      assert.deepEqual(mock.log[0].body, { message: "hi from prod" });
    });

    it("a file that doesn't exist, or a line that isn't NAME=value: exit 2 at its file:line:column, nothing sent", async () => {
      const dir = await project({ ...files, "elsewhere/bad.env": "base_url=MOCK_URL\ngreeting hello\n" });
      const missing = await cli(dir, ["run", "tests", "--env", "../elsewhere/nope.env", ...SECRET]);
      assert.equal(missing.code, 2, said(missing));
      assert.equal(missing.stderr, `the environment file ${join(dir, "elsewhere/nope.env")} doesn't exist\n`);
      const bad = await cli(dir, ["run", "tests", "--env", "../elsewhere/bad.env", ...SECRET]);
      assert.equal(bad.code, 2, said(bad));
      assert.equal(bad.stderr, `${join(dir, "elsewhere/bad.env")}:2:1  line 2 isn't NAME=value\n\n1 problem: nothing was sent.\n`);
      // (in the current folder: its path from there)
      const here = await node(join(dir, "elsewhere"), [CLI, "run", "../proj/tests", "--env", "bad.env"]);
      assert.equal(here.code, 2, said(here));
      assert.match(here.stderr, /^bad\.env:2:1 {2}line 2 isn't NAME=value\n/);
      assert.equal(mock.log.length, 0);
    });

    it("a {{env.NAME}} the file hasn't: exit 2 before anything is sent", async () => {
      const dir = await project({ ...files, "elsewhere/staging.env": "base_url=MOCK_URL\n" });
      const r = await cli(dir, ["run", "tests", ...ENV, ...SECRET]);
      assert.equal(r.code, 2, said(r));
      assert.match(r.all, /env\.greeting/);
      assert.match(r.all, /nothing was sent/);
      assert.equal(mock.log.length, 0);
    });

    it("--env <name> alone: the suites' environment of that name, as before", async () => {
      const dir = await project({ ...files, "proj/providers/mock.yml": PROVIDER.replace("{{env.base_url}}", "MOCK_URL"), "proj/tests/files.hafen.yml": SUITE.replace("{{env.greeting}}", "hey") });
      const r = await cli(dir, ["run", "tests", "--env", "prod", ...SECRET, "--report", "run:out/run.json"]);
      assert.equal(r.code, 0, said(r));
      assert.deepEqual(mock.log[0].body, { message: "hey from prod" });
      assert.equal(JSON.parse(await read(dir, "proj/out/run.json")).settings.env, "prod");
    });
  });

  describe("run --secret <file>", () => {
    // A suite whose message holds a secret and a --var, which the mock says back, and a check that fails
    // on the reply: its reason says it
    const LEAK = `version: 1
name: Leak
provider: ../providers/mock.yml
tests:
  - name: echo
    turns:
      - user: "say {{secret.WORD}} and {{note}}"
        expect:
          - { path: $.data.reply, equals: "no" }
`;

    it("its values fill {{secret.NAME}}; none of them is printed or written, even one no file asked for: the output, the run file, junit, md, json", async () => {
      const dir = await project({
        ...files,
        "proj/tests/files.hafen.yml": LEAK,
        "elsewhere/staging.secrets.env": `MOCK_TOKEN=${TOKEN}\nWORD=${WORD}\nUNUSED=${UNUSED}\n`,
      });
      const reports = ["run:out/run.json", "junit:out/junit.xml", "md:out/summary.md", "json:out/summary.json"].flatMap((r) => ["--report", r]);
      const r = await cli(dir, ["run", "tests", ...ENV, ...SECRET, "--var", `note=${UNUSED}`, "--verbose", ...reports]);
      assert.equal(r.code, 1, said(r));
      // Sent as they are
      assert.equal(mock.log[0].headers.authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(mock.log[0].body, { message: `say ${WORD} and ${UNUSED}` });
      // Said and written, hidden
      assert.match(r.stdout, /\[redacted\]/);
      for (const [where, text] of [["the output", r.all], ...await Promise.all(["run.json", "junit.xml", "summary.md", "summary.json"].map(async (f) => [f, await read(dir, `proj/out/${f}`)]))]) {
        for (const value of [TOKEN, WORD, UNUSED]) assert.ok(!text.includes(value), `${value} isn't in ${where}`);
      }
      assert.match(await read(dir, "proj/out/junit.xml"), /\[redacted\]/);
    });

    it("a name it hasn't comes from the environment's variable; one it has wins over it; one it leaves empty is the environment's", async () => {
      const dir = await project({ ...files, "elsewhere/other.secrets.env": "OTHER=x\n", "elsewhere/empty.secrets.env": "MOCK_TOKEN=\n" });
      const fromEnv = await cli(dir, ["run", "tests", ...ENV, "--secret", "../elsewhere/other.secrets.env"], { MOCK_TOKEN: "tok-env-1357" });
      assert.equal(fromEnv.code, 0, said(fromEnv));
      assert.equal(mock.log.at(-1).headers.authorization, "Bearer tok-env-1357");
      const fileWins = await cli(dir, ["run", "tests", ...ENV, ...SECRET], { MOCK_TOKEN: "tok-env-1357" });
      assert.equal(fileWins.code, 0, said(fileWins));
      assert.equal(mock.log.at(-1).headers.authorization, `Bearer ${TOKEN}`);
      const empty = await cli(dir, ["run", "tests", ...ENV, "--secret", "../elsewhere/empty.secrets.env"], { MOCK_TOKEN: "tok-env-1357" });
      assert.equal(empty.code, 0, said(empty));
      assert.equal(mock.log.at(-1).headers.authorization, "Bearer tok-env-1357");
      // With no file, the environment's alone (as CI's secrets are)
      const none = await cli(dir, ["run", "tests", ...ENV], { MOCK_TOKEN: "tok-env-1357" });
      assert.equal(none.code, 0, said(none));
      assert.equal(mock.log.at(-1).headers.authorization, "Bearer tok-env-1357");
      // Neither: exit 2, nothing more sent
      const sent = mock.log.length;
      const neither = await cli(dir, ["run", "tests", ...ENV, "--secret", "../elsewhere/other.secrets.env"]);
      assert.equal(neither.code, 2, said(neither));
      assert.match(neither.all, /MOCK_TOKEN/);
      assert.match(neither.all, /nothing was sent/);
      assert.equal(mock.log.length, sent);
    });

    it("--secrets is the same option", async () => {
      const dir = await project();
      const r = await cli(dir, ["run", "tests", ...ENV, "--secrets", "../elsewhere/staging.secrets.env"]);
      assert.equal(r.code, 0, said(r));
      assert.equal(mock.log[0].headers.authorization, `Bearer ${TOKEN}`);
    });

    it("a file that doesn't exist, or bad lines: exit 2 at its file:line:column, nothing of the lines shown, nothing sent", async () => {
      const dir = await project({ ...files, "elsewhere/bad.secrets.env": `MOCK_TOKEN=${TOKEN}\n"sk-leaky-9999"\nTOKEN="abc"sk-tail-5555\n` });
      const missing = await cli(dir, ["run", "tests", ...ENV, "--secret", "../elsewhere/nope.secrets.env"]);
      assert.equal(missing.code, 2, said(missing));
      assert.equal(missing.stderr, `the secrets file ${join(dir, "elsewhere/nope.secrets.env")} doesn't exist\n`);
      const bad = await cli(dir, ["run", "tests", ...ENV, "--secret", "../elsewhere/bad.secrets.env"]);
      assert.equal(bad.code, 2, said(bad));
      const file = join(dir, "elsewhere/bad.secrets.env");
      assert.equal(bad.stderr, `${file}:2:1  line 2 isn't NAME=value\n${file}:3:7  after a quoted value, only a # comment\n\n2 problems: nothing was sent.\n`);
      assert.ok(!bad.all.includes("sk-") && !bad.all.includes(TOKEN));
      // (with another before it: its problems all the same)
      const twice = await cli(dir, ["run", "tests", ...ENV, ...SECRET, "--secrets", "../elsewhere/bad.secrets.env"]);
      assert.equal(twice.code, 2, said(twice));
      assert.equal(twice.stderr, bad.stderr);
      assert.equal(mock.log.length, 0);
    });
  });

  describe("validate --env <file> --secret <file>", () => {
    it("checks every {{env.NAME}} against the environment file: one it hasn't is a problem (exit 2)", async () => {
      const dir = await project({ ...files, "elsewhere/partial.env": "base_url=MOCK_URL\n" });
      const ok = await cli(dir, ["validate", "tests", ...ENV]);
      assert.equal(ok.code, 0, said(ok));
      assert.match(ok.stdout, /✓ tests\/files\.hafen\.yml/);
      const partial = await cli(dir, ["validate", "tests", "--env", "../elsewhere/partial.env"]);
      assert.equal(partial.code, 2, said(partial));
      assert.match(partial.stderr, /tests\/files\.hafen\.yml:\d+:\d+ {2}.*env\.greeting/);
      const bad = await cli(dir, ["validate", "tests", "--env", "../elsewhere/nope.env"]);
      assert.equal(bad.code, 2, said(bad));
      assert.match(bad.stderr, /the environment file .*nope\.env doesn't exist/);
      assert.equal(mock.log.length, 0);
    });

    it("with --env-check, every {{secret.NAME}} against the secrets file, then the environment; without it, secrets aren't checked", async () => {
      const dir = await project({ ...files, "elsewhere/other.secrets.env": "OTHER=x\n" });
      const other = ["--secret", "../elsewhere/other.secrets.env"];
      assert.equal((await cli(dir, ["validate", "tests", ...ENV, ...other])).code, 0);
      const unset = await cli(dir, ["validate", "tests", ...ENV, ...other, "--env-check"]);
      assert.equal(unset.code, 2, said(unset));
      assert.match(unset.stderr, /providers\/mock\.yml:\d+:\d+ {2}.*MOCK_TOKEN/);
      const set = await cli(dir, ["validate", "tests", ...ENV, ...SECRET, "--env-check"]);
      assert.equal(set.code, 0, said(set));
      const fromEnv = await cli(dir, ["validate", "tests", ...ENV, ...other, "--env-check"], { MOCK_TOKEN: "tok-env-1357" });
      assert.equal(fromEnv.code, 0, said(fromEnv));
      for (const r of [unset, set, fromEnv]) assert.ok(!r.all.includes(TOKEN));
      assert.equal(mock.log.length, 0);
    });
  });

  describe("a pack, run with --env <file> --secret <file>", () => {
    it("writes the names next to it (<name>.env.example, <name>.secret.example), never a value; runs anywhere with both files, from anywhere", async () => {
      const dir = await project();
      // Packed where the secrets are set: none of them goes in it
      const packed = await cli(dir, ["pack", "tests", "-o", "out/files.hafen-pack.mjs"], { MOCK_TOKEN: TOKEN });
      assert.equal(packed.code, 0, said(packed));
      assert.match(packed.stdout, /environment values it uses, from --env <file>: base_url, greeting \(their names are in files\.hafen-pack\.env\.example\)/);
      assert.match(packed.stdout, /secrets it needs, from --secret <file> or the environment: MOCK_TOKEN \(their names are in files\.hafen-pack\.secret\.example\)/);
      assert.match(packed.stdout, /run it: node files\.hafen-pack\.mjs run --env staging\.env --secret staging\.secrets\.env\n/);
      assert.equal(await read(dir, "proj/out/files.hafen-pack.env.example"), `# The environment values files.hafen-pack.mjs uses ({{env.NAME}}): their names. Fill in a copy for each
# environment (staging.env, prod.env: its name picks the suites' environment of that name), and
# give it with --env:
#   node files.hafen-pack.mjs run --env staging.env --secret staging.secrets.env

base_url=
greeting=
`);
      assert.equal(await read(dir, "proj/out/files.hafen-pack.secret.example"), `# The secrets files.hafen-pack.mjs needs: their names, never their values. Fill in a copy (never commit
# it) and give it with --secret, or set them as environment variables where it runs:
#   node files.hafen-pack.mjs run --env staging.env --secret staging.secrets.env

# used by providers/mock.yml
MOCK_TOKEN=
`);
      assert.ok(!(await exists(join(dir, "proj/out/files.hafen-pack.env"))));
      const pack = await read(dir, "proj/out/files.hafen-pack.mjs");
      assert.ok(!pack.includes(TOKEN) && !pack.includes(mock.url), "no secret, and no environment's value, in the pack");

      // Somewhere else, with only the pack; the files somewhere else again
      const away = await mkdtemp(join(tmpdir(), "hafen-env-files-run-"));
      dirs.push(away);
      await writeFile(join(away, "files.hafen-pack.mjs"), pack);
      const both = ["--env", join(dir, "elsewhere/staging.env"), "--secret", join(dir, "elsewhere/staging.secrets.env")];
      const info = await node(away, ["files.hafen-pack.mjs", "info"]);
      assert.match(info.stdout, /environment values it uses, from --env <file>: base_url, greeting\nsecrets it needs, from --secret <file> or the environment: MOCK_TOKEN/);
      assert.match((await node(away, ["files.hafen-pack.mjs", "--help"])).stdout, /node files\.hafen-pack\.mjs run --env \.\/staging\.env --secret \.\/staging\.secrets\.env/);
      const check = await node(away, ["files.hafen-pack.mjs", "validate", ...both, "--env-check"]);
      assert.equal(check.code, 0, said(check));
      const run = await node(away, ["files.hafen-pack.mjs", "run", ...both, "--report", "run:out/run.json"]);
      assert.equal(run.code, 0, said(run));
      assert.match(run.stdout, /✓ Files › echo/);
      assert.equal(mock.log[0].headers.authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(mock.log[0].body, { message: "hello from staging" });
      const record = await read(away, "out/run.json");
      assert.ok(!record.includes(TOKEN));
      assert.equal(JSON.parse(record).where.pack, "files.hafen-pack.mjs");
      // A file that isn't there, or a secret that isn't set: exit 2, nothing sent
      mock.reset();
      const missing = await node(away, ["files.hafen-pack.mjs", "run", "--env", join(dir, "elsewhere/staging.env"), "--secret", "nope.secrets.env"]);
      assert.equal(missing.code, 2, said(missing));
      assert.match(missing.stderr, /the secrets file nope\.secrets\.env doesn't exist/);
      const unset = await node(away, ["files.hafen-pack.mjs", "validate", "--env", join(dir, "elsewhere/staging.env"), "--env-check"]);
      assert.equal(unset.code, 2, said(unset));
      assert.match(unset.all, /MOCK_TOKEN/);
      assert.equal(mock.log.length, 0);
    });

    it("needs no values and no secrets: writes no example, and says so", async () => {
      const dir = await project({ ...files, "proj/providers/mock.yml": PROVIDER.replace("{{env.base_url}}", "MOCK_URL").replace(/^headers:.*\n/m, ""), "proj/tests/files.hafen.yml": SUITE.replace("{{env.greeting}}", "hey") });
      const packed = await cli(dir, ["pack", "tests", "-o", "out/files.hafen-pack.mjs"]);
      assert.equal(packed.code, 0, said(packed));
      assert.match(packed.stdout, /environment values it uses, from --env <file>: none\n {2}secrets it needs, from --secret <file> or the environment: none\n {2}run it: node files\.hafen-pack\.mjs run --env staging\n/);
      assert.ok(!(await exists(join(dir, "proj/out/files.hafen-pack.env.example"))));
      assert.ok(!(await exists(join(dir, "proj/out/files.hafen-pack.secret.example"))));
    });
  });
});

describe("--env and --secret, each given more than once (the CI recipe)", () => {
  const GLOBAL_TOKEN = "tok-global-1111";
  const STAGING_TOKEN = "tok-staging-2222";
  const PROVIDER = `kind: http
url: "{{env.base_url}}/json"
headers: { Authorization: "Bearer {{secret.MOCK_TOKEN}}" }
body: { message: "{{user}}" }
response: { text: $.data.reply }
`;
  // (the mock answers "You said: <message>")
  const SUITE = `version: 1
name: Files
provider: ../providers/mock.yml
environments:
  staging: { label: from staging }
  prod: { label: from prod }
tests:
  - name: echo
    turns:
      - user: "{{env.greeting}} {{env.region}} {{label}} {{note}}"
        expect:
          - { type: status, equals: 200 }
`;
  const files = {
    "proj/package.json": "{}",
    "proj/providers/mock.yml": PROVIDER,
    "proj/tests/files.hafen.yml": SUITE,
    "ci/globals.env": "base_url=MOCK_URL\ngreeting=hello\nregion=global-region\n",
    "ci/staging.env": "region=eu-staging\n",
    "ci/globals.secret.env": `MOCK_TOKEN=${GLOBAL_TOKEN}\nSHARED=shared-secret-3333\n`,
    "ci/staging.secret.env": `MOCK_TOKEN=${STAGING_TOKEN}\nSHARED=\n`,
  };
  const RECIPE = ["--env", "../ci/globals.env", "--env", "../ci/staging.env", "--secret", "../ci/globals.secret.env", "--secret", "../ci/staging.secret.env"];

  async function project(these = files) {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "hafen-env-repeat-")));
    dirs.push(dir);
    for (const [path, text] of Object.entries(these)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text.replaceAll("MOCK_URL", mock.url));
    }
    return dir;
  }
  const cli = (dir, args, env) => node(join(dir, "proj"), [CLI, ...args], env);

  describe("--env and --secret, read in order", () => {
    it("the environment files' values merged, a later one's winning; the name is the last --env's (a file's, or a name)", async () => {
      const dir = await project();
      const at = (p) => join(dir, "ci", p);
      const both = await environmentOptions({ env: [at("globals.env"), at("staging.env")] });
      assert.equal(both.env, "staging");
      assert.deepEqual(both.environment, { name: "staging", values: { base_url: mock.url, greeting: "hello", region: "eu-staging" } });
      // (the other way round: the globals' over staging's)
      assert.equal((await environmentOptions({ env: [at("staging.env"), at("globals.env")] })).environment.values.region, "global-region");
      // A name last: that environment, with the files' values
      assert.deepEqual(await environmentOptions({ env: [at("globals.env"), "prod"] }), { env: "prod", environment: { name: "prod", values: { base_url: mock.url, greeting: "hello", region: "global-region" } }, secrets: {}, secretValues: [], secretFiles: [] });
      // Names alone: the last one's, and no values (the suites' environment of that name)
      assert.deepEqual(await environmentOptions({ env: ["prod", "staging"] }), { env: "staging", secrets: {}, secretValues: [], secretFiles: [] });
    });

    it("the secrets files' values merged, a later one's winning; one a file leaves empty (NAME=) stays the earlier one's; every value is one to hide", async () => {
      const dir = await project();
      const at = (p) => join(dir, "ci", p);
      const given = await environmentOptions({ secret: [at("globals.secret.env"), at("staging.secret.env")] });
      assert.deepEqual(given.secrets, { MOCK_TOKEN: STAGING_TOKEN, SHARED: "shared-secret-3333" });
      assert.deepEqual(given.secretValues, [GLOBAL_TOKEN, "shared-secret-3333", STAGING_TOKEN]);
      assert.deepEqual(given.secretFiles, [at("globals.secret.env"), at("staging.secret.env")]);
    });

    it("lines that aren't NAME=value, in any of the files: each at its file:line:column, all of them", async () => {
      const dir = await project({ ...files, "ci/bad.env": "region=x\nno equals\n", "ci/bad.secret.env": "OK=1\n\"sk-leaky-9999\"\n" });
      const at = (p) => join(dir, "ci", p);
      await assert.rejects(environmentOptions({ env: [at("globals.env"), at("bad.env")], secret: [at("globals.secret.env"), at("bad.secret.env")] }), (e) => {
        assert.deepEqual(e.problems.map((p) => `${p.file}:${p.line}:${p.column} ${p.message}`), [
          `${at("bad.secret.env")}:2:1 line 2 isn't NAME=value`,
          `${at("bad.env")}:2:1 line 2 isn't NAME=value`,
        ]);
        return e.setup;
      });
      // One that doesn't exist: said, whichever it is
      await assert.rejects(environmentOptions({ env: [at("globals.env"), at("nope.env")] }), (e) => e.setup && e.message === `the environment file ${at("nope.env")} doesn't exist`);
    });
  });

  describe("run with the CI recipe", () => {
    it("--env globals.env --env staging.env --secret globals.secret.env --secret staging.secret.env: staging's over the globals', the staging environment", async () => {
      const dir = await project();
      const r = await cli(dir, ["run", "tests", ...RECIPE, "--var", `note=${GLOBAL_TOKEN}`, "--report", "run:out/run.json", "--report", "junit:out/junit.xml"]);
      assert.equal(r.code, 0, said(r));
      assert.equal(mock.log.length, 1);
      assert.equal(mock.log[0].headers.authorization, `Bearer ${STAGING_TOKEN}`);
      assert.deepEqual(mock.log[0].body, { message: `hello eu-staging from staging ${GLOBAL_TOKEN}` });
      const run = await read(dir, "proj/out/run.json");
      assert.equal(JSON.parse(run).settings.env, "staging");
      // The overridden one's value too (a file's secret, used or not): never printed or written
      for (const [where, text] of [["the output", r.all], ["the run file", run], ["junit", await read(dir, "proj/out/junit.xml")]]) {
        for (const value of [GLOBAL_TOKEN, STAGING_TOKEN, "shared-secret-3333"]) assert.ok(!text.includes(value), `${value} isn't in ${where}`);
      }
      assert.match(run, /\[redacted\]/);
    });

    it("--secret and --secrets mixed: one list, in the order given; then the environment's variables", async () => {
      const dir = await project();
      const r = await cli(dir, ["run", "tests", "--env", "../ci/globals.env", "--env", "../ci/staging.env", "--secrets", "../ci/staging.secret.env", "--secret", "../ci/globals.secret.env", "--var", "note=x"]);
      assert.equal(r.code, 0, said(r));
      assert.equal(mock.log.at(-1).headers.authorization, `Bearer ${GLOBAL_TOKEN}`);
      // A name no file sets: the environment's variable
      const dir2 = await project({ ...files, "ci/globals.secret.env": "OTHER=1\n", "ci/staging.secret.env": "MOCK_TOKEN=\n" });
      const fromEnv = await cli(dir2, ["run", "tests", ...RECIPE, "--var", "note=x"], { MOCK_TOKEN: "tok-env-4444" });
      assert.equal(fromEnv.code, 0, said(fromEnv));
      assert.equal(mock.log.at(-1).headers.authorization, "Bearer tok-env-4444");
      // Nowhere: exit 2, saying where it was looked for
      const sent = mock.log.length;
      const nowhere = await cli(dir2, ["run", "tests", ...RECIPE, "--var", "note=x"]);
      assert.equal(nowhere.code, 2, said(nowhere));
      assert.match(nowhere.stderr, /\{\{secret\.MOCK_TOKEN\}\} isn't set \(not in the --secret files or the environment\)/);
      assert.equal(mock.log.length, sent);
    });

    it("a bad line in the second file: exit 2 at its file:line:column, nothing sent", async () => {
      const dir = await project({ ...files, "ci/staging.env": "region=eu\ngreeting hello\n" });
      const r = await cli(dir, ["run", "tests", ...RECIPE, "--var", "note=x"]);
      assert.equal(r.code, 2, said(r));
      assert.equal(r.stderr, `${join(dir, "ci/staging.env")}:2:1  line 2 isn't NAME=value\n\n1 problem: nothing was sent.\n`);
      assert.equal(mock.log.length, 0);
    });

    it("--help says so", async () => {
      const dir = await project();
      const r = await cli(dir, ["--help"]);
      assert.match(r.stdout, /--env globals\.env --env staging\.env --secret globals\.secret\.env --secret staging\.secret\.env/);
    });
  });

  describe("validate and a pack, with the recipe", () => {
    it("validate --env-check: the merged values and secrets", async () => {
      const dir = await project();
      const ok = await cli(dir, ["validate", "tests", ...RECIPE, "--var", "note=x", "--env-check"]);
      assert.equal(ok.code, 0, said(ok));
      // (staging's region only: without staging.env, the globals' does)
      const partial = await project({ ...files, "ci/globals.env": "base_url=MOCK_URL\ngreeting=hello\n" });
      const missing = await cli(partial, ["validate", "tests", "--env", "../ci/globals.env", "--secret", "../ci/globals.secret.env", "--var", "note=x"]);
      assert.equal(missing.code, 2, said(missing));
      assert.match(missing.stderr, /\{\{env\.region\}\} isn't set: the environment "globals" has no region/);
      assert.ok(!missing.all.includes(GLOBAL_TOKEN));
    });

    it("a pack's run takes them the same way", async () => {
      const dir = await project();
      const packed = await cli(dir, ["pack", "tests", "-o", "out/files.hafen-pack.mjs"]);
      assert.equal(packed.code, 0, said(packed));
      const away = await mkdtemp(join(tmpdir(), "hafen-env-repeat-run-"));
      dirs.push(away);
      await writeFile(join(away, "files.hafen-pack.mjs"), await read(dir, "proj/out/files.hafen-pack.mjs"));
      const recipe = RECIPE.map((a) => (a.startsWith("../ci/") ? join(dir, a.slice(3)) : a));
      const r = await node(away, ["files.hafen-pack.mjs", "run", ...recipe, "--var", `note=${GLOBAL_TOKEN}`, "--report", "run:out/run.json"]);
      assert.equal(r.code, 0, said(r));
      assert.equal(mock.log[0].headers.authorization, `Bearer ${STAGING_TOKEN}`);
      assert.deepEqual(mock.log[0].body, { message: `hello eu-staging from staging ${GLOBAL_TOKEN}` });
      const run = await read(away, "out/run.json");
      assert.ok(!run.includes(GLOBAL_TOKEN) && !run.includes(STAGING_TOKEN) && !r.all.includes(GLOBAL_TOKEN));
      assert.match((await node(away, ["files.hafen-pack.mjs", "--help"])).stdout, /--env globals\.env --env staging\.env/);
    });
  });
});
