// Hafen was named "hafen eval" before, and kept its data in a folder of that name. The first time
// Hafen starts, what that folder kept is copied into Hafen's own: the page's storage (IndexedDB: runs
// and conversations; Local Storage: the sidebar's state, the theme, the folder opened last) and the
// window's look. Secrets aren't: the system keeps their key under the app's name, so they can't be
// read under the new one, and are entered again (Settings → Secrets, and System One). The old folder
// is left as it was.

import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The old data folder's name (in the system's app data folder)
export const LEGACY_FOLDER = "hafen eval";
export const CARRIED = ["IndexedDB", "Local Storage", "window.json"];
// Written once it's done, so it's done once
export const MARK = "carried-over.json";

// Copy what `from` kept into `to`, once: each thing that `to` doesn't have yet. Returns what was copied.
// Each is copied beside its place and then moved into it, so one that fails part way leaves nothing
// half there (and the next start tries again).
export function carryOver(from, to) {
  if (!from || !existsSync(from) || existsSync(join(to, MARK))) return [];
  mkdirSync(to, { recursive: true });
  const copied = [];
  for (const name of CARRIED) {
    const source = join(from, name);
    const target = join(to, name);
    if (!existsSync(source) || existsSync(target)) continue;
    const part = `${target}.carrying`;
    rmSync(part, { recursive: true, force: true });
    cpSync(source, part, { recursive: true });
    renameSync(part, target);
    copied.push(name);
  }
  writeFileSync(join(to, MARK), `${JSON.stringify({ from, copied, at: new Date().toISOString() }, null, 2)}\n`);
  return copied;
}
