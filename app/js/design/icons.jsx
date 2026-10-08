// Line icons, 18×18, drawn with currentColor: <Icon name="test" />. Icons are decorative
// (aria-hidden): the button or text next to one names what it is.

const PATHS = {
  // A suite file: a box with a tab line over it
  suite: '<rect x="2.5" y="5.5" width="13" height="10"/><path d="M4.5 3h9"/>',
  // A test: a box with a tick
  test: '<rect x="2.5" y="2.5" width="13" height="13"/><path d="M5.5 9l2.5 2.5 4.5-5"/>',
  // A check: a tick
  check: '<path d="M3.5 9.5l3.5 3.5 7.5-8"/>',
  // A check that failed: a cross, the tick's size (smaller than close's ×)
  fail: '<path d="M5 5l8 8M13 5l-8 8"/>',
  // A provider (an endpoint): a plug
  provider: '<path d="M6.5 2.5v4M11.5 2.5v4M4.5 6.5h9v2.5a4.5 4.5 0 0 1-9 0zM9 13.5v2.5"/>',
  // The timeline: bars at different starts
  timeline: '<path d="M2.5 4.5h7M5.5 9h8M8.5 13.5h7"/>',
  // A run: play
  run: '<path d="M5.5 3.5l9 5.5-9 5.5z"/>',
  // Back: to what holds this
  back: '<path d="M11 4.5L6.5 9l4.5 4.5"/>',
  // A conversation
  chat: '<path d="M3 4.5h12v8H8.5L5.5 15v-2.5H3z"/>',
  // Runs: their history (a clock turning back)
  runs: '<path d="M3.6 10.5A5.6 5.6 0 1 0 4.4 5.6"/><path d="M3.8 2.8v3.1h3.1"/><path d="M9 6v3.3l2.3 1.4"/>',
  // Stopping a run
  stop: '<rect x="4.5" y="4.5" width="9" height="9"/>',
  plus: '<path d="M9 3.5v11M3.5 9h11"/>',
  minus: '<path d="M3.5 9h11"/>',
  copy: '<rect x="6.5" y="6.5" width="8.5" height="8.5"/><path d="M11.5 6.5V3h-8.5v8.5h3.5"/>',
  maximize: '<path d="M10.5 3h4.5v4.5M7.5 15H3v-4.5M15 3l-5.5 5.5M3 15l5.5-5.5"/>',
  // Settings: a gear
  settings: '<path d="M7.54 3.91L7.87 1.89H10.13L10.46 3.91L11.57 4.36L13.23 3.18L14.82 4.77L13.64 6.43L14.09 7.54L16.11 7.87V10.13L14.09 10.46L13.64 11.57L14.82 13.23L13.23 14.82L11.57 13.64L10.46 14.09L10.13 16.11H7.87L7.54 14.09L6.43 13.64L4.77 14.82L3.18 13.23L4.36 11.57L3.91 10.46L1.89 10.13V7.87L3.91 7.54L4.36 6.43L3.18 4.77L4.77 3.18L6.43 4.36Z" stroke-linejoin="round"/><circle cx="9" cy="9" r="2.25"/>',
  // A scope (stage, prod…): stacked layers, one of them chosen
  scope: '<path d="M9 2.5l6.5 3.25L9 9 2.5 5.75z" stroke-linejoin="round"/><path d="M2.5 9.25L9 12.5l6.5-3.25M2.5 12.5L9 15.75l6.5-3.25" stroke-linejoin="round"/>',
  sidebar: '<rect x="2.5" y="3.5" width="13" height="11"/><path d="M7 3.5v11"/>',
  menu: '<path d="M2 5h14M2 13h14"/>',
  close: '<path d="M4.5 4.5l9 9M13.5 4.5l-9 9"/>',
  // Search: a magnifier
  search: '<circle cx="7.75" cy="7.75" r="4.75"/><path d="M11.25 11.25l4.25 4.25"/>',
  // More actions (a row's menu): three dots
  more: '<circle cx="4" cy="9" r=".9"/><circle cx="9" cy="9" r=".9"/><circle cx="14" cy="9" r=".9"/>',
  // Notifications: a bell
  bell: '<path d="M4.5 13V8.5a4.5 4.5 0 0 1 9 0V13l1.5 1.5H3z" stroke-linejoin="round"/><path d="M7.5 16h3"/>',
};

export function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"
         className={`icon icon-${name}`} dangerouslySetInnerHTML={{ __html: PATHS[name] }} />
  );
}
