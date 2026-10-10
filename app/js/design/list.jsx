// A list row: the main button, an optional size, and × to delete (click twice; the second click's
// label is `deleteQuestion`; a row with no onDelete has none). With `detail`, the button has two lines: the label over the detail.
// With `id`, the row is #<id>, its button #<id>-open and its × #<id>-delete. `before` goes ahead
// of the button (a tree's chevron); `actions` go after the size, before ×, and show like × does (a
// suite's + that adds a test); `data` becomes data-* attributes. `ariaLabel` names the button when its
// text alone doesn't (a turn's row: "turn 2: …"); `icon` goes in the button, before its text.

import { useLayoutEffect, useRef } from "react";
import { ConfirmButton } from "./confirm.jsx";

// extra: marks after the label, kept whole while the label is cut (a group, ×3); onContextMenu: the
// row's right-click
export function ListRow({ id, label, detail, title, active = false, size, onOpen, onDelete, deleteLabel = "Delete",
                          deleteQuestion = "delete", before, actions, style, data = {}, openDisabled, ariaLabel, icon, extra, onContextMenu }) {
  const text = detail ? <><span className="list-label">{label}</span><span className="list-detail">{detail}</span></> : extra ? <span className="list-label">{label}</span> : label;
  const dataset = Object.fromEntries(Object.entries(data).map(([key, value]) => [`data-${key}`, value]));
  return (
    <li className={"list-row" + (detail ? " two-line" : "") + (active ? " active" : "")} id={id} style={style} {...dataset} onContextMenu={onContextMenu}>
      {before}
      <button type="button" className={"list-open" + (extra && !detail ? " has-extra" : "")} id={id && `${id}-open`} title={title ?? label} aria-label={ariaLabel} aria-current={active ? "true" : undefined}
              disabled={openDisabled} onClick={onOpen}>{icon}{text}{extra}</button>
      {size && <span className="list-size">{size}</span>}
      {actions}
      {onDelete && <ConfirmButton className="btn btn-ghost list-del" id={id && `${id}-delete`} aria-label={`${deleteLabel}: ${label}`}
                                  label="×" question={deleteQuestion} onConfirm={onDelete} />}
    </li>
  );
}

// A <ul> of rows. A row's control that had focus has it again after the list draws (found by its
// id), so keyboard users don't lose their place when rows move.
export function List({ children, ...props }) {
  const ref = useRef(null);
  const focused = ref.current?.contains(document.activeElement) ? document.activeElement.id : "";
  useLayoutEffect(() => {
    if (focused && document.activeElement?.id !== focused) document.getElementById(focused)?.focus();
  });
  return <ul className="list" {...props} ref={ref}>{children}</ul>;
}
