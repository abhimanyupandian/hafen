// Settings (from hafen's design system: spec/design/components.md, Settings): a modal with the logo
// and the options down the left, grouped under their headings, a divider, and the chosen option on the
// right. The options are panes the app gives (initSettings): each is a list of what's kept (items(),
// remove(item), clear()) or a Body component. <SettingsModal /> draws it while it's open.

import { Fragment, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { formatSize } from "../lib/format.js";
import { on } from "../lib/events.js";
import { say } from "../lib/log.js";
import { ConfirmButton } from "./confirm.jsx";
import { Logo } from "./logo.jsx";
import { createStore, useStore } from "./hooks.js";
import { CloseButton, Modal } from "./modal.jsx";

let options = [];
let chosen = null;  // the pane shown (remembered while the page is open)

// open: the modal is up. pane: the pane chosen; shown: the pane whose items are drawn, with its
// items (drawn afresh each time, `version`). error: why a deletion couldn't happen. usage: the
// storage used (from the app, as initSettings gives it: {value, title}), as it's shown.
const view = createStore({ open: false, pane: null, shown: null, items: [], version: 0, error: "", usage: null });

let usageOf = null;  // () => {value, title}: the storage used ("2.7 MB"), from the app (optional)
async function showUsage() {
  const used = usageOf ? await usageOf() : null;
  if (view.get().open) view.set({ usage: used });
}
const total = (items) => formatSize(items.reduce((sum, item) => sum + (item.size || 0), 0));

// Delete, then show the pane again. A deletion that can't happen says why.
async function act(pane, work) {
  try {
    await work();
  } catch (err) {
    say(err.message || String(err), "err");
    view.set({ error: err.message || String(err) });
    return;
  }
  await show(pane.id);
}

async function show(id) {
  const pane = options.find((p) => p.id === id) ?? options[0];
  chosen = pane.id;
  view.set({ pane: pane.id });
  const items = pane.items ? await pane.items() : [];
  if (!view.get().open) return;
  view.set(({ version }) => ({ shown: pane.id, items, version: version + 1, error: "" }));
  showUsage();
}

// Open Settings on the option last chosen, or on `paneId` (e.g. "secrets"). (As a click handler it's
// given the event, which isn't a pane.)
export function openSettings(paneId) {
  if (view.get().open) return;
  flushSync(() => view.set({ open: true, pane: null, shown: null, items: [], error: "", usage: null }));
  show(typeof paneId === "string" ? paneId : chosen ?? options[0].id).then(() => document.getElementById(`settings-tab-${chosen}`)?.focus());
}

// Close Settings from inside a pane (as its × does: focus goes back where it was)
export const closeSettings = () => document.getElementById("settingsModal")?.close();

function Row({ pane, item }) {
  const key = item._id ?? item.name;
  return (
    <li className="settings-row" id={`settings-${pane.id}-${key}`}>
      <div className="settings-row-text">
        <span className="settings-row-name">{item.name}</span>
        <span className="hint">{[item.detail, item._id && `_id ${item._id}`].filter(Boolean).join(" · ")}</span>
      </div>
      <span className="list-size">{formatSize(item.size || 0)}</span>
      <ConfirmButton className="btn btn-ghost list-del" id={`settings-${pane.id}-${key}-delete`} aria-label={`Delete ${item.name}`}
                     label="×" question="delete" onConfirm={() => act(pane, () => pane.remove(item))} />
    </li>
  );
}

// A pane: its list (drawn afresh each time it's read, `version`), and its Body, which stays as it is
// while the list is read again.
function Content({ pane, items, error, version }) {
  useEffect(() => pane.redrawOn && on(pane.redrawOn, () => { if (view.get().open && view.get().shown === pane.id) show(pane.id); }), [pane]);
  if (!pane.items) {
    return (
      <>
        <div className="settings-content-head"><h2 className="settings-title" id="settingsTitle">{pane.title}</h2></div>
        {pane.description && <p className="note">{pane.description}</p>}
        <pane.Body />
      </>
    );
  }
  return (
    <>
      <div className="settings-content-head" key={`head-${version}`}>
        <h2 className="settings-title" id="settingsTitle">{pane.title}</h2>
        <span className="hint" id="settingsTotal">{`${items.length} · ${total(items)}`}</span>
        <ConfirmButton className="btn btn-ghost" id={`settings-${pane.id}-clear`} disabled={!items.length}
                       label="clear all" question={pane.clearQuestion} onConfirm={() => act(pane, () => pane.clear())} />
      </div>
      <p className="note">{pane.description}</p>
      <Fragment key={version}>
        <p className="hint error" id="settingsError" role="alert" hidden={!error}>{error}</p>
        {items.length
          ? <ul className="list settings-list" id={`settings-${pane.id}-list`} aria-label={pane.title}>
              {items.map((item) => <Row key={item._id ?? item.name} pane={pane} item={item} />)}
            </ul>
          : <p className="note placeholder" id="settingsEmpty">Nothing here.</p>}
      </Fragment>
      {pane.Body && <pane.Body />}
    </>
  );
}

export function SettingsModal() {
  const { open, pane, shown, items, version, error, usage } = useStore(view);
  const dialogRef = useRef(null);
  // What's stored changes outside a pane's list too
  useEffect(() => (open ? on("runs:changed", showUsage) : undefined), [open]);
  if (!open) return null;
  const showing = options.find((p) => p.id === shown);
  // Up and down move between the options, as in a list of tabs
  const keydown = (e) => {
    const at = options.findIndex((p) => p.id === chosen);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: options.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const to = options[(next + options.length) % options.length];
    flushSync(() => show(to.id));
    document.getElementById(`settings-tab-${to.id}`).focus();
  };
  return (
    <Modal id="settingsModal" label="Settings" className="settings" dialogRef={dialogRef} onClose={() => view.set({ open: false })}>
      <div className="settings-layout">
        <aside className="settings-nav">
          <div className="settings-brand">
            <Logo />
            <span className="label">Settings</span>
          </div>
          {[...new Set(options.map((p) => p.group))].map((group) => (
            <Fragment key={group}>
              <p className="hint settings-group">{group}</p>
              <div className="settings-tabs" role="tablist" aria-orientation="vertical" aria-label={group} onKeyDown={keydown}>
                {options.filter((p) => p.group === group).map((p) => (
                  <button key={p.id} type="button" className="settings-tab" id={`settings-tab-${p.id}`} role="tab" aria-controls="settingsContent"
                          aria-selected={pane === null ? undefined : String(p.id === pane)} tabIndex={pane === null ? undefined : p.id === pane ? 0 : -1}
                          onClick={() => show(p.id)}>{p.label}</button>
                ))}
              </div>
            </Fragment>
          ))}
          <div className="hint settings-usage" id="settingsUsage" title={usage?.title}>
            {usage?.value && <><span>Storage used</span><span className="settings-usage-value" id="settingsUsageValue">{usage.value}</span></>}
          </div>
        </aside>
        <section className="settings-content" id="settingsContent" role="tabpanel" aria-labelledby={pane && `settings-tab-${pane}`}>
          {showing && <Content key={showing.id} pane={showing} items={items} error={error} version={version} />}
        </section>
      </div>
      <div className="settings-close"><CloseButton dialogRef={dialogRef} id="settingsClose" /></div>
    </Modal>
  );
}

// The app's panes, and how to tell the storage used
export function initSettings({ panes, usage }) {
  options = panes;
  usageOf = usage ?? null;
}
