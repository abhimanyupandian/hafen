// An app-wide event bus, so views react to each other without importing each other.
//
//   suites:changed   suites or providers were read again, or one was edited
//   runs:changed     a run was saved or deleted
//   run:changed      a run started, went on, or ended (the live one)
//   select:changed   what's selected changed (a test, turn, check, step, run or provider)
//   prefs:changed    a preference changed (the theme)
//   theme:changed    the applied theme changed
//   thread:bottom    a message was sent (or a turn added): the thread goes to its bottom

const bus = new EventTarget();

export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
// on() returns a function that stops listening.
export function on(name, handler) {
  const listener = (event) => handler(event.detail);
  bus.addEventListener(name, listener);
  return () => bus.removeEventListener(name, listener);
}
