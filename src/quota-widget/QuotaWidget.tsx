import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  quotaWidgetApi,
  type PanelApp,
  type PanelQuota,
  type PanelQuotaLine,
  type PanelTexts,
  type TrayPanelState,
} from "./api";
import { formatResetIn } from "./formatReset";
import { readSavedPosition, savePosition } from "./position";
import { useWidgetTheme } from "./useWidgetTheme";

/** 数据多久刷新一次（刷新缓存 → 取状态一次往返）。 */
const REFRESH_INTERVAL = 60_000;
/** 重置倒计时多久跳一格。 */
const CLOCK_TICK = 30_000;
/** 尺寸回报、位置保存的去抖。 */
const REPORT_DEBOUNCE = 80;
const SAVE_DEBOUNCE = 300;

/** `emphasis` 是 text 里要上色的那段数值，拆开包一层。 */
function QuotaLineText({ line }: { line: PanelQuotaLine }) {
  if (!line.emphasis) return <>{line.text}</>;
  const at = line.text.indexOf(line.emphasis);
  if (at < 0) return <>{line.text}</>;
  return (
    <>
      {line.text.slice(0, at)}
      <span className="qw-emphasis">{line.emphasis}</span>
      {line.text.slice(at + line.emphasis.length)}
    </>
  );
}

function QuotaBlock({
  quota,
  texts,
  now,
}: {
  quota: PanelQuota;
  texts: PanelTexts;
  now: number;
}) {
  if (quota.lines.length === 0) {
    return quota.note ? (
      <div className="text-[11px] leading-snug text-muted-foreground">
        {quota.note}
      </div>
    ) : null;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {quota.lines.map((line, i) => (
        <div key={i}>
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 truncate text-[12px] tabular-nums leading-tight",
                line.warn && "qw-warn",
              )}
            >
              <QuotaLineText line={line} />
            </span>
            {line.resetsAt && (
              <span className="ms-auto shrink-0 whitespace-nowrap text-[10.5px] tabular-nums text-muted-foreground">
                {formatResetIn(line.resetsAt, now, texts)}
              </span>
            )}
          </div>
          {line.left != null && (
            <div className="qw-bar mt-1">
              <div
                className="qw-bar-fill"
                data-warn={line.warn}
                style={{ width: `${Math.max(3, Math.min(100, line.left))}%` }}
              />
            </div>
          )}
        </div>
      ))}
      {quota.resetCredits != null && (
        <div className="text-[10.5px] text-muted-foreground">
          {texts.resetCredits.replace("{count}", String(quota.resetCredits))}
        </div>
      )}
    </div>
  );
}

function AppSection({
  app,
  texts,
  now,
}: {
  app: PanelApp;
  texts: PanelTexts;
  now: number;
}) {
  // 在用那家的额度挂在应用上；子面板里其余查得到额度的供应商各列一小块
  const others = app.rows.filter(
    (row) => row.kind === "provider" && row.provider?.quota && !row.checked,
  );
  return (
    <section className="qw-app flex flex-col gap-1.5 pt-1.5">
      <div className="flex items-baseline gap-2">
        {app.attention && <span className="qw-attention shrink-0" />}
        <span className="shrink-0 text-[11px] font-semibold text-muted-foreground">
          {app.name}
        </span>
        {app.current && (
          <span className="min-w-0 truncate text-[12px] font-medium leading-tight">
            {app.current}
          </span>
        )}
      </div>
      {app.quota && <QuotaBlock quota={app.quota} texts={texts} now={now} />}
      {others.map((row) => (
        <div key={row.id} className="qw-other flex flex-col gap-1">
          <span className="truncate text-[11px] leading-tight text-muted-foreground">
            {row.provider!.name}
          </span>
          <QuotaBlock
            quota={row.provider!.quota!}
            texts={texts}
            now={now}
          />
        </div>
      ))}
    </section>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-2.5 px-3 pb-3">
      <div className="qw-skel mt-1 w-2/3" />
      <div className="qw-skel w-full" />
      <div className="qw-skel w-5/6" />
    </div>
  );
}

export function QuotaWidget() {
  useWidgetTheme();
  const rootRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TrayPanelState | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // 加载完成：摆好存下的位置和首屏尺寸，后端随即显示窗口；拿回玻璃模式选配色
  useEffect(() => {
    let cancelled = false;
    const el = rootRef.current;
    quotaWidgetApi
      .ready(
        readSavedPosition(),
        el?.offsetWidth ?? 300,
        el?.offsetHeight ?? 140,
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
    const timer = window.setInterval(() => void load().catch(() => {}), REFRESH_INTERVAL);
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

  return (
    <div ref={rootRef} className="qw-card">
      <header className="qw-header" data-tauri-drag-region>
        <span className="text-[12px] font-semibold" data-tauri-drag-region>
          {texts?.usageTab ?? "· · ·"}
        </span>
        <button
          type="button"
          className="qw-close"
          aria-label="Close"
          onClick={() => void quotaWidgetApi.hide().catch(() => {})}
        >
          <X className="h-3 w-3" />
        </button>
      </header>
      <div className="qw-body">
        {!state || !texts ? (
          <Skeleton />
        ) : state.apps.length === 0 ? (
          <div className="flex h-16 items-center justify-center text-[11px] text-muted-foreground">
            {texts.noMatch}
          </div>
        ) : (
          state.apps.map((app) => (
            <AppSection key={app.app} app={app} texts={texts} now={now} />
          ))
        )}
      </div>
    </div>
  );
}
