// The app in its desktop window (desktop/), rather than a browser tab. The window gives the page
// window.hafen (desktop/preload.cjs): its platform, and commands the main process runs (opening a
// folder, secrets, the system's notifications, the window's theme). The engine itself runs in the
// desktop app's utility process, reached through a port (host.js). In a browser, isApp is false.

export const isApp = typeof window !== "undefined" && !!window.hafen;

// A command of the desktop app's (desktop/main.js COMMANDS)
export const invoke = (command, args) => window.hafen.invoke(command, args);
