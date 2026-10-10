// Redaction (research §21), applied before anything is stored or written: secret headers, every
// value resolved from {{secret.…}}, and, when a suite asks, emails, card numbers and phone numbers.
// A secret is hidden as it is and as it shows once encoded: escaped in JSON (a body as it was sent,
// a reply that echoes it), percent-encoded (a query value, a form) and in base64 (Basic auth).

import { isObject } from "./util.js";

export const SECRET_HEADERS = ["authorization", "proxy-authorization", "x-api-key", "api-key", "cookie", "set-cookie", "x-goog-api-key"];

// The patterns a suite (redact: { patterns }) or --redact can ask for: what finds one, its label, and
// whether what was found is one. Applied in this order (a card's 15 digits aren't a phone number).
const PATTERNS = {
  // (Tried only where a run of its letters begins: from every letter of a long one, a hex id say, it
  // would read to the run's end each time, and take minutes)
  email: [/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  card: [/\b(?:\d[ -]?){12,18}\d\b/g, "[card]", isCard],
  // After a +, or in groups (555-123-4567, (555) 123 4567); never digits in a word or a hex id, or an
  // address's host:port
  phone: [/(?<![\w+.-])(?:\+\d[\d ().-]{5,22}|(?:\(\d{1,5}\)[ .-]?|\d{1,5}[ .-])\d[\d ().-]{1,20})\d(?![\w-]|[.:]\d)/g, "[phone]", isPhone],
};

// 13 to 19 digits that start as a card number does (2 to 6) and pass the Luhn check (an order number
// or a timestamp in milliseconds mostly doesn't)
function isCard(found) {
  const digits = found.replace(/\D/g, "");
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = Number(digits[digits.length - 1 - i]) * (i % 2 ? 2 : 1);
    sum += d > 9 ? d - 9 : d;
  }
  return /^[2-6]/.test(digits) && sum % 10 === 0;
}

// 7 to 15 digits, one separator at a time, parentheses only around a group. Without a +, not an IP
// (192.168.100.200), a date (2026-10-07, 07.10.2026) or a number grouped in thousands (1.234.567,
// 12 345 678), and with a group of 3 digits or more (not 10 20 30 40)
function isPhone(found) {
  const groups = found.match(/\d+/g);
  const digits = groups.join("").length;
  if (digits < 7 || digits > 15 || /[ .-]{2}/.test(found) || /[()]/.test(found.replace(/\(\d+\)/, ""))) return false;
  if (found.startsWith("+")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(found)) return false;
  if (/^(\d{4}[-. ]\d{1,2}[-. ]\d{1,2}|\d{1,2}[-. ]\d{1,2}[-. ]\d{4})$/.test(found)) return false;
  if (/^(\d{1,3}(\.\d{3})+|\d{1,2}( \d{3})+)$/.test(found)) return false;
  return groups.some((g) => g.length >= 3);
}

// Every secret value the engine has filled in, in this process (vars.js notes each): what the HTTP
// log the page sees hides, wherever it shows (an address's path, an error's message)
export const seenSecrets = new Set();
export const noteSecret = (value) => { if (value) seenSecrets.add(String(value)); };
let seen;
export const hideSeenSecrets = (text) => (seen ??= createRedactor({ secrets: seenSecrets })).text(String(text ?? ""));

export const REDACT_PATTERNS = Object.keys(PATTERNS);

// A secret header's value as the secrets it holds, to redact wherever else it shows (a reply that
// echoes it): the whole value, and a credential after its scheme (Bearer sk-…: sk-…)
export function headerSecrets(value) {
  const text = String(value ?? "");
  const credential = /^[A-Za-z][\w-]*\s+(\S+)$/.exec(text)?.[1];
  return credential ? [text, credential] : [text];
}

// A secret shorter than this isn't redacted: a value like "yes", "eu" or "443" would be cut out of
// ordinary words and numbers all through a record. A base64 form needs a few more letters (a short
// run of them turns up by chance in any long base64 text).
const MIN_SECRET = 4;
const MIN_BASE64 = 6;

// A secret's forms, worked out once each: itself; escaped in a JSON string, as JavaScript writes it
// and as Python does (\u escapes), once, twice (JSON in a JSON string) and three times (that in a
// stream's JSON event); percent-encoded as a query value or a form field (spaces as %20 or +) or in
// a whole address; and in base64
const formsOf = new Map();
function secretForms(secret) {
  if (!formsOf.has(secret)) {
    const json = (s) => JSON.stringify(s).slice(1, -1);
    // (Python writes JSON with each UTF-16 unit past ASCII as \u00e9)
    const ascii = (s) => s.split("").map((c) => (c.charCodeAt(0) > 0x7f ? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}` : c)).join("");
    const escaped = [json(secret), ascii(json(secret))];
    for (const once of escaped.slice()) escaped.push(json(once), json(json(once)));
    // (a lone surrogate can't be percent-encoded)
    const encoded = (encode) => { try { return encode(secret); } catch { return ""; } };
    const forms = [
      secret, ...escaped,
      encoded(encodeURIComponent), encoded(encodeURIComponent).replace(/%20/g, "+"),
      new URLSearchParams({ v: secret }).toString().slice(2), encoded(encodeURI),
      ...base64Forms(secret),
    ];
    formsOf.set(secret, [...new Set(forms)].filter((form) => form.length >= MIN_SECRET));
  }
  return formsOf.get(secret);
}

// A secret in base64 and base64url: whole, and the letters that are its own wherever it falls in a
// longer text that was encoded (user:password, for Basic auth), at each of the three byte alignments
function base64Forms(secret) {
  const bytes = new TextEncoder().encode(secret);
  const out = [];
  for (const shift of [0, 1, 2]) {
    const shifted = new Uint8Array(shift + bytes.length);
    shifted.set(bytes, shift);
    const base64 = btoa(Array.from(shifted, (b) => String.fromCharCode(b)).join(""));
    if (!shift) out.push(base64);
    out.push(base64.slice(Math.ceil((shift * 8) / 6), Math.floor((shifted.length * 8) / 6)));
  }
  return out.filter((form) => form.length >= MIN_BASE64).flatMap((form) => [form, form.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")]);
}

// secrets: a Set of strings (filled as {{secret.…}} values are resolved); headers: more header names
// (a list, or a Set that can grow: a conversation's provider can change); patterns: ["email",
// "card", "phone"]
export function createRedactor({ secrets = new Set(), headers = [], patterns = [] } = {}) {
  const more = headers instanceof Set ? headers : new Set(headers);
  const isSecretHeader = (name) => {
    const lower = String(name).toLowerCase();
    return SECRET_HEADERS.includes(lower) || [...more].some((h) => String(h).toLowerCase() === lower);
  };

  // Every secret's forms: gathered again only when a secret is added
  let counted = -1;
  let forms = [];
  const allForms = () => {
    const size = secrets.size ?? secrets.length;
    if (size !== counted) {
      counted = size;
      const long = [...secrets].filter(Boolean).map(String).filter((s) => s.length >= MIN_SECRET);
      forms = [...new Set(long.flatMap(secretForms))];
    }
    return forms;
  };
  const asked = Object.entries(PATTERNS).filter(([name]) => patterns.includes(name)).map(([, rule]) => rule);

  // Where in a text what's redacted is, as [start, end, label] in order: every place a secret's form
  // is (two that overlap hidden as one, so a secret containing another goes whole), then what the
  // patterns find in the rest
  const hidden = (value) => {
    const found = [];
    for (const form of allForms()) {
      for (let at = value.indexOf(form); at !== -1; at = value.indexOf(form, at + form.length)) found.push([at, at + form.length, "[redacted]"]);
    }
    let spans = [];
    for (const span of found.sort((a, b) => a[0] - b[0])) {
      const last = spans.at(-1);
      if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
      else spans.push(span);
    }
    // (Each pattern's finds come in order: merged in with the spans so far, those it overlaps left out)
    for (const [re, label, is] of asked) {
      const before = spans;
      let i = 0;
      spans = [];
      for (const m of value.matchAll(re)) {
        const start = m.index;
        const end = start + m[0].length;
        while (i < before.length && before[i][1] <= start) spans.push(before[i++]);
        if ((i < before.length && before[i][0] < end) || (is && !is(m[0]))) continue;
        spans.push([start, end, label]);
      }
      while (i < before.length) spans.push(before[i++]);
    }
    return spans;
  };

  const text = (value) => {
    let out = "";
    let at = 0;
    for (const [start, end, label] of hidden(value)) {
      out += value.slice(at, start) + label;
      at = end;
    }
    return at ? out + value.slice(at) : value;
  };

  // A stream's raw chunks (a turn's response.chunks) as the text they make: a secret split across
  // two would go through in pieces. Each chunk keeps its place; a label goes in the one where what it
  // hides began.
  const chunks = (list) => {
    const whole = list.join("");
    const spans = hidden(whole);
    let from = 0;
    let first = 0;  // the first span that doesn't end before this chunk
    return list.map((chunk) => {
      const to = from + chunk.length;
      while (first < spans.length && spans[first][1] <= from) first++;
      let out = "";
      let at = from;
      for (let i = first; i < spans.length && spans[i][0] < to; i++) {
        const [start, end, label] = spans[i];
        out += whole.slice(at, Math.max(at, start)) + (start >= from ? label : "");
        at = Math.min(end, to);
      }
      from = to;
      return out + whole.slice(at, to);
    });
  };

  // What this redactor gave back (an object), with the secrets and headers it knew then: given back as
  // it is while they're the same, wherever it turns up again (a turn's record, stored redacted, in the
  // event that says it ended and in the run at its end; a conversation's earlier turns, with each
  // message). Once one is added, it's redacted again, as anything is.
  const given = new WeakMap();
  const knows = () => `${secrets.size ?? secrets.length}\u0000${more.size}`;
  let now = "";

  const value = (v, key) => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return key === "chunks" && v.every((c) => typeof c === "string") ? chunks(v) : v.map((item) => value(item));
    if (isObject(v)) {
      if (key !== "headers" && given.get(v) === now) return v;
      return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, key === "headers" && isSecretHeader(k) ? "[redacted]" : value(item, k)]));
    }
    return v;
  };

  // Headers anywhere are objects under a "headers" key: their secret ones go whole
  return {
    redact: (v) => {
      now = knows();
      const out = value(v);
      if (isObject(out) && out !== v) given.set(out, now);
      return out;
    },
    headers: (h) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k, isSecretHeader(k) ? "[redacted]" : text(String(v))])),
    text,
    isSecretHeader,
    rules: () => ["headers", "secrets", ...patterns],
  };
}
