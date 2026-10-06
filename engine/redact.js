// Redaction (research §21), applied before anything is stored or written: secret headers, every
// value resolved from ${env:…}, and, when a suite asks, emails, card numbers and phone numbers.

import { isObject } from "./util.js";

export const SECRET_HEADERS = ["authorization", "proxy-authorization", "x-api-key", "api-key", "cookie", "set-cookie", "x-goog-api-key"];

const PATTERNS = {
  email: [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  card: [/\b(?:\d[ -]?){12,18}\d\b/g, "[card]"],
  phone: [/\+?\d[\d ().-]{7,}\d/g, "[phone]"],
};

// Every secret value the engine has filled in, in this process (vars.js notes each): what the HTTP
// log the page sees hides, wherever it shows (an address's path, an error's message)
export const seenSecrets = new Set();
export const noteSecret = (value) => { if (value) seenSecrets.add(String(value)); };
export const hideSeenSecrets = (text) => createRedactor({ secrets: seenSecrets }).text(String(text ?? ""));

// secrets: a Set of strings (filled as ${env:…} values are resolved); headers: more header names;
// patterns: ["email", "card", "phone"]
export function createRedactor({ secrets = new Set(), headers = [], patterns = [] } = {}) {
  const secretHeaders = new Set([...SECRET_HEADERS, ...headers.map((h) => h.toLowerCase())]);

  const text = (value) => {
    let out = value;
    // Longest first, so a secret containing another is replaced whole
    for (const secret of [...secrets].filter((s) => s && s.length >= 4).sort((a, b) => b.length - a.length)) {
      out = out.split(secret).join("[redacted]");
    }
    for (const name of patterns) {
      const [re, label] = PATTERNS[name] ?? [];
      if (re) out = out.replace(re, label);
    }
    return out;
  };

  const value = (v, key) => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map((item) => value(item));
    if (isObject(v)) {
      return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, key === "headers" && secretHeaders.has(k.toLowerCase()) ? "[redacted]" : value(item, k)]));
    }
    return v;
  };

  // Headers anywhere are objects under a "headers" key: their secret ones go whole
  return {
    redact: (v) => value(v),
    headers: (h) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k, secretHeaders.has(k.toLowerCase()) ? "[redacted]" : text(String(v))])),
    text,
    rules: () => ["headers", "secrets", ...patterns],
  };
}
