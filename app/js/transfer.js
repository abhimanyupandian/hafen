// Import and Export (contracts/ui.md, The workspace). The app keeps its suites, providers, plugins
// and data files in its own workspace; Import copies suites, with everything they use, from files or
// a folder the user picks into it, and Export copies them from it to a folder the user picks, as plain
// files ready for git and `npx hafen run <folder>`. What a suite uses is the engine's to say (its
// dependencies command: providers, data files, prices, schemas, plugins and what they import; never a
// secret); here are what's picked, what's asked, and what's said after. A file that's there with
// another text is never written over without asking.

import { createStore } from "./design/hooks.js";
import { notify } from "./design/toast.jsx";
import { invoke, isApp } from "./lib/app.js";
import { audit } from "./lib/audit.js";
import { say } from "./lib/log.js";
import * as kept from "./lib/scope-store.js";
import { envFile, secretFile } from "./lib/ci.js";
import { KEYS, store } from "./lib/store.js";
import { app, engineCall, reload, rememberExport, select } from "./state.js";

// A suite's file: name.hafen.yml (or .yaml, .json), as the engine finds them
const SUITE_FILE = /\.hafen\.(ya?ml|json)$/i;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const cancelled = (err) => err?.name === "AbortError";
// What a suite can use: the files a folder picked without the File System Access API is read for (not
// what's in node_modules, .git and the like, as the engine's hosts leave them out)
const USABLE = /\.(ya?ml|json|csv|jsonl|ndjson|m?js)$/i;
const LEFT_OUT = /(^|\/)(node_modules|\.git|\.hafen|dist|release)\//;

// A question the user answers in a dialog (views/transfer.jsx draws it), one at a time: { kind, …,
// answer(choice) }. kind: "collisions" (Import: files here with another text: replace, both, skip or
// cancel), "overwrite" (Export: files there already: overwrite or cancel), "legacy" (the folder opened
// before: import or later). The first answer counts (the dialog closing after it answers nothing).
export const questions = createStore({ open: null });
function ask(question) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (choice) => {
      if (answered) return;
      answered = true;
      questions.set({ open: null });
      resolve(choice);
    };
    questions.set({ open: { ...question, answer } });
  });
}

/* ---------- Import ---------- */

// The page's own file picker (a browser without the File System Access API): files, or a folder's
function chooseFiles({ folder }) {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement("input"), { type: "file", multiple: true, accept: folder ? "" : ".yml,.yaml,.json,.csv,.jsonl,.js,.mjs" });
    input.webkitdirectory = folder;
    input.onchange = () => resolve([...input.files]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

// Where to import from: { from (the engine's name for it), name, files (the suites picked; none: the
// folder's) }, or null. Files picked in a browser come without their folder, so each is found by the
// path a suite names it by (the provider it uses, its data…): pick those with the suites.
async function pickImport({ folder }) {
  if (isApp) {
    const picked = await invoke("import_pick", { folder });
    return picked && { from: { place: picked.place }, name: picked.name, files: picked.files };
  }
  if (folder) {
    if (window.showDirectoryPicker) {
      const handle = await window.showDirectoryPicker({ id: "hafen-import", mode: "read" });
      return { from: { handle }, name: handle.name, files: null };
    }
    const picked = await chooseFiles({ folder: true });
    if (!picked.length) return null;
    // (each by its path in the folder, which comes first)
    const files = {};
    for (const f of picked) {
      const path = f.webkitRelativePath.split("/").slice(1).join("/");
      if (USABLE.test(path) && !LEFT_OUT.test(path)) files[path] = await f.text();
    }
    return { from: { files }, name: picked[0].webkitRelativePath.split("/")[0], files: null };
  }
  const picked = window.showOpenFilePicker
    ? await Promise.all((await window.showOpenFilePicker({ id: "hafen-import", multiple: true, types: [{ description: "Suites, and the files they use", accept: { "text/yaml": [".yml", ".yaml"], "application/json": [".json"], "text/csv": [".csv"], "text/plain": [".jsonl"], "text/javascript": [".js", ".mjs"] } }] })).map((h) => h.getFile()))
    : await chooseFiles({ folder: false });
  if (!picked.length) return null;
  // (a script picked is a plugin: in plugins/, where a suite finds one by its name)
  const files = {};
  for (const f of picked) files[/\.m?js$/i.test(f.name) ? `plugins/${f.name}` : f.name] = await f.text();
  return { from: { files, loose: true }, name: picked.length === 1 ? picked[0].name : `${picked.length} files`, files: Object.keys(files).filter((f) => SUITE_FILE.test(f)) };
}

// Import suite files, or (folder) the suites in a folder: picked, then copied in (importFrom)
export async function importSuites({ folder = false } = {}) {
  try {
    const picked = await pickImport({ folder });
    return picked ? await importFrom(picked) : null;
  } catch (err) {
    if (cancelled(err)) return null;
    say(`couldn't import: ${err.message}`, "err");
    notify({ title: "Couldn't import", text: err.message, kind: "error" });
    return null;
  }
}

// Copy suites and what they use into the workspace, keeping their paths: a file that's here already
// with the same text is left as it is; any here with another text are asked about once (replace them,
// keep both: the ones imported under a free name, name-2.yml, the suites imported pointed at them; or
// skip them). → the suites imported (as they're named here), or null
export async function importFrom({ from, name, files }) {
  const suites = (files ?? (await engineCall("suites", { from }))).filter((f) => SUITE_FILE.test(f));
  if (!suites.length) {
    say(`import from ${name}: no suites there (files named *.hafen.yml, *.hafen.yaml or *.hafen.json)`, "err");
    notify({ title: `No suites in ${name}`, text: "A suite's file is named *.hafen.yml (or .hafen.yaml, .hafen.json).", kind: "error" });
    return null;
  }
  const uses = await engineCall("dependencies", { files: suites, from });
  const plan = await engineCall("copyPlan", { files: uses.files, from });
  const changed = plan.filter((p) => p.status === "changed").map((p) => p.file);
  const fresh = plan.filter((p) => p.status === "new").map((p) => p.file);
  const choice = changed.length ? await ask({ kind: "collisions", name, files: changed }) : "replace";
  if (choice === "cancel") {
    say(`import from ${name}: cancelled, nothing was copied`, "log");
    return null;
  }
  const out = await engineCall("copy", { files: choice === "skip" ? fresh : [...fresh, ...changed], from, keepBoth: choice === "both" ? changed : [] });
  await reload();
  // What it brought in: the suites written (as they're named here), and the ones here already as they are
  const same = suites.filter((f) => plan.find((p) => p.file === f)?.status === "same");
  const imported = [...out.written.filter((w) => SUITE_FILE.test(w.file)).map((w) => w.as), ...same];
  const others = out.written.filter((w) => !SUITE_FILE.test(w.file));
  const skipped = choice === "skip" ? changed : out.kept;
  say(`imported from ${name}: ${plural(imported.length, "suite")}${imported.length ? ` (${imported.join(", ")})` : ""}, ${plural(others.length, "other file")}`, "log");
  for (const w of out.written) say(`  ${w.as}${w.as !== w.file ? ` (${w.file} there: yours is kept as it was)` : ""}`, "log");
  for (const f of skipped) say(`  ${f}: not imported (${/\.m?js$/i.test(f) ? "a plugin is used by its name, so the one here stays" : "the one here stays"})`, "log");
  for (const f of same.filter((x) => !out.written.some((w) => w.file === x))) say(`  ${f}: here already, the same`, "log");
  for (const p of uses.problems) say(`  ${p.file}: ${p.message}`, "err");
  for (const pkg of uses.packages) say(`  ${pkg}: a plugin package, not a file: install it where the suites run`, "err");
  audit("suites.import", { from: name, suites: imported.length, files: out.written.length, choice: changed.length ? choice : undefined, problems: uses.problems.length || undefined });
  notify({
    title: imported.length ? `Imported ${plural(imported.length, "suite")} from ${name}` : `Nothing imported from ${name}`,
    text: [imported.length ? imported.join(", ") : "", others.length ? `${plural(others.length, "file")} they use` : "", skipped.length ? `${skipped.length} skipped` : "", uses.problems.length ? `${plural(uses.problems.length, "problem")}: see the console` : ""].filter(Boolean).join(" · "),
    kind: uses.problems.length ? "error" : imported.length ? "ok" : "",
  });
  if (imported.length) select({ kind: "suite", file: imported[0] });
  return imported;
}

/* ---------- Export ---------- */

// The Export dialog (views/transfer.jsx): the suites it's for, while it's open
export const exporting = createStore({ files: null });
export const openExport = (files) => exporting.set({ files });

// A folder to export to: { to (the engine's name for it), path, name, ci (its path as CI runs it) },
// or null
async function pickExport() {
  if (isApp) {
    const picked = await invoke("export_pick");
    return picked && { to: { place: picked.place }, path: picked.path, name: picked.name, ci: picked.ci };
  }
  if (!window.showDirectoryPicker) throw new Error("this browser can't write to a folder: use the desktop app, or a browser that can (Chrome, Edge)");
  const handle = await window.showDirectoryPicker({ id: "hafen-export", mode: "readwrite" });
  // (a browser gives only the folder's name: CI runs it from the folder that holds it)
  return { to: { handle }, path: handle.name, name: handle.name, ci: handle.name };
}


// Export suites (one, or all) and everything they use to a folder the user picks, as plain files with
// the same paths, so `npx hafen run <folder>` runs them as they are. env: also write the environment
// values (Globals' globals.env, then the scope chosen's <scope>.env, each its own, each only when it has
// any); secrets: and the secrets the same way (globals.secret.env, <scope>.secret.env), in plain text
// (asked first). Files there already are listed and asked about first. Where they went, and exactly
// which of those files were written, is remembered for each suite (Copy CI command). → where, or null
export async function exportSuites(files, { env = false, secrets = false } = {}) {
  let target;
  try {
    target = await pickExport();
    if (!target) return null;
    const uses = await engineCall("dependencies", { files });
    const { env: scope, scopeSecrets } = app.get();
    const entries = ["", ...(scope ? [scope] : [])];
    const texts = {};
    const envFiles = [];
    if (env) {
      for (const entry of entries) {
        const values = kept.valuesOf(entry);
        if (!Object.keys(values).length) continue;
        texts[envFile(entry)] = kept.envText(values, kept.valuesComment(entry, envFile(entry)));
        envFiles.push(envFile(entry));
      }
    }
    // (the desktop app's secrets never pass through the page: its main process writes them, after)
    const secretFiles = secrets ? entries.filter((entry) => scopeSecrets[entry]?.length).map((entry) => secretFile(entry)) : [];
    const also = isApp ? secretFiles : [];
    if (secrets && !isApp) {
      for (const entry of entries) {
        const values = await kept.secretValues(entry);
        if (Object.keys(values).length) texts[secretFile(entry)] = kept.envText(values, kept.secretsComment(entry));
      }
    }
    const plan = await engineCall("copyPlan", { files: uses.files, to: target.to, texts, also });
    const there = plan.filter((p) => p.status === "changed" || p.status === "there").map((p) => p.file);
    if (there.length && (await ask({ kind: "overwrite", name: target.name, files: there })) !== "overwrite") {
      say(`export to ${target.name}: cancelled, nothing was written`, "log");
      return null;
    }
    const out = await engineCall("copy", { files: uses.files.filter((f) => plan.find((p) => p.file === f)?.status !== "same"), to: target.to, texts });
    if (isApp) for (const entry of entries) if (secretFiles.includes(secretFile(entry))) await invoke("secrets_export", { env: entry, file: secretFile(entry), place: target.to.place });
    const wroteSecrets = isApp ? secretFiles : secretFiles.filter((f) => texts[f] !== undefined);
    const where = { path: target.path, name: target.name, ci: target.ci, scope: scope ?? "", env: envFiles, secret: wroteSecrets, at: Date.now() };
    rememberExport(files, where);
    const written = out.written.length + (isApp ? wroteSecrets.length : 0);
    say(`exported ${plural(files.length, "suite")} to ${target.path}: ${plural(uses.files.length, "file")} (${plural(written, "written")}, the rest there already, the same)`, "log");
    for (const w of out.written) say(`  ${w.as}`, "log");
    if (isApp) for (const f of wroteSecrets) say(`  ${f} (secrets, in plain text: keep it out of version control)`, "log");
    for (const p of uses.problems) say(`  ${p.file}: ${p.message}`, "err");
    for (const pkg of uses.packages) say(`  ${pkg}: a plugin package, not a file: install it where the suites run`, "err");
    audit("suites.export", { to: target.path, suites: files.length, files: written, env: envFiles.join(",") || undefined, secrets: wroteSecrets.length ? "written" : undefined });
    notify({
      title: `Exported ${files.length === 1 ? files[0] : plural(files.length, "suite")} to ${target.name}`,
      text: [`${plural(uses.files.length, "file")}`, uses.problems.length ? `${plural(uses.problems.length, "problem")}: see the console` : `npx hafen run ${target.ci}`].join(" · "),
      kind: uses.problems.length ? "error" : "ok",
    });
    return where;
  } catch (err) {
    if (cancelled(err)) return null;
    say(`couldn't export${target ? ` to ${target.path}` : ""}: ${err.message}`, "err");
    notify({ title: "Couldn't export", text: err.message, kind: "error" });
    return null;
  }
}

/* ---------- the folder opened before ---------- */

// The folder the desktop app opened before it kept its own workspace (remembered as KEYS.root): on the
// first start of this version it's offered once, to import its suites from; then forgotten, whatever
// the answer. (The browser build never remembered one.)
export async function offerLegacyFolder() {
  const path = store.get(KEYS.root);
  if (!path) return;
  if (!isApp) {
    store.remove(KEYS.root);
    return;
  }
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const choice = await ask({ kind: "legacy", name, path });
  store.remove(KEYS.root);
  if (choice !== "import") {
    say(`${name}'s suites weren't imported: Suites → Import a folder… brings them in any time`, "log");
    return;
  }
  try {
    const picked = await invoke("import_legacy", { path });
    if (!picked) {
      notify({ title: `Couldn't import from ${name}`, text: "The folder isn't there any more.", kind: "error" });
      return;
    }
    await importFrom({ from: { place: picked.place }, name: picked.name, files: null });
  } catch (err) {
    say(`couldn't import from ${name}: ${err.message}`, "err");
    notify({ title: `Couldn't import from ${name}`, text: err.message, kind: "error" });
  }
}
