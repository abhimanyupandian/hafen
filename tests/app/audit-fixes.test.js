// What a review of the app's own code found, fixed and held here: times rounded before they're split.

import assert from "node:assert/strict";
import { it } from "node:test";
import { sec } from "../../app/js/lib/format.js";

it("times: rounded before they're split, never 60.0 s or 1 min 60 s", () => {
  assert.equal(sec(620), "0.62 s");
  assert.equal(sec(59940), "59.9 s");
  assert.equal(sec(59960), "1 min 0 s");
  assert.equal(sec(119600), "2 min 0 s");
  assert.equal(sec(72400), "1 min 12 s");
  assert.equal(sec(undefined), "—");
  assert.equal(sec(Number.NaN), "—");
});
