/// <reference lib="dom" />
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { BG, THEME_CASES, VIEWPORTS, apiUnreachable, noHorizontalOverflow, seedTheme } from "./helpers";

const ROUTES = ["/", "/setup", "/diag", "/docs", "/app", "/does-not-exist"];

async function expectNoOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await noHorizontalOverflow(page);
  expect(scrollWidth, "document scrollWidth").toBeLessThanOrEqual(clientWidth);
}

for (const vp of VIEWPORTS) {
  for (const tc of THEME_CASES) {
    test.describe(`${vp.name} / ${tc.name}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: tc.os });

      test.beforeEach(async ({ page }) => {
        await apiUnreachable(page);
        await seedTheme(page, tc.pref);
      });

      test("resolves the theme on first paint and every route has no horizontal overflow", async ({ page }) => {
        for (const route of ROUTES) {
          await page.goto(route);
          await expect(page.locator("h1").first()).toBeVisible();
          await expect(page.locator("html")).toHaveAttribute("data-theme", tc.expected);
          await expect(page.locator("html")).toHaveAttribute("data-theme-pref", tc.pref);
          await expectNoOverflow(page);
        }
      });

      test("home has no automated accessibility violations (axe, incl. contrast)", async ({ page }) => {
        await page.goto("/");
        await expect(page.getByRole("heading", { name: "Model catalog" })).toBeVisible();
        await expect(page.getByText("Sample data").first()).toBeVisible();
        const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
      });
    });
  }
}

test.describe("theme behaviour", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("pre-paint script sets the theme even when the app bundle never loads (no flash)", async ({ page }) => {
    await page.route("**/assets/*.js", (r) => r.abort());
    for (const [os, expected] of [["dark", "dark"], ["light", "light"]] as const) {
      await page.emulateMedia({ colorScheme: os });
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-theme", expected);
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(BG[expected]);
    }
  });

  test("an explicit choice persists across reload and ignores the OS; System follows the OS live", async ({ page }) => {
    await apiUnreachable(page);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    const footerTheme = page.locator("footer").getByRole("radiogroup", { name: "Theme" });
    await expect(page.locator("html")).toHaveAttribute("data-theme-pref", "system");
    await expect(footerTheme.getByRole("radio", { name: "System" })).toBeChecked();

    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await footerTheme.getByText("Light", { exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" }); // OS changes, explicit choice must hold
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await page.evaluate(() => localStorage.getItem("theme-preference"))).toBe("light");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("footer").getByRole("radio", { name: "Light" })).toBeChecked();

    await page.locator("footer").getByText("System", { exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("theme-preference"))).toBe("system");
  });

  test("works when storage is blocked", async ({ page }) => {
    await apiUnreachable(page);
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } });
    });
    await page.goto("/");
    await page.locator("footer").getByText("Dark", { exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("theme control is keyboard operable with arrow keys", async ({ page }) => {
    await apiUnreachable(page);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    const header = page.locator("header").getByRole("radiogroup", { name: "Theme" });
    await header.getByRole("radio", { name: "System" }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(header.getByRole("radio", { name: "Dark" })).toBeChecked();
    await page.keyboard.press("ArrowLeft");
    await expect(header.getByRole("radio", { name: "Light" })).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});

test.describe("catalog (sample fallback)", () => {
  test.use({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  test.beforeEach(async ({ page }) => {
    await apiUnreachable(page);
    await page.goto("/");
  });

  test("labels fallback data as sample and lists every sample model", async ({ page }) => {
    await expect(page.getByText("Sample data").first()).toBeVisible();
    await expect(page.getByTestId("result-count")).toHaveText("Showing all 6 models");
    await expect(page.locator("#catalog tbody tr")).toHaveCount(6);
    await expect(page.locator("#catalog")).toContainText("source: web-bundled-sample");
  });

  test("filters by provider and search, shows an empty state, and clears it", async ({ page }) => {
    await page.getByLabel("Provider").selectOption("sample-beta");
    await expect(page.locator("#catalog tbody tr")).toHaveCount(2);
    await expect(page.getByTestId("result-count")).toHaveText("Showing 2 of 6 models");

    await page.getByLabel("Search models").fill("REASON");
    await expect(page.locator("#catalog tbody tr")).toHaveCount(1);
    await expect(page.locator("#catalog tbody")).toContainText("beta-reason");

    await page.getByLabel("Search models").fill("zzz-nothing");
    await expect(page.getByTestId("catalog-empty")).toContainText('No models match "zzz-nothing"');
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.locator("#catalog tbody tr")).toHaveCount(6);
    await expect(page.getByLabel("Search models")).toBeFocused();
  });

  test("copy ID puts exactly the displayed ID on the clipboard and announces it", async ({ page }) => {
    const row = page.locator("#catalog tbody tr", { hasText: "alpha-large" }).first();
    const shown = (await row.locator("code").first().textContent()) ?? "";
    await row.getByRole("button", { name: "Copy ID model ID alpha-large" }).click();
    await expect(row.getByRole("button")).toContainText("Copied");
    await expect(row.getByRole("status")).toHaveText("Copied model ID alpha-large");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
    await expect(row.getByRole("button")).toContainText("Copy ID", { timeout: 4000 });
  });

  test("copy failure is reported and the text is selected", async ({ page }) => {
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", { value: () => Promise.reject(new Error("denied")) });
      document.execCommand = () => false;
    });
    const row = page.locator("#catalog tbody tr", { hasText: "gamma-mini" }).first();
    await row.getByRole("button", { name: /Copy ID/ }).click();
    await expect(row.getByRole("status")).toContainText("Copy failed");
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("gamma-mini");
  });
});

test.describe("catalog from a mocked API", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test("renders contract-shaped data without the sample label (mock, not integration evidence)", async ({ page }) => {
    await page.route("**/api/catalog", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          pricingVersion: "pv_mock",
          items: [{ id: "mock-model", provider: "mock-provider", displayName: "Mock Model", protocols: ["openai_chat"], inputMicrousdPerMtok: "3000000", cachedInputMicrousdPerMtok: null, outputMicrousdPerMtok: "15000000", contextWindowTokens: "200000", updatedAt: "2026-10-18T12:00:00Z", source: "mock" }],
        }),
      }),
    );
    await page.goto("/");
    await expect(page.locator("#catalog tbody tr")).toHaveCount(1);
    await expect(page.locator("#catalog")).toContainText("$3.00");
    await expect(page.locator("#catalog")).toContainText("$15.00");
    await expect(page.locator("#catalog")).toContainText("200K");
    await expect(page.locator("#catalog")).not.toContainText("Sample data");
    await expect(page.locator("#catalog")).toContainText("pv_mock");
  });

  test("falls back to sample data when the API returns HTML or a malformed body", async ({ page }) => {
    await page.route("**/api/catalog", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<html></html>" }));
    await page.goto("/");
    await expect(page.getByText("Sample data").first()).toBeVisible();
    await expect(page.locator("#catalog")).toContainText("answered with something this page does not understand");
  });
});

test.describe("quickstart", () => {
  test.use({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  test("tabs follow the ARIA pattern; samples use placeholders and our own /v1 endpoint; copy matches display", async ({ page }) => {
    await apiUnreachable(page);
    await page.goto("/#quickstart");
    const tabs = page.getByRole("tablist", { name: "Quickstart language" });
    const first = tabs.getByRole("tab", { name: "Anthropic SDK" });
    await first.focus();
    await expect(first).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowRight");
    await expect(tabs.getByRole("tab", { name: "OpenAI SDK" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    const curl = tabs.getByRole("tab", { name: "cURL" });
    await expect(curl).toBeFocused();
    const panel = page.getByRole("tabpanel", { name: "cURL" });
    const code = (await panel.locator("code").textContent()) ?? "";
    expect(code).toContain("YOUR_API_KEY");
    expect(code).toContain("http://127.0.0.1:4173/v1/chat/completions");
    await panel.getByRole("button", { name: /Copy cURL example/ }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
    await expect(panel.getByRole("status")).toHaveText("Copied cURL example");
  });
});

for (const width of [320, 390, 768, 1024, 1440, 1920]) {
  for (const theme of ["light", "dark"] as const) {
    test(`numbered instructions keep text beside the number at ${width}px / ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await seedTheme(page, theme);
      await apiUnreachable(page);
      await page.goto("/#quickstart");
      const steps = page.locator("#quickstart .steps li, #billing .steps li");
      await expect(steps).toHaveCount(6);
      for (const step of await steps.all()) {
        const misplaced = await step.evaluate((item) => {
          const left = item.querySelector("strong")!.getBoundingClientRect().left;
          const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
          const failures: string[] = [];
          let node = walker.nextNode();
          while (node) {
            if (node.textContent?.trim()) {
              const range = document.createRange();
              range.selectNodeContents(node);
              if (Array.from(range.getClientRects()).some((rect) => rect.left < left - 1)) failures.push(node.textContent);
            }
            node = walker.nextNode();
          }
          return failures;
        });
        expect(misplaced, "instruction text must not fall into the number column").toEqual([]);
      }
      const tabSize = await page.locator("#quickstart .tabs__list").evaluate((list) => ({ height: list.clientHeight, content: list.scrollHeight }));
      expect(tabSize.content, "tabs must not have a one-pixel vertical scrollbar").toBeLessThanOrEqual(tabSize.height);
      await expectNoOverflow(page);
    });
  }
}

test.describe("navigation at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test.beforeEach(async ({ page }) => {
    await apiUnreachable(page);
    await page.goto("/");
  });

  test("mobile menu moves focus in, traps Tab, closes on Escape and restores focus", async ({ page }) => {
    const menuBtn = page.locator('button[aria-controls="mobile-menu"]');
    await menuBtn.click();
    const dialog = page.getByRole("dialog", { name: "Menu" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Menu" })).toBeFocused();
    await expect(menuBtn).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".page")).toHaveAttribute("inert", "");

    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => {
        const a = document.activeElement;
        return !!a && (a.closest("#mobile-menu") !== null || a.closest("header") !== null);
      });
      expect(inside, `focus escaped after ${i + 1} Tab presses`).toBe(true);
      seen.add(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""));
    }
    expect(seen.has("Diagnostics")).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(menuBtn).toBeFocused();
    await expect(menuBtn).toHaveAttribute("aria-expanded", "false");
  });

  test("menu link navigates, closes the menu and lands on the new page", async ({ page }) => {
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("dialog").getByRole("link", { name: "Setup" }).click();
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connect your tools");
    await expect(page).toHaveTitle(/Setup guides/);
  });

  test("theme control is in the menu and in the footer", async ({ page }) => {
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("dialog").getByText("Dark", { exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.keyboard.press("Escape");
    await expect(page.locator("footer").getByRole("radiogroup", { name: "Theme" })).toBeVisible();
  });

  test("bottom navigation is visible, does not cover the footer and links work", async ({ page }) => {
    const bottom = page.getByRole("navigation", { name: "Quick navigation" });
    await expect(bottom).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const lastLink = page.locator("footer").getByRole("link", { name: "Sign in" });
    await lastLink.scrollIntoViewIfNeeded();
    const navTop = (await bottom.boundingBox())!.y;
    const footerBottom = await page.locator("footer").evaluate((el) => el.getBoundingClientRect().bottom);
    expect(footerBottom).toBeLessThanOrEqual(navTop + 1);
    await bottom.getByRole("link", { name: "Docs" }).click();
    await expect(page).toHaveURL(/\/docs$/);
    await expect(bottom.getByRole("link", { name: "Docs" })).toHaveAttribute("aria-current", "page");
  });

  test("keyboard focus is never hidden behind the sticky header or bottom nav", async ({ page }) => {
    const bottom = page.getByRole("navigation", { name: "Quick navigation" });
    const header = page.locator("header");
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press("Tab");
      const box = await page.evaluate(() => {
        const r = document.activeElement?.getBoundingClientRect();
        return r ? { top: r.top, bottom: r.bottom, h: r.height } : null;
      });
      if (!box || box.h === 0) continue;
      const hBottom = (await header.boundingBox())!.y + (await header.boundingBox())!.height;
      const nTop = (await bottom.boundingBox())!.y;
      const inBottom = await page.evaluate(() => !!document.activeElement?.closest(".bottom-nav, header, .skip-link") || document.activeElement?.classList.contains("skip-link"));
      if (inBottom) continue;
      if (box.h > 300) {
        // Tall scroll region: it can only be partly in view; some of it must be clear of both bars.
        expect(box.bottom).toBeGreaterThan(hBottom + 20);
        expect(box.top).toBeLessThan(nTop - 20);
        continue;
      }
      const who = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120));
      expect(box.top, `focused element under header: ${who}`).toBeGreaterThanOrEqual(hBottom - 1);
      expect(box.bottom, "focused element under bottom nav").toBeLessThanOrEqual(nTop + 1);
    }
  });
});

test.describe("skip link, FAQ, reduced motion", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("skip link is the first tab stop and focuses main", async ({ page }) => {
    await apiUnreachable(page);
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
  });

  test("FAQ uses details/summary and toggles with the keyboard", async ({ page }) => {
    await apiUnreachable(page);
    await page.goto("/#faq");
    const summary = page.getByText("Is the gateway live?");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("details", { hasText: "Is the gateway live?" })).toHaveAttribute("open", "");
  });

  test("reduced motion removes transitions and smooth scrolling", async ({ page }) => {
    await apiUnreachable(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const d = await page.evaluate(() => {
      const s = document.querySelector(".faq summary");
      return parseFloat(getComputedStyle(s!, "::after").transitionDuration);
    });
    expect(d).toBeLessThan(0.01);
    await page.getByRole("link", { name: "Browse models" }).click();
    await expect(page.locator("#catalog")).toBeFocused();
  });

  test("normal motion keeps the 200 ms disclosure transition", async ({ page }) => {
    await apiUnreachable(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    const d = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".faq summary")!, "::after").transitionDuration));
    expect(d).toBeCloseTo(0.2, 2);
  });
});

test.describe("links", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test("every internal link and hash target resolves on every route", async ({ page }) => {
    await apiUnreachable(page);
    const targets = new Set<string>();
    for (const route of ["/", "/setup", "/diag", "/docs", "/app"]) {
      await page.goto(route);
      await expect(page.locator("h1").first()).toBeVisible();
      const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""));
      for (const h of hrefs) targets.add(new URL(h, `http://x${route === "/" ? "/" : route}`).pathname + (h.includes("#") ? "#" + h.split("#")[1] : ""));
      for (const h of hrefs) {
        expect(h, `placeholder href on ${route}`).not.toBe("#");
        expect(h.startsWith("http"), `external link on ${route}: ${h}`).toBe(false);
      }
    }
    for (const t of targets) {
      const [path = "/", hash] = t.split("#");
      await page.goto(path || "/");
      await expect(page.locator("h1").first(), `page for ${t}`).not.toHaveText("Page not found");
      if (hash) expect(await page.locator(`[id="${hash}"]`).count(), `hash target #${hash} on ${path}`).toBe(1);
    }
  });

  test("unknown routes render the 404 page with a way home", async ({ page }) => {
    await apiUnreachable(page);
    await page.goto("/no/such/page");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
    await page.getByRole("link", { name: "Go to the home page" }).click();
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe("setup guides", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test("every guide is labelled documentation only, uses placeholders and has no download", async ({ page }) => {
    await apiUnreachable(page);
    await page.goto("/setup");
    const badges = page.locator(".badge", { hasText: "Documentation only" });
    expect(await badges.count()).toBe(5);
    await expect(page.getByText("Tested with our service", { exact: true })).toHaveCount(0);
    await expect(page.locator("a[download], a[href$='.sh'], a[href$='.ps1']")).toHaveCount(0);
    const text = await page.locator("main").innerText();
    expect(text).toContain("YOUR_API_KEY");
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });
});

test.describe("account shell", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("shows an unavailable state when the API is down and does not fake sign-in", async ({ page }) => {
    await apiUnreachable(page);
    await page.goto("/app");
    await expect(page.getByRole("alert")).toContainText("API unavailable");
    await expect(page.getByText("Signed in", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("offers wallet sign-in when /api/session answers 401 (no fake session)", async ({ page }) => {
    await page.route("**/api/session", (r) =>
      r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "No session", requestId: "req_1" } }) }),
    );
    await page.goto("/app");
    await expect(page.getByRole("button", { name: "Sign in with an EVM wallet" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Sign in with a TRON wallet" })).toBeEnabled();
    await expect(page.getByText("Signed in", { exact: true })).toHaveCount(0);
  });

  test("shows the console for the session the API returns (mocked contract fixture; other calls unreachable)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 }); // the account label lives in the desktop rail
    await page.route("**/api/**", (r) => r.abort("connectionrefused"));
    await page.route("**/api/session", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: { id: "usr_1", createdAt: "2026-10-18T12:00:00Z" }, account: { id: "acc_1", name: null }, membership: { id: "mem_1", accountId: "acc_1", userId: "usr_1", role: "owner" }, expiresAt: "2099-10-19T12:00:00Z" }) }),
    );
    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    await expect(page.getByText("acc_1")).toBeVisible();
    await expect(page.getByText("Balance unavailable")).toBeVisible(); // isolated region error, shell still usable
  });
});
