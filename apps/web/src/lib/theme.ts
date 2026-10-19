export type ThemePref = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme-preference";
export const THEME_COLORS: Record<ResolvedTheme, string> = { dark: "#202225", light: "#f6f3ec" };

export function parsePref(value: string | null | undefined): ThemePref {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}
