import type { PanelTexts } from "./api";

/**
 * 重置倒计时的时长部分（「2小时34分」「2h 34m」），单位模板与分隔符由后端文案给出，
 * 最多取两级（天+小时、小时+分）。规则与托盘面板一致（`tray-panel/TrayPanel.tsx`
 * 的 `formatResetIn`，独立成份避免带上它的依赖图）。
 */
export function formatResetWhen(
  iso: string,
  now: number,
  texts: PanelTexts,
): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || at <= now) return null;
  const totalMinutes = Math.max(1, Math.floor((at - now) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const unit = (template: string, n: number) =>
    template.replace("{n}", String(n));
  const parts =
    days > 0
      ? [
          unit(texts.durationDays, days),
          hours > 0 && unit(texts.durationHours, hours),
        ]
      : hours > 0
        ? [
            unit(texts.durationHours, hours),
            minutes > 0 && unit(texts.durationMinutes, minutes),
          ]
        : [unit(texts.durationMinutes, minutes)];
  return parts.filter(Boolean).join(texts.durationSep);
}

/** 完整的重置倒计时句（「2小时34分后重置」）；悬停说明用。 */
export function formatResetIn(
  iso: string,
  now: number,
  texts: PanelTexts,
): string | null {
  const when = formatResetWhen(iso, now, texts);
  return when === null ? null : texts.resetsIn.replace("{when}", when);
}
