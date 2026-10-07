// The relay (`npm run serve`, serve.js; research §25): serves the browser build (app/dist) and relays
// its calls to endpoints on an allowlist, streaming responses through unchanged. It answers only its
// own pages (a request from another site's page, by its Origin, is refused) and listens on 127.0.0.1
// unless told otherwise. A refused call says so in a header, so the app can tell the user why.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../app/dist/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "origin", "referer", "content-length", "x-hafen-target", "accept-encoding"]);

// An address as fetch will call it: dot segments (and their %2e spellings) resolved, an http(s) one
// only; null for one that isn't
const callable = (url) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
};

// Whether `url` is on the allowlist: each entry is a prefix (https://api.acme.example/), compared with
// the address as it will be called (so /v1/chat/../../admin isn't under /v1/chat)
export const allowed = (allow, url) => {
  const target = callable(url);
  if (!target) return false;
  return allow.some((entry) => {
    const prefix = callable(entry) ?? entry;
    const bare = prefix.replace(/\/$/, "");
    return target === prefix || target === bare || target.startsWith(`${bare}/`) || target.startsWith(`${bare}?`);
  });
};

// The names a page on this machine reaches it by (when it listens on a loopback address)
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const isLoopback = (host) => LOOPBACK.has(String(host).toLowerCase()) || /^127\./.test(String(host));
const hostName = (header = "") => String(header).toLowerCase().replace(/:\d+$/, "");

// loopback: it listens on this machine only, so a call is relayed only for a page that reached it by a
// loopback name (a site whose name was made to point here, DNS rebinding, isn't its own page even when
// its Origin matches the Host it sent)
export function createRelay({ allow = [], dist = DIST, loopback = true } = {}) {
  return createServer(async (req, res) => {
    const self = `http://${req.headers.host}`;
    const url = new URL(req.url, self);
    try {
      if (url.pathname === "/relay/ping") return send(res, 200, { relay: true, endpoints: allow.length });
      if (url.pathname === "/relay") {
        if (loopback && !isLoopback(hostName(req.headers.host))) return refuse(res, 403, `the relay only answers pages on this machine (127.0.0.1, localhost), not ${hostName(req.headers.host) || "an unnamed host"}`);
        const origin = req.headers.origin;
        if (origin && origin !== self) return refuse(res, 403, `the relay only answers its own pages, not ${origin}`);
        const target = req.headers["x-hafen-target"];
        if (!target) return refuse(res, 400, "no target (x-hafen-target)");
        if (!allowed(allow, target)) return refuse(res, 403, `${target} isn't on the relay's allowlist (--allow-endpoint, or HAFEN_ENDPOINTS)`);
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k) && !k.startsWith("sec-")));
        const body = ["GET", "HEAD"].includes(req.method) ? undefined : Readable.toWeb(req);
        const controller = new AbortController();
        res.on("close", () => controller.abort());
        // (the address as the allowlist judged it)
        const upstream = await fetch(callable(target), { method: req.method, headers, body, duplex: "half", signal: controller.signal });
        const outHeaders = {};
        upstream.headers.forEach((v, k) => { if (!HOP.has(k) && k !== "content-encoding") outHeaders[k] = v; });
        res.writeHead(upstream.status, outHeaders);
        // (pipeline, not pipe: an upstream that drops mid-stream, or a page that goes away, ends this
        // response, below, rather than the relay)
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
        else res.end();
        return;
      }
      // The browser build's files
      const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
      let file = join(dist, path === "/" ? "index.html" : path);
      if (!file.startsWith(dist)) return send(res, 403, { error: "forbidden" });
      try {
        if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      } catch {
        file = join(dist, "index.html");
      }
      const content = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(content);
    } catch (err) {
      if (!res.headersSent) send(res, 502, { error: `the relay couldn't reach the endpoint: ${reasonOf(err)}` });
      // (begun already: the page sees its stream end short, as it would without the relay)
      else res.destroy();
    }
  });
}

// Why a call failed, as fetch says it: its cause's message, else (localhost tried as both 127.0.0.1
// and ::1) the first of its causes', else its code
const reasonOf = (err) => err.cause?.message || err.cause?.errors?.[0]?.message || err.cause?.code || err.message;

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function refuse(res, status, message) {
  res.writeHead(status, { "content-type": "application/json", "x-hafen-relay": "refused" });
  res.end(JSON.stringify({ error: message }));
}

export async function serve({ port = 8790, host = "127.0.0.1", allow = [] } = {}) {
  try {
    await stat(join(DIST, "index.html"));
  } catch {
    process.stderr.write("The browser build isn't there yet: run `npm run build` in evals/ first. The relay works without it.\n");
  }
  const server = createRelay({ allow, loopback: isLoopback(host) });
  // (a port that's taken, or an address this machine doesn't have: said plainly, a setup error)
  await new Promise((resolve, reject) => {
    server.once("error", (err) => reject(Object.assign(new Error(err.code === "EADDRINUSE" ? `port ${port} is in use: choose another with --port` : err.code === "EADDRNOTAVAIL" ? `this machine has no address ${host} (--host)` : err.code === "EACCES" ? `port ${port} needs more permissions: choose one above 1024 with --port` : `can't listen on ${host}:${port}: ${err.message}`), { setup: true })));
    server.listen(port, host, resolve);
  });
  process.stdout.write(`Hafen: http://${host}:${port}  ·  relay allows ${allow.length ? allow.join(", ") : "nothing yet (--allow-endpoint)"}\n`);
  return server;
}
