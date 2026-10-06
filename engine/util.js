// Small helpers the engine shares. No DOM, no Node: everything here runs in a Web Worker, Electron's
// utility process and Node alike.

export const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Short random ids, 0-9a-z: `_id`s of runs, spans and the like.
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
export function uid(length = 16) {
  let id = "";
  while (id.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      // 252 = 7 × 36: bytes above it would make the first letters likelier
      if (byte < 252 && id.length < length) id += ALPHABET[byte % 36];
    }
  }
  return id;
}

// A test's id, as the app writes it into files: t_ + 8 characters
export const testId = () => `t_${uid(8)}`;

// Wait `ms`, or less if `signal` aborts (then it rejects with an AbortError).
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener("abort", stop, { once: true });
  });
}

export const abortError = (message = "stopped") => Object.assign(new Error(message), { name: "AbortError" });
export const isAbort = (err) => err?.name === "AbortError";

// Read a body: a web ReadableStream or any async iterable of bytes or strings, as strings.
export async function* textChunks(body) {
  const decoder = new TextDecoder();
  for await (const chunk of iterate(body)) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const rest = decoder.decode();
  if (rest) yield rest;
}

// Async-iterate a ReadableStream (not every browser lets you `for await` one directly).
export async function* iterate(body) {
  if (!body) return;
  if (typeof body.getReader !== "function") {
    yield* body;
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock?.();
  }
}

// Combine abort signals: aborts when any of them does.
export function anySignal(signals) {
  const live = signals.filter(Boolean);
  if (typeof AbortSignal.any === "function") return AbortSignal.any(live);
  const controller = new AbortController();
  for (const s of live) {
    if (s.aborted) controller.abort(s.reason);
    else s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

// Percentiles of numbers (nearest rank): {p50, p95, p99, n}
export function percentiles(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const at = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : undefined);
  return { p50: at(50), p95: at(95), p99: at(99), n: sorted.length };
}

// The path of a file relative to another's folder, with / separators (suite files name others so).
// Why a file a suite names isn't there: outside the opened folder (where the host can tell), or missing
export const missingFile = (host, path, what) => (host?.files?.outside?.(path) ? `${what} isn't in the opened folder (only files in it are read)` : `${what} doesn't exist`);

export function joinPath(fromFile, relative) {
  if (/^([a-z]+:)?\//i.test(relative) || /^[A-Za-z]:[\\/]/.test(relative)) return relative;
  const base = fromFile.split(/[\\/]/).slice(0, -1);
  for (const part of relative.split(/[\\/]/)) {
    if (part === "..") base.pop();
    else if (part && part !== ".") base.push(part);
  }
  const joined = base.join("/");
  return fromFile.startsWith("/") && !joined.startsWith("/") ? `/${joined}` : joined;
}

export const basename = (file) => file.split(/[\\/]/).pop();

// A value as one short line, for reasons and badges
export function short(value, max = 80) {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// Deep copy of plain data
export const copy = (value) => (value === undefined ? undefined : structuredClone(value));
