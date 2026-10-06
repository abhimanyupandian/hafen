// System One's request during a run (contracts/ui.md, Panel: Step, Check): the judge call's step and a
// System One check's panel show the request it sends, all of it (the address, the headers, the body:
// the state, the model, the questions), its key hidden; while it's being asked, and after.

import { expect, fileText, test } from "./fixtures.js";

const writeFile = (page, path, text) => page.evaluate(async ([path, text]) => {
  const parts = path.split("/");
  let dir = await navigator.storage.getDirectory();
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(text);
  await w.close();
}, [path, text]);
const KEY = "jev-test-key-123456";
// A suite whose one turn has two System One checks, judged at `endpoint`
const suite = (base, endpoint) => `version: 1
provider: providers/mock-json.yml
environments:
  local: { base_url: "${base}" }
judges:
  default: { kind: systemone, endpoint: "${endpoint}" }
tests:
  - name: judged
    turns:
      - user: a refund for 4417
        expect:
          - { type: systemone.noul, question: "Does the reply ask why?", min: 0.8 }
          - { type: systemone.choice, question: "What does it offer?", options: [refund, replacement], equals: refund }
`;

test.beforeEach(async ({ app: { page } }) => {
  await page.evaluate((key) => localStorage.setItem("eval.secrets", JSON.stringify({ "": { JEV_API_KEY: key } })), KEY);
});
test.afterEach(async ({ app: { errors } }) => {
  expect(errors).toEqual([]);
});

test("after a run: the judge call's step and each System One check show the request, all of it, the key hidden", async ({ app: { page, servers } }) => {
  await writeFile(page, "judged.hafen.yml", suite(servers.mock.url, "{{base_url}}/systemone"));
  await page.click("#openFolder");
  await page.locator("#suiteList .list-row[id^='test-'] .list-open", { hasText: "judged" }).first().click();
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("passed 1/1");
  // The check's panel
  await page.locator("#turn-0 .turn-head .label").click();
  await page.locator("#turnCheck-0-open").click();
  await expect(page.locator("#checkJudgeRequestLabel")).toHaveText("Request to System One");
  await expect(page.locator("#checkJudgeRequestUrl")).toHaveText(`POST ${servers.mock.url}/systemone/v1/systemone`);
  const body = JSON.parse(await page.locator("#checkJudgeRequest").textContent());
  expect(body.state).toBe("I'm sorry it arrived broken. Could you tell me why you want a refund for order 4417?");
  expect(body.model).toBe("jev-latest");
  expect(body.questions).toEqual({ c0: { type: "noul", instructions: "Does the reply ask why?" }, c1: { type: "choice", instructions: "What does it offer?", criteria: { refund: "refund", replacement: "replacement" } } });
  await expect(page.locator("#checkJudgeRequestHeaders")).toContainText("authorization");
  await expect(page.locator("#checkJudgeRequestHeaders")).toContainText("[redacted]");
  await expect(page.locator("#checkJudgeRequestAsking")).toHaveCount(0);
  // The other check, judged in the same request, shows the same
  await page.click("#panelBack");
  await page.locator("#turnCheck-1-open").click();
  expect(JSON.parse(await page.locator("#checkJudgeRequest").textContent())).toEqual(body);
  // Copied, all of it
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.click("#checkJudgeRequestCopy");
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(body);
  // The judge call's step
  await page.locator(".timeline-bar[data-kind='judge_call']").first().click();
  await expect(page.locator("#panel .panel-head")).toContainText("Step");
  expect(JSON.parse(await page.locator("#stepJudgeRequest").textContent())).toEqual(body);
  // The key is nowhere on the page, nor in the run kept
  expect(await page.content()).not.toContain(KEY);
  const runs = await page.evaluate(async () => {
    const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const db = await done(indexedDB.open("hafen"));
    const all = await done(db.transaction("runs").objectStore("runs").getAll());
    db.close();
    return JSON.stringify(all);
  });
  expect(runs).not.toContain(KEY);
  expect(runs).toContain('"questions"');
});

test("during a run: the request shows as it's asked (asking…), on the check's panel and the call's step", async ({ app: { page, servers } }) => {
  // A judge that takes 2 s to answer (the mock's slow reply: not System One's, so it errors after)
  await writeFile(page, "judged.hafen.yml", suite(servers.mock.url, "{{base_url}}/slow?ms=2000&to="));
  await page.click("#openFolder");
  await page.locator("#suiteList .list-row[id^='test-'] .list-open", { hasText: "judged" }).first().click();
  await page.click("#testRun");
  await page.locator("#turn-0 .turn-head .label").click();
  await page.locator("#turnCheck-0-open").click();
  await expect(page.locator("#checkJudgeRequestAsking")).toBeVisible();
  await expect(page.locator("#checkNotRun")).toHaveText("Judging…");
  const body = JSON.parse(await page.locator("#checkJudgeRequest").textContent());
  expect(body.questions.c0).toEqual({ type: "noul", instructions: "Does the reply ask why?" });
  expect(body.state).toContain("4417");
  // The call's step, still going
  await page.locator(".timeline-bar[data-kind='judge_call']").first().click();
  await expect(page.locator("#stepJudgeRequestAsking")).toBeVisible();
  // Then it's done (System One's answer wasn't one here): the request stays, no longer being asked
  await expect(page.locator("#status")).toContainText(/failed|error/, { timeout: 8000 });
  await expect(page.locator("#stepJudgeRequestAsking")).toHaveCount(0);
  await expect(page.locator("#stepJudgeRequest")).toBeVisible();
});
