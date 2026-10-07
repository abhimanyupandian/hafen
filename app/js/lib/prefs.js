// Preferences, from Settings → App: the theme. Kept in localStorage; other tabs and windows follow
// ("storage" events), and "prefs:changed" says when it changes. Its colours are tokens.css's, for
// <html data-theme="light|dark">, which the inline script in index.html and build.html sets before
// the page draws (from the same key), and this module again when it changes ("theme:changed" when
// what's applied does: the system's can change by itself). The logo follows it (components/logo.jsx).

import { invoke, isApp } from "./app.js";
import { emit } from "./events.js";
import { KEYS, store } from "./store.js";

export const THEMES = [["light", "Light"], ["dark", "Dark"], ["system", "As the system's"]];
// (Not chosen yet: the system's, so a first visit with the system dark is dark)
export const theme = () => store.get(KEYS.theme) ?? "system";

// What's applied: "light" or "dark"; and the logo for it (a black tile on light, a white one on dark)
const applied = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
const LOGOS = { light: "icons/hafen-h-black.svg", dark: "icons/hafen-h.svg" };
export const logo = () => LOGOS[applied()];

// The desktop app's window (its background, its own buttons) in the page's theme (electron/main.js)
const tellApp = () => isApp && invoke("set_theme", { applied: applied(), choice: theme() }).catch(() => {});

const systemDark = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const chosen = theme();
  const next = chosen === "dark" || (chosen === "system" && systemDark.matches) ? "dark" : "light";
  if (document.documentElement.dataset.theme === next) return;
  document.documentElement.dataset.theme = next;
  emit("theme:changed", next);
  tellApp();
}

export function setTheme(value) {
  store.set(KEYS.theme, value);
  applyTheme();
  tellApp();  // (the choice, even when what's shown stays the same: "system" follows the system's)
  emit("prefs:changed");
}

systemDark.addEventListener("change", applyTheme);
tellApp();
window.addEventListener("storage", (e) => {
  if (![KEYS.theme, null].includes(e.key)) return;
  applyTheme();
  emit("prefs:changed");
});
applyTheme();
