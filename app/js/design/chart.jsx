// A small trend line (spec/design/components.md, Additions: Small charts): SVG, 308×64, a baseline and
// a top line, the series in the text colour, a failed point in the danger colour, the latest value at
// the right. No fills, gridlines or legend: the field label says what it is.
//
//   <Chart id label points={[{ value, failed }]} format={(v) => …} />

const W = 308;
const H = 64;
const PAD = { top: 6, bottom: 14, left: 2, right: 48 };

export function Chart({ id, label, points, format = (v) => String(v) }) {
  const values = points.map((p) => p.value).filter((v) => Number.isFinite(v));
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i) => PAD.left + (i / (points.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v) => PAD.top + (1 - (v - min) / span) * (H - PAD.top - PAD.bottom);
  // (A point with no value, a run with no cost or no turns, is left out: the line starts at the first
  // that has one, and the latest is the last that has one)
  const drawn = points.map((p, i) => ({ ...p, i })).filter((p) => Number.isFinite(p.value));
  const path = drawn.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
  const last = drawn.at(-1);
  return (
    <>
      <div className="chart-label"><span className="hint">{label}</span></div>
      <svg className="chart" id={id} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: latest ${format(last.value)}, from ${format(min)} to ${format(max)}`}>
        <line className="chart-edge" x1={PAD.left} x2={W - PAD.right} y1={PAD.top} y2={PAD.top} />
        <line className="chart-edge" x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} />
        <path className="chart-line" d={path} />
        {points.map((p, i) => Number.isFinite(p.value) && <circle key={i} className={`chart-point${p.failed ? " failed" : ""}`} cx={x(i)} cy={y(p.value)} r="1.5" />)}
        <text className="latest" x={W - PAD.right + 6} y={y(last.value) + 4}>{format(last.value)}</text>
        <text x={PAD.left} y={H - 2}>{format(min)}</text>
        <text x={W - PAD.right} y={H - 2} textAnchor="end">{format(max)}</text>
      </svg>
    </>
  );
}
