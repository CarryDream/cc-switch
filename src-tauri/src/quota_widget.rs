//! 额度悬浮窗：桌面上的常驻小卡片，玻璃质感，列出各应用在用 / 有缓存额度供应商的
//! 用量和重置时间。数据与托盘面板同源（`tray::collect_panel_model`），刷新走托盘的
//! 同一条防抖管线，并订阅后端状态变更事件实时同步；窗口只做展示，不提供切换等写操作。
//!
//! - 托盘开关持久化；窗口与卡片同尺寸，无外围画布。关闭只隐藏，轻量模式下隐藏后释放。
//! - 位置记在前端 localStorage（物理像素），按显示器工作区校验，打开时先摆好位置和尺寸
//!   再显示，避免闪跳；首次打开默认落在主屏右上角工作区。
//! - macOS 26 使用 NSGlassEffectView，旧 macOS 使用 Popover 材质（含全屏空间辅助属性）；
//!   Windows 11 22H2+ 剥离非客户区标题栏样式后使用原生 DWM Acrylic（DWMSBT_TRANSIENTWINDOW），
//!   旧版 Windows 回退圆角区域裁剪 + 高可读半透明底色。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::sync_utils::MutexExt;

/// 悬浮窗的窗口 label（能力文件 `capabilities/quota-widget.json` 按它授权）。
pub const WIDGET_LABEL: &str = "quota-widget";
/// 托盘菜单里「额度悬浮窗」开关的事件 id。
pub const WIDGET_TOGGLE_ID: &str = "widget:toggle";
/// 后端状态（切换供应商、刷新额度、切换语言等）变化后推送给悬浮窗的事件。
const CHANGED_EVENT: &str = "quota-widget-changed";
/// 悬浮窗可见性变化时推送给前端（隐藏时暂停轮询，重新显示时立即恢复并同步最新文案）。
const VISIBILITY_EVENT: &str = "quota-widget-visibility";

const MIN_WIDTH: f64 = 220.0;
const MAX_WIDTH: f64 = 480.0;
const MIN_HEIGHT: f64 = 32.0;
const MAX_HEIGHT: f64 = 380.0;
const DEFAULT_WIDTH: f64 = 296.0;
const DEFAULT_HEIGHT: f64 = 84.0;
const DEFAULT_MARGIN: f64 = 16.0;

/// 合并高频状态变更通知（批量刷新多个供应商额度时只触发一两次重取）。
const CHANGED_THROTTLE: Duration = Duration::from_millis(250);
/// 前端初始化失败或卡住时的兜底亮相超时，避免 `PENDING_REVEAL` 永久锁死窗口。
const REVEAL_FALLBACK: Duration = Duration::from_millis(1500);
/// Antigravity 额度刷新防抖间隔（与托盘其它应用 10 秒防抖保持一致）。
const AGY_REFRESH_DEBOUNCE: Duration = Duration::from_secs(10);

/// 窗口建好后还没显示：等前端回报位置和尺寸（`quota_widget_ready`）再亮相。
static PENDING_REVEAL: AtomicBool = AtomicBool::new(false);
/// 每次创建或隐藏递增，防止过期的兜底定时器在隐藏后错误拉起窗口。
static REVEAL_SEQ: AtomicU64 = AtomicU64::new(0);
/// 上次套给窗口的 `(逻辑宽, 逻辑高, 缩放百分比)`，跨 DPI 移动时也会重新套尺寸。
static APPLIED_FRAME: Mutex<Option<(f64, f64, u32)>> = Mutex::new(None);
/// 上次推送变更事件的时间与是否已排期补发。
static CHANGED_STATE: Mutex<(Option<Instant>, bool)> = Mutex::new((None, false));
/// 上次向 Antigravity 实查额度的时间（非强制请求在 10 秒内直接复用 `UsageCache`）。
static LAST_AGY_REFRESH: Mutex<Option<Instant>> = Mutex::new(None);

// ─── 窗口 ────────────────────────────────────────────────────────────────────

fn widget_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WIDGET_LABEL)
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct WidgetVisibility {
    visible: bool,
    texts: crate::tray_panel::PanelTexts,
}

fn emit_visibility(window: &WebviewWindow, visible: bool) {
    let payload = WidgetVisibility {
        visible,
        texts: crate::tray_panel::PanelTexts::current(),
    };
    let _ = window.emit_to(WIDGET_LABEL, VISIBILITY_EVENT, payload);
}

/// 显示悬浮窗并立即在主线程清理平台残留的非客户区样式（Windows 上 `tao::set_visible(true)`
/// 会写回 `WS_CAPTION | WS_SYSMENU`，需在其后剥离以去掉右上角关闭按钮鬼影）。
fn show_window_clean(window: &WebviewWindow) {
    let _ = window.show();
    platform::after_show(window);
}

fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(
        app,
        WIDGET_LABEL,
        WebviewUrl::App("quota-widget.html".into()),
    )
    // 无任务栏常驻小组件不设标题，避免 Windows DWM/GDI 在任何过渡帧里绘出标题文字。
    .title("")
    .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    // Linux 使用不透明画布避开 WebKitGTK 透明表面缺块问题（#9216）。
    .transparent(!cfg!(target_os = "linux"))
    .background_color(tauri::window::Color(0, 0, 0, 0))
    // 与卡片同尺寸，不为阴影扩画布，避免系统材质出现第二层外框。
    .shadow(!cfg!(target_os = "windows"))
    .always_on_top(true)
    .skip_taskbar(true)
    .visible_on_all_workspaces(true)
    .visible(false)
    .focused(false)
    .build()?;
    let seq = REVEAL_SEQ.fetch_add(1, Ordering::AcqRel) + 1;
    PENDING_REVEAL.store(true, Ordering::Release);
    *APPLIED_FRAME.lock_recover() = None;
    platform::init(&window);

    let fallback_app = app.clone();
    let fallback_window = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REVEAL_FALLBACK).await;
        if REVEAL_SEQ.load(Ordering::Acquire) == seq && PENDING_REVEAL.swap(false, Ordering::AcqRel)
        {
            log::debug!("[QuotaWidget] 前端未在超时内回报就绪，按默认尺寸亮相");
            let (monitors, primary) = collect_monitors(&fallback_app);
            let pos = default_position(primary, &monitors, DEFAULT_WIDTH, DEFAULT_HEIGHT);
            apply_frame(&fallback_window, pos, DEFAULT_WIDTH, DEFAULT_HEIGHT);
            show_window_clean(&fallback_window);
            emit_visibility(&fallback_window, true);
        }
    });

    let handle = window.clone();
    window.on_window_event(move |event| match event {
        // 常驻悬浮窗：失焦不收起，只有关闭请求时才隐藏并同步状态。
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            set_enabled(handle.app_handle(), false);
        }
        // 跨 DPI 显示器拖动时清空缓存并按当前逻辑尺寸重套平台裁剪 / 玻璃效果。
        tauri::WindowEvent::ScaleFactorChanged {
            scale_factor,
            new_inner_size,
            ..
        } => {
            let prev = APPLIED_FRAME.lock_recover().take();
            let (width, height) = prev.map(|(w, h, _)| (w, h)).unwrap_or_else(|| {
                let scale = (*scale_factor).max(0.5);
                (
                    (new_inner_size.width as f64 / scale).clamp(MIN_WIDTH, MAX_WIDTH),
                    (new_inner_size.height as f64 / scale).clamp(MIN_HEIGHT, MAX_HEIGHT),
                )
            });
            platform::apply(&handle, width, height);
        }
        // 聚焦变化时做一次轻量非客户区样式守卫（Windows 上样式已干净时直接跳过）。
        tauri::WindowEvent::Focused(_) => {
            platform::on_focus(&handle);
        }
        _ => {}
    });
    Ok(window)
}

fn ensure_window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(window) = widget_window(app) {
        return Some(window);
    }
    match create_window(app) {
        Ok(window) => Some(window),
        Err(e) => {
            log::error!("[QuotaWidget] 创建悬浮窗失败: {e}");
            None
        }
    }
}

fn hide_window(window: &WebviewWindow) {
    REVEAL_SEQ.fetch_add(1, Ordering::AcqRel);
    PENDING_REVEAL.store(false, Ordering::Release);
    emit_visibility(window, false);
    let _ = window.hide();
    release_if_lightweight(window.app_handle());
}

pub fn is_enabled() -> bool {
    crate::settings::get_settings().enable_quota_widget
}

pub fn show_widget(app: &AppHandle) {
    if let Some(window) = widget_window(app) {
        if PENDING_REVEAL.load(Ordering::Acquire) {
            return;
        }
        let scale = window.scale_factor().unwrap_or(1.0).max(0.5);
        let (width, height) = window
            .inner_size()
            .ok()
            .map(|size| (size.width as f64 / scale, size.height as f64 / scale))
            .filter(|(w, h)| *w > 0.0 && *h > 0.0)
            .unwrap_or((DEFAULT_WIDTH, DEFAULT_HEIGHT));
        let clamped_w = width.clamp(MIN_WIDTH, MAX_WIDTH);
        let clamped_h = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
        let current_pos = window.outer_position().ok().map(|p| (p.x, p.y));
        let (monitors, primary) = collect_monitors(app);
        if let Some(resolved) =
            resolve_position(current_pos, clamped_w, clamped_h, &monitors, primary)
        {
            if current_pos != Some(resolved) {
                // 隐藏期间显示器拔插或布局变更导致窗口脱离工作区：拉回有效屏并重套尺寸与裁剪。
                *APPLIED_FRAME.lock_recover() = None;
                apply_frame(&window, Some(resolved), clamped_w, clamped_h);
            }
        }
        show_window_clean(&window);
        emit_visibility(&window, true);
        return;
    }
    let _ = ensure_window(app);
}

fn try_set_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = crate::settings::get_settings();
    if settings.enable_quota_widget != enabled {
        settings.enable_quota_widget = enabled;
        if let Err(e) = crate::settings::update_settings(settings) {
            log::error!("[QuotaWidget] 设置未保存，保留原来的悬浮窗状态: {e}");
            crate::tray::refresh_tray_menu(app);
            return Err(e.to_string());
        }
    }
    if enabled {
        show_widget(app);
    } else {
        hide_widget(app);
    }
    crate::tray::refresh_tray_menu(app);
    Ok(())
}

pub fn set_enabled(app: &AppHandle, enabled: bool) {
    let _ = try_set_enabled(app, enabled);
}

pub fn hide_widget(app: &AppHandle) {
    if let Some(window) = widget_window(app) {
        hide_window(&window);
    }
}

/// 托盘开关：同步设置状态并记忆，关闭时隐藏、开启时显示或创建。
pub fn toggle(app: &AppHandle) {
    set_enabled(app, !is_enabled());
}

/// 通知开着的悬浮窗数据或语言已变更（250ms 节流，隐藏期间跳过）。
pub fn notify_changed(app: &AppHandle) {
    let Some(window) = widget_window(app) else {
        return;
    };
    if !PENDING_REVEAL.load(Ordering::Acquire) && !window.is_visible().unwrap_or(false) {
        return;
    }
    let wait = {
        let mut state = CHANGED_STATE.lock_recover();
        if state.1 {
            return;
        }
        let now = Instant::now();
        match state.0.map(|last| now.duration_since(last)) {
            Some(elapsed) if elapsed < CHANGED_THROTTLE => {
                state.1 = true;
                CHANGED_THROTTLE - elapsed
            }
            _ => {
                state.0 = Some(now);
                Duration::ZERO
            }
        }
    };
    if wait.is_zero() {
        let _ = app.emit_to(
            WIDGET_LABEL,
            CHANGED_EVENT,
            crate::tray_panel::PanelTexts::current(),
        );
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(wait).await;
        *CHANGED_STATE.lock_recover() = (Some(Instant::now()), false);
        let visible = widget_window(&app).is_some_and(|w| w.is_visible().unwrap_or(false));
        if visible || PENDING_REVEAL.load(Ordering::Acquire) {
            let _ = app.emit_to(
                WIDGET_LABEL,
                CHANGED_EVENT,
                crate::tray_panel::PanelTexts::current(),
            );
        }
    });
}

/// 轻量模式要释放全部 WebView：悬浮窗隐藏（或此刻被收起）时销毁，下次打开重建。
/// 开着的留着——用户正看着，和托盘面板同一待遇。
pub fn release_if_lightweight(app: &AppHandle) {
    if !crate::lightweight::is_lightweight_mode() || widget_window(app).is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(window) = widget_window(&handle) else {
                return;
            };
            if !crate::lightweight::is_lightweight_mode()
                || PENDING_REVEAL.load(Ordering::Acquire)
                || window.is_visible().unwrap_or(false)
            {
                return;
            }
            if let Err(e) = window.destroy() {
                log::warn!("[QuotaWidget] 轻量模式下销毁悬浮窗失败: {e}");
            }
        });
    });
}

// ─── 摆放 ────────────────────────────────────────────────────────────────────

/// 单个显示器的工作区（物理像素，排除任务栏 / 菜单栏）及缩放倍率。
#[derive(Debug, Clone, Copy, PartialEq)]
struct MonitorWorkArea {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    scale: f64,
}

impl MonitorWorkArea {
    fn from_monitor(monitor: &tauri::Monitor) -> Self {
        let work = monitor.work_area();
        Self {
            left: work.position.x,
            top: work.position.y,
            right: work.position.x + work.size.width as i32,
            bottom: work.position.y + work.size.height as i32,
            scale: monitor.scale_factor().max(0.5),
        }
    }
}

fn collect_monitors(app: &AppHandle) -> (Vec<MonitorWorkArea>, Option<MonitorWorkArea>) {
    let monitors = app
        .available_monitors()
        .map(|list| list.iter().map(MonitorWorkArea::from_monitor).collect())
        .unwrap_or_default();
    let primary = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| MonitorWorkArea::from_monitor(&m));
    (monitors, primary)
}

/// 首次打开或旧坐标已脱离所有显示器时的默认位置：主屏工作区右上角留边距。
fn default_position(
    primary: Option<MonitorWorkArea>,
    monitors: &[MonitorWorkArea],
    width: f64,
    height: f64,
) -> Option<(i32, i32)> {
    let m = primary.or_else(|| monitors.first().copied())?;
    let margin = (DEFAULT_MARGIN * m.scale).round() as i32;
    let win_w = (width * m.scale).round().max(1.0) as i32;
    let win_h = (height * m.scale).round().max(1.0) as i32;
    let x = (m.right - win_w - margin).max(m.left);
    let max_y = (m.bottom - win_h).max(m.top);
    let y = (m.top + margin).min(max_y);
    Some((x, y))
}

/// 按单个显示器的工作区和缩放倍率把坐标收紧到可抓回的范围内，防止越界或 `clamp` panic。
fn clamp_to_monitor(x: i32, y: i32, width: f64, height: f64, m: MonitorWorkArea) -> (i32, i32) {
    let win_w = (width * m.scale).round().max(1.0) as i32;
    let win_h = (height * m.scale).round().max(1.0) as i32;
    let min_vis_x = ((96.0 * m.scale).round().max(1.0) as i32).min(win_w);
    let min_vis_y = ((32.0 * m.scale).round().max(1.0) as i32).min(win_h);
    let min_x = m.left - (win_w - min_vis_x).max(0);
    let max_x = (m.right - min_vis_x).max(min_x);
    let min_y = m.top;
    let max_y = (m.bottom - min_vis_y).max(min_y);
    (x.clamp(min_x, max_x), y.clamp(min_y, max_y))
}

/// 逐显示器检查存下的坐标是否仍在某块真实工作区内（避免错位多屏的空洞死区），
/// 命中就收紧回该屏内，否则回退到主屏默认位置。
fn resolve_position(
    saved: Option<(i32, i32)>,
    width: f64,
    height: f64,
    monitors: &[MonitorWorkArea],
    primary: Option<MonitorWorkArea>,
) -> Option<(i32, i32)> {
    if let Some((x, y)) = saved {
        // 过滤 Windows 最小化 / 桌面切换时可能写入的异常哨兵坐标。
        if x > -10_000 && y > -10_000 {
            let mut best: Option<(MonitorWorkArea, i64)> = None;
            for &m in monitors {
                let win_w = (width * m.scale).round().max(1.0) as i32;
                let win_h = (height * m.scale).round().max(1.0) as i32;
                let slack = (48.0 * m.scale).round() as i32;
                let exp_left = m.left - slack;
                let exp_top = m.top - slack;
                let exp_right = m.right + slack;
                let exp_bottom = m.bottom + slack;
                let overlap_w = (x + win_w).min(exp_right) - x.max(exp_left);
                let overlap_h = (y + win_h).min(exp_bottom) - y.max(exp_top);
                if overlap_w > 0 && overlap_h > 0 {
                    let cx = x + win_w / 2;
                    let cy = y + win_h / 2;
                    let center_inside =
                        cx >= m.left && cx < m.right && cy >= m.top && cy < m.bottom;
                    let score = (overlap_w as i64) * (overlap_h as i64)
                        + if center_inside { 1_000_000_000 } else { 0 };
                    if best.is_none_or(|(_, best_score)| score > best_score) {
                        best = Some((m, score));
                    }
                }
            }
            if let Some((monitor, _)) = best {
                return Some(clamp_to_monitor(x, y, width, height, monitor));
            }
        }
    }
    default_position(primary, monitors, width, height)
}

/// 内容增高（展开详情或菜单）导致底部越过显示器工作区下沿（任务栏）时，向上推回。
fn nudge_y_within_monitor(y: i32, height: f64, monitor: MonitorWorkArea) -> Option<i32> {
    let new_phys_h = (height * monitor.scale).round().max(1.0) as i32;
    if y.saturating_add(new_phys_h) > monitor.bottom {
        let nudged = (monitor.bottom - new_phys_h).max(monitor.top);
        if nudged != y {
            return Some(nudged);
        }
    }
    None
}

/// 摆一次窗口：先落位置（跨 DPI 显示器时先切到目标屏）、再按当前屏缩放套尺寸和玻璃/裁剪区域。
/// 无显式 `position` 且高度变化时，若底部越过所在屏工作区下沿，先向上推回避免被任务栏遮挡。
fn apply_frame(window: &WebviewWindow, position: Option<(i32, i32)>, width: f64, height: f64) {
    let width = width.clamp(MIN_WIDTH, MAX_WIDTH);
    let height = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
    if let Some((x, y)) = position {
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
    let scale_bps = (window.scale_factor().unwrap_or(1.0) * 100.0).round() as u32;
    let next = (width, height, scale_bps);
    let prev = *APPLIED_FRAME.lock_recover();
    let changed = prev != Some(next);
    if changed {
        if position.is_none() {
            let height_changed =
                prev.is_none_or(|(_, prev_h, _)| (prev_h - height).abs() > f64::EPSILON);
            if height_changed {
                if let (Ok(pos), Ok(Some(monitor))) =
                    (window.outer_position(), window.current_monitor())
                {
                    let work = MonitorWorkArea::from_monitor(&monitor);
                    if let Some(nudged_y) = nudge_y_within_monitor(pos.y, height, work) {
                        let _ = window.set_position(tauri::PhysicalPosition::new(pos.x, nudged_y));
                    }
                }
            }
        }
        *APPLIED_FRAME.lock_recover() = Some(next);
        let _ = window.set_size(tauri::LogicalSize::new(width, height));
        platform::apply(window, width, height);
    }
}

// ─── 命令 ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetGlass {
    /// 背后有没有系统玻璃、是哪种；前端据此选卡片的画法。
    pub glass: &'static str,
    pub platform: &'static str,
}

/// `quota_widget_bootstrap` / `quota_widget_ready` 的回执：玻璃模式、平台，外加面板文案。
///
/// 悬浮窗不加载界面的 i18n（和托盘面板一样，文案由后端下发），而
/// `tray_panel_state` 里没有文案，首帧随 `bootstrap` / `ready` 下发，后续语言变化经 `CHANGED_EVENT` 同步。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetReady {
    pub glass: &'static str,
    pub platform: &'static str,
    pub texts: crate::tray_panel::PanelTexts,
}

fn current_widget_ready() -> WidgetReady {
    WidgetReady {
        glass: platform::glass(),
        platform: std::env::consts::OS,
        texts: crate::tray_panel::PanelTexts::current(),
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetPosition {
    pub x: i32,
    pub y: i32,
}

/// 零跳动冷启动第一步：返回玻璃模式、平台与文案但不显示窗口，等前端拿到真实数据
/// 渲染完 DOM 后再调 `quota_widget_ready` 一次性按最终高度亮相。
#[tauri::command]
pub fn quota_widget_bootstrap() -> WidgetReady {
    current_widget_ready()
}

/// 前端加载完成：摆好校验后的位置和实测的尺寸，然后显示。返回玻璃模式与文案给前端。
#[tauri::command]
pub fn quota_widget_ready(
    app: AppHandle,
    position: Option<WidgetPosition>,
    width: f64,
    height: f64,
) -> WidgetReady {
    let info = current_widget_ready();
    let Some(window) = widget_window(&app) else {
        return info;
    };
    let clamped_w = width.clamp(MIN_WIDTH, MAX_WIDTH);
    let clamped_h = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
    let (monitors, primary) = collect_monitors(&app);
    let resolved = resolve_position(
        position.map(|p| (p.x, p.y)),
        clamped_w,
        clamped_h,
        &monitors,
        primary,
    );
    apply_frame(&window, resolved, clamped_w, clamped_h);
    if PENDING_REVEAL.swap(false, Ordering::AcqRel) {
        show_window_clean(&window);
    }
    info
}

/// 只更新这个窗口的材质外观，主窗口和用户主题设置不受影响。
#[tauri::command]
pub fn quota_widget_appearance(app: AppHandle, dark: bool) -> WidgetGlass {
    if let Some(window) = widget_window(&app) {
        platform::appearance(&window, dark);
    }
    WidgetGlass {
        glass: platform::glass(),
        platform: std::env::consts::OS,
    }
}

/// 内容变了（数据到货、深浅色切换）：窗口跟着内容改尺寸。
#[tauri::command]
pub fn quota_widget_layout(app: AppHandle, width: f64, height: f64) {
    if let Some(window) = widget_window(&app) {
        apply_frame(&window, None, width, height);
    }
}

/// 将悬浮窗移回主屏右上角默认工作区并按当前尺寸套用布局。
#[tauri::command]
pub fn quota_widget_reset_position(app: AppHandle, width: f64, height: f64) {
    let Some(window) = widget_window(&app) else {
        return;
    };
    let clamped_w = width.clamp(MIN_WIDTH, MAX_WIDTH);
    let clamped_h = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
    let (monitors, primary) = collect_monitors(&app);
    let pos = default_position(primary, &monitors, clamped_w, clamped_h);
    *APPLIED_FRAME.lock_recover() = None;
    apply_frame(&window, pos, clamped_w, clamped_h);
}

/// 刷新各家额度（在用的 + 开了自动查询的脚本供应商），写进缓存；前端随后取状态。
#[tauri::command]
pub async fn quota_widget_refresh(app: AppHandle) {
    crate::tray::refresh_all_usage_in_tray(&app).await;
    crate::tray::refresh_panel_provider_usage(&app).await;
}

/// 双击悬浮窗打开主窗口（和左键点托盘图标同一条路径）。
///
/// 必须是 async 命令：轻量模式下打开主窗口要重建 WebView，Windows 上在同步命令里
/// `WebviewWindowBuilder::build()` 会触发 WebView2 死锁（同 `tray_panel_action`）。
#[tauri::command]
pub async fn quota_widget_show_main(app: AppHandle) {
    crate::tray::show_main_window(&app);
}

/// 悬浮窗右键菜单隐藏自己并同步托盘开关状态。
#[tauri::command]
pub fn quota_widget_hide(app: AppHandle) {
    set_enabled(&app, false);
}

/// 主设置页切换用量悬浮窗开关：持久化设置、显示/隐藏窗口并同步托盘菜单。
#[tauri::command]
pub fn quota_widget_set_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    try_set_enabled(&app, enabled)
}

fn cached_agy_quota_if_fresh(
    usage_cache: &crate::services::usage_cache::UsageCache,
    last_refresh: Option<Instant>,
    now: Instant,
    force: bool,
) -> Option<crate::services::subscription::SubscriptionQuota> {
    if force {
        return None;
    }
    let last = last_refresh?;
    if now.saturating_duration_since(last) >= AGY_REFRESH_DEBOUNCE {
        return None;
    }
    usage_cache.with_subscription(&crate::app_config::AppType::Agy, Clone::clone)
}

/// Antigravity 现在登着的号的额度：托盘的额度管线不含 AGY（不在 `TRAY_APPS`），
/// 悬浮窗自己问并写穿到 `AppState.usage_cache`（与主界面共享），非强制请求 10 秒内
/// 直接复用缓存。若用户在可见应用设置中隐藏了 AGY，则直接返回 not_found 不发请求。
#[tauri::command]
pub async fn quota_widget_agy_quota(
    force: Option<bool>,
    app_state: tauri::State<'_, crate::store::AppState>,
    state: tauri::State<'_, crate::commands::AgyAccountState>,
) -> Result<crate::services::subscription::SubscriptionQuota, String> {
    let visible_apps = crate::settings::get_settings()
        .visible_apps
        .unwrap_or_default();
    if !visible_apps.is_visible(&crate::app_config::AppType::Agy) {
        return Ok(crate::services::subscription::SubscriptionQuota::not_found(
            "agy",
        ));
    }
    let forced = force.unwrap_or(false);
    let last = *LAST_AGY_REFRESH.lock_recover();
    if let Some(cached) =
        cached_agy_quota_if_fresh(&app_state.usage_cache, last, Instant::now(), forced)
    {
        return Ok(cached);
    }
    let result = crate::commands::agy_account::agy_quota(&state.0, None).await;
    if let Ok(quota) = &result {
        if quota.success {
            app_state
                .usage_cache
                .put_subscription(crate::app_config::AppType::Agy, quota.clone());
            *LAST_AGY_REFRESH.lock_recover() = Some(Instant::now());
        }
    }
    result
}

// ─── 平台：玻璃 ──────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, NSObjectProtocol};
    use objc2::{msg_send, sel, MainThreadMarker};
    use objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
        NSGlassEffectView, NSGlassEffectViewStyle, NSView, NSVisualEffectBlendingMode,
        NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView, NSWindow,
        NSWindowCollectionBehavior, NSWindowOrderingMode,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use tauri::WebviewWindow;

    /// 和卡片 CSS 的圆角一致（Apple Liquid Glass 圆角 14px）。
    const RADIUS: f64 = 14.0;

    pub fn glass() -> &'static str {
        "native"
    }

    thread_local! {
        /// 垫在网页下面的一块玻璃，铺满整个内容区（只在主线程上碰）。
        static GLASS: RefCell<Option<Retained<NSView>>> = const { RefCell::new(None) };
    }

    fn ns_window(window: &WebviewWindow) -> Option<&NSWindow> {
        let ptr = window.ns_window().ok()?;
        // SAFETY: 指针来自 tao，窗口存活期间有效；只在主线程上借用，不持有。
        Some(unsafe { &*ptr.cast::<NSWindow>() })
    }

    /// 网页透明，玻璃铺在网页下面：系统有 `NSGlassEffectView`（macOS 26+）就用它，否则用
    /// Popover 材质的毛玻璃（和托盘面板同一套做法）。
    fn make_glass(mtm: MainThreadMarker) -> Retained<NSView> {
        if AnyClass::get(c"NSGlassEffectView").is_some() {
            let glass = NSGlassEffectView::initWithFrame(mtm.alloc(), NSRect::ZERO);
            glass.setStyle(NSGlassEffectViewStyle::Regular);
            glass.setCornerRadius(RADIUS);
            return Retained::into_super(glass);
        }
        let effect = NSVisualEffectView::initWithFrame(mtm.alloc(), NSRect::ZERO);
        effect.setMaterial(NSVisualEffectMaterial::Popover);
        effect.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
        effect.setState(NSVisualEffectState::Active);
        if effect.respondsToSelector(sel!(setCornerRadius:)) {
            // SAFETY: 上面确认过能响应，参数是 CGFloat。
            unsafe {
                let _: () = msg_send![&*effect, setCornerRadius: RADIUS];
            }
        } else {
            effect.setWantsLayer(true);
            // SAFETY: setWantsLayer 之后 layer 是 CALayer；只设圆角和裁切。
            unsafe {
                let layer: *mut AnyObject = msg_send![&*effect, layer];
                if !layer.is_null() {
                    let _: () = msg_send![layer, setCornerRadius: RADIUS];
                    let _: () = msg_send![layer, setMasksToBounds: true];
                }
            }
        }
        Retained::into_super(effect)
    }

    pub fn init(window: &WebviewWindow) {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            GLASS.with(|slot| *slot.borrow_mut() = None);
            // `visible_on_all_workspaces` 不含 FullScreenAuxiliary，切到全屏应用时悬浮窗会留在普通桌面。
            if let Some(ns_window) = ns_window(&target) {
                ns_window.setCollectionBehavior(
                    ns_window.collectionBehavior()
                        | NSWindowCollectionBehavior::FullScreenAuxiliary,
                );
            }
        });
    }

    pub fn after_show(_window: &WebviewWindow) {}

    pub fn on_focus(_window: &WebviewWindow) {}

    pub fn appearance(window: &WebviewWindow, dark: bool) {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Some(window) = ns_window(&target) else {
                return;
            };
            // SAFETY: AppKit 提供的常量，进程存活期间一直有效。
            let name = unsafe {
                if dark {
                    NSAppearanceNameDarkAqua
                } else {
                    NSAppearanceNameAqua
                }
            };
            let appearance = NSAppearance::appearanceNamed(name);
            window.setAppearance(appearance.as_deref());
        });
    }

    /// 窗口改了尺寸：玻璃跟着铺满内容区。
    pub fn apply(window: &WebviewWindow, _width: f64, _height: f64) {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let Some(ns_window) = ns_window(&target) else {
                return;
            };
            let Some(content) = ns_window.contentView() else {
                return;
            };
            GLASS.with(|slot| {
                let mut glass = slot.borrow_mut();
                if glass.is_none() {
                    let view = make_glass(mtm);
                    // 放在所有子视图（WKWebView）下面
                    content.addSubview_positioned_relativeTo(
                        &view,
                        NSWindowOrderingMode::Below,
                        None,
                    );
                    *glass = Some(view);
                }
                if let Some(view) = glass.as_ref() {
                    let bounds = content.bounds();
                    view.setFrame(NSRect::new(
                        NSPoint::new(0.0, 0.0),
                        NSSize::new(bounds.size.width, bounds.size.height),
                    ));
                }
            });
        });
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::sync::atomic::{AtomicBool, Ordering};

    use tauri::WebviewWindow;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Dwm::{
        DwmExtendFrameIntoClientArea, DwmSetWindowAttribute, DWMSBT_TRANSIENTWINDOW,
        DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_SYSTEMBACKDROP_TYPE, DWMWA_TEXT_COLOR,
        DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };
    use windows_sys::Win32::Graphics::Gdi::{
        ClientToScreen, CreateRoundRectRgn, DeleteObject, SetWindowRgn,
    };
    use windows_sys::Win32::UI::Controls::MARGINS;
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DefWindowProcW, GetWindowLongW, GetWindowRect, SetWindowLongW, SetWindowPos, GWL_EXSTYLE,
        GWL_STYLE, STYLESTRUCT, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_NOZORDER, WM_NCACTIVATE, WM_NCDESTROY, WM_NCPAINT, WM_STYLECHANGING, WS_CAPTION,
        WS_EX_WINDOWEDGE, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
    };

    const RADIUS: f64 = 8.0;
    /// 悬浮窗专用 Win32 子类 ID（"CSQW"），仅挂在 `quota-widget` 窗口上。
    const CHROME_SUBCLASS_ID: usize = 0x4353_5157;
    const DWMWA_COLOR_NONE: u32 = 0xffff_fffe;
    const STRIP_STYLES: u32 =
        WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU;
    static ACRYLIC: AtomicBool = AtomicBool::new(false);

    pub fn glass() -> &'static str {
        if ACRYLIC.load(Ordering::Acquire) {
            "acrylic"
        } else {
            "frosted"
        }
    }

    /// 悬浮窗专用 Win32 子类：
    /// - `WM_STYLECHANGING`：拦截 `tao::WindowFlags::apply_diff` 写回的 `WS_CAPTION | WS_SYSMENU`
    ///   并保持 `WS_POPUP`，从根源杜绝右上角关闭按钮 `×` 与非客户区框架回写。
    /// - `WM_NCPAINT`：屏蔽经典非客户区重绘，防止残留白色标题条或标题文字落到 GDI 表面。
    /// - `WM_NCACTIVATE`：按微软文档传入 `lParam = -1` 调用 `DefWindowProcW`，只更新窗口激活状态
    ///   （保证 Windows 11 DWM Acrylic 实时模糊在聚焦/失焦后都保持通透），不绘制顶部 ~22px 白色标题带。
    /// - `WM_NCDESTROY`：窗口销毁前摘除子类并继续交给 tao 清理。
    unsafe extern "system" fn widget_chrome_subclass(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _uid_subclass: usize,
        _ref_data: usize,
    ) -> LRESULT {
        match msg {
            WM_STYLECHANGING if lparam != 0 => {
                let ss = &mut *(lparam as *mut STYLESTRUCT);
                if wparam as i32 == GWL_STYLE {
                    ss.styleNew = (ss.styleNew & !STRIP_STYLES) | WS_POPUP;
                } else if wparam as i32 == GWL_EXSTYLE {
                    ss.styleNew &= !WS_EX_WINDOWEDGE;
                }
            }
            WM_NCPAINT => return 0,
            WM_NCACTIVATE => return DefWindowProcW(hwnd, msg, wparam, -1),
            WM_NCDESTROY => {
                RemoveWindowSubclass(hwnd, Some(widget_chrome_subclass), CHROME_SUBCLASS_ID);
            }
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    /// 幂等挂载子类（仅应在窗口所属主线程调用）。
    unsafe fn ensure_chrome_subclass(hwnd: HWND) {
        SetWindowSubclass(hwnd, Some(widget_chrome_subclass), CHROME_SUBCLASS_ID, 0);
    }

    /// 剥离 tao 写回的非客户区标题栏与系统菜单样式并切为 `WS_POPUP`，彻底避免 DWM 在顶部
    /// 绘出白色标题带、标题文字或右上角关闭按钮 `×`。
    /// `force_dwm` 为 `false` 时，若窗口样式已经干净则直接跳过，适合高频焦点事件的轻量守卫。
    /// SAFETY: 调用方必须确保 `hwnd` 属于存活的顶层窗口并在主线程调用。
    unsafe fn strip_non_client_chrome(hwnd: isize, force_dwm: bool) {
        let style = GetWindowLongW(hwnd as _, GWL_STYLE) as u32;
        let stripped = (style & !STRIP_STYLES) | WS_POPUP;
        let ex_style = GetWindowLongW(hwnd as _, GWL_EXSTYLE) as u32;
        let stripped_ex = ex_style & !WS_EX_WINDOWEDGE;
        let dirty = stripped != style || stripped_ex != ex_style;
        if dirty {
            if stripped != style {
                SetWindowLongW(hwnd as _, GWL_STYLE, stripped as i32);
            }
            if stripped_ex != ex_style {
                SetWindowLongW(hwnd as _, GWL_EXSTYLE, stripped_ex as i32);
            }
            SetWindowPos(
                hwnd as _,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
        if (dirty || force_dwm) && ACRYLIC.load(Ordering::Acquire) {
            let none = DWMWA_COLOR_NONE;
            let corners = DWMWCP_ROUND;
            DwmSetWindowAttribute(
                hwnd as _,
                DWMWA_BORDER_COLOR as u32,
                &none as *const _ as _,
                std::mem::size_of_val(&none) as u32,
            );
            DwmSetWindowAttribute(
                hwnd as _,
                DWMWA_CAPTION_COLOR as u32,
                &none as *const _ as _,
                std::mem::size_of_val(&none) as u32,
            );
            DwmSetWindowAttribute(
                hwnd as _,
                DWMWA_TEXT_COLOR as u32,
                &none as *const _ as _,
                std::mem::size_of_val(&none) as u32,
            );
            DwmSetWindowAttribute(
                hwnd as _,
                DWMWA_WINDOW_CORNER_PREFERENCE as u32,
                &corners as *const _ as _,
                std::mem::size_of_val(&corners) as u32,
            );
        }
    }

    pub fn init(window: &WebviewWindow) {
        ACRYLIC.store(false, Ordering::Release);
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        let margins = MARGINS {
            cxLeftWidth: -1,
            cxRightWidth: -1,
            cyTopHeight: -1,
            cyBottomHeight: -1,
        };
        // SAFETY: HWND 来自存活的 Tauri 窗口；所有 Win32 属性值和结构大小均与系统定义匹配。
        unsafe {
            strip_non_client_chrome(hwnd.0 as isize, false);

            // Windows 11 22H2+：启用真正的桌面级 DWM Acrylic 模糊（CSS backdrop-filter
            // 无法穿透 WebView 模糊桌面背景）。失败（如 Win10）时不扩展 frame，回退圆角裁剪。
            let backdrop = DWMSBT_TRANSIENTWINDOW as u32;
            let backdrop_result = DwmSetWindowAttribute(
                hwnd.0 as _,
                DWMWA_SYSTEMBACKDROP_TYPE as u32,
                &backdrop as *const _ as _,
                std::mem::size_of_val(&backdrop) as u32,
            );
            let acrylic = if backdrop_result >= 0 {
                DwmExtendFrameIntoClientArea(hwnd.0 as _, &margins) >= 0
            } else {
                log::debug!(
                    "[QuotaWidget] 原生 Acrylic 不可用，回退圆角磨砂模式 ({backdrop_result:#x})"
                );
                false
            };
            ACRYLIC.store(acrylic, Ordering::Release);
            strip_non_client_chrome(hwnd.0 as isize, true);
        }
        // 在窗口所属主线程挂载 Win32 子类，确保首次 `show()` 前就能拦截 `WM_STYLECHANGING`
        // 与 `WM_NCACTIVATE` / `WM_NCPAINT`。
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(hwnd) = target.hwnd() else {
                return;
            };
            // SAFETY: 主线程上的存活窗口。
            unsafe {
                ensure_chrome_subclass(hwnd.0 as _);
                strip_non_client_chrome(hwnd.0 as isize, true);
            }
        });
    }

    /// `tao::set_visible(true)` 会经 `WindowFlags::apply_diff` 尝试写回 `WS_CAPTION | WS_SYSMENU`，
    /// 在主线程再次确认子类挂载并清理非客户区样式与 DWM 属性。
    pub fn after_show(window: &WebviewWindow) {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(hwnd) = target.hwnd() else {
                return;
            };
            // SAFETY: 主线程上的存活窗口。
            unsafe {
                ensure_chrome_subclass(hwnd.0 as _);
                strip_non_client_chrome(hwnd.0 as isize, true);
            }
        });
    }

    /// 聚焦/失焦时的轻量非客户区样式守卫：样式已干净时不发 DWM/SetWindowPos 调用。
    pub fn on_focus(window: &WebviewWindow) {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(hwnd) = target.hwnd() else {
                return;
            };
            // SAFETY: 主线程上的存活窗口。
            unsafe {
                strip_non_client_chrome(hwnd.0 as isize, false);
            }
        });
    }

    pub fn appearance(window: &WebviewWindow, dark: bool) {
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        let value = i32::from(dark);
        // SAFETY: HWND 在调用期间存活；属性接收一个 BOOL（32 位整数）。
        unsafe {
            DwmSetWindowAttribute(
                hwnd.0 as _,
                DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
                &value as *const _ as _,
                std::mem::size_of_val(&value) as u32,
            );
        }
    }

    /// 每次尺寸更新时确保非客户区样式保持剥离；非 Acrylic 降级模式按新尺寸裁剪圆角。
    pub fn apply(window: &WebviewWindow, width: f64, height: f64) {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(hwnd) = target.hwnd() else {
                return;
            };
            // SAFETY: 主线程上的存活窗口；region 交给系统管理，失败时自行释放。
            unsafe {
                ensure_chrome_subclass(hwnd.0 as _);
                strip_non_client_chrome(hwnd.0 as isize, true);
                if ACRYLIC.load(Ordering::Acquire) {
                    return;
                }
                let mut outer = RECT::default();
                let mut origin = POINT::default();
                if GetWindowRect(hwnd.0 as _, &mut outer) == 0
                    || ClientToScreen(hwnd.0 as _, &mut origin) == 0
                {
                    return;
                }
                let dpi = GetDpiForWindow(hwnd.0 as _);
                let scale = if dpi > 0 { dpi as f64 / 96.0 } else { 1.0 };
                let x = origin.x - outer.left;
                let y = origin.y - outer.top;
                let w = (width * scale).round() as i32;
                let h = (height * scale).round() as i32;
                let diameter = (RADIUS * 2.0 * scale).round() as i32;
                let region = CreateRoundRectRgn(x, y, x + w + 1, y + h + 1, diameter, diameter);
                if !region.is_null() && SetWindowRgn(hwnd.0 as _, region, 1) == 0 {
                    DeleteObject(region);
                }
            }
        });
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use tauri::WebviewWindow;

    pub fn glass() -> &'static str {
        "frosted"
    }

    pub fn init(_window: &WebviewWindow) {}

    pub fn after_show(_window: &WebviewWindow) {}

    pub fn on_focus(_window: &WebviewWindow) {}

    pub fn appearance(_window: &WebviewWindow, _dark: bool) {}

    pub fn apply(_window: &WebviewWindow, _width: f64, _height: f64) {}
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{
        cached_agy_quota_if_fresh, clamp_to_monitor, default_position, nudge_y_within_monitor,
        resolve_position, MonitorWorkArea, AGY_REFRESH_DEBOUNCE,
    };
    use crate::app_config::AppType;
    use crate::services::subscription::{CredentialStatus, SubscriptionQuota};
    use crate::services::usage_cache::UsageCache;

    const PRIMARY_1080P: MonitorWorkArea = MonitorWorkArea {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1032,
        scale: 1.0,
    };

    #[cfg(target_os = "windows")]
    #[tauri::command]
    fn quota_preview_report(body: String) {
        println!("[quota-preview-body] {body}");
    }

    /// Opt-in renderer/material smoke test. Uses a different app identifier and synthetic data,
    /// never calls the real application setup, account queries, or installed singleton.
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires the renderer on port 3001 and an interactive Windows desktop"]
    fn native_visual_smoke() {
        use crate::sync_utils::MutexExt;
        use tauri::Manager;
        let mut context = tauri::generate_context!();
        context.config_mut().identifier = "com.ccswitch.quota-visual-check".into();
        context.config_mut().app.windows.clear();
        context.config_mut().build.dev_url = Some("http://127.0.0.1:3001".parse().unwrap());
        tauri::Builder::default()
            .any_thread()
            .invoke_handler(tauri::generate_handler![
                super::quota_widget_bootstrap,
                super::quota_widget_ready,
                super::quota_widget_layout,
                super::quota_widget_appearance,
                super::quota_widget_reset_position,
                quota_preview_report,
            ])
            .setup(|app| {
                let background = concat!(
                    "http://127.0.0.1:3001/@fs/",
                    env!("CARGO_MANIFEST_DIR"),
                    "/../tests/fixtures/quotaWidgetBackdrop.html"
                );
                tauri::WebviewWindowBuilder::new(
                    app,
                    "quota-visual-background",
                    tauri::WebviewUrl::External(background.parse()?),
                )
                .title("Quota visual backdrop")
                .position(190.0, 190.0)
                .inner_size(400.0, 260.0)
                .decorations(false)
                .build()?;
                let window = tauri::WebviewWindowBuilder::new(
                    app,
                    super::WIDGET_LABEL,
                    tauri::WebviewUrl::App("quota-widget.html".into()),
                )
                .title("CC Switch quota visual check")
                .inner_size(super::DEFAULT_WIDTH, 140.0)
                .position(220.0, 220.0)
                .transparent(true)
                .background_color(tauri::window::Color(0, 0, 0, 0))
                .decorations(false)
                .shadow(false)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .visible(false)
                .always_on_top(true)
                .initialization_script(include_str!("../../tests/fixtures/quotaWidgetPreview.js"))
                .build()?;
                super::PENDING_REVEAL.store(true, std::sync::atomic::Ordering::Release);
                *super::APPLIED_FRAME.lock_recover() = None;
                super::platform::init(&window);
                println!("[quota-preview-hwnd] {}", window.hwnd()?.0 as usize);
                println!("[quota-preview-ready]");
                window.eval("setTimeout(() => window.__TAURI_INTERNALS__.invoke('quota_preview_report', {body: document.body.innerText}), 5000)")?;
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(18)).await;
                    if let Some(window) = handle.get_webview_window(super::WIDGET_LABEL) {
                        println!(
                            "[quota-preview] glass={} size={:?}",
                            super::platform::glass(),
                            window.inner_size()
                        );
                    }
                    handle.exit(0);
                });
                Ok(())
            })
            .build(context)
            .unwrap()
            .run_return(|_, _| {});
    }

    #[test]
    fn default_position_places_widget_in_primary_top_right_work_area() {
        let pos = default_position(Some(PRIMARY_1080P), &[PRIMARY_1080P], 252.0, 120.0);
        // 1920 - 252 - 16 = 1652, y = 0 + 16 = 16
        assert_eq!(pos, Some((1652, 16)));
    }

    #[test]
    fn position_off_desktop_or_in_mismatched_monitor_dead_zone_falls_back_to_default() {
        let left_primary = MonitorWorkArea {
            left: 0,
            top: 0,
            right: 2560,
            bottom: 1400,
            scale: 1.0,
        };
        let right_lower = MonitorWorkArea {
            left: 2560,
            top: 360,
            right: 4480,
            bottom: 1400,
            scale: 1.0,
        };
        let monitors = [left_primary, right_lower];
        let fallback = default_position(Some(left_primary), &monitors, 252.0, 100.0);

        // 严重越界 & Windows 最小化哨兵坐标 (-32000, -32000) 都回到默认位置
        assert_eq!(
            resolve_position(Some((-32000, -32000)), 252.0, 100.0, &monitors, Some(left_primary)),
            fallback
        );
        // 右屏上方的死区空洞 (3000, 40) 不属于任何一块显示器，不再误放行
        assert_eq!(
            resolve_position(Some((3000, 40)), 252.0, 100.0, &monitors, Some(left_primary)),
            fallback
        );
        // 负坐标副屏上的合法位置保留
        let neg_left = MonitorWorkArea {
            left: -1920,
            top: 0,
            right: 0,
            bottom: 1080,
            scale: 1.0,
        };
        assert_eq!(
            resolve_position(
                Some((-1900, 100)),
                252.0,
                100.0,
                &[neg_left, PRIMARY_1080P],
                Some(PRIMARY_1080P),
            ),
            Some((-1900, 100))
        );
    }

    #[test]
    fn barely_visible_position_respects_dpi_scale_and_window_width() {
        // 1x 屏：右边只露出 40px -> 拉回到至少露出 96px
        assert_eq!(clamp_to_monitor(1880, 200, 252.0, 100.0, PRIMARY_1080P), (1824, 200));
        // 顶部越界 -> 拉回工作区顶边；底部至少露出 32px
        assert_eq!(clamp_to_monitor(100, -10, 252.0, 100.0, PRIMARY_1080P), (100, 0));
        assert_eq!(clamp_to_monitor(100, 1020, 252.0, 100.0, PRIMARY_1080P), (100, 1000));

        // 2x 高 DPI 屏：4K 物理工作区，至少露出 96*2 = 192px，窗口物理宽 504px
        let hidpi = MonitorWorkArea {
            left: 0,
            top: 0,
            right: 3840,
            bottom: 2080,
            scale: 2.0,
        };
        assert_eq!(clamp_to_monitor(3750, 200, 252.0, 100.0, hidpi), (3648, 200));
        // 窄窗口 180px（物理 360px）左拖极限：- (360 - 192) = -168，不会整块消失在屏外
        assert_eq!(clamp_to_monitor(-300, 200, 180.0, 100.0, hidpi), (-168, 200));
    }

    #[test]
    fn bottom_edge_nudge_pulls_window_up_when_height_overflows_work_area() {
        // 未越过工作区底部：保持不动
        assert_eq!(nudge_y_within_monitor(700, 240.0, PRIMARY_1080P), None);
        assert_eq!(nudge_y_within_monitor(792, 240.0, PRIMARY_1080P), None);

        // 展开详情或右键菜单后越过任务栏顶边（1032）：向上推到 1032 - 240 = 792
        assert_eq!(nudge_y_within_monitor(850, 240.0, PRIMARY_1080P), Some(792));

        // 2x HiDPI 屏：物理高度 200 * 2 = 400，1800 + 400 > 2080 -> 2080 - 400 = 1680
        let hidpi = MonitorWorkArea {
            left: 0,
            top: 0,
            right: 3840,
            bottom: 2080,
            scale: 2.0,
        };
        assert_eq!(nudge_y_within_monitor(1800, 200.0, hidpi), Some(1680));

        // 上方负坐标副屏：-200 + 200 = 0 > -48 -> -48 - 200 = -248
        let upper = MonitorWorkArea {
            left: 0,
            top: -1080,
            right: 1920,
            bottom: -48,
            scale: 1.0,
        };
        assert_eq!(nudge_y_within_monitor(-200, 200.0, upper), Some(-248));

        // 极矮工作区：窗口比工作区还高时最多顶到 work_area.top，不推到屏幕外
        let short = MonitorWorkArea {
            left: 0,
            top: 40,
            right: 1280,
            bottom: 300,
            scale: 1.0,
        };
        assert_eq!(nudge_y_within_monitor(80, 320.0, short), Some(40));
        assert_eq!(nudge_y_within_monitor(40, 320.0, short), None);
    }

    #[test]
    fn agy_quota_cache_debounce_respects_ttl_and_force() {
        let cache = UsageCache::new();
        let agy_quota = SubscriptionQuota {
            tool: "agy".to_string(),
            credential_status: CredentialStatus::Valid,
            credential_message: None,
            success: true,
            tiers: vec![],
            extra_usage: None,
            reset_credits: None,
            credits_balance: None,
            plan_name: Some("Pro".to_string()),
            error: None,
            queried_at: Some(1_700_000_000_000),
        };
        let t0 = Instant::now();

        // 缓存为空时即使在 10 秒防抖窗口内也返回 None（触发实查）
        assert!(cached_agy_quota_if_fresh(&cache, Some(t0), t0 + Duration::from_secs(2), false).is_none());

        cache.put_subscription(AppType::Agy, agy_quota);

        // 10 秒内非强制请求直接命中缓存
        let hit = cached_agy_quota_if_fresh(&cache, Some(t0), t0 + Duration::from_secs(5), false)
            .expect("within debounce window should return cached AGY quota");
        assert_eq!(hit.tool, "agy");
        assert_eq!(hit.plan_name.as_deref(), Some("Pro"));

        // 强制刷新绕过缓存
        assert!(cached_agy_quota_if_fresh(&cache, Some(t0), t0 + Duration::from_secs(1), true).is_none());

        // 满 10 秒后过期，绕过缓存
        assert!(
            cached_agy_quota_if_fresh(&cache, Some(t0), t0 + AGY_REFRESH_DEBOUNCE, false).is_none()
        );

        // 从未刷新过（last_refresh = None）不走防抖
        assert!(cached_agy_quota_if_fresh(&cache, None, t0, false).is_none());
    }
}
