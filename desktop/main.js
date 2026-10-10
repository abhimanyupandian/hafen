// Hafen as a desktop app (Electron; research §4–5). The window shows the app (app/dist), with no
// title bar: its top bars are the window's, as the design system says. The engine runs in a utility
// process (engine-host.js): Node, as in CI, so the app and CI run the same way, with no CORS, real
// concurrency, and secrets kept out of the page. The page and the engine talk over a MessageChannel
// port; the main process owns the window, the app's workspace (<the data folder>/workspace: the
// suites, providers, plugins and data files the app keeps, as plain files), the dialogs that pick a
// folder or files to import from or export to, and secrets (encrypted with the system's keychain
// through safeStorage), and hands the engine the secrets when it first needs them.
//
// Commands the page can ask for (window.hafen.invoke, preload.cjs):
//   engine_port     (re)connect the page to the engine
//   import_pick     {folder} → ask for suite files (or, folder, a folder of them) to import: { place,
//                   name, files } (place: the engine's id for the folder they're in; files: the suite
//                   files picked, from it; none for a folder), or null
//   export_pick     → ask for a folder to export to: { place, path, name, ci (its path from its git
//                   repository's top, else the whole path: what CI runs) }, or null
//   secrets_state   → what's kept, never a value: { names: {env: [NAME…]} (the ones that can be read;
//                   "" Globals'), unreadable: {env: [NAME…]} (can't be decrypted here), storage:
//                   { encrypted (the system encrypts them now; null until the keychain's first used),
//                   plain (how many are kept unencrypted) } }
//   secrets_scopes  → the scopes that have secrets ("" for Globals)
//   secrets_list    {env} → which secret names have values (never the values)
//   secrets_names   → every scope's secret names as the file keeps them ({env: [NAME…]}, never a value;
//                   one that can't be decrypted among them): for the scopes that no longer exist
//   secrets_reveal  {env, names?} → a scope's own secrets' values ({NAME: value}; all, or those named),
//                   for the page to show when the user asks it to (show, show all, edit as .env)
//   secrets_set     {env, name, value} → keep a value ("" forgets it)
//   secrets_set_many {env, values} → keep several at once ({NAME: value}, "" forgetting one): an import
//   secrets_drop    {env} → forget every secret of a scope (the scope deleted)
//   secrets_move    {from, to} → a scope's secrets kept under its new name (the scope renamed)
//   secrets_copy    {from, to} → a scope's secrets kept for another too (the scope duplicated)
//   secrets_export  {env, file, place?} → ask where (or, place, into a folder picked to export to),
//                   and write the scope's own secrets ("": Globals') there as a .env file, in plain text
//                   (what --secret reads in CI, after globals.secret.env for a scope); the values never
//                   pass through the page. → the path written, or null
//   notify_system   {title, body, tag} → the system's notification, when the window isn't in front;
//                   clicked, the window comes forward and the page is told its tag (hafen:notification)
//   set_theme       {applied} → the window's background and native parts follow the page

import { app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, nativeTheme, Notification, safeStorage, screen, utilityProcess } from "electron";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
// (a secret's name: the engine's, a .env file's and {{secret.NAME}}'s, as the page's is)
import { envValueText, NAME as SECRET_NAME, NAME_RULE } from "hafen/engine/env-file.js";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = join(here, "../app/dist/index.html");
const BACKGROUND = { light: "#ffffff", dark: "#0a0a0a" };
// The app's icon (desktop/icons, made from source.svg). A package has it already (electron-builder
// puts it in); run with npm run app, the app is Electron's own, so the Dock would show Electron's.
const ICON = join(here, "icons", "icon.png");

// The app is Hafen. Its data folder is named by its id, dev.hafen.app, not "Hafen": so it runs
// beside the hafen desktop app (whose folder, on a disk that ignores case, "Hafen" would be) and never
// shares its storage or its lock
const NAME = "Hafen";
const ID = "dev.hafen.app";
app.setName(NAME);
app.setAboutPanelOptions({ applicationName: NAME, applicationVersion: app.getVersion() });
// (Windows names notifications and the taskbar's entry by this)
if (process.platform === "win32") app.setAppUserModelId(ID);
// HAFEN_DATA: a data folder of its own (secrets, window state, the one-window lock), so a test run
// doesn't meet the app you have open
app.setPath("userData", process.env.HAFEN_DATA || join(app.getPath("appData"), ID));
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let engine = null;

/* ---------- the workspace, and folders picked to import from or export to ---------- */

// The app's own files, kept as the engine reads them: made the first time it's needed
const workspaceDir = () => {
  const dir = join(app.getPath("userData"), "workspace");
  mkdirSync(dir, { recursive: true });
  return dir;
};

// Each folder a dialog gave (to import from, or export to), by an id the page names it by: the engine
// reads (and writes) only these, and the workspace
const places = new Map();  // id → { root, write }
let placeCount = 0;
function addPlace(root, write) {
  const id = `p${++placeCount}`;
  places.set(id, { root, write });
  engine?.postMessage({ type: "place", id, root, write });
  return id;
}

// The folder that holds every one of these paths
function commonFolder(paths) {
  const parts = paths.map((p) => dirname(p).split(sep));
  const out = [];
  for (let i = 0; parts.every((p) => i < p.length && p[i] === parts[0][i]); i++) out.push(parts[0][i]);
  return out.join(sep) || sep;
}

// A folder's path as CI sees it once it's committed: from the top of its git repository; outside one,
// the whole path
function ciPath(dir) {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return relative(at, dir).split(sep).join("/") || ".";
    if (dirname(at) === at) return dir;
  }
}


/* ---------- secrets: encrypted in the data folder ---------- */

// secrets.json: { env: { NAME: { encrypted, value } } } ("" Globals'). Each value says whether it's
// encrypted (base64 of safeStorage's) or not (the text: the system offered no encryption when it was
// kept), so neither is ever read as the other when the system's offer changes: one encrypted that can't
// be decrypted now is kept as it is, unused, and never written back as text. A value written before
// the marker (a bare string) was encrypted whenever the system could.
//
// The system's keychain (safeStorage) is used only when a value is needed: a secret set, shown or
// exported, or the engine's first run or message (it asks for them: desktop/engine-host.js). Never as
// the app starts, and never to list names: the file keeps them as plain keys. (On macOS even asking
// whether it can encrypt reads the keychain, and the system may ask the user to allow that.)
const secretsFile = () => join(app.getPath("userData"), "secrets.json");
let valuesRead = false;  // the values have been read in this run of the app: the engine has them
let keychainUsed = false;
const keychain = () => {
  keychainUsed = globalThis.hafenKeychainUsed = true;  // (the tests look: tests/browser/desktop.spec.js)
  return safeStorage;
};
const canEncrypt = () => keychain().isEncryptionAvailable();
const encrypt = (value) => (canEncrypt() ? { encrypted: true, value: keychain().encryptString(value).toString("base64") } : { encrypted: false, value });
function decrypt(stored) {
  const marked = stored !== null && typeof stored === "object";
  const encrypted = marked ? stored.encrypted === true : canEncrypt();
  const value = marked ? stored.value : stored;
  if (typeof value !== "string") throw new Error("not a value");
  if (!encrypted) return { value, plain: true };
  if (!canEncrypt()) throw new Error("the system can't decrypt it now");
  return { value: keychain().decryptString(Buffer.from(value, "base64")), plain: false };
}

// The values, decrypted: { values: { env: { NAME: value } }, stored (the file as it is), unreadable
// (Set of "env\0NAME" that couldn't be decrypted: encrypted under another keychain, say), plain (how
// many are kept unencrypted) }. Read once and kept (each command answers from it), and again only when
// the file changes; a file that can't be read at all throws, and is never written over. Values kept
// unencrypted while the system can encrypt them are encrypted then.
let cache = null;  // { at: the file's mtime and size, all }
function readSecrets() {
  let at = "none";
  try {
    const info = statSync(secretsFile());
    at = `${info.mtimeMs}:${info.size}`;
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`the secrets file can't be read (${err.message}): it's left as it is`);
  }
  if (cache?.at === at) return cache.all;
  let stored = {};
  if (at !== "none") {
    try {
      stored = JSON.parse(readFileSync(secretsFile(), "utf8")) ?? {};
    } catch (err) {
      throw new Error(`the secrets file can't be read (${err.message}): it's left as it is`);
    }
  }
  const values = {};
  const unreadable = new Set();
  let plain = 0;
  for (const [env, names] of Object.entries(stored)) {
    values[env] = {};
    for (const [name, kept] of Object.entries(names ?? {})) {
      try {
        const read = decrypt(kept);
        values[env][name] = read.value;
        if (read.plain) plain++;
      } catch {
        unreadable.add(`${env}\0${name}`);
      }
    }
  }
  const all = { values, stored, unreadable, plain };
  cache = { at, all };
  valuesRead = true;
  // (kept unencrypted when the system couldn't, and it can now: encrypted. A file that can't be written
  // keeps them as they are, and they're still read.)
  if (plain && canEncrypt()) {
    try {
      writeSecrets(all);
    } catch (err) {
      console.error(`couldn't encrypt the secrets kept unencrypted: ${err.message}`);
    }
  }
  return cache.all;
}

// The file as it is: each scope's names, and each value as kept, never decrypted (no keychain). A file
// that can't be read throws, and is never written over.
function readStored() {
  try {
    return JSON.parse(readFileSync(secretsFile(), "utf8")) ?? {};
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`the secrets file can't be read (${err.message}): it's left as it is`);
  }
}
const namesIn = (stored) => Object.fromEntries(Object.entries(stored).map(([env, names]) => [env, Object.keys(names ?? {})]).filter(([, names]) => names.length));
// Write the file as it is (values moved as they're kept, never decrypted); the engine is given the
// values again if it had them
function writeStored(stored) {
  mkdirSync(dirname(secretsFile()), { recursive: true });
  writeFileSync(secretsFile(), JSON.stringify(stored, null, 2), { mode: 0o600 });
  cache = null;
  if (valuesRead) sendSecrets();
}

// Write the values, keeping the ones that couldn't be read as they were in the file. A scope with
// none left isn't written at all: no trace of it stays in the file.
function writeSecrets(all) {
  const { values, stored, unreadable } = all;
  const out = {};
  let plain = 0;
  for (const env of new Set([...Object.keys(stored), ...Object.keys(values)])) {
    const kept = {};
    for (const [name, value] of Object.entries(stored[env] ?? {})) if (unreadable.has(`${env}\0${name}`)) kept[name] = value;
    for (const [name, value] of Object.entries(values[env] ?? {})) {
      kept[name] = encrypt(value);
      if (!kept[name].encrypted) plain++;
    }
    if (Object.keys(kept).length) out[env] = kept;
  }
  mkdirSync(dirname(secretsFile()), { recursive: true });
  writeFileSync(secretsFile(), JSON.stringify(out, null, 2), { mode: 0o600 });
  const info = statSync(secretsFile());
  cache = { at: `${info.mtimeMs}:${info.size}`, all: { values, stored: out, unreadable, plain } };
}

// Change the values (each scope's {NAME: value}; a value "" forgets it), write them and give the engine
// them. A file that can't be read at all throws, and nothing is written over it.
function changeSecrets(change) {
  const all = readSecrets();
  const next = { values: structuredClone(all.values), stored: structuredClone(all.stored), unreadable: new Set(all.unreadable), plain: all.plain };
  change(next);
  writeSecrets(next);
  sendSecrets();
}
const setIn = (all, env, values) => {
  all.values[env] = { ...(all.values[env] ?? {}) };
  for (const [name, value] of Object.entries(values)) {
    if (!SECRET_NAME.test(name ?? "")) throw new Error(`"${name}": a name is ${NAME_RULE}`);
    all.unreadable.delete(`${env}\0${name}`);  // set or forgotten: what was there goes
    if (value) all.values[env][name] = String(value);
    else delete all.values[env][name];
  }
};
// A map's own entries only (a name from the page is never looked up on what an object inherits)
const ownOf = (map, key) => (map && Object.hasOwn(map, key) ? map[key] : undefined);

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
    // workspace again)
    if (!app.isQuitting && code !== 0) setTimeout(() => { startEngine(); if (win) connect(); }, 500);
  });
  // (the values only once they've been read: before then, the engine asks for them before its first
  // run or message, and always has an answer, {} when they can't be read)
  if (valuesRead) sendSecrets();
  engine.on("message", (message) => {
    if (message?.type !== "unlock") return;
    let values = {};
    try {
      values = readSecrets().values;
    } catch (err) {
      console.error(err.message);
    }
    engine?.postMessage({ type: "secrets", values });
  });
  for (const [id, { root, write }] of places) engine.postMessage({ type: "place", id, root, write });
}

// A new port between the page and the engine (each time the page loads), on the workspace
function connect() {
  if (!engine) startEngine();
  const { port1, port2 } = new MessageChannelMain();
  engine.postMessage({ type: "port", workspace: workspaceDir() }, [port1]);
  win.webContents.postMessage("hafen:port", null, [port2]);
}

/* ---------- the window ---------- */

// The window's look before the page draws: the theme the page last applied, unless it was the system's
// (or none was chosen yet, a first start): then the system's now, so a dark system never sees a light
// window first
function themeNow() {
  const system = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  try {
    const saved = JSON.parse(readFileSync(join(app.getPath("userData"), "window.json"), "utf8"));
    // (a file from before the choice was kept in it has only what was applied)
    if (saved.choice === "system" || !["light", "dark"].includes(saved.choice ?? saved.applied)) return system;
    return saved.applied === "dark" ? "dark" : "light";
  } catch {
    return system;
  }
}

function createWindow() {
  const applied = themeNow();
  // It opens filling the screen, every time: the whole work area (the menu bar and the Dock stay in
  // view), maximized
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    x,
    y,
    width,
    height,
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
  win.maximize();
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
  // Suite files to import (the folder they're in is read for what they use), or a folder of them
  async import_pick({ folder = false }) {
    const result = await dialog.showOpenDialog(win, folder
      ? { properties: ["openDirectory"], title: "Import the suites in a folder", buttonLabel: "Import" }
      : { properties: ["openFile", "multiSelections"], title: "Import suites", buttonLabel: "Import", filters: [{ name: "Suites", extensions: ["yml", "yaml", "json"] }] });
    if (result.canceled || !result.filePaths.length) return null;
    const root = folder ? result.filePaths[0] : commonFolder(result.filePaths);
    return { place: addPlace(root, false), name: basename(root), files: folder ? null : result.filePaths.map((f) => relative(root, f).split(sep).join("/")) };
  },
  async export_pick() {
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], title: "Export to a folder", buttonLabel: "Export here" });
    if (result.canceled || !result.filePaths.length) return null;
    const path = result.filePaths[0];
    return { place: addPlace(path, true), path, name: basename(path), ci: ciPath(path) };
  },
  // What's kept, never a value (Settings → Secrets, the fields' checks). Before the values are needed,
  // from the file alone (no keychain): every name kept, none known to be unreadable yet. Whether the
  // system encrypts them is known (and asked) only once the keychain's been used: null till then,
  // unless one was kept unencrypted
  secrets_state() {
    const unknown = (plain) => (plain ? false : null);
    if (!valuesRead) {
      const stored = readStored();
      const plain = Object.values(stored).flatMap((names) => Object.values(names ?? {})).filter((kept) => kept && typeof kept === "object" && kept.encrypted === false).length;
      return { names: namesIn(stored), unreadable: {}, storage: { encrypted: unknown(plain), plain } };
    }
    const { values, unreadable, plain } = readSecrets();
    const names = Object.fromEntries(Object.entries(values).map(([env, kept]) => [env, Object.keys(kept)]).filter(([, n]) => n.length));
    const cannot = {};
    for (const key of unreadable) {
      const [env, name] = key.split("\0");
      (cannot[env] ??= []).push(name);
    }
    return { names, unreadable: cannot, storage: { encrypted: keychainUsed ? canEncrypt() : unknown(plain), plain } };
  },
  // The scopes that have secrets ("" is Globals')
  secrets_scopes() {
    return Object.keys(namesIn(readStored()));
  },
  secrets_list({ env = "" }) {
    return Object.fromEntries(Object.keys(ownOf(readStored(), env) ?? {}).map((name) => [name, true]));
  },
  // Every scope's secret names as the file keeps them, never a value (one that can't be decrypted
  // among them: deleting its scope's secrets deletes it too): Settings → Secrets lists the scopes that
  // no longer exist by these
  secrets_names() {
    return namesIn(readStored());
  },
  // A scope's own values, shown in Settings when the user asks (never otherwise)
  secrets_reveal({ env = "", names }) {
    const kept = ownOf(readSecrets().values, env) ?? {};
    const wanted = Array.isArray(names) ? names.filter((n) => Object.hasOwn(kept, n)) : Object.keys(kept);
    return Object.fromEntries(wanted.map((n) => [n, kept[n]]));
  },
  secrets_set({ env = "", name, value }) {
    return COMMANDS.secrets_set_many({ env, values: { [name]: value } });
  },
  secrets_set_many({ env = "", values = {} }) {
    // (only forgotten: from the file as it is, no keychain)
    if (Object.values(values).every((value) => !value)) {
      const stored = readStored();
      const kept = { ...(ownOf(stored, env) ?? {}) };
      for (const name of Object.keys(values)) delete kept[name];
      if (Object.keys(kept).length) stored[env] = kept;
      else delete stored[env];
      writeStored(stored);
      return true;
    }
    changeSecrets((all) => setIn(all, env, values));
    return true;
  },
  // A scope deleted, renamed or copied: its values move as they're kept (no keychain)
  secrets_drop({ env }) {
    if (!env) throw new Error("name the scope whose secrets go");
    const stored = readStored();
    if (!Object.hasOwn(stored, env)) return true;
    delete stored[env];
    writeStored(stored);
    return true;
  },
  secrets_move({ from, to }) {
    if (!from || !to) throw new Error("name the scope and its new name");
    const stored = readStored();
    if (!Object.hasOwn(stored, from)) return true;
    stored[to] = { ...(stored[to] ?? {}), ...stored[from] };
    delete stored[from];
    writeStored(stored);
    return true;
  },
  secrets_copy({ from, to }) {
    if (!from || !to) throw new Error("name the scope and its copy");
    const stored = readStored();
    if (!Object.keys(stored[from] ?? {}).length) return true;
    stored[to] = { ...(stored[to] ?? {}), ...stored[from] };
    writeStored(stored);
    return true;
  },
  async secrets_export({ env = "", file, place }) {
    const mine = ownOf(readSecrets().values, env) ?? {};
    const name = basename(file || `${env || "globals"}.secret.env`);
    let path;
    if (place) {
      // (into a folder picked to export to, beside the suites)
      const picked = places.get(place);
      if (!picked?.write) throw new Error("that folder wasn't picked to export to: pick it again");
      path = join(picked.root, name);
    } else {
      const result = await dialog.showSaveDialog(win, { title: "Export the secrets, in plain text", defaultPath: join(app.getPath("documents"), name), buttonLabel: "Export" });
      if (result.canceled || !result.filePath) return null;
      path = result.filePath;
    }
    const head = `# ${env ? `The "${env}" scope's own secrets` : "Globals' secrets"}, in plain text, from Hafen.\n# Keep this file out of version control. In CI: hafen run … ${env ? "--secret globals.secret.env " : ""}--secret <this file>\n`;
    writeFileSync(path, `${head}${Object.entries(mine).map(([n, value]) => `${n}=${envValueText(value)}\n`).join("")}`, { mode: 0o600 });
    return path;
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
      writeFileSync(join(app.getPath("userData"), "window.json"), JSON.stringify({ applied, choice }));
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
