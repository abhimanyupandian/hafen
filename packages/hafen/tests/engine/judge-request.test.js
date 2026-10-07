// System One's request, on its call's step (data-model.md, Span: request): all of it (the address, the
// headers, the body: the state, the model, the questions), its key hidden, and sent to the page as the
// call starts, before it's answered.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { shownRequest } from "../../engine/judges/systemone.js";
import { runSuites } from "../../engine/runner.js";
import { memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
after(() => mock.close());

const KEY = "jev-secret-key-123456";
const SUITE = `version: 1
provider: providers/json.yml
judges:
  default: { kind: systemone, endpoint: "{{base_url}}/systemone" }
tests:
  - name: t
    turns:
      - user: a refund for 4417
        expect:
          - { type: status, equals: 200 }
          - { type: systemone.noul, question: "Does the reply ask why?", min: 0.8 }
          - { type: systemone.choice, question: "What does it offer?", options: [refund, replacement], equals: refund }
`;
const PROVIDER = "kind: http\nurl: \"{{base_url}}/json\"\nbody: { message: \"{{user}}\" }\nresponse: { text: $.data.reply }\n";

describe("System One's request", () => {
  it("is on its call's step, all of it, its key hidden; and reaches the page before the call ends", async () => {
    const host = memoryHost({ "s.hafen.yml": SUITE, "providers/json.yml": PROVIDER }, { secrets: { JEV_API_KEY: KEY } });
    const events = [];
    // (as the page gets them: a copy as each is sent)
    const run = await runSuites({ suites: [await loadSuite(host, "s.hafen.yml")], host, options: { vars: { base_url: mock.url } }, onEvent: (e) => events.push(structuredClone(e)) });
    assert.deepEqual(run.turns[0].results.map((r) => r.status), ["pass", "pass", "pass"]);
    const call = run.spans.find((s) => s.kind === "judge_call");
    assert.deepEqual(call.ref, { checks: [1, 2] });
    assert.equal(call.request.method, "POST");
    assert.equal(call.request.url, `${mock.url}/systemone/v1/systemone`);
    assert.deepEqual(call.request.headers, { "content-type": "application/json", accept: "application/json", authorization: "[redacted]" });
    assert.deepEqual(call.request.body, {
      state: "I'm sorry it arrived broken. Could you tell me why you want a refund for order 4417?",
      model: "jev-latest",
      questions: {
        c1: { type: "noul", instructions: "Does the reply ask why?" },
        c2: { type: "choice", instructions: "What does it offer?", criteria: { refund: "refund", replacement: "replacement" } },
      },
    });
    // What was sent is what's shown (but its key)
    const sent = mock.log.find((r) => r.path === "/systemone/v1/systemone");
    assert.deepEqual(sent.body, call.request.body);
    assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
    // The page has it while the call's still going: an update with it, before its end
    const mine = events.filter((e) => e.type === "span" && e.span._id === call._id);
    const withIt = mine.findIndex((e) => e.span.request);
    const ended = mine.findIndex((e) => e.action === "end");
    assert.ok(withIt > -1 && withIt < ended, JSON.stringify(mine.map((e) => [e.action, !!e.span.request, e.span.status])));
    assert.equal(mine[withIt].span.status, "running");
    // The key: nowhere
    assert.ok(!JSON.stringify(run).includes(KEY));
    assert.ok(!JSON.stringify(events).includes(KEY));
  });

  it("hides the key, and every secret value the run used, wherever it is", () => {
    const request = { method: "POST", url: "https://x.example/v1/systemone", headers: { authorization: `Bearer ${KEY}`, "x-extra": "tok-999999" }, body: JSON.stringify({ state: "the code is tok-999999", model: "jev-latest", questions: {} }) };
    const redact = (v) => JSON.parse(JSON.stringify(v).split("tok-999999").join("[redacted]"));
    const shown = shownRequest(request, redact);
    assert.equal(shown.headers.authorization, "[redacted]");
    assert.equal(shown.headers["x-extra"], "[redacted]");
    assert.equal(shown.body.state, "the code is [redacted]");
    // A body that isn't JSON is shown as it is
    assert.equal(shownRequest({ ...request, body: "not json" }).body, "not json");
  });

  it("a check's name with its value (set as its result comes) reaches the page too", async () => {
    const host = memoryHost({ "s.hafen.yml": SUITE, "providers/json.yml": PROVIDER }, { secrets: { JEV_API_KEY: KEY } });
    const events = [];
    await runSuites({ suites: [await loadSuite(host, "s.hafen.yml")], host, options: { vars: { base_url: mock.url } }, onEvent: (e) => events.push(structuredClone(e)) });
    const named = events.filter((e) => e.type === "span" && e.action === "update" && e.span.kind === "check").map((e) => e.span.name);
    assert.ok(named.includes("noul 0.91"), JSON.stringify(named));
  });
});
