import type { CSSProperties } from "react";

export type QuotaStatus = "normal" | "warn" | "danger";

export function quotaPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

export function quotaStatus(left: number): QuotaStatus {
  if (left <= 0) return "danger";
  return left < 20 ? "warn" : "normal";
}

interface QuotaBarProps {
  left: number;
  label: string;
  weekly?: { left: number; label: string };
}

/** 一根等高槽：实心条是短周期，空心端点是周额度，不用第二条实心条互相遮盖。 */
export function QuotaBar({ left, label, weekly }: QuotaBarProps) {
  const primary = quotaPercent(left);
  const week = weekly ? quotaPercent(weekly.left) : null;
  const limiting = week === null ? primary : Math.min(primary, week);
  const description = [
    `${label}: ${primary}%`,
    weekly && `${weekly.label}: ${week}%`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="qw-bar-track"
      role="meter"
      aria-label={description}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={limiting}
      aria-valuetext={description}
      data-status={quotaStatus(limiting)}
      data-tauri-drag-region
    >
      <span
        className="qw-bar-fill"
        data-status={quotaStatus(primary)}
        style={{ transform: `scaleX(${primary / 100})` }}
        aria-hidden="true"
        data-tauri-drag-region
      />
      {week !== null && (
        <span
          className="qw-week-marker"
          data-status={quotaStatus(week)}
          style={{ "--week-position": `${week}%` } as CSSProperties}
          aria-hidden="true"
          data-tauri-drag-region
        />
      )}
    </div>
  );
}
