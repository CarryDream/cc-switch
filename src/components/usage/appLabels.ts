import { APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import type { AppId } from "@/lib/api";

/**
 * 只导入了用量、还没做成应用（没有 `AppId`）的客户端。用量页认得它们，
 * 没有供应商卡片，名字单独给（品牌图标见 `AppGlyph` 的 `APP_ICON_NAME`）。
 */
export const USAGE_ONLY_APP_NAMES: Record<
  string,
  { name: string; short: string }
> = {
  droid: { name: "Factory Droid", short: "Droid" },
};

export function isKnownAppId(appType: string): appType is AppId {
  return appType in APP_DISPLAY_NAME;
}

export function appDisplayName(appType: string): string {
  const usageOnly = USAGE_ONLY_APP_NAMES[appType];
  if (usageOnly) return usageOnly.name;
  return isKnownAppId(appType) ? APP_DISPLAY_NAME[appType] : appType;
}

/**
 * 请求日志「应用」列用的短名：图标已经区分了品牌（Claude Code / Desktop 靠角标），
 * 列里只留最短能认出的名字，把宽度让给供应商列。全名在悬停提示里。
 */
const APP_SHORT_NAME: Record<AppId, string> = {
  claude: "Claude",
  "claude-desktop": "Desktop",
  codex: "Codex",
  gemini: "Gemini",
  grokbuild: "Grok",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  pi: "Pi",
  mcode: "MiniMax",
  kimi: "Kimi",
  dsh: "DSH",
  agy: "Antigravity",
  omp: "omp",
  copilot: "Copilot",
  workbuddy: "WorkBuddy",
  codebuddy: "CodeBuddy",
};

/** 没有品牌图标的应用在筛选条里显示的两位字母标记。 */
export function usageOnlyMonogram(appType: string): string {
  return (USAGE_ONLY_APP_NAMES[appType]?.short ?? appType).slice(0, 2);
}

export function appShortName(appType: string): string {
  const usageOnly = USAGE_ONLY_APP_NAMES[appType];
  if (usageOnly) return usageOnly.short;
  return isKnownAppId(appType) ? APP_SHORT_NAME[appType] : appType;
}
