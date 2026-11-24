// Native visual smoke test only. All data is synthetic; native layout/material IPC stays real.
(() => {
  localStorage.setItem("cc-switch-theme", "light");
  const fiveReset = new Date(Date.now() + 8000000).toISOString();
  const weekReset = new Date(Date.now() + 260000000).toISOString();
  const line = (tier, left, resetsAt) => ({
    tier,
    left,
    resetsAt,
    text: `${tier} ${left}%`,
    warn: left < 20,
    emphasis: null,
  });
  const app = (appId, current, lines) => ({
    app: appId,
    name: current,
    current,
    mode: "直连",
    modeKind: "direct",
    header: null,
    attention: null,
    addId: null,
    addText: "",
    rows: [],
    quota: { lines, resetCredits: null, note: null },
  });
  const state = {
    problems: [],
    feedback: null,
    lightweight: false,
    quotaWidget: true,
    quitHint: null,
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
    if (
      cmd === "quota_widget_refresh" ||
      cmd === "quota_widget_show_main" ||
      cmd === "quota_widget_hide" ||
      cmd === "quota_widget_reset_position"
    )
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
