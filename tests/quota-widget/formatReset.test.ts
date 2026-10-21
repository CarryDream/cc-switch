import { describe, expect, it } from "vitest";
import { formatResetIn } from "@/quota-widget/formatReset";
import type { PanelTexts } from "@/quota-widget/api";

const texts: PanelTexts = {
  switchProvider: "切换供应商",
  searchPlaceholder: "搜索供应商…",
  inUse: "使用中",
  noMatch: "没有匹配的供应商",
  openMain: "打开主窗口",
  quit: "退出",
  settings: "设置",
  lightweightMode: "轻量模式",
  openPanel: "打开快捷面板",
  configTab: "配置",
  usageTab: "用量",
  quotaWidget: "用量悬浮窗",
  resetsIn: "{when}后重置",
  durationDays: "{n}天",
  durationHours: "{n}小时",
  durationMinutes: "{n}分",
  durationSep: "",
  resetCredits: "可重置 {count} 次",
};

describe("formatResetIn", () => {
  it("拼出两级时长（小时+分）", () => {
    const now = Date.parse("2026-10-22T10:00:00+08:00");
    expect(formatResetIn("2026-10-22T12:34:00+08:00", now, texts)).toBe(
      "2小时34分后重置",
    );
  });

  it("天+小时", () => {
    const now = Date.parse("2026-10-22T10:00:00+08:00");
    expect(formatResetIn("2026-10-24T13:00:00+08:00", now, texts)).toBe(
      "2天3小时后重置",
    );
  });

  it("不到一小时只写分钟，至少 1 分", () => {
    const now = Date.parse("2026-10-22T10:00:00+08:00");
    expect(formatResetIn("2026-10-22T10:00:20+08:00", now, texts)).toBe(
      "1分后重置",
    );
  });

  it("已到时间或解析失败返回空（等下次刷新）", () => {
    const now = Date.parse("2026-10-22T10:00:00+08:00");
    expect(formatResetIn("2026-10-22T09:00:00+08:00", now, texts)).toBeNull();
    expect(formatResetIn("not-a-date", now, texts)).toBeNull();
  });

  it("英语用空格分隔单位", () => {
    const en = { ...texts, resetsIn: "Resets in {when}", durationDays: "{n}d", durationHours: "{n}h", durationMinutes: "{n}m", durationSep: " " };
    const now = Date.parse("2026-10-22T10:00:00Z");
    expect(formatResetIn("2026-10-22T12:34:00Z", now, en)).toBe(
      "Resets in 2h 34m",
    );
  });
});
