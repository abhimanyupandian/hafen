// A modal dialog, on <dialog> at the end of <body>: the browser keeps focus inside it, Esc closes
// it, the page behind can't be used meanwhile, and focus goes back where it was when it closes. A
// click on the dimmed backdrop closes it too. `onClose` runs however it closes (the owner then
// stops drawing it). `dialogRef` gets the <dialog>, to close it from inside.
//
// A modal opened from inside another (Settings → a large editor) is drawn in its own <dialog>, but in
// React's tree it's inside the other's, and React passes a "close" up that tree: so each acts on its
// own dialog's close only, and closing the editor goes back to Settings rather than closing both.

import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.jsx";

export function Modal({ id, label, className = "", onClose, dialogRef, children }) {
  const own = useRef(null);
  const ref = dialogRef ?? own;
  useLayoutEffect(() => { ref.current.showModal(); }, []);
  // The dialog has no padding of its own, so a click on it (not on what's inside) is on the backdrop.
  return createPortal(
    <dialog id={id} className={`modal ${className}`} aria-label={label} ref={ref}
            onClick={(e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }}
            onClose={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {children}
    </dialog>,
    document.body);
}

// The × that closes a modal, for its head.
export const CloseButton = ({ dialogRef, id }) => (
  <button type="button" className="btn btn-ghost btn-icon" id={id} aria-label="Close" title="Close" onClick={() => dialogRef.current.close()}>
    <Icon name="close" size={16} />
  </button>
);
