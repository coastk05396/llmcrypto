/// <reference lib="dom" />
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Request } from "@playwright/test";
import { makeZip } from "../unit/zip-fixture";
import { VIEWPORTS, apiUnreachable, noHorizontalOverflow } from "./helpers";

const CSV = [
  "model,input_tokens,output_tokens,cached_tokens,cost_usd,secret_note",
  "alpha-large,184000,10200,40000,0.60,keep-local",
  "unlisted-model,10,10,0,0.01,x",
  ",5,5,0,0,x",
  'alpha-large,abc,5,0,0,x',
].join("\n");

async function importFile(page: Page, name: string, buffer: Buffer) {
  await page.getByLabel("Usage export file").setInputFiles({ name, mimeType: "application/octet-stream", buffer });
}

test.beforeEach(async ({ page }) => {
  await apiUnreachable(page);
  await page.goto("/diag");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("sample report is clearly labelled as a sample", async ({ page }) => {
  await page.getByRole("button", { name: "Show sample report" }).click();
  await expect(page.getByRole("heading", { name: /Report: Sample usage export/ })).toBeFocused();
  await expect(page.getByText("Sample report - not your data")).toBeVisible();
  await expect(page.getByText("Sample prices").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Unmatched models" })).toBeVisible();
  await expect(page.locator("main")).toContainText("unlisted-model-x");
});

test("imports CSV locally: exact arithmetic, unmatched, excluded rows and unknown columns", async ({ page }) => {
  await importFile(page, "usage.csv", Buffer.from(CSV));
  await expect(page.getByRole("heading", { name: "Report: usage.csv" })).toBeVisible();
  const matched = page.getByRole("region", { name: "Matched models table", exact: true });
  // 184000 in * $3 + 10200 out * $15 + 40000 cached * $0.30 = 0.552 + 0.153 + 0.012
  await expect(matched).toContainText("0.717000");
  await expect(matched).toContainText("0.600000");
  await expect(page.getByRole("region", { name: "Unmatched models table", exact: true })).toContainText("unlisted-model");
  await expect(page.getByRole("region", { name: "Excluded rows table" })).toContainText("No model value");
  await expect(page.locator("main")).toContainText("secret_note");
  await expect(page.locator("main")).toContainText("0.117000 USD, snapshot estimate is higher");
  await expect(page.locator("main")).toContainText("not a promise of savings");
  await expect(page.getByText("Sample report - not your data")).toHaveCount(0);
  await expect(page.getByText("Sample prices").first()).toBeVisible(); // API is down, so prices are the bundled sample
});

test("rejects oversize, unsupported, hostile and malformed input with a clear message", async ({ page }) => {
  await importFile(page, "big.csv", Buffer.alloc(25 * 1024 * 1024 + 1, 0x61));
  await expect(page.getByRole("alert")).toContainText("limit is 25 MB");

  await importFile(page, "notes.txt", Buffer.from("hello"));
  await expect(page.getByRole("alert")).toContainText("Use a .zip, .csv, .json or .jsonl file");

  const bomb = makeZip([{ name: "bomb.csv", data: new Uint8Array(80 * 1024 * 1024) }]);
  expect(bomb.length).toBeLessThan(1024 * 1024);
  await importFile(page, "bomb.zip", Buffer.from(bomb));
  await expect(page.getByRole("alert")).toContainText("would expand");

  const lying = makeZip([{ name: "lie.csv", data: new Uint8Array(4 * 1024 * 1024), declaredSize: 50 }]);
  await importFile(page, "lie.zip", Buffer.from(lying));
  await expect(page.getByRole("alert")).toContainText("expands beyond");

  const many = makeZip(Array.from({ length: 101 }, (_, i) => ({ name: `f${i}.csv`, data: "model,input_tokens,output_tokens\n" })));
  await importFile(page, "many.zip", Buffer.from(many));
  await expect(page.getByRole("alert")).toContainText("101 entries");

  await importFile(page, "bad.json", Buffer.from("{oops"));
  await expect(page.getByRole("alert")).toContainText("not valid JSON");
});

test("reads a ZIP of several files and ignores path-traversal entries", async ({ page }) => {
  const zip = makeZip([
    { name: "a.csv", data: "model,input_tokens,output_tokens\nalpha-small,1000000,0\n" },
    { name: "../evil.csv", data: "model,input_tokens,output_tokens\nalpha-small,1,1\n" },
  ]);
  await importFile(page, "export.zip", Buffer.from(zip));
  await expect(page.getByRole("heading", { name: "Report: export.zip" })).toBeVisible();
  await expect(page.locator("main")).toContainText("unsafe path, ignored");
  await expect(page.getByRole("region", { name: "Matched models table", exact: true })).toContainText("0.250000");
});

test("no upload: importing makes no network request carrying the file and no non-GET or cross-origin request", async ({ page }) => {
  const seen: Request[] = [];
  page.on("request", (r) => seen.push(r));
  page.on("websocket", () => { throw new Error("websocket opened"); });
  await importFile(page, "usage.csv", Buffer.from(CSV));
  await expect(page.getByRole("heading", { name: "Report: usage.csv" })).toBeVisible();
  await page.getByRole("button", { name: "Show sample report" }).click();
  await expect(page.getByText("Sample report - not your data")).toBeVisible();
  const origin = new URL(page.url()).origin;
  for (const r of seen) {
    expect(r.method(), r.url()).toBe("GET");
    expect(r.postData(), r.url()).toBeNull();
    expect(new URL(r.url()).origin === origin || r.url().startsWith("blob:") || r.url().startsWith("data:"), `cross-origin ${r.url()}`).toBe(true);
    expect(["fetch", "xhr", "websocket", "ping", "beacon"], `${r.resourceType()} ${r.url()}`).not.toContain(r.resourceType());
  }
});

test("downloads JSON and a formula-injection-safe CSV", async ({ page }) => {
  const hostile = 'model,input_tokens,output_tokens\n"=HYPERLINK(""http://evil.example"")",1,1\n"@SUM(1)",1,1\nalpha-small,1,1\n';
  await importFile(page, "hostile.csv", Buffer.from(hostile));
  await expect(page.getByRole("heading", { name: "Report: hostile.csv" })).toBeVisible();

  const [csvDl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Download model table/ }).click()]);
  const csv = await (await import("node:fs/promises")).readFile(await csvDl.path(), "utf8");
  expect(csvDl.suggestedFilename()).toBe("usage-models.csv");
  expect(csv).toContain("'=HYPERLINK");
  expect(csv).toContain("'@SUM(1)");
  expect(csv).not.toMatch(/(^|,|\r\n)"?[=@]/);

  const [jsonDl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Download report \(JSON\)/ }).click()]);
  const json = JSON.parse(await (await import("node:fs/promises")).readFile(await jsonDl.path(), "utf8")) as { sample: boolean; unmatched: { model: string }[] };
  expect(json.sample).toBe(false);
  expect(json.unmatched.map((u) => u.model)).toContain("=HYPERLINK(\"http://evil.example\")");
});

test("sample downloads are named as samples", async ({ page }) => {
  await page.getByRole("button", { name: "Show sample report" }).click();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Download report \(JSON\)/ }).click()]);
  expect(dl.suggestedFilename()).toBe("sample-usage-report.json");
});

test("print layout hides site chrome and keeps the sample label", async ({ page }) => {
  await page.getByRole("button", { name: "Show sample report" }).click();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("header")).toBeHidden();
  await expect(page.locator("footer")).toBeHidden();
  await expect(page.getByRole("button", { name: "Print" })).toBeHidden();
  await expect(page.getByText("Sample report - not your data")).toBeVisible();
});

test("keyboard only: tab to sample button, activate, focus lands on report", async ({ page }) => {
  const sample = page.getByRole("button", { name: "Show sample report" });
  await page.getByLabel("Usage export file").focus();
  await page.keyboard.press("Tab");
  await expect(sample).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: /Report:/ })).toBeFocused();
});

for (const vp of VIEWPORTS) {
  for (const scheme of ["light", "dark"] as const) {
    test(`${vp.name} ${scheme}: sample report has no overflow and no axe violations`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme });
      const page = await ctx.newPage();
      await apiUnreachable(page);
      await page.goto("/diag");
      await page.getByRole("button", { name: "Show sample report" }).click();
      await expect(page.getByText("Sample report - not your data")).toBeVisible();
      const { scrollWidth, clientWidth } = await noHorizontalOverflow(page);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
      await ctx.close();
    });
  }
}
