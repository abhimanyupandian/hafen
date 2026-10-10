// The engine's foundations: schemas in step with the spec, the package standing alone, variables,
// JSONPath (with the RFC 9535 compliance suite), streams, think tags, transport, spans, redaction.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import providerSchema from "../../engine/files/schema/provider.js";
import suiteSchema from "../../engine/files/schema/suite.js";
import { problem, select } from "../../engine/jsonpath.js";
import { createRedactor } from "../../engine/redact.js";
import { createSpans } from "../../engine/spans.js";
import { ndjson } from "../../engine/stream/ndjson.js";
import { sse } from "../../engine/stream/sse.js";
import { thinkTagSplitter } from "../../engine/stream/think-tags.js";
import { withNetwork, withRetries } from "../../engine/transport.js";
import { createScope, MissingVariable, references } from "../../engine/vars.js";
import { fakeTransport } from "../helpers.js";

const here = fileURLToPath(new URL(".", import.meta.url));
// The hafen package (packages/hafen), and the spec's contracts in Hafen's repository
const project = resolve(here, "../..");
const spec = resolve(project, "../../spec/001-hafen/contracts");

async function* bytes(chunks) {
  for (const c of chunks) yield new TextEncoder().encode(c);
}
const collect = async (gen) => {
  const out = [];
  for await (const x of gen) out.push(x);
  return out;
};

describe("schemas", () => {
  it("match the spec's contracts", async () => {
    assert.deepEqual(suiteSchema, JSON.parse(await readFile(join(spec, "suite.schema.json"), "utf8")));
    assert.deepEqual(providerSchema, JSON.parse(await readFile(join(spec, "provider.schema.json"), "utf8")));
  });
});

describe("standalone", () => {
  it("imports nothing from outside the package (packages/hafen): it installs on its own", async () => {
    const offenders = [];
    const walk = async (dir) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (["node_modules", "dist", "release", "test-results", ".hafen"].includes(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (/\.(m?js|jsx|cjs)$/.test(e.name)) {
          const text = await readFile(full, "utf8");
          for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
            const target = resolve(dir, m[1]);
            if (relative(project, target).startsWith("..")) offenders.push(`${relative(project, full)} → ${m[1]}`);
          }
        }
      }
    };
    await walk(project);
    assert.deepEqual(offenders, []);
  });
});

describe("variables", () => {
  const scope = createScope({ layers: [{ order: "4417", n: 3 }, { order: "0000", row: { q: "hi" } }], secrets: (n) => ({ KEY: "sk-secret-123" })[n] });
  it("resolves {{names}}, first layer first", () => {
    assert.equal(scope.resolve("order {{order}}"), "order 4417");
    assert.equal(scope.resolve("{{row.q}}"), "hi");
  });
  it("keeps a whole value's type", () => {
    assert.equal(scope.resolve("{{n}}"), 3);
    assert.deepEqual(scope.resolve({ a: ["{{n}}"] }), { a: [3] });
  });
  it("resolves {{secret.…}} and remembers the values, for redaction", () => {
    assert.equal(scope.resolve("Bearer {{secret.KEY}}"), "Bearer sk-secret-123");
    assert.ok(scope.secretsUsed.has("sk-secret-123"));
  });
  it("throws for what isn't set", () => {
    assert.throws(() => scope.resolve("{{nope}}"), MissingVariable);
    assert.throws(() => scope.resolve("{{secret.NOPE}}"), /isn't set/);
  });
  it("fills in no old way: ${env:…} and {{scope.…}} are refused, saying what to write instead", () => {
    assert.throws(() => scope.resolve("Bearer ${env:KEY}"), { message: "${env:KEY} is the old way to write a secret: write {{secret.KEY}}" });
    assert.throws(() => scope.resolve("{{scope.KEY}}"), { message: "{{scope.KEY}} is the old way: write {{env.KEY}} (a value of the environment) or {{secret.KEY}} (a secret)" });
  });
  it("finds references", () => {
    const r = references({ a: "{{x}} {{secret.Y}} ${env:Z}", b: ["{{row.z}}"] });
    assert.deepEqual([...r.vars], ["x", "secret.Y", "row.z"]);
    assert.deepEqual([...r.env], ["Y"]);
  });
});

describe("JSONPath", () => {
  it("selects values", () => {
    const data = { reply: { actions: [{ type: "refund" }, { type: "note" }], order: { id: 4417 } } };
    assert.deepEqual(select("$.reply.actions[*].type", data), ["refund", "note"]);
    assert.deepEqual(select("$.reply.order.id", data), [4417]);
    assert.deepEqual(select("$.nope", data), []);
    assert.match(problem("$.[bad"), /isn't a valid JSONPath/);
  });
  it("passes the JSONPath Compliance Test Suite (RFC 9535)", async () => {
    const cts = JSON.parse(await readFile(join(here, "../fixtures/jsonpath-cts.json"), "utf8"));
    const failures = [];
    for (const t of cts.tests) {
      if (t.invalid_selector) {
        if (!problem(t.selector)) failures.push(`${t.name}: should be invalid`);
        continue;
      }
      let got;
      try {
        got = select(t.selector, t.document);
      } catch (err) {
        failures.push(`${t.name}: ${err.message}`);
        continue;
      }
      const ok = t.results ? t.results.some((r) => JSON.stringify(r) === JSON.stringify(got)) : JSON.stringify(t.result) === JSON.stringify(got);
      if (!ok) failures.push(t.name);
    }
    assert.deepEqual(failures, [], `${failures.length} of ${cts.tests.length} failed`);
  });
});

describe("streams", () => {
  it("SSE: events split anywhere, CRLF, comments, no final blank line", async () => {
    const text = ": hello\r\nevent: a\r\ndata: {\"x\":1}\r\n\r\ndata: line1\ndata: line2\n\ndata: [DONE]";
    const chunks = text.match(/.{1,3}/gs);
    const events = await collect(sse(bytes(chunks)));
    assert.deepEqual(events, [{ event: "a", data: '{"x":1}' }, { event: "message", data: "line1\nline2" }, { event: "message", data: "[DONE]" }]);
  });
  it("NDJSON: lines split anywhere", async () => {
    const out = await collect(ndjson(bytes(['{"a":', '1}\n{"b"', ":2}\n\n"])));
    assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
  });
  it("think tags: split across pieces", () => {
    const s = thinkTagSplitter();
    const parts = [..."<think>Check it.</think>Answer.".match(/.{1,2}/g).flatMap((p) => s.feed(p)), ...s.end()];
    const thinking = parts.filter((p) => p.type === "thinking").map((p) => p.text).join("");
    const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("");
    assert.equal(thinking, "Check it.");
    assert.equal(text, "Answer.");
  });
  it("think tags: a < that isn't a tag stays text", () => {
    const s = thinkTagSplitter();
    const parts = [...s.feed("a < b <"), ...s.feed("thin"), ...s.feed("g>"), ...s.end()];
    assert.equal(parts.map((p) => p.text).join(""), "a < b <thing>");
    assert.ok(parts.every((p) => p.type === "text"));
  });
});

describe("transport", () => {
  it("retries 429 and 5xx, honouring retry-after, then gives up", async () => {
    const t = fakeTransport((req, n) => (n < 3 ? { status: n === 1 ? 429 : 503, headers: { "retry-after-ms": "5" } } : { status: 200, body: "ok" }));
    const retries = [];
    const res = await withRetries(t, { retries: 2, onRetry: (r) => retries.push(r) }).send({ url: "x" });
    assert.equal(res.status, 200);
    assert.deepEqual(retries.map((r) => r.status), [429, 503]);
    const t2 = fakeTransport(() => ({ status: 500 }));
    assert.equal((await withRetries(t2, { retries: 1 }).send({ url: "x" })).status, 500);
    assert.equal(t2.requests.length, 2);
  });
  it("network simulation adds delay", async () => {
    const t = fakeTransport(() => ({ status: 200, body: "ok" }));
    const start = performance.now();
    await withNetwork(t, { delay_ms: 60 }).send({ url: "x" });
    assert.ok(performance.now() - start >= 55);
  });
});

describe("spans", () => {
  it("never starts a child before its parent, and times from the run's start", () => {
    let now = 100;
    const spans = createSpans({ now: () => now });
    now = 110;
    const a = spans.start("turn", "t");
    const b = spans.start("request", "r", { parent: a, start: 0 });
    now = 150;
    spans.end(b);
    spans.end(a, "pass");
    assert.equal(spans.get(a).start, 10);
    assert.equal(spans.get(b).start, 10);
    assert.equal(spans.get(a).metrics.ms, 40);
  });
});

describe("redaction", () => {
  it("removes secret headers, secret values and asked-for patterns", () => {
    const r = createRedactor({ secrets: new Set(["sk-live-abcdef"]), patterns: ["email"] });
    const out = r.redact({ request: { headers: { Authorization: "Bearer sk-live-abcdef", "X-Client": "a" } }, reply: "mail me at a@b.co, key sk-live-abcdef" });
    assert.equal(out.request.headers.Authorization, "[redacted]");
    assert.equal(out.request.headers["X-Client"], "a");
    assert.equal(out.reply, "mail me at [email], key [redacted]");
  });
});
