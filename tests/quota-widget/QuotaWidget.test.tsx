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
  WIDGET_CHANGED_EVENT,
  WIDGET_VISIBILITY_EVENT,
  quotaWidgetApi,
  type PanelTexts,
  type TrayPanelState,
} from "@/quota-widget/api";
import { readSavedPosition, savePosition } from "@/quota-widget/position";

const eventHandlers = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, cb: (event: { payload: unknown }) => void) => {
    eventHandlers.set(event, cb);
    return Promise.resolve(() => {
      eventHandlers.delete(event);
    });
  }),
}));

vi.mock("@/quota-widget/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/quota-widget/api")>()),
  quotaWidgetApi: {
    state: vi.fn(),
    refresh: vi.fn(),
    bootstrap: vi.fn(),
    ready: vi.fn(),
    appearance: vi.fn(),
    layout: vi.fn(),
    resetPosition: vi.fn(),
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
  refresh: "立即刷新",
  hideWidget: "隐藏悬浮窗",
  tierDual: "双轨",
  tierFiveHour: "5 小时",
  tierWeekly: "每周",
  lockPosition: "锁定位置",
  unlockPosition: "解锁位置",
  resetPosition: "重置位置",
  opacityLight: "轻透",
  opacityBalanced: "均衡",
  opacitySolid: "实底",
  refreshing: "刷新中…",
  updatedJustNow: "刚刚更新",
  updatedAgo: "{when}前更新",
  resetsIn: "{when}后重置",
  durationDays: "{n}天",
  durationHours: "{n}小时",
  durationMinutes: "{n}分",
  durationSep: "",
  resetCredits: "可重置 {count} 次",
};
const weekReset = () => new Date(Date.now() + 3 * 86400000).toISOString();
const fiveReset = () => new Date(Date.now() + 2 * 3600000).toISOString();

function fixture(): TrayPanelState {
  return {
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
              resetsAt: fiveReset(),
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
  eventHandlers.clear();
  window.localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(quotaWidgetApi.state).mockResolvedValue(fixture());
  vi.mocked(quotaWidgetApi.refresh).mockResolvedValue(undefined);
  vi.mocked(quotaWidgetApi.bootstrap).mockResolvedValue({
    glass: "acrylic",
    platform: "windows",
    texts,
  });
  vi.mocked(quotaWidgetApi.ready).mockResolvedValue({
    glass: "acrylic",
    platform: "windows",
    texts,
  });
  vi.mocked(quotaWidgetApi.appearance).mockResolvedValue({
    glass: "acrylic",
    platform: "windows",
  });
  vi.mocked(quotaWidgetApi.layout).mockResolvedValue(undefined);
  vi.mocked(quotaWidgetApi.resetPosition).mockResolvedValue(undefined);
  vi.mocked(quotaWidgetApi.showMain).mockResolvedValue(undefined);
  vi.mocked(quotaWidgetApi.hide).mockResolvedValue(undefined);
  vi.mocked(quotaWidgetApi.agyQuota).mockResolvedValue({
    success: false,
    tiers: [],
    credentialStatus: "not_found",
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
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("defers ready() until bootstrap and initial state render real DOM (zero-jump startup)", async () => {
    let resolveState!: (value: TrayPanelState) => void;
    vi.mocked(quotaWidgetApi.state).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveState = resolve;
        }),
    );
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const hasRealRow = Boolean(this.querySelector(".qw-row"));
        return {
          width: 296,
          height: hasRealRow ? 148 : 54,
        } as DOMRect;
      });

    render(<QuotaWidget />);
    // 骨架屏阶段不提前调用 ready()
    await act(async () => {});
    expect(quotaWidgetApi.bootstrap).toHaveBeenCalledTimes(1);
    expect(quotaWidgetApi.ready).not.toHaveBeenCalled();

    // 首帧真实数据到位后，直接以真实高度调用一次 ready()
    await act(async () => {
      resolveState(fixture());
    });
    expect(await screen.findByText("智谱")).toBeVisible();
    expect(quotaWidgetApi.ready).toHaveBeenCalledTimes(1);
    expect(quotaWidgetApi.ready).toHaveBeenCalledWith(null, 296, 148);
    rectSpy.mockRestore();
  });

  it("falls back to calling ready() after 150ms if initial state is slow", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(quotaWidgetApi.state).mockReturnValue(new Promise(() => {}));
      render(<QuotaWidget />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(quotaWidgetApi.ready).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(155);
      });
      expect(quotaWidgetApi.ready).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gracefully falls back to ready() when bootstrap() fails", async () => {
    vi.mocked(quotaWidgetApi.bootstrap).mockRejectedValueOnce(
      new Error("unknown command"),
    );
    render(<QuotaWidget />);
    expect(await screen.findByText("智谱")).toBeVisible();
    expect(quotaWidgetApi.ready).toHaveBeenCalledTimes(1);
  });

  it("switches between dual, 5-hour, and weekly views with 3 footer pills", async () => {
    const { container } = render(<QuotaWidget />);
    await screen.findByText("智谱");

    const dualBtn = screen.getByRole("button", { name: "双轨" });
    const fiveHourBtn = screen.getByRole("button", { name: "5 小时" });
    const weeklyBtn = screen.getByRole("button", { name: "每周" });

    // 默认双轨：智谱 5h=100%, weekly=0% -> 瓶颈显示 0% + 周游标存在
    expect(dualBtn).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("0%")).toBeVisible();
    expect(container.querySelector(".qw-week-marker")).not.toBeNull();

    // 点「5 小时」：只看 5h -> 显示 100% + 5h 重置时间，不显示周游标
    fireEvent.click(fiveHourBtn);
    expect(fiveHourBtn).toHaveAttribute("aria-pressed", "true");
    expect(dualBtn).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("100%")).toBeVisible();
    expect(screen.getByText(/1小时59分|2小时/)).toBeVisible();
    expect(container.querySelector(".qw-week-marker")).toBeNull();

    // 点「每周」：切到每周视图 -> 显示 0% + 周重置时间 + weekly 变体
    fireEvent.click(weeklyBtn);
    expect(weeklyBtn).toHaveAttribute("aria-pressed", "true");
    expect(fiveHourBtn).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("0%")).toBeVisible();
    expect(screen.getByRole("meter")).toHaveAttribute("data-variant", "weekly");

    // 再次点击已选中的「每周」恢复默认双轨视图
    fireEvent.click(weeklyBtn);
    expect(weeklyBtn).toHaveAttribute("aria-pressed", "false");
    expect(dualBtn).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".qw-week-marker")).not.toBeNull();

    // 切到「5 小时」后再点「双轨」也能直接返回双轨
    fireEvent.click(fiveHourBtn);
    expect(fiveHourBtn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(dualBtn);
    expect(dualBtn).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".qw-week-marker")).not.toBeNull();
  });

  it("keeps exact stable row order across dual, 5-hour, and weekly views while dimming missing-tier rows with 5h/7d badges", async () => {
    const state = fixture();
    state.apps = [
      {
        ...state.apps[0],
        app: "codex",
        name: "Codex",
        current: "OpenAI-5hOnly",
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
              resetsAt: fiveReset(),
            },
          ],
        },
      },
      {
        ...state.apps[0],
        app: "claude",
        name: "Claude Code",
        current: "智谱双轨",
      },
      {
        ...state.apps[0],
        app: "gemini",
        name: "Gemini",
        current: "WeeklyOnly",
        quota: {
          note: null,
          resetCredits: null,
          lines: [
            {
              tier: "weekly",
              text: "每周剩余60%",
              left: 60,
              warn: false,
              emphasis: null,
              resetsAt: weekReset(),
            },
          ],
        },
      },
    ];
    vi.mocked(quotaWidgetApi.state).mockResolvedValue(state);
    const { container } = render(<QuotaWidget />);
    await screen.findByText("OpenAI-5hOnly");

    const rowNames = () =>
      Array.from(container.querySelectorAll(".qw-name-text")).map(
        (el) => el.textContent,
      );

    // 默认双轨维持原顺序
    expect(rowNames()).toEqual(["OpenAI-5hOnly", "智谱双轨", "WeeklyOnly"]);

    // 切到每周视图：顺序完全不变，仅 5h 的第一行置灰并标出 5h 徽标
    fireEvent.click(screen.getByRole("button", { name: "每周" }));
    expect(rowNames()).toEqual(["OpenAI-5hOnly", "智谱双轨", "WeeklyOnly"]);
    const rowsInWeekly = container.querySelectorAll(".qw-row");
    expect(rowsInWeekly[0]).toHaveClass("qw-row-dim");
    expect(rowsInWeekly[0].querySelector(".qw-tier-badge")).toHaveTextContent(
      "5h",
    );
    expect(rowsInWeekly[1]).not.toHaveClass("qw-row-dim");
    expect(rowsInWeekly[2]).not.toHaveClass("qw-row-dim");

    // 切到 5 小时视图：顺序完全不变，仅周额度的第三行置灰并标出 7d 徽标
    fireEvent.click(screen.getByRole("button", { name: "5 小时" }));
    expect(rowNames()).toEqual(["OpenAI-5hOnly", "智谱双轨", "WeeklyOnly"]);
    const rowsInFiveHour = container.querySelectorAll(".qw-row");
    expect(rowsInFiveHour[0]).not.toHaveClass("qw-row-dim");
    expect(rowsInFiveHour[1]).not.toHaveClass("qw-row-dim");
    expect(rowsInFiveHour[2]).toHaveClass("qw-row-dim");
    expect(rowsInFiveHour[2].querySelector(".qw-tier-badge")).toHaveTextContent(
      "7d",
    );
  });

  it("matches percentage text tone classes (.qw-low, .qw-warn, .qw-danger) to bar severity", async () => {
    const state = fixture();
    state.apps = [
      {
        ...state.apps[0],
        app: "claude",
        current: "LowTier",
        quota: {
          note: null,
          resetCredits: null,
          lines: [
            {
              tier: "five_hour",
              text: "5小时剩余35%",
              left: 35,
              warn: false,
              emphasis: null,
              resetsAt: null,
            },
          ],
        },
      },
      {
        ...state.apps[0],
        app: "codex",
        current: "WarnTier",
        quota: {
          note: null,
          resetCredits: null,
          lines: [
            {
              tier: "five_hour",
              text: "5小时剩余12%",
              left: 12,
              warn: true,
              emphasis: null,
              resetsAt: null,
            },
          ],
        },
      },
      {
        ...state.apps[0],
        app: "gemini",
        current: "DangerTier",
        quota: {
          note: null,
          resetCredits: null,
          lines: [
            {
              tier: "five_hour",
              text: "5小时剩余0%",
              left: 0,
              warn: true,
              emphasis: null,
              resetsAt: null,
            },
          ],
        },
      },
    ];
    vi.mocked(quotaWidgetApi.state).mockResolvedValue(state);
    render(<QuotaWidget />);
    expect(await screen.findByText("35%")).toHaveClass("qw-low");
    expect(screen.getByText("12%")).toHaveClass("qw-warn");
    expect(screen.getByText("0%")).toHaveClass("qw-danger");
  });

  it("expands inline row details on single click (including resetCredits, note, and Argon weekly) and cancels on double click", async () => {
    const state = fixture();
    state.apps[0].quota!.resetCredits = 3;
    state.apps[0].quota!.note = "订阅有效至月底";
    vi.mocked(quotaWidgetApi.state).mockResolvedValue(state);
    vi.mocked(quotaWidgetApi.agyQuota).mockResolvedValue({
      success: true,
      tiers: [
        {
          name: "agy_gemini_five_hour",
          utilization: 40,
          resetsAt: fiveReset(),
        },
        {
          name: "agy_gemini_weekly",
          utilization: 20,
          resetsAt: weekReset(),
        },
        {
          name: "agy_gemini_argon_weekly",
          utilization: 90,
          resetsAt: weekReset(),
        },
      ],
    });

    const { container } = render(<QuotaWidget />);
    await screen.findByText("智谱");
    await screen.findByText("Antigravity");

    // 折叠态不渲染详情内容
    expect(screen.queryByText("可重置 3 次")).toBeNull();
    expect(screen.queryByText("Argon 每周")).toBeNull();

    // 单击第一行展开详情
    const rows = container.querySelectorAll(".qw-row");
    fireEvent.click(rows[0]);
    expect(await screen.findByText("可重置 3 次")).toBeVisible();
    expect(screen.getByText("订阅有效至月底")).toBeVisible();
    expect(rows[0]).toHaveAttribute("data-expanded", "true");

    // 单击 AGY 行展开所有档位（含 Argon 每周）
    fireEvent.click(rows[1]);
    expect(await screen.findByText("Argon 每周")).toBeVisible();
    expect(screen.getByText("80%")).toBeVisible();

    // 再次单击收起第一行
    fireEvent.click(rows[0]);
    await waitFor(() => expect(screen.queryByText("可重置 3 次")).toBeNull());

    // 双击行应打开主窗口而不是展开行详情
    const nowSpy = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(180);
    fireEvent.mouseDown(rows[0], { button: 0, clientX: 25, clientY: 25 });
    fireEvent.click(rows[0], { clientX: 25, clientY: 25 });
    fireEvent.mouseDown(rows[0], { button: 0, clientX: 25, clientY: 25 });
    fireEvent.click(rows[0], { clientX: 25, clientY: 25 });
    expect(quotaWidgetApi.showMain).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => window.setTimeout(resolve, 260));
    expect(screen.queryByText("可重置 3 次")).toBeNull();
    nowSpy.mockRestore();
  });

  it("renders immediately from cached state and shows pulsing status dot while background refresh is pending", async () => {
    vi.mocked(quotaWidgetApi.refresh).mockReturnValue(new Promise(() => {}));
    const { container } = render(<QuotaWidget />);
    expect(await screen.findByText("智谱")).toBeVisible();
    const dot = container.querySelector(".qw-status-dot")!;
    expect(dot).toHaveClass("qw-status-dot-busy");
    expect(dot).toHaveAttribute("title", "刷新中…");
  });

  it("deduplicates concurrent in-flight refresh and AGY calls", async () => {
    let resolveRefresh!: () => void;
    vi.mocked(quotaWidgetApi.refresh).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    let resolveAgy!: () => void;
    vi.mocked(quotaWidgetApi.agyQuota).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAgy = () =>
            resolve({
              success: false,
              tiers: [],
              credentialStatus: "not_found",
            });
        }),
    );

    const { container } = render(<QuotaWidget />);
    await screen.findByText("智谱");
    await waitFor(() =>
      expect(quotaWidgetApi.refresh).toHaveBeenCalledTimes(1),
    );
    expect(quotaWidgetApi.agyQuota).toHaveBeenCalledTimes(1);

    // 刷新进行中再次点击右键「立即刷新」不会重复并发触发
    fireEvent.contextMenu(container.querySelector(".qw-card")!);
    fireEvent.click(screen.getByRole("menuitem", { name: "立即刷新" }));
    expect(quotaWidgetApi.refresh).toHaveBeenCalledTimes(1);
    expect(quotaWidgetApi.agyQuota).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRefresh();
      resolveAgy();
    });
    const dot = container.querySelector(".qw-status-dot")!;
    await waitFor(() => expect(dot).not.toHaveClass("qw-status-dot-busy"));
    expect(dot).toHaveAttribute("title", "刚刚更新");
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

  it("silently omits Antigravity when credentials are not_found", async () => {
    render(<QuotaWidget />);
    await screen.findByText("智谱");
    expect(screen.queryByText(/Antigravity/)).toBeNull();
  });

  it("reports a real AGY read error instead of silently losing that row", async () => {
    vi.mocked(quotaWidgetApi.agyQuota).mockResolvedValue({
      success: false,
      tiers: [],
      credentialStatus: "valid",
      error: "Credential read failed",
    });
    render(<QuotaWidget />);
    expect(
      await screen.findByText("Antigravity · Credential read failed"),
    ).toBeVisible();
  });

  it("keeps last good AGY tiers when a subsequent forced refresh fails", async () => {
    vi.mocked(quotaWidgetApi.agyQuota)
      .mockResolvedValueOnce({
        success: true,
        tiers: [
          {
            name: "agy_gemini_five_hour",
            utilization: 25,
            resetsAt: fiveReset(),
          },
        ],
      })
      .mockResolvedValueOnce({
        success: false,
        tiers: [],
        credentialStatus: "valid",
        error: "Network timeout",
      });

    const { container } = render(<QuotaWidget />);
    expect(await screen.findByText("Antigravity")).toBeVisible();
    expect(screen.getByText("75%")).toBeVisible();
    expect(quotaWidgetApi.agyQuota).toHaveBeenNthCalledWith(1, false);

    // 右键菜单点立即刷新，带 force=true 请求；第二次失败仍保留 75% 行
    fireEvent.contextMenu(container.querySelector(".qw-card")!);
    fireEvent.click(screen.getByRole("menuitem", { name: "立即刷新" }));
    await waitFor(() =>
      expect(quotaWidgetApi.agyQuota).toHaveBeenCalledTimes(2),
    );
    expect(quotaWidgetApi.agyQuota).toHaveBeenNthCalledWith(2, true);
    expect(screen.getByText("Antigravity")).toBeVisible();
    expect(screen.getByText("75%")).toBeVisible();
  });

  it("keeps Claude and Gemini weekly markers independent and picks worst weekly including Argon", async () => {
    vi.mocked(quotaWidgetApi.agyQuota).mockResolvedValue({
      success: true,
      tiers: [
        {
          name: "agy_third_party_five_hour",
          utilization: 0,
          resetsAt: fiveReset(),
        },
        {
          name: "agy_third_party_weekly",
          utilization: 100,
          resetsAt: weekReset(),
        },
        {
          name: "agy_gemini_five_hour",
          utilization: 40,
          resetsAt: fiveReset(),
        },
        { name: "agy_gemini_weekly", utilization: 20, resetsAt: weekReset() },
        {
          name: "agy_gemini_argon_weekly",
          utilization: 90,
          resetsAt: weekReset(),
        },
      ],
    });
    render(<QuotaWidget />);
    await screen.findByText("Antigravity (Claude)");
    const meters = screen.getAllByRole("meter");
    expect(meters[1]).toHaveAttribute("aria-valuenow", "0");
    // Gemini Argon 周额度只剩 10%，成为瓶颈
    expect(meters[2]).toHaveAttribute("aria-valuenow", "10");
  });

  it("shows later reset time when both 5-hour and weekly quotas are 0%", async () => {
    const state = fixture();
    state.apps[0].quota!.lines[0].left = 0;
    state.apps[0].quota!.lines[1].left = 0;
    vi.mocked(quotaWidgetApi.state).mockResolvedValue(state);
    render(<QuotaWidget />);
    await screen.findByText("智谱");
    expect(screen.getByText(/2天23小时|3天/)).toBeVisible();
  });

  it("renders balance providers and expired plans with readable text instead of em-dash", async () => {
    const state = fixture();
    state.apps = [
      {
        ...state.apps[0],
        app: "claude",
        name: "Claude Code",
        current: "DeepSeek",
        quota: {
          note: null,
          resetCredits: null,
          lines: [
            {
              tier: null,
              text: "余额 82.10 CNY",
              left: null,
              warn: false,
              emphasis: "82.10 CNY",
              resetsAt: null,
            },
          ],
        },
      },
      {
        ...state.apps[0],
        app: "codex",
        name: "Codex",
        current: "ExpiredPlan",
        quota: {
          note: null,
          resetCredits: null,
          lines: [
            {
              tier: null,
              text: "套餐已过期",
              left: null,
              warn: true,
              emphasis: null,
              resetsAt: null,
            },
          ],
        },
      },
    ];
    vi.mocked(quotaWidgetApi.state).mockResolvedValue(state);
    render(<QuotaWidget />);
    expect(await screen.findByText("82.10 CNY")).toHaveClass("qw-balance");
    expect(screen.getByText("套餐已过期")).toHaveClass("qw-danger");
    expect(screen.queryByRole("meter")).toBeNull();
    // 没有双档条时不展示双档图例
    expect(screen.queryByText("5 小时")).toBeNull();
  });

  it("only shows dual-bar legend when a row actually has both 5-hour and weekly tiers", async () => {
    const state = fixture();
    // 只有 weekly 单档，没有 5 小时档
    state.apps[0].quota!.lines = [state.apps[0].quota!.lines[1]];
    vi.mocked(quotaWidgetApi.state).mockResolvedValue(state);
    render(<QuotaWidget />);
    await screen.findByText("智谱");
    expect(screen.queryByText("双轨")).toBeNull();
    expect(screen.queryByText("5 小时")).toBeNull();
    expect(screen.queryByText("每周")).toBeNull();
  });

  it("disambiguates identical provider names across different apps", async () => {
    const state = fixture();
    state.apps = [
      { ...state.apps[0], app: "claude", name: "Claude Code", current: "官方" },
      { ...state.apps[0], app: "codex", name: "Codex", current: "官方" },
    ];
    vi.mocked(quotaWidgetApi.state).mockResolvedValue(state);
    render(<QuotaWidget />);
    expect(await screen.findByText("Claude Code")).toBeVisible();
    expect(screen.getByText("Codex")).toBeVisible();
  });

  it("opens main window on double click without movement, but ignores drag-like movement", async () => {
    const { container } = render(<QuotaWidget />);
    await screen.findByText("智谱");
    const card = container.querySelector(".qw-card")!;

    const nowSpy = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(220)
      .mockReturnValueOnce(500)
      .mockReturnValueOnce(620);

    // 移动超过 4px 的两次按下不算双击
    fireEvent.mouseDown(card, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseDown(card, { button: 0, clientX: 40, clientY: 10 });
    expect(quotaWidgetApi.showMain).not.toHaveBeenCalled();

    // 同一点双击才打开主窗口
    fireEvent.mouseDown(card, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.mouseDown(card, { button: 0, clientX: 22, clientY: 21 });
    await waitFor(() =>
      expect(quotaWidgetApi.showMain).toHaveBeenCalledTimes(1),
    );
    await act(async () => {});
    nowSpy.mockRestore();
  });

  it("supports floating context menu: opacity presets, lock/unlock drag region, reset position, and hide", async () => {
    savePosition(500, 300);
    expect(readSavedPosition()).toEqual({ x: 500, y: 300 });

    const { container } = render(<QuotaWidget />);
    await screen.findByText("智谱");
    const card = container.querySelector(".qw-card")!;
    expect(card).toHaveAttribute("data-opacity", "balanced");
    expect(card).toHaveAttribute("data-tauri-drag-region");

    // 单行卡片打开浮层菜单时附加最小高度保护
    fireEvent.contextMenu(card);
    expect(screen.getByRole("menu")).toBeVisible();
    expect(card).toHaveAttribute("data-menu-pad", "true");

    // 切换透明度三档（预览时菜单保持打开并持久化到 localStorage）
    fireEvent.click(screen.getByRole("button", { name: "轻透" }));
    expect(card).toHaveAttribute("data-opacity", "light");
    expect(window.localStorage.getItem("cc-switch-quota-widget-opacity")).toBe(
      "light",
    );
    fireEvent.click(screen.getByRole("button", { name: "实底" }));
    expect(card).toHaveAttribute("data-opacity", "solid");
    expect(screen.getByRole("menu")).toBeVisible();

    // 锁定位置：移除所有 data-tauri-drag-region，并在底部左侧出现解锁图标
    fireEvent.click(screen.getByRole("menuitem", { name: "锁定位置" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(card).toHaveAttribute("data-locked", "true");
    expect(container.querySelectorAll("[data-tauri-drag-region]")).toHaveLength(
      0,
    );
    expect(window.localStorage.getItem("cc-switch-quota-widget-locked")).toBe(
      "true",
    );

    // 点击底部锁定指示按钮直接解锁
    fireEvent.click(screen.getByRole("button", { name: "解锁位置" }));
    expect(card).not.toHaveAttribute("data-locked");
    expect(card).toHaveAttribute("data-tauri-drag-region");

    // 重置位置：清空 localStorage 坐标并调用后端 resetPosition
    fireEvent.contextMenu(card);
    fireEvent.click(screen.getByRole("menuitem", { name: "重置位置" }));
    expect(readSavedPosition()).toBeNull();
    expect(quotaWidgetApi.resetPosition).toHaveBeenCalledTimes(1);

    // 隐藏悬浮窗
    fireEvent.contextMenu(card);
    fireEvent.click(screen.getByRole("menuitem", { name: "隐藏悬浮窗" }));
    expect(quotaWidgetApi.hide).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not add extra menu height padding on cards with 3 or more rows", async () => {
    const state = fixture();
    state.apps = [
      { ...state.apps[0], app: "claude", current: "Row1" },
      { ...state.apps[0], app: "codex", current: "Row2" },
      { ...state.apps[0], app: "gemini", current: "Row3" },
    ];
    vi.mocked(quotaWidgetApi.state).mockResolvedValue(state);
    const { container } = render(<QuotaWidget />);
    await screen.findByText("Row3");

    const card = container.querySelector(".qw-card")!;
    fireEvent.contextMenu(card);
    expect(screen.getByRole("menu")).toBeVisible();
    expect(card).not.toHaveAttribute("data-menu-pad");
  });

  it("reacts to backend changed events to refresh state and language texts immediately", async () => {
    render(<QuotaWidget />);
    await screen.findByText("智谱");

    const englishTexts: PanelTexts = {
      ...texts,
      tierDual: "Both",
      tierFiveHour: "5-hour",
      tierWeekly: "Weekly",
      noMatch: "No quotas",
    };
    const updated = fixture();
    updated.apps[0].current = "OpenRouter";
    vi.mocked(quotaWidgetApi.state).mockResolvedValue(updated);

    act(() => {
      eventHandlers.get(WIDGET_CHANGED_EVENT)?.({ payload: englishTexts });
    });

    expect(await screen.findByText("OpenRouter")).toBeVisible();
    expect(screen.getByText("Both")).toBeVisible();
    expect(screen.getByText("5-hour")).toBeVisible();
    expect(screen.getByText("Weekly")).toBeVisible();

    // 隐藏事件通知应关闭菜单
    act(() => {
      eventHandlers.get(WIDGET_VISIBILITY_EVENT)?.({
        payload: { visible: false, texts: englishTexts },
      });
    });
  });
});
