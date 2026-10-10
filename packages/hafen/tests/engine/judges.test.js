// Judged checks (docs/checks.md): System One and LLM judges, reference checks, samples and min, unsure
// and confidence, and System One's request as the page sees it.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { junit } from "../../engine/index.js";
import { shownRequest } from "../../engine/judges/systemone.js";
import { casesOf, problemsOf, turnsOf } from "../../engine/reports/outcome.js";
import { runSuites } from "../../engine/runner.js";
import { fakeTransport, memoryHost, MOCK_SSE_PROVIDER, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
beforeEach(() => mock.reset());
after(() => mock.close());

describe("judges", () => {
  const JSON_PROVIDER = `kind: http
url: "{{base_url}}/json"
body: { message: "{{user}}" }
response:
  text: $.data.reply
  usage: { input: $.usage.input_tokens, output: $.usage.output_tokens }
price: { input: 1, output: 2 }
`;

  async function runYaml(suiteYaml, { files = {}, options = {}, secrets = { JEV_API_KEY: "jev-secret-key-1" }, events } = {}) {
    const host = memoryHost({ "s.hafen.yml": suiteYaml, "providers/json.yml": JSON_PROVIDER, "providers/sse.yml": MOCK_SSE_PROVIDER, ...files }, { secrets });
    const suite = await loadSuite(host, "s.hafen.yml");
    assert.deepEqual(suite.errors, [], JSON.stringify(suite.errors));
    assert.deepEqual(suite.missing.filter((m) => m.variable !== "base_url"), []);
    return runSuites({ suites: [suite], host, options: { vars: { base_url: mock.url }, ...options }, onEvent: events ? (e) => events.push(e) : undefined });
  }

  const judges = `judges:
  default: { kind: systemone, endpoint: "{{base_url}}/systemone" }
  rubric: { kind: llm, provider: judge, samples: 3 }
providers:
  judge: { kind: openai-chat, base_url: "{{base_url}}/judge", model: mock-judge, api_key: "" }
`;

  it("System One: noul, choice and score, one request per turn", async () => {
    const run = await runYaml(`version: 1
provider: providers/json.yml
${judges}
tests:
  - name: t
    turns:
      - user: a refund for 4417
        expect:
          - { type: systemone.noul, question: "Does the reply ask why?", min: 0.8 }
          - { type: systemone.choice, question: "What does it offer?", options: [refund, replacement], equals: refund }
          - { type: systemone.score, question: "How helpful?", rubric: [poor, ok, great], min: 2 }
`);
    const [noul, choice, score] = run.turns[0].results;
    assert.equal(noul.status, "pass");
    assert.equal(noul.value, 0.91);
    assert.equal(noul.confidence, 0.82);
    assert.equal(choice.status, "pass");
    assert.equal(choice.actual, "refund");
    assert.equal(score.status, "pass");
    assert.equal(mock.log.filter((r) => r.path === "/systemone/v1/systemone").length, 1);
    assert.equal(mock.log.find((r) => r.path === "/systemone/v1/systemone").headers.authorization, "Bearer jev-secret-key-1");
    // The key is redacted from the record
    assert.ok(!JSON.stringify(run).includes("jev-secret-key-1"));
  });

  it("low confidence on a passing value is unsure, which fails by default and warns or passes when asked", async () => {
    const yaml = `version: 1
provider: providers/json.yml
${judges}
tests:
  - name: t
    turns:
      - user: a refund
        expect:
          - { type: systemone.noul, question: "UNSURE: is it polite?", min: 0.5 }
`;
    const failed = await runYaml(yaml);
    assert.equal(failed.turns[0].results[0].status, "unsure");
    assert.equal(failed.turns[0].results[0].unsure, "fail");
    assert.equal(failed.tests[0].status, "failed");
    assert.equal(failed.verdict, "failed");
    const warned = await runYaml(yaml, { options: { unsure: "warn" } });
    assert.deepEqual([warned.turns[0].results[0].unsure, warned.tests[0].status, warned.tests[0].unsure, warned.verdict], ["warn", "passed", true, "unsure"]);
    const passed = await runYaml(yaml, { options: { unsure: "pass" } });
    assert.deepEqual([passed.turns[0].results[0].unsure, passed.tests[0].status, passed.tests[0].unsure, passed.verdict], ["pass", "passed", false, "passed"]);
  });

  it("a value that misses its criterion fails, however low the confidence, under every policy: never unsure", async () => {
    // (the mock's UNSURE answers: noul 0.55 with confidence 0.1, a choice of refund at 0.4, a score of 2 at 0.3)
    const yaml = `version: 1
provider: providers/json.yml
${judges}
tests:
  - name: t
    turns:
      - user: a refund
        expect:
          - { type: systemone.noul, question: "UNSURE: is it polite?", min: 0.8 }
          - { type: systemone.choice, question: "UNSURE: what does it offer?", options: [refund, replacement], equals: replacement }
          - { type: systemone.score, question: "UNSURE: how helpful?", rubric: [poor, ok, great], max: 1 }
`;
    for (const unsure of [undefined, "fail", "warn", "pass"]) {
      const run = await runYaml(yaml, { options: { unsure } });
      assert.deepEqual(run.turns[0].results.map((r) => [r.status, r.confidence, r.unsure]), [["fail", 0.1, undefined], ["fail", 0.4, undefined], ["fail", 0.3, undefined]], unsure);
      assert.deepEqual(run.turns[0].results.map((r) => r.reason), ["0.55 outside 0.8–1", 'chose "refund", not "replacement"', "scored 2 (great), outside 0–1"]);
      assert.deepEqual([run.tests[0].status, run.verdict], ["failed", "failed"], unsure);
    }
  });

  it("how an unsure result counts: the check's unsure over the test's, the test's over the suite's defaults, --unsure over all", async () => {
    const yaml = (defaults, test, check) => `version: 1
provider: providers/json.yml
${judges}${defaults ? `defaults: { unsure: ${defaults} }\n` : ""}tests:
  - name: t
${test ? `    unsure: ${test}\n` : ""}    turns:
      - user: a refund
        expect:
          - { type: systemone.noul, question: "UNSURE: is it polite?"${check ? `, unsure: ${check}` : ""} }
          - { type: systemone.noul, question: "UNSURE: is it kind?" }
`;
    const counted = async (args, options = {}) => (await runYaml(yaml(...args), { options })).turns[0].results.map((r) => r.unsure);
    assert.deepEqual(await counted([]), ["fail", "fail"]);
    assert.deepEqual(await counted(["warn"]), ["warn", "warn"]);
    assert.deepEqual(await counted(["warn", "pass"]), ["pass", "pass"]);
    assert.deepEqual(await counted(["warn", "pass", "fail"]), ["fail", "pass"]);
    assert.deepEqual(await counted([null, null, "warn"]), ["warn", "fail"]);
    assert.deepEqual(await counted(["pass", "pass", "warn"], { unsure: "fail" }), ["fail", "fail"]);
    // The test: failed when one counts as failed; else unsure when one warns; else passed
    const run = await runYaml(yaml(null, "pass", "warn"));
    assert.deepEqual([run.tests[0].status, run.tests[0].unsure, run.verdict], ["passed", true, "unsure"]);
    assert.equal(run.turns[0].metrics.accuracy, 1);
    const failed = await runYaml(yaml(null, null, "pass"));
    assert.deepEqual([failed.tests[0].status, failed.verdict, failed.turns[0].metrics.accuracy], ["failed", "failed", 0.5]);
  });

  it("an unsure check that counts as failed fails the test however it's written: on the whole conversation too", async () => {
    const run = await runYaml(`version: 1
provider: providers/json.yml
${judges}
tests:
  - name: t
    turns: [ { user: a refund } ]
    expect_conversation:
      - { type: systemone.noul, on: reply, question: "UNSURE: is it polite?" }
`);
    const [r] = run.tests[0].instances[0].conversation_results;
    assert.deepEqual([r.status, r.unsure, run.tests[0].status], ["unsure", "fail", "failed"]);
    const warned = await runYaml(`version: 1
provider: providers/json.yml
${judges}
tests:
  - name: t
    unsure: warn
    turns: [ { user: a refund } ]
    expect_conversation:
      - { type: systemone.noul, on: reply, question: "UNSURE: is it polite?" }
`);
    assert.deepEqual([warned.tests[0].status, warned.tests[0].unsure, warned.verdict], ["passed", true, "unsure"]);
  });

  it("an unreachable judge is an error, not a failure", async () => {
    const run = await runYaml(`version: 1
provider: providers/json.yml
judges:
  default: { kind: systemone, endpoint: "http://127.0.0.1:1" }
tests:
  - name: t
    turns:
      - user: hi
        expect: [ { type: systemone.noul, question: "ok?" } ]
`);
    assert.equal(run.turns[0].results[0].status, "error");
    assert.equal(run.tests[0].status, "error");
  });

  it("LLM judges: rubric criteria, sample agreement as confidence", async () => {
    const run = await runYaml(`version: 1
provider: providers/json.yml
${judges}
tests:
  - name: t
    turns:
      - user: a refund
        expect:
          - { type: judge, judge: rubric, rubric: [Asks why, Mentions the order] }
          - { type: judge, judge: rubric, rubric: [Apologises, "NOT-MET: offers a discount"], min: 1 }
          - { type: judge, judge: rubric, rubric: ["FLAKY criterion"] }
`, { options: {} });
    const [good, bad, flaky] = run.turns[0].results;
    assert.equal(good.status, "pass");
    assert.equal(good.confidence, 1);
    assert.equal(bad.status, "fail");
    assert.match(bad.reason, /not met: NOT-MET/);
    assert.ok(flaky.confidence < 1 && flaky.confidence > 0.5, `confidence ${flaky.confidence}`);
    assert.equal(flaky.judge.samples.length, 3);
  });
});

// The judge: an LLM over HTTP whose reply is { text, in, out }. It reads the criteria from the prompt
// and meets each unless it says NOT-MET; FLAKY ones are met on the 1st and 2nd asking, not the 3rd;
// GARBLE-ONCE gets an answer that isn't JSON the first time; GARBLE gets one every time. A reference
// check is met unless its reference says WRONG.
function judgeAnswer(prompt, state) {
  const criteria = [];
  const lines = prompt.split("\n");
  const at = lines.indexOf("Criteria:");
  if (at >= 0) for (const line of lines.slice(at + 1)) { const m = /^\d+\. (.*)$/.exec(line); if (!m) break; criteria.push(m[1]); }
  if (prompt.includes("Reference answer:")) {
    const reference = prompt.split("Reference answer:\n<<<\n")[1].split("\n>>>")[0];
    return JSON.stringify({ criteria: [{ criterion: "same meaning as the reference", met: !/WRONG/.test(reference), reason: "compared" }] });
  }
  const key = criteria.join("|");
  state.asked.set(key, (state.asked.get(key) ?? 0) + 1);
  const n = state.asked.get(key);
  if (criteria.some((c) => c.includes("GARBLE-ONCE")) && n === 1) return "I think it's fine.";
  if (criteria.some((c) => /GARBLE(?!-ONCE)/.test(c))) return "no JSON here";
  return `Here: ${JSON.stringify({ criteria: criteria.map((c) => ({ criterion: c, met: !/NOT-MET/.test(c) && !(/FLAKY/.test(c) && n % 3 === 0), reason: "looked" })) })}`;
}

function router({ systemone } = {}) {
  const state = { asked: new Map(), judged: 0 };
  const transport = fakeTransport((req) => {
    if (req.url.startsWith("http://judge.example/")) {
      state.judged++;
      if (req.url.endsWith("/down")) return { status: 500, body: '{"error":"overloaded"}' };
      return { body: JSON.stringify({ text: judgeAnswer(JSON.parse(req.body).prompt, state), in: 7, out: 3 }) };
    }
    if (req.url.startsWith("http://systemone.example/")) return { body: JSON.stringify(systemone(JSON.parse(req.body))) };
    return { body: JSON.stringify({ data: { reply: `You said: ${JSON.parse(req.body).message}` } }) };
  });
  return { transport, state };
}

const HEAD = `version: 1
provider: { kind: http, url: "http://chat.example/chat", body: { message: "{{user}}" }, response: { text: $.data.reply } }
providers:
  judge-llm: { kind: http, url: "http://judge.example/chat", body: { prompt: "{{user}}" }, response: { text: $.text, usage: { input: $.in, output: $.out } }, price: { input: 1, output: 2 } }
  judge-down: { kind: http, url: "http://judge.example/down", retries: 0, body: { prompt: "{{user}}" }, response: { text: $.text } }
judges:
  default: { kind: llm, provider: judge-llm }
  down: { kind: llm, provider: judge-down }
  one: { kind: llm, provider: judge-llm, samples: 1 }
  s1: { kind: systemone, endpoint: "http://systemone.example", api_key: "" }
`;
const suite = (tests, head = HEAD) => `${head}tests:\n${tests}`;

async function run(yaml, { systemone, options = {} } = {}) {
  const { transport, state } = router({ systemone });
  const host = memoryHost({ "s.hafen.yml": yaml }, { transport });
  const loaded = await loadSuite(host, "s.hafen.yml");
  assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
  const out = await runSuites({ suites: [loaded], host, options });
  return { run: out, state, results: out.turns.flatMap((t) => t.results ?? []) };
}

describe("reference checks", () => {
  it("pass when the reply means the same as the reference (default min 0.8), fail when it doesn't; the value is the similarity", async () => {
    const { run: r, results } = await run(suite(`  - name: same
    turns:
      - user: a refund for 4417
        expect:
          - { type: reference, reference: "You said: a refund for 4417" }
          - { type: reference, reference: "WRONG: we don't do refunds" }
`));
    const [same, wrong] = results;
    assert.deepEqual([same.status, same.value, same.confidence], ["pass", 1, 1]);
    assert.deepEqual([wrong.status, wrong.value], ["fail", 0]);
    assert.match(wrong.reason, /not met: same meaning as the reference/);
    assert.equal(r.tests[0].status, "failed");
  });

  it("a reference check with no reference answer is a problem before anything is sent; run anyway, an error, not a pass", async () => {
    const { transport, state } = router();
    const host = memoryHost({ "s.hafen.yml": suite(`  - name: none
    turns: [ { user: hi, expect: [ { type: reference, min: 0.5 } ] } ]
`) }, { transport });
    const loaded = await loadSuite(host, "s.hafen.yml");
    const why = "a reference check needs reference (the expected answer)";
    assert.deepEqual(loaded.errors, [{ file: "s.hafen.yml", line: 13, column: 36, message: why }]);
    const stopped = await runSuites({ suites: [loaded], host });
    assert.equal(stopped.status, "error");
    assert.equal(transport.requests.length, 0);
    // (the run's own guard: a suite that skipped loading's check, as the app's one-check run could)
    const out = await runSuites({ suites: [{ ...loaded, errors: [] }], host });
    const [result] = out.turns.flatMap((t) => t.results);
    assert.deepEqual([result.status, result.reason], ["error", why]);
    assert.equal(state.judged, 0);
  });
});

describe("LLM judges", () => {
  it("an answer that doesn't parse is asked again once (its step says so), and the second answer counts", async () => {
    const { run: r, results, state } = await run(suite(`  - name: garbled once
    turns: [ { user: hi, expect: [ { type: judge, judge: one, rubric: [GARBLE-ONCE but polite] } ] } ]
`));
    assert.equal(results[0].status, "pass", results[0].reason);
    assert.equal(state.judged, 2, "asked twice for one sample");
    assert.deepEqual(r.spans.filter((s) => s.kind === "judge_call").map((s) => s.name), ["judge-llm · sample 1", "judge-llm · sample 1 (again)"]);
  });

  it("an answer that doesn't parse twice: the check is an error (not a failure), and the test errors", async () => {
    const { run: r, results, state } = await run(suite(`  - name: garbled
    turns: [ { user: hi, expect: [ { type: judge, judge: one, rubric: [GARBLE always] } ] } ]
`));
    assert.deepEqual([results[0].status, results[0].reason], ["error", "the judge didn't answer with JSON"]);
    assert.equal(state.judged, 2, "once, then once more: no more");
    assert.equal(r.tests[0].status, "error");
  });

  it("a judge that fails (its endpoint answers 500) makes the check an error, never a pass or a fail", async () => {
    // (what the reason says is held in scratch/failing/judge-error-reason.test.js: it says "didn't
    // answer with JSON", not the judge's own error)
    const { run: r, results } = await run(suite(`  - name: down
    turns: [ { user: hi, expect: [ { type: judge, judge: down, samples: 1, rubric: [polite] } ] } ]
`));
    assert.equal(results[0].status, "error");
    assert.equal(r.tests[0].status, "error");
  });

  it("the judge's tokens and cost are counted on the check (every sample's), at the judge provider's price", async () => {
    const { results, state } = await run(suite(`  - name: counted
    turns: [ { user: hi, expect: [ { type: judge, rubric: [polite, short] } ] } ]
`));
    assert.equal(state.judged, 3, "3 samples by default");
    assert.deepEqual(results[0].usage, { input: 21, output: 9 });
    assert.equal(results[0].cost, (21 * 1 + 9 * 2) / 1e6);
    assert.deepEqual(results[0].judge.samples.length, 3);
  });

  it("samples: the check's, else the judge's, else 3", async () => {
    for (const [check, judge, calls] of [["samples: 5, ", "", 5], ["", "judge: one, ", 1], ["samples: 2, ", "judge: one, ", 2]]) {
      const { state } = await run(suite(`  - name: sampled
    turns: [ { user: hi, expect: [ { type: judge, ${check}${judge}rubric: [polite] } ] } ]
`));
      assert.equal(state.judged, calls, `${check}${judge}`);
    }
  });

  it("min: the share of criteria a sample must meet (default 1, every one); the value is criteria met ÷ criteria", async () => {
    const { results } = await run(suite(`  - name: half
    turns:
      - user: hi
        expect:
          - { type: judge, judge: one, rubric: [polite, NOT-MET offers a discount] }
          - { type: judge, judge: one, rubric: [polite, NOT-MET offers a discount], min: 0.5 }
`));
    assert.deepEqual(results.map((x) => [x.status, x.value]), [["fail", 0.5], ["pass", 0.5]]);
  });

});

describe("a rubric with no judge, at run time", () => {
  it("no default judge: the check is an error that says to name one; a System One judge can't grade a rubric", async () => {
    const head = HEAD.replace("  default: { kind: llm, provider: judge-llm }\n", "");
    const { results } = await run(suite(`  - name: no judge
    turns:
      - user: hi
        expect:
          - { type: judge, rubric: [polite] }
          - { type: judge, judge: s1, rubric: [polite] }
`, head));
    assert.equal(results[0].status, "error");
    assert.match(results[0].reason, /this check needs a judge: name an LLM judge/);
    assert.equal(results[1].status, "error");
    assert.match(results[1].reason, /the judge "s1" can't grade a rubric \(it's systemone\)/);
  });
});

describe("unsure (docs/checks.md, Unsure)", () => {
  // A FLAKY criterion: 2 of 3 samples meet it, so the verdict (pass) has confidence 2/3
  const flaky = (extra = "", check = "") => suite(`  - name: flaky
${extra}    turns: [ { user: hi, expect: [ { type: judge, rubric: [FLAKY polite]${check} } ] } ]
`);

  it("a confidence of 2/3 is above the default 0.6: pass, not unsure", async () => {
    const { run: r, results } = await run(flaky());
    assert.deepEqual([results[0].status, results[0].confidence], ["pass", 0.667]);
    assert.equal(r.verdict, "passed");
  });

  it("the check's unsure_below over it: unsure; the test's unsure_below the same; fail (the default) fails the test, saying so", async () => {
    const byCheck = await run(flaky("", ", unsure_below: 0.7"));
    assert.equal(byCheck.results[0].status, "unsure");
    assert.match(byCheck.results[0].reason, /^2\/3 samples agree · .*, but confidence 0\.667 is below 0\.7$/);
    assert.equal(byCheck.run.tests[0].status, "failed");
    assert.equal(byCheck.run.verdict, "failed");
    const byTest = await run(flaky("    unsure_below: 0.7\n"));
    assert.equal(byTest.results[0].status, "unsure");
    // (the check's own wins over the test's)
    const both = await run(flaky("    unsure_below: 0.7\n", ", unsure_below: 0.5"));
    assert.equal(both.results[0].status, "pass");
  });

  it("the test's unsure: warn passes it with a warning (the run's verdict unsure); pass passes it quietly (the run passed, not unsure); fail fails it", async () => {
    const warned = await run(flaky("    unsure_below: 0.7\n    unsure: warn\n"));
    assert.equal(warned.run.tests[0].status, "passed");
    assert.equal(warned.run.verdict, "unsure");
    const passed = await run(flaky("    unsure_below: 0.7\n    unsure: pass\n"));
    assert.equal(passed.results[0].status, "unsure");
    assert.equal(passed.run.tests[0].status, "passed");
    assert.equal(passed.run.verdict, "passed");
    const failed = await run(flaky("    unsure_below: 0.7\n    unsure: fail\n"));
    assert.equal(failed.run.tests[0].status, "failed");
    assert.equal(failed.run.verdict, "failed");
    // (the suite's defaults say it for every test; the check's own, over the test's)
    const byDefault = await run(flaky().replace("tests:\n", "defaults: { unsure: warn, unsure_below: 0.7 }\ntests:\n"));
    assert.equal(byDefault.run.tests[0].status, "passed");
    const byCheck = await run(flaky("    unsure_below: 0.7\n    unsure: fail\n", ", unsure: warn"));
    assert.deepEqual([byCheck.results[0].unsure, byCheck.run.tests[0].status, byCheck.run.verdict], ["warn", "passed", "unsure"]);
  });

});

describe("System One's bounds", () => {
  const systemone = ({ questions }) => ({
    model: "jev-test",
    answers: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k,
      q.type === "noul" ? { noul: 0.7, confidence: 0.9 }
        : q.type === "score" ? { score: 2, confidence: 0.8 }
          : { choice: "replacement", confidence: 0.9, probabilities: { refund: 0.1, replacement: 0.9 } }])),
    usage: { input_tokens: 10, output_tokens: 3 },
  });

  it("noul within min–max (max too); score within min–max of its rubric's levels; choice among the acceptable options (one or a list)", async () => {
    const { results, run: r } = await run(suite(`  - name: bounds
    turns:
      - user: hi
        expect:
          - { type: systemone.noul, judge: s1, question: "Kind?", min: 0.5, max: 0.8 }
          - { type: systemone.noul, judge: s1, question: "Kind?", max: 0.6 }
          - { type: systemone.score, judge: s1, question: "Helpful?", min: 2 }
          - { type: systemone.score, judge: s1, question: "Helpful?", rubric: [poor, ok, great], max: 1 }
          - { type: systemone.choice, judge: s1, question: "Offer?", options: [refund, replacement], equals: refund }
          - { type: systemone.choice, judge: s1, question: "Offer?", options: [refund, replacement], equals: [refund, replacement] }
`), { systemone });
    assert.deepEqual(results.map((x) => x.status), ["pass", "fail", "pass", "fail", "fail", "pass"]);
    assert.match(results[1].reason, /0\.7 outside 0\.5–0\.6/);
    assert.match(results[3].reason, /scored 2 \(great\), outside 0–1/);
    assert.match(results[4].reason, /chose "replacement", not "refund"/);
    assert.equal(results[5].value, 0.9, "a choice's value is the chosen option's probability");
    // One request for the turn's six questions
    assert.equal(r.spans.filter((s) => s.kind === "judge_call").length, 1);
  });

  it("a choice needs two options or more: a problem in the file, before anything is sent", async () => {
    const { transport } = router({ systemone });
    const host = memoryHost({ "s.hafen.yml": suite(`  - name: one option
    turns: [ { user: hi, expect: [ { type: systemone.choice, judge: s1, question: "Offer?", options: [refund], equals: refund } ] } ]
`) }, { transport });
    const loaded = await loadSuite(host, "s.hafen.yml");
    assert.deepEqual(loaded.errors.map((e) => [e.line, e.message]), [[13, "tests.0.turns.0.expect.0.options: must NOT have fewer than 2 items"]]);
    const r = await runSuites({ suites: [loaded], host });
    assert.equal(r.status, "error");
    assert.equal(transport.requests.length, 0);
  });
});

describe("a judged check's confidence", () => {
  const JSON_PROVIDER = `kind: http
url: "{{base_url}}/json"
body: { message: "{{user}}" }
response: { text: $.data.reply }
`;
  const HEAD = `version: 1
provider: providers/json.yml
judges:
  default: { kind: systemone, endpoint: "{{base_url}}/systemone" }
  rubric: { kind: llm, provider: judge, samples: 3 }
  house: { kind: plugin, plugin: house }
  vague: { kind: plugin, plugin: vague }
providers:
  judge: { kind: openai-chat, base_url: "{{base_url}}/judge", model: mock-judge, api_key: "" }
`;
  // Judge plugins: one that says how sure it is, one that doesn't
  const judgePlugin = (name, confidence) => `export default { kind: "judge", name: "${name}", version: "1.0.0", hosts: [],
  async judge({ input }) { return { value: 0.9, ${confidence === undefined ? "" : `confidence: ${confidence}, `}reason: "looked at " + input.length + " characters" }; } };
`;

  async function load(yaml) {
    const host = memoryHost({
      "s.hafen.yml": yaml, "providers/json.yml": JSON_PROVIDER,
      "plugins/house.js": judgePlugin("house", 0.7), "plugins/vague.js": judgePlugin("vague"),
    }, { secrets: { JEV_API_KEY: "jev-key-12345" } });
    return { host, suite: await loadSuite(host, "s.hafen.yml") };
  }
  async function runYaml(yaml, options = {}) {
    const { host, suite } = await load(yaml);
    assert.deepEqual(suite.errors, [], JSON.stringify(suite.errors));
    return runSuites({ suites: [suite], host, options: { vars: { base_url: mock.url }, ...options } });
  }
  const pick = (r) => [r.status, r.reason, r.confidence];

  it("System One: passes when the value does and the confidence is above it; fails saying both when it isn't (equal isn't above)", async () => {
    const run = await runYaml(`${HEAD}tests:
  - name: t
    turns:
      - user: a refund for 4417
        expect:
          - { type: systemone.noul, question: "Does the reply ask why?", min: 0.8, confidence: 0.5 }
          - { type: systemone.noul, question: "CONFIDENCE=0.42 Does the reply ask why?", min: 0.8, confidence: 0.5 }
          - { type: systemone.noul, question: "CONFIDENCE=0.5 Does the reply ask why?", min: 0.8, confidence: 0.5 }
          - { type: systemone.choice, question: "What does it offer?", options: [refund, replacement], equals: refund, confidence: 0.8 }
          - { type: systemone.choice, question: "What does it offer, again?", options: [refund, replacement], equals: refund, confidence: 0.9 }
          - { type: systemone.score, question: "How helpful?", rubric: [poor, ok, great], min: 2, confidence: 0.85 }
      - user: hello
        expect:
          - { type: systemone.noul, question: "CONFIDENCE=0.42 Does the reply ask why?", confidence: 0.5 }
          - { type: systemone.noul, question: "CONFIDENCE=0.9 Does the reply ask why?", confidence: 0.5 }
`);
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.deepEqual(run.turns[0].results.map(pick), [
      ["pass", "0.91 within 0.8–1", 0.82],
      ["fail", "0.91 within 0.8–1, but confidence 0.42 isn't above 0.5", 0.42],
      ["fail", "0.91 within 0.8–1, but confidence 0.5 isn't above 0.5", 0.5],
      ["pass", 'chose "refund"', 0.86],
      ["fail", 'chose "refund", but confidence 0.86 isn\'t above 0.9', 0.86],
      ["fail", "scored 2 (great), within 2–2, but confidence 0.8 isn't above 0.85", 0.8],
    ]);
    // A value that fails fails, saying the confidence too when it isn't above
    assert.deepEqual(run.turns[1].results.map(pick), [
      ["fail", "0.12 outside 0.5–1, and confidence 0.42 isn't above 0.5", 0.42],
      ["fail", "0.12 outside 0.5–1", 0.9],
    ]);
    // (all asked in one request a turn, as ever)
    assert.equal(mock.log.filter((r) => r.path === "/systemone/v1/systemone").length, 2);
    assert.equal(run.verdict, "failed");
    // The reports and the command line say why, as the result does
    const [c] = casesOf(run);
    assert.equal(c.status, "failed");
    const lines = problemsOf(c.test, turnsOf(run, c.test)).map((p) => p.text);
    assert.ok(lines.includes("turn 1 · noul 0.91: 0.91 within 0.8–1, but confidence 0.42 isn't above 0.5"), lines.join("\n"));
    assert.match(junit(run), /noul 0\.91: 0\.91 within 0\.8–1, but confidence 0\.42 isn(&apos;|')t above 0\.5/);
  });

  it("is never unsure: below unsure_below (the test's, or 0.6) it passes or fails by its own number; a check without it is still unsure", async () => {
    const run = await runYaml(`${HEAD}tests:
  - name: t
    unsure_below: 0.9
    turns:
      - user: a refund for 4417
        expect:
          - { type: systemone.noul, question: "Does the reply ask why?", min: 0.8, confidence: 0.5 }
          - { type: systemone.noul, question: "Does the reply ask why, again?", min: 0.8 }
          - { type: systemone.noul, question: "UNSURE: is it polite?", confidence: 0.05 }
          - { type: systemone.noul, question: "UNSURE: is it polite, again?" }
`);
    assert.deepEqual(run.turns[0].results.map((r) => [r.status, r.confidence]), [["pass", 0.82], ["unsure", 0.82], ["pass", 0.1], ["unsure", 0.1]]);
    assert.equal(run.tests[0].status, "failed");
    assert.equal(run.verdict, "failed", "the two without confidence are unsure, counted as failed (the default)");
  });

  it("an LLM judge's confidence is the share of samples that agree: 2 of 3 is above 0.6, not above 0.7", async () => {
    const run = await runYaml(`${HEAD}tests:
  - name: t
    turns:
      - user: a refund for 4417
        expect:
          - { type: judge, judge: rubric, rubric: "FLAKY one", min: 1, confidence: 0.6 }
          - { type: judge, judge: rubric, rubric: "FLAKY two", min: 1, confidence: 0.7 }
          - { type: reference, judge: rubric, reference: "same thing", confidence: 0.9 }
`);
    const [six, seven, reference] = run.turns[0].results;
    assert.deepEqual([six.status, six.confidence], ["pass", 0.667]);
    assert.deepEqual([seven.status, seven.confidence], ["fail", 0.667]);
    assert.match(seven.reason, /^2\/3 samples agree · .*, but confidence 0\.667 isn't above 0\.7$/);
    assert.deepEqual([reference.status, reference.confidence], ["pass", 1]);
  });

  it("a judge that gives no confidence: the check is an error saying so (without confidence: as ever)", async () => {
    const run = await runYaml(`${HEAD}tests:
  - name: t
    turns:
      - user: a refund for 4417
        expect:
          - { type: systemone.choice, question: "NO-CONFIDENCE what does it offer?", options: [refund, replacement], equals: refund, confidence: 0.5 }
          - { type: systemone.choice, question: "NO-CONFIDENCE what does it offer, again?", options: [refund, replacement], equals: refund }
          - { type: judge, judge: vague, question: "Is it kind?", confidence: 0.5 }
          - { type: judge, judge: house, question: "Is it kind?", confidence: 0.5 }
          - { type: judge, judge: house, question: "Is it kind, really?", confidence: 0.75 }
`);
    const [none, without, vague, house, houseHigh] = run.turns[0].results;
    assert.deepEqual([none.status, none.reason, none.actual], ["error", 'the judge gave no confidence, so confidence: 0.5 can\'t be checked (chose "refund")', "refund"]);
    assert.deepEqual([without.status, without.confidence], ["pass", undefined]);
    assert.equal(vague.status, "error");
    assert.match(vague.reason, /^the judge gave no confidence, so confidence: 0\.5 can't be checked/);
    assert.deepEqual(pick(house), ["pass", "looked at 84 characters", 0.7]);
    assert.deepEqual(pick(houseHigh), ["fail", "looked at 84 characters, but confidence 0.7 isn't above 0.75", 0.7]);
    assert.equal(run.tests[0].status, "failed");
  });

  it("a number from 0 to just under 1, on a judged check, without unsure_below: anything else is a problem where it's written, before anything is sent", async () => {
    const { host, suite } = await load(`${HEAD}tests:
  - name: t
    turns:
      - user: a refund
        expect:
          - { type: systemone.noul, question: "q?", confidence: 1.5 }
          - { type: systemone.noul, question: "q?", confidence: 1 }
          - { type: systemone.noul, question: "q?", confidence: -0.1 }
          - { type: systemone.noul, question: "q?", confidence: high }
`);
    assert.deepEqual(suite.errors.map((e) => [e.line, e.column, e.message]), [
      [15, 65, "tests.0.turns.0.expect.0.confidence: must be < 1"],
      [16, 65, "tests.0.turns.0.expect.1.confidence: must be < 1"],
      [17, 65, "tests.0.turns.0.expect.2.confidence: must be >= 0"],
      [18, 65, "tests.0.turns.0.expect.3.confidence: must be number"],
    ]);
    const run = await runSuites({ suites: [suite], host, options: { vars: { base_url: mock.url } } });
    assert.equal(run.status, "error");
    assert.equal(run.error.all.length, 4);
    // On a check that has no confidence (a rule check), or with an unsure_below it'd make do nothing
    const other = await load(`${HEAD}tests:
  - name: t
    turns:
      - user: a refund
        expect:
          - { contains: "refund", confidence: 0.5 }
          - { type: contains, value: refund, confidence: 0.5 }
          - { type: systemone.noul, question: "q?", confidence: 0.5, unsure_below: 0.7 }
          - { type: systemone.noul, question: "q?", confidence: 0.5, unsure: warn }
          - { type: house-check, confidence: 0.5 }
    expect_conversation:
      - { type: tool.not_called, tool: refund, confidence: 0.5 }
`);
    assert.deepEqual(other.suite.errors.map((e) => [e.line, e.column, e.message]), [
      [15, 47, "confidence is for judged checks (systemone.noul, systemone.choice, systemone.score, judge, reference): a text check has none"],
      [16, 58, "confidence is for judged checks (systemone.noul, systemone.choice, systemone.score, judge, reference): a contains check has none"],
      [17, 84, "a check with confidence passes or fails by it (it's never unsure), so its unsure_below does nothing: take one of them out"],
      [18, 78, "a check with confidence passes or fails by it (it's never unsure), so its unsure does nothing: take one of them out"],
      [21, 60, "confidence is for judged checks (systemone.noul, systemone.choice, systemone.score, judge, reference): a tool.not_called check has none"],
    ]);
    const refused = await runSuites({ suites: [other.suite], host: other.host, options: { vars: { base_url: mock.url } } });
    assert.equal(refused.status, "error");
    assert.equal(mock.log.length, 0, "nothing was sent");
  });
});

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
