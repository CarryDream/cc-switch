import { invoke } from "@tauri-apps/api/core";
import type {
  PanelApp,
  PanelLink,
  PanelProvider,
  PanelQuota,
  PanelQuotaLine,
  PanelRow,
  PanelTexts,
  TrayPanelState,
} from "@/tray-panel/api";

export type {
  PanelApp,
  PanelLink,
  PanelProvider,
  PanelQuota,
  PanelQuotaLine,
  PanelRow,
  PanelTexts,
  TrayPanelState,
};

/** 后端状态（切换供应商、刷新额度、切换语言等）更新后推给悬浮窗的事件。 */
export const WIDGET_CHANGED_EVENT = "quota-widget-changed";
/** 悬浮窗显示/隐藏状态切换事件，隐藏时暂停轮询、重新露面时立刻恢复。 */
export const WIDGET_VISIBILITY_EVENT = "quota-widget-visibility";

export interface WidgetVisibility {
  visible: boolean;
  texts: PanelTexts;
}

/** 存下的窗口位置（物理像素，`onMoved` 给什么存什么）。 */
export interface WidgetPosition {
  x: number;
  y: number;
}

/** Antigravity 额度的一档（后端 `subscription::QuotaTier`）。 */
export interface AgyQuotaTier {
  /** 窗口标识：five_hour、seven_day、agy_gemini_argon_weekly 等 */
  name: string;
  /** 使用百分比 0–100 */
  utilization: number;
  /** ISO 8601 重置时间 */
  resetsAt: string | null;
}

/** 后端 `subscription::SubscriptionQuota` 里悬浮窗用到的字段。 */
export interface AgyAccountQuota {
  success: boolean;
  tiers: AgyQuotaTier[];
  error?: string | null;
  credentialStatus?: string;
}

/** 后端 `quota_widget_ready` / `quota_widget_appearance` 的回执：玻璃模式、平台。 */
export interface WidgetGlass {
  glass: "native" | "acrylic" | "frosted";
  platform: string;
}

/** `quota_widget_ready` 额外带上首帧文案（悬浮窗不加载界面的 i18n）。 */
export interface WidgetReady extends WidgetGlass {
  texts: PanelTexts;
}

export const quotaWidgetApi = {
  /** 与托盘面板同一份数据 */
  state: () => invoke<TrayPanelState>("tray_panel_state"),
  /** 刷新各家额度（写缓存），随后 `state` 取新数据 */
  refresh: () => invoke<void>("quota_widget_refresh"),
  /** 仅取玻璃模式、平台与首帧文案，不展示窗口（冷启动先渲染真实高度再 ready） */
  bootstrap: () => invoke<WidgetReady>("quota_widget_bootstrap"),
  /** 前端加载完成：摆好位置和尺寸后显示，拿回玻璃模式与首帧文案 */
  ready: (position: WidgetPosition | null, width: number, height: number) =>
    invoke<WidgetReady>("quota_widget_ready", { position, width, height }),
  appearance: (dark: boolean) =>
    invoke<WidgetGlass>("quota_widget_appearance", { dark }),
  /** 内容变了：窗口跟着改尺寸 */
  layout: (width: number, height: number) =>
    invoke<void>("quota_widget_layout", { width, height }),
  /** 重置窗口到默认位置（主屏右上角工作区） */
  resetPosition: (width: number, height: number) =>
    invoke<void>("quota_widget_reset_position", { width, height }),
  /** 双击卡片或右键菜单：打开主窗口 */
  showMain: () => invoke<void>("quota_widget_show_main"),
  /** 右键菜单隐藏悬浮窗并同步托盘开关状态 */
  hide: () => invoke<void>("quota_widget_hide"),
  /** Antigravity 当前登录号的额度（支持 10s 缓存去抖，手动刷新传 force=true） */
  agyQuota: (force = false) =>
    invoke<AgyAccountQuota>("quota_widget_agy_quota", { force }),
};
