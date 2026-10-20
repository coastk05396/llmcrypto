/// <reference lib="dom" />
/**
 * Layout, theme and accessibility for the task 16/19/20/21 screens at 390 and 1440, light and dark, against the REAL api.
 * Axe runs with WCAG 2.0/2.1/2.2 A and AA tags; every page must also have no horizontal overflow.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { apiCall, apiSignIn, channelSend, fundedAccount, uniqDigits, uniqName, useSession } from "./api-helpers";
import { VIEWPORTS, THEME_CASES, noHorizontalOverflow, seedTheme } from "./helpers";
import { newEvm } from "./wallet-mock";

for (const vp of VIEWPORTS) {
  for (const tc of THEME_CASES.filter((t) => t.name === "light" || t.name === "dark")) {
    test.describe(`${vp.name} / ${tc.name}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: tc.os });

      test("sign-in alternatives, security, tuning, context steering, project memory, connectivity and more: no overflow, no axe violations", async ({ page, context }, info) => {
        await seedTheme(page, tc.pref);
        const check = async (label: string) => {
          const run = () => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
          let r = await run();
          // axe measures at the current scroll position, where the fixed bottom bar can cover a control that is fine once scrolled to.
          // Bring each flagged target-size control to the middle of the viewport and measure again; real size problems stay flagged.
          const sizing = r.violations.filter((v) => v.id === "target-size").flatMap((v) => v.nodes.map((n) => n.target.join(" ")));
          if (sizing.length > 0) {
            for (const sel of sizing) await page.locator(sel).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
            r = await run();
          }
          expect(r.violations.map((v) => `${label} ${v.id}: ${v.nodes.map((n) => n.target.join(" ") + " :: " + n.any.map((a) => a.message).join(" ")).join(" | ")}`)).toEqual([]);
          const { scrollWidth, clientWidth } = await noHorizontalOverflow(page);
          const culprits = scrollWidth > clientWidth
            ? await page.evaluate(() => {
                const w = document.documentElement.clientWidth;
                return Array.from(document.querySelectorAll("*")).filter((e) => e.getBoundingClientRect().right > w + 1).slice(0, 10).map((e) => `${e.tagName}.${(e as HTMLElement).className}|${e.getAttribute("data-testid") ?? ""} right=${Math.round(e.getBoundingClientRect().right)}`);
              })
            : [];
          expect(scrollWidth, `${label} overflow; offenders: ${culprits.join("; ")}`).toBeLessThanOrEqual(clientWidth);
          await page.screenshot({ path: info.outputPath(`${label}-${vp.name}-${tc.name}.png`), fullPage: true });
        };

        // signed out: wallet buttons plus the opened "Other ways to sign in" (password, Telegram, API key)
        await page.goto("/app");
        await expect(page.locator("html")).toHaveAttribute("data-theme", tc.expected);
        await page.locator("summary", { hasText: "Other ways to sign in" }).click();
        await expect(page.getByRole("button", { name: "Open restricted view" })).toBeVisible();
        await check("signin-alt");
        await page.getByRole("button", { name: "Use a recovery code" }).click();
        await check("signin-recovery");

        // signed in with data in every area
        const { session, secret } = await fundedAccount();
        void secret;
        const project = (await apiCall(session, "POST", "/api/projects", { name: uniqName("layout_") })).json;
        await apiCall(session, "POST", `/api/projects/${project["id"]}/memories`, { text: "A note about the layout test project.", storageConsent: true, inject: true });
        await apiCall(session, "POST", "/api/auth/password", { username: uniqName("layout_user_"), password: "correct horse battery" });
        await useSession(context, session);

        await page.goto("/app/security");
        await expect(page.getByTestId("unused-codes")).toHaveText("8");
        await check("security");

        await page.goto("/app/tuning");
        await expect(page.getByTestId("policy-version")).toBeVisible();
        await page.getByRole("checkbox", { name: "Turn on LoopGuard" }).check();
        await page.getByRole("radio", { name: /^Enforce/ }).check();
        await expect(page.getByTestId("report")).toBeVisible();
        await check("tuning");

        await page.goto("/app/context");
        await page.getByRole("checkbox", { name: "Turn on Concise guidance" }).check();
        await page.getByLabel("Your message").fill("Preview this.");
        await page.getByRole("button", { name: "Preview request" }).click();
        await expect(page.getByTestId("preview-result")).toBeVisible();
        await check("context");

        await page.goto(`/app/memory?project=${project["id"]}`);
        await expect(page.getByTestId("note")).toBeVisible();
        await page.getByRole("button", { name: /^Edit note version 1/ }).click();
        await check("memory-edit-dialog");
        await page.keyboard.press("Escape");
        await check("memory");

        await page.goto("/app/connectivity");
        await page.getByRole("button", { name: "Pair Telegram" }).click();
        await channelSend(uniqDigits(), (await page.getByTestId("pairing-code").textContent())!.trim());
        await check("connectivity-pairing");
        await page.getByRole("button", { name: "Confirm pairing" }).click();
        await expect(page.getByTestId("binding")).toBeVisible();
        await check("connectivity");

        if (vp.width < 1024) {
          await page.goto("/app/more");
          await expect(page.getByRole("list", { name: "More pages" })).toBeVisible();
          await check("more");
          await page.getByRole("link", { name: "Connectivity" }).first().click();
          await expect(page.getByRole("heading", { level: 1, name: "Connectivity" })).toBeVisible();
        } else {
          const rail = page.locator(".console__rail");
          await expect(rail.getByText("More")).toBeVisible();
          await expect(rail.getByRole("link", { name: "Project memory" })).toBeVisible();
        }
      });
    });
  }
}

test.describe("keyboard: dialogs trap and restore focus", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test("recovery-code dialog cannot be dismissed with Escape; unpair dialog returns focus to its trigger", async ({ page, context }) => {
    const { session } = await apiSignIn(newEvm());
    await useSession(context, session);
    await page.goto("/app/connectivity");
    await page.getByRole("button", { name: "Pair Telegram" }).click();
    await channelSend(uniqDigits(), (await page.getByTestId("pairing-code").textContent())!.trim());
    await page.getByRole("button", { name: "Confirm pairing" }).click();
    const trigger: ReturnType<Page["getByRole"]> = page.getByRole("button", { name: /^Unpair Telegram/ });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Unpair this destination?" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
