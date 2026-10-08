// A data row's name (contracts/test-file.md, data: row_name): its first column's value (a CSV file's
// header order, a JSON line's first key), or the test's row_name filled in with the row; on one line,
// cut at 60 characters; none when it's empty, or when row_name can't be filled in (the row still runs).
// Recorded on each run of the row (and its turns and fixtures), said wherever the row is ("row 3: a
// refund please"), and redacted as the rest of the run is, in every report and event. A run file from
// before row names says "row 3". The check before a run says a row_name on a test with no data file,
// one with a secret in it, and a column its data file hasn't.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { firstCell, readData, rowLabel, rowNameText } from "../../engine/files/data.js";
import { loadSuite } from "../../engine/files/suite-file.js";
import { jsonSummary } from "../../engine/reports/json.js";
import { junit } from "../../engine/reports/junit.js";
import { markdown } from "../../engine/reports/markdown.js";
import { parseRun, serializeRun } from "../../engine/reports/run-file.js";
import { preflight, runSuites } from "../../engine/runner.js";
import { fakeTransport, memoryHost } from "../helpers.js";

const SECRET = "sk-live-5150abcd";
// (its key a secret, so the run knows it: a data cell that holds it is redacted)
const PROVIDER = `provider: { kind: http, url: "http://x.example/chat", headers: { x-key: "{{secret.API_KEY}}" }, body: { m: "{{user}}" }, response: { text: $.reply } }`;
const suite = (tests, head = "") => `version: 1\nname: Orders\n${head}${PROVIDER}\ntests:\n${tests}`;
const ORDERS = "question,order\na refund for 4417,4417\n\"  where is\nmy   parcel  \",4418\n,4419\n";

// A run of the files, its replies the message (or reply(message)): { run, events, transport }
async function runFiles(files, { reply = (m) => m, secrets = { API_KEY: SECRET } } = {}) {
  const transport = fakeTransport((req) => ({ body: JSON.stringify({ reply: reply(JSON.parse(req.body).m) }) }));
  const host = memoryHost(files, { secrets, transport });
  const suites = [];
  for (const f of Object.keys(files).filter((f) => f.endsWith(".hafen.yml"))) suites.push(await loadSuite(host, f));
  const events = [];
  const run = await runSuites({ suites, host, onEvent: (e) => events.push(e) });
  return { run, events, transport };
}
const caseNames = (xml) => [...xml.matchAll(/<testcase [^>]*name="([^"]*)"/g)].map((m) => m[1]);
const rowSpans = (run) => run.spans.filter((s) => s.kind === "row").map((s) => s.name);
// Where a text is in a file (its first after `after`): "line:column"
const where = (text, needle, after = "") => {
  const before = text.slice(0, text.indexOf(needle, text.indexOf(after)));
  return `${before.split("\n").length}:${before.length - before.lastIndexOf("\n")}`;
};

describe("a row's name, as it's said", () => {
  it("on one line, at most 60 characters (cut with …); empty is none", () => {
    assert.equal(rowNameText("  a refund\n  please\t "), "a refund please");
    assert.equal(rowNameText("x".repeat(60)), "x".repeat(60));
    assert.equal(rowNameText("x".repeat(61)), `${"x".repeat(59)}…`);
    assert.equal([...rowNameText("é".repeat(80))].length, 60);
    // (the cut doesn't leave a space before the …)
    assert.equal(rowNameText(`${"a".repeat(58)} bcd`), `${"a".repeat(58)}…`);
    for (const none of ["", "   \n ", null, undefined]) assert.equal(rowNameText(none), undefined);
    assert.equal(rowNameText(4417), "4417");
    assert.equal(rowNameText({ id: 1 }), '{"id":1}');
    assert.equal(rowLabel(3, "a refund please"), "row 3: a refund please");
    assert.equal(rowLabel(3, undefined), "row 3");
  });

  it("the first column: a CSV file's by its header's order, a JSON line's first key", () => {
    // (a column named "1" would come first among an object's keys: the header says it's second)
    const csv = readData("question,1\nhi,x\n", "d.csv");
    assert.deepEqual(csv.columns, ["question", "1"]);
    assert.equal(firstCell(csv.rows[0], csv), "hi");
    const lines = readData('{"b":1,"a":2}\n{"a":3,"c":4}\n', "d.jsonl");
    assert.deepEqual(lines.columns, ["b", "a", "c"]);
    assert.deepEqual(lines.rows.map((r) => firstCell(r, lines)), [1, 3]);
  });
});

describe("each row's name, in the run and every report", () => {
  it("without row_name: its first column's value (CSV and JSON lines), on its runs, turns and steps; an empty one is none", async () => {
    const { run } = await runFiles({
      "data/orders.csv": ORDERS,
      "data/orders.jsonl": '{"question":"hi","order":1}\n{"order":2,"question":"bye"}\n',
      "s.hafen.yml": suite(`  - name: orders
    data: data/orders.csv
    turns: [ { user: "order {{row.order}}", expect: [ { contains: "4417" } ] } ]
  - name: lines
    data: data/orders.jsonl
    turns: [ { user: "{{row.question}}", expect: [ { contains: "i" } ] } ]
`),
    });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    const [orders, lines] = run.tests;
    assert.deepEqual(orders.instances.map((i) => i.row_name), ["a refund for 4417", "where is my parcel", undefined]);
    assert.ok(!("row_name" in orders.instances[2]), "none: not there at all");
    assert.deepEqual(lines.instances.map((i) => i.row_name), ["hi", "2"]);
    assert.deepEqual(run.turns.map((t) => t.row_name), ["a refund for 4417", "where is my parcel", undefined, "hi", "2"]);
    assert.deepEqual(rowSpans(run), ["row 1: a refund for 4417", "row 2: where is my parcel", "row 3", "row 1: hi", "row 2: 2"]);
    // JUnit: a case each row, its number and its name; the reports say where it went wrong the same way
    const xml = junit(run);
    assert.deepEqual(caseNames(xml), ["orders [row 1: a refund for 4417]", "orders [row 2: where is my parcel]", "orders [row 3]", "lines [row 1: hi]", "lines [row 2: 2]"]);
    assert.match(xml, /<failure message="contains 4417: didn&apos;t find 4417" type="check">row 2: where is my parcel · turn 1 · contains 4417/);
    assert.match(markdown(run), /- \*\*Orders › orders\*\* · row 2: where is my parcel · turn 1 · failed · `contains 4417`/);
    assert.match(markdown(run), /- \*\*Orders › orders\*\* · row 3 · turn 1 · failed/);
    const json = JSON.parse(jsonSummary(run));
    assert.deepEqual(json.tests[0].problems.map((p) => [p.row, p.row_name, p.turn]), [[2, "where is my parcel", 0], [3, null, 0]]);
    assert.deepEqual(json.results.filter((r) => r.test === "orders").map((r) => r.row_name), ["a refund for 4417", "where is my parcel", null]);
  });

  it("row_name: a template filled in with the row, the suite's variables and the environment's values, cut at 60; one that can't be filled in is none, and the row runs", async () => {
    const long = "x".repeat(80);
    const { run } = await runFiles({
      "data/orders.csv": `question,order\na refund for 4417,4417\n${long},4418\n`,
      "data/sparse.jsonl": '{"q":"hi","order":1}\n{"q":"bye"}\n',
      "s.hafen.yml": suite(`  - name: orders
    data: data/orders.csv
    row_name: "{{row.question}} ({{row.order}}, {{shop}}, {{env.region}})"
    turns: [ { user: "{{row.question}}", expect: [ { contains: "e" } ] } ]
  - name: sparse
    data: data/sparse.jsonl
    row_name: "{{row.q}} #{{row.order}}"
    turns: [ { user: "{{row.q}}", expect: [ { contains: "e" } ] } ]
`, "variables: { shop: Acme }\nenvironments: { local: { region: eu } }\n"),
    });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.deepEqual(run.tests[0].instances.map((i) => i.row_name), ["a refund for 4417 (4417, Acme, eu)", `${"x".repeat(59)}…`]);
    // (a row the template can't be filled in for: no name, never an error of its own)
    assert.deepEqual(run.tests[1].instances.map((i) => [i.row_name, i.status]), [["hi #1", "failed"], [undefined, "passed"]]);
    assert.deepEqual(caseNames(junit(run)).slice(2), ["sparse [row 1: hi #1]", "sparse [row 2]"]);
  });

  it("a secret in a data cell is redacted in the name: in the run file, JUnit, the Markdown, the JSON and every event", async () => {
    const { run, events } = await runFiles({
      "data/keys.csv": `question\nmy key is ${SECRET}\nhello\n`,
      "s.hafen.yml": suite(`  - name: keys
    data: data/keys.csv
    repeat: 2
    turns: [ { user: "{{row.question}}", expect: [ { contains: nope } ] } ]
`),
    });
    assert.equal(run.status, "done", JSON.stringify(run.error));
    assert.deepEqual(run.tests[0].instances.map((i) => i.row_name), ["my key is [redacted]", "hello", "my key is [redacted]", "hello"]);
    const reports = { "the run file": serializeRun(run), JUnit: junit(run), "the Markdown": markdown(run), "the JSON": jsonSummary(run), "the events": JSON.stringify(events) };
    for (const [what, text] of Object.entries(reports)) assert.ok(!text.includes(SECRET), `${what} has the secret`);
    assert.ok(caseNames(reports.JUnit).includes("keys [row 1: my key is [redacted]]"));
    assert.match(reports["the Markdown"], /row 1: my key is \[redacted\] · run 2 · turn 1 · failed/);
    // (the row's step as it started: before the turn that sends the secret)
    const started = events.find((e) => e.type === "span" && e.action === "start" && e.span.kind === "row");
    assert.equal(started.span.name, "row 1: my key is [redacted] · run 1");
    const turnStart = events.find((e) => e.type === "turn:start");
    assert.equal(turnStart.key.row_name, "my key is [redacted]");
  });

  it("a run file from before row names: each row said by its number", async () => {
    const { run } = await runFiles({
      "data/orders.csv": ORDERS,
      "s.hafen.yml": suite(`  - name: orders
    data: data/orders.csv
    turns: [ { user: "order {{row.order}}", expect: [ { contains: "4417" } ] } ]
`),
    });
    const old = parseRun(JSON.stringify(JSON.parse(serializeRun(run), (k, v) => (k === "row_name" ? undefined : v))));
    assert.ok(!serializeRun(old).includes("row_name"));
    assert.deepEqual(caseNames(junit(old)), ["orders [row 1]", "orders [row 2]", "orders [row 3]"]);
    assert.match(markdown(old), /- \*\*Orders › orders\*\* · row 2 · turn 1 · failed/);
    assert.deepEqual(JSON.parse(jsonSummary(old)).tests[0].problems.map((p) => [p.row, p.row_name]), [[2, null], [3, null]]);
  });
});

describe("the check before a run: row_name", () => {
  const check = async (files) => {
    const host = memoryHost(files, { secrets: { API_KEY: SECRET } });
    const out = await preflight({ suites: [await loadSuite(host, "s.hafen.yml")], host });
    out.close();
    return out.problems.map((p) => `${p.file}:${p.line}:${p.column}  ${p.message}`);
  };

  it("on a test with no data file: said (and only that)", async () => {
    const text = suite(`  - name: plain
    row_name: "{{row.question}}"
    turns: [ { user: hi, expect: [ { contains: hi } ] } ]
`);
    assert.deepEqual(await check({ "s.hafen.yml": text }), [`s.hafen.yml:${where(text, "row_name")}  tests.0.row_name: row_name names a data row: this test has no data file (data)`]);
  });

  it("with a secret in it: said where it's written (a row's name is in every report)", async () => {
    const text = suite(`  - name: orders
    data: data/orders.csv
    row_name: "{{row.question}} {{secret.API_KEY}}"
    turns: [ { user: hi, expect: [ { contains: hi } ] } ]
`);
    assert.deepEqual(await check({ "s.hafen.yml": text, "data/orders.csv": ORDERS }), [`s.hafen.yml:${where(text, "{{secret.API_KEY}}", "row_name")}  tests.0.row_name: a row's name can't hold a secret ({{secret.API_KEY}}): it's shown in every report`]);
  });

  it("a column the data file hasn't: said where it's written, with the one it most likely meant; a variable nothing sets, as anywhere; nothing is sent", async () => {
    const text = suite(`  - name: orders
    data: data/orders.csv
    row_name: "{{row.qestion}} {{row.zzz}} {{row.order}}"
    turns: [ { user: hi, expect: [ { contains: hi } ] } ]
  - name: lines
    data: { file: data/orders.jsonl }
    row_name: "{{row.ordr}} {{nowhere}}"
    turns: [ { user: hi, expect: [ { contains: hi } ] } ]
`);
    const files = { "s.hafen.yml": text, "data/orders.csv": ORDERS, "data/orders.jsonl": '{"question":"hi","order":1}\n' };
    assert.deepEqual(await check(files), [
      `s.hafen.yml:${where(text, "{{row.qestion}}")}  tests.0.row_name: {{row.qestion}} isn't a column of data/orders.csv (did you mean {{row.question}}?)`,
      `s.hafen.yml:${where(text, "{{row.zzz}}")}  tests.0.row_name: {{row.zzz}} isn't a column of data/orders.csv (its columns: question, order)`,
      `s.hafen.yml:${where(text, "{{row.ordr}}")}  tests.1.row_name: {{row.ordr}} isn't a column of data/orders.jsonl (did you mean {{row.order}}?)`,
      `s.hafen.yml:${where(text, '"{{row.ordr}}')}  {{nowhere}} isn't set anywhere before it's used (variables, environments, an extract or a setup step)`,
    ]);
    const { run, transport } = await runFiles(files);
    assert.equal(run.status, "error");
    assert.equal(transport.requests.length, 0);
  });
});
