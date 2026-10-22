import React from "react";
import ReactDOM from "react-dom/client";
import "../index.css";
import "./widget.css";
import { FrontendErrorBoundary } from "@/components/FrontendErrorBoundary";
import { installGlobalErrorHandlers } from "@/lib/frontendLogger";
import { QuotaWidget } from "./QuotaWidget";

installGlobalErrorHandlers();

// 悬浮窗不带主界面的 i18n 和 react-query：文案由后端 `tray_panel_state` 随数据一起给，
// 取数是简单的「刷新 → 取状态」两步，不值得为此挂一套缓存层。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FrontendErrorBoundary>
      <QuotaWidget />
    </FrontendErrorBoundary>
  </React.StrictMode>,
);
