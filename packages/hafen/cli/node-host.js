// The engine's host in Node (the CLI, and the desktop app's utility process): files under a root
// folder, secrets from the environment, fetch for the network (research §5).

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchTransport } from "../engine/transport.js";

const SKIP = new Set(["node_modules", ".git", ".hafen", "dist", "release"]);
export const VERSION = "0.1.0";

// root: the folder suite paths are relative to. secrets(NAME, {env}): where secrets ({{secret.NAME}})
// come from (the command line's: secretsFrom). also: more folders files may be read from (the ones a
// command line names, outside the current one).
//
// Files are read only under the root (and `also`): a suite can't name a file elsewhere (a key, a
// credentials file) to have it read and sent on. Links are followed before that's checked. They're
// written and removed only under the root.
export function nodeHost({ root = process.cwd(), secrets = (name) => process.env[name], transport = fetchTransport(), app = "cli", saveRun, also = [] } = {}) {
  const abs = (p) => (isAbsolute(p) ? p : join(root, p));
  const under = (dir, full) => {
    const rel = relative(dir, full);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  const realOr = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const readRoots = [root, ...also].map((d) => resolve(d));
  const realRoots = readRoots.map(realOr);
  const readable = (full) => readRoots.some((d) => under(d, full)) || realRoots.some((d) => under(d, full));
  // A path that may be read: under a read root, as written and once links are followed
  const reading = async (p) => {
    const full = resolve(abs(p));
    if (!readable(full)) throw new Error(`${p} isn't in the opened folder`);
    const real = await realpath(full).catch((err) => { if (err.code === "ENOENT") return full; throw err; });
    if (!realRoots.some((d) => under(d, real)) && !readRoots.some((d) => under(d, real))) throw new Error(`${p} isn't in the opened folder`);
    return full;
  };
  // A path under the root, or an error (files are only written and removed there)
  const inside = (p) => {
    const full = resolve(abs(p));
    if (!under(resolve(root), full) || full === resolve(root)) throw new Error(`${p} isn't in the opened folder`);
    return abs(p);
  };
  return {
    root,
    transport,
    secrets,
    now: () => performance.now(),
    clock: () => Date.now(),
    where: { app, version: VERSION, os: process.platform, node: process.versions.node },
    sha256: async (text) => createHash("sha256").update(text).digest("hex"),
    files: {
      read: async (p) => readFile(await reading(p), "utf8"),
      // A path outside the folders that may be read (so a message can say so, rather than "doesn't exist")
      outside: (p) => !readable(resolve(abs(p))),
      // Writes and removals only under the root
      async write(p, text) {
        const at = inside(p);
        await mkdir(dirname(at), { recursive: true });
        await writeFile(at, text);
      },
      async remove(p) {
        await rm(inside(p));
      },
      async exists(p) {
        try {
          await stat(await reading(p));
          return true;
        } catch {
          return false;
        }
      },
    },
    // Every file under the root, or under `dir` (a folder that may be read): paths relative to the root,
    // with / separators
    async list(dir = root) {
      const out = [];
      if (!readable(resolve(dir))) return out;
      const walk = async (d) => {
        let entries;
        try {
          entries = await readdir(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.name.startsWith(".") && e.name !== ".") { if (SKIP.has(e.name) || e.isDirectory()) continue; }
          if (SKIP.has(e.name)) continue;
          const full = join(d, e.name);
          if (e.isDirectory()) await walk(full);
          else out.push(relative(root, full).split(sep).join("/"));
        }
      };
      await walk(resolve(dir));
      return out;
    },
    saveRun,
    pluginWorker: nodePluginWorker,
    // A plugin's module, by its file: loaded from there, so it imports other files and packages as
    // any module does (relative to it; packages from its node_modules up)
    moduleUrl: (file) => pathToFileURL(resolve(abs(file))).href,
    // A plugin package, found from the root (as Node would find it from there)
    resolvePackage: async (name) => createRequire(join(resolve(root), "package.json")).resolve(name),
  };
}

// A plugin's worker: a thread with no environment (it can't read the process's secrets)
export function nodePluginWorker() {
  // (a plugin is an ES module: Node needn't say so when its project's package.json has no "type")
  const worker = new Worker(new URL("../engine/plugin-worker-node.js", import.meta.url), { env: {}, execArgv: [...process.execArgv, "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"] });
  return {
    post: (message) => worker.postMessage(message),
    onMessage: (handler) => worker.on("message", handler),
    onError: (handler) => worker.on("error", handler),
    terminate: () => worker.terminate(),
  };
}

// A path given on the command line, relative to the root, with / separators
export const fromRoot = (root, p) => relative(root, resolve(p)).split(sep).join("/");

// Where the command line's secrets come from: a secrets file's values (--secret, KEY=VALUE), each
// it sets, then the process's environment variables (CI's secrets). A name the file leaves empty
// (NAME=) isn't set by it.
export const secretsFrom = (values = {}) => (name) => (Object.hasOwn(values, name) && values[name] !== "" ? values[name] : process.env[name]);
