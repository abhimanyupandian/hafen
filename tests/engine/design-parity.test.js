// The design system, copied from hafen (spec/design/README.md, Reusing it in another project): every
// rule the copied stylesheets keep must be hafen's, declaration for declaration (comments may differ,
// and rules for hafen's own features are left out), and the logo files are hafen's byte for byte. Runs
// when hafen's web/ sits beside this project (as in its repository); skipped elsewhere (after a move
// to its own repository, the gallery's visual tests keep the look).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const HAFEN = here("../../../web/public/");
const OURS = here("../../app/");

// A stylesheet's rules: Map("<@media …>|<selector>" → "declarations"), comments and spacing ignored
export function rules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map();
  const context = [];
  let buffer = "";
  for (const ch of text) {
    if (ch === "{") {
      const prelude = buffer.trim().replace(/\s+/g, " ");
      buffer = "";
      context.push(prelude);
    } else if (ch === "}") {
      const prelude = context.pop();
      const body = buffer.trim().replace(/\s+/g, " ");
      buffer = "";
      if (prelude && !prelude.startsWith("@")) out.set(`${context.join(" ")}|${prelude}`, body);
    } else buffer += ch;
  }
  return out;
}

// Rules in `ours` that hafen has under the same selector and context but with other declarations,
// and rules hafen doesn't have at all
function differences(ours, theirs) {
  const changed = [];
  const extra = [];
  for (const [key, body] of ours) {
    if (!theirs.has(key)) extra.push(key);
    else if (theirs.get(key) !== body) changed.push(key);
  }
  return { changed, extra };
}

describe("design parity with hafen", { skip: !existsSync(HAFEN) && "hafen's web/ isn't beside this project" }, () => {
  for (const file of ["css/tokens.css", "css/components.css"]) {
    it(`${file}: every rule is hafen's, unchanged`, async () => {
      const { changed, extra } = differences(rules(await readFile(`${OURS}${file}`, "utf8")), rules(await readFile(`${HAFEN}${file}`, "utf8")));
      assert.deepEqual(changed, [], "rules whose declarations differ from hafen's");
      assert.deepEqual(extra, [], "rules hafen doesn't have (additions go in eval.css)");
    });
  }
  for (const icon of ["hafen-h.svg", "hafen-h-black.svg"]) {
    it(`the logo ${icon} is hafen's, byte for byte`, async () => {
      assert.equal(await readFile(`${OURS}public/icons/${icon}`, "utf8"), await readFile(`${HAFEN}icons/${icon}`, "utf8"));
    });
  }
  it("frame.css: the frame rules hafen also has keep hafen's declarations", async () => {
    const theirs = new Map([...rules(await readFile(`${HAFEN}css/app.css`, "utf8")), ...rules(await readFile(`${HAFEN}css/build.css`, "utf8"))]);
    const { changed } = differences(rules(await readFile(`${OURS}css/frame.css`, "utf8")), theirs);
    assert.deepEqual(changed, []);
  });
});
