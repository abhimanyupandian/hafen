// The rename to Hafen, in the desktop app: its old data folder is carried over once
// (desktop/carry-over.js).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { CARRIED, carryOver, LEGACY_FOLDER, MARK } from "../../desktop/carry-over.js";

describe("the rename to Hafen", () => {
  describe("the desktop app's data, carried over from its old folder", () => {
    let root;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), "hafen-carry-")); });
    const fill = (dir) => {
      mkdirSync(join(dir, "IndexedDB", "file__0.indexeddb.leveldb"), { recursive: true });
      writeFileSync(join(dir, "IndexedDB", "file__0.indexeddb.leveldb", "000003.log"), "runs");
      mkdirSync(join(dir, "Local Storage", "leveldb"), { recursive: true });
      writeFileSync(join(dir, "Local Storage", "leveldb", "000003.log"), "theme");
      writeFileSync(join(dir, "window.json"), '{"applied":"dark"}');
      writeFileSync(join(dir, "secrets.json"), '{"":{"JEV_API_KEY":"encrypted"}}');
    };

    it("is named for the old app", () => {
      assert.equal(LEGACY_FOLDER, "hafen eval");
      assert.deepEqual(CARRIED, ["IndexedDB", "Local Storage", "window.json"]);
    });

    it("copies the page's storage and the window's look, not the secrets (their key is the old app's), once", () => {
      const from = join(root, "old");
      const to = join(root, "new");
      fill(from);
      assert.deepEqual(carryOver(from, to), ["IndexedDB", "Local Storage", "window.json"]);
      assert.equal(readFileSync(join(to, "IndexedDB", "file__0.indexeddb.leveldb", "000003.log"), "utf8"), "runs");
      assert.equal(readFileSync(join(to, "Local Storage", "leveldb", "000003.log"), "utf8"), "theme");
      assert.equal(readFileSync(join(to, "window.json"), "utf8"), '{"applied":"dark"}');
      assert.equal(existsSync(join(to, "secrets.json")), false);
      assert.deepEqual(JSON.parse(readFileSync(join(to, MARK), "utf8")).copied, ["IndexedDB", "Local Storage", "window.json"]);
      // The old folder is left as it was
      assert.equal(existsSync(join(from, "secrets.json")), true);
      // Once: the old folder changed since isn't copied again
      writeFileSync(join(from, "window.json"), '{"applied":"light"}');
      assert.deepEqual(carryOver(from, to), []);
      assert.equal(readFileSync(join(to, "window.json"), "utf8"), '{"applied":"dark"}');
      rmSync(root, { recursive: true, force: true });
    });

    it("never writes over what the new folder has, and finishes a copy that stopped part way", () => {
      const from = join(root, "old");
      const to = join(root, "new");
      fill(from);
      mkdirSync(to, { recursive: true });
      writeFileSync(join(to, "window.json"), '{"applied":"light"}');
      // A copy that stopped part way (the app quit during it): beside its place, not in it
      mkdirSync(join(to, "IndexedDB.carrying"), { recursive: true });
      writeFileSync(join(to, "IndexedDB.carrying", "half"), "");
      assert.deepEqual(carryOver(from, to), ["IndexedDB", "Local Storage"]);
      assert.equal(readFileSync(join(to, "window.json"), "utf8"), '{"applied":"light"}');
      assert.equal(existsSync(join(to, "IndexedDB.carrying")), false);
      assert.equal(existsSync(join(to, "IndexedDB", "half")), false);
      assert.equal(existsSync(join(to, "IndexedDB", "file__0.indexeddb.leveldb", "000003.log")), true);
      rmSync(root, { recursive: true, force: true });
    });

    it("does nothing with no old folder (or none named)", () => {
      assert.deepEqual(carryOver(join(root, "missing"), join(root, "new")), []);
      assert.deepEqual(carryOver(null, join(root, "new")), []);
      assert.equal(existsSync(join(root, "new")), false);
      rmSync(root, { recursive: true, force: true });
    });
  });
});
