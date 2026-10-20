import { useEffect, useState } from "react";

export type ThemeChoice = "light" | "dark" | "system";

const THEME_KEY = "rdweb.app.theme";

function initialTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

const query = () => window.matchMedia?.("(prefers-color-scheme: dark)");

/** Light/dark/system theme on <html class="dark">, remembered in this browser. */
export function useTheme(): { theme: ThemeChoice; setTheme: (t: ThemeChoice) => void; dark: boolean } {
  const [theme, setThemeState] = useState<ThemeChoice>(initialTheme);
  const [systemDark, setSystemDark] = useState(() => !!query()?.matches);

  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const dark = theme === "dark" || (theme === "system" && systemDark);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
    // index.html has one per colour scheme for the first paint; both follow the choice
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute("content", dark ? "#09090b" : "#ffffff");
  }, [dark]);

  const setTheme = (t: ThemeChoice) => {
    setThemeState(t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* storage unavailable */
    }
  };
  return { theme, setTheme, dark };
}
