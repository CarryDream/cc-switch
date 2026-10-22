import { invoke } from "@tauri-apps/api/core";
import type { AppId } from "@/lib/api/types";
import type { AppMode } from "@/types/proxy";

/** 悬浮窗的数据与托盘面板同源（后端 `tray_panel::TrayPanelState`）。 */
export interface PanelTexts {
  switchProvider: string;
  searchPlaceholder: string;
  inUse: string;
  noMatch: string;
  openMain: string;
  quit: string;
  settings: string;
  lightweightMode: string;
  openPanel: string;
  configTab: string;
  usageTab: string;
  /** 托盘面板底部开关额度悬浮窗（悬浮窗自己不用，字段与后端对齐） */
  quotaWidget: string;
  /** 档位名（Antigravity 行用） */
  tierFiveHour: string;
  tierWeekly: string;
  /** 某一档还有多久重置：`{when}` 是下面几个单位拼出的时长 */
  resetsIn: string;
  /** 时长单位：`{n}` 是数字；最多取两级，中间用 `durationSep` 隔开 */
  durationDays: string;
  durationHours: string;
  durationMinutes: string;
  durationSep: string;
  /** 可用的额度重置次数：`{count}` */
  resetCredits: string;
}

export interface PanelQuotaLine {
  text: string;
  /** 剩余百分比；余额这种没有总额的为空 */
  left: number | null;
  warn: boolean;
  /** 这一档什么时候重置（ISO 8601） */
  resetsAt: string | null;
  /** `text` 里要上绿色的那段数值（还有余额时的金额） */
  emphasis: string | null;
  /** 机器可读的档位（`five_hour` / `weekly`）；没有档名的为空 */
  tier: string | null;
}

export interface PanelQuota {
  lines: PanelQuotaLine[];
  note: string | null;
  /** ChatGPT 订阅（Codex）可用的额度重置次数 */
  resetCredits: number | null;
}

export interface PanelProvider {
  name: string;
  hint: string | null;
  icon: string | null;
  iconColor: string | null;
  quota: PanelQuota | null;
}

export interface PanelRow {
  kind: "provider" | "check" | "item" | "label" | "separator";
  id: string;
  text: string;
  enabled: boolean;
  checked: boolean;
  provider: PanelProvider | null;
}

export interface PanelApp {
  app: AppId;
  name: string;
  current: string | null;
  mode: string;
  modeKind: AppMode;
  header: string | null;
  attention: string | null;
  quota: PanelQuota | null;
  addId: string | null;
  addText: string;
  rows: PanelRow[];
}

export interface TrayPanelState {
  texts: PanelTexts;
  problems: PanelLink[];
  feedback: string | null;
  apps: PanelApp[];
  lightweight: boolean;
  quotaWidget: boolean;
  quitHint: string | null;
}

export interface PanelLink {
  id: string;
  text: string;
}

/** 存下的窗口位置（物理像素，`onMoved` 给什么存什么）。 */
export interface WidgetPosition {
  x: number;
  y: number;
}

/** Antigravity 额度的一档（后端 `subscription::QuotaTier`）。 */
export interface AgyQuotaTier {
  /** 窗口标识：five_hour、seven_day、seven_day_opus 等 */
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
}

/** 后端 `quota_widget_ready` 的回执：背后是哪种玻璃、什么平台。 */
export interface WidgetGlass {
  glass: "native" | "acrylic" | "frosted";
  platform: string;
}

export const quotaWidgetApi = {
  /** 与托盘面板同一份数据 */
  state: () => invoke<TrayPanelState>("tray_panel_state"),
  /** 刷新各家额度（写缓存），随后 `state` 取新数据 */
  refresh: () => invoke<void>("quota_widget_refresh"),
  /** 前端加载完成：摆好位置和尺寸后显示，拿回玻璃模式 */
  ready: (position: WidgetPosition | null, width: number, height: number) =>
    invoke<WidgetGlass>("quota_widget_ready", { position, width, height }),
  /** 内容变了：窗口跟着改尺寸 */
  layout: (width: number, height: number) =>
    invoke<void>("quota_widget_layout", { width, height }),
  hide: () => invoke<void>("quota_widget_hide"),
  /** 双击卡片：打开主窗口 */
  showMain: () => invoke<void>("quota_widget_show_main"),
  /** Antigravity 当前登录号的额度（每次都是网络请求，别调太勤） */
  agyQuota: () => invoke<AgyAccountQuota>("quota_widget_agy_quota"),
};
