// The app as Hafen, and its turns and checks as they now look: the response's JSON ends with its
// closing bracket; turns are listed with a box-with-a-tick icon in the colour of how they went; sending
// goes to the bottom; a reply has no provider label; checks aren't dragged, and are cards (by status)
// that can be turned off and on; the request and the raw stream, renamed and spaced; an editor opened
// from Settings goes back to Settings; Settings' headings; the panels' spacing; an empty timeline as
// tall as its note; the checks grouped; "Storage used"; placeholders in the middle of what holds them;
// and what the app kept before it was Hafen, carried over.

import { parse } from "yaml";
import { expect, fileText, fixtureFiles, newScope, openYaml, pickFolder, reopen, test, writeFiles } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";
const openApp = async (page) => {
  await reopen(page);
  await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
};
const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
const turnButton = (page, n, text = "") => page.locator(`#suiteList .list-open[aria-label^="turn ${n}: ${text}"]`).first();
const fileSays = (page, check, file = SUITE) => expect.poll(async () => { try { return check(parse(await fileText(page, file))); } catch { return false; } }, { timeout: 5000 }).toBe(true);
const writeFile = (page, path, text) => page.evaluate(async ([path, text]) => {
  const parts = path.split("/");
  let dir = await navigator.storage.getDirectory().then((root) => root.getDirectoryHandle("workspace", { create: true }));
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(text);
  await w.close();
}, [path, text]);
// A design token's colour, as the page draws it
const token = (page, name) => page.evaluate((name) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, name);
const box = (locator) => locator.boundingBox();
async function runSmoke(page) {
  await openTest(page, "refund for a broken item");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
}

test.afterEach(async ({ app: { errors } }) => {
  expect(errors).toEqual([]);
});

test("the response's JSON ends with its closing bracket, as every open object and array does", async ({ app: { page } }) => {
  await openApp(page);
  await runSmoke(page);
  await page.locator("#turn-0 .turn-head .label").click();
  const tree = page.locator("#turnResponse");
  const rows = tree.locator(".json-row");
  // The last row is the root's "}", at its depth
  await expect(rows.last()).toHaveClass(/json-end/);
  await expect(rows.last()).toHaveText("}");
  expect(await rows.last().evaluate((el) => el.style.paddingLeft)).toBe("0px");
  // One closing row for each open object and array
  const open = await tree.locator(".json-row:not(.json-end) > .tree-toggle[aria-expanded='true']").count();
  await expect(tree.locator(".json-end")).toHaveCount(open);
  // Scrolled to its end, the last line shows inside the box
  await tree.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const [inner, outer] = [await box(rows.last()), await box(tree)];
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height);
  // Folded, the root has no closing row
  await tree.locator(".json-row").first().locator(".tree-toggle").click();
  await expect(tree.locator(".json-end")).toHaveCount(0);
});

test("turns are listed with a box-with-a-tick icon (not 'turn 1'), green when passed, red when failed, blue while running", async ({ app: { page, servers } }) => {
  // A suite whose one turn takes a while
  await writeFile(page, "providers/mock-slow.yml", 'kind: http\nurl: "{{base_url}}/slow?ms=1500"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n');
  await writeFile(page, "slow.hafen.yml", `version: 1\nname: Slow\nprovider: providers/mock-slow.yml\nenvironments:\n  local: { base_url: "${servers.mock.url}" }\ntests:\n  - name: slow one\n    turns:\n      - user: wait for it\n        expect:\n          - { type: status, equals: 200 }\n`);
  await openApp(page);
  // Before a run: the icon, grey; the message, not "turn 1"
  const first = turnButton(page, 1, "Hi, I'm");
  await expect(first.locator(".turn-icon svg")).toHaveCount(1);
  await expect(first.locator(".turn-icon")).not.toHaveAttribute("data-status", /./);
  expect(await first.textContent()).not.toMatch(/turn 1/);
  await expect(first).toHaveAttribute("aria-label", /^turn 1: Hi, I'm \{\{customer\}\}/);
  await runSmoke(page);
  await expect(first.locator(".turn-icon")).toHaveAttribute("data-status", "passed");
  expect(await first.locator(".turn-icon").evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--ok"));
  const second = turnButton(page, 2, "It arrived broken");
  await expect(second.locator(".turn-icon")).toHaveAttribute("data-status", "failed");
  expect(await second.locator(".turn-icon").evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--danger"));
  // The suite's view lists its turns the same way
  await page.locator(`#suiteList .list-row[data-file="${SUITE}"] .list-open`).first().click();
  await expect(page.locator("#suiteTest-0-turn-0 .turn-icon")).toHaveAttribute("data-status", "passed");
  await expect(page.locator("#suiteTest-0-turn-1 .turn-icon")).toHaveAttribute("data-status", "failed");
  expect(await page.locator("#suiteTest-0-turn-0").textContent()).not.toMatch(/turn 1/);
  // Running: blue, then green
  await openTest(page, "slow one");
  await page.click("#testRun");
  const slow = turnButton(page, 1, "wait for it");
  await expect(slow.locator(".turn-icon")).toHaveAttribute("data-status", "running");
  expect(await slow.locator(".turn-icon").evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--run"));
  await expect(slow.locator(".turn-icon")).toHaveAttribute("data-status", "passed", { timeout: 10000 });
});

test("sending a message (or adding a turn) goes to the bottom of the thread, wherever it was", async ({ app: { page } }) => {
  await openApp(page);
  await page.selectOption("#convProvider", "providers/mock-json.yml");
  const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  for (const n of [1, 2]) {
    await page.fill("#input", `${long}\nmessage ${n}`);
    await page.click("#send");
    await expect(page.locator(`#turn-${n - 1}-reply .msg-body`)).toContainText("You said");
  }
  const scroller = page.locator("#scroller");
  const atBottom = () => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 2);
  expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight * 1.5)).toBe(true);
  // Scrolled up, it stays there (until a message is sent)
  await scroller.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(200);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
  await page.fill("#input", "and one more");
  await page.click("#send");
  await expect(page.locator("#turn-2-reply .msg-body")).toContainText("You said: and one more");
  await expect.poll(atBottom).toBe(true);
  // With a test open, adding a turn goes there too
  await openTest(page, "refund for a broken item");
  await page.fill("#input", `${long}\nanother turn`);
  await page.click("#send");
  await fileSays(page, (d) => d.tests[0].turns.length === 3);
  await scroller.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(200);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
  await page.fill("#input", `${long}\na new turn`);
  await page.click("#send");
  await fileSays(page, (d) => d.tests[0].turns.length === 4);
  await expect.poll(atBottom).toBe(true);
});

test("a reply has no provider label: its stats and its copy button go under it", async ({ app: { page } }) => {
  await openApp(page);
  await page.selectOption("#convProvider", "providers/mock-json.yml");
  await page.fill("#input", "hello");
  await page.click("#send");
  await expect(page.locator("#turn-0-reply .msg-body")).toContainText("You said: hello");
  await expect(page.locator("#turn-0-reply > .label")).toHaveCount(0);
  await expect(page.locator("#turn-0-reply")).not.toContainText("mock-json");
  await expect(page.locator("#turn-0-reply .msg-foot .msg-stats")).toBeVisible();
  await expect(page.locator("#turn-0-reply .msg-foot #turn-0-copy")).toHaveCount(1);
  // (A test's reply too)
  await runSmoke(page);
  await expect(page.locator("#turn-0-reply > .label")).toHaveCount(0);
  await expect(page.locator("#turn-0-reply")).not.toContainText("mock-json");
});

test("a turn's checks are cards, coloured by how they went; a check's last result is one too", async ({ app: { page } }) => {
  await openApp(page);
  await runSmoke(page);
  await page.locator("#turn-0 .turn-head .label").click();
  const cards = page.locator("#turnChecks > .check-card");
  await expect(cards).toHaveCount(4);
  // Like the sidebar's palette cards: a bordered card, its kind as an icon and a label, then the check
  await page.click("#checksToggle");
  const [card, palette] = await Promise.all([
    cards.first().evaluate((el) => { const cs = getComputedStyle(el); return [cs.paddingTop, cs.paddingLeft, cs.borderTopWidth, cs.borderTopStyle]; }),
    page.locator("#palette-path").evaluate((el) => { const cs = getComputedStyle(el); return [cs.paddingTop, cs.paddingLeft, cs.borderTopWidth, cs.borderTopStyle]; }),
  ]);
  expect(card).toEqual(palette);
  await expect(cards.first().locator(".block-label svg")).toHaveCount(1);
  await expect(cards.first().locator(".block-label .label")).toHaveText("Status");
  await expect(cards.nth(1).locator(".block-label .label")).toHaveText("Path");
  await expect(cards.first().locator(".check-card-text")).toHaveText("status 200");
  // By status: passed, green (its edge, its label, its status)
  await expect(cards.first()).toHaveAttribute("data-status", "pass");
  await expect(page.locator("#turnCheck-0-status")).toHaveText("pass");
  const ok = await token(page, "--ok");
  expect(await cards.first().evaluate((el) => getComputedStyle(el).boxShadow)).toContain(ok);
  expect(await cards.first().locator(".block-label").evaluate((el) => getComputedStyle(el).color)).toBe(ok);
  // Failed, red
  await page.locator("#turn-1 .turn-head .label").click();
  await expect(page.locator("#turnCheck-0")).toHaveAttribute("data-status", "fail");
  expect(await page.locator("#turnCheck-0").evaluate((el) => getComputedStyle(el).boxShadow)).toContain(await token(page, "--danger"));
  await expect(page.locator("#turnCheck-0 .check-card-reason")).not.toBeEmpty();
  // A click on the card opens the check; its last result is the same card
  await page.locator("#turnCheck-0 .check-card-reason").click();
  await expect(page.locator("#panel .panel-head")).toContainText("Check");
  await expect(page.locator("#checkResult > .check-card")).toHaveAttribute("data-status", "fail");
  await expect(page.locator("#checkResultCard .list-del")).toHaveCount(0);
  await expect(page.locator("#checkResultCard-on")).toHaveCount(0);
});

test("a check is turned off and on from its card and from its panel: skipped when off, and the file as it was when on again", async ({ app: { page } }) => {
  await openApp(page);
  const original = await fileText(page, SUITE);
  await openTest(page, "refund for a broken item");
  await page.locator("#turn-0 .turn-head .label").click();
  await expect(turnButton(page, 1).locator("xpath=..").locator(".list-size")).toHaveText("4 checks");
  // Off, from its card (it shows at once, before the file's saved)
  await page.locator("#turnCheck-1-on").uncheck();
  await expect(page.locator("#turnCheck-1-on")).not.toBeChecked();
  await fileSays(page, (d) => d.tests[0].turns[0].expect[1].enabled === false);
  await expect(page.locator("#turnCheck-1")).toHaveAttribute("data-status", "off");
  await expect(page.locator("#turnCheck-1-status")).toHaveText("off");
  await expect(page.locator("#panel .field-head", { hasText: "Checks" })).toContainText("1 off");
  await expect(page.locator("#check-0-1")).toHaveAttribute("data-status", "off");
  await expect(turnButton(page, 1).locator("xpath=..").locator(".list-size")).toHaveText("3 checks");
  // Run: it's skipped, the others count
  await page.click("#testHeaderRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  await expect(page.locator("#turnCheck-1")).toHaveAttribute("data-status", "off");
  await expect(page.locator("#turnCheck-0")).toHaveAttribute("data-status", "pass");
  await expect(turnButton(page, 1).locator("xpath=..").locator(".list-size")).toHaveText("3/3");
  await expect(page.locator("#turn-0 .turn-summary")).toContainText("3/3 checks");
  const recorded = await page.evaluate(async () => {
    const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const db = await done(indexedDB.open("hafen"));
    const runs = await done(db.transaction("runs").objectStore("runs").getAll());
    db.close();
    return runs.sort((a, b) => b.started - a.started)[0].turns[0].results[1];
  });
  expect([recorded.status, recorded.reason]).toEqual(["skipped", "turned off (enabled: false)"]);
  // On again, from the check's panel: the key goes, and the file is as it was
  await page.locator("#turnCheck-1-open").click();
  await expect(page.locator("#checkOn")).not.toBeChecked();
  await expect(page.locator("#checkResultCard")).toHaveAttribute("data-status", "off");
  await page.locator("#checkOn").check();
  await fileSays(page, (d) => d.tests[0].turns[0].expect[1].enabled === undefined);
  expect(await fileText(page, SUITE)).toBe(original);
  // The last run ran it turned off: on, it hasn't run as it is now
  await expect(page.locator("#checkNotRun")).toBeVisible();
  await expect(page.locator("#checkResultCard")).toHaveCount(0);
  await page.locator("#panelBack").click();
  await expect(page.locator("#turnCheck-1-on")).toBeChecked();
});

test("the request and the raw stream: named Request and Raw stream, each on a row of its own, apart", async ({ app: { page } }) => {
  await openApp(page);
  await page.selectOption("#convProvider", "providers/mock-sse.yml");
  await page.fill("#input", "hi");
  await page.click("#send");
  await expect(page.locator("#send")).toHaveText(/send/i);
  await page.locator("#turn-0 .turn-head .label").click();
  await expect(page.locator("#turnRequest > summary")).toHaveText("Request");
  await expect(page.locator("#turnStream > summary")).toHaveText(/^Raw stream · \d+ chunks?$/);
  const [request, stream] = [await box(page.locator("#turnRequest")), await box(page.locator("#turnStream"))];
  expect(stream.y - (request.y + request.height)).toBeGreaterThanOrEqual(6);
  expect(request.height).toBeGreaterThanOrEqual(24);
  // Opened, its content is under its name, apart from it
  await page.locator("#turnRequest > summary").click();
  const [summary, pre] = [await box(page.locator("#turnRequest > summary")), await box(page.locator("#turnRequest > pre"))];
  expect(pre.y - (summary.y + summary.height)).toBeGreaterThanOrEqual(6);
});

test("an editor opened from Settings goes back to Settings: Cancel, Esc and Save each close only the editor", async ({ app: { page } }) => {
  await openApp(page);
  await page.click("#openSettings");
  await page.click("#settings-tab-environments");
  await newScope(page, "stage");
  await expect(page.locator("#envText")).toBeEnabled();
  // Cancel
  await page.click("#envText");
  await expect(page.locator("#editorText")).toBeVisible();
  await page.click("#editorCancel");
  await expect(page.locator("#editorText")).toHaveCount(0);
  await expect(page.locator("#settingsModal")).toBeVisible();
  await expect(page.locator("#settingsTitle")).toHaveText("Environments");
  // Esc
  await page.click("#envText");
  await expect(page.locator("#editorText")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#editorText")).toHaveCount(0);
  await expect(page.locator("#settingsModal")).toBeVisible();
  // Save: saved (the scope's values, as a .env file's text), and back in Settings
  await page.click("#envText");
  await page.fill("#editorText", "base_url=http://stage.example\n");
  await page.click("#editorSave");
  await expect(page.locator("#editorText")).toHaveCount(0);
  await expect(page.locator("#settingsModal")).toBeVisible();
  await expect(page.locator("#envVar-base_url input")).toHaveValue("http://stage.example");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("eval.scope.stage")))).toEqual({ base_url: "http://stage.example" });
  // A field's large editor in Settings (a provider's YAML): the same
  await page.click("#settings-tab-providers");
  await page.click("#provider-mock-json-open");
  await openYaml(page);
  await page.click("#providerYamlMax");
  await expect(page.locator("#editorText")).toBeVisible();
  await page.click("#editorCancel");
  await expect(page.locator("#settingsModal")).toBeVisible();
  await expect(page.locator("#providerYaml")).toBeVisible();
  // And Settings' own × still closes it
  await page.click("#settingsClose");
  await expect(page.locator("#settingsModal")).toHaveCount(0);
});

test("Settings: its groups' headings are bold capitals; its foot says the storage used", async ({ app: { page } }) => {
  await openApp(page);
  await runSmoke(page);
  await page.click("#openSettings");
  const headings = page.locator(".settings-group");
  expect(await headings.allTextContents()).toEqual(["Storage", "Connection", "Configurations", "App"]);
  for (const style of await headings.evaluateAll((els) => els.map((el) => { const cs = getComputedStyle(el); return [Number(cs.fontWeight) >= 600, cs.textTransform]; }))) {
    expect(style).toEqual([true, "uppercase"]);
  }
  await expect(page.locator("#settingsUsage")).toHaveText(/^Storage used\s*\d+\.\d MB$/);
  await expect(page.locator("#settingsUsageValue")).toHaveText(/^\d+\.\d MB$/);
  await expect(page.locator("#settingsUsage")).toHaveAttribute("title", /1 run · 0 conversations/);
});

test("the app is Hafen: its title, its name, the commands it shows; no 'hafen eval' anywhere", async ({ app: { page } }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await expect(page).toHaveTitle("Hafen");
  await expect(page.locator("#brand")).toHaveAttribute("title", "Hafen");
  await runSmoke(page);
  // (Copy CI command runs the folder it was exported to: exported first)
  await pickFolder(page, "ci");
  await page.click("#testCopyCi");
  await page.click("#exportGo");
  await expect(page.locator("#exportDialog")).toHaveCount(0);
  await page.click("#testCopyCi");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^npx hafen run "ci" .*--report run:results\/run\.hafen-run\.json$/);
  await page.click("#openSettings");
  for (const tab of ["relay", "plugins", "environments"]) {
    await page.click(`#settings-tab-${tab}`);
    expect((await page.locator("#settingsModal").innerText()).toLowerCase()).not.toMatch(/hafen[ -]eval/);
  }
  await page.click("#settingsClose");
  expect((await page.content()).toLowerCase()).not.toMatch(/hafen[ -]eval/);
});

test("a run file from before the app was Hafen opens, and goes out again as a Hafen run", async ({ app: { page } }) => {
  await openApp(page);
  await runSmoke(page);
  const run = await page.evaluate(async () => {
    const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const db = await done(indexedDB.open("hafen"));
    const runs = await done(db.transaction("runs").objectStore("runs").getAll());
    db.close();
    return runs[0];
  });
  const old = { ...run, _id: "oldrun0000000001", kind: "hafen-eval-run" };
  await page.locator("#runsSection input[type=file]").setInputFiles({ name: "oldrun0000000001.hafen-eval-run.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(old)) });
  await expect(page.locator("#run-oldrun0000000001")).toBeVisible();
  await expect(page.locator("#panel .panel-head")).toContainText("Run");
  const download = page.waitForEvent("download");
  await page.click("#exportRun");
  const file = await download;
  expect(file.suggestedFilename()).toBe("oldrun0000000001.hafen-run.json");
  const { readFile } = await import("node:fs/promises");
  expect(JSON.parse(await readFile(await file.path(), "utf8")).kind).toBe("hafen-run");
});

test("the runs and conversations the app kept before it was Hafen (its old database) are carried over, once", async ({ app: { page } }) => {
  await openApp(page);
  await runSmoke(page);
  await page.click("#newConversation");
  await page.selectOption("#convProvider", "providers/mock-json.yml");
  await page.fill("#input", "kept from before");
  await page.click("#send");
  await expect(page.locator("#conversationList .list-row")).toHaveCount(1);
  // Into the old database, out of the new one (as a browser that ran the old app has them)
  const ids = await page.evaluate(async () => {
    const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const now = await done(indexedDB.open("hafen"));
    const records = {};
    for (const s of ["runs", "conversations"]) records[s] = await done(now.transaction(s).objectStore(s).getAll());
    const open = indexedDB.open("hafen-eval", 2);
    open.onupgradeneeded = () => { for (const s of ["runs", "conversations"]) open.result.createObjectStore(s, { keyPath: "_id" }); };
    const old = await done(open);
    for (const s of ["runs", "conversations"]) {
      const tx = old.transaction(s, "readwrite");
      for (const r of records[s]) tx.objectStore(s).put(r);
      await new Promise((r) => { tx.oncomplete = r; });
      const clear = now.transaction(s, "readwrite");
      clear.objectStore(s).clear();
      await new Promise((r) => { clear.oncomplete = r; });
    }
    old.close();
    now.close();
    return { run: records.runs[0]._id, conversation: records.conversations[0]._id };
  });
  await page.reload();
  await page.locator("html:not(.loading)").waitFor();
  await expect(page.locator(`#run-${ids.run}`)).toBeVisible();
  await expect(page.locator(`#conversation-${ids.conversation}`)).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).sort())).toEqual(["hafen"]);
});

test("the panels' spacing: a label 6px over its field; 14px to facts and buttons; the head's label beside its back button", async ({ app: { page } }) => {
  await openApp(page);
  await page.locator(`#suiteList .list-row[data-file="${SUITE}"] .list-open`).first().click();
  const gap = async (upper, lower) => { const [a, b] = [await box(upper), await box(lower)]; return Math.round(b.y - (a.y + a.height)); };
  expect(await gap(page.locator("#panel .field-head", { hasText: "Name (in reports)" }), page.locator("#suiteName"))).toBe(6);
  // (the provider's Fixtures field between: a field as any other, 18px under the one before)
  expect(await gap(page.locator("#suiteProvider").locator(".."), page.locator("#suiteProviderFixturesEdit").locator(".."))).toBe(18);
  expect(await gap(page.locator("#suiteProviderFixturesEdit").locator(".."), page.locator("#suiteProviderFixturesNone"))).toBe(6);
  expect(await gap(page.locator("#suiteProviderFixturesNone"), page.locator("#suiteGroup").locator("../.."))).toBe(14);
  expect(await gap(page.locator("label[for=suiteGroup]"), page.locator("#suiteGroup"))).toBe(6);
  expect(await gap(page.locator("#suiteGroupHint"), page.locator("#suiteFacts"))).toBe(14);
  expect(await gap(page.locator("#suiteFacts"), page.locator("#suiteRun").locator(".."))).toBe(14);
  expect(await gap(page.locator("#suiteName"), page.locator("#panel .field-head", { hasText: "File name" }))).toBe(18);
  // A test's Runs: the label, then its fields' own labels, 6px apart
  await openTest(page, "refund for a broken item");
  expect(await gap(page.locator("#panel .field-head", { hasText: /^Runs$/ }), page.locator("label[for=testRepeat]"))).toBe(6);
  expect(await gap(page.locator("label[for=testRepeat]"), page.locator("#testRepeat"))).toBe(6);
  expect(await gap(page.locator("#testGroupHint"), page.locator("#panel .field-head", { hasText: /^History$/ }))).toBe(18);
  const [back, label] = [await box(page.locator("#panelBack")), await box(page.locator("#panel .panel-head > .block-label"))];
  expect(label.x - (back.x + back.width)).toBeLessThan(12);
  // A panel that starts with facts: from the top of its body as any other
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  await page.locator("#runList .list-open").first().click();
  const [body, facts] = [await box(page.locator("#panel .panel-body")), await box(page.locator("#runFacts"))];
  expect(Math.round(facts.y - body.y)).toBe(12);
});

test("an empty timeline is as tall as its note (and isn't resized); with steps, as tall as it's set (a fifth of the window by default)", async ({ app: { page } }) => {
  await openApp(page);
  const body = page.locator("#timelineBody");
  await expect(page.locator("#timelineEmpty")).toBeVisible();
  expect((await box(body)).height).toBeLessThan(60);
  await expect(page.locator("#timelineResizer")).toBeHidden();
  await expect(page.locator("#timelineFit")).toHaveCount(0);
  await runSmoke(page);
  await expect(page.locator("#timelineFit")).toBeVisible();
  expect(Math.round((await box(body)).height)).toBe(180);
  expect(await page.locator("#timelineResizer").evaluate((el) => getComputedStyle(el).display)).not.toBe("none");
});

test("the sidebar's checks are grouped: response, metrics, thinking and tools, System One, LLM judges", async ({ app: { page } }) => {
  await openApp(page);
  await page.click("#checksToggle");
  expect(await page.locator(".palette-heading").allTextContents()).toEqual(["Response", "Metrics", "Thinking and tools", "System One", "LLM judges"]);
  const ids = async (group) => page.locator(`#palette-group-${group} .palette-item`).evaluateAll((els) => els.map((e) => e.id.replace("palette-", "")));
  expect(await ids("response")).toEqual(["path", "text", "status", "json"]);
  expect(await ids("metrics")).toEqual(["latency", "length", "tokens", "cost"]);
  expect(await ids("behaviour")).toEqual(["thinking", "tool-called", "tool-not-called", "tool-order", "sequence"]);
  expect(await ids("systemone")).toEqual(["system-one-noul", "system-one-choice", "system-one-score"]);
  expect(await ids("llm")).toEqual(["judge", "reference"]);
  await expect(page.locator("#palette-system-one-noul .label")).toHaveText("Noul");
  // A card adds its check to the selected turn; on the turn's card it's named in full
  await openTest(page, "refund for a broken item");
  await page.locator("#turn-1 .turn-head .label").click();
  await page.click("#palette-system-one-noul");
  await fileSays(page, (d) => d.tests[0].turns[1].expect[1]?.type === "systemone.noul");
  await page.locator("#panelBack").click();
  await expect(page.locator("#turnCheck-1 .block-label .label")).toHaveText("System One · noul");
  await page.click("#palette-tool-not-called");
  await fileSays(page, (d) => d.tests[0].turns[1].expect[2]?.type === "tool.not_called");
});

test.describe("with nothing in the app yet", () => {
  test.use({ workspace: {} });

  test("placeholders sit in the middle of what holds them: the sidebar's sections, the thread, a panel, Settings", async ({ app: { page, servers } }) => {
    const centred = async (sel, holder) => page.evaluate(([sel, holder]) => {
      const el = document.querySelector(sel);
      const h = el.closest(holder);
      const [a, b] = [el.getBoundingClientRect(), h.getBoundingClientRect()];
      const cs = getComputedStyle(h);
      const top = a.top - b.top - parseFloat(cs.paddingTop);
      const bottom = b.bottom - parseFloat(cs.paddingBottom) - a.bottom;
      return { align: getComputedStyle(el).textAlign, off: Math.abs(top - bottom) };
    }, [sel, holder]);
    for (const [sel, holder] of [["#conversationsEmpty", "#conversationsBody"], ["#runsEmpty", "#runsBody"], ["#suitesEmpty", "#suitesBody"], ["#threadEmpty", "#scroller"]]) {
      const { align, off } = await centred(sel, holder);
      expect(align, sel).toBe("center");
      expect(off, sel).toBeLessThan(4);
    }
    await writeFiles(page, await fixtureFiles(servers.mock.url));
    await openApp(page);
    await openTest(page, "refund for a broken item");
    await page.locator("#turn-0 .turn-head .label").click();
    expect(await page.locator("#turnNotRun").evaluate((el) => getComputedStyle(el).textAlign)).toBe("center");
    await page.click("#openSettings");
    await page.click("#settings-tab-runs");
    expect(await page.locator("#settingsEmpty").evaluate((el) => getComputedStyle(el).textAlign)).toBe("center");
  });
});
