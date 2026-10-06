// Hafen as a desktop app (Electron; research §4–5). The window shows the app (app/dist), with no
// title bar: its top bars are the window's, as the design system says. The engine runs in a utility
// process (engine-host.js): Node, as in CI, so the app and CI run the same way, with no CORS, real
// concurrency, and secrets kept out of the page. The page and the engine talk over a MessageChannel
// port; the main process owns the window, folders (the dialog) and secrets (encrypted with the
// system's keychain through safeStorage), and hands the engine the secrets it needs.
//
// Commands the page can ask for (window.hafen.invoke, preload.cjs):
//   engine_port     (re)connect the page to the engine
//   open_folder     choose a folder: its path, or null
//   secrets_scopes  → the scopes that have secrets ("" for every scope)
//   secrets_list    {env} → which secret names have values (never the values)
//   secrets_set     {env, name, value} → keep a value ("" forgets it)
//   notify_system   {title, body, tag} → the system's notification, when the window isn't in front;
//                   clicked, the window comes forward and the page is told its tag (hafen:notification)
//   set_theme       {applied} → the window's background and native parts follow the page

import { app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, nativeTheme, Notification, safeStorage, utilityProcess } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { carryOver, LEGACY_FOLDER } from "./carry-over.js";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = join(here, "../app/dist/index.html");
const BACKGROUND = { light: "#ffffff", dark: "#0a0a0a" };
// The app's icon (desktop/icons, made from source.svg). A package has it already (electron-builder
// puts it in); run with npm run app, the app is Electron's own, so the Dock would show Electron's.
const ICON = join(here, "icons", "icon.png");

// The app is Hafen wherever it's seen (the window, the menu bar, About); inside it's Hafen Lab, the
// name of its data folder and of its keychain entry, so it runs beside the hafen desktop app (whose
// folder, on a disk that ignores case, "Hafen" would be) and never shares its storage or its lock
const NAME = "Hafen";
app.setName("Hafen Lab");
app.setAboutPanelOptions({ applicationName: NAME, applicationVersion: app.getVersion() });
// (Windows names notifications and the taskbar's entry by this)
if (process.platform === "win32") app.setAppUserModelId("dev.hafen.lab");
// HAFEN_LAB_DATA: a data folder of its own (secrets, window state, the one-window lock), so a test
// run doesn't meet the app you have open
if (process.env.HAFEN_LAB_DATA) app.setPath("userData", process.env.HAFEN_LAB_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  // Once: what the app kept when it was "hafen eval" (carry-over.js). HAFEN_LAB_CARRY_FROM names the
  // folder to copy from instead (a test's); a test's own data folder copies nothing otherwise.
  const from = process.env.HAFEN_LAB_CARRY_FROM ?? (process.env.HAFEN_LAB_DATA ? null : join(app.getPath("appData"), LEGACY_FOLDER));
  try {
    carryOver(from, app.getPath("userData"));
  } catch (err) {
    console.error(`couldn't copy what the app kept before it was Hafen (${err.message}): it's tried again next time`);
  }
}

let win = null;
let engine = null;

/* ---------- secrets: encrypted in the data folder ---------- */

const secretsFile = () => join(app.getPath("userData"), "secrets.json");
const encrypt = (value) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value).toString("base64") : value);
const decrypt = (value) => (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(value, "base64")) : value);

// The values, decrypted: { values: { env: { NAME: value } }, stored (the file as it is), unreadable
// (Set of "env\0NAME" that couldn't be decrypted: encrypted under another keychain, say) }. A file
// that can't be read at all throws, and is never written over.
function readSecrets() {
  let stored;
  try {
    stored = JSON.parse(readFileSync(secretsFile(), "utf8")) ?? {};
  } catch (err) {
    if (err.code === "ENOENT") return { values: {}, stored: {}, unreadable: new Set() };
    throw new Error(`the secrets file can't be read (${err.message}): it's left as it is`);
  }
  const values = {};
  const unreadable = new Set();
  for (const [env, names] of Object.entries(stored)) {
    values[env] = {};
    for (const [name, value] of Object.entries(names ?? {})) {
      try {
        values[env][name] = decrypt(value);
      } catch {
        unreadable.add(`${env}\0${name}`);
      }
    }
  }
  return { values, stored, unreadable };
}

// Write the values, keeping the ones that couldn't be read as they were in the file
function writeSecrets({ values, stored, unreadable }) {
  const out = {};
  for (const env of new Set([...Object.keys(stored), ...Object.keys(values)])) {
    out[env] = {};
    for (const [name, value] of Object.entries(stored[env] ?? {})) if (unreadable.has(`${env}\0${name}`)) out[env][name] = value;
    for (const [name, value] of Object.entries(values[env] ?? {})) out[env][name] = encrypt(value);
  }
  mkdirSync(dirname(secretsFile()), { recursive: true });
  writeFileSync(secretsFile(), JSON.stringify(out, null, 2), { mode: 0o600 });
}

const sendSecrets = () => {
  try {
    engine?.postMessage({ type: "secrets", values: readSecrets().values });
  } catch (err) {
    console.error(err.message);
  }
};

/* ---------- the engine ---------- */

function startEngine() {
  engine = utilityProcess.fork(join(here, "engine-host.js"), [], { serviceName: "Hafen engine", stdio: "inherit" });
  engine.on("exit", (code) => {
    engine = null;
    // Stopped unexpectedly: started again, and the page given a new connection to it (it opens the
    // folder again)
    if (!app.isQuitting && code !== 0) setTimeout(() => { startEngine(); if (win) connect(); }, 500);
  });
  sendSecrets();
}

// A new port between the page and the engine (each time the page loads)
function connect() {
  if (!engine) startEngine();
  const { port1, port2 } = new MessageChannelMain();
  engine.postMessage({ type: "port" }, [port1]);
  win.webContents.postMessage("hafen:port", null, [port2]);
}

/* ---------- the window ---------- */

function themeNow() {
  try {
    return JSON.parse(readFileSync(join(app.getPath("userData"), "window.json"), "utf8")).applied ?? "light";
  } catch {
    return "light";
  }
}

function createWindow() {
  const applied = themeNow();
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: NAME,
    icon: ICON,  // (the window's, on Windows and Linux)
    backgroundColor: BACKGROUND[applied],
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 18, y: 18 } } : { titleBarOverlay: { color: BACKGROUND[applied], symbolColor: applied === "dark" ? "#ededed" : "#0a0a0a", height: 52 } }),
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  if (!existsSync(PAGE)) {
    dialog.showErrorBox(NAME, "The app isn't built yet: run `npm run build` in evals/ first.");
  }
  win.loadFile(PAGE);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) import("electron").then(({ shell }) => shell.openExternal(url));
    return { action: "deny" };
  });
  win.on("closed", () => { win = null; });
}

/* ---------- commands ---------- */

const COMMANDS = {
  engine_port() {
    connect();
    return true;
  },
  async open_folder() {
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], title: "Open a folder with your suites" });
    return result.canceled ? null : result.filePaths[0];
  },
  // The scopes that have secrets ("" is every scope's)
  secrets_scopes() {
    return Object.entries(readSecrets().values).filter(([, names]) => Object.keys(names).length).map(([env]) => env);
  },
  secrets_list({ env = "" }) {
    const { values } = readSecrets();
    return Object.fromEntries(Object.keys(values[env] ?? {}).map((name) => [name, true]));
  },
  secrets_set({ env = "", name, value }) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name ?? "")) throw new Error("a secret's name is letters, digits and _");
    // (A file that can't be read at all throws here, and nothing is written over it)
    const all = readSecrets();
    all.values[env] = { ...(all.values[env] ?? {}) };
    all.unreadable.delete(`${env}\0${name}`);  // set or forgotten: what was there goes
    if (value) all.values[env][name] = value;
    else delete all.values[env][name];
    writeSecrets(all);
    sendSecrets();
    return true;
  },
  notify_system({ title, body, tag }) {
    if (Notification.isSupported()) {
      const note = new Notification({ title, body, silent: true });
      note.on("click", () => {
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        if (tag) win.webContents.send("hafen:notification", String(tag));
      });
      note.show();
    } else win?.flashFrame(true);
    return true;
  },
  set_theme({ applied, choice }) {
    nativeTheme.themeSource = choice === "system" ? "system" : applied;
    win?.setBackgroundColor(BACKGROUND[applied] ?? BACKGROUND.light);
    if (process.platform !== "darwin") win?.setTitleBarOverlay?.({ color: BACKGROUND[applied], symbolColor: applied === "dark" ? "#ededed" : "#0a0a0a" });
    try {
      writeFileSync(join(app.getPath("userData"), "window.json"), JSON.stringify({ applied }));
    } catch {}
    return true;
  },
};

ipcMain.handle("hafen", async (_event, command, args) => {
  try {
    const fn = COMMANDS[command];
    if (!fn) throw new Error(`unknown command "${command}"`);
    return { value: await fn(args ?? {}) };
  } catch (err) {
    return { error: err.message ?? String(err) };
  }
});

// macOS's app menu says Hafen (Electron's own menu would name the app by its data folder's name)
function setMenu() {
  if (process.platform !== "darwin") return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: NAME,
      submenu: [
        { role: "about", label: `About ${NAME}` }, { type: "separator" },
        { role: "services" }, { type: "separator" },
        { role: "hide", label: `Hide ${NAME}` }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" },
        { role: "quit", label: `Quit ${NAME}` },
      ],
    },
    { role: "fileMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
  ]));
}

app.whenReady().then(() => {
  setMenu();
  if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(ICON);
  startEngine();
  createWindow();
});
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on("before-quit", () => { app.isQuitting = true; engine?.kill(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (!win) createWindow(); });
