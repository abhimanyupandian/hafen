// The engine in the browser build: a Web Worker running engine/serve-port.js (research §5), so a long
// run never blocks the page. Files come from a folder the user opened (the File System Access API) or
// from files opened one at a time (kept in memory, downloaded when saved); calls go straight to the
// endpoint, or through the relay when the app was served by `hafen serve`.

import { servePort } from "../../engine/serve-port.js";
import { fetchTransport } from "../../engine/transport.js";

const VERSION = "0.1.0";

servePort(
  {
    receive: (handler) => { self.onmessage = (e) => handler(e.data); },
    send: (message) => self.postMessage(message),
  },
  async ({ handle = null, files = {}, relay = null, secrets = {} }) => browserHost({ handle, files, relay, secrets }),
);

// What the desktop app's host (cli/node-host.js) doesn't list either
const SKIP = new Set(["node_modules", ".git", ".hafen", "dist", "release"]);

function browserHost({ handle, files, relay, secrets }) {
  const memory = new Map(Object.entries(files));
  const written = new Map();  // files changed in memory (no folder): the page offers them as downloads
  let values = secrets;
  const host = {
    root: handle?.name ?? null,
    transport: fetchTransport({ relay }),
    secrets: (name, { env } = {}) => values[env]?.[name] ?? values[""]?.[name],
    // New secrets or relay (engine "configure"): the files, and edits to those in memory, stay
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
          if (!memory.has(path)) throw new Error(`${path} isn't open`);
          return memory.get(path);
        }
        const file = await fileHandle(handle, path);
        return (await file.getFile()).text();
      },
      async write(path, text) {
        if (!handle) {
          memory.set(path, text);
          written.set(path, text);
          return;
        }
        const file = await fileHandle(handle, path, { create: true });
        const stream = await file.createWritable();
        await stream.write(text);
        await stream.close();
      },
      async remove(path) {
        if (!handle) {
          if (!memory.delete(path)) throw new Error(`${path} isn't open`);
          written.delete(path);
          return;
        }
        const parts = path.split("/").filter(Boolean);
        if (parts.includes("..")) throw new Error(`${path} isn't in the opened folder`);
        let dir = handle;
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        await dir.removeEntry(parts.at(-1));
      },
      async exists(path) {
        if (!handle) return memory.has(path);
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
    written,
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
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
  return dir.getFileHandle(parts.at(-1), { create });
}
