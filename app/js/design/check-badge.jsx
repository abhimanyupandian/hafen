// The result of one check (spec/design/components.md, Additions: Check badge): the design system's
// badge, 24px, coloured by status, its dot filled or hollow. A click selects the check.
//
//   <CheckBadge id status name reason onClick />   status: pass | fail | unsure | running | skipped | error | ""

export function CheckBadge({ id, status = "", name, reason, confidence, onClick, selected = false }) {
  const title = [name, status && `${status}${confidence !== undefined ? ` (confidence ${confidence})` : ""}`, reason].filter(Boolean).join(" · ");
  return (
    <button type="button" className={`btn btn-ghost badge check-badge${selected ? " selected" : ""}`} id={id} data-status={status} title={title}
            aria-label={`${name}: ${status || "not run yet"}`} aria-pressed={selected || undefined} onClick={onClick}>
      <span className="badge-dot" aria-hidden="true"></span><span className="badge-text">{name}</span>
    </button>
  );
}
