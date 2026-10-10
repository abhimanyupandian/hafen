// The steps of a run on a time axis: a Gantt chart (spec/design/components.md, Additions: Timeline), in
// a dock built on the console's frame, above the console. Rows are the spans, grouped by turn and
// indented by depth; bars by status; a now line while running; zoom (25% to 200% of "fit") and Space
// and drag to pan, from the design system's zoom and pan.
//
//   <TimelineDock spans running selected onSelect={(span) => …} total />

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { KEYS } from "../lib/store.js";
import { useCollapsible } from "./collapsible.jsx";
import { openMenu } from "./context-menu.jsx";
import { createZoom, Zoom } from "./zoom.jsx";
import { makeResizable } from "./resizer.js";
import { panWithSpace } from "./pan.js";

const ROW = 24;
const AXIS = 24;
// Its height until it's dragged: a fifth of the window's, between 120px and 240px (the thread first)
const defaultHeight = () => Math.round(Math.min(240, Math.max(120, window.innerHeight / 5)));
const LABELS = 200;
const TICK_GAP = 64;  // the least room between two ticks, so their labels never overlap
const HIDDEN = new Set(["run", "suite", "first_byte"]);  // what every row would share, or too small to see

const fmt = (ms) => (ms === undefined ? "" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`);
// The tick step: the first that leaves TICK_GAP pixels between ticks at this many pixels per ms
const tickStep = (pxPerMs) => [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000, 300000].find((s) => s * pxPerMs >= TICK_GAP) ?? 600000;

// Spans as rows: depth-first under their parents, groups folded on request; `show` brings back kinds
// that are usually hidden (a suite's view shows its suite)
function rowsOf(spans, folded, show = []) {
  const byParent = new Map();
  const ids = new Set(spans.map((s) => s._id));
  for (const s of spans) {
    const parent = s.parent && ids.has(s.parent) ? s.parent : null;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(s);
  }
  const rows = [];
  const walk = (parent, depth) => {
    for (const s of (byParent.get(parent) ?? []).sort((a, b) => a.start - b.start)) {
      const hidden = HIDDEN.has(s.kind) && !show.includes(s.kind);
      if (!hidden) rows.push({ span: s, depth, group: (byParent.get(s._id) ?? []).length > 0 });
      if (!folded.has(s._id)) walk(s._id, hidden ? depth : depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

// A span and every span under it that has spans of its own: what "expand all" or "collapse all" on it
// opens or folds
function groupsUnder(spans, id) {
  const byParent = new Map();
  for (const s of spans) {
    if (!byParent.has(s.parent)) byParent.set(s.parent, []);
    byParent.get(s.parent).push(s._id);
  }
  const out = [];
  const walk = (at) => {
    const kids = byParent.get(at) ?? [];
    if (kids.length) out.push(at);
    for (const kid of kids) walk(kid);
  };
  walk(id);
  return out;
}

// Each span's place: its kind and what it is (a suite's file, a test's id, a check's place among its
// turn's, else its name), under its parent's, counted among its siblings alike ("…/turn:turn 1#0").
// The same step of another run of the same thing has the same place.
export function placesOf(spans) {
  const byParent = new Map();
  const ids = new Set(spans.map((s) => s._id));
  for (const s of spans) {
    const parent = s.parent && ids.has(s.parent) ? s.parent : null;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(s);
  }
  const out = new Map();
  const walk = (parent, at) => {
    const counts = new Map();
    for (const s of [...(byParent.get(parent) ?? [])].sort((a, b) => a.start - b.start)) {
      const what = s.kind === "suite" ? s.ref?.suite : s.kind === "test" ? s.ref?.test : s.kind === "check" ? `#${s.ref?.check}` : s.name;
      const own = `${s.kind}:${what ?? s.name}`;
      const n = counts.get(own) ?? 0;
      counts.set(own, n + 1);
      const place = `${at}/${own}#${n}`;
      out.set(s._id, place);
      walk(s._id, place);
    }
  };
  walk(null, "");
  return out;
}

// What's folded or open, by place: kept while the page is open (not saved), across runs and views, so a
// rerun shows what was open, as it was left. A place not set yet is as `collapse` says.
const remembered = new Map();   // place → folded

// show: kinds usually hidden to show (["suite"]); collapse: kinds whose rows start folded (["test"]),
// including ones that appear while a run goes on (unless opened, in this run or an earlier one).
// actions: more controls in its head (after fit)
export function TimelineDock({ spans = [], running = false, selected, onSelect, show = [], collapse = [], empty = "Run a test or send a message to see its steps here.", actions = null }) {
  const sectionRef = useRef(null);
  const handleRef = useRef(null);
  const chartRef = useRef(null);
  const labelsRef = useRef(null);
  const labelsHandle = useRef(null);
  const [open, toggle] = useCollapsible("timeline", true);
  const [version, setVersion] = useState(0);   // (drawn again as `remembered` changes)
  const [scale, setScale] = useState(1);
  const [now, setNow] = useState(0);
  const [width, setWidth] = useState(800);

  const end = useMemo(() => Math.max(1, ...spans.map((s) => s.end ?? s.start ?? 0), running ? now : 0), [spans, running, now]);
  const origin = useMemo(() => Math.min(...spans.map((s) => s.start ?? 0), end), [spans, end]);
  const places = useMemo(() => placesOf(spans), [spans]);
  const isFolded = (s) => {
    const place = places.get(s._id);
    return remembered.has(place) ? remembered.get(place) : collapse.includes(s.kind);
  };
  const folded = useMemo(() => new Set(spans.filter(isFolded).map((s) => s._id)), [spans, places, version, collapse.join()]);
  // Fold (or open) these spans: remembered by their places
  const setFold = (ids, fold) => {
    for (const id of ids) if (places.has(id)) remembered.set(places.get(id), fold);
    setVersion((v) => v + 1);
  };
  const rows = useMemo(() => rowsOf(spans, folded, show), [spans, folded, show.join()]);
  const zoom = useMemo(() => createZoom({ area: () => chartRef.current, apply: (next) => setScale(next) }), []);

  useLayoutEffect(() => {
    makeResizable(handleRef.current, {
      key: KEYS.timelineHeight, label: "timeline", initial: defaultHeight(), axis: "y", direction: -1,
      min: () => 80, max: () => Math.max(80, (sectionRef.current?.parentElement?.clientHeight ?? 600) - 120),
      apply: (px) => document.documentElement.style.setProperty("--timeline-h", `${px}px`),
    });
    makeResizable(labelsHandle.current, {
      key: KEYS.timelineLabels, label: "timeline labels", initial: LABELS, axis: "x",
      min: () => 120, max: () => 480,
      apply: (px) => document.documentElement.style.setProperty("--timeline-labels", `${px}px`),
    });
    panWithSpace(chartRef.current);
    const observer = new ResizeObserver(() => setWidth(chartRef.current?.clientWidth ?? 800));
    observer.observe(chartRef.current);
    return () => observer.disconnect();
  }, []);

  // While running, a now line moves on: from the run's own latest step (not where the last run's line
  // was left: each run's clock starts at 0)
  useLayoutEffect(() => {
    if (!running) return undefined;
    const latest = Math.max(0, ...spans.map((x) => x.end ?? x.start ?? 0));
    setNow(latest);
    const started = performance.now() - latest;
    const timer = setInterval(() => setNow(performance.now() - started), 100);
    return () => clearInterval(timer);
  }, [running]);

  // Keep the labels' scroll in step with the chart's
  const syncScroll = () => { if (labelsRef.current) labelsRef.current.style.top = `${-chartRef.current.scrollTop}px`; };

  const span = end - origin || 1;
  // Pixels per ms. "Fit" (100%) is the chart's width exactly, the last bar's duration label included
  // (the 80px past the end): nothing to scroll sideways
  const DURATION_ROOM = 80;
  const px = ((width - DURATION_ROOM) / span) * scale;
  const x = (ms) => (ms - origin) * px;
  // (At fit, x(end) is the width less the room, but for a hair of floating point over it, which
  // rounded up would be a pixel to scroll: the content's width rounds up only what's really more)
  const step = tickStep(px);
  const ticks = [];
  for (let t = 0; t <= span && ticks.length < 400; t += step) ticks.push(t);
  const total = spans.find((s) => s.kind === "run" || s.kind === "turn") ? fmt(end - origin) : "";

  return (
    <section className={`console collapsible timeline${open ? " open" : ""}${rows.length ? "" : " no-steps"}`} id="timeline" aria-labelledby="timelineLabel" ref={sectionRef}>
      <div className="console-resizer" id="timelineResizer" ref={handleRef}></div>
      <div className="console-head collapsible-head">
        <button className="collapsible-toggle" id="timelineToggle" type="button" aria-expanded={open} aria-controls="timelineBody" onClick={toggle}>
          <span className="chev" aria-hidden="true"></span><span className="label" id="timelineLabel">Timeline</span>
        </button>
        {rows.length > 0 && <span className="hint when-open" id="timelineTotal">{`${total}${total ? " · " : ""}${rows.length} steps`}</span>}
        {rows.length > 0 && <button className="btn btn-ghost when-open" id="timelineFit" type="button" onClick={() => zoom.set(1)}>fit</button>}
        {actions}
      </div>
      <div className={`timeline-body collapsible-body${rows.length ? "" : " no-steps"}`} id="timelineBody">
        <div className="timeline-labels" aria-hidden="true"
             onWheel={(e) => {
               // The labels move with the chart: the wheel over them scrolls it (up and down; ⌘/Ctrl zooms the chart)
               if (e.ctrlKey || e.metaKey || !chartRef.current) return;
               chartRef.current.scrollTop += e.deltaMode === 1 ? e.deltaY * ROW : e.deltaY;
             }}>
          <div className="timeline-labels-inner" ref={labelsRef} style={{ top: 0, height: `${AXIS + rows.length * ROW}px` }}>
            <div style={{ height: AXIS }}></div>
            {rows.map((r, i) => (
              <div key={r.span._id} className={`timeline-label${selected === r.span._id ? " selected" : ""}`} style={{ top: AXIS + i * ROW, paddingLeft: r.depth * 14 }}
                   onClick={() => onSelect?.(r.span)} title={r.span.name} data-span={r.span._id} data-kind={r.span.kind}
                   onContextMenu={r.group ? (e) => {
                     // Right-click on a row that has steps under it: open or fold it and all under it
                     const ids = groupsUnder(spans, r.span._id);
                     openMenu(e, {
                       label: `${r.span.name}: expand or collapse`,
                       items: [
                         { id: "expand-all", label: "Expand all", onPick: () => setFold(ids, false) },
                         { id: "collapse-all", label: "Collapse all", onPick: () => setFold(ids, true) },
                       ],
                     });
                   } : undefined}>
                {r.group
                  ? <button type="button" className="tree-toggle" tabIndex={-1} aria-expanded={String(!folded.has(r.span._id))}
                            onClick={(e) => { e.stopPropagation(); setFold([r.span._id], !folded.has(r.span._id)); }}>
                      <span className="chev" aria-hidden="true"></span>
                    </button>
                  : <span className="tree-toggle" aria-hidden="true"></span>}
                {["suite", "test", "repeat", "row", "turn"].includes(r.span.kind) ? <span className="label">{r.span.name}</span> : <span>{r.span.name}</span>}
              </div>
            ))}
          </div>
          <div className="timeline-labels-resizer" ref={labelsHandle} style={{ right: 0 }}></div>
        </div>
        <div className="timeline-chart" ref={chartRef} role="region" aria-label="Timeline. Hold Space and drag, or scroll, to move around; Ctrl or ⌘ and scroll to zoom" onScroll={syncScroll}>
          {!rows.length && <p className="note timeline-empty" id="timelineEmpty">{empty}</p>}
          {rows.length > 0 && (
            <div style={{ position: "relative", width: `${Math.max(width, Math.ceil(x(end) - 1e-6) + DURATION_ROOM)}px`, height: `${AXIS + rows.length * ROW}px` }}>
              <div className="timeline-axis" style={{ width: "100%" }}>
                {ticks.map((t) => <span key={t} style={{ left: x(origin + t) }}>{fmt(t)}</span>)}
              </div>
              {ticks.map((t) => <div key={`g${t}`} className="timeline-grid" style={{ left: x(origin + t) }}></div>)}
              {rows.map((r, i) => {
                const s = r.span;
                const left = x(s.start);
                const stop = s.end ?? (running ? Math.max(s.start, now) : s.start);
                const w = Math.max(2, (stop - s.start) * px);
                const metrics = s.metrics ?? {};
                const title = [`${s.kind} · ${s.name}`, `starts ${fmt(s.start - origin)}`, `takes ${fmt(stop - s.start)}`, s.status,
                  metrics.ttft_ms !== undefined && `first token ${fmt(metrics.ttft_ms)}`, metrics.confidence !== undefined && `confidence ${metrics.confidence}`,
                  metrics.tokens && `${metrics.tokens.input ?? 0} in · ${metrics.tokens.output ?? 0} out`].filter(Boolean).join("\n");
                return (
                  <div key={s._id} className={`timeline-row${selected === s._id ? " selected" : ""}`} style={{ top: AXIS + i * ROW }}>
                    <button type="button" className={`timeline-bar${selected === s._id ? " selected" : ""}`} id={`span-${s._id}`} data-kind={s.kind} data-status={s.status}
                            style={{ left, width: w }} title={title} aria-label={`${s.kind} ${s.name}, ${fmt(stop - s.start)}`} onClick={() => onSelect?.(s)}></button>
                    <span className="timeline-duration" style={{ left: left + w + 6 }}>{fmt(stop - s.start)}</span>
                  </div>
                );
              })}
              {running && <div className="timeline-now" style={{ left: x(Math.max(origin, now)) }}></div>}
            </div>
          )}
        </div>
        {rows.length > 0 && <Zoom zoom={zoom} id="timelineZoom" label="timeline" groupLabel="Timeline zoom" />}
      </div>
    </section>
  );
}
