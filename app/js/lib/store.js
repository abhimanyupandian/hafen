// localStorage that fails quietly (private windows, blocked storage), and the keys the app uses.
// (From hafen's design system: spec/design/patterns.md, Remembered state.)

export const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
  keys() { try { return Object.keys(localStorage); } catch { return []; } },
  getJSON(key, fallback) { try { return JSON.parse(this.get(key)) ?? fallback; } catch { return fallback; } },
  setJSON(key, value) { this.set(key, JSON.stringify(value)); },
};

export const KEYS = {
  section: (id) => `eval.section.${id}`,
  navCollapsed: "eval.navCollapsed",       // the sidebar is collapsed (wide screens)
  navWidth: "eval.navWidth",               // the sidebar's width, when resized (px)
  consoleHeight: "eval.consoleHeight",     // the console's height, when resized (px)
  timelineHeight: "eval.timelineHeight",   // the timeline dock's height (px)
  timelineLabels: "eval.timelineLabels",   // the timeline's label column width (px)
  theme: "eval.theme",                     // Settings → Appearance: "light", "dark" or "system" (the default)
  env: "eval.env",                         // the scope chosen last ("": none, chosen so; unset: never chosen)
  scopes: "eval.scopes",                   // the app's scopes, by name, in the order they were made
  scope: (name) => `eval.scope.${name}`,   // a scope's environment values: {NAME: text} (one key a scope)
  root: "eval.root",                       // the folder opened last (desktop app)
  relay: "eval.relay",                     // the relay's address (browser build)
  secrets: "eval.secrets",                 // secret values by scope, "" for every scope (browser build only; the desktop app keeps them encrypted)
  provider: "eval.provider",               // the provider chosen for exploring
  notifications: "eval.notifications",     // Settings → Notifications: { sound, when, passed, failed, system }
  collapsed: "eval.collapsed",             // tree rows folded: {row id: true}
  fixtures: "eval.fixtures",               // the timeline's and the console's fixtures: "hidden" when hidden
};
