/// <reference lib="dom" />
/** Real operator routes and ledger; grants are test-only out-of-band setup on loopback. */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { apiCall, apiGet, apiSignIn, CONTROL, fundedAccount, useSession } from "./api-helpers";
import { noHorizontalOverflow, overflowCulprits, seedTheme } from "./helpers";
import { newEvm } from "./wallet-mock";

async function grant(accountId: string) {
  const r = await fetch(`${CONTROL}/operators/grant`, { method: "POST", body: JSON.stringify({ accountId }) }); expect(r.status).toBe(200);
}

test("customer roles have no operator access", async ({ page, context }) => {
  const { session } = await apiSignIn(newEvm()); await useSession(context, session);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/operations"); await expect(page.getByRole("status")).toContainText("Operator access unavailable");
  await expect(page.locator(".console__rail").getByRole("link", { name: "Operations" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Elevate operator session" })).toHaveCount(0);
  expect((await apiCall(session, "GET", "/api/operator/reconciliation")).status).toBe(403);
});

test("two operators confirm an immutable adjustment, ledger and customer audit reconcile", async ({ page, context, browser }) => {
  const a = await apiSignIn(newEvm()); const b = await apiSignIn(newEvm()); const customer = await fundedAccount();
  await grant(a.accountId); await grant(b.accountId); await useSession(context, a.session);
  await page.goto("/app/operations"); await page.getByRole("button", { name: "Elevate operator session" }).click();
  await expect(page.getByRole("heading", { name: "Reconciliation", exact: true })).toBeVisible();
  await expect(page.locator(".console__rail").getByRole("link", { name: "Operations" })).toBeVisible(); // operators get the nav entry
  await page.getByLabel("Account ID", { exact: true }).fill(customer.accountId); await page.getByLabel("Amount in micro-USD").fill("1000000"); await page.getByLabel("Proposal reason").fill("Confirmed missing credit after reconciliation.");
  await page.getByRole("button", { name: "Review proposal" }).click(); await page.getByRole("button", { name: "Confirm proposal" }).click();
  await expect(page.getByText("A different operator must approve or reject your proposal.")).toBeVisible();
  const list = await apiGet(a.session, "/api/operator/adjustments"); const id = String((list["items"] as { id: string; accountId: string }[]).find((x) => x.accountId === customer.accountId)!.id);
  expect((await apiCall(a.session, "POST", `/api/operator/adjustments/${id}/approve`, { reason: "Self approval denied" })).status).toBe(403);
  const c2 = await browser.newContext(); await useSession(c2, b.session); const p2 = await c2.newPage();
  try {
    await p2.goto("/app/operations"); await p2.getByRole("button", { name: "Elevate operator session" }).click();
    await p2.getByLabel(`Decision reason for ${id}`).fill("Verified the missing credit independently."); await p2.getByRole("button", { name: `Approve ${id}`, exact: true }).click(); await p2.getByRole("button", { name: "Confirm approve", exact: true }).click();
    await expect(p2.getByText("Ledger transaction:").first()).toBeVisible();
    const balance = await apiGet(customer.session, "/api/accounts/current/balance"); expect(balance["availableMicrousd"]).toBe("6000000");
    const audit = await apiGet(customer.session, "/api/audit?source=operator"); expect(audit["items"].length).toBeGreaterThan(0); expect(audit["items"].every((x: { actor: string; actorUserId: null }) => x.actor === "operator" && x.actorUserId === null)).toBe(true);
    // the customer sees the operator step in their own audit view, as "operator" with no user id
    const c3 = await browser.newContext(); await useSession(c3, customer.session); const p3 = await c3.newPage();
    try {
      await p3.goto("/app/audit"); await p3.getByLabel("Show").selectOption("operator");
      const rows = p3.getByTestId("audit-table").getByRole("row");
      await expect(rows.nth(1).locator("td").first()).toHaveText("operator"); // no user id next to it
    } finally { await c3.close(); }
    await p2.getByRole("button", { name: "End operator elevation" }).click(); await expect(p2.getByRole("button", { name: "Elevate operator session" })).toBeVisible();
    expect((await apiCall(b.session, "GET", "/api/operator/reconciliation")).status).toBe(403);
  } finally { await c2.close(); }
});

for (const theme of ["light", "dark"] as const) {
  test(`operator empty states accessible at 320px in ${theme}`, async ({ page, context }) => {
    const a = await apiSignIn(newEvm()); await grant(a.accountId); await useSession(context, a.session); await seedTheme(page, theme); await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/app/operations"); await page.getByRole("button", { name: "Elevate operator session" }).click(); await expect(page.getByRole("heading", { name: "Ledger mismatches" })).toBeVisible();
    await expect(page.getByText("No ledger mismatches.")).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    await page.waitForLoadState("networkidle");
    const widths = await noHorizontalOverflow(page); expect(widths.scrollWidth, (await overflowCulprits(page)).join("; ")).toBeLessThanOrEqual(widths.clientWidth);
  });
}
