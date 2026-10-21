import { useEffect, useState } from "react";

/** 和主界面 ThemeProvider 的 storageKey 一致 */
const THEME_STORAGE_KEY = "cc-switch-theme";

type ThemeChoice = "light" | "dark" | "system";

function readChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // 读不到按跟随系统
  }
  return "system";
}

function systemDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function resolve(): boolean {
  const choice = readChoice();
  if (choice === "system") return systemDark();
  return choice === "dark";
}

/**
 * 悬浮窗是常驻的独立 WebView：不挂主界面的 ThemeProvider（它会改主窗口的原生主题），
 * 只读主界面存在 localStorage 的选择，另一个窗口改了或系统深浅色变了都跟着变。
 */
export function useWidgetTheme(): boolean {
  const [dark, setDark] = useState(resolve);

  useEffect(() => {
    const update = () => setDark(resolve());
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener("change", update);
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) update();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      media?.removeEventListener("change", update);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("light", !dark);
  }, [dark]);

  return dark;
}
