// The engine in the browser build: a Web Worker running hafen/engine/serve-port.js (research §5), so a long
// run never blocks the page. Its files are the app's workspace: a folder in this browser's private
// file system (the Origin Private File System, `workspace/`), opened by itself when the app starts,
// never one the user picks. Import and Export copy files from and to a folder the user picked (its
// handle) or files picked one by one (kept in memory). Calls go straight to the endpoint, or through
// the relay when the app was served by `npm run serve` (server/serve.js).

import { servePort } from "hafen/engine/serve-port.js";
import { fetchTransport } from "hafen/engine/transport.js";
import { setPluginsWhere } from "hafen/engine/plugin-place.js";

// (the app keeps its plugins: a problem naming one that isn't there says where to add it)
setPluginsWhere("your plugins (Settings → Plugins) or the suite's plugins");

const VERSION = "0.0.2";
// The workspace's folder in the private file system
const WORKSPACE = "workspace";

servePort(
  {
    receive: (handler) => { self.onmessage = (e) => handler(e.data); },
    send: (message) => self.postMessage(message),
  },
  async ({ relay = null, secrets = {} }) => browserHost({ handle: await workspace(), relay, secrets }),
  // A folder picked (its handle, or its files read by their paths: { files }), or files picked one by
  // one ({ files: { name: text }, loose: true }: each found by the path a suite names it by, as there
  // are no folders to go by)
  async ({ handle, files, loose }) => browserHost({ handle: handle ?? null, files: files ?? {}, loose: !!loose }),
);

// The workspace's folder; a browser that can't keep one has it in memory, until the page closes
async function workspace() {
  try {
    return await (await navigator.storage.getDirectory()).getDirectoryHandle(WORKSPACE, { create: true });
  } catch {
    return null;
  }
}

// What the desktop app's host (hafen/cli/node-host.js) doesn't list either
const SKIP = new Set(["node_modules", ".git", ".hafen", "dist", "release"]);

// The secrets the page gave, by scope ("": Globals'), as the desktop app's host has them
// (desktop/engine-host.js): a scope's own (none chosen: "", Globals' alone), else Globals'. Only a map's
// own text values count: {{secret.constructor}} is a secret nobody set, not what every object inherits.
const own = (map, key) => (map && typeof map === "object" && Object.hasOwn(map, key) ? map[key] : undefined);
const text = (value) => (typeof value === "string" ? value : undefined);
const secretIn = (values, name, env) => text(own(own(values, env || ""), name)) ?? text(own(own(values, ""), name));
// Every secret value a scope and Globals hold: the engine hides each one in what it keeps (a run file),
// whether a file used it or not
const knownIn = (values, env) => [...new Set([env || "", ""])].flatMap((e) => Object.values(own(values, e) ?? {}).filter((v) => typeof v === "string" && v !== ""));

// loose: files picked one by one, read by the path a suite names them by, or else by their name alone
function browserHost({ handle, files = {}, relay = null, secrets = {}, loose = false }) {
  const memory = new Map(Object.entries(files));
  // (a file picked on its own: the one of that name, wherever a suite says it is)
  const inMemory = (path) => (memory.has(path) ? path : loose ? [...memory.keys()].find((k) => k.split("/").pop() === path.split("/").pop()) : undefined);
  let values = secrets;
  const host = {
    root: handle?.name ?? null,
    transport: fetchTransport({ relay }),
    secrets: (name, { env } = {}) => secretIn(values, name, env),
    knownSecrets: (env) => knownIn(values, env),
    // New secrets or relay (engine "configure"): the files stay
    configure({ secrets: next, relay: nextRelay } = {}) {
      if (next) values = next;
      if (nextRelay !== undefined) host.transport = fetchTransport({ relay: nextRelay });
    },
    now: () => performance.now(),
    clock: () => Date.now(),
    where: { app: "browser", version: VERSION, browser: navigator.userAgent },
    sha256: async (text) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join(""),
    files: {
      async read(path) {
        if (!handle) {
          const at = inMemory(path);
          if (at === undefined) throw new Error(`${path} isn't there`);
          return memory.get(at);
        }
        const file = await fileHandle(handle, path);
        return (await file.getFile()).text();
      },
      async write(path, text) {
        if (!handle) {
          memory.set(path, text);
          return;
        }
        const file = await fileHandle(handle, path, { create: true });
        const stream = await file.createWritable();
        await stream.write(text);
        await stream.close();
      },
      async remove(path) {
        if (!handle) {
          if (!memory.delete(path)) throw new Error(`${path} isn't there`);
          return;
        }
        const parts = path.split("/").filter(Boolean);
        if (parts.includes("..")) throw new Error(`${path} isn't in the workspace`);
        let dir = handle;
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        await dir.removeEntry(parts.at(-1));
      },
      async exists(path) {
        if (!handle) return inMemory(path) !== undefined;
        try {
          await fileHandle(handle, path);
          return true;
        } catch {
          return false;
        }
      },
    },
    async list() {
      if (!handle) return [...memory.keys()];
      const out = [];
      const walk = async (dir, prefix) => {
        for await (const [name, entry] of dir.entries()) {
          if (SKIP.has(name) || (entry.kind === "directory" && name.startsWith("."))) continue;
          if (entry.kind === "directory") await walk(entry, `${prefix}${name}/`);
          else out.push(`${prefix}${name}`);
        }
      };
      await walk(handle, "");
      return out;
    },
    // A plugin's worker: a Web Worker of its own
    pluginWorker() {
      const w = new Worker(new URL("./plugin-worker.js", import.meta.url), { type: "module" });
      return {
        post: (message) => w.postMessage(message),
        onMessage: (handler) => w.addEventListener("message", (e) => handler(e.data)),
        onError: (handler) => w.addEventListener("error", (e) => handler(new Error(e.message || "the worker stopped"))),
        terminate: () => w.terminate(),
      };
    },
  };
  return host;
}

async function fileHandle(root, path, { create = false } = {}) {
  const parts = path.split("/").filter(Boolean);
  if (parts.includes("..")) throw new Error(`${path} isn't in the folder`);
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
  return dir.getFileHandle(parts.at(-1), { create });
}
