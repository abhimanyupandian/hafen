// Settings: its groups and head, the theme (Appearance, and the system's until one is chosen), the
// relay, System One's key, and an editor opened from it going back to it.

import { expect, newScope, openYaml, reopen, test } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";

test("the theme switches to dark from Settings", async ({ app: { page } }) => {
  await page.click("#openSettings");
  await page.click("#settings-tab-appearance");
  await page.click("#themeDark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.click("#themeLight");
});

test("Connection → System One keeps JEV_API_KEY, for every environment", async ({ app: { page } }) => {
  await page.click("#openSettings");
  const tabs = await page.locator("[aria-label=Connection] .settings-tab").allTextContents();
  expect(tabs).toEqual(["Providers", "System One", "Relay"]);
  expect(await page.locator("[aria-label=Configurations] .settings-tab").allTextContents()).toEqual(["Environments", "Secrets", "Plugins"]);
  await page.click("#settings-tab-systemone");
  await expect(page.locator("#systemoneKeyState")).toHaveText("not set");
  await page.fill("#systemoneKey", "jev-test-key");
  await page.click("#systemoneSave");
  await expect(page.locator("#systemoneKeyState")).toHaveText("set");
  await expect(page.locator("#systemoneKey")).toHaveValue("");
  // It's kept for every environment, and Secrets leaves it to this pane
  await page.click("#settings-tab-secrets");
  await expect(page.locator("#secretName")).toBeVisible();
  await expect(page.locator("#secret-JEV_API_KEY")).toHaveCount(0);
  await page.fill("#secretName", "JEV_API_KEY");
  await page.fill("#secretValue", "x");
  await page.press("#secretValue", "Enter");
  await expect(page.locator("#secretsError")).toContainText("System One");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("eval.secrets"))[""].JEV_API_KEY)).toBe("jev-test-key");
  await page.click("#settings-tab-systemone");
  // (forgetting asks first)
  await page.click("#systemoneForget");
  await expect(page.locator("#systemoneKeyState")).toHaveText("set");
  await page.click("#systemoneForget");
  await expect(page.locator("#systemoneKeyState")).toHaveText("not set");
});

test.describe("Settings → Relay", () => {
  test.beforeEach(async ({ app: { page } }) => {
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  });
  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
  });

  test("Settings → Relay (the browser build): the relay's address, and that it answers with the endpoints it allows", async ({ app: { page, servers, errors } }) => {
    await page.click("#openSettings");
    await page.click("#settings-tab-relay");
    await expect(page.locator("#relayAddress")).toHaveValue(servers.url.replace(/\/$/, ""));
    await expect(page.locator(".server-status.ok")).toHaveText("The relay answers, allowing 1 endpoint prefix.");
    // An address with no relay: said so, and how to start one
    await page.fill("#relayAddress", "http://127.0.0.1:59998");
    await page.locator("#relayAddress").press("Enter");
    await expect(page.locator(".server-status.error")).toHaveText("No relay answers there. Start one in Hafen's folder: npm run serve -- --allow-endpoint <url>");
    // (the browser logs the refused connection itself: that's the one error expected here)
    for (let i = errors.length - 1; i >= 0; i--) if (/Failed to load resource: net::ERR_CONNECTION_REFUSED/.test(errors[i])) errors.splice(i, 1);
  });
});

test.describe("its groups, its head, Appearance, and the editors it opens", () => {
  const openApp = async (page) => {
    await reopen(page);
    await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
  };
  const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
  async function runSmoke(page) {
    await openTest(page, "refund for a broken item");
    await page.click("#testRun");
    await expect(page.locator("#status")).toContainText("failed 0/1");
  }
  const box = (page, sel) => page.locator(sel).evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });

  test.afterEach(async ({ app: { errors } }) => {
    expect(errors).toEqual([]);
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

  test("Settings: its head stays at the top as the content scrolls, so the close button never floats over a field", async ({ app: { page } }) => {
    await openApp(page);
    await page.click("#openSettings");
    await page.click("#settings-tab-providers");
    await page.click("#provider-mock-json-open");
    await openYaml(page);
    await page.locator("#settingsContent").evaluate((el) => { el.scrollTop = 400; });
    const content = await box(page, "#settingsContent");
    const head = await box(page, ".settings-content-head");
    expect(Math.abs(head.top - content.top)).toBeLessThan(2);
    const close = await box(page, "#settingsClose");
    expect(close.bottom).toBeLessThanOrEqual(head.bottom + 1);
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("#settingsClose")?.id, [close.left + close.width / 2, close.top + close.height / 2]);
    expect(hit).toBe("settingsClose");
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

  test("Appearance: Light, System and Dark side by side, the one chosen pressed; each applies its theme, System follows the system's", async ({ app: { page } }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.click("#openSettings");
    await page.click("#settings-tab-appearance");
    const group = page.locator("#themeChoice");
    await expect(group).toHaveAttribute("role", "radiogroup");
    await expect(group).toHaveAttribute("aria-labelledby", "themeLabel");
    await expect(page.locator("#themeLabel")).toHaveText("Theme");
    await expect(group.locator("button")).toHaveText(["Light", "System", "Dark"]);
    await expect(group.getByRole("radio")).toHaveCount(3);
    // (the one chosen pressed, the others not)
    const checked = async (id) => {
      for (const other of ["themeLight", "themeSystem", "themeDark"]) await expect(page.locator(`#${other}`)).toHaveAttribute("aria-checked", String(other === id));
    };
    // Nothing chosen yet: the system's
    await checked("themeSystem");
    await expect(page.locator("#themeSystem")).toHaveCSS("background-color", await page.evaluate(() => getComputedStyle(document.body).color));
    await expect(page.locator("#themeSystem")).toHaveAttribute("tabindex", "0");
    await expect(page.locator("#themeDark")).toHaveAttribute("tabindex", "-1");
    // Each applies its theme, and is kept
    await page.click("#themeDark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await checked("themeDark");
    expect(await page.evaluate(() => localStorage.getItem("eval.theme"))).toBe("dark");
    await page.click("#themeLight");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await checked("themeLight");
    expect(await page.evaluate(() => localStorage.getItem("eval.theme"))).toBe("light");
    // (Light stays light when the system goes dark)
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    // System: the system's, following it as it changes
    await page.click("#themeSystem");
    await checked("themeSystem");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("eval.theme"))).toBe("system");
    // Keys, as a radio group's: the arrows choose the next (round), Home and End the ends
    await page.locator("#themeSystem").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#themeDark")).toBeFocused();
    await expect(page.locator("#themeDark")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#themeLight")).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.keyboard.press("End");
    await expect(page.locator("#themeDark")).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Home");
    await expect(page.locator("#themeLight")).toHaveAttribute("aria-checked", "true");
    // Kept after a reload
    await reopen(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.click("#openSettings");
    await page.click("#settings-tab-appearance");
    await expect(page.locator("#themeLight")).toHaveAttribute("aria-checked", "true");
  });

  test.describe("with the system dark", () => {
    test.use({ colorScheme: "dark" });
    test("a first visit follows the system; a choice of Light or Dark is kept", async ({ app: { page } }) => {
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await page.click("#openSettings");
      await page.click("#settings-tab-appearance");
      await expect(page.locator("#themeSystem")).toHaveAttribute("aria-checked", "true");
      await page.click("#themeLight");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await page.reload();
      await page.locator("html:not(.loading)").waitFor();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    });
  });
});
