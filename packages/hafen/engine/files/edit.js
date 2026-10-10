// Editing a suite file in place (contracts/test-file.md): each edit changes only the text it has to,
// so comments, key order and formatting stay as they were, and a one-field change is a one-line diff.
// Where that can't be done safely, the yaml library rewrites the document.

import { isMap, isSeq, parseDocument, stringify } from "yaml";

// Apply edits to a suite's text, keeping comments and formatting: [{ op: "set" | "add" | "delete",
// path: [...], value }]. "add" appends to a list. Returns the new text.
//
// Each edit changes only the lines it's about (found by the parser's source positions), so
// everything else stays byte for byte, and a one-field change is a one-line diff. The result is
// parsed again and compared with the intended data; if they differ (an edit inside a flow
// collection, say), the edit is made through the YAML library instead, which keeps comments.
export function editText(text, file, edits) {
  // A file with Windows line endings keeps them, and one with a byte order mark keeps it: the edit is
  // made to the text without them, and they're put back
  const bom = text.startsWith("\uFEFF");
  const crlf = text.includes("\r\n");
  let work = bom ? text.slice(1) : text;
  if (crlf) work = work.replace(/\r\n/g, "\n");
  const kind = /\.json$/i.test(file) ? "json" : "yaml";
  let out;
  if (kind === "json") {
    const data = JSON.parse(work);
    for (const edit of edits) {
      checkTarget(data, edit, file);
      applyToObject(data, edit);
    }
    out = `${JSON.stringify(data, null, 2)}\n`;
  } else {
    out = work;
    for (const edit of edits) out = editOne(out, file, edit);
  }
  if (crlf) out = out.replace(/\n/g, "\r\n");
  return bom ? `\uFEFF${out}` : out;
}

function editOne(text, file, edit) {
  const doc = parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length) throw new Error(`can't edit ${file}: ${doc.errors[0].message.split("\n")[0]}`);
  const expected = doc.toJS();
  checkTarget(expected, edit, file);
  applyToObject(expected, structuredClone(edit));
  let attempt = null;
  try {
    attempt = surgical(text, doc, edit, expected);
  } catch {
    attempt = null;
  }
  if (attempt !== null) {
    const check = parseDocument(attempt);
    if (!check.errors.length && sameData(check.toJS(), expected)) return attempt;
  }
  // Through the library, checked the same way: an edit is made as meant, or not at all
  const library = viaLibrary(doc, edit);
  const check = parseDocument(library);
  if (check.errors.length || !sameData(check.toJS(), expected)) throw new Error(`can't make this change to ${file} (${edit.op} ${edit.path.join(".")})`);
  return library;
}

const sameData = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const lineStart = (text, at) => text.lastIndexOf("\n", at - 1) + 1;

const lineEnd = (text, at) => {
  const n = text.indexOf("\n", at);
  return n === -1 ? text.length : n;
};

const scalarText = (value) => stringify(value).trimEnd();

// A scalar as the value of a key at `column`: a text of several lines as a block (|, its lines
// indented under the key), anything else on the key's line
const scalarAt = (value, column) => {
  if (typeof value !== "string" || !value.includes("\n")) return scalarText(value);
  const [first, ...rest] = stringify({ v: value }, { lineWidth: 0 }).replace(/\n$/, "").split("\n");
  return [first.slice(3), ...rest.map((l) => (l ? " ".repeat(column) + l : l))].join("\n");
};

// A comment in a stretch of YAML: a # after a space (or at its start), outside quotes
const hasComment = (source) => /(^|\s)#/.test(source.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, '""'));

const flowText = (value) => stringify(value, { collectionStyle: "flow", lineWidth: 0 }).trimEnd();

const isCollection = (v) => v !== null && typeof v === "object";

// The outermost { flow } or [flow] collection on the way to `path` (path included): { node, path }
function flowAncestor(doc, path) {
  for (let i = 0; i <= path.length; i++) {
    const node = i === 0 ? doc.contents : doc.getIn(path.slice(0, i), true);
    if ((isMap(node) || isSeq(node)) && node.flow) return { node, path: path.slice(0, i) };
    if (!isMap(node) && !isSeq(node)) return null;
  }
  return null;
}

// The edit as a change to the text's lines, or null when it isn't a simple one. (`expected`: the data
// as the edit is to leave it)
function surgical(text, doc, { op, path, value }, expected) {
  const parentPath = path.slice(0, -1);
  const key = path.at(-1);
  // Inside a { flow } or [flow] collection (a check written on one line, say): that collection is
  // written again where it is, as flow, holding what it's to hold; the rest of the file stays as it was
  // (Only one written on one line with no comment in it: written again, it's one line as it was. One
  // over several lines, or with comments, is left to the library, which keeps them)
  const flow = flowAncestor(doc, op === "add" ? path : parentPath);
  if (flow) {
    const next = flow.path.reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), expected);
    if (next === undefined) return null;
    // An empty one ([] or {}: a list is left as `tests: []` when its last item goes) that now holds
    // maps or lists is written as a block under its key, as the format writes one (not one line that
    // grows with every test)
    const holder = flow.path.length === 0 ? null : flow.path.length === 1 ? doc.contents : doc.getIn(flow.path.slice(0, -1), true);
    if (!flow.node.items.length && isMap(holder) && !holder.flow && isCollection(next) && Object.values(next).some(isCollection)) {
      const pair = holder.items.find((p) => p.value === flow.node);
      const colon = pair?.key?.range ? text.indexOf(":", pair.key.range[1]) : -1;
      if (colon < 0 || colon > flow.node.range[0] || hasComment(text.slice(flow.node.range[1], lineEnd(text, flow.node.range[1])))) return null;
      const indent = pair.key.range[0] - lineStart(text, pair.key.range[0]);
      return replaceRange(text, [colon + 1, flow.node.range[1]], `\n${block(next, indent + 2)}`);
    }
    const source = text.slice(flow.node.range[0], flow.node.range[1]);
    if (/[\n\r]/.test(source) || hasComment(source)) return null;
    return replaceRange(text, flow.node.range, flowText(next));
  }
  if (op === "add") {
    const seq = doc.getIn(path, true);
    if (!isSeq(seq) || seq.flow || !seq.items.length) return null;
    const last = seq.items.at(-1);
    const itemStart = last.range[0];
    const dash = text.lastIndexOf("-", itemStart);
    const indent = dash - lineStart(text, dash);
    const at = lineEnd(text, Math.max(itemStart, last.range[1] - 1));
    const flow = isMap(last) && last.flow;
    let rendered;
    if (!isCollection(value)) rendered = `- ${scalarText(value)}`;
    else if (flow) rendered = `- ${flowText(value)}`;
    else rendered = block(value, indent + 2).replace(/^ */, `${" ".repeat(indent)}- `).slice(indent);
    return `${text.slice(0, at)}\n${" ".repeat(indent)}${rendered}${text.slice(at)}`;
  }
  const parent = doc.getIn(parentPath, true) ?? (parentPath.length === 0 ? doc.contents : undefined);
  if (op === "set") {
    if (isMap(parent) && !parent.flow) {
      const pair = parent.items.find((p) => p.key?.value === key);
      if (pair) {
        const node = pair.value;
        const column = pair.key?.range ? pair.key.range[0] - lineStart(text, pair.key.range[0]) : 0;
        // A key with no value (`name:`; the library gives it an empty one, right after the colon): the
        // value goes after its colon, a space apart
        const empty = !node || (node.range && node.range[0] === node.range[1] && node.value === null);
        if (empty && pair.key?.range && !isCollection(value)) {
          const colon = text.indexOf(":", pair.key.range[1]);
          if (colon < 0 || /[^\s]/.test(text.slice(pair.key.range[1], colon))) return null;
          return `${text.slice(0, colon + 1)} ${scalarAt(value, column)}${text.slice(colon + 1)}`;
        }
        if (!node || isCollection(value) || isMap(node) || isSeq(node)) {
          if (!node) return null;
          if (isCollection(value) && (isMap(node) || isSeq(node)) && node.flow) {
            // An empty one ([], {}) given maps or lists: a block under its key, as the format writes one
            if (!node.items.length && Object.values(value).some(isCollection) && !hasComment(text.slice(node.range[1], lineEnd(text, node.range[1])))) {
              const colon = text.indexOf(":", pair.key.range[1]);
              if (colon < 0 || colon > node.range[0]) return null;
              return replaceRange(text, [colon + 1, node.range[1]], `\n${block(value, column + 2)}`);
            }
            return replaceRange(text, node.range, flowText(value));
          }
          return null;
        }
        // A text of several lines goes as a block under its key (a message, say); a comment on its line
        // stays on the block's first line (`|- # greet`), not in its text
        const rendered = scalarAt(value, column);
        if (rendered.includes("\n")) {
          const end = lineEnd(text, valueEnd(text, node));
          const rest = text.slice(valueEnd(text, node), end);
          const [head, ...lines] = rendered.split("\n");
          return replaceRange(text, [node.range[0], end], [head + rest, ...lines].join("\n"));
        }
        return replaceRange(text, [node.range[0], valueEnd(text, node)], rendered);
      }
      // A new key, after the map's last pair, at its keys' indentation
      const firstKey = parent.items[0]?.key;
      if (!firstKey) return null;
      const indent = firstKey.range[0] - lineStart(text, firstKey.range[0]);
      const lastPair = parent.items.at(-1);
      const at = lineEnd(text, Math.max(lastPair.key.range[0], (lastPair.value?.range?.[1] ?? lastPair.key.range[1]) - 1));
      const line = isCollection(value)
        ? Array.isArray(value) || Object.keys(value).length > 3
          ? `${key}:\n${block(value, indent + 2)}`
          : `${key}: ${flowText(value)}`
        : `${key}: ${scalarText(value)}`;
      return `${text.slice(0, at)}\n${" ".repeat(indent)}${line}${text.slice(at)}`;
    }
    if (isSeq(parent) && !parent.flow && typeof key === "number") {
      const node = parent.items[key];
      if (!node) return null;
      // A list item replaced where it is: a flow one as flow, a block one as block (a comment on its
      // line, after it, stays)
      if (isCollection(value) && (isMap(node) || isSeq(node))) {
        if (node.flow) return replaceRange(text, node.range, flowText(value));
        const dash = text.lastIndexOf("-", node.range[0]);
        const indent = dash - lineStart(text, dash);
        const rendered = block(value, indent + 2).slice(indent + 2);
        return replaceRange(text, [node.range[0], valueEnd(text, node)], rendered);
      }
      if (isCollection(value) || isMap(node) || isSeq(node)) return null;
      return replaceRange(text, node.range, scalarText(value));
    }
    return null;
  }
  if (op === "delete") {
    if (isSeq(parent) && !parent.flow && typeof key === "number") {
      const node = parent.items[key];
      if (!node) return null;
      const dash = text.lastIndexOf("-", node.range[0]);
      // Comment lines just above the item, at its indentation, are about it: they go with it
      let from = lineStart(text, dash);
      const indent = dash - from;
      while (from > 0) {
        const prev = lineStart(text, from - 1);
        const line = text.slice(prev, from - 1);
        if (!new RegExp(`^ {${indent}}#`).test(line)) break;
        from = prev;
      }
      const cut = cutLines(text, from, Math.max(node.range[0], node.range[1] - 1));
      if (parent.items.length > 1) return cut;
      // The last item: the list stays, empty (`tests: []`)
      const holder = doc.getIn(parentPath.slice(0, -1), true) ?? (parentPath.length === 1 ? doc.contents : undefined);
      const pair = isMap(holder) && !holder.flow ? holder.items.find((p) => p.key?.value === parentPath.at(-1)) : null;
      if (!pair) return null;
      const colon = text.indexOf(":", pair.key.range[1]);
      if (colon === -1 || colon >= from) return null;
      return `${cut.slice(0, colon + 1)} []${cut.slice(colon + 1)}`;
    }
    if (isMap(parent) && !parent.flow) {
      const pair = parent.items.find((p) => p.key?.value === key);
      if (!pair) return null;
      return cutLines(text, pair.key.range[0], Math.max(pair.key.range[0], (pair.value?.range?.[1] ?? pair.key.range[1]) - 1));
    }
    return null;
  }
  return null;
}

const replaceRange = (text, range, replacement) => text.slice(0, range[0]) + replacement + text.slice(range[1]);

// Where a block value's own text ends (its range can run on into the blank lines after it)
const valueEnd = (text, node) => {
  let end = node.range[1];
  while (end > node.range[0] && /\s/.test(text[end - 1])) end--;
  return end;
};

function cutLines(text, from, to) {
  const start = lineStart(text, from);
  const end = lineEnd(text, to);
  return text.slice(0, start) + text.slice(end + 1);
}

// A value as block YAML, every line indented by `indent`
function block(value, indent) {
  return stringify(value, { lineWidth: 0 }).trimEnd().split("\n").map((l) => " ".repeat(indent) + l).join("\n");
}

// The edit through the YAML library (keeps comments; may respace them)
function viaLibrary(doc, edit) {
  if (edit.op === "delete") {
    doc.deleteIn(edit.path);
    return doc.toString({ lineWidth: 0 });
  }
  if (edit.op === "add") {
    const seq = doc.getIn(edit.path, true);
    const flow = isSeq(seq) && seq.items.length > 0 && seq.items.every((item) => isMap(item) && item.flow);
    const node = doc.createNode(edit.value, { flow });
    if (isSeq(seq)) seq.items.push(node);
    else doc.setIn(edit.path, doc.createNode([edit.value], { flow: false }));
    return doc.toString({ lineWidth: 0 });
  }
  const old = doc.getIn(edit.path, true);
  const parent = doc.getIn(edit.path.slice(0, -1), true);
  const flow = (old && (isMap(old) || isSeq(old)) && old.flow) || (isMap(parent) && parent.flow);
  doc.setIn(edit.path, typeof edit.value === "object" && edit.value !== null ? doc.createNode(edit.value, { flow: !!flow }) : edit.value);
  return doc.toString({ lineWidth: 0 });
}

// An edit has to find what it's about: the map or list it changes, and in a list, an item that's there
// (to set or delete). Otherwise it's refused, rather than doing nothing, changing another item, or
// filling in the gaps.
function checkTarget(data, { op, path }, file) {
  const where = path.join(".");
  const parent = path.slice(0, -1).reduce((v, k) => (v === null || v === undefined || typeof v !== "object" ? undefined : v[k]), data);
  const key = path.at(-1);
  const isObj = parent !== null && typeof parent === "object";
  if (!isObj) throw new Error(`${file} has nothing at ${path.slice(0, -1).join(".") || "the top"}: open it again`);
  if (Array.isArray(parent)) {
    if (typeof key !== "number" || key < 0) throw new Error(`${where} in ${file} isn't a list item`);
    if (key >= parent.length && !(op === "add" && key === parent.length)) throw new Error(`${file} has nothing at ${where}: open it again`);
  }
  // (Deleting a map key that isn't there changes nothing: it's already gone)
  if (op === "add" && parent[key] !== undefined && parent[key] !== null && !Array.isArray(parent[key])) throw new Error(`${where} in ${file} isn't a list`);
}

function applyToObject(data, { op, path, value }) {
  const parent = path.slice(0, -1).reduce((o, k) => (o[k] ??= typeof k === "number" ? [] : {}), data);
  const key = path.at(-1);
  if (op === "delete") {
    if (Array.isArray(parent)) parent.splice(key, 1);
    else delete parent[key];
  } else if (op === "add") {
    parent[key] ??= [];
    parent[key].push(value);
  } else parent[key] = value;
}
