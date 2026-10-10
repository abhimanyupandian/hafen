// The page's own helpers that need no page: "2 mins ago"; a plugin's JavaScript coloured, indented as
// it's typed, and formatted; the run of a test shown when none is picked (the latest); ×3; a data row
// by its name ("row 3: a refund please"); how a run, a test and a turn went, in one set of words (a
// run that broke off before its test included).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatJs, highlightJs, newLine, tokens } from "../../app/js/design/code.js";
import { ago } from "../../app/js/lib/format.js";
import { countedResult, instancesOf, pickedInstance, repeatOf, rowLabel, runName, runOutcome, testResult, testStatusText, turnChecksText, turnStatus, turnsOf } from "../../app/js/views/derive.js";
import { pluginTemplate } from "hafen/engine/plugin-templates.js";

describe("ago", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const before = (s) => now - s * 1000;
  it("in words, rounded, singular and plural", () => {
    assert.equal(ago(now, now), "just now");
    assert.equal(ago(before(44), now), "just now");
    assert.equal(ago(before(45), now), "1 min ago");
    assert.equal(ago(before(89), now), "1 min ago");
    assert.equal(ago(before(120), now), "2 mins ago");
    assert.equal(ago(before(59 * 60), now), "59 mins ago");
    assert.equal(ago(before(3600), now), "1 hour ago");
    assert.equal(ago(before(3 * 3600), now), "3 hours ago");
    assert.equal(ago(before(86400), now), "1 day ago");
    assert.equal(ago(before(2 * 86400), now), "2 days ago");
    assert.equal(ago(before(13 * 86400), now), "13 days ago");
    assert.equal(ago(before(21 * 86400), now), "3 weeks ago");
    assert.match(ago(before(90 * 86400), now), /2026/);
    // (a clock behind the run's: not "in the future")
    assert.equal(ago(now + 5000, now), "just now");
  });
});

describe("JavaScript in the editor", () => {
  it("every character in one token, comments, strings (template ones over lines), numbers, keywords and calls told apart", () => {
    const text = "// a\nconst x = 'it\\'s' + `t\n${y}` / 2.5e3; /* b\nc */ go(1)";
    const toks = tokens(text);
    assert.equal(toks.map((t) => t.text).join(""), text);
    const kinds = toks.filter((t) => t.kind !== "code").map((t) => [t.kind, t.text]);
    assert.deepEqual(kinds, [["comment", "// a"], ["keyword", "const"], ["string", "'it\\'s'"], ["string", "`t\n${y}`"], ["number", "2.5e3"], ["comment", "/* b\nc */"], ["fn", "go"], ["number", "1"]]);
    assert.equal(highlightJs("a < b && c"), "a &lt; b &amp;&amp; c");
    assert.equal(highlightJs('return "<b>"'), '<span class="tok-keyword">return</span> <span class="tok-string">"&lt;b&gt;"</span>');
  });

  it("format: the starting files are left as they are, and come back so from no indenting at all", () => {
    for (const kind of ["provider", "check", "judge"]) {
      const t = pluginTemplate(kind, "acme");
      assert.equal(formatJs(t), t, kind);
      assert.equal(formatJs(t.split("\n").map((l) => l.trimStart()).join("\n")), t, kind);
      assert.equal(formatJs(t.split("\n").map((l) => `      ${l}  `).join("\n")), t, `${kind}, over-indented, spaces at line ends`);
    }
  });

  it("format: several brackets on a line are one level; closers first on a line go back; continued lines; strings and comments over lines kept", () => {
    assert.equal(formatJs("foo({\na: 1,\n});"), "foo({\n  a: 1,\n});");
    assert.equal(formatJs("x = [\n[1,\n2],\n];"), "x = [\n  [1,\n    2],\n];");
    assert.equal(formatJs("const y = a\n.map(f)\n.filter(g);"), "const y = a\n  .map(f)\n  .filter(g);");
    assert.equal(formatJs("const z = ok\n? 1\n: 2;"), "const z = ok\n  ? 1\n  : 2;");
    assert.equal(formatJs("const s = `a {\n   b\n}`;\nif (x) {\ny();\n}"), "const s = `a {\n   b\n}`;\nif (x) {\n  y();\n}");
    assert.equal(formatJs("/* {\n   keep\n*/\nf();"), "/* {\n   keep\n*/\nf();");
    assert.equal(formatJs("const t = '{';\nf();"), "const t = '{';\nf();", "a bracket in a string isn't one");
    assert.equal(formatJs("a();\r\nif (b) {\r\nc();\r\n}"), "a();\r\nif (b) {\r\n  c();\r\n}", "Windows line endings kept");
    assert.equal(formatJs("}\n}\nx"), "}\n}\nx", "closers with nothing open don't go below nothing");
  });

  it("Enter: the line's indent; a level more after an opener; between brackets, the closer on its own line", () => {
    assert.deepEqual(newLine("  x = 1;", 8), { insert: "\n  ", caret: 3 });
    assert.deepEqual(newLine("f() {", 5), { insert: "\n  ", caret: 3 });
    assert.deepEqual(newLine("  f() {}", 7), { insert: "\n    \n  ", caret: 5 });
    assert.deepEqual(newLine("f([])", 3), { insert: "\n  \n", caret: 3 });
    // (its closer on a later line: not split again)
    assert.deepEqual(newLine("f() {\n}", 5), { insert: "\n  ", caret: 3 });
  });
});

describe("a test's runs", () => {
  const run = {
    turns: [
      { suite: "s.yml", test: "t", repeat: 1, row: null, index: 0, user: "a1" },
      { suite: "s.yml", test: "t", repeat: 2, row: null, index: 0, user: "a2" },
      { suite: "s.yml", test: "other", repeat: 1, row: null, index: 0, user: "b" },
      { suite: "s.yml", test: "t", repeat: 3, row: null, index: 0, user: "a3" },
    ],
  };
  const test = { id: "t", name: "t", turns: [{ user: "a" }] };

  it("none picked: the latest, everywhere it's chosen", () => {
    const instances = instancesOf(run, "s.yml", test);
    assert.deepEqual(instances.map((x) => x.repeat), [1, 2, 3]);
    assert.deepEqual(pickedInstance(instances, {}), { repeat: 3, row: null });
    assert.deepEqual(pickedInstance(instances, { repeat: 1, row: null }), { repeat: 1, row: null });
    assert.deepEqual(pickedInstance(instances, { repeat: 9 }), { repeat: 3, row: null }, "one that isn't there: the latest");
    assert.equal(pickedInstance([], {}), undefined);
    assert.deepEqual(turnsOf(run, "s.yml", test).map((x) => x.record.user), ["a3"]);
    assert.deepEqual(turnsOf(run, "s.yml", test, { repeat: 2, row: null }).map((x) => x.record.user), ["a2"]);
    assert.deepEqual(turnsOf(null, "s.yml", test), []);
  });

  it("a data row by its name, as its turns recorded it (the engine's words: row 3: a refund please); a run from before row names, row 3", () => {
    const rows = {
      turns: [
        { suite: "s.yml", test: "t", repeat: 1, row: 1, row_name: "a refund please", index: 0, user: "r1" },
        { suite: "s.yml", test: "t", repeat: 1, row: 1, row_name: "a refund please", index: 1, user: "r1b" },
        { suite: "s.yml", test: "t", repeat: 1, row: 2, index: 0, user: "r2" },
      ],
    };
    const instances = instancesOf(rows, "s.yml", test);
    assert.deepEqual(instances, [{ repeat: 1, row: 1, row_name: "a refund please" }, { repeat: 1, row: 2 }]);
    assert.deepEqual(instances.map((x) => rowLabel(x.row, x.row_name)), ["row 1: a refund please", "row 2"]);
    assert.deepEqual(pickedInstance(instances, {}), { repeat: 1, row: 2 });
    assert.equal(pickedInstance(instances, { repeat: 1, row: 1 }).row_name, "a refund please");
    assert.deepEqual(turnsOf(rows, "s.yml", test, instances[0]).map((x) => x.record.user), ["r1", "r1b"]);
  });

  it("×3: a test's repeat, else its suite's default, else 1", () => {
    assert.equal(repeatOf({ data: {} }, { repeat: 3 }), 3);
    assert.equal(repeatOf({ data: { defaults: { repeat: 2 } } }, {}), 2);
    assert.equal(repeatOf({ data: { defaults: { repeat: 2 } } }, { repeat: 1 }), 1);
    assert.equal(repeatOf(null, null), 1);
  });
});

describe("how it went, in one set of words", () => {
  const test = { id: "t_auth0001", name: "login and chat", turns: [{ user: "hi", expect: [{ type: "status", equals: 200 }, { contains: "hi" }] }] };
  const suites = [{ file: "auth.hafen.yml", data: { tests: [test] } }];
  const of = (run) => ({ suites: [{ file: "auth.hafen.yml", name: "Auth" }], settings: { filters: { ids: ["t_auth0001"], tests: [], tags: [] } }, tests: [], ...run });
  const refused = of({ status: "error", error: { message: "{{env.base_url}} isn't set", all: [{ message: "{{env.base_url}} isn't set" }, { message: "{{env.who}} isn't set" }] } });
  const broke = of({ status: "error", error: { message: "auth.hafen.yml: the fixture \"acme-login\" (beforeAll) failed: Couldn't reach" } });

  it("a run that broke off before the test it was asked for is that test's last try: error, or couldn't run, with why", () => {
    assert.deepEqual(testStatusText(testResult(broke, "auth.hafen.yml", test)), { text: "error", status: "error", why: broke.error.message });
    assert.deepEqual(testStatusText(testResult(refused, "auth.hafen.yml", test)), { text: "couldn't run", status: "error", why: "{{env.base_url}} isn't set" });
    // (not one it wasn't asked for, nor another suite's; a whole suite's run counts for each of its tests)
    assert.equal(testResult(broke, "auth.hafen.yml", { id: "t_other0001", name: "other" }), null);
    assert.equal(testResult(broke, "other.hafen.yml", test), null);
    assert.equal(testResult({ ...broke, settings: { filters: {} } }, "auth.hafen.yml", { id: "t_other0001", name: "other" })?.unreached, true);
    // (a run that ended well and has no record of it: nothing)
    assert.equal(testResult(of({ status: "done", verdict: "passed" }), "auth.hafen.yml", test), null);
  });

  it("a run's word: couldn't run, error, the one test's, else failed before error before stopped", () => {
    assert.equal(runOutcome(refused).text, "couldn't run");
    assert.equal(runOutcome(broke).text, "error");
    const done = (tests, more = {}) => runOutcome({ status: "done", verdict: "failed", tests, ...more });
    assert.deepEqual(done([{ status: "error", reason: "500" }]), { text: "error", status: "error", why: "500" }, "the engine's verdict says failed: the test erred");
    assert.equal(done([{ status: "failed" }]).text, "failed");
    assert.equal(done([{ status: "error" }, { status: "failed" }]).text, "failed");
    assert.equal(done([{ status: "error" }, { status: "passed" }]).text, "error");
    assert.equal(done([{ status: "stopped" }], { status: "stopped", verdict: null }).text, "stopped");
    assert.equal(done([{ status: "passed", unsure: true }], { verdict: "unsure" }).text, "unsure");
    assert.equal(done([{ status: "passed" }, { status: "skipped" }], { verdict: "passed" }).text, "passed");
    // A fixture that said to stop: the test it stopped says why; a beforeAll one stops the run, its
    // tests skipped with the same reason, and the run says why
    const said = 'the fixture "gate" (before) said to stop';
    assert.deepEqual(done([{ status: "stopped", reason: said }], { status: "stopped", verdict: null }), { text: "stopped", status: "stopped", why: said });
    assert.deepEqual(testStatusText({ status: "skipped", reason: said }), { text: "skipped", status: "skipped", why: said });
    assert.deepEqual(done([{ status: "skipped", reason: said }, { status: "skipped", reason: said }], { status: "stopped", verdict: null, stopped: said }), { text: "stopped", status: "stopped", why: said });
  });

  it("a run's name: its one test's, the test a run that broke off was asked for, else its suites'", () => {
    assert.equal(runName(broke, suites), "login and chat");
    assert.equal(runName(of({ settings: { filters: { tests: ["by name"] } } }), []), "by name");
    assert.equal(runName(of({ settings: { filters: {} } }), suites), "Auth");
    assert.equal(runName({ tests: [{ name: "one" }], suites: [] }), "one");
  });

  it("a turn stopped on purpose is stopped, not an error; one stopped or skipped ran none of its checks", () => {
    const checks = test.turns[0].expect;
    const stopped = { error: "stopped", results: checks.map(() => ({ status: "skipped", reason: "the run was stopped" })) };
    assert.equal(turnStatus(stopped, checks), "stopped");
    assert.equal(turnChecksText(stopped, checks), "stopped");
    assert.equal(turnChecksText({ skipped: "the run was stopped", results: [] }, checks), "skipped");
    assert.equal(turnStatus({ error: "timed out after 2 s", results: [] }, checks), "error");
    assert.equal(turnChecksText({ results: [{ check: checks[0], status: "pass" }, { check: checks[1], status: "fail" }] }, checks), "1/2");
  });

  it("an unsure result shows as it counted: failed under fail, passed under pass, unsure under warn (or a run from before)", () => {
    const checks = test.turns[0].expect;
    const unsure = (how) => ({ check: checks[0], status: "unsure", reason: "0.55 within 0.5–1, but confidence 0.1 is below 0.6", confidence: 0.1, ...(how ? { unsure: how } : {}) });
    const failed = countedResult(unsure("fail"));
    assert.equal(failed.status, "fail");
    assert.equal(failed.reason, "unsure: 0.55 within 0.5–1, but confidence 0.1 is below 0.6 (unsure counts as failed)");
    assert.equal(failed.confidence, 0.1);
    assert.equal(countedResult(unsure("pass")).status, "pass");
    assert.equal(countedResult(unsure("warn")).status, "unsure");
    assert.equal(countedResult(unsure()).status, "unsure");
    assert.equal(countedResult(null), null);
    const pass = { check: checks[1], status: "pass" };
    assert.equal(turnStatus({ results: [unsure("fail"), pass] }, checks), "failed");
    assert.equal(turnChecksText({ results: [unsure("fail"), pass] }, checks), "1/2");
    assert.equal(turnStatus({ results: [unsure("warn"), pass] }, checks), "unsure");
    assert.equal(turnStatus({ results: [unsure("pass"), pass] }, checks), "passed");
    assert.equal(turnChecksText({ results: [unsure("pass"), pass] }, checks), "2/2");
    assert.equal(turnStatus({ results: [unsure("fail"), pass] }), "failed");
  });
});
