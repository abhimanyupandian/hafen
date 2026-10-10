// What the command line's tests share: the mock endpoint and the folders a test file makes (useMock),
// a folder of files, the command line run in it (its secrets set), and the suites most tests write.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { startMock } from "../helpers.js";

export const CLI = fileURLToPath(new URL("../../cli/hafen.js", import.meta.url));
const SSE = await readFile(fileURLToPath(new URL("../fixtures/suites/providers/mock-sse.yml", import.meta.url)), "utf8");

// The mock endpoint ({ url, log, reset }), and the folders the file's tests made. useMock(), at the top
// of a test file: the mock started before its tests and reset before each; after them, closed and the
// folders removed
export let mock;
export const dirs = [];
export function useMock() {
  before(async () => {
    mock = await startMock({ chunkMs: 1 });
  });
  beforeEach(() => mock.reset());
  after(async () => {
    await mock.close();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
}

// A JSON provider (one reply), its key a secret
export const JSON_PROVIDER = `kind: http
url: "{{base_url}}/json"
headers: { Authorization: "Bearer {{secret.MOCK_TOKEN}}" }
body: { message: "{{user}}" }
response:
  text: $.data.reply
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
price: { input: 1, output: 2 }
`;

// A folder with these files (paths to text), its environment's base_url the mock's
export async function project(files) {
  const dir = await mkdtemp(join(tmpdir(), "hafen-flows-"));
  dirs.push(dir);
  const all = { "providers/json.yml": JSON_PROVIDER, "providers/sse.yml": SSE, ...files };
  for (const [path, text] of Object.entries(all)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), typeof text === "function" ? text(mock.url) : text.replaceAll("MOCK_URL", mock.url));
  }
  return dir;
}

export function cli(dir, args, { env = {}, signalAfterMs, signal = "SIGTERM" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: "1", MOCK_TOKEN: "tok-secret-9876", JEV_API_KEY: "jev-secret-key-1", GITHUB_STEP_SUMMARY: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    if (signalAfterMs) setTimeout(() => child.kill(signal), signalAfterMs);
    child.on("close", (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
  });
}
export const readJSON = async (dir, path) => JSON.parse(await readFile(join(dir, path), "utf8"));
export const said = (r) => `exit ${r.code}\n${r.stdout}\n${r.stderr}`;

// A suite: its head (provider, environments…), then its tests (YAML)
export const suite = (tests, head = "provider: providers/json.yml") => `version: 1
name: Flows
${head}
environments:
  local: { base_url: "MOCK_URL" }
tests:
${tests}`;
