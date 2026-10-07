// A terminal-style log panel. Lines are "cmd" (shown with $), "out", "log" (dim) or "err".
// A progress update in command output ("… 45%") replaces its previous line if that's among the
// last few; logged text (prompts, messages) is always kept as-is. The oldest lines go once there
// are LIMIT. It follows new lines while scrolled to the bottom, and opens at the bottom (lines
// written while it was closed included). Copy puts every line on the clipboard (commands with
// their $). Its top edge (.console-resizer) can be dragged to make it taller, up to the whole
// column (remembered). One per page: write() is what lib/log.js's say() writes with.
// (eval: it starts closed, so the thread has the room; open with nothing to show, it's only as tall
// as a note saying so: spec/design/components.md, Additions: Console when empty.)

import { useLayoutEffect, useRef, useState } from "react";
import { copyText } from "../lib/clipboard.js";
import { KEYS } from "../lib/store.js";
import { useCollapsible } from "./collapsible.jsx";
import { createDraw, useDraw } from "./hooks.js";
import { makeResizable } from "./resizer.js";

const HEIGHT = 200;     // the log's default height
const MIN_HEIGHT = 60;
const LIMIT = 3000;

let lines = [];          // [{key, kind, text}]
let nextKey = 0;
let open = true;         // the console is open (closed, it has no size)
let follow = false;      // scroll to the bottom once the new lines are drawn
let body = null;         // its .console-body
const lineDraw = createDraw();

// The tallest the log can be: the whole column, less the console's head and whatever else in the
// column doesn't shrink (a top bar, a message box, other docks).
function maxHeight(section) {
  const column = section.parentElement;
  const fixed = [...column.children].filter((el) => el !== section && getComputedStyle(el).flexGrow === "0")
    .reduce((sum, el) => sum + el.offsetHeight, 0);
  return Math.max(MIN_HEIGHT, column.clientHeight - fixed - section.querySelector(".console-head").offsetHeight - 1);
}

// "==> Downloading 45% (…)" -> "==> Downloading ": lines with the same stem are one progress bar.
const progressStem = (line) => line.match(/^(.*?)\d+(?:\.\d+)?%/)?.[1];

// tag: what the line is about (Console's `hide` leaves out the lines of those tags)
export function write(text, kind = "out", tag) {
  // Closed, it has no size: it's scrolled to the bottom when it opens.
  const atBottom = !open || !body || body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  for (let line of String(text).split("\n")) {
    line = line.trimEnd();
    if (!line) continue;
    if (kind === "cmd") line = "$ " + line.replace(/^[$+] /, "");
    const stem = kind === "out" ? progressStem(line) : undefined;
    const previous = stem === undefined ? null : lines.slice(-8).reverse()
      .find((l) => l.kind === kind && progressStem(l.text) === stem);
    if (previous) {
      previous.text = line;
      continue;
    }
    lines.push({ key: nextKey++, kind, text: line, ...(tag ? { tag } : {}) });
  }
  if (lines.length > LIMIT) lines = lines.slice(-LIMIT);
  if (atBottom) follow = true;
  lines = [...lines];
  lineDraw.draw();
}

// actions: more buttons in its head (before copy). hide: tags whose lines aren't shown (or copied).
export function Console({ actions = null, hide = [] }) {
  useDraw(lineDraw);
  const sectionRef = useRef(null);
  const bodyRef = useRef(null);
  const handleRef = useRef(null);
  const [copyLabel, setCopyLabel] = useState("copy");
  const toBottom = () => { bodyRef.current.scrollTop = bodyRef.current.scrollHeight; };
  const [isOpen, toggle] = useCollapsible("console", false, (now) => { if (now) toBottom(); });
  open = isOpen;
  useLayoutEffect(() => {
    body = bodyRef.current;
    makeResizable(handleRef.current, {
      key: KEYS.consoleHeight, label: "console", initial: HEIGHT, axis: "y", direction: -1,
      min: () => MIN_HEIGHT,
      max: () => maxHeight(sectionRef.current),
      apply: (px) => document.documentElement.style.setProperty("--console-h", `${px}px`),
    });
  }, []);
  useLayoutEffect(() => {
    if (!follow) return;
    follow = false;
    toBottom();
  });
  const shown = hide.length ? lines.filter((line) => !hide.includes(line.tag)) : lines;
  const copy = async () => {
    const text = shown.map((line) => line.text).join("\n");
    const copied = text && await copyText(text);
    setCopyLabel(!text ? "nothing to copy" : copied ? "copied" : "couldn't copy");
    setTimeout(() => setCopyLabel("copy"), 1500);
  };
  const clear = () => {
    lines = [];
    lineDraw.draw();
  };
  const empty = !shown.length;
  return (
    <section className={"console collapsible" + (isOpen ? " open" : "") + (empty ? " no-lines" : "")} id="console" aria-labelledby="consoleLabel" ref={sectionRef}>
      <div className="console-resizer" id="consoleResizer" ref={handleRef}></div>
      <div className="console-head collapsible-head">
        <button className="collapsible-toggle" id="consoleToggle" type="button" aria-expanded={isOpen} aria-controls="consoleBody" onClick={toggle}>
          <span className="chev" aria-hidden="true"></span><span className="label" id="consoleLabel">Console</span>
        </button>
        {actions}
        <button className="btn btn-ghost console-copy when-open" id="consoleCopy" type="button" onClick={copy}>{copyLabel}</button>
        <button className="btn btn-ghost console-clear when-open" id="consoleClear" type="button" onClick={clear}>clear</button>
      </div>
      <div className={"console-body collapsible-body" + (empty ? " no-lines" : "")} id="consoleBody" role="log" aria-label="Console output" tabIndex={0} ref={bodyRef}>
        {empty
          ? <p className="note console-empty" id="consoleEmpty">No lines yet: what the app does is logged here.</p>
          : shown.map((line) => <div key={line.key} className={line.kind} data-tag={line.tag}>{line.text}</div>)}
      </div>
    </section>
  );
}
