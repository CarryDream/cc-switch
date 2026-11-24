import React from "react";
import ReactDOM from "react-dom/client";
import "./widget.css";
import {
  installGlobalErrorHandlers,
  reportFrontendError,
} from "@/lib/frontendLogger";
import { QuotaWidget } from "./QuotaWidget";

installGlobalErrorHandlers();

interface WidgetErrorState {
  hasError: boolean;
}

/** 轻量独立错误边界：不引入主界面 i18n、Tailwind 和图标库，保持悬浮窗独立入口精简。 */
class WidgetErrorBoundary extends React.Component<
  React.PropsWithChildren,
  WidgetErrorState
> {
  state: WidgetErrorState = { hasError: false };

  static getDerivedStateFromError(): WidgetErrorState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    reportFrontendError(
      "quota_widget.error_boundary",
      error,
      info.componentStack ?? undefined,
    );
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }
    return (
      <div className="qw-card qw-error-fallback" data-tauri-drag-region>
        <span>CC Switch</span>
        <button
          type="button"
          className="qw-retry-btn"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    );
  }
}

// 悬浮窗不加载主界面的 i18n、Tailwind 和 react-query：文案由后端经 `quota_widget_ready`
// 与变更事件下发，数据与托盘面板同源。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WidgetErrorBoundary>
      <QuotaWidget />
    </WidgetErrorBoundary>
  </React.StrictMode>,
);
