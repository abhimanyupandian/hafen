// KEY=VALUE files (engine/env-file.js): an environment's values and a secrets file, read and edited
// in place.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { editEnvText, envValueText, parseEnvText } from "../../engine/env-file.js";

describe("KEY=VALUE files", () => {
  it("reads names and values: comments, blank lines, export, spaces, quotes, dotted names", () => {
    const { values, errors } = parseEnvText([
      "# staging",
      "",
      "base_url=https://staging.acme.example/#top",
      "db.host = db.internal  # the database",
      "export REGION=eu",
      "greeting=\"Hello, \\\"you\\\"\\n\"",
      "raw='a # b \\n'",
      "EMPTY=",
    ].join("\n"), "environments/staging.env");
    assert.deepEqual(errors, []);
    assert.deepEqual(values, {
      base_url: "https://staging.acme.example/#top",
      "db.host": "db.internal",
      REGION: "eu",
      greeting: "Hello, \"you\"\n",
      raw: "a # b \\n",
      EMPTY: "",
    });
  });

  it("each problem with its file, line and column: not NAME=value, a bad name, a name set twice, an unclosed quote", () => {
    const { errors } = parseEnvText("A=1\nno equals here\n1x=2\nA=3\nB=\"open\n", "s.env");
    assert.deepEqual(errors.map((e) => `${e.file}:${e.line}:${e.column} ${e.message}`), [
      "s.env:2:1 line 2 isn't NAME=value",
      "s.env:3:1 \"1x\" isn't a name (letters, digits, _ . -, not starting with a digit)",
      "s.env:4:1 A is on line 1 too: a name is set once",
      "s.env:5:3 a value that starts with \" ends with one",
    ]);
  });

  it("edits one name in its place, adds one at the end, takes one out: every other line as it was", () => {
    const text = "# the stage environment\nA=1\n\n# the db\nB=2\n";
    assert.equal(editEnvText(text, "A", "x"), "# the stage environment\nA=x\n\n# the db\nB=2\n");
    assert.equal(editEnvText(text, "C", "3"), "# the stage environment\nA=1\n\n# the db\nB=2\nC=3\n");
    assert.equal(editEnvText(text, "B", null), "# the stage environment\nA=1\n\n# the db\n");
    assert.equal(editEnvText("A=1\r\nB=2\r\n", "A", "x"), "A=x\r\nB=2\r\n");
    assert.throws(() => editEnvText(text, "no spaces", "x"), /isn't a name/);
  });

  it("a value that wouldn't read back as it is is quoted, and reads back the same", () => {
    for (const value of ["plain", "with spaces inside", " padded ", "a #comment", "#start", "quote \" and \\", "two\nlines", ""]) {
      const text = editEnvText("", "K", value);
      assert.equal(parseEnvText(text).values.K, value, `${JSON.stringify(value)} as ${text}`);
    }
    assert.equal(envValueText("https://x.example/#frag"), "https://x.example/#frag");
  });
});
