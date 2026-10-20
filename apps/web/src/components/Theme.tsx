import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { MonitorIcon, MoonIcon, SunIcon } from "./Icons";
import { THEME_COLORS, THEME_STORAGE_KEY, parsePref, resolveTheme, type ResolvedTheme, type ThemePref } from "../lib/theme";

interface ThemeState {
  pref: ThemePref;
  resolved: ResolvedTheme;
  setPref: (p: ThemePref) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);
const DARK_QUERY = "(prefers-color-scheme: dark)";

function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("ThemeProvider missing");
  return ctx;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(() => parsePref(document.documentElement.getAttribute("data-theme-pref")));
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(DARK_QUERY).matches);
  const resolved = resolveTheme(pref, systemDark);

  // Follow the operating system only while System is selected.
  useEffect(() => {
    if (pref !== "system") return;
    const mql = window.matchMedia(DARK_QUERY);
    setSystemDark(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [pref]);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", resolved);
    root.setAttribute("data-theme-pref", pref);
    root.style.colorScheme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[resolved]);
  }, [pref, resolved]);

  // Other tabs: follow an explicit change made there.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) setPrefState(parsePref(e.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, p);
    } catch {
      /* storage blocked: the choice lasts for this page view only */
    }
  }, []);

  const value = useMemo(() => ({ pref, resolved, setPref }), [pref, resolved, setPref]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

const OPTIONS: { value: ThemePref; label: string; icon: ReactNode }[] = [
  { value: "light", label: "Light", icon: <SunIcon /> },
  { value: "dark", label: "Dark", icon: <MoonIcon /> },
  { value: "system", label: "System", icon: <MonitorIcon /> },
];

/** Three-way radiogroup. It shows the stored preference, not the resolved theme. */
export function ThemeControl({ compact = false }: { compact?: boolean }) {
  const { pref, setPref } = useTheme();
  const name = useId();
  return (
    <div className={`theme-control${compact ? " theme-control--compact" : ""}`} role="radiogroup" aria-label="Theme">
      {OPTIONS.map((o) => (
        <label key={o.value} className="theme-option">
          <input type="radio" name={name} value={o.value} checked={pref === o.value} onChange={() => setPref(o.value)} />
          <span className="theme-option__face">
            {o.icon}
            <span className={compact ? "sr-only" : "theme-option__text"}>{o.label}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
