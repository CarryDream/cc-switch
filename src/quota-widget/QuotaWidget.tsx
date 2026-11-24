import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  WIDGET_CHANGED_EVENT,
  WIDGET_VISIBILITY_EVENT,
  quotaWidgetApi,
  type AgyQuotaTier,
  type PanelApp,
  type PanelQuota,
  type PanelQuotaLine,
  type PanelTexts,
  type TrayPanelState,
  type WidgetVisibility,
} from "./api";
import { formatResetIn, formatResetWhen } from "./formatReset";
import {
  clearSavedPosition,
  readSavedPosition,
  savePosition,
} from "./position";
import { useWidgetTheme } from "./useWidgetTheme";
import { QuotaBar, quotaTone } from "./QuotaBar";

/** 数据多久主动刷新一次（刷新缓存 → 取状态）。 */
const REFRESH_INTERVAL = 60_000;
/** 重置倒计时多久跳一格。 */
const CLOCK_TICK = 30_000;
/** 尺寸回报、位置保存的去抖。 */
const REPORT_DEBOUNCE = 80;
const SAVE_DEBOUNCE = 300;
/** 冷启动最多等待真实内容渲染的兜底超时（毫秒），避免慢首帧长期不显窗。 */
const REVEAL_FALLBACK_MS = 150;
/** 双击判定窗口（毫秒）与最大允许位移（像素）：拖动区域会吞掉系统 dblclick，自己按 mousedown 认。 */
const DBLCLICK_MS = 350;
const DBLCLICK_MAX_MOVE = 4;
/** 单击展开详情前短暂等待，若紧接着触发双击则取消展开改为打开主窗口。 */
const EXPAND_CLICK_DELAY_MS = 220;
/** 点击重置位置后短时间内忽略系统回抛的 onMoved，保持 localStorage 清空状态。 */
const RESET_SAVE_SUPPRESS_MS = 600;
/** Antigravity 额度多久问一次：每次都是实打实的网络请求，不能跟主刷新一样勤。 */
const AGY_REFRESH_INTERVAL = 300_000;
/** 重新显示悬浮窗时，距上次 AGY 查询超过该间隔才顺带补查。 */
const AGY_RESUME_STALE_MS = 60_000;
/** 记住用户偏好的额度视图：默认双轨，点击底部「双轨 / 5 小时 / 每周」可切换。 */
const TIER_VIEW_KEY = "cc-switch-quota-widget-tier-view";
/** 记住是否锁定窗口位置（禁止拖拽）。 */
const LOCKED_KEY = "cc-switch-quota-widget-locked";
/** 记住背景透明度档位：轻透 / 均衡 / 实底。 */
const OPACITY_KEY = "cc-switch-quota-widget-opacity";

export type TierView = "dual" | "five_hour" | "weekly";
export type WidgetOpacity = "light" | "balanced" | "solid";

function readSavedTierView(): TierView {
  try {
    const raw = window.localStorage.getItem(TIER_VIEW_KEY);
    if (raw === "five_hour" || raw === "weekly" || raw === "dual") return raw;
  } catch {
    // 读不到默认双轨
  }
  return "dual";
}

function saveTierView(view: TierView): void {
  try {
    window.localStorage.setItem(TIER_VIEW_KEY, view);
  } catch {
    // 记不住也不影响使用
  }
}

function readSavedLocked(): boolean {
  try {
    return window.localStorage.getItem(LOCKED_KEY) === "true";
  } catch {
    return false;
  }
}

function saveLocked(locked: boolean): void {
  try {
    window.localStorage.setItem(LOCKED_KEY, String(locked));
  } catch {
    // 记不住也不影响使用
  }
}

function readSavedOpacity(): WidgetOpacity {
  try {
    const raw = window.localStorage.getItem(OPACITY_KEY);
    if (raw === "light" || raw === "balanced" || raw === "solid") return raw;
  } catch {
    // 读不到默认均衡
  }
  return "balanced";
}

function saveOpacity(opacity: WidgetOpacity): void {
  try {
    window.localStorage.setItem(OPACITY_KEY, opacity);
  } catch {
    // 记不住也不影响使用
  }
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function clampPct(value: number): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : 0;
}

function measureElement(el: HTMLElement | null): {
  width: number;
  height: number;
} {
  if (!el) return { width: 296, height: 84 };
  const rect = el.getBoundingClientRect();
  const width = rect.width > 0 ? Math.ceil(rect.width) : el.offsetWidth || 296;
  const height =
    rect.height > 0 ? Math.ceil(rect.height) : el.offsetHeight || 84;
  return { width, height };
}

function formatDurationMinutes(
  totalMinutes: number,
  texts: PanelTexts,
): string {
  const mins = Math.max(1, Math.floor(totalMinutes));
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const minutes = mins % 60;
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

function formatUpdatedStatus(
  isRefreshing: boolean,
  lastUpdatedAt: number | null,
  now: number,
  texts: PanelTexts,
): string | undefined {
  if (isRefreshing) return texts.refreshing;
  if (lastUpdatedAt == null) return undefined;
  const elapsedMs = Math.max(0, now - lastUpdatedAt);
  if (elapsedMs < 60_000) return texts.updatedJustNow;
  const when = formatDurationMinutes(Math.floor(elapsedMs / 60_000), texts);
  return texts.updatedAgo.replace("{when}", when);
}

interface QuotaTarget {
  key: string;
  name: string;
  /** 多个应用下供应商重名时展示的应用简称，避免两行无法分辨。 */
  appTag?: string;
  quota: PanelQuota;
  attention?: boolean;
}

/**
 * 主行：某一档用尽（0%）时它就是瓶颈，优先显示它（0% 红色 + 该档的重置倒计时）；
 * 否则 5 小时那档优先，再退到第一条有百分比的行或第一条文本/余额行。
 */
function primaryLine(lines: PanelQuotaLine[]): PanelQuotaLine | null {
  if (!lines || lines.length === 0) return null;
  return (
    lines.find((line) => line.left != null && line.left <= 0) ??
    lines.find((line) => line.tier === "five_hour") ??
    lines.find((line) => line.left != null) ??
    lines[0]
  );
}

interface TierRef {
  left: number;
  resetsAt: string | null;
}

/**
 * 双档行的瓶颈档：剩余更少者为真实可用量。
 * 当两档同为 0%（都已用尽）时，取重置时间更晚的一档（通常是周额度），因为那才是真正恢复可用的时刻。
 */
function pickBottleneck<T extends TierRef>(fiveHour: T, weekly: T): T {
  if (fiveHour.left < weekly.left) return fiveHour;
  if (weekly.left < fiveHour.left) return weekly;
  if (fiveHour.left === 0) {
    const t5 = fiveHour.resetsAt ? Date.parse(fiveHour.resetsAt) : Number.NaN;
    const tw = weekly.resetsAt ? Date.parse(weekly.resetsAt) : Number.NaN;
    if (Number.isFinite(tw) && (!Number.isFinite(t5) || tw > t5)) {
      return weekly;
    }
  }
  return fiveHour;
}

function isAgyFiveHour(name: string): boolean {
  return name.includes("five_hour") || name.includes("5h");
}

function isAgyWeekly(name: string): boolean {
  return (
    name.includes("seven_day") ||
    name === "weekly_limit" ||
    name.includes("weekly") ||
    name.includes("week")
  );
}

/** Antigravity 额度的档位名 → 本地档名（单独区分 Argon 周额度，避免 tooltip 重名）。 */
function agyTierLabel(name: string, texts: PanelTexts): string {
  if (name.includes("argon")) return `Argon ${texts.tierWeekly}`;
  if (isAgyFiveHour(name)) return texts.tierFiveHour;
  if (isAgyWeekly(name)) return texts.tierWeekly;
  return name;
}

function pickWorstWeeklyTier(tiers: AgyQuotaTier[]): AgyQuotaTier | undefined {
  const weeklies = tiers.filter((t) => isAgyWeekly(t.name));
  if (weeklies.length === 0) return undefined;
  return weeklies.reduce((worst, cur) => {
    const worstLeft = clampPct(100 - worst.utilization);
    const curLeft = clampPct(100 - cur.utilization);
    if (curLeft < worstLeft) return cur;
    if (curLeft === worstLeft && curLeft === 0) {
      const tw = worst.resetsAt ? Date.parse(worst.resetsAt) : Number.NaN;
      const tc = cur.resetsAt ? Date.parse(cur.resetsAt) : Number.NaN;
      if (Number.isFinite(tc) && (!Number.isFinite(tw) || tc > tw)) {
        return cur;
      }
    }
    return worst;
  });
}

interface AgyGroup {
  key: string;
  name: string;
  tiers: AgyQuotaTier[];
}

function splitAgyGroups(tiers: AgyQuotaTier[] | null): AgyGroup[] {
  if (!tiers || tiers.length === 0) return [];
  const claudeTiers = tiers.filter(
    (t) =>
      t.name.includes("third_party") ||
      t.name.includes("3p") ||
      t.name.includes("claude"),
  );
  const geminiTiers = tiers.filter((t) => t.name.includes("gemini"));
  if (claudeTiers.length > 0 && geminiTiers.length > 0) {
    return [
      {
        key: "agy-claude",
        name: "Antigravity (Claude)",
        tiers: claudeTiers,
      },
      {
        key: "agy-gemini",
        name: "Antigravity (Gemini)",
        tiers: geminiTiers,
      },
    ];
  }
  return [{ key: "agy-single", name: "Antigravity", tiers }];
}

function hasDualQuota(quota: PanelQuota): boolean {
  const has5h = quota.lines.some(
    (line) => line.tier === "five_hour" && line.left != null,
  );
  const hasWeekly = quota.lines.some(
    (line) => line.tier === "weekly" && line.left != null,
  );
  return has5h && hasWeekly;
}

function hasDualAgy(tiers: AgyQuotaTier[] | null): boolean {
  return splitAgyGroups(tiers).some(
    (group) =>
      group.tiers.some((t) => isAgyFiveHour(t.name)) &&
      group.tiers.some((t) => isAgyWeekly(t.name)),
  );
}

/** 悬停说明：供应商名 + 全部档行（每周等都在这里）+ 重置倒计时。 */
function rowTooltip(
  name: string,
  appTag: string | undefined,
  quota: PanelQuota,
  texts: PanelTexts,
  now: number,
): string | undefined {
  const title = appTag ? `${name} (${appTag})` : name;
  const rows = quota.lines.map((line) => {
    const reset = line.resetsAt
      ? formatResetIn(line.resetsAt, now, texts)
      : null;
    return reset ? `${line.text} · ${reset}` : line.text;
  });
  if (quota.resetCredits != null) {
    rows.push(
      texts.resetCredits.replace("{count}", String(quota.resetCredits)),
    );
  }
  if (quota.note) {
    rows.push(quota.note);
  }
  return [title, ...rows].filter(Boolean).join("\n") || undefined;
}

function lineLabel(line: PanelQuotaLine | null, texts: PanelTexts): string {
  if (!line) return "";
  if (line.tier === "five_hour") return texts.tierFiveHour;
  if (line.tier === "weekly") return texts.tierWeekly;
  return line.text;
}

function pctToneClass(pct: number | null): string | undefined {
  if (pct == null) return undefined;
  const tone = quotaTone(pct);
  if (tone === "danger") return "qw-danger";
  if (tone === "warn") return "qw-warn";
  if (tone === "low") return "qw-low";
  return undefined;
}

function LockIcon() {
  return (
    <svg
      className="qw-lock-icon"
      viewBox="0 0 12 12"
      width="10"
      height="10"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3.75 5.25V3.75a2.25 2.25 0 0 1 4.5 0v1.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <rect
        x="2.5"
        y="5.25"
        width="7"
        height="5"
        rx="1.4"
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      className="qw-chevron"
      viewBox="0 0 10 10"
      width="8"
      height="8"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3.25 2.25 6.5 5 3.25 7.75"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function QuotaRow({
  target,
  tierView,
  texts,
  now,
  expanded,
  draggable,
  onRowClick,
}: {
  target: QuotaTarget;
  tierView: TierView;
  texts: PanelTexts;
  now: number;
  expanded: boolean;
  draggable: boolean;
  onRowClick: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  const dragAttr = draggable ? "" : undefined;
  const quota = target.quota;
  const fiveHourLine = quota.lines.find(
    (line) => line.tier === "five_hour" && line.left != null,
  );
  const weeklyLine = quota.lines.find(
    (line) => line.tier === "weekly" && line.left != null,
  );

  // 根据底部视图模式决定展示双轨、仅 5 小时、还是仅每周
  const dual =
    tierView === "dual" && fiveHourLine && weeklyLine
      ? {
          fiveHour: {
            left: clampPct(fiveHourLine.left!),
            resetsAt: fiveHourLine.resetsAt,
            line: fiveHourLine,
          },
          weekly: {
            left: clampPct(weeklyLine.left!),
            resetsAt: weeklyLine.resetsAt,
            line: weeklyLine,
          },
        }
      : null;

  const focusedLine =
    tierView === "five_hour"
      ? (fiveHourLine ?? null)
      : tierView === "weekly"
        ? (weeklyLine ?? null)
        : null;
  const missingFocusedTier =
    (tierView === "five_hour" && !fiveHourLine) ||
    (tierView === "weekly" && !weeklyLine);

  const primary = dual ? null : (focusedLine ?? primaryLine(quota.lines));
  const limitingDual = dual ? pickBottleneck(dual.fiveHour, dual.weekly) : null;
  const pct = limitingDual
    ? limitingDual.left
    : primary?.left != null
      ? clampPct(primary.left)
      : null;

  const resetSource = limitingDual ? limitingDual.line : primary;
  const reset =
    resetSource?.resetsAt != null
      ? formatResetWhen(resetSource.resetsAt, now, texts)
      : null;

  // 缺失聚焦档位时标出实际数据来源（5h / 7d），避免单档行在另一视图中被误读
  const sourceBadge =
    missingFocusedTier && primary?.tier === "five_hour"
      ? { text: "5h", title: texts.tierFiveHour }
      : missingFocusedTier && primary?.tier === "weekly"
        ? { text: "7d", title: texts.tierWeekly }
        : null;

  // 余额型 / 套餐过期等没有百分比的行：展示具体金额或状态文案，而非空白 "—"
  const nonPercentText =
    pct == null ? (primary?.emphasis ?? primary?.text ?? null) : null;
  const isBalance = pct == null && Boolean(primary?.emphasis);
  const isNonPercentWarn = pct == null && Boolean(primary?.warn);
  const barVariant = tierView === "weekly" && weeklyLine ? "weekly" : "default";

  return (
    <div
      className={cx("qw-row", missingFocusedTier && "qw-row-dim")}
      title={rowTooltip(target.name, target.appTag, quota, texts, now)}
      data-expanded={expanded}
      data-missing-tier={missingFocusedTier ? "true" : undefined}
      data-tauri-drag-region={dragAttr}
      onClick={onRowClick}
    >
      <div className="qw-row-head" data-tauri-drag-region={dragAttr}>
        {target.attention && (
          <span className="qw-attention" data-tauri-drag-region={dragAttr} />
        )}
        <span className="qw-app-name" data-tauri-drag-region={dragAttr}>
          <span className="qw-name-text" data-tauri-drag-region={dragAttr}>
            {target.name}
          </span>
          {target.appTag && (
            <span className="qw-app-tag" data-tauri-drag-region={dragAttr}>
              {target.appTag}
            </span>
          )}
          <ChevronIcon />
        </span>
        {reset && (
          <span className="qw-reset" data-tauri-drag-region={dragAttr}>
            {reset}
          </span>
        )}
        {sourceBadge && (
          <span
            className="qw-tier-badge"
            title={sourceBadge.title}
            data-tauri-drag-region={dragAttr}
          >
            {sourceBadge.text}
          </span>
        )}
        <span
          className={cx(
            pct != null ? "qw-pct" : "qw-value",
            pct != null
              ? pctToneClass(pct)
              : isNonPercentWarn
                ? "qw-danger"
                : isBalance
                  ? "qw-balance"
                  : undefined,
          )}
          data-tauri-drag-region={dragAttr}
        >
          {pct != null ? `${pct}%` : (nonPercentText ?? "—")}
        </span>
      </div>
      {dual || pct != null ? (
        <QuotaBar
          left={dual?.fiveHour.left ?? pct ?? 0}
          label={dual ? texts.tierFiveHour : lineLabel(primary, texts)}
          weekly={
            dual
              ? { left: dual.weekly.left, label: texts.tierWeekly }
              : undefined
          }
          variant={barVariant}
          draggable={draggable}
        />
      ) : quota.note ? (
        <div
          className="qw-note"
          title={quota.note}
          data-tauri-drag-region={dragAttr}
        >
          {quota.note}
        </div>
      ) : null}
      <div
        className="qw-detail-wrap"
        data-expanded={expanded}
        aria-hidden={!expanded}
        data-tauri-drag-region={dragAttr}
      >
        <div className="qw-detail-inner" data-tauri-drag-region={dragAttr}>
          {expanded && (
            <div className="qw-detail" data-tauri-drag-region={dragAttr}>
              {quota.lines.map((line, idx) => {
                if (line.left != null) {
                  const linePct = clampPct(line.left);
                  const lineReset = line.resetsAt
                    ? formatResetIn(line.resetsAt, now, texts)
                    : null;
                  return (
                    <div
                      key={`${line.tier ?? "line"}-${idx}`}
                      className="qw-detail-row"
                      data-tauri-drag-region={dragAttr}
                    >
                      <span
                        className="qw-detail-label"
                        data-tauri-drag-region={dragAttr}
                      >
                        {lineLabel(line, texts)}
                      </span>
                      {lineReset && (
                        <span
                          className="qw-detail-reset"
                          data-tauri-drag-region={dragAttr}
                        >
                          {lineReset}
                        </span>
                      )}
                      <span
                        className={cx("qw-detail-val", pctToneClass(linePct))}
                        data-tauri-drag-region={dragAttr}
                      >
                        {linePct}%
                      </span>
                    </div>
                  );
                }
                if (line.emphasis) {
                  const prefix =
                    line.text.replace(line.emphasis, "").trim() || line.text;
                  return (
                    <div
                      key={`bal-${idx}`}
                      className="qw-detail-row"
                      data-tauri-drag-region={dragAttr}
                    >
                      <span
                        className="qw-detail-label"
                        data-tauri-drag-region={dragAttr}
                      >
                        {prefix}
                      </span>
                      <span
                        className="qw-detail-val qw-balance"
                        data-tauri-drag-region={dragAttr}
                      >
                        {line.emphasis}
                      </span>
                    </div>
                  );
                }
                return (
                  <div
                    key={`txt-${idx}`}
                    className="qw-detail-row"
                    data-tauri-drag-region={dragAttr}
                  >
                    <span
                      className={cx(
                        "qw-detail-label",
                        line.warn && "qw-danger",
                      )}
                      data-tauri-drag-region={dragAttr}
                    >
                      {line.text}
                    </span>
                  </div>
                );
              })}
              {quota.resetCredits != null && (
                <div
                  className="qw-detail-meta"
                  data-tauri-drag-region={dragAttr}
                >
                  {texts.resetCredits.replace(
                    "{count}",
                    String(quota.resetCredits),
                  )}
                </div>
              )}
              {quota.note && (
                <div
                  className="qw-detail-note"
                  data-tauri-drag-region={dragAttr}
                >
                  {quota.note}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Antigravity 的主行：某一档用尽时优先显示（多档 0% 取更晚重置者）；否则 5 小时那档。 */
function pickAgyPrimary(tiers: AgyQuotaTier[]): AgyQuotaTier {
  const exhausted = tiers.filter((t) => clampPct(100 - t.utilization) === 0);
  if (exhausted.length > 0) {
    return exhausted.reduce((worst, cur) => {
      const tw = worst.resetsAt ? Date.parse(worst.resetsAt) : Number.NaN;
      const tc = cur.resetsAt ? Date.parse(cur.resetsAt) : Number.NaN;
      if (Number.isFinite(tc) && (!Number.isFinite(tw) || tc > tw)) {
        return cur;
      }
      return worst;
    });
  }
  return tiers.find((t) => isAgyFiveHour(t.name)) ?? tiers[0];
}

/** Antigravity 行：托盘额度管线不含 AGY，数据由悬浮窗自己问（见 `quota_widget_agy_quota`）。 */
function AgyRow({
  name,
  allTiers,
  tierView,
  staleError,
  texts,
  now,
  expanded,
  draggable,
  onRowClick,
}: {
  name: string;
  allTiers: AgyQuotaTier[];
  tierView: TierView;
  staleError: string | null;
  texts: PanelTexts;
  now: number;
  expanded: boolean;
  draggable: boolean;
  onRowClick: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  const dragAttr = draggable ? "" : undefined;
  const fiveHourTier = allTiers.find((t) => isAgyFiveHour(t.name));
  const weeklyTier = pickWorstWeeklyTier(allTiers);
  const dual =
    tierView === "dual" && fiveHourTier && weeklyTier
      ? {
          fiveHour: {
            left: clampPct(100 - fiveHourTier.utilization),
            resetsAt: fiveHourTier.resetsAt,
            tier: fiveHourTier,
          },
          weekly: {
            left: clampPct(100 - weeklyTier.utilization),
            resetsAt: weeklyTier.resetsAt,
            tier: weeklyTier,
          },
        }
      : null;

  const focusedTier =
    tierView === "five_hour"
      ? (fiveHourTier ?? null)
      : tierView === "weekly"
        ? (weeklyTier ?? null)
        : null;
  const missingFocusedTier =
    (tierView === "five_hour" && !fiveHourTier) ||
    (tierView === "weekly" && !weeklyTier);

  const bottleneckTier = dual
    ? pickBottleneck(dual.fiveHour, dual.weekly).tier
    : (focusedTier ?? pickAgyPrimary(allTiers));
  const left = clampPct(100 - bottleneckTier.utilization);
  const reset = bottleneckTier.resetsAt
    ? formatResetWhen(bottleneckTier.resetsAt, now, texts)
    : null;
  const barVariant = tierView === "weekly" && weeklyTier ? "weekly" : "default";

  const sourceBadge =
    missingFocusedTier && isAgyFiveHour(bottleneckTier.name)
      ? { text: "5h", title: texts.tierFiveHour }
      : missingFocusedTier && isAgyWeekly(bottleneckTier.name)
        ? { text: "7d", title: texts.tierWeekly }
        : null;

  const tooltip = [
    name,
    ...allTiers.map((tier) => {
      const tLeft = clampPct(100 - tier.utilization);
      const tReset = tier.resetsAt
        ? formatResetIn(tier.resetsAt, now, texts)
        : null;
      const text = `${agyTierLabel(tier.name, texts)} ${tLeft}%`;
      return tReset ? `${text} · ${tReset}` : text;
    }),
    staleError ? `⚠ ${staleError}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div
      className={cx("qw-row", missingFocusedTier && "qw-row-dim")}
      title={tooltip}
      data-expanded={expanded}
      data-missing-tier={missingFocusedTier ? "true" : undefined}
      data-tauri-drag-region={dragAttr}
      onClick={onRowClick}
    >
      <div className="qw-row-head" data-tauri-drag-region={dragAttr}>
        {staleError && (
          <span className="qw-attention" data-tauri-drag-region={dragAttr} />
        )}
        <span className="qw-app-name" data-tauri-drag-region={dragAttr}>
          <span className="qw-name-text" data-tauri-drag-region={dragAttr}>
            {name}
          </span>
          <ChevronIcon />
        </span>
        {reset && (
          <span className="qw-reset" data-tauri-drag-region={dragAttr}>
            {reset}
          </span>
        )}
        {sourceBadge && (
          <span
            className="qw-tier-badge"
            title={sourceBadge.title}
            data-tauri-drag-region={dragAttr}
          >
            {sourceBadge.text}
          </span>
        )}
        <span
          className={cx("qw-pct", pctToneClass(left))}
          data-tauri-drag-region={dragAttr}
        >
          {left}%
        </span>
      </div>
      <QuotaBar
        left={dual?.fiveHour.left ?? left}
        label={
          dual ? texts.tierFiveHour : agyTierLabel(bottleneckTier.name, texts)
        }
        weekly={
          dual ? { left: dual.weekly.left, label: texts.tierWeekly } : undefined
        }
        variant={barVariant}
        draggable={draggable}
      />
      <div
        className="qw-detail-wrap"
        data-expanded={expanded}
        aria-hidden={!expanded}
        data-tauri-drag-region={dragAttr}
      >
        <div className="qw-detail-inner" data-tauri-drag-region={dragAttr}>
          {expanded && (
            <div className="qw-detail" data-tauri-drag-region={dragAttr}>
              {allTiers.map((tier) => {
                const tLeft = clampPct(100 - tier.utilization);
                const tReset = tier.resetsAt
                  ? formatResetIn(tier.resetsAt, now, texts)
                  : null;
                return (
                  <div
                    key={tier.name}
                    className="qw-detail-row"
                    data-tauri-drag-region={dragAttr}
                  >
                    <span
                      className="qw-detail-label"
                      data-tauri-drag-region={dragAttr}
                    >
                      {agyTierLabel(tier.name, texts)}
                    </span>
                    {tReset && (
                      <span
                        className="qw-detail-reset"
                        data-tauri-drag-region={dragAttr}
                      >
                        {tReset}
                      </span>
                    )}
                    <span
                      className={cx("qw-detail-val", pctToneClass(tLeft))}
                      data-tauri-drag-region={dragAttr}
                    >
                      {tLeft}%
                    </span>
                  </div>
                );
              })}
              {staleError && (
                <div
                  className="qw-detail-note qw-detail-error"
                  data-tauri-drag-region={dragAttr}
                >
                  ⚠ {staleError}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 汇集所有可见的额度目标：当前在用的 + 其它有额度缓存的；多应用重名时补应用标签。 */
function collectQuotaTargets(apps: PanelApp[]): QuotaTarget[] {
  const raw: Array<QuotaTarget & { appLabel: string }> = [];
  const seenKeys = new Set<string>();

  for (const app of apps) {
    // 1. 在用供应商的额度
    if (app.quota && (app.quota.lines.length > 0 || app.quota.note)) {
      const key = `${app.app}:current`;
      seenKeys.add(key);
      raw.push({
        key,
        name: app.current ?? app.name,
        appLabel: app.name,
        quota: app.quota,
        attention: Boolean(app.attention),
      });
    }

    // 2. 子面板里其它有额度缓存的供应商
    for (const row of app.rows) {
      if (row.kind === "provider" && row.provider?.quota && !row.checked) {
        const q = row.provider.quota;
        if (q.lines.length > 0 || q.note) {
          const key = `${app.app}:${row.id}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            raw.push({
              key,
              name: row.provider.name,
              appLabel: app.name,
              quota: q,
              attention: false,
            });
          }
        }
      }
    }
  }

  // 多个不同应用出现同名供应商（如都有 "Official" / "官方"）时追加应用简称区分
  const appsByName = new Map<string, Set<string>>();
  for (const item of raw) {
    const norm = item.name.trim().toLowerCase();
    let set = appsByName.get(norm);
    if (!set) {
      set = new Set();
      appsByName.set(norm, set);
    }
    set.add(item.appLabel);
  }

  return raw.map(({ appLabel, ...target }) => {
    const colliding =
      (appsByName.get(target.name.trim().toLowerCase())?.size ?? 0) > 1;
    return colliding && target.name !== appLabel
      ? { ...target, appTag: appLabel }
      : target;
  });
}

function Skeleton() {
  return (
    <div className="qw-skeleton">
      <div className="qw-skel qw-skel-md" />
      <div className="qw-skel qw-skel-lg" />
      <div className="qw-skel qw-skel-sm" />
    </div>
  );
}

export function QuotaWidget() {
  const dark = useWidgetTheme();
  const rootRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TrayPanelState | null>(null);
  // 文案随 `bootstrap` / `ready` 首帧下发，并由 `CHANGED_EVENT` / `VISIBILITY_EVENT` 实时同步语言切换
  const [texts, setTexts] = useState<PanelTexts | null>(null);
  const [agyTiers, setAgyTiers] = useState<AgyQuotaTier[] | null>(null);
  const [agyError, setAgyError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [isHovered, setIsHovered] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tierView, setTierView] = useState<TierView>(readSavedTierView);
  const [locked, setLocked] = useState<boolean>(readSavedLocked);
  const [opacity, setOpacity] = useState<WidgetOpacity>(readSavedOpacity);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [refreshCount, setRefreshCount] = useState(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [revealFallback, setRevealFallback] = useState(false);

  const lastDownRef = useRef<{ at: number; x: number; y: number } | null>(null);
  const downPosRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const pendingExpandTimerRef = useRef<number | undefined>(undefined);
  const lastAgyFetchRef = useRef<number>(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const agyInFlightRef = useRef<Promise<void> | null>(null);
  const revealedRef = useRef(false);
  const revealFallbackTimerRef = useRef<number | undefined>(undefined);
  const suppressSaveUntilRef = useRef<number>(0);
  const mountedRef = useRef(true);

  const isRefreshing = refreshCount > 0;
  const dragAttr = locked ? undefined : "";

  const clearPendingExpand = useCallback(() => {
    if (pendingExpandTimerRef.current !== undefined) {
      window.clearTimeout(pendingExpandTimerRef.current);
      pendingExpandTimerRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPendingExpand();
    };
  }, [clearPendingExpand]);

  const selectTierView = useCallback((next: TierView) => {
    saveTierView(next);
    setTierView(next);
  }, []);

  const toggleTierView = useCallback((target: "five_hour" | "weekly") => {
    setTierView((prev) => {
      const next: TierView = prev === target ? "dual" : target;
      saveTierView(next);
      return next;
    });
  }, []);

  const toggleLocked = useCallback(() => {
    setLocked((prev) => {
      const next = !prev;
      saveLocked(next);
      return next;
    });
  }, []);

  const selectOpacity = useCallback((next: WidgetOpacity) => {
    saveOpacity(next);
    setOpacity(next);
  }, []);

  const toggleRowExpanded = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const readState = useCallback(async () => {
    const next = await quotaWidgetApi.state();
    if (mountedRef.current) {
      setState(next);
      setLastUpdatedAt(Date.now());
    }
  }, []);

  const refreshAndReadState = useCallback(() => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    if (mountedRef.current) setRefreshCount((count) => count + 1);
    const promise = (async () => {
      try {
        // 刷新只是把缓存焐热：失败也要照常展示已有缓存，不能因此整块空白。
        await quotaWidgetApi.refresh().catch(() => {});
        await readState();
      } finally {
        refreshInFlightRef.current = null;
        if (mountedRef.current) {
          setRefreshCount((count) => Math.max(0, count - 1));
        }
      }
    })();
    refreshInFlightRef.current = promise;
    return promise;
  }, [readState]);

  const fetchAgyQuota = useCallback((force = false) => {
    if (agyInFlightRef.current) return agyInFlightRef.current;
    lastAgyFetchRef.current = Date.now();
    if (mountedRef.current) setRefreshCount((count) => count + 1);
    const promise = (async () => {
      try {
        const quota = await quotaWidgetApi.agyQuota(force);
        if (!mountedRef.current) return;
        if (quota.success && quota.tiers.length > 0) {
          setAgyTiers(quota.tiers);
          setAgyError(null);
          setLastUpdatedAt(Date.now());
        } else if (quota.credentialStatus === "not_found") {
          // 未安装 / 未登录 / 在设置中隐藏了 Antigravity：静默不显示，不弹报错占位
          setAgyTiers(null);
          setAgyError(null);
        } else {
          // 真实查询失败：保留上次成功拿到的数据（不因网络抖动抹掉），仅记录错误提示
          setAgyError(quota.error ?? "Antigravity: quota unavailable");
        }
      } catch (error) {
        if (!mountedRef.current) return;
        setAgyError(String(error));
      } finally {
        agyInFlightRef.current = null;
        if (mountedRef.current) {
          setRefreshCount((count) => Math.max(0, count - 1));
        }
      }
    })();
    agyInFlightRef.current = promise;
    return promise;
  }, []);

  // 失焦或按下 Esc 时收起 hover 态和自定义右键菜单
  useEffect(() => {
    const onBlur = () => {
      setIsHovered(false);
      setMenuOpen(false);
      clearPendingExpand();
      downPosRef.current = null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [clearPendingExpand]);

  // 双击打开主窗口：要求间隔与位移同时满足阈值，避免快速连续微调拖动误触发
  const onCardMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const targetEl = event.target as HTMLElement | null;
    if (targetEl?.closest(".qw-menu, .qw-legend, button")) return;
    if (menuOpen) {
      setMenuOpen(false);
      clearPendingExpand();
      suppressClickRef.current = true;
      return;
    }
    downPosRef.current = { x: event.clientX, y: event.clientY };
    const at = performance.now();
    const prev = lastDownRef.current;
    if (
      prev !== null &&
      at - prev.at < DBLCLICK_MS &&
      Math.hypot(event.clientX - prev.x, event.clientY - prev.y) <=
        DBLCLICK_MAX_MOVE
    ) {
      clearPendingExpand();
      suppressClickRef.current = true;
      lastDownRef.current = null;
      void quotaWidgetApi.showMain().catch(() => {});
    } else {
      suppressClickRef.current = false;
      lastDownRef.current = { at, x: event.clientX, y: event.clientY };
    }
  };

  const handleRowClick = useCallback(
    (key: string, event: MouseEvent<HTMLDivElement>) => {
      const targetEl = event.target as HTMLElement | null;
      if (targetEl?.closest(".qw-menu, .qw-legend, button")) return;
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        downPosRef.current = null;
        return;
      }
      const down = downPosRef.current;
      downPosRef.current = null;
      if (
        down &&
        Math.hypot(event.clientX - down.x, event.clientY - down.y) >
          DBLCLICK_MAX_MOVE
      ) {
        return;
      }
      clearPendingExpand();
      pendingExpandTimerRef.current = window.setTimeout(() => {
        pendingExpandTimerRef.current = undefined;
        toggleRowExpanded(key);
      }, EXPAND_CLICK_DELAY_MS);
    },
    [clearPendingExpand, toggleRowExpanded],
  );

  // 冷启动预热：先 bootstrap 拿玻璃模式与文案（不显窗），与 state 并行拉取，
  // 等真实 DOM 渲染完成后在 useLayoutEffect 里一次性 ready 显窗，零高度跳变；
  // 若 state 慢或旧后端无 bootstrap，150ms 后自动兜底显窗。
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled && !revealedRef.current) {
        setRevealFallback(true);
      }
    }, REVEAL_FALLBACK_MS);
    revealFallbackTimerRef.current = timer;

    const bootstrapFn = quotaWidgetApi.bootstrap;
    if (typeof bootstrapFn !== "function") {
      setRevealFallback(true);
    } else {
      bootstrapFn()
        .then((info) => {
          if (cancelled || !info) return;
          document.documentElement.dataset.glass = info.glass;
          document.documentElement.dataset.platform = info.platform;
          setTexts((prev) => prev ?? info.texts);
        })
        .catch(() => {
          if (!cancelled && !revealedRef.current) {
            setRevealFallback(true);
          }
        });
    }

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    void quotaWidgetApi
      .appearance(dark)
      .then((info) => {
        if (active) document.documentElement.dataset.glass = info.glass;
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [dark]);

  // 拖动后记住位置（物理像素；异常哨兵坐标已在 savePosition 内部过滤）
  useEffect(() => {
    let timer: number | undefined;
    const unlisten = getCurrentWindow().onMoved(({ payload }) => {
      if (Date.now() < suppressSaveUntilRef.current) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (Date.now() < suppressSaveUntilRef.current) return;
        savePosition(payload.x, payload.y);
      }, SAVE_DEBOUNCE);
    });
    return () => {
      window.clearTimeout(timer);
      void unlisten.then((fn) => fn());
    };
  }, []);

  // 订阅后端变更与可见性事件：切换供应商、主界面刷新、切换语言都能即时同步
  useEffect(() => {
    const unlistenChanged = listen<PanelTexts>(
      WIDGET_CHANGED_EVENT,
      ({ payload }) => {
        if (!mountedRef.current) return;
        if (payload) setTexts(payload);
        void readState().catch(() => {});
      },
    );
    const unlistenVisibility = listen<WidgetVisibility>(
      WIDGET_VISIBILITY_EVENT,
      ({ payload }) => {
        if (!mountedRef.current || !payload) return;
        setTexts(payload.texts);
        setIsVisible(payload.visible);
        if (!payload.visible) {
          setMenuOpen(false);
          setIsHovered(false);
          clearPendingExpand();
        } else {
          setNow(Date.now());
          if (Date.now() - lastAgyFetchRef.current >= AGY_RESUME_STALE_MS) {
            void fetchAgyQuota();
          }
        }
      },
    );
    return () => {
      void unlistenChanged.then((fn) => fn());
      void unlistenVisibility.then((fn) => fn());
    };
  }, [clearPendingExpand, fetchAgyQuota, readState]);

  // 主额度：先秒读本地缓存立刻出画面，再后台刷新写缓存后更新；隐藏期间暂停轮询
  useEffect(() => {
    if (!isVisible) return;
    void readState()
      .catch(() => {})
      .finally(() => {
        if (mountedRef.current) {
          void refreshAndReadState().catch(() => {});
        }
      });
    const timer = window.setInterval(
      () => void refreshAndReadState().catch(() => {}),
      REFRESH_INTERVAL,
    );
    return () => {
      window.clearInterval(timer);
    };
  }, [isVisible, readState, refreshAndReadState]);

  // 重置倒计时本地跳字，隐藏时暂停
  useEffect(() => {
    if (!isVisible) return;
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK);
    return () => window.clearInterval(timer);
  }, [isVisible]);

  // Antigravity 额度：隐藏时暂停轮询
  useEffect(() => {
    if (!isVisible) return;
    if (lastAgyFetchRef.current === 0) {
      void fetchAgyQuota();
    }
    const timer = window.setInterval(
      () => void fetchAgyQuota(),
      AGY_REFRESH_INTERVAL,
    );
    return () => {
      window.clearInterval(timer);
    };
  }, [isVisible, fetchAgyQuota]);

  // 卡片尺寸变了窗口跟着改（使用 getBoundingClientRect 向上取整，兼容 125%/150% DPI）
  const reportLayout = useCallback(() => {
    if (!revealedRef.current) return;
    const el = rootRef.current;
    if (!el) return;
    const { width, height } = measureElement(el);
    void quotaWidgetApi.layout(width, height).catch(() => {});
  }, []);

  // 首次内容渲染完成（或 150ms 兜底超时）直接量真实 DOM 后一次性 ready 显窗，
  // 之后内容变化再走 layout。
  const hasContent = Boolean(state && texts);
  useLayoutEffect(() => {
    if (!revealedRef.current) {
      if (!hasContent && !revealFallback) return;
      revealedRef.current = true;
      if (revealFallbackTimerRef.current !== undefined) {
        window.clearTimeout(revealFallbackTimerRef.current);
        revealFallbackTimerRef.current = undefined;
      }
      const { width, height } = measureElement(rootRef.current);
      void quotaWidgetApi
        .ready(readSavedPosition(), width, height)
        .then((info) => {
          if (!mountedRef.current || !info) return;
          document.documentElement.dataset.glass = info.glass;
          document.documentElement.dataset.platform = info.platform;
          setTexts((prev) => prev ?? info.texts);
        })
        .catch(() => {});
      return;
    }
    if (hasContent) reportLayout();
  }, [
    hasContent,
    revealFallback,
    menuOpen,
    tierView,
    expandedKeys,
    locked,
    reportLayout,
  ]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      if (!revealedRef.current) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(reportLayout, REPORT_DEBOUNCE);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [reportLayout]);

  const quotaTargets = collectQuotaTargets(state?.apps ?? []);
  const agyGroups = splitAgyGroups(agyTiers);
  const hasAgy = agyGroups.length > 0;
  const showStandaloneAgyError = !hasAgy && Boolean(agyError);
  const isEmpty =
    quotaTargets.length === 0 && !hasAgy && !showStandaloneAgyError;
  const hasAnyDual =
    quotaTargets.some((target) => hasDualQuota(target.quota)) ||
    hasDualAgy(agyTiers);
  const effectiveView: TierView = hasAnyDual ? tierView : "dual";

  const totalRowCount =
    quotaTargets.length + agyGroups.length + (showStandaloneAgyError ? 1 : 0);
  const showFooter = hasAnyDual || locked;
  const statusTooltip = texts
    ? formatUpdatedStatus(isRefreshing, lastUpdatedAt, now, texts)
    : undefined;
  const menuTopOffset = menuOpen
    ? `${(rootRef.current?.scrollTop ?? 0) + 5}px`
    : undefined;

  return (
    <div
      ref={rootRef}
      className="qw-card"
      data-tauri-drag-region={dragAttr}
      data-active={isHovered}
      data-opacity={opacity}
      data-locked={locked ? "true" : undefined}
      data-menu-pad={menuOpen && totalRowCount <= 2 ? "true" : undefined}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onMouseDown={onCardMouseDown}
      onContextMenu={(event) => {
        event.preventDefault();
        clearPendingExpand();
        if (texts) setMenuOpen((prev) => !prev);
      }}
    >
      {!state || !texts ? (
        <Skeleton />
      ) : (
        <>
          {!showFooter && isRefreshing && (
            <span
              className="qw-status-dot qw-status-dot-busy qw-status-corner"
              title={statusTooltip}
              aria-label={statusTooltip}
              data-refreshing="true"
            />
          )}
          {isEmpty ? (
            <div className="qw-empty" data-tauri-drag-region={dragAttr}>
              {texts.noMatch}
            </div>
          ) : (
            <>
              {quotaTargets.map((target) => (
                <QuotaRow
                  key={target.key}
                  target={target}
                  tierView={effectiveView}
                  texts={texts}
                  now={now}
                  expanded={expandedKeys.has(target.key)}
                  draggable={!locked}
                  onRowClick={(event) => handleRowClick(target.key, event)}
                />
              ))}
              {agyGroups.map((group) => (
                <AgyRow
                  key={group.key}
                  name={group.name}
                  allTiers={group.tiers}
                  tierView={effectiveView}
                  staleError={agyError}
                  texts={texts}
                  now={now}
                  expanded={expandedKeys.has(group.key)}
                  draggable={!locked}
                  onRowClick={(event) => handleRowClick(group.key, event)}
                />
              ))}
              {showStandaloneAgyError && agyError && (
                <div
                  className="qw-note"
                  title={agyError}
                  data-tauri-drag-region={dragAttr}
                >
                  Antigravity · {agyError}
                </div>
              )}
            </>
          )}
          {showFooter && (
            <div className="qw-legend" data-mode={effectiveView}>
              <div className="qw-footer-meta">
                <span
                  className={cx(
                    "qw-status-dot",
                    isRefreshing && "qw-status-dot-busy",
                  )}
                  title={statusTooltip}
                  aria-label={statusTooltip}
                  data-refreshing={isRefreshing}
                />
                {locked && (
                  <button
                    type="button"
                    className="qw-lock-btn"
                    title={texts.unlockPosition}
                    aria-label={texts.unlockPosition}
                    onClick={toggleLocked}
                  >
                    <LockIcon />
                  </button>
                )}
              </div>
              {hasAnyDual && (
                <div className="qw-tier-switch" role="group">
                  <button
                    type="button"
                    className="qw-tier-btn"
                    title={`${texts.tierDual} (${texts.tierFiveHour} + ${texts.tierWeekly})`}
                    aria-pressed={effectiveView === "dual"}
                    data-selected={effectiveView === "dual"}
                    onClick={() => selectTierView("dual")}
                  >
                    <span>{texts.tierDual}</span>
                  </button>
                  <button
                    type="button"
                    className="qw-tier-btn"
                    title={texts.tierFiveHour}
                    aria-pressed={effectiveView === "five_hour"}
                    data-selected={effectiveView === "five_hour"}
                    data-muted={effectiveView === "weekly"}
                    onClick={() => toggleTierView("five_hour")}
                  >
                    <i className="qw-key-fill" aria-hidden="true" />
                    <span>{texts.tierFiveHour}</span>
                  </button>
                  <button
                    type="button"
                    className="qw-tier-btn"
                    title={texts.tierWeekly}
                    aria-pressed={effectiveView === "weekly"}
                    data-selected={effectiveView === "weekly"}
                    data-muted={effectiveView === "five_hour"}
                    onClick={() => toggleTierView("weekly")}
                  >
                    <i className="qw-key-marker" aria-hidden="true" />
                    <span>{texts.tierWeekly}</span>
                  </button>
                </div>
              )}
            </div>
          )}
          {menuOpen && (
            <div
              className="qw-menu"
              role="menu"
              style={menuTopOffset ? { top: menuTopOffset } : undefined}
            >
              <button
                type="button"
                role="menuitem"
                className="qw-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  void refreshAndReadState().catch(() => {});
                  void fetchAgyQuota(true);
                }}
              >
                {texts.refresh}
              </button>
              <div className="qw-menu-opacity" role="group">
                {(
                  [
                    { value: "light", label: texts.opacityLight },
                    { value: "balanced", label: texts.opacityBalanced },
                    { value: "solid", label: texts.opacitySolid },
                  ] as const
                ).map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    className="qw-opacity-pill"
                    aria-pressed={opacity === preset.value}
                    data-selected={opacity === preset.value}
                    onClick={() => selectOpacity(preset.value)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                role="menuitem"
                className="qw-menu-item"
                onClick={() => {
                  toggleLocked();
                  setMenuOpen(false);
                }}
              >
                {locked ? texts.unlockPosition : texts.lockPosition}
              </button>
              <button
                type="button"
                role="menuitem"
                className="qw-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  clearSavedPosition();
                  suppressSaveUntilRef.current =
                    Date.now() + RESET_SAVE_SUPPRESS_MS;
                  const { width, height } = measureElement(rootRef.current);
                  void quotaWidgetApi
                    .resetPosition(width, height)
                    .catch(() => {});
                }}
              >
                {texts.resetPosition}
              </button>
              <div className="qw-menu-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="qw-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  void quotaWidgetApi.showMain().catch(() => {});
                }}
              >
                {texts.openMain}
              </button>
              <button
                type="button"
                role="menuitem"
                className="qw-menu-item qw-menu-danger"
                onClick={() => {
                  setMenuOpen(false);
                  void quotaWidgetApi.hide().catch(() => {});
                }}
              >
                {texts.hideWidget}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
