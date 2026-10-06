// Small marks beside a suite's or a test's name (spec/design/components.md, Additions: Group badge,
// Repeat badge, Spinner): its group (G2, in that group's colour, the same for the same number
// everywhere), how many times it runs (×3), and a turning circle for what's running.

// The group colours: eight, then round again (G9 as G1)
const tone = (group) => ((Math.max(1, Math.round(group)) - 1) % 8) + 1;

export function GroupBadge({ group, of = "test", id }) {
  if (group === undefined || group === null || group === "") return null;
  const title = `${of === "suite" ? "Suite" : "Test"} group ${group}: ${of === "suite" ? "suites" : "tests"} in the same group run one after another; different groups at the same time`;
  return <span className="group-badge" id={id} data-group={tone(Number(group))} title={title} aria-label={`group ${group}`}>{`G${group}`}</span>;
}

export function RepeatBadge({ times, id }) {
  if (!(times > 1)) return null;
  return <span className="repeat-badge" id={id} title={`Runs ${times} times`} aria-label={`runs ${times} times`}>{`×${times}`}</span>;
}

// A circle going round: running (in place of a turn's or a test's icon)
export const Spinner = ({ size = 14 }) => (
  <svg className="spinner" width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
    <circle cx="9" cy="9" r="6.5" strokeOpacity=".25" />
    <path d="M9 2.5a6.5 6.5 0 0 1 6.5 6.5" strokeLinecap="round" />
  </svg>
);
