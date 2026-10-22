import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuotaWidget } from "@/quota-widget/QuotaWidget";
import {
  quotaWidgetApi,
  type PanelTexts,
  type TrayPanelState,
} from "@/quota-widget/api";

vi.mock("@/quota-widget/api", () => ({
  quotaWidgetApi: {
    state: vi.fn(),
    refresh: vi.fn(),
    ready: vi.fn(),
    appearance: vi.fn(),
    layout: vi.fn(),
    hide: vi.fn(),
    showMain: vi.fn(),
    agyQuota: vi.fn(),
  },
}));
vi.mock("@/quota-widget/useWidgetTheme", () => ({
  useWidgetTheme: () => false,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onMoved: () => Promise.resolve(() => {}) }),
}));

const texts: PanelTexts = {
  switchProvider: "",
  searchPlaceholder: "",
  inUse: "",
  noMatch: "暂无额度",
  openMain: "打开主窗口",
  quit: "",
  settings: "",
  lightweightMode: "",
  openPanel: "",
  configTab: "",
  usageTab: "用量",
  quotaWidget: "用量悬浮窗",
  tierFiveHour: "5 小时",
  tierWeekly: "每周",
  resetsIn: "{when}后重置",
  durationDays: "{n}天",
  durationHours: "{n}小时",
  durationMinutes: "{n}分",
  durationSep: "",
  resetCredits: "{count}次",
};
const weekReset = () => new Date(Date.now() + 3 * 86400000).toISOString();
function fixture(): TrayPanelState {
  return {
    texts,
    problems: [],
    feedback: null,
    lightweight: false,
    quotaWidget: true,
    quitHint: null,
    apps: [
      {
        app: "claude",
        name: "Claude Code",
        current: "智谱",
        mode: "直连",
        modeKind: "direct",
        header: null,
        attention: null,
        addId: null,
        addText: "",
        rows: [],
        quota: {
          note: null,
          resetCredits: null,
          lines: [
            {
              tier: "five_hour",
              text: "5小时剩余100%",
              left: 100,
              warn: false,
              emphasis: null,
              resetsAt: new Date(Date.now() + 2 * 3600000).toISOString(),
            },
            {
              tier: "weekly",
              text: "每周已用尽",
              left: 0,
              warn: true,
              emphasis: null,
              resetsAt: weekReset(),
            },
          ],
        },
      },
    ],
  };
}

beforeEach(() => {
  vi.mocked(quotaWidgetApi.state).mockResolvedValue(fixture());
  vi.mocked(quotaWidgetApi.refresh).mockResolvedValue(undefined);
  vi.mocked(quotaWidgetApi.ready).mockResolvedValue({
    glass: "acrylic",
    platform: "windows",
  });
  vi.mocked(quotaWidgetApi.appearance).mockResolvedValue({
    glass: "acrylic",
    platform: "windows",
  });
  vi.mocked(quotaWidgetApi.showMain).mockResolvedValue(undefined);
  vi.mocked(quotaWidgetApi.agyQuota).mockResolvedValue({
    success: true,
    tiers: [],
  });
});

describe("QuotaWidget", () => {
  it("has one compact card, uses the provider name, and shows the exhausted week's reset", async () => {
    const { container } = render(<QuotaWidget />);
    expect(await screen.findByText("智谱")).toBeVisible();
    expect(screen.queryByText("Claude Code")).toBeNull();
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByText("0%")).toHaveClass("qw-danger");
    expect(screen.getByText(/2天23小时|3天/)).toBeVisible();
    expect(container.querySelectorAll(".qw-card")).toHaveLength(1);
    expect(container.querySelector(".qw-stage")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("returns to idle after leaving even if the window retains focus", async () => {
    const { container } = render(<QuotaWidget />);
    await screen.findByText("智谱");
    const card = container.querySelector(".qw-card")!;
    fireEvent.mouseEnter(card);
    fireEvent.focus(window);
    expect(card).toHaveAttribute("data-active", "true");
    fireEvent.mouseLeave(card);
    expect(card).toHaveAttribute("data-active", "false");
    fireEvent.mouseEnter(card);
    fireEvent.blur(window);
    expect(card).toHaveAttribute("data-active", "false");
  });

  it("reports an AGY read error instead of silently losing that row", async () => {
    vi.mocked(quotaWidgetApi.agyQuota).mockResolvedValue({
      success: false,
      tiers: [],
      error: "Credential read failed",
    });
    render(<QuotaWidget />);
    expect(
      await screen.findByText("Antigravity · Credential read failed"),
    ).toBeVisible();
  });

  it("keeps Claude and Gemini weekly markers independent", async () => {
    vi.mocked(quotaWidgetApi.agyQuota).mockResolvedValue({
      success: true,
      tiers: [
        {
          name: "agy_third_party_five_hour",
          utilization: 0,
          resetsAt: weekReset(),
        },
        {
          name: "agy_third_party_weekly",
          utilization: 100,
          resetsAt: weekReset(),
        },
        {
          name: "agy_gemini_five_hour",
          utilization: 40,
          resetsAt: weekReset(),
        },
        { name: "agy_gemini_weekly", utilization: 20, resetsAt: weekReset() },
      ],
    });
    render(<QuotaWidget />);
    await screen.findByText("Antigravity (Claude)");
    const meters = screen.getAllByRole("meter");
    expect(meters[1]).toHaveAttribute("aria-valuenow", "0");
    expect(meters[2]).toHaveAttribute("aria-valuenow", "60");
  });

  it("opens the main window on double click, not on the first early click", async () => {
    const { container } = render(<QuotaWidget />);
    await screen.findByText("智谱");
    const card = container.querySelector(".qw-card")!;
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(220);
    fireEvent.mouseDown(card, { button: 0 });
    expect(quotaWidgetApi.showMain).not.toHaveBeenCalled();
    fireEvent.mouseDown(card, { button: 0 });
    await waitFor(() =>
      expect(quotaWidgetApi.showMain).toHaveBeenCalledTimes(1),
    );
    await act(async () => {});
    vi.restoreAllMocks();
  });
});
