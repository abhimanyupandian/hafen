// The demo video: the desktop app driven through a real session with the sample order agent
// (sample-agent/: Google ADK on a local Qwen3-4B), System One (Jev) judging its replies, then the same
// suite run from a terminal (vhs). The app fills the screen, as it opens; the waits for whole runs are
// sped up, and say so on screen.
//
// Needs: the agent running on :8100 (sample-agent/README.md), Ollama, vhs, ffmpeg, a built app
// (npm run build), and a System One key in ~/.hafen-demo/jev.secret.env (JEV_API_KEY=…: never printed).
// Run: npm run demo-video. Writes docs/demo/hafen-demo.mp4 (HAFEN_DEMO_THEME=light for the light theme).

import { _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUT = join(ROOT, "docs/demo");
const AGENT = process.env.AGENT_URL ?? "http://127.0.0.1:8100";
const THEME = process.env.HAFEN_DEMO_THEME ?? "dark";
const KEY_FILE = join(homedir(), ".hafen-demo/jev.secret.env");
const EXPORT_DIR = "/tmp/hafen-demo/order-tests";   // what the terminal shows: a short path
const FAST = 4;                                       // how much the waits for whole runs are sped up
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MESSAGES = [
  "Hi there!",
  "Please add 2 bags of Ethiopian coffee beans to my cart.",
  "Also add a pour-over kettle.",
  "What's in my cart?",
  "Please remove the kettle.",
  "Show me my cart again.",
  "Great, please place my order.",
  "What orders do I have, and what's their status?",
];

// Checks added from the Checks list: [turn index, palette id, YAML, what the caption says it checks]
const CHECKS = [
  [0, "system-one-noul", "type: systemone.noul\nquestion: Is the reply a polite, friendly greeting?\nmin: 0.8",
    "System One (Jev) judges whether the greeting is polite and friendly."],
  [1, "tool-called", "type: tool.called\ntool: add_to_cart\nargs: { $.quantity: 2 }",
    "the agent must call add_to_cart, with a quantity of 2."],
  [3, "tool-called", "type: tool.called\ntool: list_cart",
    "the agent must call list_cart to show the cart."],
  [3, "text", "matches: '\\|\\s*-{3,}'",
    "the reply must show the cart as a markdown table."],
  [5, "tool-called", "type: tool.called\ntool: list_cart",
    "after removing the kettle, it must call list_cart again."],
  [5, "text", "matches: '\\|\\s*-{3,}'",
    "the updated cart, again as a markdown table."],
  [6, "tool-called", "type: tool.called\ntool: place_order",
    "the agent must call place_order."],
  [6, "text", "contains: \"1001\"",
    "the reply must give the order number, 1001."],
  [6, "system-one-noul", "type: systemone.noul\nquestion: Does the reply confirm that the order was placed?\nmin: 0.8",
    "System One (Jev) judges whether the reply confirms the order."],
  [7, "tool-called", "type: tool.called\ntool: list_orders",
    "the agent must call list_orders for the status."],
  [7, "text", "matches: '\\|\\s*-{3,}'",
    "the orders must come as a markdown table."],
  [7, "text", "contains: \"1001\"",
    "order 1001 must be in the list."],
  [7, "system-one-score", "type: systemone.score\non: conversation\nquestion: How polite and professional is the assistant?\nrubric: [rude, curt, polite, warm and professional]\nmin: 2",
    "System One (Jev) scores how polite the whole conversation was."],
];

// ---------- what's needed first ----------

const key = (await readFile(KEY_FILE, "utf8").catch(() => "")).match(/^JEV_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error(`no JEV_API_KEY in ${KEY_FILE}`);
const health = await fetch(`${AGENT}/health`).then((r) => r.json()).catch(() => null);
if (!health?.ok) throw new Error(`the sample agent isn't answering at ${AGENT} (see sample-agent/README.md)`);
for (const tool of ["vhs", "ffmpeg"]) execFileSync("which", [tool]);

const work = await mkdtemp(join(tmpdir(), "hafen-demo-"));
const raw = join(work, "raw");
const data = join(work, "data");
await mkdir(join(data, "workspace/providers"), { recursive: true });
await copyFile(join(ROOT, "sample-agent/hafen/providers/orders-agent.yml"), join(data, "workspace/providers/orders-agent.yml"));
await rm(EXPORT_DIR, { recursive: true, force: true });
await mkdir(EXPORT_DIR, { recursive: true });

// ---------- the app, recorded ----------

const env = { ...process.env, HAFEN_DATA: data, JEV_API_KEY: key };
delete env.ELECTRON_RUN_AS_NODE;
// The window's size as it opens (the screen's work area), so the video is the app as people see it
// (even numbers: the video's encoder needs them)
const probe = await electron.launch({ args: [ROOT], cwd: ROOT, env: { ...env, HAFEN_DATA: join(work, "probe") } });
await probe.firstWindow();
const opened = await probe.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
await probe.close();
const SIZE = { width: opened.width - (opened.width % 2), height: opened.height - (opened.height % 2) };
const app = await electron.launch({ args: [ROOT], cwd: ROOT, env, recordVideo: { dir: raw, size: SIZE } });
const t0 = Date.now();
const page = await app.firstWindow();
await page.locator("html:not(.loading)").waitFor();

// Its scope (local, with the agent's address) and theme, then the conversation's provider
await page.evaluate(({ theme, agent }) => {
  localStorage.setItem("eval.theme", theme);
  localStorage.setItem("eval.scopes", JSON.stringify(["local"]));
  localStorage.setItem("eval.scope.local", JSON.stringify({ agent_url: agent }));
  localStorage.setItem("eval.env", "local");
}, { theme: THEME, agent: AGENT });
await page.reload();
await page.locator("html:not(.loading)").waitFor();
await page.selectOption("#convProvider", "providers/orders-agent.yml");

// The video's timeline: where it starts, and each change of speed (seconds into the recording)
const now = () => (Date.now() - t0) / 1000;
const marks = [];
const speed = async (x) => {
  marks.push({ at: now(), speed: x });
  await badge(x > 1 ? `⏩ ${x}× · the agent at work` : "");
};

// A caption at the foot of the window, and a badge while the waits are sped up (in the page: this
// ffmpeg draws no text)
async function overlay(id, text, style) {
  await page.evaluate(({ id, text, style }) => {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      Object.assign(el.style, { position: "fixed", zIndex: 2147483647, pointerEvents: "none", transition: "opacity .25s", font: "600 17px/1.3 system-ui, -apple-system, sans-serif", padding: "10px 18px", borderRadius: "999px", background: "#ffffff", color: "#0a0a0a", border: "1px solid rgba(0,0,0,.12)", boxShadow: "0 6px 24px rgba(0,0,0,.35)" }, style);
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = text ? "1" : "0";
  }, { id, text, style });
}
const caption = (text) => overlay("demo-caption", text, { left: "50%", bottom: "28px", transform: "translateX(-50%)" });
const badge = (text) => overlay("demo-speed", text, { right: "24px", top: "14px", background: "rgba(37,99,235,.95)", color: "#fff", border: "none", font: "600 14px/1.2 system-ui, -apple-system, sans-serif" });

async function waitForReply() {
  await page.locator("#send.stop").waitFor({ timeout: 30000 });
  await page.locator("#send:not(.stop)").waitFor({ timeout: 10 * 60000 });
}
async function waitForRun() {
  await page.locator("#status", { hasText: "running" }).waitFor({ timeout: 10000 }).catch(() => {});
  await page.locator("#status", { hasText: /passed|failed|error|stopped/ }).waitFor({ timeout: 20 * 60000 });
}
const suiteText = () => readFile(join(data, "workspace/shop.hafen.yml"), "utf8").catch(() => "");

marks.push({ at: now(), start: true });
await speed(1);

// Scene 1: a conversation
await caption("A coffee shop agent: Google ADK on a local Qwen3-4B. Talk to it in Hafen.");
await sleep(2500);
for (const [i, message] of MESSAGES.entries()) {
  await page.locator("#input").pressSequentially(message, { delay: 28 });
  await sleep(400);
  await page.press("#input", "Enter");
  await sleep(600);
  await speed(FAST);
  await waitForReply();
  await speed(1);
  if (i === 1) await caption("Its tool calls and reply stream in, and every step lands on the timeline.");
  await sleep(1800);
}
await page.locator("#turn-3-reply .msg-body").click();
await caption("Each reply's response, as JSON: the tool it called, and what the tool returned.");
await sleep(3500);

// Scene 2: saved as a test
await caption("Save the conversation as a test.");
await page.locator("#saveSuiteName").pressSequentially("shop", { delay: 60 });
await page.locator("#saveName").pressSequentially("fill a cart, then order", { delay: 35 });
await sleep(600);
await page.click("#saveTest");
await page.locator("#evalTitle", { hasText: "fill a cart, then order" }).waitFor();
await sleep(2000);

// Scene 3: checks from the Checks list: the tools called, and System One (Jev) on the replies
await caption("Now add checks to the turns, from the Checks list.");
await page.click("#checksToggle");
await sleep(1500);
for (const [n, [turn, palette, yaml, says]] of CHECKS.entries()) {
  await caption(`Turn ${turn + 1}: ${says}`);
  await page.locator(`#turn-${turn} .turn-head`).click();
  await sleep(250);
  await page.click(`#palette-${palette}`);
  await page.locator("#checkYaml").waitFor();
  await sleep(250);
  await page.fill("#checkYaml", "");
  // (the first two typed out; the rest pasted, as the video has shown how)
  if (n < 2) await page.locator("#checkYaml").pressSequentially(yaml, { delay: 22 });
  else await page.fill("#checkYaml", yaml);
  const before = await suiteText();
  await page.locator("#checkYaml").blur();
  // (saved: the file changed)
  for (let k = 0; k < 40 && (await suiteText()) === before; k++) await sleep(150);
  // (time to read the caption)
  await sleep(n < 2 ? 1200 : 1700);
}

// Scene 4: run it
await caption("Run the test: Follow keeps the running turn in view, and every check gets a badge.");
await page.locator("#scroller").evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
await sleep(800);
await page.click("#testHeaderRun");
await sleep(2500);
await speed(FAST);
await waitForRun();
await speed(1);
await caption("Each check says why, and System One's give a value and a confidence.");
await page.locator("#turn-0").scrollIntoViewIfNeeded();
await sleep(1500);
await page.locator("#turn-0-reply .badge", { hasText: "noul" }).first().click();
await sleep(4000);

// Scene 5: exported to a folder
await caption("Export the suite, with everything it uses, to your repository.");
await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, EXPORT_DIR);
await page.locator('#suiteList .list-row[data-file="shop.hafen.yml"] .list-open').click();
await sleep(1500);
await page.click("#suiteExport");
await page.locator("#exportGo").waitFor();
await sleep(2000);
await page.click("#exportGo");
await page.locator("#exportDialog").waitFor({ state: "detached" });
await page.locator("#suiteCiHint").scrollIntoViewIfNeeded().catch(() => {});
await sleep(4000);
marks.push({ at: now(), end: true });

const video = page.video();
await app.close();
const appVideo = await video.path();
console.log("app recorded:", appVideo);

// ---------- the terminal, recorded by vhs ----------

const cli = join(ROOT, "packages/hafen/cli/hafen.js");
const terminalVideo = join(raw, "terminal.mp4");
const theme = THEME === "light"
  ? '{"name":"hafen","background":"#ffffff","foreground":"#1a1a1a","black":"#1a1a1a","red":"#c62828","green":"#2e7d32","yellow":"#a16207","blue":"#1d4ed8","magenta":"#7e22ce","cyan":"#0e7490","white":"#e5e5e5","brightBlack":"#6b6b6b","brightRed":"#c62828","brightGreen":"#2e7d32","brightYellow":"#a16207","brightBlue":"#1d4ed8","brightMagenta":"#7e22ce","brightCyan":"#0e7490","brightWhite":"#ffffff","cursor":"#1a1a1a","selection":"#d4d4d4"}'
  : '{"name":"hafen","background":"#0a0a0a","foreground":"#e6e6e6","black":"#0a0a0a","red":"#f87171","green":"#4ade80","yellow":"#facc15","blue":"#60a5fa","magenta":"#c084fc","cyan":"#22d3ee","white":"#e6e6e6","brightBlack":"#737373","brightRed":"#f87171","brightGreen":"#4ade80","brightYellow":"#facc15","brightBlue":"#60a5fa","brightMagenta":"#c084fc","brightCyan":"#22d3ee","brightWhite":"#ffffff","cursor":"#e6e6e6","selection":"#333333"}';
const tape = `Output "${terminalVideo}"
Set Shell bash
Set FontSize 22
Set Width ${SIZE.width}
Set Height ${SIZE.height}
Set Padding 40
Set Theme ${theme}
Set TypingSpeed 40ms
Set WaitTimeout 20m
Env BASH_SILENCE_DEPRECATION_WARNING "1"
Hide
Type \`export PS1='$ '; cd /tmp/hafen-demo; hafen() { node '${cli}' "$@"; }; clear\`
Enter
Show
Sleep 800ms
Type "# The same suite, from a terminal: as CI runs it"
Enter
Sleep 600ms
Type "hafen run order-tests --env order-tests/local.env --secret ~/.hafen-demo/jev.secret.env"
Sleep 500ms
Enter
Wait+Screen /tests? · \\d+ failed/
Sleep 5s
`;
const tapeFile = join(work, "terminal.tape");
await writeFile(tapeFile, tape);
const vhsStart = Date.now();
execFileSync("vhs", [tapeFile], { stdio: "inherit", cwd: work });
const vhsSeconds = (Date.now() - vhsStart) / 1000;
console.log("terminal recorded:", terminalVideo, `(${Math.round(vhsSeconds)} s)`);

// ---------- cut, sped up where it says so, and joined ----------

// The app's segments: from the start mark to the end, each at its speed
const start = marks.find((m) => m.start).at;
const end = marks.find((m) => m.end).at;
const changes = marks.filter((m) => m.speed !== undefined && m.at >= start && m.at <= end);
const segments = changes.map((m, i) => ({ from: m.at, to: changes[i + 1]?.at ?? end, speed: m.speed })).filter((s) => s.to - s.from > 0.05);
// The terminal's: as typed, sped up while it runs (from 9 s in to 5 s before its end)
const termLength = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", terminalVideo]).toString());
const termSegments = [{ from: 0, to: 9, speed: 1 }, { from: 9, to: termLength - 5, speed: FAST }, { from: termLength - 5, to: termLength, speed: 1 }];

const parts = [];
const filter = [];
const cut = (input, list, label) => list.forEach((s, i) => {
  filter.push(`[${input}:v]trim=start=${s.from.toFixed(3)}:end=${s.to.toFixed(3)},setpts=(PTS-STARTPTS)/${s.speed},scale=${SIZE.width}:${SIZE.height}:force_original_aspect_ratio=decrease,pad=${SIZE.width}:${SIZE.height}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1[${label}${i}]`);
  parts.push(`[${label}${i}]`);
});
cut(0, segments, "a");
cut(1, termSegments, "t");
filter.push(`${parts.join("")}concat=n=${parts.length}:v=1:a=0[out]`);
const output = join(OUT, "hafen-demo.mp4");
execFileSync("ffmpeg", ["-y", "-v", "error", "-i", appVideo, "-i", terminalVideo, "-filter_complex", filter.join(";"), "-map", "[out]",
  "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output], { stdio: "inherit" });
const length = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", output]).toString());
await writeFile(join(work, "marks.json"), JSON.stringify({ marks, segments, termSegments }, null, 2));
console.log(`wrote ${output}: ${Math.round(length)} s (raw footage kept in ${raw})`);
