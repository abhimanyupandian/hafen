// Searching the sidebar's lists (Suites, Conversations) by name and by date, as text: every word typed
// must be found somewhere in what a row is (its names, and its dates written the ways people write
// them: 2026-10-06, Oct 6, 6 October 2026, Tuesday, 14:02, today, 2 mins ago…), in any case.

import { ago } from "./format.js";

const pad = (n) => String(n).padStart(2, "0");

// A time, as the ways it might be searched for
export function dateTexts(ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return [];
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const long = d.toLocaleString("en", { month: "long" });
  const short = d.toLocaleString("en", { month: "short" });
  const weekday = d.toLocaleString("en", { weekday: "long" });
  const today = new Date(now);
  const daysAgo = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(y, m - 1, day)) / 86400000);
  return [
    `${y}-${pad(m)}-${pad(day)} ${hm}`, `${y}/${pad(m)}/${pad(day)}`, `${pad(day)}/${pad(m)}/${y}`, `${pad(m)}/${pad(day)}/${y}`,
    `${day}/${m}/${y}`, `${m}/${day}/${y}`, `${day}.${m}.${y}`,
    `${short} ${day}, ${y}`, `${long} ${day}, ${y}`, `${day} ${short} ${y}`, `${day} ${long} ${y}`, weekday, hm,
    d.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }),
    daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : "", ago(ms, now),
  ].filter(Boolean);
}

// The words of a search, lower case ("" or only spaces: none, everything matches)
export const searchWords = (query) => String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);

// Whether every word is found in what's given (texts, and times as dateTexts)
export function matches(words, { texts = [], times = [] } = {}, now = Date.now()) {
  if (!words.length) return true;
  const hay = [...texts, ...times.flatMap((t) => dateTexts(t, now))].filter((x) => x !== undefined && x !== null).join(" \u0001 ").toLowerCase();
  return words.every((w) => hay.includes(w));
}
