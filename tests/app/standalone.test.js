// The project stands alone: nothing in it imports a file from outside it. And the app (app/, desktop/,
// server/, its tests) reaches the engine and the CLI only as the hafen package (hafen/engine/…,
// hafen/cli/…), never by a path into packages/hafen, so what it runs is what the package publishes.
// (The package checks the same of itself: packages/hafen/tests/engine/foundations.test.js.)

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SKIP = ["node_modules", "dist", "release", "test-results", ".hafen", ".electron-dev", ".git"];
const IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

async function imports() {
  const found = [];  // { file, spec, target }: each relative import, from the project's root
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.includes(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.(m?js|jsx|cjs)$/.test(e.name)) {
        for (const m of (await readFile(full, "utf8")).matchAll(IMPORT)) found.push({ file: relative(ROOT, full), spec: m[1], target: relative(ROOT, resolve(dir, m[1])) });
      }
    }
  };
  await walk(ROOT);
  return found;
}

it("imports nothing from outside the project", async () => {
  const offenders = (await imports()).filter((i) => i.target.startsWith("..")).map((i) => `${i.file} → ${i.spec}`);
  assert.deepEqual(offenders, []);
});

it("the app reaches the engine and the CLI as the hafen package (hafen/…), not by a path into it", async () => {
  const inPackage = (path) => path.startsWith(`packages${sep}`);
  const engineOrCli = (path) => /^packages[\\/][^\\/]+[\\/](engine|cli)[\\/]/.test(path);
  const offenders = (await imports()).filter((i) => !inPackage(i.file) && engineOrCli(i.target)).map((i) => `${i.file} → ${i.spec}`);
  assert.deepEqual(offenders, []);
});
