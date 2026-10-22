// Native visual smoke test only. All data is synthetic; native layout/material IPC stays real.
(() => {
  localStorage.setItem("cc-switch-theme", "light");
  const texts = {
    usageTab: "用量",
    noMatch: "暂无额度",
    tierFiveHour: "5 小时",
    tierWeekly: "每周",
    resetsIn: "{when}后重置",
    durationDays: "{n}天",
    durationHours: "{n}小时",
    durationMinutes: "{n}分",
    durationSep: "",
    resetCredits: "{count}次重置",
  };
  const fiveReset = new Date(Date.now() + 8000000).toISOString();
  const weekReset = new Date(Date.now() + 260000000).toISOString();
  const line = (tier, left, resetsAt) => ({
    tier,
    left,
    resetsAt,
    text: `${tier} ${left}%`,
    warn: left < 20,
  });
  const app = (app, current, lines) => ({
    app,
    name: current,
    current,
    rows: [],
    quota: { lines, resetCredits: null, note: null },
  });
  const state = {
    texts,
    apps: [
      app("claude", "智谱", [
        line("five_hour", 78, fiveReset),
        line("weekly", 43, weekReset),
      ]),
      app("codex", "OpenAI", [line("five_hour", 0, fiveReset)]),
    ],
  };
  const original = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (cmd, args, options) => {
    if (cmd === "tray_panel_state") return state;
    if (cmd === "quota_widget_refresh" || cmd === "quota_widget_show_main")
      return;
    if (cmd === "quota_widget_agy_quota")
      return {
        success: true,
        tiers: [
          {
            name: "agy_third_party_five_hour",
            utilization: 0,
            resetsAt: fiveReset,
          },
          {
            name: "agy_third_party_weekly",
            utilization: 100,
            resetsAt: weekReset,
          },
          {
            name: "agy_gemini_five_hour",
            utilization: 42,
            resetsAt: fiveReset,
          },
          { name: "agy_gemini_weekly", utilization: 13, resetsAt: weekReset },
        ],
      };
    if (cmd === "quota_widget_ready") {
      // Fixed, on-screen coordinates for the isolated test only.
      args = { ...args, position: { x: 220, y: 220 } };
    }
    return original(cmd, args, options);
  };
})();
