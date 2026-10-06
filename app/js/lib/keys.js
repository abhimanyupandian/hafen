// The keyboard shortcut that runs what's selected: ⌘↵ on macOS, Ctrl+Enter on Windows and Linux (either
// works everywhere, as the large editor's save does)

export const isMac = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? "");
export const RUN_KEY = isMac ? "⌘↵" : "Ctrl+Enter";
export const isRunKey = (e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.isComposing;
