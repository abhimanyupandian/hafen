// KEY=VALUE files (contracts/test-file.md, Environments and secrets): an environment's values (the
// CLI's --env <file>, {{env.NAME}}) and secrets (--secret <file>, {{secret.NAME}}), anywhere on the
// disk: whoever runs the engine reads them and passes the values in. Plain text, a value to a line:
//
//   # a comment, and blank lines, are kept as they are
//   base_url=https://staging.acme.example
//   db.host = db.internal          (spaces around = are fine; a dotted name is one name)
//   greeting="Hello, \"you\"\n"    (double quotes: \n, \t, \", \\ ; single quotes: as written)
//   export REGION=eu               (an `export ` before the name is allowed, and ignored)
//
// A value unquoted runs to the end of its line, less a ` # comment` after it (KEY= # not set yet: an
// empty value). Every value is text. Nothing here reads files: the host does.

// What a name is, for an environment's value and a secret alike: here, in {{env.NAME}} and
// {{secret.NAME}} (vars.js), a fixture's values, and the app's (letters, digits, _ . -, not starting
// with a digit)
export const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
export const NAME_RULE = "letters, digits, _ . -, not starting with a digit";
const LINE = /^\s*(?:export\s+)?([^=\s]+)\s*=(\s*)(.*)$/;

// A file's text: { values: { NAME: "value" }, errors: [{ file, line, column, message }],
// lines: [{ key, line }] } (where each name is, for problems that point at it)
export function parseEnvText(text, file = "") {
  const values = {};
  const errors = [];
  const lines = [];
  const rows = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const [i, row] of rows.entries()) {
    const line = i + 1;
    if (!row.trim() || row.trim().startsWith("#")) continue;
    const m = row.match(LINE);
    if (!m) {
      errors.push({ file, line, column: 1, message: `line ${line} isn't NAME=value` });
      continue;
    }
    const [, key, space, raw] = m;
    const column = row.indexOf(key) + 1;
    if (!NAME.test(key)) {
      errors.push({ file, line, column, message: `"${key}" isn't a name (${NAME_RULE})` });
      continue;
    }
    // (a # after the = and a space is a comment: KEY= # note is KEY, empty)
    const value = space && raw.startsWith("#") ? { text: "" } : valueOf(raw);
    if (value.error) {
      errors.push({ file, line, column: row.indexOf(raw) + 1, message: value.error });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      const first = lines.find((l) => l.key === key).line;
      errors.push({ file, line, column, message: `${key} is on line ${first} too: a name is set once` });
      continue;
    }
    values[key] = value.text;
    lines.push({ key, line, column });
  }
  return { values, errors, lines };
}

function valueOf(raw) {
  const text = raw.trimEnd();
  if (text.startsWith("\"")) {
    let out = "";
    for (let i = 1; i < text.length; i++) {
      const c = text[i];
      if (c === "\\" && i + 1 < text.length) {
        const n = text[++i];
        out += { n: "\n", t: "\t", r: "\r", "\"": "\"", "\\": "\\" }[n] ?? `\\${n}`;
      } else if (c === "\"") {
        const rest = text.slice(i + 1).trim();
        if (rest && !rest.startsWith("#")) return { error: `after a quoted value, only a # comment: not ${rest}` };
        return { text: out };
      } else out += c;
    }
    return { error: "a value that starts with \" ends with one" };
  }
  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1);
    if (end === -1) return { error: "a value that starts with ' ends with one" };
    const rest = text.slice(end + 1).trim();
    if (rest && !rest.startsWith("#")) return { error: `after a quoted value, only a # comment: not ${rest}` };
    return { text: text.slice(1, end) };
  }
  // (a # starts a comment only after a space: a URL's #fragment stays)
  return { text: text.replace(/\s+#.*$/, "").trim() };
}

// A value as it's written in a file: as it is when that reads back the same, else in double quotes
export function envValueText(value) {
  const text = String(value);
  const plain = text === text.trim() && !/[\n\r\t"'\\]/.test(text) && !/\s#/.test(text) && !text.startsWith("#");
  return plain ? text : `"${text.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

// A file's text with one name set (on its own line, in its place; a new one at the end) or taken
// out (value null): every other line, comments and blank ones too, as it was
export function editEnvText(text, key, value) {
  if (!NAME.test(key)) throw new Error(`"${key}" isn't a name (${NAME_RULE})`);
  const eol = /\r\n/.test(text ?? "") ? "\r\n" : "\n";
  const rows = String(text ?? "").split(/\r?\n/);
  const at = rows.findIndex((row) => row.match(LINE)?.[1] === key);
  if (value === null || value === undefined) {
    if (at !== -1) rows.splice(at, 1);
  } else if (at !== -1) rows[at] = `${key}=${envValueText(value)}`;
  else {
    while (rows.length && rows.at(-1) === "") rows.pop();
    rows.push(`${key}=${envValueText(value)}`, "");
  }
  return rows.join(eol);
}
