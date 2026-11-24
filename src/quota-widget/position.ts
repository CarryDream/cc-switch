import type { WidgetPosition } from "./api";

/** 窗口位置记在 localStorage（物理像素），所有窗口共享同一存储。 */
const POSITION_KEY = "cc-switch-quota-widget-position";
/** 过滤 Windows 最小化 / 显示桌面时的异常哨兵坐标（如 -32000）。 */
const MIN_VALID_COORD = -10_000;

export function readSavedPosition(): WidgetPosition | null {
  try {
    const raw = window.localStorage.getItem(POSITION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (
      typeof parsed.x === "number" &&
      Number.isFinite(parsed.x) &&
      typeof parsed.y === "number" &&
      Number.isFinite(parsed.y) &&
      parsed.x > MIN_VALID_COORD &&
      parsed.y > MIN_VALID_COORD
    ) {
      return { x: Math.round(parsed.x), y: Math.round(parsed.y) };
    }
  } catch {
    // 读不到就回默认位置（主屏右上角）
  }
  return null;
}

export function savePosition(x: number, y: number): void {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x <= MIN_VALID_COORD ||
    y <= MIN_VALID_COORD
  ) {
    return;
  }
  try {
    window.localStorage.setItem(
      POSITION_KEY,
      JSON.stringify({ x: Math.round(x), y: Math.round(y) }),
    );
  } catch {
    // 记不住也不影响使用
  }
}

export function clearSavedPosition(): void {
  try {
    window.localStorage.removeItem(POSITION_KEY);
  } catch {
    // 清不掉也不影响使用
  }
}
