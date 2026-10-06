// The app's address says what's open, so a link opens it again: ?tab=<tab>&_id=<_id>.
//
//   ?tab=suites&_id=<test id>      a test
//   ?tab=runs&_id=<run _id>        a run
//   ?tab=providers&_id=<file>      a provider
//
// Opening something adds it to the browser's history, so Back returns to what was open before.

export function readRoute() {
  const params = new URLSearchParams(location.search);
  return { tab: params.get("tab"), _id: params.get("_id") };
}

export function setRoute(tab, _id, { replace = false } = {}) {
  const url = new URL(location.href);
  url.search = tab ? new URLSearchParams(_id ? { tab, _id } : { tab }).toString() : "";
  if (url.href === location.href) return;
  history[replace ? "replaceState" : "pushState"](null, "", url);
}

export const onRouteChange = (handler) => window.addEventListener("popstate", () => handler(readRoute()));
