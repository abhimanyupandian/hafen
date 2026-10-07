// The command line's numbers and paths: a number option that isn't one is a configuration error (exit
// 2), never NaN taken as "no limit"; a folder named outside the current one is searched for suites
// (and read), and a suite there can't read a file outside both.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../helpers.js";

const CLI = fileURLToPath(new URL("../../cli/hafen.js", import.meta.url));
let mock;
let dir;

function cli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

before(async () => {
  mock = await startMock({ chunkMs: 1 });
  dir = await mkdtemp(join(tmpdir(), "hafen-cli-opts-"));
  await mkdir(join(dir, "proj", "providers"), { recursive: true });
  await mkdir(join(dir, "proj", "suites"), { recursive: true });
  await mkdir(join(dir, "elsewhere"), { recursive: true });
  await writeFile(join(dir, "proj", "providers", "json.yml"), `kind: http\nurl: "${mock.url}/json"\nbody: { message: "{{user}}" }\nresponse:\n  text: $.data.reply\n  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }\nprice: { input: 100000, output: 100000 }\n`);
  await writeFile(join(dir, "proj", "suites", "a.hafen.yml"), `version: 1\nprovider: ../providers/json.yml\ntests:\n${[1, 2, 3, 4, 5].map((i) => `  - name: t${i}\n    turns:\n      - user: hi ${i}\n`).join("")}`);
  await writeFile(join(dir, "elsewhere", "secret.txt"), "SECRET");
});
after(async () => {
  await mock.close();
  await rm(dir, { recursive: true, force: true });
});

describe("number options", () => {
  for (const [option, value] of [["--max-cost", "$1"], ["--timeout", "5s"], ["--timeout", "0"], ["--repeat", "x"], ["--repeat", "1.5"]]) {
    it(`${option} ${value}: exit 2, saying what it takes`, async () => {
      const r = await cli(["run", option, value, "--report", "json:/dev/null"], join(dir, "proj"));
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`${option} takes`));
      assert.equal(mock.log.length, 0);
    });
  }

  it("--max-cost 1 stops the run at $1 (exit 3)", async () => {
    const r = await cli(["run", "--max-cost", "1", "--report", "json:/dev/null"], join(dir, "proj"));
    assert.equal(r.code, 3, r.stdout + r.stderr);
  });

  it("--concurrency and HAFEN_CONCURRENCY are gone (groups in the files say what runs at once): exit 2, saying so, nothing sent", async () => {
    mock.reset();
    for (const args of [["--concurrency", "4"], ["--concurrency=1"]]) {
      const r = await cli(["run", ...args, "--report", "json:/dev/null"], join(dir, "proj"));
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /--concurrency is no longer used: suites and tests run by their group/);
    }
    for (const value of ["4", "lots"]) {
      const env = await new Promise((resolve) => {
        const child = spawn(process.execPath, [CLI, "run", "--report", "json:/dev/null"], { cwd: join(dir, "proj"), env: { ...process.env, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "", HAFEN_CONCURRENCY: value } });
        let stderr = "";
        child.stderr.on("data", (d) => { stderr += d; });
        child.on("close", (code) => resolve({ code, stderr }));
      });
      assert.equal(env.code, 2);
      assert.match(env.stderr, /HAFEN_CONCURRENCY is no longer used/);
    }
    assert.equal(mock.log.length, 0);
  });
});

describe("paths outside the current folder", () => {
  it("a folder named there is searched for suites, and they run, reaching their project's providers", async () => {
    // (its project: the nearest folder above it with a package.json or a .git)
    await writeFile(join(dir, "proj", "package.json"), "{}");
    const r = await cli(["run", join(dir, "proj", "suites"), "--report", "json:/dev/null"], join(dir, "elsewhere"));
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /5 tests/);
    await rm(join(dir, "proj", "package.json"));
    // With no project to it, only the folder named is read: its suites' ../providers aren't
    const bare = await cli(["validate", join(dir, "proj", "suites")], join(dir, "elsewhere"));
    assert.equal(bare.code, 2);
    assert.match(bare.stdout + bare.stderr, /isn't in the opened folder/);
  });

  it("a suite can't read a file outside the current folder and the ones named", async () => {
    await writeFile(join(dir, "proj", "suites", "b.hafen.yml"), `version: 1\nprovider: ../providers/json.yml\ntests:\n  - name: t\n    data: ${join(dir, "elsewhere", "secret.txt")}\n    turns: [ { user: "{{row}}" } ]\n`);
    const r = await cli(["validate", join(dir, "proj", "suites", "b.hafen.yml")], join(dir, "proj"));
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /isn't in the opened folder/);
    await rm(join(dir, "proj", "suites", "b.hafen.yml"));
  });
});
