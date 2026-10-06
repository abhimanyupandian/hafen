// JavaScript in the large editor (spec/design/components.md, Additions: Code editor): its colours
// (comments, strings, numbers, keywords, a call's name), and its formatting: each line indented by the
// brackets open before it, two spaces a level, as the plugins' starting files are. No library: a small
// tokenizer that knows JavaScript's comments, strings (template ones over several lines too) and
// numbers, which is all colouring and indenting need.

const KEYWORDS = "as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|false|finally|for|from|function|get|if|import|in|instanceof|let|new|null|of|return|set|static|super|switch|this|throw|true|try|typeof|undefined|var|void|while|with|yield";

// One token at a time: [comment, string, number, keyword, a call's name]
const TOKEN = new RegExp([
  String.raw`(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))`,
  String.raw`('(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?|\`(?:\\[\s\S]|[^\`\\])*\`?)`,
  String.raw`(\b(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?)\b)`,
  String.raw`(\b(?:${KEYWORDS})\b)`,
  String.raw`([A-Za-z_$][\w$]*)(?=\s*\()`,
].join("|"), "g");
const KINDS = ["comment", "string", "number", "keyword", "fn"];

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The text's tokens, in order, every character in one: [{ kind: "comment" | "string" | "number" |
// "keyword" | "fn" | "code", text }]
export function tokens(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(TOKEN)) {
    if (m.index > last) out.push({ kind: "code", text: text.slice(last, m.index) });
    const at = m.slice(1).findIndex((g) => g !== undefined);
    out.push({ kind: KINDS[at], text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "code", text: text.slice(last) });
  return out;
}

// The text as HTML, each token in a span of its kind (.tok-comment…), escaped
export function highlightJs(text) {
  return tokens(String(text)).map((t) => (t.kind === "code" ? escape(t.text) : `<span class="tok-${t.kind}">${escape(t.text)}</span>`)).join("");
}

const OPEN = { "{": "}", "[": "]", "(": ")" };
const CLOSE = new Set(Object.values(OPEN));
// A line that carries on the one before it (a chained call, a ternary's ? or :, && || ??): a level more
const CONTINUES = /^(\.(?!\.\.)|\?|:|&&|\|\|)/;

// Format: each line indented by the brackets still open before it (the lines that opened them, a level
// each, however many a line opens), a closing bracket at its line's start back at its opener's level,
// a line that carries on the one before it a level more; spaces at line ends removed. A line inside a
// comment or a template string over several lines stays as it is.
export function formatJs(text) {
  const source = String(text);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  // Where each line starts, and whether it starts inside a token (a comment or string over lines)
  const starts = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const flat = source.replace(/\r\n/g, "\n");
  const inside = new Array(lines.length).fill(false);
  const brackets = [];  // [{ at, char }] in code only
  let at = 0;
  for (const t of tokens(flat)) {
    if (t.kind === "code") {
      for (let i = 0; i < t.text.length; i++) if (OPEN[t.text[i]] || CLOSE.has(t.text[i])) brackets.push({ at: at + i, char: t.text[i] });
    } else if (t.text.includes("\n")) {
      // The lines this token runs on to
      for (let line = 0; line < lines.length; line++) if (starts[line] > at && starts[line] < at + t.text.length) inside[line] = true;
    }
    at += t.text.length;
  }
  const stack = [];  // the line of each bracket still open
  let b = 0;
  const out = [];
  for (const [n, line] of lines.entries()) {
    const end = starts[n] + line.length;
    const mine = [];
    while (b < brackets.length && brackets[b].at < end) mine.push(brackets[b++]);
    if (inside[n]) {
      out.push(line);
    } else {
      const body = line.trim();
      // The closing brackets it starts with take its level back to their openers'
      let leading = 0;
      const lead = body.match(/^[}\])]+/)?.[0] ?? "";
      for (const c of lead) if (CLOSE.has(c) && leading < stack.length) leading++;
      const open = new Set(stack.slice(0, stack.length - leading)).size;
      const level = open + (CONTINUES.test(body) ? 1 : 0);
      out.push(body ? "  ".repeat(level) + body : "");
    }
    for (const { char } of mine) {
      if (OPEN[char]) stack.push(n);
      else if (stack.length) stack.pop();
    }
  }
  return out.join(eol);
}

// Enter at `caret` in `text`: what to insert, a new line indented as the line it breaks is (a level
// more after an opening bracket; with its closer right after the caret, that on a line of its own)
export function newLine(text, caret) {
  const before = text.slice(0, caret);
  const lineStart = before.lastIndexOf("\n") + 1;
  const indent = before.slice(lineStart).match(/^[ \t]*/)[0];
  const prev = before.trimEnd().slice(-1);
  const next = text.slice(caret).trimStart()[0];
  if (OPEN[prev]) {
    const inner = `\n${indent}  `;
    // (its closer on the same line, only spaces before it: on a line of its own)
    return OPEN[prev] === next && /^[ \t]*$/.test(text.slice(caret, text.indexOf(next, caret))) ? { insert: `${inner}\n${indent}`, caret: inner.length } : { insert: inner, caret: inner.length };
  }
  return { insert: `\n${indent}`, caret: indent.length + 1 };
}
