// Scopes and Globals (app/js/lib/scopes.js): the values a scope gives once Globals' are under its own (a
// name only Globals has is Globals', one both have the scope's, one only the scope has the scope's; no
// scope: Globals' alone), the names no scope can take (Globals' own, and ones whose files would meet
// another's), where a row's name comes from, and a free name for a copy.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NAME as ENGINE_NAME } from "hafen/engine/env-file.js";
import { copyName, effectiveValues, NAME, RESERVED, scopeNameProblem, sourceOf } from "../../app/js/lib/scopes.js";
import { envFile, secretFile } from "../../app/js/lib/ci.js";

const globals = { base_url: "https://global.example", region: "eu", shared: "g" };
const scopes = [{ name: "stage", values: { base_url: "https://stage.example", who: "stage-team" } }, { name: "empty", values: {} }];

describe("effectiveValues", () => {
  it("a scope's own over Globals': only Globals has it, Globals'; both, the scope's; only the scope, the scope's", () => {
    assert.deepEqual(effectiveValues("stage", { globals, scopes }), { base_url: "https://stage.example", region: "eu", shared: "g", who: "stage-team" });
  });

  it("no scope chosen (null, or \"\"): Globals' alone", () => {
    assert.deepEqual(effectiveValues(null, { globals, scopes }), globals);
    assert.deepEqual(effectiveValues("", { globals, scopes }), globals);
    assert.deepEqual(effectiveValues(undefined, {}), {});
  });

  it("a scope with no values of its own, or one that isn't there, gives Globals'", () => {
    assert.deepEqual(effectiveValues("empty", { globals, scopes }), globals);
    assert.deepEqual(effectiveValues("gone", { globals, scopes }), globals);
  });

  it("gives a copy: changing it changes neither Globals nor the scope", () => {
    const out = effectiveValues("stage", { globals, scopes });
    out.region = "us";
    out.who = "someone";
    assert.equal(globals.region, "eu");
    assert.equal(scopes[0].values.who, "stage-team");
  });

  it("an empty value of the scope's still overrides Globals' (it's set, to nothing)", () => {
    assert.equal(effectiveValues("s", { globals, scopes: [{ name: "s", values: { region: "" } }] }).region, "");
  });
});

describe("scope names", () => {
  it("Globals' names are no scope's, case aside", () => {
    assert.deepEqual(RESERVED, ["globals", "global", "every-scope"]);
    for (const name of ["globals", "global", "every-scope", "Globals", "GLOBAL", "Every-Scope"]) assert.match(scopeNameProblem(name), /Globals' name/, name);
  });

  it("nor one ending .secret: its values' file would be another scope's secrets file", () => {
    assert.match(scopeNameProblem("stage.secret"), /doesn't end \.secret/);
    assert.match(scopeNameProblem("stage.SECRET"), /doesn't end \.secret/);
    assert.equal(scopeNameProblem("stage.secrets"), "");
    assert.equal(scopeNameProblem("secret"), "");
  });

  it("no two entries' files are the same file", () => {
    const names = ["", "stage", "prod", "stage.v2", "every"];
    const files = names.flatMap((n) => [envFile(n), secretFile(n)]);
    assert.equal(new Set(files).size, files.length);
    assert.equal(envFile(""), "globals.env");
    assert.equal(secretFile(""), "globals.secret.env");
  });

  it("letters, digits, '.', '-' and '_', starting with a letter or digit; one taken is refused", () => {
    assert.equal(scopeNameProblem("stage-2_eu.v1"), "");
    assert.match(scopeNameProblem("-stage"), /letters, digits/);
    assert.match(scopeNameProblem("my stage"), /letters, digits/);
    assert.match(scopeNameProblem(""), /letters, digits/);
    assert.equal(scopeNameProblem("stage", ["stage"]), 'There\'s a scope "stage" already.');
  });

  it("a value's and a secret's name is the engine's: a dotted one too (db.password), as a --secret file has it", () => {
    assert.equal(NAME, ENGINE_NAME);
    for (const ok of ["API_KEY", "db.password", "my-key", "_x"]) assert.ok(NAME.test(ok), ok);
    for (const bad of ["2nd", "a b", "", "a=b"]) assert.ok(!NAME.test(bad), bad);
  });

  it("a copy's name is free: <name>-copy, then -copy-2…", () => {
    assert.equal(copyName("stage", ["stage"]), "stage-copy");
    assert.equal(copyName("stage", ["stage", "stage-copy", "stage-copy-2"]), "stage-copy-3");
  });
});

describe("where a row's name comes from", () => {
  it("a scope's own: own, or override when Globals has it too; Globals' only: inherited; Globals' own rows: own", () => {
    const own = { base_url: "s", who: "w" };
    assert.equal(sourceOf("who", { scope: "stage", own, globals }), "own");
    assert.equal(sourceOf("base_url", { scope: "stage", own, globals }), "override");
    assert.equal(sourceOf("region", { scope: "stage", own, globals }), "globals");
    assert.equal(sourceOf("nope", { scope: "stage", own, globals }), null);
    assert.equal(sourceOf("region", { scope: "", own: globals, globals }), "own");
  });

  it("only own names count: an inherited one (constructor) is nobody's", () => {
    assert.equal(sourceOf("constructor", { scope: "stage", own: {}, globals: {} }), null);
    assert.equal(sourceOf("toString", { scope: "stage", own: {}, globals }), null);
  });
});
