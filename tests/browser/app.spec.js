// The app as a whole, in the browser build (the engine in the page's Web Worker): a test run end to
// end; the sidebar, the top bar and the panels going back; the console; its name, its address and a
// first start's first steps.

import { addScope, expect, fileText, pickFolder, reopen, test, writeFile } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";
const openApp = async (page) => {
  await reopen(page);
  await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
};
const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
// (a suite by its file, data-file; a test by its name)
const row = (page, text) => (/\.hafen\.(ya?ml|json)$/.test(text) ? page.locator(`#suiteList .list-row[data-file="${text}"]`) : page.locator("#suiteList .list-row", { hasText: text })).first();
const consoleText = (page) => page.locator("#log, .console-body").first().textContent();
async function runSmoke(page) {
  await openTest(page, "refund for a broken item");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
}

test("runs a test and shows each check's result under each reply", async ({ app: { page, errors } }) => {
  await expect(page.locator('#suiteList .list-row[data-file="smoke.hafen.yml"]')).toHaveCount(1);
  await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).click();
  await expect(page.locator("#evalTitle")).toHaveText("refund for a broken item");
  await expect(page.locator(".check-badge[data-status='']").first()).toBeVisible();
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed 0/1");
  await expect(page.locator("#turn-0-reply .check-badge[data-status='pass']")).toHaveCount(4);
  await expect(page.locator("#turn-1-reply .check-badge[data-status='fail']")).toHaveText("contains refund");
  await expect(page.locator("#runList")).toContainText("failed");
  await expect(page.locator("#testFacts")).toContainText("4/5");
  expect(errors).toEqual([]);
});

test("the top bar has no provider in it; the test panel's Provider opens it in Settings", async ({ app: { page } }) => {
  await page.locator("#suiteList .list-open", { hasText: "refund for a broken item" }).click();
  await expect(page.locator("#topbar .badge")).toHaveCount(0);
  await expect(page.locator("#currentProvider")).toHaveCount(0);
  await page.click("#testProviderManage");
  await expect(page.locator("#settingsTitle")).toHaveText("Providers");
});

test("collapsed, the sidebar shows its sections as icons; one opens it on that section", async ({ app: { page } }) => {
  await expect(page.locator("#navRail")).toBeHidden();
  await page.click("#collapseNav");
  await expect(page.locator("#navBody")).toBeHidden();
  await expect(page.locator("#navRail button")).toHaveCount(4);
  expect(await page.locator("#navRail button").evaluateAll((b) => b.map((x) => x.getAttribute("aria-label")))).toEqual(["Conversations", "Suites", "Checks", "Runs"]);
  await expect(page.locator("#rail-checks")).toBeVisible();
  await page.click("#rail-checks");
  await expect(page.locator("#navBody")).toBeVisible();
  await expect(page.locator("#navRail")).toBeHidden();
  await expect(page.locator("#checksToggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#checksToggle")).toBeFocused();
});

test.describe("the sidebar, the top bar and the console", () => {
  test.beforeEach(async ({ app: { page } }) => {
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  });
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("the sidebar's order, the panels' YAML buttons, the chat's labels and the message box", async ({ app: { page } }) => {
    const order = await page.locator("#navBody > section").evaluateAll((els) => els.map((e) => e.id));
    expect(order).toEqual(["conversationsSection", "suitesSection", "checksSection", "runsSection"]);
    await page.click("#collapseNav");
    expect(await page.locator("#navRail button").evaluateAll((b) => b.map((x) => x.getAttribute("aria-label")))).toEqual(["Conversations", "Suites", "Checks", "Runs"]);
    await expect(page.locator("#rail-runs svg path").first()).toHaveAttribute("d", /^M3\.6 10\.5/);
    await page.click("#rail-suites");
    // Explore: a generic message box
    await page.selectOption("#convProvider", "providers/mock-json.yml");
    await expect(page.locator("#input")).toHaveAttribute("placeholder", "Type a message");
    // A test: "user", at the right
    await openTest(page, "refund for a broken item");
    await expect(page.locator("#turn-0-user > .label")).toHaveCount(0);  // (no "user" label: the message speaks for itself)
    const box = await page.locator("#turn-1-user .msg-body").boundingBox();
    const article = await page.locator("#turn-1-user").boundingBox();
    expect(Math.abs(box.x + box.width - (article.x + article.width))).toBeLessThan(2);
    expect(box.x).toBeGreaterThan(article.x + 20);
    // The YAML buttons
    await expect(page.locator("#testYamlEdit")).toHaveText("Edit the suite as YAML");
    await row(page, SUITE).locator(".list-open").click();
    await expect(page.locator("#suiteYamlEdit")).toHaveText("Edit the file as YAML");
    await page.click("#suiteYamlEdit");
    await expect(page.locator("#editorText")).toHaveValue(await fileText(page, SUITE));
    await page.click("#editorCancel");
  });

  test("the sidebar: import and export all are words in Suites' head; a closed section shows its icon, an open one its arrow", async ({ app: { page } }) => {
    await expect(page.locator("#importSuites")).toHaveText("import");
    await expect(page.locator("#exportSuites")).toHaveText("export all");
    await expect(page.locator("#importSuites svg, #exportSuites svg")).toHaveCount(0);
    await expect(page.locator("#suitesMenu")).toHaveCount(0);
    // Checks starts closed: its icon; open: the arrow
    await expect(page.locator("#checksToggle .section-icon svg")).toHaveCount(1);
    await expect(page.locator("#checksToggle .chev")).toHaveCount(0);
    await page.click("#checksToggle");
    await expect(page.locator("#checksToggle .chev")).toHaveCount(1);
    await expect(page.locator("#checksToggle .section-icon")).toHaveCount(0);
    // The label doesn't move between the two
    const open = await page.locator("#checksLabel").boundingBox();
    await page.click("#checksToggle");
    const closed = await page.locator("#checksLabel").boundingBox();
    expect(Math.abs(open.x - closed.x)).toBeLessThan(1);
  });

  test("the top bar's icon says what's open; panels go back to what holds them", async ({ app: { page } }) => {
    await expect(page.locator("#evalIcon")).toHaveAttribute("data-mode", "explore");
    await row(page, SUITE).locator(".list-open").click();
    await expect(page.locator("#evalIcon")).toHaveAttribute("data-mode", "suite");
    await openTest(page, "refund for a broken item");
    await expect(page.locator("#evalIcon")).toHaveAttribute("data-mode", "test");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("failed 0/1");
    // A check → its turn → the test → the suite
    await page.locator("#turn-1-reply .check-badge").first().click();
    await expect(page.locator("#panel .panel-head")).toContainText("Check");
    await page.click("#panelBack");
    await expect(page.locator("#panel .panel-head")).toContainText("Turn 2");
    await page.click("#panelBack");
    await expect(page.locator("#panel .panel-head")).toContainText("Test");
    await page.click("#panelBack");
    await expect(page.locator("#panel .panel-head")).toContainText("Suite");
    // A step goes back to its turn
    await openTest(page, "refund for a broken item");
    await page.locator(".timeline-bar[data-kind='request']").first().click();
    await expect(page.locator("#panel .panel-head")).toContainText("Step");
    await page.click("#panelBack");
    await expect(page.locator("#panel .panel-head")).toContainText("Turn 1");
    // A run's
    await page.locator("#runList .list-open").first().click();
    await expect(page.locator("#evalIcon")).toHaveAttribute("data-mode", "run");
  });

  test("the console is an audit log: engine calls, HTTP calls, settings and events — never a secret's value", async ({ app: { page } }) => {
    // An HTTP call with a key in its address
    const provider = `kind: http\nurl: "{{base_url}}/json?api_key=SECRET123&lang=en"\nbody: { message: "{{user}}" }\nresponse: { text: $.data.reply }\n`;
    await writeFile(page, "providers/mock-json.yml", provider);
    await page.selectOption("#convProvider", "providers/mock-json.yml");
    await page.fill("#input", "hello");
    await page.click("#send");
    await expect(page.locator("#send")).toHaveText(/send/i);
    // An edit, a run, a setting, a secret
    await openTest(page, "refund for a broken item");
    await page.fill("#testName", "renamed for the log");
    await page.press("#testName", "Enter");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText(/failed|passed/);
    await addScope(page, "local");
    await page.click("#openSettings");
    await page.click("#settings-tab-secrets");
    await page.fill("#secretName", "SHOP_TOKEN");
    await page.fill("#secretValue", "VALUE-NOT-LOGGED");
    await page.press("#secretValue", "Enter");
    await expect(page.locator("#secret-SHOP_TOKEN")).toBeVisible();
    await page.click("#settingsClose");
    const text = await consoleText(page);
    for (const line of [
      /engine\.open .*found="1 suites, 2 providers".* ok/,
      /config\.provider .*provider=providers\/mock-json\.yml/,
      /engine\.send .*provider=providers\/mock-json\.yml.* ok/,
      /http\.request .*method=POST url=http:\/\/127\.0\.0\.1:\d+\/json\?api_key=\*\*\*&lang=en .*200/,
      /conversation\.turn .*turn=1/,
      /engine\.edit .*file=smoke\.hafen\.yml op=set:tests\.0\.name.* ok/,
      /run\.start .*file=smoke\.hafen\.yml/,
      /run\.turn .*turn=2/,
      /run\.test .*test="renamed for the log"/,
      /engine\.run .*result="failed 0\/1"/,
      // (Secrets opens on the scope chosen)
      /config\.secret .*name=SHOP_TOKEN env=local action=set/,
    ]) expect(text).toMatch(line);
    expect(text).not.toContain("SECRET123");
    expect(text).not.toContain("VALUE-NOT-LOGGED");
  });
});

test.describe("its name, its address and its first steps", () => {
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
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

  test("Settings' button is a gear (the same icon as the rail's), and opens Settings", async ({ app: { page } }) => {
    const gear = page.locator("#openSettings svg.icon-settings");
    await expect(gear).toHaveCount(1);
    // A gear: one outline with eight teeth (32 corners) around a hub, not the old sliders
    const d = await gear.locator("path").getAttribute("d");
    expect(d.match(/[LHV]/g).length).toBe(31);
    await expect(gear.locator("circle")).toHaveCount(1);
    await page.click("#openSettings");
    await expect(page.locator("#settingsModal")).toBeVisible();
  });

  test("Back to the plain address goes to the conversation", async ({ app: { page } }) => {
    await openApp(page);
    await openTest(page, "refund for a broken item");
    await expect(page).toHaveURL(/tab=suites/);
    await page.goBack();
    await expect(page).not.toHaveURL(/tab=/);
    await expect(page.locator("#evalTitle")).toHaveText("New conversation");
    await expect(page.locator("#panel .panel-head")).toContainText("Conversation");
  });

  test.describe("a first start, nothing in the app yet", () => {
    test.use({ workspace: {} });

    test("the thread's note has the first steps as buttons, adding a provider the primary; Suites' note offers Import; nothing asks for a folder", async ({ app: { page } }) => {
      await expect(page.locator("#threadAddProvider")).toHaveText("Add a provider");
      await expect(page.locator("#threadAddProvider")).toHaveClass(/btn-primary/);
      await expect(page.locator("#threadNewConversation")).toHaveText("New conversation");
      await expect(page.locator("#threadNewSuite")).toHaveText("New suite");
      await expect(page.locator("#suitesImport")).toHaveText("import some");
      await expect(page.locator("#convProviders")).toHaveText("add one");
      await expect(page.locator("body")).not.toContainText(/open a folder|open files/i);
      // The panel's add one: Settings → Providers' new provider, a form that's saved at once
      await page.click("#convProviders");
      await expect(page.locator("#newProviderForm")).toBeVisible();
      await page.click("#newProviderCreate");
      await expect(page.locator("#providerYaml")).toHaveValue(/kind: ollama/);
      await page.click("#settingsClose");
      // A provider there: adding one isn't the primary any more
      await expect(page.locator("#threadAddProvider")).not.toHaveClass(/btn-primary/);
      await expect(page.locator("#convProviders")).toHaveText("manage");
    });
  });
});
