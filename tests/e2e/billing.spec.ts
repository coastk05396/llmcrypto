/// <reference lib="dom" />
/**
 * Credits, usage, request detail, agent runs and exports against the REAL apps/api (in-memory PGlite) with:
 *  - the deterministic FakeProvider behind /v1/chat/completions (no real provider exists),
 *  - the TEST-ONLY dev credit helper for funding (setup only; the UI under test never funds),
 *  - a test-only payment network config + TestAddressProvider + FakeChainClient (no real chain, no real funds).
 * Tests marked "(mocked API)" intercept one endpoint to reach a state that cannot be produced on demand.
 */
import AxeBuilder from "@axe-core/playwright";
import { CONTRACT_VERSION } from "@llmcrypto/contracts";
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN, apiCreateDeposit, apiGet, chainAdvance, chainPay, chatCompletion, fundedAccount, useSession } from "./api-helpers";
import { THEME_CASES, VIEWPORTS, noHorizontalOverflow, seedTheme } from "./helpers";

const TOKEN_A = "0x00000000000000000000000000000000000000a1";
const TOKEN_B = "0x00000000000000000000000000000000000000b2";
const usd = (micros: bigint) => {
  const whole = micros / 1_000_000n;
  let frac = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${whole}.${frac}`;
};

test.describe("docs", () => {
  test("the contract version shown is the one exported by @llmcrypto/contracts", async ({ page }) => {
    await page.goto("/docs");
    await expect(page.getByTestId("contract-version")).toHaveText(CONTRACT_VERSION);
  });
});

test.describe("funded request journey (real API, FakeProvider)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a gateway request shows in Overview, Usage, request detail, Credits balance and ledger, and reconciles", async ({ page, context }) => {
    const { session, secret } = await fundedAccount("5000000");
    await useSession(context, session);

    const r1 = await chatCompletion(secret, "hello [[fake:cached=4]] [[fake:output=40]]", { "X-Run-Id": "run-e2e-1" });
    expect(r1.status).toBe(200);
    const r2 = await chatCompletion(secret, "second request without a run id");
    expect(r2.status).toBe(200);

    // the server's own numbers, used as the oracle for what the UI must show
    const usage = (await apiGet(session, "/api/usage")).items as { requestId: string; chargeMicrousd: string; status: string; runId: string | null; outputTokens: string; priceVersion: string }[];
    expect(usage).toHaveLength(2);
    const charged = usage.reduce((s, u) => s + BigInt(u.chargeMicrousd), 0n);
    expect(charged).toBeGreaterThan(0n);
    const bal = await apiGet(session, "/api/accounts/current/balance");
    expect(BigInt(bal["postedMicrousd"])).toBe(5_000_000n - charged);

    // Overview: recent requests + cost
    await page.goto("/app");
    await expect(page.getByTestId("available")).toHaveText(`${usd(5_000_000n - charged)} USD`);
    await expect(page.getByTestId("recent-cost")).toHaveText(`${usd(charged)} USD`);
    const recent = page.getByTestId("recent-table");
    await expect(recent.getByRole("row")).toHaveCount(3); // header + 2
    await expect(recent).toContainText("sample-fast-1");

    // Usage list -> request detail
    await page.getByRole("link", { name: "View all usage" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Usage and logs" })).toBeVisible();
    const withRun = usage.find((u) => u.runId === "run-e2e-1")!;
    const rowOf = (id: string) => page.getByTestId("usage-table").getByRole("row").filter({ has: page.locator(`a[href="/app/usage/${id}"]`) });
    await expect(rowOf(withRun.requestId)).toContainText(`${usd(BigInt(withRun.chargeMicrousd))}`);
    await expect(rowOf(withRun.requestId)).toContainText("run-e2e-1");
    const noRun = usage.find((u) => u.runId === null)!;
    await expect(rowOf(noRun.requestId)).toContainText("Unknown");

    await rowOf(withRun.requestId).getByRole("link").click();
    await expect(page.getByRole("heading", { level: 1, name: "Request detail" })).toBeVisible();
    await expect(page.getByTestId("request-id")).toHaveText(withRun.requestId);
    await expect(page.getByTestId("charge")).toHaveText(`${usd(BigInt(withRun.chargeMicrousd))} USD`);
    await expect(page.getByText("Settled", { exact: true }).first()).toBeVisible();
    const tokens = page.getByTestId("token-table");
    await expect(tokens.getByRole("row", { name: /Output/ })).toContainText(String(r1.json["usage"]["completion_tokens"]));
    await expect(tokens.getByRole("row", { name: /Cached input/ })).toContainText(String(r1.json["usage"]["prompt_tokens_details"]["cached_tokens"]));
    // rate snapshot: the catalog is the same price version as the request, so rates are shown (0.25 USD / 1M input)
    await expect(page.getByTestId("rate-note")).toContainText(withRun.priceVersion);
    await expect(tokens.getByRole("row", { name: /Input \(uncached\)/ })).toContainText("0.25 USD per 1M tokens");

    // deep link without list state: bounded lookup still finds it; an unknown id is "not found", never an error page
    await page.goto(`/app/usage/${noRun.requestId}`);
    await expect(page.getByTestId("request-id")).toHaveText(noRun.requestId);
    await expect(page.getByText("Unknown (the caller sent none)").first()).toBeVisible();
    await page.goto("/app/usage/req_does_not_exist");
    await expect(page.getByTestId("request-not-found")).toBeVisible();

    // Credits: balance cells and ledger table. Page size forced to 2 to drive the real cursor.
    await page.route("**/api/ledger?*", (route) => route.continue({ url: route.request().url().replace(/limit=\d+/, "limit=2") }));
    await page.goto("/app/credits");
    await expect(page.getByTestId("available")).toHaveText(`${usd(5_000_000n - charged)} USD`);
    await expect(page.getByTestId("posted")).toHaveText(`${usd(5_000_000n - charged)} USD`);
    await expect(page.getByTestId("held")).toHaveText("0.00 USD");
    await expect(page.getByTestId("ledger-count")).toContainText("2 entries loaded, more available");
    await page.getByRole("button", { name: "Load more entries" }).click();
    await expect(page.getByTestId("ledger-count")).toContainText("3 entries loaded, end of ledger");
    const ledger = page.getByTestId("ledger-table");
    await expect(ledger).toContainText("+5.00"); // the dev credit, labelled as an adjustment
    await expect(ledger).toContainText("Adjustment");
    for (const u of usage) await expect(ledger).toContainText(`-${usd(BigInt(u.chargeMicrousd))}`);
    await expect(ledger.getByRole("link", { name: new RegExp(withRun.requestId) })).toHaveAttribute("href", `/app/usage/${withRun.requestId}`);
    await page.getByLabel("Show").selectOption("spend");
    await expect(page.getByTestId("ledger-count")).toContainText("loaded");
    await expect(ledger).not.toContainText("Adjustment");
  });

  test("Usage filters, empty-filter state, agent runs with an unknown correlation, and an export that reconciles", async ({ page, context }) => {
    const { session, secret } = await fundedAccount("5000000");
    await useSession(context, session);
    expect((await chatCompletion(secret, "a", { "X-Run-Id": "run-e2e-2" })).status).toBe(200);
    expect((await chatCompletion(secret, "b", { "X-Run-Id": "run-e2e-2" })).status).toBe(200);
    expect((await chatCompletion(secret, "c")).status).toBe(200);
    const usage = (await apiGet(session, "/api/usage")).items as { chargeMicrousd: string }[];
    const total = usage.reduce((s, u) => s + BigInt(u.chargeMicrousd), 0n);

    await page.goto("/app/usage");
    const rows = page.getByTestId("usage-table").getByRole("row");
    await expect(rows).toHaveCount(4);
    await page.getByLabel("Run ID").fill("run-e2e-2");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(rows).toHaveCount(3);
    await page.getByLabel("Run ID").fill("nope");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByTestId("usage-empty")).toContainText("No requests match these filters");
    await page.getByLabel("From (UTC date)").fill("2030-01-01");
    await page.getByLabel("To (UTC date)").fill("2029-01-01");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByText("The end date must not be before the start date.")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await expect(rows).toHaveCount(4);

    // export of the unfiltered usage: job polling -> download; summary total equals the server's sum
    await page.getByRole("button", { name: "Request export" }).click();
    await expect(page.getByTestId("export-status")).toContainText("Export ready", { timeout: 20_000 });
    await expect(page.getByTestId("export-status")).toContainText(`3 rows, total ${usd(total)} USD`);
    const href = await page.getByTestId("export-download").getAttribute("href");
    const file = await page.request.get(`${WEB_ORIGIN}${href}`);
    expect(file.status()).toBe(200);
    expect((await file.text()).trim().split("\n")).toHaveLength(4); // header + 3 rows

    // agent runs: one known run with 2 requests, one unknown bucket with 1
    await page.getByRole("link", { name: "Agent runs" }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Agent runs" })).toBeVisible();
    const runs = page.getByTestId("runs-table");
    await expect(runs.getByRole("row")).toHaveCount(3);
    await expect(runs.getByRole("row", { name: /run-e2e-2/ }).getByRole("cell").nth(2)).toHaveText("2");
    await expect(runs.getByRole("row", { name: /Unknown run/ })).toContainText("No run ID sent");
    await runs.getByRole("link", { name: "run-e2e-2" }).click();
    await expect(page.getByLabel("Run ID")).toHaveValue("run-e2e-2");
    await expect(page.getByTestId("usage-table").getByRole("row")).toHaveCount(3);
  });

  test("a new funded-less account sees empty states, not blank frames", async ({ page, context }) => {
    const { session } = await fundedAccount("1000000");
    await useSession(context, session);
    await page.goto("/app");
    await expect(page.getByTestId("recent-empty")).toBeVisible();
    await page.goto("/app/usage");
    await expect(page.getByTestId("usage-empty")).toContainText("No requests yet");
    await page.goto("/app/usage/agent-runs");
    await expect(page.getByRole("heading", { name: "No runs yet" })).toBeVisible();
    await page.goto("/app/credits");
    await expect(page.getByRole("heading", { name: "No deposits yet" })).toBeVisible();
  });
});

test.describe("deposit intents (test payment config, TestAddressProvider, FakeChainClient)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("create an intent, see address/network/asset, then every state through to CREDITED and a ledger row", async ({ page, context }) => {
    const { session } = await fundedAccount("1000000");
    await useSession(context, session);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/app/credits");
    await page.getByRole("button", { name: "Add credit" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add credit" });
    await expect(dialog.getByRole("radio")).toHaveCount(2); // from the real GET /api/deposits/networks
    await expect(dialog.getByRole("radio").first()).toBeChecked();
    // testnet-b is used for chain movement here because the fake chain is shared across parallel specs (testnet-a: underpaid test)
    await dialog.getByRole("radio").nth(1).check();

    // validation: below the configured minimum (0.001 TUSD) never reaches the API
    const posts: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/deposits")) posts.push(r.headers()["idempotency-key"] ?? ""); });
    await dialog.getByLabel(/Amount to send/).fill("0.0001");
    await dialog.getByRole("button", { name: "Create deposit address" }).click();
    await expect(dialog.getByRole("alert")).toContainText("The minimum is 0.001 TUSD");
    expect(posts).toHaveLength(0);
    await dialog.getByLabel(/Amount to send/).fill("2");
    await dialog.getByRole("button", { name: "Create deposit address" }).click();
    await expect(dialog).toBeHidden();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/^[0-9a-f-]{36}$/);

    const card = page.getByTestId("deposit").first();
    await expect(card).toHaveAttribute("data-status", "CREATED");
    await expect(card).toContainText("Awaiting payment");
    await expect(card).toContainText("Send only TUSD on testnet-b");
    await expect(card).toContainText("2 TUSD on testnet-b");
    const address = (await card.getByTestId("deposit-address").textContent()) ?? "";
    expect(address).toMatch(/^0x[0-9a-f]{40}$/);
    await card.getByRole("button", { name: /Copy testnet-b TUSD receiving address/ }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);

    // paid on the right network, mined but under-confirmed -> state is explained with the count (2 required)
    await chainPay({ network: "testnet-b", address, amountAtomic: "2000000000000000000", assetContract: TOKEN_B, blocks: 0 });
    await page.reload();
    await expect(page.getByTestId("deposit").first()).toHaveAttribute("data-status", /DETECTED|CONFIRMING/);
    await expect(page.getByTestId("deposit").first()).toContainText(/Confirmations \d of 2/);
    await expect(page.getByRole("progressbar")).toBeVisible();
    await expect(page.getByTestId("available")).toHaveText("1.00 USD"); // nothing credited before finality

    // finality reached -> the open deposit is polled and flips by itself; balance and ledger follow
    await chainAdvance("testnet-b", 5);
    await expect(page.getByTestId("deposit").first()).toHaveAttribute("data-status", "CREDITED", { timeout: 30_000 });
    await expect(page.getByTestId("deposit").first()).toContainText("Credited");
    await expect(page.getByTestId("available")).toHaveText("3.00 USD", { timeout: 15_000 });
    await expect(page.getByTestId("ledger-table")).toContainText("Deposit");
    await expect(page.getByTestId("ledger-table")).toContainText("+2.00");
  });

  test("an underpaid transfer is shown as under review with a reason, not credited", async ({ page, context }) => {
    const { session } = await fundedAccount("1000000");
    await useSession(context, session);
    const d = await apiCreateDeposit(session, { asset: "TUSD", network: "testnet-a", amountAtomic: "3000000" });
    await chainPay({ network: "testnet-a", address: d["address"], amountAtomic: "1000000", assetContract: TOKEN_A, blocks: 5 });
    await chainAdvance("testnet-a", 5);
    await page.goto("/app/credits");
    const card = page.getByTestId("deposit").first();
    await expect(card).toHaveAttribute("data-status", "REVIEW_REQUIRED");
    await expect(card).toContainText("Under review");
    await expect(card).toContainText("lower than the amount expected");
    await expect(card).toContainText(d["id"]);
    await expect(page.getByTestId("available")).toHaveText("1.00 USD");
  });

  test("the second network's intent is labelled with its own network and 18-decimal amount", async ({ page, context }) => {
    const { session } = await fundedAccount("1000000");
    await useSession(context, session);
    await apiCreateDeposit(session, { asset: "TUSD", network: "testnet-b", amountAtomic: "2000000000000000000" });
    await page.goto("/app/credits");
    const card = page.getByTestId("deposit").first();
    await expect(card).toContainText("2 TUSD on testnet-b");
    await expect(card).toContainText("Send only TUSD on testnet-b");
  });

  test("(mocked API) no payment networks configured -> explicit empty state, no address is requested", async ({ page, context }) => {
    const { session } = await fundedAccount("1000000");
    await useSession(context, session);
    await page.route("**/api/deposits/networks", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "No payment networks configured", requestId: "req_mock" } }) }));
    let posted = false;
    page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/deposits")) posted = true; });
    await page.goto("/app/credits");
    await page.getByRole("button", { name: "Add credit" }).first().click();
    await expect(page.getByTestId("no-networks")).toContainText("No payment networks configured");
    expect(posted).toBe(false);
  });

  test("(mocked API) every deposit state renders text, address handling and warnings", async ({ page, context }) => {
    const { session } = await fundedAccount("1000000");
    await useSession(context, session);
    const base = { asset: "TUSD", decimals: 6, requiredConfirmations: 3, createdAt: "2026-10-18T00:00:00.000Z", address: "0x1111111111111111111111111111111111111111", assetContract: TOKEN_A, network: "testnet-a", amountAtomic: "1000000", expiresAt: "2026-10-18T01:00:00.000Z", confirmations: 0, creditedMicrousd: null, ledgerTransactionId: null, reviewReason: null };
    const items = [
      { ...base, id: "d1", status: "CREATED" },
      { ...base, id: "d2", status: "DETECTED" },
      { ...base, id: "d3", status: "CONFIRMING", confirmations: 2 },
      { ...base, id: "d4", status: "CREDITED", confirmations: 3, creditedMicrousd: "1000000", ledgerTransactionId: "ltx_1" },
      { ...base, id: "d5", status: "EXPIRED" },
      { ...base, id: "d6", status: "REVIEW_REQUIRED", reviewReason: "WRONG_NETWORK" },
      { ...base, id: "d7", status: "REVERSED", creditedMicrousd: null },
    ];
    await page.route("**/api/deposits?*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items, nextCursor: null }) }));
    await page.route("**/api/deposits/d*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(items[0]) }));
    await page.goto("/app/credits");
    const labels = ["Awaiting payment", "Payment detected", "Confirming", "Credited", "Expired", "Under review", "Reversed"];
    const cards = page.getByTestId("deposit");
    await expect(cards).toHaveCount(7);
    for (const [i, l] of labels.entries()) await expect(cards.nth(i)).toContainText(l);
    await expect(cards.nth(0)).toContainText("Send only TUSD on testnet-a");
    await expect(cards.nth(2)).toContainText("Confirmations 2 of 3");
    await expect(cards.nth(5)).toContainText("different network");
    await expect(cards.nth(3)).toContainText("1.00 USD");
  });
});

test.describe("layout, themes and accessibility (390 / 1440, light / dark)", () => {
  for (const vp of VIEWPORTS) {
    for (const tc of THEME_CASES.filter((t) => t.name === "light" || t.name === "dark")) {
      test.describe(`${vp.name} / ${tc.name}`, () => {
        test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: tc.os });

        test("overview, usage, detail, agent runs, credits and add-credit dialog: no overflow, no axe violations", async ({ page, context }, info) => {
          await seedTheme(page, tc.pref);
          const { session, secret } = await fundedAccount("5000000");
          await chatCompletion(secret, "layout [[fake:cached=2]]", { "X-Run-Id": "run-layout" });
          await chatCompletion(secret, "layout two");
          const dep = await apiCreateDeposit(session, { asset: "TUSD", network: "testnet-a", amountAtomic: "2000000" });
          const usage = (await apiGet(session, "/api/usage")).items as { requestId: string }[];
          await useSession(context, session);

          const check = async (label: string) => {
            const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
            expect(r.violations.map((v) => `${label} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
            const { scrollWidth, clientWidth } = await noHorizontalOverflow(page);
            expect(scrollWidth, `${label} overflow`).toBeLessThanOrEqual(clientWidth);
            await page.screenshot({ path: info.outputPath(`${label}-${vp.name}-${tc.name}.png`), fullPage: true });
          };

          await page.goto("/app");
          await expect(page.getByTestId("recent-table")).toBeVisible();
          await expect(page.locator("html")).toHaveAttribute("data-theme", tc.expected);
          await check("overview");
          await page.goto("/app/usage");
          await expect(page.getByTestId("usage-table")).toBeVisible();
          await check("usage");
          await page.goto(`/app/usage/${usage[0]!.requestId}`);
          await expect(page.getByTestId("token-table")).toBeVisible();
          await check("request-detail");
          await page.goto("/app/usage/agent-runs");
          await expect(page.getByTestId("runs-table")).toBeVisible();
          await check("agent-runs");
          await page.goto("/app/credits");
          await expect(page.getByTestId("deposit")).toContainText(dep["id"]);
          await expect(page.getByTestId("ledger-table")).toBeVisible();
          await check("credits");
          await page.getByRole("button", { name: "Add credit" }).first().click();
          await expect(page.getByRole("dialog", { name: "Add credit" }).getByRole("radio").first()).toBeVisible();
          await check("add-credit-dialog");
          await page.keyboard.press("Escape");
          await expect(page.getByRole("dialog")).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Add credit" }).first()).toBeFocused();
        });
      });
    }
  }
});
