// A judged check's confidence (contracts/checks.md, Confidence): `confidence: 0.5` passes the check
// only when its value passes and the judge's confidence is above 0.5; otherwise it fails, saying both.
// A judge that gives none makes it an error. It's never unsure (unsure_below is for the checks without
// it). Against the mock's System One (noul 0.91 for a reply that asks why, its confidence the value's
// distance from 0.5, doubled: 0.82; CONFIDENCE=0.42 in a question, that one) and its LLM judge (FLAKY
// criteria: 2 of 3 samples agree).

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { loadSuite } from "../../engine/files/suite-file.js";
import { runSuites } from "../../engine/runner.js";
import { casesOf, problemsOf, turnsOf } from "../../engine/reports/outcome.js";
import { junit } from "../../engine/index.js";
import { memoryHost, startMock } from "../helpers.js";

let mock;
before(async () => { mock = await startMock({ chunkMs: 1 }); });
after(() => mock.close());
beforeEach(() => mock.reset());

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

describe("a judged check's confidence", () => {
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
