//! UIA 捕获薄封装：前台进程名 → focused element → TextPattern → 选区文本 + 行包围盒。
//!
//! 范围（spike）：标准 UIA 路径。Chromium/Edge、Word、记事本、Acrobat、WebView2（含自窗口）
//! 走此路径；无 TextPattern 的自绘应用（微信等）留待剪贴板兜底（后半）。

use windows::core::{Interface, IUnknown, PWSTR, Result as WResult};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Ole::{
    SafeArrayAccessData, SafeArrayDestroy, SafeArrayGetLBound, SafeArrayGetUBound,
    SafeArrayUnaccessData,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    QueryFullProcessImageNameW,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
    IUIAutomationTextRange, UIA_TextPatternId,
};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetGUIThreadInfo, GetWindowRect, GetWindowThreadProcessId,
    GUITHREADINFO,
};

use super::layout::{PhysRect, Point};

pub struct Uia {
    automation: IUIAutomation,
}

impl Uia {
    /// 需要 worker 线程已 `CoInitializeEx(COINIT_MULTITHREADED)`
    pub fn new() -> WResult<Self> {
        // SAFETY: 标准 COM 激活，进程内单例（CUIAutomation 为 CLSID GUID 常量）
        let automation: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)? };
        Ok(Self { automation })
    }

    /// 焦点元素（浮标 focusable:false 保证划词时焦点仍在源应用）
    pub fn focused(&self) -> WResult<IUIAutomationElement> {
        // SAFETY: COM 接口调用
        unsafe { self.automation.GetFocusedElement() }
    }

    /// 前台窗口元素兜底：GetFocusedElement 对部分 provider 返回 S_OK + null
    /// （Acrobat 保护模式 / Gecko 等），改从前台 HWND 取元素再试 TextPattern
    pub fn element_from_foreground(&self) -> WResult<IUIAutomationElement> {
        // SAFETY: Win32 查询 + COM 接口调用
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_invalid() {
                return Err(windows::core::Error::empty());
            }
            self.automation.ElementFromHandle(hwnd)
        }
    }

    pub fn text_pattern(&self, element: &IUIAutomationElement) -> WResult<IUIAutomationTextPattern> {
        // SAFETY: COM 接口调用 + 接口 cast
        unsafe {
            let unk: IUnknown = element.GetCurrentPattern(UIA_TextPatternId)?;
            unk.cast::<IUIAutomationTextPattern>()
        }
    }

    /// 第一个非空选区 range；无选区 → Ok(None)
    pub fn first_nonempty_range(
        &self,
        pattern: &IUIAutomationTextPattern,
    ) -> WResult<Option<IUIAutomationTextRange>> {
        // SAFETY: COM 接口调用
        unsafe {
            let ranges = pattern.GetSelection()?;
            let len = ranges.Length()?;
            for i in 0..len {
                let range = ranges.GetElement(i)?;
                let text = range.GetText(-1)?;
                let text = text.to_string();
                if !text.trim().is_empty() {
                    return Ok(Some(range));
                }
            }
        }
        Ok(None)
    }

    pub fn range_text(range: &IUIAutomationTextRange) -> String {
        // SAFETY: COM 接口调用；BSTR → String（lossy）
        unsafe { range.GetText(-1).map(|b| b.to_string()).unwrap_or_default() }
    }

    /// 行包围盒（物理像素，阅读序）。返回 `f64` SAFEARRAY，每行 4 个：left/top/width/height。
    pub fn range_rects(range: &IUIAutomationTextRange) -> WResult<Vec<PhysRect>> {
        // SAFETY: SAFEARRAY 生命周期由本函数管理（Access→拷贝→Unaccess→Destroy）
        unsafe {
            let psa = range.GetBoundingRectangles()?;
            if psa.is_null() {
                return Ok(vec![]);
            }
            let out = (|| -> WResult<Vec<PhysRect>> {
                let lb = SafeArrayGetLBound(psa, 1)?;
                let ub = SafeArrayGetUBound(psa, 1)?;
                let n = (ub - lb + 1).max(0) as usize;
                if n < 4 {
                    return Ok(vec![]);
                }
                let mut pv: *mut core::ffi::c_void = std::ptr::null_mut();
                SafeArrayAccessData(psa, &mut pv)?;
                let data = std::slice::from_raw_parts(pv as *const f64, n);
                let mut rects = Vec::with_capacity(n / 4);
                for c in data.chunks_exact(4) {
                    rects.push(PhysRect {
                        x: c[0].round() as i32,
                        y: c[1].round() as i32,
                        w: c[2].round() as i32,
                        h: c[3].round() as i32,
                    });
                }
                Ok(rects)
            })();
            SafeArrayUnaccessData(psa).ok();
            SafeArrayDestroy(psa).ok();
            out
        }
    }
}

/// 前台窗口所属进程的可执行文件名（小写）。拿不到 → None。
pub fn foreground_process_name() -> Option<String> {
    // SAFETY: Win32 查询 + 带权限边界（QUERY_LIMITED_INFORMATION）
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return None;
        };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let full = if QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok()
        {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            String::new()
        };
        let _ = CloseHandle(handle);
        let exe = full.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase();
        if exe.is_empty() { None } else { Some(exe) }
    }
}

/// 前台应用 caret 位置（物理屏幕坐标 ctrlkey/shortcut 触发定位）。
/// 链：①前台线程 GUITHREADINFO.hwndCaret + rcCaret（客户区）→ ClientToScreen
/// （可编辑态场景准）；②**鼠标当前位置**（浏览器选中文本/自绘应用无系统 caret，
/// 而用户刚拖选完鼠标就在选区附近—— 「快捷键浮标不在查词
/// 位置」的根因是原实现直接退窗口中心）；③前台窗口矩形中心兜底；全失败 →
/// None（调用方弃捕）。注意 UIA rects 可用时定位优先走 rects（pick_anchor），
/// 本函数只是 rects 失败/剪贴板兜底路径的锚点。
pub fn foreground_caret() -> Option<Point> {
    // SAFETY: Win32 查询链；GUITHREADINFO.cbSize 先填（约定）
    unsafe {
        let mut gti = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if GetGUIThreadInfo(0, &mut gti).is_ok() && !gti.hwndCaret.is_invalid() {
            let mut pt = windows::Win32::Foundation::POINT {
                x: gti.rcCaret.left,
                y: gti.rcCaret.bottom, // caret 底部 = 文本行基线下方，浮标位置更贴
            };
            if ClientToScreen(gti.hwndCaret, &mut pt).as_bool() {
                return Some(Point { x: pt.x, y: pt.y });
            }
        }
        let mut cur = windows::Win32::Foundation::POINT::default();
        if GetCursorPos(&mut cur).is_ok() {
            return Some(Point { x: cur.x, y: cur.y });
        }
        let hwnd = GetForegroundWindow();
        if !hwnd.is_invalid() {
            let mut rect = Default::default();
            if GetWindowRect(hwnd, &mut rect).is_ok() {
                return Some(Point {
                    x: (rect.left + rect.right) / 2,
                    y: (rect.top + rect.bottom) / 2,
                });
            }
        }
        None
    }
}
