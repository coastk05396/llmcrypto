/// <reference lib="dom" />
/**
 * Console journeys against the REAL apps/api (in-memory PGlite, started by playwright.config.ts) through the web
 * origin's proxy, driven by an injected mock EIP-1193 / TronLink wallet. Tests marked "(mocked API)" intercept
 * one endpoint to reach states that cannot be produced on demand (step-up window, replay-window expiry).
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Request } from "@playwright/test";
import { WEB_ORIGIN, apiCreateKey, apiSignIn, gatewayModelsStatus, useSession } from "./api-helpers";
import { VIEWPORTS, THEME_CASES, noHorizontalOverflow, seedTheme } from "./helpers";
import { installWallet, newEvm, newTron } from "./wallet-mock";

const evmSignIn = (page: Page) => page.getByRole("button", { name: "Sign in with an EVM wallet" });
const tronSignIn = (page: Page) => page.getByRole("button", { name: "Sign in with a TRON wallet" });
const sessionPosts = (page: Page) => {
  const seen: string[] = [];
  page.on("request", (r: Request) => { if (r.method() === "POST" && r.url().endsWith("/api/auth/wallet/sessions")) seen.push(r.url()); });
  return seen;
};

test.describe("sign-in (real API, injected wallet)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("EVM: challenge -> personal_sign -> session; lands on Overview with balance and a hardened cookie", async ({ page, context }) => {
    const w = newEvm();
    await installWallet(page, w);
    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await evmSignIn(page).click();
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    await expect(page.getByTestId("available")).toHaveText(/^0\.00\s*USD$/);
    await expect(page.getByTestId("held")).toHaveText(/^0\.00\s*USD$/);
    await expect(page.getByTestId("active-keys")).toHaveText("0");
    // first-request path with a placeholder, never a real key
    await expect(page.getByText("Bearer YOUR_API_KEY")).toBeVisible();
    const cookie = (await context.cookies()).find((c) => c.name === "session");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" });
    // nothing sensitive in web storage or the URL
    const storage = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    expect(storage).not.toContain(cookie!.value);
    expect(storage).not.toMatch(/signature|0x[0-9a-f]{130}/i);
    expect(page.url()).toBe(`${WEB_ORIGIN}/app`);
  });

  test("a declined signature returns to a usable screen and a retry succeeds", async ({ page }) => {
    const w = newEvm();
    const posts = sessionPosts(page);
    const mock = await installWallet(page, w);
    await page.goto("/app");
    await mock.rejectNextSign();
    await evmSignIn(page).click();
    await expect(page.getByRole("alert")).toContainText("Signature was declined");
    expect(posts).toHaveLength(0);
    await expect(evmSignIn(page)).toBeEnabled();
    await expect(tronSignIn(page)).toBeEnabled();
    await evmSignIn(page).click();
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    expect(posts).toHaveLength(1);
  });

  test("a wallet on a chain the service does not accept is refused with guidance and no session", async ({ page }) => {
    await installWallet(page, newEvm(), { chainHex: "0x5" });
    await page.goto("/app");
    await evmSignIn(page).click();
    await expect(page.getByRole("alert")).toContainText("Network not accepted");
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await expect(evmSignIn(page)).toBeEnabled();
  });

  test("accountsChanged / chainChanged while signing discards the challenge: nothing is posted", async ({ page }) => {
    const posts = sessionPosts(page);
    const w = newEvm();
    const mock = await installWallet(page, w);
    await page.goto("/app");
    for (const emit of [() => mock.emitAccountsChanged([newEvm().address]), () => mock.emitChainChanged("0x89")]) {
      await mock.holdSign(true);
      await evmSignIn(page).click();
      await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
      await expect(page.getByLabel("What you are signing")).toContainText("127.0.0.1:4173");
      await expect.poll(() => mock.signCount()).toBeGreaterThan(0);
      await emit();
      await expect(page.getByRole("alert")).toContainText("Wallet changed");
      await mock.releaseSign(); // the late signature must not be used
      await mock.setChainHex("0x1");
      await expect(evmSignIn(page)).toBeEnabled();
    }
    expect(posts).toHaveLength(0);
  });

  test("Cancel during an unanswered wallet prompt ends the attempt", async ({ page }) => {
    const mock = await installWallet(page, newEvm());
    await page.goto("/app");
    await mock.holdSign(true);
    await evmSignIn(page).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("alert")).toContainText("Cancelled");
    await expect(evmSignIn(page)).toBeEnabled();
  });

  test("no wallet installed shows guidance and keeps the other method available", async ({ page }) => {
    await installWallet(page, undefined);
    await page.goto("/app");
    await evmSignIn(page).click();
    await expect(page.getByRole("alert")).toContainText("No EVM wallet was found in this browser");
    await expect(tronSignIn(page)).toBeEnabled();
    await tronSignIn(page).click();
    await expect(page.getByRole("alert")).toContainText("No TRON wallet was found in this browser");
  });

  test("TRON: signMessageV2 sign-in creates a separate account", async ({ page }) => {
    const w = newTron();
    await installWallet(page, w);
    await page.goto("/app");
    await tronSignIn(page).click();
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    await page.getByRole("link", { name: "Security" }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Security" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Linked wallets" })).toContainText(w.address);
    await expect(page.getByRole("list", { name: "Linked wallets" })).toContainText("tron:mainnet");
  });

  test("TRON: declining the TronLink prompt is recoverable", async ({ page }) => {
    const mock = await installWallet(page, newTron());
    await page.goto("/app");
    await mock.rejectNextSign();
    await tronSignIn(page).click();
    await expect(page.getByRole("alert")).toContainText("Signature was declined");
    await expect(tronSignIn(page)).toBeEnabled();
  });

  test("TRON: a TronLink account change while signing discards the signature", async ({ page }) => {
    const posts = sessionPosts(page);
    const mock = await installWallet(page, newTron());
    await page.goto("/app");
    await mock.holdSign(true);
    await tronSignIn(page).click();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    await mock.emitTronMessage("accountsChanged");
    await expect(page.getByRole("alert")).toContainText("Wallet changed");
    await mock.releaseSign();
    expect(posts).toHaveLength(0);
  });

  test("unauthorized deep link shows sign-in at that path and returns there after signing in", async ({ page }) => {
    await installWallet(page, newEvm());
    await page.goto("/app/keys");
    await expect(page.getByText("Sign in to view this page")).toBeVisible();
    await evmSignIn(page).click();
    await expect(page.getByRole("heading", { level: 1, name: "API keys" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/app/keys");
  });

  test("an expired/ended session falls back to a usable sign-in with a notice, then recovers", async ({ page, context }) => {
    const w = newEvm();
    const { session } = await apiSignIn(w);
    await useSession(context, session);
    await installWallet(page, w);
    await page.goto("/app/keys");
    await expect(page.getByRole("heading", { level: 1, name: "API keys" })).toBeVisible();
    await context.clearCookies(); // the server will now answer 401 exactly as for an expired session
    await page.getByRole("link", { name: "Overview" }).first().click();
    await expect(page.getByText("Your session expired")).toBeVisible();
    await expect(evmSignIn(page)).toBeEnabled();
    await evmSignIn(page).click();
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  });

  test("sign out ends the session on the server", async ({ page, context }) => {
    const w = newEvm();
    const { session } = await apiSignIn(w);
    await useSession(context, session);
    await page.goto("/app");
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await expect(page.getByText("Signed out")).toBeVisible();
    const res = await fetch(`${WEB_ORIGIN}/api/session`, { headers: { Cookie: `session=${session}` } });
    expect(res.status).toBe(401);
  });
});

test.describe("API keys (real API)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("create -> one-time reveal -> list -> gateway accepts key -> revoke -> gateway rejects key", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const { session } = await apiSignIn(newEvm());
    await useSession(context, session);
    const idemKeys: string[] = [];
    const bodies: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/keys")) {
        idemKeys.push(r.headers()["idempotency-key"] ?? "");
        bodies.push(r.postData() ?? "");
      }
    });

    await page.goto("/app/keys");
    await expect(page.getByRole("heading", { name: "No API keys yet" })).toBeVisible();
    await page.getByRole("button", { name: "Create key" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Create API key" });
    await expect(dialog).toBeVisible();

    // client-side validation: error summary links to the field
    await dialog.getByLabel("Spend cap in USD (optional)").fill("0");
    await dialog.getByRole("button", { name: "Create key" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Enter a name");
    await expect(dialog.getByRole("alert")).toContainText("above zero");
    expect(idemKeys).toHaveLength(0);

    await dialog.getByLabel("Name", { exact: true }).fill("e2e-primary");
    await dialog.getByLabel("Spend cap in USD (optional)").fill("5.5");
    const firstModel = dialog.getByRole("group", { name: "Model allowlist" }).getByRole("checkbox").first();
    await expect(firstModel).toBeVisible(); // models come from the real /api/catalog
    await firstModel.check();
    await dialog.getByRole("button", { name: "Create key" }).click();

    const reveal = page.getByRole("dialog", { name: "Copy your key now, it will not be shown again" });
    await expect(reveal).toBeVisible();
    const secret = (await reveal.getByTestId("secret").textContent()) ?? "";
    expect(secret).toMatch(/^sk_[A-Za-z0-9_-]{20,}$/);
    await expect(reveal.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
    await reveal.getByRole("button", { name: /Copy API key secret/ }).click();
    await expect(reveal.getByText("Copied", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);

    // Escape without storing asks for confirmation instead of silently discarding
    await page.keyboard.press("Escape");
    await expect(reveal.getByText("Close without storing?")).toBeVisible();
    await reveal.getByLabel("I have stored this key").check();
    await reveal.getByRole("button", { name: "Close", exact: true }).click();
    await expect(reveal).toBeHidden();

    // the secret is gone from the DOM, URL and storage
    await expect(page.locator("body")).not.toContainText(secret);
    expect(page.url()).not.toContain(secret);
    const storage = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    expect(storage).not.toContain(secret);
    expect(idemKeys).toHaveLength(1);
    expect(idemKeys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ name: "e2e-primary", scopes: ["gateway:invoke"], spendCapMicrousd: "5500000" });

    const row = page.getByRole("list", { name: "API keys" }).getByRole("listitem").filter({ hasText: "e2e-primary" });
    await expect(row).toContainText("Active");
    await expect(row).toContainText(`${secret.slice(0, 8)}…`);
    await expect(row).toContainText("5.50 USD");
    await expect(row).toContainText("Never"); // last used

    // reload: list persists, secret never comes back
    await page.reload();
    await expect(row).toBeVisible();
    await expect(page.locator("body")).not.toContainText(secret);

    // the key really authenticates against the gateway (allowlist narrows model discovery to 1 model)
    expect(await gatewayModelsStatus(secret)).toEqual({ status: 200, count: 1 });

    // a second creation uses a different Idempotency-Key
    await page.getByRole("button", { name: "Create key" }).first().click();
    await dialog.getByLabel("Name", { exact: true }).fill("e2e-second");
    await dialog.getByRole("button", { name: "Create key" }).click();
    await expect(reveal).toBeVisible();
    await reveal.getByLabel("I have stored this key").check();
    await reveal.getByRole("button", { name: "Close", exact: true }).click();
    expect(idemKeys).toHaveLength(2);
    expect(idemKeys[1]).not.toBe(idemKeys[0]);

    // revoke: confirm dialog, focus starts on Cancel, effect announced
    await row.getByRole("button", { name: "Revoke e2e-primary" }).click();
    const rev = page.getByRole("dialog", { name: "Revoke this key?" });
    await expect(rev).toContainText("Requests using this key will fail immediately");
    await expect(rev.getByRole("button", { name: "Cancel" })).toBeFocused();
    await rev.getByRole("button", { name: "Revoke key" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Key e2e-primary revoked" })).toBeVisible();
    await expect(row).toContainText("Revoked");
    await expect(row.getByRole("button", { name: /Revoke/ })).toHaveCount(0);
    expect((await gatewayModelsStatus(secret)).status).toBe(401);
  });

  test("replayed create from a different session returns NON_RECOVERABLE and mints no second key (API-level)", async ({ page, context }) => {
    const w = newEvm();
    const first = await apiSignIn(w);
    await useSession(context, first.session);
    let idem = "";
    let payload = "";
    page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/keys")) { idem = r.headers()["idempotency-key"] ?? ""; payload = r.postData() ?? ""; } });
    await page.goto("/app/keys");
    await page.getByRole("button", { name: "Create key" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Create API key" });
    await dialog.getByLabel("Name", { exact: true }).fill("replay-me");
    await dialog.getByRole("button", { name: "Create key" }).click();
    const reveal = page.getByRole("dialog", { name: /Copy your key now/ });
    await reveal.getByLabel("I have stored this key").check();
    await reveal.getByRole("button", { name: "Close", exact: true }).click();

    const second = await apiSignIn(w); // same wallet, new session
    const res = await fetch(`${WEB_ORIGIN}/api/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN, Cookie: `session=${second.session}`, "Idempotency-Key": idem },
      body: payload,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ secretStatus: "NON_RECOVERABLE", secret: null });
    await page.reload();
    await expect(page.getByRole("list", { name: "API keys" }).getByRole("listitem")).toHaveCount(1);
  });

  test("(mocked API) NON_RECOVERABLE response shows the not-recoverable state and no secret", async ({ page, context }) => {
    const { session } = await apiSignIn(newEvm());
    await useSession(context, session);
    await page.route("**/api/keys", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({
        status: 201, contentType: "application/json",
        body: JSON.stringify({ key: { id: "key_x", name: "n", projectId: null, prefix: "sk_zzzzz", scopes: ["gateway:invoke"], modelAllowlist: [], spendCapMicrousd: null, expiresAt: null, createdAt: "2026-10-18T12:00:00Z", lastUsedAt: null, revokedAt: null }, secretStatus: "NON_RECOVERABLE", secret: null }),
      });
    });
    await page.goto("/app/keys");
    await page.getByRole("button", { name: "Create key" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Create API key" });
    await dialog.getByLabel("Name", { exact: true }).fill("n");
    await dialog.getByRole("button", { name: "Create key" }).click();
    const nr = page.getByRole("dialog", { name: "Secret not recoverable" });
    await expect(nr).toContainText("No second key was made");
    await expect(nr.getByTestId("secret")).toHaveCount(0);
  });

  test("(mocked API) STEP_UP_REQUIRED keeps the form and offers wallet re-verification", async ({ page, context }) => {
    const w = newEvm();
    const { session } = await apiSignIn(w);
    await useSession(context, session);
    await installWallet(page, w);
    let blocked = true;
    await page.route("**/api/keys", async (route) => {
      if (route.request().method() === "POST" && blocked) {
        return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "STEP_UP_REQUIRED", message: "Recent sign-in required", requestId: "req_s" } }) });
      }
      return route.continue();
    });
    await page.goto("/app/keys");
    await page.getByRole("button", { name: "Create key" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Create API key" });
    await dialog.getByLabel("Name", { exact: true }).fill("needs-step-up");
    await dialog.getByRole("button", { name: "Create key" }).click();
    await expect(dialog).toContainText("Sign in again to create keys");
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("needs-step-up");
    blocked = false;
    await dialog.getByRole("button", { name: "Sign in with an EVM wallet" }).click();
    await expect(dialog).not.toContainText("Sign in again to create keys");
    await dialog.getByRole("button", { name: "Create key" }).click();
    await expect(page.getByRole("dialog", { name: /Copy your key now/ })).toBeVisible();
  });

  test("(mocked API) list failure shows a retryable error region", async ({ page, context }) => {
    const { session } = await apiSignIn(newEvm());
    await useSession(context, session);
    let fail = true;
    await page.route("**/api/keys?*", (route) => fail
      ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "down", requestId: "req_503" } }) })
      : route.continue());
    await page.goto("/app/keys");
    await expect(page.getByRole("alert")).toContainText("Could not load keys");
    await expect(page.getByRole("alert")).toContainText("req_503");
    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { name: "No API keys yet" })).toBeVisible();
  });

  test("a member-role gap is not assumed: owner sees Overview active-key count update after creating a key", async ({ page, context }) => {
    const { session } = await apiSignIn(newEvm());
    await apiCreateKey(session, "seed");
    await useSession(context, session);
    await page.goto("/app");
    await expect(page.getByTestId("active-keys")).toHaveText("1");
    await expect(page.getByText("You have an active key.")).toBeVisible();
  });
});

test.describe("Security: linked identities (real API)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("last-method guard, link a TRON wallet, unlink it", async ({ page, context }) => {
    const evm = newEvm();
    const tron = newTron();
    const { session } = await apiSignIn(evm);
    await useSession(context, session);
    const mock = await installWallet(page, tron);
    await page.goto("/app/security");
    const list = page.getByRole("list", { name: "Linked wallets" });
    await expect(list).toContainText(new RegExp(evm.address, "i")); // server returns the canonical EIP-55 form
    const remove = page.getByRole("button", { name: /^Remove EVM wallet/ });
    await expect(remove).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("You cannot remove your only sign-in method")).toBeVisible();
    await remove.click({ force: true }); // aria-disabled: activation must be a no-op
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // declined link: usable, nothing linked
    await mock.rejectNextSign();
    await page.getByRole("button", { name: "Link a TRON wallet" }).click();
    await expect(page.getByRole("alert")).toContainText("Signature was declined");
    await expect(list.getByRole("listitem")).toHaveCount(1);

    await page.getByRole("button", { name: "Link a TRON wallet" }).click();
    await expect(page.getByRole("status").filter({ hasText: "TRON wallet linked" })).toBeVisible();
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list).toContainText(tron.address);

    // unlink the TRON wallet (not last method now)
    await page.getByRole("button", { name: /^Remove TRON wallet/ }).click();
    const dlg = page.getByRole("dialog", { name: "Remove this wallet?" });
    await expect(dlg.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dlg.getByRole("button", { name: "Remove wallet" }).click();
    await expect(page.getByRole("status").filter({ hasText: "TRON wallet removed" })).toBeVisible();
    await expect(list.getByRole("listitem")).toHaveCount(1);
  });

  test("linking a wallet that already belongs to another account is refused (no merge)", async ({ page, context }) => {
    const other = newTron();
    await apiSignIn(other); // creates the other account owning this TRON wallet
    const { session } = await apiSignIn(newEvm());
    await useSession(context, session);
    await installWallet(page, other);
    await page.goto("/app/security");
    await page.getByRole("button", { name: "Link a TRON wallet" }).click();
    await expect(page.getByRole("alert")).toContainText("Wallet already linked elsewhere");
    await expect(page.getByRole("list", { name: "Linked wallets" }).getByRole("listitem")).toHaveCount(1);
  });
});

test.describe("layout, themes and accessibility", () => {
  for (const vp of VIEWPORTS) {
    for (const tc of THEME_CASES.filter((t) => t.name === "light" || t.name === "dark")) {
      test.describe(`${vp.name} / ${tc.name}`, () => {
        test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: tc.os });

        test("sign-in, overview, keys (with dialogs) and security: no overflow, correct chrome, no axe violations", async ({ page, context }, info) => {
          await seedTheme(page, tc.pref);
          const axe = async (label: string) => {
            const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
            expect(r.violations.map((v) => `${label} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
            const { scrollWidth, clientWidth } = await noHorizontalOverflow(page);
            expect(scrollWidth, `${label} overflow`).toBeLessThanOrEqual(clientWidth);
            await page.screenshot({ path: info.outputPath(`${label}-${vp.name}-${tc.name}.png`), fullPage: true });
          };

          // signed out
          await installWallet(page, undefined);
          await page.goto("/app");
          await expect(page.locator("html")).toHaveAttribute("data-theme", tc.expected);
          await expect(evmSignIn(page)).toBeVisible();
          await evmSignIn(page).click(); // no wallet -> info banner
          await expect(page.getByRole("alert")).toContainText("No EVM wallet");
          await axe("signin");

          // signed in
          const { session } = await apiSignIn(newEvm());
          await apiCreateKey(session, "layout-key");
          await useSession(context, session);
          await page.goto("/app");
          await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
          await expect(page.getByTestId("available")).toBeVisible();
          if (vp.width < 1024) {
            await expect(page.getByRole("navigation", { name: "Console" }).last()).toBeVisible();
            await expect(page.locator(".console__rail")).toBeHidden();
          } else {
            await expect(page.locator(".console__rail")).toBeVisible();
            await expect(page.locator(".bottom-nav--console")).toBeHidden();
          }
          await axe("overview");

          await page.goto("/app/keys");
          await expect(page.getByRole("list", { name: "API keys" })).toContainText("layout-key");
          await axe("keys");
          await page.getByRole("button", { name: "Create key" }).first().click();
          await expect(page.getByRole("dialog", { name: "Create API key" })).toBeVisible();
          await axe("create-dialog");
          await page.keyboard.press("Escape");
          await expect(page.getByRole("dialog")).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Create key" }).first()).toBeFocused();

          await page.goto("/app/security");
          await expect(page.getByRole("heading", { level: 1, name: "Security" })).toBeVisible();
          await expect(page.getByRole("list", { name: "Linked wallets" })).toBeVisible();
          await axe("security");
        });
      });
    }
  }

  test("reveal dialog and revoke dialog pass axe at 390px", async ({ page, context }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { session } = await apiSignIn(newEvm());
    await apiCreateKey(session, "to-revoke");
    await useSession(context, session);
    await page.goto("/app/keys");
    await page.getByRole("button", { name: "Revoke to-revoke" }).click();
    await expect(page.getByRole("dialog", { name: "Revoke this key?" })).toBeVisible();
    const r1 = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(r1.violations.map((v) => v.id)).toEqual([]);
    await page.screenshot({ path: info.outputPath("revoke-dialog-390.png") });
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Create key" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Create API key" });
    await dialog.getByLabel("Name", { exact: true }).fill("shot");
    await dialog.getByRole("button", { name: "Create key" }).click();
    await expect(page.getByRole("dialog", { name: /Copy your key now/ })).toBeVisible();
    const r2 = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(r2.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join("|")}`)).toEqual([]);
    const { scrollWidth, clientWidth } = await noHorizontalOverflow(page);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});
