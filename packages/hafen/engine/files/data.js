// Data files (contracts/test-file.md, data): CSV with a header row, or JSON lines (one object per
// line). Each row becomes {{row.<column>}}; rows are numbered from 1. A row has a name (its test's
// row_name filled in with it, else its first column's value), said wherever the row is: "row 3: a
// refund please".

export const parseData = (text, file) => readData(text, file).rows;

// A data file read: { rows, columns, header }. columns: a CSV file's header, in order (header: true),
// or the keys JSON lines have, in the order they first come
export function readData(text, file) {
  if (/\.jsonl?$/i.test(file) || /^\s*\{/.test(text)) {
    const rows = text.split(/\r?\n/).map((line, i) => [line.trim(), i + 1]).filter(([line]) => line).map(([line, n]) => {
      try {
        const row = JSON.parse(line);
        if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error("not an object");
        return row;
      } catch (err) {
        throw new Error(`${file}:${n}: a row isn't a JSON object (${err.message})`);
      }
    });
    return { rows, columns: [...new Set(rows.flatMap((r) => Object.keys(r)))], header: false };
  }
  const records = parseCSV(text);
  if (!records.length) return { rows: [], columns: [], header: true };
  const [header, ...rows] = records;
  const columns = header.map((name) => name.trim());
  return { rows: rows.filter((r) => r.some((cell) => cell !== "")).map((r) => Object.fromEntries(columns.map((name, i) => [name, r[i] ?? ""]))), columns, header: true };
}

// A row's name, as every report says it: on one line, at most 60 characters (cut with "…");
// undefined for none (it's empty)
export const ROW_NAME_MAX = 60;
export function rowNameText(value) {
  if (value === undefined || value === null) return undefined;
  const text = (typeof value === "string" ? value : JSON.stringify(value)).replace(/\s+/g, " ").trim();
  const chars = [...text];
  if (chars.length <= ROW_NAME_MAX) return text || undefined;
  return `${chars.slice(0, ROW_NAME_MAX - 1).join("").trimEnd()}…`;
}

// A row's first column's value: a CSV file's by its header's order, a JSON line's first key's (read:
// readData's { columns, header }, when it's known)
export const firstCell = (row, read) => row?.[read?.header && read.columns.length ? read.columns[0] : Object.keys(row ?? {})[0]];

// Where a row is said: "row 3: a refund please", or "row 3" (no name: a run file from before row names)
export const rowLabel = (row, name) => (name ? `row ${row}: ${name}` : `row ${row}`);

// RFC 4180 CSV: quoted fields with "" for a quote, commas and newlines inside quotes
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
