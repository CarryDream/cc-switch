//! 额度悬浮窗：桌面上的常驻小卡片，玻璃质感，列出各应用在用 / 有缓存额度供应商的
//! 用量和重置时间。数据与托盘面板同源（`tray::collect_panel_model`），刷新走托盘的
//! 同一条防抖管线；窗口只做展示，不提供切换等写操作。
//!
//! - 窗口懒创建，关掉（✕ / 托盘菜单）只是隐藏；进入轻量模式时销毁，下次打开重建。
//! - 位置记在前端 localStorage（物理像素），打开时先摆好位置和尺寸再显示，避免闪跳。
//! - 玻璃：macOS 26 用 `NSGlassEffectView`（Liquid Glass），更早的系统用 Popover 材质
//!   毛玻璃；Windows 11 用 DWM 系统背景（Acrylic）+ DWM 圆角，设置失败回退网页自绘
//!   磨砂；Linux 没有原生材质，网页自己画。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 悬浮窗的窗口 label（能力文件 `capabilities/quota-widget.json` 按它授权）。
pub const WIDGET_LABEL: &str = "quota-widget";
/// 托盘菜单里「额度悬浮窗」开关的事件 id。
pub const WIDGET_TOGGLE_ID: &str = "widget:toggle";

const MIN_WIDTH: f64 = 180.0;
const MAX_WIDTH: f64 = 480.0;
const MIN_HEIGHT: f64 = 40.0;
const MAX_HEIGHT: f64 = 380.0;

/// 窗口建好后还没显示：等前端回报位置和尺寸（`quota_widget_ready`）再亮相。
static PENDING_REVEAL: AtomicBool = AtomicBool::new(false);
/// 上次套给窗口的尺寸（逻辑像素），没变就不动窗口。
static APPLIED_SIZE: Mutex<Option<(f64, f64)>> = Mutex::new(None);

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

// ─── 窗口 ────────────────────────────────────────────────────────────────────

fn widget_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WIDGET_LABEL)
}

fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let window =
        WebviewWindowBuilder::new(app, WIDGET_LABEL, WebviewUrl::App("quota-widget.html".into()))
            .title("CC Switch")
            .inner_size(240.0, 96.0)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .decorations(false)
            .transparent(true)
            // 无边框透明窗口的系统阴影会暴露方形外框，Windows 关掉；macOS 留着给卡片投影。
            .shadow(!cfg!(target_os = "windows"))
            .always_on_top(true)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
            .visible(false)
            .focused(false)
            .build()?;
    PENDING_REVEAL.store(true, Ordering::Release);
    *lock(&APPLIED_SIZE) = None;
    platform::init(&window);

    let handle = window.clone();
    window.on_window_event(move |event| {
        // 常驻悬浮窗：失焦不收起，只有点 ✕ / 托盘菜单才隐藏。
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            hide_window(&handle);
        }
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
    PENDING_REVEAL.store(false, Ordering::Release);
    let _ = window.hide();
    release_if_lightweight(window.app_handle());
}

pub fn hide_widget(app: &AppHandle) {
    if let Some(window) = widget_window(app) {
        hide_window(&window);
    }
}

/// 托盘菜单开关：开着就关，关着就开。窗口销毁过（轻量模式）就重建，前端加载后经
/// `quota_widget_ready` 摆好位置再显示。
pub fn toggle(app: &AppHandle) {
    if let Some(window) = widget_window(app) {
        if PENDING_REVEAL.load(Ordering::Acquire) {
            return; // 刚建好还在等前端排版，ready 会显示它
        }
        if window.is_visible().unwrap_or(false) {
            hide_window(&window);
        } else {
            let _ = window.show();
        }
        return;
    }
    let _ = ensure_window(app);
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

/// 所有显示器的并集（物理像素）；读不到显示器时为空。
fn desktop_bounds(app: &AppHandle) -> Option<(i32, i32, i32, i32)> {
    let monitors = app.available_monitors().ok()?;
    let first = monitors.first()?;
    let mut left = first.position().x;
    let mut top = first.position().y;
    let mut right = first.position().x + first.size().width as i32;
    let mut bottom = first.position().y + first.size().height as i32;
    for m in &monitors[1..] {
        left = left.min(m.position().x);
        top = top.min(m.position().y);
        right = right.max(m.position().x + m.size().width as i32);
        bottom = bottom.max(m.position().y + m.size().height as i32);
    }
    Some((left, top, right, bottom))
}

/// 存的位置还在不在桌面上：显示器拔掉后旧坐标可能整块在屏幕外，回默认位置（居中）。
/// 还在就收紧到可抓得回来的范围：横向上至少留 96px（标题栏横贯整宽，露出一段就能拖），
/// 纵向上整个标题栏都要在桌面内、底部至少留 32px。
fn clamp_within(x: i32, y: i32, bounds: (i32, i32, i32, i32)) -> Option<(i32, i32)> {
    let (left, top, right, bottom) = bounds;
    let slack = 64;
    if x < left - slack || x > right || y < top - slack || y > bottom {
        return None;
    }
    Some((x.clamp(left - 204, right - 96), y.clamp(top, bottom - 32)))
}

/// 摆一次窗口：位置（有就挪）、尺寸（按显示器缩放换物理像素）、玻璃跟着内容改大小。
fn apply_frame(window: &WebviewWindow, position: Option<(i32, i32)>, width: f64, height: f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let width = width.clamp(MIN_WIDTH, MAX_WIDTH);
    let height = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
    let changed = *lock(&APPLIED_SIZE) != Some((width, height));
    if changed {
        *lock(&APPLIED_SIZE) = Some((width, height));
        if let Some((x, y)) = position {
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
        let _ = window.set_size(tauri::PhysicalSize::new(
            (width * scale).round() as u32,
            (height * scale).round() as u32,
        ));
        platform::apply(window, width, height);
    } else if let Some((x, y)) = position {
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
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

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetPosition {
    pub x: i32,
    pub y: i32,
}

/// 前端加载完成：摆好存下的位置和实测的尺寸，然后显示。返回玻璃模式给前端配色。
#[tauri::command]
pub fn quota_widget_ready(
    app: AppHandle,
    position: Option<WidgetPosition>,
    width: f64,
    height: f64,
) -> WidgetGlass {
    let info = WidgetGlass {
        glass: platform::glass(),
        platform: std::env::consts::OS,
    };
    let Some(window) = widget_window(&app) else {
        return info;
    };
    let saved = position.and_then(|p| {
        desktop_bounds(&app).and_then(|b| clamp_within(p.x, p.y, b))
    });
    apply_frame(&window, saved, width, height);
    if PENDING_REVEAL.swap(false, Ordering::AcqRel) {
        let _ = window.show();
    }
    info
}

/// 内容变了（数据到货、深浅色切换）：窗口跟着内容改尺寸。
#[tauri::command]
pub fn quota_widget_layout(app: AppHandle, width: f64, height: f64) {
    if let Some(window) = widget_window(&app) {
        apply_frame(&window, None, width, height);
    }
}

/// 刷新各家额度（在用的 + 开了自动查询的脚本供应商），写进缓存；前端随后取状态。
#[tauri::command]
pub async fn quota_widget_refresh(app: AppHandle) {
    crate::tray::refresh_all_usage_in_tray(&app).await;
    crate::tray::refresh_panel_provider_usage(&app).await;
}

#[tauri::command]
pub fn quota_widget_hide(app: AppHandle) {
    hide_widget(&app);
}

/// 双击悬浮窗打开主窗口（和左键点托盘图标同一条路径）。
#[tauri::command]
pub fn quota_widget_show_main(app: AppHandle) {
    crate::tray::show_main_window(&app);
}

/// Antigravity 现在登着的号的额度：托盘的额度管线不含 AGY（不在 `TRAY_APPS`），
/// 悬浮窗自己问。每次都是实打实的网络请求（约 1 秒），前端按几分钟一档的节奏调。
#[tauri::command]
pub async fn quota_widget_agy_quota(
    state: tauri::State<'_, crate::commands::AgyAccountState>,
) -> Result<crate::services::subscription::SubscriptionQuota, String> {
    crate::commands::agy_account::agy_quota(&state.0, None).await
}

// ─── 平台：玻璃 ──────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;

    use objc2_06::rc::Retained;
    use objc2_06::runtime::{AnyClass, NSObjectProtocol};
    use objc2_06::MainThreadMarker;
    use objc2_app_kit_03::{
        NSGlassEffectView, NSGlassEffectViewStyle, NSView, NSVisualEffectBlendingMode,
        NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView, NSWindow,
        NSWindowOrderingMode,
    };
    use objc2_foundation_03::{NSPoint, NSRect, NSSize};
    use tauri::WebviewWindow;

    /// 和卡片 CSS 的圆角一致。
    const RADIUS: f64 = 12.0;

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
        if effect.respondsToSelector(objc2_06::sel!(setCornerRadius:)) {
            // SAFETY: 上面确认过能响应，参数是 CGFloat。
            unsafe {
                let _: () = objc2_06::msg_send![&*effect, setCornerRadius: RADIUS];
            }
        }
        Retained::into_super(effect)
    }

    pub fn init(_window: &WebviewWindow) {}

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
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE, DWMWA_WINDOW_CORNER_PREFERENCE,
        DWMSBT_TRANSIENTWINDOW, DWMWCP_ROUND,
    };

    /// DWM 系统背景（Acrylic）有没有套上；套不上（Win10 / 旧 22H2）由网页自绘磨砂。
    static ACRYLIC: AtomicBool = AtomicBool::new(false);

    pub fn glass() -> &'static str {
        if ACRYLIC.load(Ordering::Acquire) {
            "acrylic"
        } else {
            "frosted"
        }
    }

    pub fn init(window: &WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        // SAFETY: hwnd 来自 tao，窗口存活；只在建窗时设置一次背景和圆角。
        unsafe {
            // Acrylic 材质的系统背景（飞出层同款），画在网页透明的地方。
            let backdrop = DWMSBT_TRANSIENTWINDOW;
            let acrylic = DwmSetWindowAttribute(
                hwnd.0 as _,
                DWMWA_SYSTEMBACKDROP_TYPE as u32,
                &backdrop as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<i32>() as u32,
            ) == 0;
            ACRYLIC.store(acrylic, Ordering::Release);
            // DWM 圆角跟着裁系统背景，和卡片的 CSS 圆角对齐。
            let corners = DWMWCP_ROUND;
            DwmSetWindowAttribute(
                hwnd.0 as _,
                DWMWA_WINDOW_CORNER_PREFERENCE as u32,
                &corners as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<i32>() as u32,
            );
        }
    }

    /// 背景是整窗的，窗口改尺寸时不用动。
    pub fn apply(_window: &WebviewWindow, _width: f64, _height: f64) {}
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use tauri::WebviewWindow;

    pub fn glass() -> &'static str {
        "frosted"
    }

    pub fn init(_window: &WebviewWindow) {}

    pub fn apply(_window: &WebviewWindow, _width: f64, _height: f64) {}
}

#[cfg(test)]
mod tests {
    use super::clamp_within;

    #[test]
    fn position_off_the_desktop_falls_back_to_default() {
        let bounds = (0, 0, 1920, 1080);
        assert_eq!(clamp_within(-3000, 400, bounds), None);
        assert_eq!(clamp_within(500, 5000, bounds), None);
        // 负坐标的副屏也在桌面内
        let dual = (-1920, 0, 1920, 1080);
        assert_eq!(clamp_within(-1900, 100, dual), Some((-1900, 100)));
    }

    #[test]
    fn barely_visible_position_is_pulled_back_onto_the_desktop() {
        let bounds = (0, 0, 1920, 1080);
        // 右边只露出 40px：拉回来到至少 96px
        assert_eq!(clamp_within(1880, 200, bounds), Some((1824, 200)));
        // 标题栏跑到屏幕上面去了：标题栏整条拉回桌面内
        assert_eq!(clamp_within(100, -4, bounds), Some((100, 0)));
        // 底部至少留 32px
        assert_eq!(clamp_within(100, 1075, bounds), Some((100, 1048)));
    }
}
