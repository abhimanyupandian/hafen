// The relay (server/relay.js) and `npm run serve` (server/serve.js): the browser build served, its
// calls relayed to the endpoints it's allowed and others refused, its allowlist judged on the address as
// it will be called, a port that's taken or isn't one said plainly. (It was `hafen serve`: it serves the
// app's build, so it's the app's, not the hafen package's.)

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { allowed, createRelay } from "../../server/relay.js";
import { startMock } from "../../packages/hafen/tests/fixtures/mock-endpoint.mjs";

const SERVE = fileURLToPath(new URL("../../server/serve.js", import.meta.url));
let mock;
const dirs = [];

before(async () => {
  mock = await startMock({ chunkMs: 1 });
});
after(async () => {
  await mock.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// A folder of its own to run it in
async function folder() {
  const dir = await mkdtemp(join(tmpdir(), "hafen-serve-"));
  dirs.push(dir);
  return dir;
}

// `npm run serve` with these options, to its end
function serve(dir, args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVE, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const said = (r) => `exit ${r.code}\n${r.stdout}\n${r.stderr}`;

describe("the relay", () => {
  let relay;
  let url;
  before(async () => {
    relay = createRelay({ allow: [`${mock.url}/json`] });
    await new Promise((r) => relay.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${relay.address().port}`;
  });
  after(() => new Promise((r) => relay.close(r)));

  it("relays allowed endpoints", async () => {
    const res = await fetch(`${url}/relay`, { method: "POST", headers: { "x-hafen-target": `${mock.url}/json`, "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.reply, "You said: hi");
  });
  it("refuses endpoints not on the allowlist, saying so", async () => {
    const res = await fetch(`${url}/relay`, { method: "POST", headers: { "x-hafen-target": `${mock.url}/sse` }, body: "{}" });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("x-hafen-relay"), "refused");
  });
  it("refuses other sites' pages", async () => {
    const res = await fetch(`${url}/relay`, { method: "POST", headers: { "x-hafen-target": `${mock.url}/json`, origin: "https://evil.example" }, body: "{}" });
    assert.equal(res.status, 403);
  });
  it("a stream that drops mid-reply ends that response short, and the relay goes on", async () => {
    const cut = createRelay({ allow: [`${mock.url}/cut`, `${mock.url}/json`] });
    await new Promise((r) => cut.listen(0, "127.0.0.1", r));
    const at = `http://127.0.0.1:${cut.address().port}`;
    try {
      const res = await fetch(`${at}/relay`, { method: "POST", headers: { "x-hafen-target": `${mock.url}/cut`, "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
      assert.equal(res.status, 200);
      await assert.rejects(res.text());
      // Still relaying
      const next = await fetch(`${at}/relay`, { method: "POST", headers: { "x-hafen-target": `${mock.url}/json`, "content-type": "application/json" }, body: JSON.stringify({ message: "again" }) });
      assert.equal((await next.json()).data.reply, "You said: again");
    } finally {
      await new Promise((r) => cut.close(r));
    }
  });
  it("an endpoint it can't reach: a 502 that says why", async () => {
    const closed = await new Promise((resolve) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const { port } = s.address();
        s.close(() => resolve(port));
      });
    });
    const away = createRelay({ allow: [`http://localhost:${closed}/`] });
    await new Promise((r) => away.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${away.address().port}/relay`, { method: "POST", headers: { "x-hafen-target": `http://localhost:${closed}/json` }, body: "{}" });
      assert.equal(res.status, 502);
      assert.match((await res.json()).error, /couldn't reach the endpoint: .*ECONNREFUSED/);
    } finally {
      await new Promise((r) => away.close(r));
    }
  });
});

it("the relay's allowlist judges the address as it'll be called: no walking out with ../ or %2e%2e", () => {
  const allow = ["https://api.acme.example/v1/chat"];
  for (const u of ["https://api.acme.example/v1/chat", "https://api.acme.example/v1/chat/stream", "https://api.acme.example/v1/chat?x=1"]) assert.equal(allowed(allow, u), true, u);
  for (const u of ["https://api.acme.example/v1/chat/../../admin/users", "https://api.acme.example/v1/chat/%2e%2e/%2e%2e/admin", "https://api.acme.example/v1/chatter", "https://api.acme.example@evil.example/v1/chat", "file:///etc/passwd", "not an address"]) assert.equal(allowed(allow, u), false, u);
  assert.equal(allowed(["https://api.acme.example"], "https://api.acme.example/anything"), true);
});

describe("serve", () => {
  // A port nothing listens on now
  const freePort = () => new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  // `npm run serve` (node server/serve.js), until it says where it is
  function serving(dir, args, env = {}) {
    const child = spawn(process.execPath, [SERVE, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1", ...env } });
    let stdout = "";
    let stderr = "";
    const ready = new Promise((resolve) => {
      child.stdout.on("data", (d) => { stdout += d; if (/Hafen: http/.test(stdout)) resolve(); });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", resolve);
    });
    const closed = new Promise((resolve) => child.on("close", (code) => resolve(code)));
    return { child, ready, closed, out: () => stdout, errors: () => stderr };
  }

  it("serves the app and relays to the endpoints it's allowed (--allow-endpoint, HAFEN_ENDPOINTS), refusing others", async () => {
    const dir = await folder();
    const port = await freePort();
    const s = serving(dir, ["--port", String(port), "--allow-endpoint", `${mock.url}/json`], { HAFEN_ENDPOINTS: ` ${mock.url}/sse , ` });
    try {
      await s.ready;
      assert.match(s.out(), new RegExp(`Hafen: http://127\\.0\\.0\\.1:${port} {2}· {2}relay allows ${mock.url}/json, ${mock.url}/sse\\n`));
      const base = `http://127.0.0.1:${port}`;
      const page = await fetch(`${base}/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<div id="app">|<title>Hafen/);
      const ping = await (await fetch(`${base}/relay/ping`)).json();
      assert.deepEqual(ping, { relay: true, endpoints: 2 });
      const ok = await fetch(`${base}/relay`, { method: "POST", headers: { "x-hafen-target": `${mock.url}/json`, "content-type": "application/json", origin: base }, body: JSON.stringify({ message: "hi" }) });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).data.reply, "You said: hi");
      const sse = await fetch(`${base}/relay`, { method: "POST", headers: { "x-hafen-target": `${mock.url}/sse`, "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
      assert.equal(sse.status, 200);
      assert.match(await sse.text(), /data: \{"type":"text_delta"/);
      const refused = await fetch(`${base}/relay`, { method: "POST", headers: { "x-hafen-target": `${mock.url}/tools` }, body: "{}" });
      assert.equal(refused.status, 403);
      assert.equal(refused.headers.get("x-hafen-relay"), "refused");
      // A page that reached it by another name (DNS rebinding: evil.example made to point here), its
      // Origin matching the Host it sent: not its own page
      const rebound = await new Promise((resolve) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: "/relay", method: "POST", headers: { host: `evil.example:${port}`, origin: `http://evil.example:${port}`, "x-hafen-target": `${mock.url}/json`, "content-type": "application/json" } }, (res) => {
          let body = "";
          res.on("data", (d) => { body += d; });
          res.on("end", () => resolve({ status: res.statusCode, refused: res.headers["x-hafen-relay"], body }));
        });
        req.end(JSON.stringify({ message: "hi" }));
      });
      assert.equal(rebound.status, 403);
      assert.equal(rebound.refused, "refused");
      assert.match(rebound.body, /only answers pages on this machine/);
      // By localhost: its own
      const local = await fetch(`http://localhost:${port}/relay`, { method: "POST", headers: { "x-hafen-target": `${mock.url}/json`, "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) }).catch(() => null);
      if (local) assert.equal(local.status, 200);
    } finally {
      s.child.kill("SIGTERM");
      await s.closed;
    }
  });

  it("a port that's taken, or isn't one: exit 2, said plainly", async () => {
    const dir = await folder();
    const taken = createServer();
    await new Promise((r) => taken.listen(0, "127.0.0.1", r));
    try {
      const busy = await serve(dir, ["--port", String(taken.address().port)]);
      assert.equal(busy.code, 2, said(busy));
      assert.match(busy.stderr, /port \d+ is in use: choose another with --port/);
      assert.doesNotMatch(busy.stderr, /at .*:\d+:\d+/);
    } finally {
      taken.close();
    }
    for (const port of ["70000", "eighty", "-1", "80.5"]) {
      const bad = await serve(dir, [`--port=${port}`]);
      assert.equal(bad.code, 2, `${port}: ${said(bad)}`);
      assert.match(bad.stderr, /--port takes a whole number from 0 to 65535/);
    }
  });
});
