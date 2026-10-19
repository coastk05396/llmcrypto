/// <reference lib="dom" />
/** Real console API and workers, explicit FakeProvider; no model or chain network calls. */
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { apiCall, apiGet, fundedAccount, uniqName, useSession } from "./api-helpers";
import { noHorizontalOverflow, seedTheme } from "./helpers";

function archive(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text); const header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124); header.write("00000000000\0", 136); header.fill(32, 148, 156);
    header.write("0", 156); header.write("ustar\0", 257); header.write("00", 263);
    const sum = header.reduce((n, b) => n + b, 0); header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

for (const theme of ["light", "dark"] as const) {
  test(`repository evidence, export and deletion; ${theme} mobile`, async ({ page, context }) => {
    test.skip(process.env["E2E_BETA_FLAGS"] === "false", "enabled beta workflow");
    await page.setViewportSize({ width: 390, height: 844 }); await seedTheme(page, theme);
    const { session } = await fundedAccount(); await useSession(context, session);
    const p = await apiCall(session, "POST", "/api/projects", { name: uniqName("repo") }); expect(p.status).toBe(201);
    await page.goto(`/app/repository?project=${p.json["id"]}`);
    await page.getByLabel("Repository archive").setInputFiles({ name: "example.tar.gz", mimeType: "application/gzip", buffer: archive({ "src/app.ts": 'import { helper } from "../lib/helper";\n', "lib/helper.ts": "export const helper = 1;\n", ".env": "SECRET=excluded\n" }) });
    await page.getByRole("checkbox", { name: /authorized to upload/ }).check();
    const accepted = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("repository-imports"));
    await page.getByRole("button", { name: "Upload archive" }).click(); const response = await accepted; expect(response.status()).toBe(202);
    const id = (await response.json()).importId as string;
    await expect(page.getByRole("heading", { name: "Architecture rollup" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('import { helper } from "../lib/helper";', { exact: true })).toBeVisible();
    const connections = page.getByRole("table", { name: "Graph connections" });
    await expect(connections).toContainText("src/app.ts:1");
    // evidence is a real table: file:line and the exact source line
    const evidence = page.getByRole("table", { name: "Import evidence" });
    await expect(evidence.getByRole("row", { name: /src\/app\.ts:1/ })).toContainText('import { helper } from "../lib/helper";');
    await expect(evidence.getByRole("columnheader")).toHaveText(["Source (file:line)", "Imports", "Kind", "Source line"]);
    // the excluded secret file is not analyzed, so it is not among the files
    await expect(page.getByRole("table", { name: "Files" })).not.toContainText(".env");
    const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Export repository JSON" }).click(); const artifact = await download;
    const exported = JSON.parse(await readFile((await artifact.path())!, "utf8")); expect(exported.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ path: ".env" })]));
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    const widths = await noHorizontalOverflow(page); expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
    await page.getByRole("button", { name: "Delete import", exact: true }).click(); await page.getByRole("button", { name: "Confirm delete import" }).click();
    await expect(page.getByRole("heading", { name: "Architecture rollup" })).toHaveCount(0);
    expect((await apiCall(session, "GET", `/api/projects/${p.json["id"]}/repository-imports/${id}`)).status).toBe(404);
  });
}

test("Design brief, paid revision, export, malformed output and deletion", async ({ page, context }) => {
  test.skip(process.env["E2E_BETA_FLAGS"] === "false", "enabled beta workflow");
  const { session } = await fundedAccount(); await useSession(context, session);
  const p = await apiCall(session, "POST", "/api/projects", { name: uniqName("design") });
  await page.goto(`/app/design?project=${p.json["id"]}`);
  await page.getByLabel("Title", { exact: true }).fill("A reviewable proposal");
  await page.getByLabel("Design brief", { exact: true }).fill("Build a readable dashboard with <script>alert(1)</script> shown as text.");
  await page.getByRole("checkbox", { name: /consent to storing/ }).check();
  const accepted = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/designs"));
  await page.getByRole("button", { name: "Create paid proposal" }).click(); const response = await accepted; expect(response.status()).toBe(202); const id = (await response.json()).designId as string;
  await expect(page.getByTestId("design-document")).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("article", { name: "Revision 1" })).toContainText("Cost: charged");
  await expect(page.getByTestId("design-credit")).toContainText("Available credit:");
  // export is shown as TEXT: the markdown artifact is a text node, labelled, and nothing in it becomes an element
  await page.getByRole("button", { name: "View revision 1 export as text" }).click();
  const text = page.getByTestId("export-text");
  await expect(text).toContainText("AI-generated");
  expect(await text.locator("script, img, iframe, a").count()).toBe(0);
  expect(await page.locator("#main script").count()).toBe(0);
  await page.getByLabel("Revision instruction").fill("Make the hierarchy clearer and keep the content concise.");
  await page.getByRole("checkbox", { name: /authorize another paid/ }).check(); await page.getByRole("button", { name: "Request paid revision" }).click();
  await expect(page.getByRole("article", { name: "Revision 2" })).toContainText("succeeded", { timeout: 15000 });
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Export revision 2 JSON" }).click(); const exported = JSON.parse(await readFile((await (await download).path())!, "utf8"));
  expect(exported.revision.number).toBe(2); expect(exported.label).toContain("AI-generated");
  const design = await apiGet(session, `/api/designs/${id}`); const usage = await apiGet(session, "/api/usage");
  const charged = usage["items"].filter((u: { runId: string }) => u.runId === `design:${id}`);
  expect(charged.length).toBe(2); expect(BigInt(design["totalChargedMicrousd"])).toBeGreaterThan(0n);
  await page.getByLabel("Revision instruction").fill("Return malformed output for the failure test [[fake:malformed]]");
  await page.getByRole("checkbox", { name: /authorize another paid/ }).check(); await page.getByRole("button", { name: "Request paid revision" }).click();
  await expect(page.getByRole("article", { name: "Revision 3" })).toContainText("MALFORMED_OUTPUT", { timeout: 15000 });
  await expect(page.getByRole("article", { name: "Revision 3" }).getByTestId("design-document")).toHaveCount(0);
  await page.getByRole("button", { name: "Delete design", exact: true }).click(); await page.getByRole("button", { name: "Confirm delete design" }).click();
  await expect(page.getByTestId("design-document")).toHaveCount(0); expect((await apiCall(session, "GET", `/api/designs/${id}`)).status).toBe(404);
});

test("disabled beta routes honestly report unavailable", async ({ page, context }) => {
  test.skip(process.env["E2E_BETA_FLAGS"] !== "false", "run with E2E_BETA_FLAGS=false to verify actual disabled API flags");
  const { session } = await fundedAccount(); await useSession(context, session);
  expect(await apiGet(session, "/api/features")).toEqual({ repositoryGraph: false, designBeta: false });
  await page.goto("/app/memory");
  const rail = page.locator(".console__rail");
  await expect(rail.getByText("Project memory")).toBeVisible();
  await expect(rail.getByRole("link", { name: "Repository graph" })).toHaveCount(0);
  await expect(rail.getByRole("link", { name: "Design" })).toHaveCount(0);
  // the API itself answers 404 FEATURE_DISABLED
  const p = await apiCall(session, "POST", "/api/projects", { name: uniqName("off") });
  const off = await apiCall(session, "GET", `/api/projects/${p.json["id"]}/designs`);
  expect(off.status).toBe(404); expect(off.json["error"]["code"]).toBe("FEATURE_DISABLED");
  for (const path of ["repository", "design"]) { await page.goto(`/app/${path}`); await expect(page.getByRole("status")).toContainText("Unavailable on this deployment"); await expect(page.getByRole("button", { name: /Upload archive|Create paid proposal/ })).toHaveCount(0); }
});

test("More navigation shows beta areas only when the deployment enables them and Operations only for operators", async ({ page, context }) => {
  test.skip(process.env["E2E_BETA_FLAGS"] === "false", "enabled-flags variant");
  await page.setViewportSize({ width: 1440, height: 900 });
  const { session } = await fundedAccount(); await useSession(context, session);
  await page.goto("/app/memory");
  const rail = page.locator(".console__rail");
  await expect(rail.getByRole("link", { name: "Repository graph" })).toBeVisible();
  await expect(rail.getByRole("link", { name: "Design" })).toBeVisible();
  await expect(rail.getByRole("link", { name: "Operations" })).toHaveCount(0); // not an operator
  expect(await apiGet(session, "/api/features")).toEqual({ repositoryGraph: true, designBeta: true });
});
