// Coverage of docs/checks.md, Judged checks: the reference check, an LLM judge's answer that doesn't
// parse (asked again once, then an error), samples and min, the judge's tokens and cost counted on the
// check, unsure_below (the check's, the test's, 0.6) with each `unsure` policy, a rubric with no judge
// to grade it, and System One's score and choice bounds. Against a judge whose answers these tests
// decide (a transport that routes the judge's requests apart from the turn's).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { runSuites } from "../../engine/runner.js";
import { fakeTransport, memoryHost } from "../helpers.js";

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
