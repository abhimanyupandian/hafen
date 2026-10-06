// Makes the desktop app's icons from source.svg (npm run icons): icon.png (1024 px: Linux, the
// window's on Windows and Linux, and the Dock's when run with npm run app), icon.icns (macOS) and
// icon.ico (Windows). Each size is drawn from the SVG by Chromium (Playwright's), not scaled down,
// and the .icns and .ico hold PNGs, so no other tool is needed.

import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const svg = await readFile(join(here, "source.svg"), "utf8");

const browser = await chromium.launch();
const page = await browser.newPage();
const png = {};
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`)}</body></html>`);
  png[size] = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();

// .icns: "icns", its length, then (type, length with its 8 bytes, PNG) for each size
const ICNS = [["icp4", 16], ["icp5", 32], ["icp6", 48], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024], ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512]];
const entries = ICNS.map(([type, size]) => {
  const head = Buffer.alloc(8);
  head.write(type, 0, "ascii");
  head.writeUInt32BE(png[size].length + 8, 4);
  return Buffer.concat([head, png[size]]);
});
const icnsHead = Buffer.alloc(8);
icnsHead.write("icns", 0, "ascii");
icnsHead.writeUInt32BE(8 + entries.reduce((n, e) => n + e.length, 0), 4);

// .ico: its header, a 16-byte entry for each size (0 means 256), then the PNGs
const ICO = [16, 24, 32, 48, 64, 128, 256];
const icoHead = Buffer.alloc(6 + 16 * ICO.length);
icoHead.writeUInt16LE(0, 0);
icoHead.writeUInt16LE(1, 2);
icoHead.writeUInt16LE(ICO.length, 4);
let offset = icoHead.length;
ICO.forEach((size, i) => {
  const at = 6 + 16 * i;
  icoHead.writeUInt8(size >= 256 ? 0 : size, at);
  icoHead.writeUInt8(size >= 256 ? 0 : size, at + 1);
  icoHead.writeUInt16LE(1, at + 4);
  icoHead.writeUInt16LE(32, at + 6);
  icoHead.writeUInt32LE(png[size].length, at + 8);
  icoHead.writeUInt32LE(offset, at + 12);
  offset += png[size].length;
});

await writeFile(join(here, "icon.png"), png[1024]);
await writeFile(join(here, "icon.icns"), Buffer.concat([icnsHead, ...entries]));
await writeFile(join(here, "icon.ico"), Buffer.concat([icoHead, ...ICO.map((s) => png[s])]));
console.log("desktop/icons: icon.png, icon.icns, icon.ico");
