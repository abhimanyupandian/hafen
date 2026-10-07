// The app's screenshots for the README and docs/, each in light and dark: the browser build (app/dist)
// in Chromium, through the relay, with a folder of suites for a demo support bot that streams thinking,
// tool calls and text, and the mock endpoint's System One and LLM judges. No keys, no network.
// Run: npm run screenshots (it builds the app first).

import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRelay } from "../../server/relay.js";
import { startMock } from "../../packages/hafen/tests/fixtures/mock-endpoint.mjs";

const OUT = fileURLToPath(new URL(".", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pieces = (text, n = 3) => {
  const words = text.split(/(?<= )/);
  const out = [];
  for (let i = 0; i < words.length; i += n) out.push(words.slice(i, i + n).join(""));
  return out;
};

// What the demo bot says, by the message it's sent: its thinking, the tools it calls, its reply
const SCRIPTS = [
  {
    when: /4417/,
    thinking: "The customer wants a refund for order 4417. Look the order up first, to check it's inside the 30-day return window.",
    tools: [{ name: "lookup_order", args: { order_id: 4417 }, result: { item: "Ceramic pour-over kettle", delivered: "2026-10-02", total: 64 } }],
    text: "I'm sorry to hear that, Priya. I found order **4417**: a ceramic pour-over kettle, delivered on October 2. It's inside our 30-day window, so a refund is possible. Could you tell me why you'd like to return it?",
  },
  {
    when: /broken|snapped/i,
    thinking: "Damaged on arrival qualifies for a full refund, with no need to send it back. Start the refund and confirm the amount.",
    tools: [{ name: "create_refund", args: { order_id: 4417, reason: "damaged", amount: 64 }, result: { refund_id: "rf_9c21", status: "processing" } }],
    text: "Thank you for letting me know. I've started a full refund of **$64.00** to your original payment method (refund `rf_9c21`). You'll see it within 3–5 business days, and there's no need to send the kettle back.",
  },
  {
    when: /3920/,
    thinking: "Check when order 3920 was delivered before saying anything about a return.",
    tools: [{ name: "lookup_order", args: { order_id: 3920 }, result: { item: "Linen apron", delivered: "2026-06-14", total: 28 } }],
    text: "Order 3920 was delivered on June 14, which is more than 30 days ago, so it's outside our return window. If it's faulty, I can put you in touch with the maker's warranty team.",
  },
  {
    when: /manager/i,
    thinking: "The customer is frustrated and has asked before. Apologise and find out what the problem is.",
    tools: [],
    text: "I understand how frustrating this has been, and I'm sorry you've had to ask again. Could you give me your order number, so I can see what's happened?",
  },
  {
    when: /5102/,
    thinking: "Look up order 5102's delivery status.",
    tools: [{ name: "lookup_order", args: { order_id: 5102 }, result: { status: "out_for_delivery", eta: "today by 6 pm" } }],
    text: "Good news: order 5102 is out for delivery, and should arrive today by 6 pm.",
  },
  {
    when: /address/i,
    thinking: "Order 5230 hasn't shipped yet, so the address can still change.",
    tools: [{ name: "update_address", args: { order_id: 5230, postcode: "10115" }, result: { ok: true } }],
    text: "Done: order 5230 will now go to your new address in Berlin (10115). It hasn't shipped yet, so nothing else changes.",
  },
];
const FALLBACK = { thinking: "Ask for the order number.", tools: [], text: "Happy to help. Could you tell me your order number?" };

// The demo support bot: SSE, as {type, …} events
function demoBot() {
  return createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "*");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const message = String(JSON.parse(raw || "{}").message ?? "");
    const script = SCRIPTS.find((s) => s.when.test(message)) ?? FALLBACK;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (e) => res.write(`data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`);
    await sleep(380);
    for (const delta of pieces(script.thinking)) { send({ type: "thinking_delta", delta }); await sleep(28); }
    for (const [i, tool] of script.tools.entries()) {
      const id = `call_${i + 1}`;
      send({ type: "tool_call", id, name: tool.name, args: tool.args });
      await sleep(240);
      send({ type: "tool_result", id, name: tool.name, result: tool.result });
      await sleep(90);
    }
    for (const delta of pieces(script.text)) { send({ type: "text_delta", delta }); await sleep(32); }
    const words = (t) => t.split(/\s+/).length;
    send({ type: "usage", input_tokens: 412 + words(message), output_tokens: Math.round(words(script.text) * 1.3), thinking_tokens: Math.round(words(script.thinking) * 1.3) });
    send("[DONE]");
    res.end();
  });
}

// The folder the app opens
const files = (bot, mock) => ({
  "providers/acme-support.yml": `# Acme's support bot: streamed (SSE), with thinking and tool calls
kind: http
url: "{{base_url}}/v1/chat"
body: { message: "{{user}}" }
stream: sse
done_marker: "[DONE]"
events:
  - when: { $.type: thinking_delta }
    thinking: $.delta
    thinking_visibility: summary
  - when: { $.type: text_delta }
    text: $.delta
  - when: { $.type: tool_call }
    tool_call: { id: $.id, name: $.name, args: $.args }
  - when: { $.type: tool_result }
    tool_result: { id: $.id, name: $.name, result: $.result }
  - when: { $.type: usage }
    usage: { input: $.input_tokens, output: $.output_tokens, thinking: $.thinking_tokens }
price: { input: 3, output: 15 }
`,
  "refunds.hafen.yml": `version: 1
name: Support bot · refunds
provider: providers/acme-support.yml

environments:
  staging: { base_url: "${bot}" }

judges:
  default: { kind: systemone, endpoint: "${mock}/systemone" }
  rubric:  { kind: llm, provider: judge, samples: 3 }
providers:
  judge: { kind: openai-chat, base_url: "${mock}/judge", model: judge-mini, api_key: "" }

tests:
  - name: refund for a broken item
    id: t_refund01
    tags: [refunds, smoke]
    repeat: 3
    pass_rate: 0.67
    turns:
      - user: Hi, I'm Priya. I'd like a refund for order 4417.
        expect:
          - { type: status, equals: 200 }
          - { type: tool.called, tool: lookup_order, args: { $.order_id: 4417 } }
          - { contains: "4417" }
          - { type: latency, max_ms: 3000 }
          - { type: systemone.noul, question: "Does the reply ask why they want a refund?", min: 0.8 }
      - user: It arrived broken. The handle had snapped off.
        expect:
          - { type: tool.called, tool: create_refund }
          - { contains: "$64.00" }
          - { type: sequence, value: [thinking, "tool_call:create_refund", text] }
          - { type: judge, judge: rubric, rubric: [Offers a refund without asking for a photo first, Apologises at most once] }
    expect_conversation:
      - { type: systemone.noul, question: "Was the customer's problem resolved?", min: 0.7 }

  - name: refund outside the return window
    id: t_refund02
    tags: [refunds]
    turns:
      - user: Can I still return order 3920? It's from June.
        expect:
          - { type: tool.called, tool: lookup_order }
          - { contains: "30 days" }
          - { type: tool.not_called, tool: create_refund }

  - name: escalates an angry customer
    id: t_refund03
    turns:
      - user: This is the third time I've asked. I want to speak to a manager.
        expect:
          - { type: tool.called, tool: escalate }
          - { type: latency, max_ms: 3000 }
`,
  "orders.hafen.yml": `version: 1
name: Support bot · orders
provider: providers/acme-support.yml

environments:
  staging: { base_url: "${bot}" }

tests:
  - name: where is my order
    id: t_orders01
    tags: [smoke]
    turns:
      - user: Where is my order 5102?
        expect:
          - { type: tool.called, tool: lookup_order, args: { $.order_id: 5102 } }
          - { contains: "out for delivery" }
  - name: change the delivery address
    id: t_orders02
    turns:
      - user: I've moved. Can you send order 5230 to my new address in Berlin, 10115?
        expect:
          - { type: tool.called, tool: update_address }
          - { matches: "10115" }
`,
});

const bot = demoBot();
await new Promise((r) => bot.listen(0, "127.0.0.1", r));
const botUrl = `http://127.0.0.1:${bot.address().port}`;
const mock = await startMock({ chunkMs: 10 });
const relay = createRelay({ allow: [botUrl, mock.url] });
await new Promise((r) => relay.listen(0, "127.0.0.1", r));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript((files) => {
  if (!localStorage.getItem("eval.theme")) {
    localStorage.setItem("eval.theme", "system");
    localStorage.setItem("eval.secrets", JSON.stringify({ "": { JEV_API_KEY: "jev-demo-key" } }));
    localStorage.setItem("eval.section.console", "closed");
    localStorage.setItem("eval.navWidth", "340");
  }
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    for (const [path, text] of Object.entries(files)) {
      const parts = path.split("/");
      let dir = root;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await w.write(text);
      await w.close();
    }
    return root;
  };
}, files(botUrl, mock.url));

await mkdir(OUT, { recursive: true });
// One screenshot in each theme, once the toasts have gone, with the pointer out of the way (an empty
// part of the sidebar)
async function shoot(name) {
  await page.waitForFunction(() => !document.querySelector("#toasts .toast"), null, { timeout: 30000 });
  await page.mouse.move(150, 820);
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.locator(`html[data-theme="${scheme}"]`).waitFor();
    await sleep(300);
    await page.screenshot({ path: `${OUT}${name}-${scheme}.png`, animations: "disabled", caret: "hide" });
  }
  await page.emulateMedia({ colorScheme: "light" });
  process.stdout.write(`${name}\n`);
}
const idle = () => page.locator("html:not([data-running])").waitFor({ timeout: 60000 });
const open = (name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();

try {
  await page.goto(`http://127.0.0.1:${relay.address().port}/`);
  await page.locator("html:not(.loading)").waitFor();
  await page.click("#openFolder");
  await page.locator('#suiteList .list-row[data-file="refunds.hafen.yml"]').waitFor();

  // Exploring: a conversation with the bot
  await page.selectOption("#convProvider", "providers/acme-support.yml");
  for (const [i, message] of ["Hi, I'm Priya. I'd like a refund for order 4417.", "It arrived broken. The handle had snapped off."].entries()) {
    await page.fill("#input", message);
    await page.press("#input", "Enter");
    await page.locator(`#turn-${i}-reply .msg-stats`).waitFor({ timeout: 30000 });
    await idle();
  }
  await shoot("explore");
  await page.click("#conversationsToggle");

  // Every suite, run
  for (const file of ["orders.hafen.yml", "refunds.hafen.yml"]) {
    await page.locator(`#suiteList .list-row[data-file="${file}"] .list-open`).click();
    await page.click("#suiteRun");
    await page.locator("html[data-running]").waitFor({ timeout: 5000 }).catch(() => {});
    await idle();
  }
  await shoot("suite");

  // A test, its first turn selected: the reply, its checks, the response and the timeline
  await open("refund for a broken item");
  await page.locator("#turn-0 .turn-head .label").click();
  await sleep(300);
  if (await page.locator("#timelineFit").count()) await page.click("#timelineFit");
  await shoot("test");

  // A System One check: its result, its confidence and the request it was asked with
  await page.locator("#turnCheck-4-open").click();
  await page.locator("#checkJudgeRequest").waitFor();
  await shoot("check");
} finally {
  if (errors.length) process.stderr.write(`page errors:\n${errors.join("\n")}\n`);
  await browser.close();
  relay.close();
  bot.close();
  await mock.close();
}
