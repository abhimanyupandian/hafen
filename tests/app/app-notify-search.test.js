// The page's search and notification rules, without a page: a search's words found in a row's names
// and its dates written the ways people write them; what a run's end does as the settings say.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dateTexts, matches, searchWords } from "../../app/js/lib/search.js";

describe("search", () => {
  const now = new Date(2026, 9, 6, 15, 30).getTime();      // Tue 6 Oct 2026, 15:30 (local)
  const at = new Date(2026, 9, 6, 14, 2).getTime();        // the same day, 14:02
  const before = new Date(2025, 0, 9, 8, 5).getTime();     // Thu 9 Jan 2025, 08:05

  it("a date, the ways it's written", () => {
    const texts = dateTexts(at, now).join(" | ");
    for (const t of ["2026-10-06 14:02", "06/10/2026", "10/06/2026", "6/10/2026", "6.10.2026", "Oct 6, 2026", "October 6, 2026", "6 Oct 2026", "6 October 2026", "Tuesday", "14:02", "today", "1 hour ago"]) {
      assert.ok(texts.includes(t), `${t} in ${texts}`);
    }
    assert.ok(dateTexts(new Date(2026, 9, 5, 9, 0).getTime(), now).includes("yesterday"));
    assert.ok(!dateTexts(before, now).includes("today"));
    assert.deepEqual(dateTexts(undefined, now), []);
    assert.deepEqual(dateTexts(0, now), []);
  });

  it("every word found somewhere (any case, any order); none typed: everything", () => {
    const row = { texts: ["Refund for a broken item", "smoke"], times: [at] };
    assert.deepEqual(searchWords("  Broken   REFUND "), ["broken", "refund"]);
    assert.equal(matches(searchWords(""), row, now), true);
    assert.equal(matches(searchWords("broken refund"), row, now), true);
    assert.equal(matches(searchWords("SMOKE oct"), row, now), true);
    assert.equal(matches(searchWords("2026-10-06"), row, now), true);
    assert.equal(matches(searchWords("today"), row, now), true);
    assert.equal(matches(searchWords("refund 2025"), row, now), false);
    assert.equal(matches(searchWords("refund 2025"), { ...row, times: [before] }, now), true);
    assert.equal(matches(searchWords("jan 9"), { texts: [], times: [before] }, now), true);
    assert.equal(matches(searchWords("thursday"), { texts: [], times: [before] }, now), true);
    assert.equal(matches(searchWords("parcel"), row, now), false);
    // (a word isn't found across two texts joined)
    assert.equal(matches(searchWords("itemsmoke"), row, now), false);
  });
});

describe("a run's end", async () => {
  globalThis.document = { visibilityState: "visible", hasFocus: () => true };
  const { runEndActions } = await import("../../app/js/lib/notifications.js");
  const settings = { sound: true, when: "away", passed: true, failed: true, system: true };

  it("a sound when not looking at what ran; looking: none; always: one anyway", () => {
    assert.deepEqual(runEndActions("passed", false, settings), { sound: "done", system: false });
    assert.deepEqual(runEndActions("failed", false, settings), { sound: "failed", system: false });
    assert.deepEqual(runEndActions("passed", true, settings), { sound: null, system: false });
    assert.deepEqual(runEndActions("passed", true, { ...settings, when: "always" }), { sound: "done", system: false });
  });

  it("the outcomes chosen only; sound off; a stopped run: nothing", () => {
    assert.deepEqual(runEndActions("passed", false, { ...settings, passed: false }), { sound: null, system: false });
    assert.deepEqual(runEndActions("failed", false, { ...settings, passed: false }), { sound: "failed", system: false });
    assert.deepEqual(runEndActions("failed", false, { ...settings, sound: false }), { sound: null, system: false });
    assert.deepEqual(runEndActions("stopped", false, settings), { sound: null, system: false });
  });

  it("the system's notification only while the window isn't in front, and when it's on", () => {
    globalThis.document = { visibilityState: "visible", hasFocus: () => false };
    assert.deepEqual(runEndActions("passed", false, settings), { sound: "done", system: true });
    assert.deepEqual(runEndActions("passed", false, { ...settings, system: false }), { sound: "done", system: false });
    globalThis.document = { visibilityState: "hidden", hasFocus: () => true };
    assert.deepEqual(runEndActions("failed", false, { ...settings, sound: false }), { sound: null, system: true });
    assert.deepEqual(runEndActions("stopped", false, settings), { sound: null, system: false });
  });
});
