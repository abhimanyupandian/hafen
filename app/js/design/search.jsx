// A list's search field (spec/design/components.md, Additions: Search field): the search icon, a small
// input, and × to clear it when it has text; Esc clears it too.
//
//   <SearchField id="suitesSearch" label="Search suites" value={q} onChange={setQ} />

import { Icon } from "./icons.jsx";

export function SearchField({ id, label, value, onChange, placeholder = "Search by name or date" }) {
  return (
    <div className="search-field" role="search">
      <span className="search-icon" aria-hidden="true"><Icon name="search" size={14} /></span>
      <input className="input search-input" id={id} type="search" aria-label={label} placeholder={placeholder} autoComplete="off" spellCheck={false}
             value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && value) { e.preventDefault(); e.stopPropagation(); onChange(""); } }} />
      {value && (
        <button type="button" className="btn btn-ghost btn-icon search-clear" id={`${id}Clear`} aria-label="Clear the search" title="Clear" onClick={() => { onChange(""); document.getElementById(id)?.focus(); }}>
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}
