// Small DOM helpers.

export const $ = (id) => document.getElementById(id);

// Grow a textarea to fit its text, up to its CSS max-height. A hidden one (in a collapsed
// section) has nothing to measure, so it keeps its size.
export function autoGrow(textarea) {
  if (!textarea.getClientRects().length) return;
  textarea.style.height = "auto";
  textarea.style.height = textarea.scrollHeight + 2 + "px";
}

// The progress cursor while `work` (a promise) runs: <html class="busy">. Overlapping work keeps it
// until all of it is done.
let busyCount = 0;
export async function whileBusy(work) {
  busyCount += 1;
  document.documentElement.classList.add("busy");
  try {
    return await work;
  } finally {
    busyCount -= 1;
    if (!busyCount) document.documentElement.classList.remove("busy");
  }
}

// The page has drawn everything: drop the loader (<html class="loading">), once it has been up
// for at least a second since the page started loading, so every load and refresh shows it the
// same way. Until then the page is hidden, and nothing in it can take focus: wait for pageShown.
const LOADER_MS = 1000;
let shown;
export const pageShown = new Promise((resolve) => { shown = resolve; });
export const pageReady = () => {
  setTimeout(() => {
    document.documentElement.classList.remove("loading");
    shown();
  }, Math.max(0, LOADER_MS - performance.now()));
};

// Close the sidebar drawer (small screens).
export const closeDrawer = () => document.body.classList.remove("nav-open");
export const openDrawer = () => document.body.classList.add("nav-open");
