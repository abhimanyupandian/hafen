// The app's page carries only what it shows: what runs checks and validates files (JSON Schema, by Ajv;
// JSONPath, by json-p3) is the engine's, in its worker (or the desktop app's engine process). Followed
// from the page's entry (the app) through every static import, the engine's
// modules too (the hafen package's, imported as hafen/engine/…, as Vite resolves them), the page reaches
// neither: one that did would put them back in its bundle (500 kB over the build's warning).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// The hafen package's folder (packages/hafen, linked as node_modules/hafen), from the project's root
const HAFEN = relative(ROOT, dirname(fileURLToPath(import.meta.resolve("hafen/package.json"))));
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;

function reach(entries) {
  const files = new Set();
  const packages = new Map();  // package → the file that imports it
  const walk = (file) => {
    if (files.has(file)) return;
    files.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith(".")) {
        const next = resolve(dirname(file), spec);
        if (existsSync(next) && /\.(js|jsx|mjs)$/.test(next)) walk(next);
      } else if (spec.startsWith("hafen/")) {
        // The engine's modules: followed into the package, as Vite bundles them
        walk(fileURLToPath(import.meta.resolve(spec)));
      } else if (!spec.startsWith("node:")) {
        const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        if (!packages.has(name)) packages.set(name, relative(ROOT, file));
      }
    }
  };
  for (const e of entries) walk(join(ROOT, e));
  return { files: [...files].map((f) => relative(ROOT, f)), packages };
}

it("the page reaches neither Ajv nor json-p3, nor the engine's modules that use them", () => {
  const { files, packages } = reach(["app/js/main.jsx"]);
  for (const name of ["ajv", "json-p3"]) assert.equal(packages.has(name), false, `${name}, from ${packages.get(name)}`);
  for (const file of ["engine/checks/index.js", "engine/checks/operators.js", "engine/schema.js", "engine/jsonpath.js", "engine/runner.js"]) {
    assert.equal(files.includes(join(HAFEN, file)), false, `${file} is reached from the page`);
  }
  // (It does reach what names a check, and the engine's own small modules it shows)
  assert.ok(files.includes(join(HAFEN, "engine/checks/names.js")));
});

it("the engine's worker still has what it runs with", () => {
  const { files, packages } = reach(["app/js/worker.js"]);
  for (const name of ["ajv", "json-p3", "yaml"]) assert.ok(packages.has(name), name);
  // (followed into the package: the worker runs the engine itself)
  assert.ok(files.includes(join(HAFEN, "engine/runner.js")));
});
