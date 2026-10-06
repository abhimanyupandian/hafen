// A JSON value, browsable (spec/design/components.md, Additions: JSON tree): one row per key in the
// output box, objects and arrays folding with the tree toggle, keys grey and values in the text
// colour; an open object or array ends with its closing bracket, on a row of its own. A click on a
// value selects it and reports its path (RFC 9535: $.data.items[0].id).
//
//   <JsonTree id value selected onSelect={(path, value) => …} />

import { useState } from "react";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const childPath = (path, key) => (typeof key === "number" ? `${path}[${key}]` : IDENT.test(key) ? `${path}.${key}` : `${path}['${String(key).replace(/'/g, "\\'")}']`);
const isNode = (v) => v !== null && typeof v === "object";
const show = (v) => (typeof v === "string" ? JSON.stringify(v) : v === undefined ? "undefined" : JSON.stringify(v));

export function JsonTree({ id, value, selected, onSelect, label = "Response" }) {
  const [folded, setFolded] = useState(() => new Set());
  const rows = [];
  const walk = (v, path, key, depth) => {
    const node = isNode(v);
    const open = node && !folded.has(path);
    rows.push({ path, key, depth, value: v, node, open });
    if (open) {
      // As JSON has it: an object's key with no value isn't there (an array's empty slot is null)
      const entries = Array.isArray(v) ? v.map((x, i) => [i, x === undefined ? null : x]) : Object.entries(v).filter(([, x]) => x !== undefined);
      for (const [k, x] of entries) walk(x, childPath(path, k), k, depth + 1);
      rows.push({ path: `${path} end`, depth, end: Array.isArray(v) ? "]" : "}" });
    }
  };
  walk(value, "$", null, 0);
  const toggle = (path) => setFolded((f) => {
    const next = new Set(f);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });
  return (
    <div className="panel-output json-tree" id={id} role="tree" aria-label={label}>
      {rows.map((r) => (r.end ? (
        <div key={r.path} className="json-row json-end" style={{ paddingLeft: `${r.depth * 14}px` }} aria-hidden="true">
          <span className="tree-toggle"></span><span className="json-fold">{r.end}</span>
        </div>
      ) : (
        <div key={r.path} className={`json-row${selected === r.path ? " selected" : ""}`} style={{ paddingLeft: `${r.depth * 14}px` }} role="treeitem"
             aria-expanded={r.node ? r.open : undefined} aria-selected={selected === r.path || undefined}>
          {r.node
            ? <button type="button" className="tree-toggle" aria-expanded={String(r.open)} aria-label={`${r.open ? "Fold" : "Unfold"} ${r.path}`} onClick={() => toggle(r.path)}><span className="chev" aria-hidden="true"></span></button>
            : <span className="tree-toggle" aria-hidden="true"></span>}
          {r.key !== null && <span className="json-key">{typeof r.key === "number" ? `${r.key}: ` : `${r.key}: `}</span>}
          {r.node
            ? <span className="json-value json-fold" title={r.path} onClick={() => onSelect?.(r.path, r.value)}>{Array.isArray(r.value) ? (r.open ? "[" : `[${r.value.length}]`) : r.open ? "{" : `{${Object.values(r.value).filter((x) => x !== undefined).length}}`}</span>
            : <span className="json-value" title={r.path} tabIndex={0} onClick={() => onSelect?.(r.path, r.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(r.path, r.value); } }}>{show(r.value)}</span>}
        </div>
      )))}
    </div>
  );
}
