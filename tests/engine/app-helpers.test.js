// The page's own helpers that need no page: "2 mins ago"; a plugin's JavaScript coloured, indented as
// it's typed, and formatted; the run of a test shown when none is picked (the latest); ×3.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatJs, highlightJs, newLine, tokens } from "../../app/js/design/code.js";
import { ago } from "../../app/js/lib/format.js";
import { instancesOf, pickedInstance, repeatOf, turnsOf } from "../../app/js/views/derive.js";
import { pluginTemplate } from "../../engine/plugin-templates.js";

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

  it("×3: a test's repeat, else its suite's default, else 1", () => {
    assert.equal(repeatOf({ data: {} }, { repeat: 3 }), 3);
    assert.equal(repeatOf({ data: { defaults: { repeat: 2 } } }, {}), 2);
    assert.equal(repeatOf({ data: { defaults: { repeat: 2 } } }, { repeat: 1 }), 1);
    assert.equal(repeatOf(null, null), 1);
  });
});
