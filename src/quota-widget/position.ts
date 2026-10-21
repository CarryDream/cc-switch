import type { WidgetPosition } from "./api";

/** 窗口位置记在 localStorage（物理像素），所有窗口共享同一存储。 */
const POSITION_KEY = "cc-switch-quota-widget-position";

export function readSavedPosition(): WidgetPosition | null {
  try {
    const raw = window.localStorage.getItem(POSITION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (
      typeof parsed.x === "number" &&
      Number.isFinite(parsed.x) &&
      typeof parsed.y === "number" &&
      Number.isFinite(parsed.y)
    ) {
      return { x: Math.round(parsed.x), y: Math.round(parsed.y) };
    }
  } catch {
    // 读不到就回默认位置（居中）
  }
  return null;
}

export function savePosition(x: number, y: number): void {
  try {
    window.localStorage.setItem(
      POSITION_KEY,
      JSON.stringify({ x: Math.round(x), y: Math.round(y) }),
    );
  } catch {
    // 记不住也不影响使用
  }
}
