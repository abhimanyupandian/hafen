// Numbers and times as the design system writes them (spec/design/patterns.md, Numbers).

export const formatSize = (bytes) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.ceil(bytes / 1e3)} KB`;

// 1.2 s (and 0.62 s under a second, where a decimal matters; 1 min 12 s from a minute: rounded first,
// so 59.96 s is "1 min 0 s", never "60.0 s" or "1 min 60 s")
export const sec = (ms) => {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 59950) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
};

export const money = (usd) => (usd === undefined || usd === null ? "—" : `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`);

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// How long ago, in words: "just now", "1 min ago", "2 mins ago", "3 hours ago", "2 days ago", "3 weeks
// ago"; from 60 days, the date (now: the time to count from, for a view that ticks)
export function ago(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  const n = (count, unit) => `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  if (s < 45) return "just now";
  if (s < 3600) return n(Math.max(1, Math.round(s / 60)), "min");
  if (s < 86400) return n(Math.round(s / 3600), "hour");
  if (s < 14 * 86400) return n(Math.round(s / 86400), "day");
  if (s < 60 * 86400) return n(Math.round(s / (7 * 86400)), "week");
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

// A date with its year, and the time (24-hour): "Oct 6, 2026, 14:02" (a conversation's, in its list)
export const whenFull = (ms) => new Date(ms).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

// Today's as the time; earlier days as date and time (24-hour)
export function when(ms) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour12: false }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export const tokens = (t) => (t ? [t.input !== undefined && `${t.input} in`, t.output !== undefined && `${t.output} out`, t.thinking ? `${t.thinking} thinking` : null].filter(Boolean).join(" · ") : "");

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Reply text as HTML: escaped, with **bold** kept (as the design system's messages show it)
export const formatText = (s) => escapeHtml((s ?? "").trimStart()).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
