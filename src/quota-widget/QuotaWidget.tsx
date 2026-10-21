import { useEffect, useRef, useState, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";
import {
  quotaWidgetApi,
  type AgyQuotaTier,
  type PanelApp,
  type PanelQuota,
  type PanelQuotaLine,
  type PanelTexts,
  type TrayPanelState,
} from "./api";
import { formatResetIn, formatResetWhen } from "./formatReset";
import { readSavedPosition, savePosition } from "./position";
import { useWidgetTheme } from "./useWidgetTheme";

/** 数据多久刷新一次（刷新缓存 → 取状态一次往返）。 */
const REFRESH_INTERVAL = 60_000;
/** 重置倒计时多久跳一格。 */
const CLOCK_TICK = 30_000;
/** 尺寸回报、位置保存的去抖。 */
const REPORT_DEBOUNCE = 80;
const SAVE_DEBOUNCE = 300;
/** 双击判定窗口（毫秒）：拖动区域会吞掉系统的 dblclick，自己按 mousedown 间隔认。 */
const DBLCLICK_MS = 350;
/** Antigravity 额度多久问一次：每次都是实打实的网络请求，不能跟主刷新一样勤。 */
const AGY_REFRESH_INTERVAL = 300_000;

interface QuotaTarget {
  key: string;
  name: string;
  quota: PanelQuota;
  attention?: boolean;
}

/** 主行：5 小时那档优先，没有就退到第一条有百分比或用量信息的行。 */
function primaryLine(lines: PanelQuotaLine[]): PanelQuotaLine | null {
  if (!lines || lines.length === 0) return null;
  return (
    lines.find((line) => line.tier === "five_hour") ??
    lines.find((line) => line.left != null) ??
    lines[0]
  );
}

/** Antigravity 额度的档位名（`five_hour` / `seven_day_*` 等）→ 本地档名。 */
function agyTierLabel(name: string, texts: PanelTexts): string {
  if (name.includes("five_hour") || name.includes("5h"))
    return texts.tierFiveHour;
  if (
    name.includes("seven_day") ||
    name === "weekly_limit" ||
    name.includes("weekly")
  )
    return texts.tierWeekly;
  return name;
}

/** 悬停说明：供应商名 + 全部档行（每周等都在这里）+ 重置倒计时。 */
function rowTooltip(
  name: string,
  quota: PanelQuota,
  texts: PanelTexts,
  now: number,
): string | undefined {
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
  return [name, ...rows].filter(Boolean).join("\n") || undefined;
}

function QuotaRow({
  target,
  texts,
  now,
}: {
  target: QuotaTarget;
  texts: PanelTexts;
  now: number;
}) {
  const quota = target.quota;
  const primary = primaryLine(quota.lines);
  const rawPct = primary?.left;
  const pct =
    rawPct != null ? Math.max(0, Math.min(100, Math.round(rawPct))) : null;

  // 用完判定：明确为 0，或文本包含已用尽/用完/used up
  const isExhausted =
    pct === 0 ||
    Boolean(
      primary?.text.includes("用尽") ||
        primary?.text.includes("用完") ||
        primary?.text.toLowerCase().includes("used up"),
    );
  const isWarn = Boolean(primary?.warn) && !isExhausted;

  const reset =
    primary?.resetsAt != null
      ? formatResetWhen(primary.resetsAt, now, texts)
      : null;

  return (
    <div
      className="qw-row"
      title={rowTooltip(target.name, quota, texts, now)}
      data-tauri-drag-region
    >
      <div className="qw-row-head">
        {target.attention && (
          <span className="qw-attention" data-tauri-drag-region />
        )}
        <span className="qw-app-name" data-tauri-drag-region>
          {target.name}
        </span>
        {reset && (
          <span className="qw-reset" data-tauri-drag-region>
            {reset}
          </span>
        )}
        <span
          className={cn(
            "qw-pct",
            isExhausted ? "qw-danger" : isWarn ? "qw-warn" : undefined,
          )}
          data-tauri-drag-region
        >
          {pct != null ? `${pct}%` : isExhausted ? "0%" : "—"}
        </span>
      </div>
      {pct != null ? (
        <div
          className="qw-bar"
          data-danger={isExhausted}
          data-tauri-drag-region
        >
          <div
            className="qw-bar-fill"
            data-warn={isWarn}
            data-danger={isExhausted}
            style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
          />
        </div>
      ) : quota.note ? (
        <div className="qw-note" title={quota.note}>
          {quota.note}
        </div>
      ) : null}
    </div>
  );
}

/** Antigravity 行：托盘额度管线不含 AGY，数据由悬浮窗自己问（见 `quota_widget_agy_quota`）。 */
function AgyRow({
  name,
  primaryTier,
  allTiers,
  texts,
  now,
}: {
  name: string;
  primaryTier: AgyQuotaTier;
  allTiers: AgyQuotaTier[];
  texts: PanelTexts;
  now: number;
}) {
  const left = Math.max(
    0,
    Math.min(100, Math.round(100 - primaryTier.utilization)),
  );
  const isExhausted = left === 0;
  const isWarn = left < 20 && !isExhausted;
  const reset = primaryTier.resetsAt
    ? formatResetWhen(primaryTier.resetsAt, now, texts)
    : null;

  const tooltip = [
    name,
    ...allTiers.map((tier) => {
      const tLeft = Math.max(
        0,
        Math.min(100, Math.round(100 - tier.utilization)),
      );
      const tReset = tier.resetsAt
        ? formatResetIn(tier.resetsAt, now, texts)
        : null;
      const text = `${agyTierLabel(tier.name, texts)} ${tLeft}%`;
      return tReset ? `${text} · ${tReset}` : text;
    }),
  ].join("\n");

  return (
    <div className="qw-row" title={tooltip} data-tauri-drag-region>
      <div className="qw-row-head">
        <span className="qw-app-name" data-tauri-drag-region>
          {name}
        </span>
        {reset && (
          <span className="qw-reset" data-tauri-drag-region>
            {reset}
          </span>
        )}
        <span
          className={cn(
            "qw-pct",
            isExhausted ? "qw-danger" : isWarn ? "qw-warn" : undefined,
          )}
          data-tauri-drag-region
        >
          {left}%
        </span>
      </div>
      <div
        className="qw-bar"
        data-danger={isExhausted}
        data-tauri-drag-region
      >
        <div
          className="qw-bar-fill"
          data-warn={isWarn}
          data-danger={isExhausted}
          style={{ width: `${Math.max(2, left)}%` }}
        />
      </div>
    </div>
  );
}

function renderAgyRows(
  tiers: AgyQuotaTier[] | null,
  texts: PanelTexts,
  now: number,
) {
  if (!tiers || tiers.length === 0) return null;

  const claude5h = tiers.find(
    (t) =>
      t.name === "agy_third_party_five_hour" ||
      t.name === "third_party_five_hour" ||
      (t.name.includes("5h") &&
        (t.name.includes("3p") || t.name.includes("third_party"))),
  );
  const gemini5h = tiers.find(
    (t) =>
      t.name === "agy_gemini_five_hour" ||
      t.name === "gemini_five_hour" ||
      (t.name.includes("5h") && t.name.includes("gemini")),
  );

  // 如果两者都在，分别渲染 Claude 和 Gemini 两行
  if (claude5h && gemini5h) {
    const claudeTiers = tiers.filter(
      (t) =>
        t.name.includes("third_party") ||
        t.name.includes("3p") ||
        t.name.includes("claude"),
    );
    const geminiTiers = tiers.filter((t) => t.name.includes("gemini"));
    return (
      <>
        <AgyRow
          key="agy-claude"
          name="Antigravity (Claude)"
          primaryTier={claude5h}
          allTiers={claudeTiers.length > 0 ? claudeTiers : tiers}
          texts={texts}
          now={now}
        />
        <AgyRow
          key="agy-gemini"
          name="Antigravity (Gemini)"
          primaryTier={gemini5h}
          allTiers={geminiTiers.length > 0 ? geminiTiers : tiers}
          texts={texts}
          now={now}
        />
      </>
    );
  }

  const primary =
    tiers.find(
      (t) => t.name.includes("five_hour") || t.name.includes("5h"),
    ) ?? tiers[0];
  return (
    <AgyRow
      key="agy-single"
      name="Antigravity"
      primaryTier={primary}
      allTiers={tiers}
      texts={texts}
      now={now}
    />
  );
}

/** 汇集所有可见的额度目标：当前在用的 + 其它有额度缓存的（哪怕用完了切走了也显示） */
function collectQuotaTargets(apps: PanelApp[]): QuotaTarget[] {
  const targets: QuotaTarget[] = [];
  const seenKeys = new Set<string>();

  for (const app of apps) {
    // 1. 在用供应商的额度
    if (app.quota && (app.quota.lines.length > 0 || app.quota.note)) {
      const key = `${app.app}:current`;
      seenKeys.add(key);
      targets.push({
        key,
        name: app.name,
        quota: app.quota,
        attention: Boolean(app.attention),
      });
    }

    // 2. 子面板里其它有额度缓存的供应商（例如当前切到代理/其它模型，但官方卡额度用完仍有记录）
    for (const row of app.rows) {
      if (row.kind === "provider" && row.provider?.quota && !row.checked) {
        const q = row.provider.quota;
        if (q.lines.length > 0 || q.note) {
          const key = `${app.app}:${row.id}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            targets.push({
              key,
              name: row.provider.name,
              quota: q,
              attention: false,
            });
          }
        }
      }
    }
  }

  return targets;
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-2">
      <div className="qw-skel w-2/3" />
      <div className="qw-skel w-full" />
      <div className="qw-skel w-1/2" />
    </div>
  );
}

export function QuotaWidget() {
  useWidgetTheme();
  const rootRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TrayPanelState | null>(null);
  const [agyTiers, setAgyTiers] = useState<AgyQuotaTier[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lastDownAt = useRef(0);

  // 双击打开主窗口：mousedown 先于拖动生效，两次点按间隔够近就当双击
  const onCardMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const at = performance.now();
    if (at - lastDownAt.current < DBLCLICK_MS) {
      lastDownAt.current = 0;
      void quotaWidgetApi.showMain().catch(() => {});
    } else {
      lastDownAt.current = at;
    }
  };

  // 加载完成：摆好存下的位置和首屏尺寸，后端随即显示窗口；拿回玻璃模式选配色
  useEffect(() => {
    let cancelled = false;
    const el = rootRef.current;
    quotaWidgetApi
      .ready(
        readSavedPosition(),
        el?.offsetWidth ?? 240,
        el?.offsetHeight ?? 96,
      )
      .then((info) => {
        if (cancelled) return;
        document.documentElement.dataset.glass = info.glass;
        document.documentElement.dataset.platform = info.platform;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 拖动后记住位置（物理像素）
  useEffect(() => {
    let timer: number | undefined;
    const unlisten = getCurrentWindow().onMoved(({ payload }) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => savePosition(payload.x, payload.y),
        SAVE_DEBOUNCE,
      );
    });
    return () => {
      window.clearTimeout(timer);
      void unlisten.then((fn) => fn());
    };
  }, []);

  // 刷新额度缓存再取状态；周期轮询 + 每次露面补一次（隐藏时 WebView 的定时器被节流）
  useEffect(() => {
    let alive = true;
    const load = async () => {
      await quotaWidgetApi.refresh();
      const next = await quotaWidgetApi.state();
      if (alive) setState(next);
    };
    void load().catch(() => {});
    const timer = window.setInterval(
      () => void load().catch(() => {}),
      REFRESH_INTERVAL,
    );
    const onVisible = () => {
      if (document.visibilityState === "visible") void load().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // 重置倒计时本地跳字，不用为此惊动后端
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK);
    return () => window.clearInterval(timer);
  }, []);

  // Antigravity 的额度：查得到才显示这一行；失败就沿用上一次的，从没成功过就不显示
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const quota = await quotaWidgetApi.agyQuota();
        if (alive && quota.success && quota.tiers.length > 0) {
          setAgyTiers(quota.tiers);
        }
      } catch {
        // 没登录 / 查询失败：保持现状
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), AGY_REFRESH_INTERVAL);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // 内容尺寸变了窗口跟着改（限高，超出卡片内滚动）
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void quotaWidgetApi
          .layout(el.offsetWidth, el.offsetHeight)
          .catch(() => {});
      }, REPORT_DEBOUNCE);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  const texts = state?.texts;
  const quotaTargets = collectQuotaTargets(state?.apps ?? []);
  const hasAgy = Boolean(agyTiers && agyTiers.length > 0);
  const isEmpty = quotaTargets.length === 0 && !hasAgy;

  return (
    <div
      ref={rootRef}
      className="qw-card"
      data-tauri-drag-region
      onMouseDown={onCardMouseDown}
    >
      {!state || !texts ? (
        <Skeleton />
      ) : isEmpty ? (
        <div className="qw-empty" data-tauri-drag-region>
          {texts.noMatch}
        </div>
      ) : (
        <>
          {quotaTargets.map((target) => (
            <QuotaRow
              key={target.key}
              target={target}
              texts={texts}
              now={now}
            />
          ))}
          {renderAgyRows(agyTiers, texts, now)}
        </>
      )}
    </div>
  );
}
