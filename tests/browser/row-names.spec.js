// A data row's name (contracts/test-file.md, data: row_name): the test panel's Row names field writes
// the test's row_name (empty removes it), shown once the test has a data file; after a run, each row is
// said by its name, as the reports say it (row 2: a refund please), in its turns' heads and in the
// panel's Showing list.

import { parse } from "yaml";
import { expect, fileText, reopen, test, writeFiles } from "./fixtures.js";

const SUITE = "smoke.hafen.yml";
const ROWS = "rows.hafen.yml";
const openTest = (page, name) => page.locator("#suiteList .list-open", { hasText: name }).first().click();
// Wait until the file says what `check` wants (it's written through the engine, a moment later)
const fileSays = (page, check, file = SUITE) => expect.poll(async () => { try { return check(parse(await fileText(page, file))); } catch { return false; } }, { timeout: 5000 }).toBe(true);

test.beforeEach(async ({ app: { page } }) => {
  await expect(page.locator(`#suiteList .list-row[data-file="${SUITE}"]`)).toHaveCount(1);
});
test.afterEach(async ({ app: { errors } }) => {
  expect(errors).toEqual([]);
});

test("Row names: shown with a data file; it writes row_name, and emptied, removes it", async ({ app: { page } }) => {
  await openTest(page, "refund for a broken item");
  await expect(page.locator("#testRowName")).toHaveCount(0);
  await page.fill("#testData", "data/rows.csv");
  await page.press("#testData", "Enter");
  await fileSays(page, (d) => d.tests[0].data === "data/rows.csv");
  await expect(page.locator("#testRowName")).toHaveAttribute("placeholder", "first column");
  await expect(page.locator("#testRowNameHint")).toContainText("its first column's value");
  await page.fill("#testRowName", "{{row.question}} ({{row.order}})");
  await page.press("#testRowName", "Enter");
  await fileSays(page, (d) => d.tests[0].row_name === "{{row.question}} ({{row.order}})");
  expect(await fileText(page, SUITE)).toContain('row_name: "{{row.question}} ({{row.order}})"');
  await page.fill("#testRowName", "");
  await page.press("#testRowName", "Enter");
  await fileSays(page, (d) => d.tests[0].row_name === undefined && d.tests[0].data === "data/rows.csv");
  await expect(page.locator("#testRowName")).toHaveValue("");
});

test("after a run, each row by its name: its turns' heads and the Showing list, by its first column or by row_name", async ({ app: { page, servers } }) => {
  await writeFiles(page, {
    "data/orders.csv": "question,order\na refund for 4417,4417\na refund please,9999\n",
    [ROWS]: `version: 1\nname: Rows\nprovider: providers/mock-json.yml\nenvironments:\n  local: { base_url: "${servers.mock.url}" }\ntests:\n  - name: orders\n    data: data/orders.csv\n    turns:\n      - user: "{{row.question}}"\n        expect:\n          - { path: $.data.order.id, equals: "{{row.order}}" }\n`,
  });
  await reopen(page);
  await openTest(page, "orders");
  await page.click("#testRun");
  await expect(page.locator("#status")).toContainText("failed 1/2");
  // The latest row, by its first column; the Showing list, the one that failed first
  await expect(page.locator("#turn-0 .turn-head .label")).toHaveText("turn 1 · row 2: a refund please");
  await expect(page.locator("#testInstance option")).toHaveText(["row 2: a refund please · failed", "row 1: a refund for 4417 · passed"]);
  await page.selectOption("#testInstance", "1|1");
  await expect(page.locator("#turn-0 .turn-head .label")).toHaveText("turn 1 · row 1: a refund for 4417");
  // Named by row_name, the next run
  await page.fill("#testRowName", "{{row.question}} ({{row.order}})");
  await page.press("#testRowName", "Enter");
  await fileSays(page, (d) => d.tests[0].row_name === "{{row.question}} ({{row.order}})", ROWS);
  await page.click("#testRun");
  await expect(page.locator("#testInstance option")).toHaveText(["row 2: a refund please (9999) · failed", "row 1: a refund for 4417 (4417) · passed"]);
  await expect(page.locator("#turn-0 .turn-head .label")).toHaveText("turn 1 · row 1: a refund for 4417 (4417)");
});
