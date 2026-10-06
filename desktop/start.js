// `npm run app`: start the desktop app. Editors built on Electron (VS Code among them) set
// ELECTRON_RUN_AS_NODE for the processes they start, which would make Electron run main.js as plain
// Node; it's cleared here so the app starts the same from any terminal.
//
// On macOS the menu bar, the Dock and ⌘-Tab name an app by its bundle, and the one npm installs is
// Electron's own ("Electron", Electron's icon). So it's run from a copy named Hafen, with the
// app's icon (.electron-dev/<electron version>/Hafen.app: a clone, made once per Electron version
// and re-signed for this machine). A package (npm run app:build) is named and signed by
// electron-builder instead.

import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const NAME = "Hafen";

// The Electron to run: on macOS the named copy (made if it isn't there yet), elsewhere Electron's own
export function devElectron({ electron = require("electron"), into = join(ROOT, ".electron-dev"), platform = process.platform } = {}) {
  if (platform !== "darwin") return electron;
  const version = JSON.parse(readFileSync(require.resolve("electron/package.json"), "utf8")).version;
  const app = join(into, version, `${NAME}.app`);
  const binary = join(app, "Contents", "MacOS", "Electron");
  const stamp = join(into, version, "made");
  if (existsSync(stamp) && existsSync(binary)) return binary;
  const source = resolve(dirname(electron), "..", "..");  // …/Electron.app
  rmSync(join(into, version), { recursive: true, force: true });
  mkdirSync(join(into, version), { recursive: true });
  // A clone where the disk can (APFS): instant, and no space used
  try {
    execFileSync("cp", ["-cR", source, app]);
  } catch {
    cpSync(source, app, { recursive: true, verbatimSymlinks: true });
  }
  const plist = join(app, "Contents", "Info.plist");
  for (const [key, value] of [["CFBundleName", NAME], ["CFBundleDisplayName", NAME], ["CFBundleIdentifier", "dev.hafen.lab.dev"]]) {
    execFileSync("plutil", ["-replace", key, "-string", value, plist]);
  }
  cpSync(join(ROOT, "desktop", "icons", "icon.icns"), join(app, "Contents", "Resources", "electron.icns"));
  // Its Info.plist changed, so its signature no longer matches: signed again, for this machine only
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "ignore" });
  writeFileSync(stamp, `${new Date().toISOString()}\n`);
  return binary;
}

// Run directly (node desktop/start.js): compared as paths, so a folder with spaces in its name (or
// Windows' paths) still matches
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let electron;
  try {
    electron = devElectron();
  } catch (err) {
    // (Electron's own still runs: only its name is wrong)
    console.error(`couldn't make the named app (${err.message}); starting Electron's own`);
    electron = require("electron");
  }
  const child = spawn(electron, [ROOT, ...process.argv.slice(2)], { stdio: "inherit", env });
  child.on("exit", (code) => process.exit(code ?? 0));
}
