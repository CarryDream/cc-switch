import type { PanelTexts } from "./api";

/**
 * 重置倒计时：`{when}` 用 `durationDays / Hours / Minutes` 拼出，最多取两级
 * （天+小时、小时+分），中间用 `durationSep` 隔开——规则与托盘面板一致
 * （`tray-panel/TrayPanel.tsx` 的 `formatResetIn`，独立成份避免带上它的依赖图）。
 */
export function formatResetIn(
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
      ? [unit(texts.durationDays, days), hours > 0 && unit(texts.durationHours, hours)]
      : hours > 0
        ? [
            unit(texts.durationHours, hours),
            minutes > 0 && unit(texts.durationMinutes, minutes),
          ]
        : [unit(texts.durationMinutes, minutes)];
  return texts.resetsIn.replace(
    "{when}",
    parts.filter(Boolean).join(texts.durationSep),
  );
}
