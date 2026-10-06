// How requests reach the network. The engine never calls fetch itself: each host gives it a
// transport (research §5), and the wrappers here add retries and network simulation on top, the
// same way everywhere.
//
//   transport.send(request, { signal }) → response
//     request:  { url, method, headers: {name: value}, body?: string, redirect?: "follow" | "manual" | "error" }
//     response: { status, headers: {lowercase name: value}, body: ReadableStream | AsyncIterable }
//               (set-cookie: a list, one per cookie, where the platform lets it be read: not in a browser)

import { abortError, iterate, sleep } from "./util.js";

const headersObject = (headers) => {
  const out = Object.fromEntries([...headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
  const cookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (cookies.length) out["set-cookie"] = cookies;
  return out;
};

// A transport over fetch: Node's, a Worker's, a page's. With `relay` (the browser build's server,
// `hafen serve`), every call goes through it.
export function fetchTransport({ fetch: fetchImpl = globalThis.fetch, relay = null } = {}) {
  return {
    async send(request, { signal } = {}) {
      const init = { method: request.method ?? "POST", headers: request.headers ?? {}, body: request.body, signal, ...(request.redirect ? { redirect: request.redirect } : {}) };
      let res;
      try {
        res = relay
          ? await fetchImpl(`${relay.replace(/\/+$/, "")}/relay`, { ...init, headers: { ...init.headers, "x-hafen-target": request.url } })
          : await fetchImpl(request.url, init);
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        // In a browser, a call the endpoint doesn't allow (CORS) fails with a bare TypeError
        const blocked = typeof window !== "undefined" || typeof WorkerGlobalScope !== "undefined";
        throw Object.assign(new Error(blocked && !relay
          ? `The browser blocked the call to ${new URL(request.url).host} (the endpoint doesn't allow calls from web pages). Use the desktop app, or the relay (hafen serve).`
          : `Couldn't reach ${request.url}: ${err?.cause?.message ?? err?.message ?? err}`), { network: true });
      }
      if (relay && res.headers.get("x-hafen-relay") === "refused") {
        throw Object.assign(new Error(`The relay refused the call to ${request.url}: ${(await res.text()).slice(0, 200)}`), { network: true });
      }
      return { status: res.status, headers: headersObject(res.headers), body: res.body, url: request.url };
    },
  };
}

// Retry rate limits (429) and server errors (5xx) with backoff, honouring retry-after, up to
// `retries` times. onRetry({attempt, status, waitMs}) records each one.
export function withRetries(transport, { retries = 2, onRetry } = {}) {
  return {
    async send(request, options = {}) {
      for (let attempt = 0; ; attempt++) {
        const res = await transport.send(request, options);
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= retries) return res;
        const waitMs = retryAfter(res.headers) ?? Math.min(8000, 500 * 2 ** attempt);
        // Drain the body so the connection can be reused
        try { for await (const _ of iterate(res.body)); } catch {}
        onRetry?.({ attempt: attempt + 1, status: res.status, waitMs });
        await sleep(waitMs, options.signal);
      }
    },
  };
}

function retryAfter(headers) {
  const ms = Number(headers["retry-after-ms"]);
  if (ms > 0) return Math.min(ms, 60000);
  const value = headers["retry-after"];
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 60000)) : null;
}

// Network simulation (research §18): a delay (with jitter) before the response, bandwidth limited by
// pacing the body's chunks, and a share of streams cut off partway.
export function withNetwork(transport, profile, { random = Math.random } = {}) {
  if (!profile) return transport;
  const { delay_ms = 0, jitter_ms = 0, kbps, drop_rate = 0 } = profile;
  return {
    async send(request, options = {}) {
      const delay = delay_ms + (jitter_ms ? (random() * 2 - 1) * jitter_ms : 0);
      if (delay > 0) await sleep(delay, options.signal);
      const res = await transport.send(request, options);
      const drop = drop_rate > 0 && random() < drop_rate;
      if (!kbps && !drop) return res;
      return { ...res, body: paced(res.body, { kbps, drop, signal: options.signal, random }) };
    },
  };
}

async function* paced(body, { kbps, drop, signal, random }) {
  let sent = 0;
  const cutAt = drop ? 1 + Math.floor(random() * 4) : Infinity;  // drop after a few chunks
  let chunks = 0;
  for await (const chunk of iterate(body)) {
    if (++chunks > cutAt) throw Object.assign(new Error("The connection dropped (network simulation)"), { network: true });
    if (kbps) {
      const bytes = typeof chunk === "string" ? chunk.length : chunk.byteLength;
      sent += bytes;
      await sleep(((bytes * 8) / (kbps * 1000)) * 1000, signal);
    }
    if (signal?.aborted) throw abortError();
    yield chunk;
  }
}
