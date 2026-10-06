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
