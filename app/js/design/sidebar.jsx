// The sidebar's frame (from hafen's design system). On wide screens it collapses to a narrow rail that
// keeps the logo, Settings and the button to expand it again (remembered), and its right edge
// can be dragged to resize it, up to half the window (remembered too). On small screens it's a
// drawer instead: #menu opens it, and #scrim behind it closes it.

import { useLayoutEffect, useRef } from "react";
import { closeDrawer, openDrawer } from "../lib/dom.js";
import { KEYS, store } from "../lib/store.js";
import { openSettings } from "./settings-modal.jsx";
import { createStore, useStore } from "./hooks.js";
import { Icon } from "./icons.jsx";
import { Logo } from "./logo.jsx";
import { makeResizable } from "./resizer.js";

const narrow = matchMedia("(max-width: 860px)");
const WIDTH = 300;     // default
const MIN_WIDTH = 240;

const sidebar = createStore({ collapsed: false });

function setCollapsed(collapsed) {
  document.body.classList.toggle("nav-collapsed", collapsed);
  if (collapsed) store.set(KEYS.navCollapsed, "1");
  else store.remove(KEYS.navCollapsed);
  sidebar.set({ collapsed });
}

export const initSidebar = () => setCollapsed(store.get(KEYS.navCollapsed) === "1");
// Expand the rail (the collapsed sidebar's icons open it on their section)
export const expandSidebar = () => setCollapsed(false);
const openMenu = () => (narrow.matches ? openDrawer() : setCollapsed(false));

// The logo at the left; the page's controls at the right (spec/design/components.md, Sidebar parts)
export function NavHead({ children }) {
  return (
    <div className="nav-head">
      <span className="brand" id="brand" title="Hafen"><Logo /></span>
      <div className="nav-actions">{children}</div>
    </div>
  );
}

export function NavFoot() {
  const { collapsed } = useStore(sidebar);
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <div className="nav-foot">
      <button id="openSettings" className="btn btn-ghost btn-icon" type="button" aria-label="Settings" title="Settings" aria-haspopup="dialog" onClick={openSettings}>
        <Icon name="settings" />
      </button>
      <button id="collapseNav" className="btn btn-ghost btn-icon" type="button" aria-label={label} title={label} aria-controls="navBody" aria-expanded={String(!collapsed)}
              onClick={() => (narrow.matches ? closeDrawer() : setCollapsed(!collapsed))}>
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="2.5" y="3.5" width="13" height="11" /><path d="M7 3.5v11" /></svg>
      </button>
    </div>
  );
}

export function NavResizer() {
  const ref = useRef(null);
  useLayoutEffect(() => {
    makeResizable(ref.current, {
      key: KEYS.navWidth, label: "sidebar", initial: WIDTH, axis: "x",
      min: () => MIN_WIDTH,
      max: () => Math.max(MIN_WIDTH, innerWidth / 2),
      apply: (px) => document.documentElement.style.setProperty("--nav-w", `${px}px`),
    });
  }, []);
  return <div className="nav-resizer" id="navResizer" ref={ref}></div>;
}

export const Scrim = () => <div className="scrim" id="scrim" onClick={closeDrawer}></div>;

// The button that opens the sidebar (the drawer, or the rail expanded), in the top bar.
export const MenuButton = ({ className }) => (
  <button id="menu" className={className} type="button" aria-label="Open sidebar" aria-controls="nav" onClick={openMenu}>
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2 5h14M2 13h14" /></svg>
  </button>
);
