// Before the page's scripts: what the page can ask the desktop app for (main.js COMMANDS), its
// platform (for the window's look), and the port to the engine, forwarded with window.postMessage (a
// MessagePort can't pass through contextBridge). CommonJS: a sandboxed page's preload can't be a module.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hafen", {
  platform: process.platform,
  async invoke(command, args) {
    const reply = await ipcRenderer.invoke("hafen", command, args);
    if (reply.error) throw new Error(reply.error);
    return reply.value;
  },
  // A system notification clicked: its tag (lib/notifications.js opens what it was about)
  onNotificationClick(handler) {
    ipcRenderer.on("hafen:notification", (_event, tag) => handler(String(tag)));
  },
});

ipcRenderer.on("hafen:port", (event) => window.postMessage("hafen:port", "*", event.ports));
