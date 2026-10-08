// A <select> of [value, label] pairs (or [value, label, disabled]) with `value` selected; a
// {group, options} entry is an <optgroup> of such pairs. As with setting select.value, a value
// that's not among the options leaves nothing selected. Other props go to the <select>.

import { useLayoutEffect, useRef } from "react";

const Option = ([optionValue, label, disabled]) => <option key={optionValue} value={optionValue} disabled={!!disabled}>{label}</option>;

export function Select({ options, value = "", ...props }) {
  const ref = useRef(null);
  useLayoutEffect(() => { ref.current.value = String(value); });
  return (
    <select {...props} ref={ref}>
      {options.map((entry) => (Array.isArray(entry) ? Option(entry)
        : <optgroup key={entry.group} label={entry.group}>{entry.options.map(Option)}</optgroup>))}
    </select>
  );
}

// A setting's few values, all shown side by side, the one chosen pressed (an Addition: Segmented
// choice): the segmented group as a radio group. options: [value, label, title, id]; onChange(value)
// when another is chosen. Its keys are a radio group's: only the one chosen takes Tab; the arrows
// choose the next (round), Home and End the first and last.
export function SegmentedChoice({ id, labelledBy, options, value, onChange }) {
  const choose = (next) => { if (next !== value) onChange(next); };
  const keydown = (e) => {
    const at = options.findIndex(([v]) => v === value);
    const to = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: options.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const [next, , , nextId] = options[(to + options.length) % options.length];
    choose(next);
    document.getElementById(nextId)?.focus();
  };
  return (
    <div className="segmented" id={id} role="radiogroup" aria-labelledby={labelledBy} onKeyDown={keydown}>
      {options.map(([v, label, title, optionId]) => (
        <button key={v} type="button" role="radio" id={optionId} aria-checked={v === value} tabIndex={v === value ? 0 : -1} title={title}
                onClick={() => choose(v)}>{label}</button>
      ))}
    </div>
  );
}
