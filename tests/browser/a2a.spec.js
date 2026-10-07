// An A2A agent (kind: a2a) in the app: made in Settings → Providers from its address (its agent card
// says the rest), then talked to: the agent's progress as thinking, its question, and the same task
// carried on to its answer. Against the mock's agent (packages/hafen/tests/fixtures/mock-endpoint.mjs, /a2a).

import { expect, fileText, test } from "./fixtures.js";

test.afterEach(async ({ app: { errors } }) => {
  expect(errors).toEqual([]);
});

test("an A2A agent from its address: a conversation that carries one task from input-required to completed", async ({ app: { page, servers } }) => {
  await page.click("#openFolder");
  await page.click("#openSettings");
  await page.click("#settings-tab-providers");
  await page.click("#newProvider");
  await page.selectOption("#newProviderKind", "a2a");
  await expect(page.locator("#newProviderName")).toHaveValue("a2a");
  await expect(page.locator("#newProviderAbout")).toContainText("A2A protocol");
  await page.fill("#newProviderUrl", `${servers.mock.url}/a2a`);
  await page.click("#newProviderCreate");
  await expect.poll(() => fileText(page, "providers/a2a.yml")).toContain(`kind: a2a\ncard: ${servers.mock.url}/a2a`);
  await page.click("#settingsClose");
  await page.selectOption("#convProvider", "providers/a2a.yml");
  await page.fill("#input", "I'd like a refund for order 4417");
  await page.press("#input", "Enter");
  await expect(page.locator("#turn-0-reply .msg-body")).toHaveText("Could you tell me why you want a refund for order 4417?");
  await expect(page.locator("#turn-0-reply")).toContainText("thinking");
  await page.fill("#input", "It arrived broken");
  await page.press("#input", "Enter");
  await expect(page.locator("#turn-1-reply .msg-body")).toHaveText("I've started a refund for order 4417.");
  const log = await (await fetch(`${servers.mock.url}/_log`)).json();
  const sent = log.filter((x) => x.path === "/a2a/v1");
  expect(sent.map((x) => x.body.method)).toEqual(["SendStreamingMessage", "SendStreamingMessage"]);
  expect(sent[1].body.params.message.taskId).toBeTruthy();
});
