// When a run ends (Settings → Notifications; contracts/ui.md, Notifications): its toast, and as the
// settings say, a sound and the system's notification; either clicked opens what ran. What's set:
//
//   sound    a sound when a run ends (on)
//   when     "away": only when you aren't looking at what ran (another suite or test open, or the window
//            in the background); "always": every time (away)
//   passed   for runs that passed (an unsure pass too) (on)
//   failed   for runs that failed, or couldn't run (on)
//   system   the system's notification too, while the window isn't in front (on in the desktop app;
//            in a browser, off until turned on, which asks the browser's permission)
//
// A run that was stopped makes no sound and no system notification.

import { invoke, isApp } from "./app.js";
import { chime } from "./sound.js";
import { KEYS, store } from "./store.js";

const DEFAULTS = { sound: true, when: "away", passed: true, failed: true, system: isApp };
const listeners = new Set();

export const notifySettings = () => ({ ...DEFAULTS, ...store.getJSON(KEYS.notifications, {}) });
export function setNotifySettings(changes) {
  const next = { ...notifySettings(), ...changes };
  store.setJSON(KEYS.notifications, next);
  for (const fn of listeners) fn(next);
  return next;
}
export const onNotifySettings = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

// Whether the window is in front and seen
export const inFront = () => document.visibilityState === "visible" && document.hasFocus();

// The browser's permission for system notifications: "granted", "denied", "default", or "unsupported"
export const systemPermission = () => (isApp ? "granted" : typeof Notification === "undefined" ? "unsupported" : Notification.permission);
export async function askSystemPermission() {
  if (isApp || typeof Notification === "undefined") return systemPermission();
  try {
    return await Notification.requestPermission();
  } catch {
    return systemPermission();
  }
}

// What a click on a system notification does, by its tag (the desktop app's come back by tag)
const clicks = new Map();
let tags = 0;
if (isApp) window.hafen?.onNotificationClick?.((tag) => {
  window.focus();
  clicks.get(tag)?.();
  clicks.delete(tag);
});

// The system's notification (when allowed), silent (the sound is the page's); a click brings the
// window forward and does `onClick`
export function systemNotify({ title, text = "", onClick }) {
  const tag = `hafen-${++tags}`;
  if (onClick) {
    clicks.set(tag, onClick);
    // (forgotten after a while: one not clicked)
    setTimeout(() => clicks.delete(tag), 10 * 60 * 1000);
  }
  if (isApp) return invoke("notify_system", { title, body: text, tag }).catch(() => {});
  if (systemPermission() !== "granted") return undefined;
  try {
    const n = new Notification(title, { body: text, tag, silent: true });
    n.onclick = () => {
      window.focus();
      clicks.get(tag)?.();
      clicks.delete(tag);
      n.close();
    };
  } catch {}
  return undefined;
}

// A run ended: what to do besides its toast. outcome: "passed" | "failed" | "stopped"; viewing:
// whether what ran is what's open (and the window in front). → { sound: "done" | "failed" | null, system }
export function runEndActions(outcome, viewing, settings = notifySettings()) {
  if (outcome === "stopped" || !settings[outcome]) return { sound: null, system: false };
  const sound = settings.sound && (settings.when === "always" || !viewing) ? (outcome === "failed" ? "failed" : "done") : null;
  return { sound, system: !!settings.system && !inFront() };
}

// A sample, from Settings: the sound for a pass, and the system's notification if it's on
export function tryNotification() {
  const settings = notifySettings();
  if (settings.sound) chime("done");
  if (settings.system) systemNotify({ title: "Passed: a sample run", text: "This is how a run that ends tells you." });
}
