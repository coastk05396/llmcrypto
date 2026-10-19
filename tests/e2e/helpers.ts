/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";

export const VIEWPORTS = [
  { name: "mobile-390", width: 390, height: 844 },
  { name: "desktop-1440", width: 1440, height: 900 },
] as const;

export type ThemeCase = { name: string; pref: "light" | "dark" | "system"; os: "light" | "dark"; expected: "light" | "dark" };
export const THEME_CASES: ThemeCase[] = [
  { name: "light", pref: "light", os: "dark", expected: "light" },
  { name: "dark", pref: "dark", os: "light", expected: "dark" },
  { name: "system-light", pref: "system", os: "light", expected: "light" },
  { name: "system-dark", pref: "system", os: "dark", expected: "dark" },
];

export const BG = { dark: "rgb(32, 34, 37)", light: "rgb(246, 243, 236)" } as const;

/** The catalog API and session API are unreachable by default so results never depend on a running backend. */
export async function apiUnreachable(page: Page) {
  await page.route("**/api/**", (route: Route) => route.abort("connectionrefused"));
}

export async function noHorizontalOverflow(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
}

/** Seeds the stored preference before any page script runs, as a returning visitor would have it. */
export async function seedTheme(page: Page, pref: string) {
  await page.addInitScript((p) => {
    try { localStorage.setItem("theme-preference", p); } catch { /* ignore */ }
  }, pref);
}

/** Elements whose right edge is past the viewport, for a readable overflow failure message. */
export async function overflowCulprits(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    return Array.from(document.querySelectorAll("*")).filter((e) => e.getBoundingClientRect().right > w + 1).slice(0, 10)
      .map((e) => `${e.tagName}.${(e as HTMLElement).className}|${(e.textContent ?? "").slice(0, 40).replace(/\s+/g, " ")} right=${Math.round(e.getBoundingClientRect().right)}`);
  });
}
