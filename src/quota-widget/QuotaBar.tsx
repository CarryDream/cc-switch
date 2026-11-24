import type { CSSProperties } from "react";

export type QuotaStatus = "normal" | "warn" | "danger";
export type QuotaTone = "high" | "mid" | "low" | "warn" | "danger";
export type QuotaBarVariant = "default" | "weekly";

export function quotaPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

export function quotaStatus(left: number): QuotaStatus {
  if (left <= 0) return "danger";
  return left < 20 ? "warn" : "normal";
}

/**
 * 进度条五档语义色阶：
 * - high (≥85%)：充裕翡翠绿
 * - mid (45–84%)：清澈海蓝
 * - low (20–44%)：暖琥珀
 * - warn (1–19%)：珊瑚橙红
 * - danger (0%)：警示红
 */
export function quotaTone(left: number): QuotaTone {
  const pct = quotaPercent(left);
  if (pct <= 0) return "danger";
  if (pct < 20) return "warn";
  if (pct < 45) return "low";
  if (pct < 85) return "mid";
  return "high";
}

interface QuotaBarProps {
  left: number;
  label: string;
  weekly?: { left: number; label: string };
  /** 单独查看每周视图时使用专属靛蓝/紫蓝色阶以示区分。 */
  variant?: QuotaBarVariant;
  /** 锁定位置时关闭 Tauri 拖拽区域，避免误拖。 */
  draggable?: boolean;
}

/** 一根等高槽：实心条按余量分段变色，双轨模式下空心微游标展示周额度位置。 */
export function QuotaBar({
  left,
  label,
  weekly,
  variant = "default",
  draggable = true,
}: QuotaBarProps) {
  const primary = quotaPercent(left);
  const week = weekly ? quotaPercent(weekly.left) : null;
  const limiting = week === null ? primary : Math.min(primary, week);
  const fillScale = primary > 0 ? Math.max(primary, 2.5) / 100 : 0;
  const dragAttr = draggable ? "" : undefined;
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
      data-tone={quotaTone(limiting)}
      data-variant={variant}
      data-tauri-drag-region={dragAttr}
    >
      <span
        className="qw-bar-fill"
        data-status={quotaStatus(primary)}
        data-tone={quotaTone(primary)}
        data-variant={variant}
        style={{ transform: `scaleX(${fillScale})` }}
        aria-hidden="true"
        data-tauri-drag-region={dragAttr}
      />
      {week !== null && (
        <span
          className="qw-week-marker"
          data-status={quotaStatus(week)}
          data-tone={quotaTone(week)}
          style={{ "--week-position": `${week}%` } as CSSProperties}
          aria-hidden="true"
          data-tauri-drag-region={dragAttr}
        />
      )}
    </div>
  );
}
