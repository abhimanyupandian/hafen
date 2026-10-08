// Copy CI command (app/js/lib/ci.js): the command that runs the folder a suite was last exported to,
// naming exactly the files that export wrote there (Globals' and the scope's .env files, then their
// secrets files, in the order CI reads them), never one it didn't; none before the suite was exported.
// And the files Export would write: each entry's own, only the ones with something in them.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ciCommand, ciFiles, written } from "../../app/js/lib/ci.js";

const REPORTS = "--report junit:results/junit.xml --report run:results/run.hafen-run.json";

describe("Copy CI command", () => {
  it("is none before the suite's been exported", () => {
    assert.equal(ciCommand("smoke.hafen.yml", null, { exports: {}, env: "stage" }), null);
  });

  it("runs the folder it was exported to, with every file export wrote there, in order: Globals' then the scope's, values then secrets", () => {
    const state = { env: "stage", exports: { "smoke.hafen.yml": { ci: "tests/hafen", scope: "stage", env: ["globals.env", "stage.env"], secret: ["globals.secret.env", "stage.secret.env"] } } };
    assert.equal(ciCommand("smoke.hafen.yml", null, state), `npx hafen run "tests/hafen" --env tests/hafen/globals.env --env tests/hafen/stage.env --secret tests/hafen/globals.secret.env --secret tests/hafen/stage.secret.env ${REPORTS}`);
    assert.equal(ciCommand("smoke.hafen.yml", { name: "refund" }, state), `npx hafen run "tests/hafen" --env tests/hafen/globals.env --env tests/hafen/stage.env --secret tests/hafen/globals.secret.env --secret tests/hafen/stage.secret.env --test "refund" ${REPORTS}`);
  });

  it("never names a file export didn't write: exported without the values, none (whatever the scope has now)", () => {
    const exported = { "smoke.hafen.yml": { ci: ".", scope: "stage", env: [], secret: [] } };
    assert.equal(ciCommand("smoke.hafen.yml", null, { env: "stage", globals: { a: "1" }, scopes: [{ name: "stage", values: { b: "2" } }], scopeSecrets: { "": ["SHARED"] }, exports: exported }), `npx hafen run "." ${REPORTS}`);
    // (only Globals' had values: that one file)
    assert.equal(ciCommand("smoke.hafen.yml", null, { env: null, exports: { "smoke.hafen.yml": { ci: ".", scope: "", env: ["globals.env"], secret: [] } } }), `npx hafen run "." --env globals.env ${REPORTS}`);
  });

  it("an export remembered before it listed its files (one file, or none) still names what it wrote", () => {
    const state = { env: "stage", exports: { "a.hafen.yml": { ci: "out", env: "stage.env", secret: null } } };
    assert.equal(ciCommand("a.hafen.yml", null, state), `npx hafen run "out" --env out/stage.env ${REPORTS}`);
    assert.deepEqual(written(null), []);
    assert.deepEqual(written("x.env"), ["x.env"]);
    assert.deepEqual(written(["a", "b"]), ["a", "b"]);
  });

  it("quotes a path that needs it (the desktop app's whole path, outside a repository)", () => {
    const state = { env: "stage", exports: { "a.hafen.yml": { ci: "/Users/me/My Tests", env: ["stage.env"] } } };
    assert.equal(ciCommand("a.hafen.yml", null, state), `npx hafen run "/Users/me/My Tests" --env "/Users/me/My Tests/stage.env" ${REPORTS}`);
  });

  it("the files Export would write: each entry's own, Globals' first, only the ones with something in them", () => {
    const scopes = [{ name: "stage", values: { who: "s" } }, { name: "bare", values: {} }];
    assert.deepEqual(ciFiles({ env: "stage", globals: { a: "1" }, scopes, scopeSecrets: { "": ["A"], stage: ["K"] } }), { env: ["globals.env", "stage.env"], secret: ["globals.secret.env", "stage.secret.env"] });
    assert.deepEqual(ciFiles({ env: "stage", globals: {}, scopes, scopeSecrets: {} }), { env: ["stage.env"], secret: [] });
    assert.deepEqual(ciFiles({ env: "bare", globals: { a: "1" }, scopes, scopeSecrets: { bare: [] } }), { env: ["globals.env"], secret: [] });
    // No scope chosen: Globals' alone
    assert.deepEqual(ciFiles({ env: null, globals: { a: "1" }, scopes, scopeSecrets: { "": ["A"], stage: ["K"] } }), { env: ["globals.env"], secret: ["globals.secret.env"] });
    assert.deepEqual(ciFiles({ env: null }), { env: [], secret: [] });
  });
});
