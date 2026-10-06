// A button that asks before acting: the first click turns it into `question`, the second runs
// `onConfirm`. Moving away (blur or mouse leave) cancels. Other props go to the <button>.

import { useState } from "react";

export function ConfirmButton({ label, question, onConfirm, className = "btn", ...props }) {
  const [asking, setAsking] = useState(false);
  const reset = () => setAsking(false);
  return (
    <button type="button" {...props} className={className + (asking ? " confirm" : "")}
            onClick={() => {
              if (!asking) return setAsking(true);
              reset();
              onConfirm();
            }}
            onBlur={reset} onMouseLeave={reset}>
      {asking ? question : label}
    </button>
  );
}
