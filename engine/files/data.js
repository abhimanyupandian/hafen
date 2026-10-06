// Data files (contracts/test-file.md, data): CSV with a header row, or JSON lines (one object per
// line). Each row becomes {{row.<column>}}; rows are numbered from 1.

export function parseData(text, file) {
  if (/\.jsonl?$/i.test(file) || /^\s*\{/.test(text)) {
    return text.split(/\r?\n/).map((line, i) => [line.trim(), i + 1]).filter(([line]) => line).map(([line, n]) => {
      try {
        const row = JSON.parse(line);
        if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error("not an object");
        return row;
      } catch (err) {
        throw new Error(`${file}:${n}: a row isn't a JSON object (${err.message})`);
      }
    });
  }
  const records = parseCSV(text);
  if (!records.length) return [];
  const [header, ...rows] = records;
  return rows.filter((r) => r.some((cell) => cell !== "")).map((r) => Object.fromEntries(header.map((name, i) => [name.trim(), r[i] ?? ""])));
}

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
