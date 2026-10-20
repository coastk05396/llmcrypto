/// <reference lib="dom" />
/**
 * Task 16 frontend against the REAL apps/api (in-memory PGlite): password, Telegram code (FakeTelegramBot plays the human
 * through the test-only control port), API-key restricted sessions, recovery codes, step-up, renewal and forced logout.
 * "(mocked API)" tests intercept one endpoint to reach a state this harness cannot produce (a deployment without a bot).
 * No real Telegram exists, so nothing here is evidence of real Telegram behaviour.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  WEB_ORIGIN, ageSessions, apiCall, apiCreateKey, apiPasswordSignup, apiSignIn, apiTelegramSignIn, chatCompletion, fundedAccount, shortenSessions,
  telegramSend, uniqDigits, uniqName, useSession,
} from "./api-helpers";
import { installWallet, newEvm } from "./wallet-mock";

const PW = "correct horse battery";
const otherWays = (page: Page) => page.locator("summary", { hasText: "Other ways to sign in" }).click();
const signOut = (page: Page) => page.getByRole("button", { name: "Sign out" }).first().click();

test.describe("password sign-in (real API)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("sign up shows recovery codes once, then sign-in works and failures are generic", async ({ page }) => {
    const username = uniqName("pw_user_");
    await page.goto("/app");
    await otherWays(page);
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(PW);
    await page.getByRole("button", { name: "Create account" }).click();

    // codes are shown once and Continue stays disabled until the user confirms they stored them
    const codes = page.getByTestId("recovery-codes");
    await expect(codes).toContainText("shown once");
    await expect(codes.getByRole("listitem")).toHaveCount(8);
    await expect(page.getByRole("button", { name: "Continue to console" })).toBeDisabled();
    await page.getByLabel("I have stored these recovery codes").check();
    await page.getByRole("button", { name: "Continue to console" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

    // codes are not retrievable again: Security shows only the count
    await page.goto("/app/security");
    await expect(page.getByTestId("unused-codes")).toHaveText("8");
    await expect(page.getByTestId("recovery-codes")).toHaveCount(0);
    await expect(page.getByTestId("session-kind")).toHaveText("password");

    await signOut(page);
    await expect(page.getByText("Signed out")).toBeVisible();
    await otherWays(page);
    // wrong password: one generic message
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill("definitely the wrong one");
    await page.getByRole("button", { name: "Sign in with password" }).click();
    await expect(page.getByRole("alert")).toContainText("The username or password is incorrect.");
    // unknown user: identical message (no account enumeration)
    await page.getByLabel("Username").fill(uniqName("nobody_"));
    await page.getByRole("button", { name: "Sign in with password" }).click();
    await expect(page.getByRole("alert")).toContainText("The username or password is incorrect.");
    // correct password signs in
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(PW);
    await page.getByRole("button", { name: "Sign in with password" }).click();
    // sign-in returns to the page that was asked for (Security, where the visitor signed out)
    await expect(page.getByRole("heading", { level: 1, name: "Security" })).toBeVisible();
  });

  test("repeated failures hit 429 and the wait message; even the correct password is refused until it passes", async ({ page }) => {
    const username = uniqName("pw_limited_");
    await apiPasswordSignup(username, PW);
    await page.goto("/app");
    await otherWays(page);
    const attempt = async (pw: string) => {
      await page.getByLabel("Username").fill(username);
      await page.getByLabel("Password", { exact: true }).fill(pw);
      await page.getByRole("button", { name: "Sign in with password" }).click();
    };
    for (let i = 0; i < 5; i++) {
      await attempt("wrong password number " + i);
      await expect(page.getByRole("alert")).toContainText("incorrect");
    }
    await attempt("wrong password number 6");
    await expect(page.getByRole("alert")).toContainText("Too many attempts");
    await expect(page.getByRole("alert")).toContainText(/Wait \d+ (seconds?|minutes?|hours?)/);
    await attempt(PW);
    await expect(page.getByRole("alert")).toContainText("Too many attempts");
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  });

  test("recovery code sets a new password once; the old password and the spent code stop working", async ({ page }) => {
    const username = uniqName("pw_recover_");
    const { recoveryCodes } = await apiPasswordSignup(username, PW);
    await page.goto("/app");
    await otherWays(page);
    await page.getByRole("button", { name: "Use a recovery code" }).click();
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Recovery code").fill(recoveryCodes[0]!);
    await page.getByLabel("New password").fill("a brand new passphrase");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByText("Password changed")).toBeVisible();

    // the same code a second time is refused with a generic message
    await page.getByRole("button", { name: "Use a recovery code" }).click();
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Recovery code").fill(recoveryCodes[0]!);
    await page.getByLabel("New password").fill("yet another passphrase");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByRole("alert")).toContainText("Recovery failed");

    await page.getByRole("button", { name: "Back to sign in" }).click();
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(PW);
    await page.getByRole("button", { name: "Sign in with password" }).click();
    await expect(page.getByRole("alert")).toContainText("incorrect");
    await page.getByLabel("Password", { exact: true }).fill("a brand new passphrase");
    await page.getByRole("button", { name: "Sign in with password" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  });
});

test.describe("Telegram code sign-in (FakeTelegramBot)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("code is shown, unverified until sent to the bot, then signs in", async ({ page }) => {
    const sender = uniqDigits();
    await page.goto("/app");
    await otherWays(page);
    await page.getByRole("button", { name: "Get a Telegram code" }).click();
    const code = (await page.getByTestId("telegram-code").textContent())!.trim();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await page.getByRole("button", { name: "Verify code" }).click();
    await expect(page.getByRole("alert")).toContainText("Code not verified");
    await telegramSend(sender, code);
    await page.getByRole("button", { name: "Verify code" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    await page.goto("/app/security");
    await expect(page.getByRole("list", { name: "Linked Telegram accounts" })).toContainText(sender);
    await expect(page.getByTestId("session-kind")).toHaveText("telegram");
  });

  test("(mocked API) a deployment without a bot answers 503 and the UI says it is not configured", async ({ page }) => {
    await page.route("**/api/auth/telegram/codes", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "Telegram sign-in is not configured", requestId: "req_tg" } }) }));
    await page.goto("/app");
    await otherWays(page);
    await page.getByRole("button", { name: "Get a Telegram code" }).click();
    await expect(page.getByRole("alert")).toContainText("Telegram is not configured");
    // the other methods remain usable
    await expect(page.getByRole("button", { name: "Sign in with password" })).toBeVisible();
  });
});

test.describe("API-key restricted console session (real API)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("opens only the key's own usage; everything else is hidden or blocked and the API agrees", async ({ page, context }) => {
    const { session } = await fundedAccount("5000000");
    const key = await apiCreateKey(session, "restricted-viewer", { scopes: ["usage:read", "gateway:invoke"] });
    expect((await chatCompletion(key.secret, "hello from the restricted key")).status).toBe(200);
    const other = await apiCreateKey(session, "other-key");
    expect((await chatCompletion(other.secret, "this belongs to another key")).status).toBe(200);

    await page.goto("/app");
    await otherWays(page);
    // a wrong key is refused with a plain message
    await page.getByLabel("API key", { exact: true }).fill("sk_not_a_real_key_0000000000");
    await page.getByRole("button", { name: "Open restricted view" }).click();
    await expect(page.getByRole("alert")).toContainText("Key not accepted");
    // the secret is masked until shown
    await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "text");
    await page.getByLabel("API key", { exact: true }).fill(key.secret);
    await page.getByRole("button", { name: "Open restricted view" }).click();

    // lands on Usage with the restricted banner; only that key's request is visible
    await expect(page.getByRole("heading", { level: 1, name: "Usage and logs" })).toBeVisible();
    await expect(page.getByTestId("restricted-banner")).toContainText("Restricted session (API key)");
    await expect(page.getByTestId("usage-table").getByRole("row")).toHaveCount(2); // header + 1
    await expect(page.getByTestId("export-unavailable")).toBeVisible();
    await expect(page.getByRole("button", { name: /export/i })).toHaveCount(0);

    // navigation offers only what works
    const nav = page.getByRole("navigation", { name: "Console" }).first();
    await expect(nav.getByRole("link")).toHaveText(["Usage", "Agent runs"]);
    await expect(page.getByRole("link", { name: "Credits" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "API keys" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Security" })).toHaveCount(0);

    // restricted pages reached by URL explain themselves and never call the blocked API
    const blocked: string[] = [];
    page.on("request", (r) => { if (/\/api\/(keys|accounts|auth\/methods|projects|optimization|connectivity)/.test(r.url())) blocked.push(r.url()); });
    for (const path of ["/app/keys", "/app/credits", "/app/security", "/app/memory", "/app/tuning", "/app/context", "/app/connectivity"]) {
      await page.goto(path);
      await expect(page.getByTestId("restricted-block")).toBeVisible();
    }
    expect(blocked).toEqual([]);
    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 1, name: "Usage and logs" })).toBeVisible(); // index redirects

    // the server enforces the same boundary independent of the UI
    const bal = await context.request.get(`${WEB_ORIGIN}/api/accounts/current/balance`);
    expect(bal.status()).toBe(403);
    const keys = await context.request.get(`${WEB_ORIGIN}/api/keys`);
    expect(keys.status()).toBe(403);
  });
});

test.describe("Security: password, recovery codes, Telegram link (real API)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("add a password to a wallet account, see codes once, regenerate, then remove it", async ({ page, context }) => {
    const w = newEvm();
    const { session } = await apiSignIn(w);
    await useSession(context, session);
    await page.goto("/app/security");
    const username = uniqName("added_pw_");
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill("too short");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByRole("alert")).toContainText("Check the details");
    await page.getByLabel("Password", { exact: true }).fill(PW);
    await page.getByRole("button", { name: "Set password" }).click();

    const dlg = page.getByRole("dialog", { name: "Your recovery codes" });
    await expect(dlg.getByRole("listitem")).toHaveCount(8);
    await page.keyboard.press("Escape"); // cannot be dismissed without confirming storage
    await expect(dlg).toBeVisible();
    await dlg.getByLabel("I have stored these recovery codes").check();
    await dlg.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("unused-codes")).toHaveText("8");
    expect((await apiCall(session, "GET", "/api/auth/methods")).json["password"]["username"]).toBe(username);

    // regenerate: new codes shown once; old ones are invalidated server side
    await page.getByRole("button", { name: "New recovery codes" }).click();
    const dlg2 = page.getByRole("dialog", { name: "Your recovery codes" });
    await expect(dlg2.getByRole("listitem")).toHaveCount(8);
    await dlg2.getByLabel("I have stored these recovery codes").check();
    await dlg2.getByRole("button", { name: "Done" }).click();

    // remove the password (the wallet remains, so it is not the last method)
    await page.getByRole("button", { name: "Remove password" }).click();
    const rm = page.getByRole("dialog", { name: "Remove the password?" });
    await expect(rm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await rm.getByRole("button", { name: "Remove password" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Password removed" })).toBeVisible();
    expect((await apiCall(session, "GET", "/api/auth/methods")).json["password"]).toBeNull();
    await installWallet(page, w);
  });

  test("link and unlink a Telegram account; the last-method guard blocks removing the only method", async ({ page, context }) => {
    const { session } = await apiSignIn(newEvm());
    await useSession(context, session);
    await page.goto("/app/security");
    await page.getByRole("button", { name: "Get a Telegram code" }).click();
    const code = (await page.getByTestId("telegram-code").textContent())!.trim();
    const sender = uniqDigits();
    await telegramSend(sender, code);
    await page.getByRole("button", { name: "Verify and link" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Telegram account linked" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Linked Telegram accounts" })).toContainText(sender);

    await page.getByRole("button", { name: `Remove Telegram account ${sender}` }).click();
    await page.getByRole("dialog", { name: "Remove this Telegram account?" }).getByRole("button", { name: "Remove Telegram" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Telegram account removed" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Linked Telegram accounts" })).toHaveCount(0);

    // a Telegram-only account cannot remove its only method
    const tg = await apiTelegramSignIn(uniqDigits());
    await useSession(context, tg.session);
    await page.goto("/app/security");
    const only = page.getByRole("button", { name: /^Remove Telegram account/ });
    await expect(only).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("You cannot remove your only sign-in method")).toBeVisible();
  });

  test("removing the method this session used ends the session and the UI says why", async ({ page, context }) => {
    const w = newEvm();
    const { session } = await apiSignIn(w);
    const username = uniqName("forced_out_");
    expect((await apiCall(session, "POST", "/api/auth/password", { username, password: PW })).status).toBe(201);
    await context.clearCookies();
    await page.goto("/app");
    await otherWays(page);
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(PW);
    await page.getByRole("button", { name: "Sign in with password" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    await page.goto("/app/security");
    await page.getByRole("button", { name: "Remove password" }).click();
    await page.getByRole("dialog", { name: "Remove the password?" }).getByRole("button", { name: "Remove password" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await expect(page.getByText("You removed the sign-in method this session used")).toBeVisible();
    // the wallet session set up through the API is a different session and is unaffected
    expect((await apiCall(session, "GET", "/api/session")).status).toBe(200);
  });
});

test.describe("step-up (real API; sessions aged through the test-only control port)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("password session: wrong password is refused generically, correct one lets the retry succeed", async ({ page, context }) => {
    const { session, accountId } = await apiPasswordSignup(uniqName("stepup_pw_"), PW);
    await useSession(context, session);
    await ageSessions(accountId);
    await page.goto("/app/security");
    await page.getByRole("button", { name: "New recovery codes" }).click();
    const panel = page.getByTestId("step-up");
    await expect(panel).toContainText("Verify it is you");
    await panel.getByLabel("Confirm your password").fill("not my password at all");
    await panel.getByRole("button", { name: "Verify" }).click();
    await expect(panel).toContainText("That did not verify");
    await panel.getByLabel("Confirm your password").fill(PW);
    await panel.getByRole("button", { name: "Verify" }).click();
    await expect(panel).toHaveCount(0);
    await page.getByRole("button", { name: "New recovery codes" }).click();
    await expect(page.getByRole("dialog", { name: "Your recovery codes" }).getByRole("listitem")).toHaveCount(8);
  });

  test("wallet session: step-up is a fresh wallet signature, entries are kept", async ({ page, context }) => {
    const w = newEvm();
    const { session, accountId } = await apiSignIn(w);
    await useSession(context, session);
    await installWallet(page, w);
    await ageSessions(accountId);
    await page.goto("/app/security");
    const username = uniqName("stepup_wallet_");
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(PW);
    await page.getByRole("button", { name: "Set password" }).click();
    const panel = page.getByTestId("step-up");
    await expect(panel).toContainText("Verify it is you");
    await panel.getByRole("button", { name: "Sign in with an EVM wallet" }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByLabel("Username")).toHaveValue(username); // the form survived
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByRole("dialog", { name: "Your recovery codes" })).toBeVisible();
  });

  test("Telegram session: step-up needs a new code sent to the bot", async ({ page, context }) => {
    const sender = uniqDigits();
    const { session, accountId } = await apiTelegramSignIn(sender);
    await useSession(context, session);
    await ageSessions(accountId);
    await page.goto("/app/security");
    await page.getByLabel("Username").fill(uniqName("stepup_tg_"));
    await page.getByLabel("Password", { exact: true }).fill(PW);
    await page.getByRole("button", { name: "Set password" }).click();
    const panel = page.getByTestId("step-up");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Get a Telegram code" }).click();
    await telegramSend(sender, (await panel.getByTestId("telegram-code").textContent())!.trim());
    await panel.getByRole("button", { name: "Verify code" }).click();
    await expect(page.getByTestId("step-up")).toHaveCount(0);
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByRole("dialog", { name: "Your recovery codes" })).toBeVisible();
  });
});

test.describe("session renewal (real API)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a session about to end offers Extend and the warning goes away once the server extends it", async ({ page, context }) => {
    const { session, accountId } = await apiSignIn(newEvm());
    await useSession(context, session);
    await shortenSessions(accountId, 120);
    await page.goto("/app");
    const banner = page.getByTestId("session-expiry");
    await expect(banner).toContainText(/Your session ends in about [12] minutes?/);
    const renewed = page.waitForResponse((r) => r.url().endsWith("/api/session/renew") && r.status() === 200);
    await banner.getByRole("button", { name: "Extend session" }).click();
    await renewed;
    await expect(page.getByTestId("session-expiry")).toHaveCount(0);
    // the rotated cookie keeps working
    await page.goto("/app/keys");
    await expect(page.getByRole("heading", { level: 1, name: "API keys" })).toBeVisible();
  });
});
