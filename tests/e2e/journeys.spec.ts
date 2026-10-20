/// <reference lib="dom" />
/**
 * SPEC "Quality and acceptance criteria" journey, one spec, real apps/api (PGlite) + FakeProvider:
 * new customer wallet sign-in -> fund (TEST-ONLY dev credit helper; real deposits are covered in billing.spec.ts)
 * -> create key (UI) -> streaming + non-streaming request -> ledger/usage match -> rotate (create new, revoke old) -> sign out.
 * Run at 390/1440 x light/dark. Evidence is fake-provider/PGlite, NOT live provider or chain verification.
 */
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN, apiCall, fundAccount, gatewayModelsStatus } from "./api-helpers";
import { THEME_CASES, VIEWPORTS, noHorizontalOverflow, seedTheme } from "./helpers";
import { installWallet, newEvm } from "./wallet-mock";

const FUND = 5_000_000n;
const usd = (micros: bigint) => {
  const whole = micros / 1_000_000n;
  let frac = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${whole}.${frac}`;
};

for (const vp of VIEWPORTS) {
  for (const tc of THEME_CASES.filter((t) => t.name === "light" || t.name === "dark")) {
    test.describe(`customer journey ${vp.name} / ${tc.name}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: tc.os });

      test("sign in -> fund -> key -> stream + non-stream -> ledger/usage match -> rotate -> sign out", async ({ page }) => {
        await seedTheme(page, tc.pref);
        await installWallet(page, newEvm());

        // 1. sign in (new customer, injected wallet)
        await page.goto("/app");
        await expect(page.locator("html")).toHaveAttribute("data-theme", tc.expected);
        await page.getByRole("button", { name: "Sign in with an EVM wallet" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
        const sess = await page.request.get(`${WEB_ORIGIN}/api/session`);
        expect(sess.status()).toBe(200);
        const accountId = String(((await sess.json()) as { account: { id: string } }).account.id);

        // 2. fund (test setup helper only)
        await fundAccount(accountId, FUND.toString());

        // 3. create key through the UI
        const createKey = async (name: string): Promise<string> => {
          await page.goto("/app/keys");
          await page.getByRole("button", { name: "Create key" }).first().click();
          const dialog = page.getByRole("dialog", { name: "Create API key" });
          await dialog.getByLabel("Name", { exact: true }).fill(name);
          await dialog.getByRole("button", { name: "Create key" }).click();
          const reveal = page.getByRole("dialog", { name: "Copy your key now, it will not be shown again" });
          await expect(reveal).toBeVisible();
          const secret = ((await reveal.getByTestId("secret").textContent()) ?? "").trim();
          expect(secret).toMatch(/^sk_/);
          await reveal.getByLabel("I have stored this key").check();
          await reveal.getByRole("button", { name: "Close", exact: true }).click();
          await expect(reveal).toBeHidden();
          return secret;
        };
        const key1 = await createKey("journey-key-1");
        expect((await gatewayModelsStatus(key1)).status).toBe(200);

        // 4. non-streaming + streaming gateway requests (FakeProvider)
        const call = (secret: string, extra: object, content: string) =>
          fetch(`${WEB_ORIGIN}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ model: "sample-fast-1", messages: [{ role: "user", content }], max_tokens: 50, ...extra }),
          });
        const ns = await call(key1, {}, "non-stream [[fake:output=12]]");
        expect(ns.status).toBe(200);
        const nsJson = (await ns.json()) as { usage: { completion_tokens: number } };
        expect(nsJson.usage.completion_tokens).toBe(12);
        const st = await call(key1, { stream: true, stream_options: { include_usage: true } }, "stream [[fake:output=7]]");
        expect(st.status).toBe(200);
        expect(st.headers.get("content-type")).toContain("text/event-stream");
        const sseText = await st.text();
        expect(sseText.trimEnd().endsWith("[DONE]")).toBe(true);
        const streamUsage = sseText.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)) as { usage?: { completion_tokens: number } }).find((c) => c.usage)?.usage;
        expect(streamUsage?.completion_tokens).toBe(7);

        // 5. ledger / usage reconcile, via the API oracle, then the UI
        type UsageItem = { requestId: string; chargeMicrousd: string; status: string; outputTokens: string };
        let usage: UsageItem[] = [];
        await expect.poll(async () => {
          const r = await page.request.get(`${WEB_ORIGIN}/api/usage`);
          usage = ((await r.json()) as { items: UsageItem[] }).items;
          return usage.length === 2 && usage.every((u) => u.status === "SETTLED" || u.status.toLowerCase().includes("settled"));
        }).toBe(true);
        expect(usage.map((u) => u.outputTokens).sort()).toEqual(["12", "7"]);
        const charged = usage.reduce((s, u) => s + BigInt(u.chargeMicrousd), 0n);
        expect(charged).toBeGreaterThan(0n);
        const bal = (await (await page.request.get(`${WEB_ORIGIN}/api/accounts/current/balance`)).json()) as { postedMicrousd: string; heldMicrousd?: string };
        expect(BigInt(bal.postedMicrousd)).toBe(FUND - charged);

        await page.goto("/app/credits");
        await expect(page.getByTestId("available")).toHaveText(`${usd(FUND - charged)} USD`);
        const ledger = page.getByTestId("ledger-table");
        await expect(page.getByTestId("ledger-count")).toContainText("3 entries loaded");
        for (const u of usage) await expect(ledger).toContainText(`-${usd(BigInt(u.chargeMicrousd))}`);
        await page.goto("/app/usage");
        for (const u of usage) await expect(page.getByTestId("usage-table")).toContainText(usd(BigInt(u.chargeMicrousd)));
        expect((await noHorizontalOverflow(page)).scrollWidth).toBeLessThanOrEqual(vp.width);

        // 6. rotate: new key works, then revoke old; old key rejected, new key still works
        const key2 = await createKey("journey-key-2");
        expect((await gatewayModelsStatus(key2)).status).toBe(200);
        const row1 = page.getByRole("list", { name: "API keys" }).getByRole("listitem").filter({ hasText: "journey-key-1" });
        await row1.getByRole("button", { name: "Revoke journey-key-1" }).click();
        await page.getByRole("dialog", { name: "Revoke this key?" }).getByRole("button", { name: "Revoke key" }).click();
        await expect(row1).toContainText("Revoked");
        expect((await gatewayModelsStatus(key1)).status).toBe(401);
        expect((await call(key1, {}, "after revoke")).status).toBe(401);
        expect((await call(key2, {}, "new key ok")).status).toBe(200);
        expect(await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }))).not.toContain(key1);

        // 7. sign out: server session ends, console is gated again
        await page.getByRole("button", { name: "Sign out" }).first().click();
        await expect(page.getByText("Signed out")).toBeVisible();
        expect((await apiCall("", "GET", "/api/usage")).status).toBe(401);
        expect((await page.request.get(`${WEB_ORIGIN}/api/session`)).status()).toBe(401);
        await page.screenshot({ path: test.info().outputPath(`journey-${vp.name}-${tc.name}.png`), fullPage: true });
      });
    });
  }
}
