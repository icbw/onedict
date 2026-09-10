//! 截图翻译：
//! 快捷键框选屏幕区域 → GDI 截屏 → Windows.Media.Ocr 识别 → 识别全文直接进
//! 翻译面板（ActionTranslate 双栏流式，微信/PixPin 截图翻译式）。不做词级取词
//! ——取词场景已有划词/剪贴板链路，截图价值在整段翻译。
//!
//! 路线 A1（无包标识普通 exe 直调 WinRT OCR）：已验证无包标识可创建 zh-Hans-CN 引擎、
//! 中文识别 22–110ms、中文逐字切词带 BoundingRect、BitBlt→SoftwareBitmap 像素链通。
//!
//! `OcrProvider` trait 对冲引擎切换风险（调研 R2：未来系统封堵 unpackaged 调用或
//! 需更高质量时换 ONNX/WinAI 引擎不动上层）。
//!
//! 流程：快捷键/托盘 → `launch_capture`（ocr-capture 覆盖层铺满**鼠标所在显示器**
//! 物理 bounds——多屏铺虚拟屏整面的教训：提示条落在窗口中心 = 显示器交界处，用户
//! 看不到任何反馈）→ 前端拖框松开定格（选框内纯透屏）→ `ocr_recognize_region`
//! 直接 BitBlt 选区（**不隐藏覆盖层**——hide→show 序列曾导致错位框/闪退/乱序失焦
//! 一连串问题）→ 识别 + 快照 PNG → 前端快照无缝覆盖选框原位 + 翻译卡流式。

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position};

/// 覆盖层窗口 label（预建于 tauri.conf.json；capabilities windows 数组须含之）
const WINDOW_LABEL: &str = "ocr-capture";

/// 本次框选所在显示器的物理原点（launch_capture 写入，recognize 换算用——
/// 覆盖层只铺鼠标所在屏，坐标 = 该屏原点 + 窗口内偏移）
static CAPTURE_ORIGIN: Mutex<(i32, i32)> = Mutex::new((0, 0));

/// 进入截图模式时的全屏底图（放大镜采样用）：(PNG dataURL, 物理宽, 物理高,
/// 鼠标 CSS x, 鼠标 CSS y)。`launch_capture` 在覆盖层 show **前**截屏——此刻
/// 窗口未上屏，画面纯净无遮罩叠加（遮罩改纯透明的根因即遮罩色会被
/// BitBlt 合成进快照）。空串 = 截屏失败，前端放大镜降级隐藏。鼠标 CSS 坐标 =
/// 放大镜初始位置（实测反馈：放大镜依赖首条 mousemove——唤起后未动鼠标直接
/// 拖框则整场不出现；由 Rust 直接给出唤起时刻位置，不动鼠标也显示）。
static SCREEN_SHOT: Mutex<(String, i32, i32, f64, f64)> =
    Mutex::new((String::new(), 0, 0, 0.0, 0.0));

// ── 结果结构（命令返回 payload）──

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OcrWordOut {
    pub text: String,
    /// 屏幕物理坐标（选区原点 + 图像内偏移）；点击查词的锚点
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OcrLineOut {
    pub text: String,
    /// 行级 rect（图像内坐标，命令层再映射为屏幕物理；words 为空 = 全 0，前端跳过叠加）
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub words: Vec<OcrWordOut>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OcrRegionResult {
    pub lines: Vec<OcrLineOut>,
    /// 全文（行按 \n 拼接，复制全文/动作面板用）
    pub text: String,
    /// 选区截图快照（PNG dataURL；前端钉在选框原位——截图固定位置，
    /// 译文在快照旁流式输出；编码失败为空串，前端降级无快照）
    pub snapshot: String,
    /// 选区屏幕物理坐标（前端把结果面板摆到选区旁用）
    pub region_x: i32,
    pub region_y: i32,
    pub region_w: i32,
    pub region_h: i32,
    /// 识别耗时（截屏 + OCR，不含隐藏缓冲）
    pub elapsed_ms: u64,
}

// ── 引擎抽象（OcrProvider trait 对冲切换）──

pub trait OcrProvider: Send + Sync {
    /// 识别 top-down BGRA8 像素缓冲（w*h*4）；词 BoundingRect 为图像内像素。
    /// 语言不可用返回 `OCR_LANG_MISSING:<tag>` 前缀错误（前端据此显示引导）。
    fn recognize(
        &self,
        lang: &str,
        bgra: &[u8],
        width: i32,
        height: i32,
    ) -> Result<Vec<OcrLineOut>, String>;
    /// 系统可用 OCR 语言标签列表（设置页下拉）
    fn available_languages(&self) -> Vec<String>;
}

/// 引擎缓存：语言 → 引擎单例（TryCreate 约 2–3ms，缓存后重复识别零建引擎开销）。
/// windows crate 接口类型为 Agile（ThreadingModel.Both），跨线程共享安全。
static ENGINES: Mutex<Option<HashMap<String, windows::Media::Ocr::OcrEngine>>> = Mutex::new(None);

/// 按语言标签创建引擎（spike 实测：Try* 返回 `Result<OcrEngine>` 非 Option；
/// 语言不可用 = Err）。空串走自动链：zh-Hans-CN → en-US → 用户语言。
fn create_engine(lang: &str) -> Result<windows::Media::Ocr::OcrEngine, String> {
    use windows::Globalization::Language;
    use windows::Media::Ocr::OcrEngine;

    let make = |tag: &str| -> Option<windows::Media::Ocr::OcrEngine> {
        let l = Language::CreateLanguage(&windows::core::HSTRING::from(tag)).ok()?;
        OcrEngine::TryCreateFromLanguage(&l).ok()
    };

    if !lang.is_empty() {
        return make(lang)
            .ok_or_else(|| format!("OCR_LANG_MISSING:{lang}"));
    }
    // 自动链（偏好 ocrLang 未设置）：中文优先（应用主场景）→ 英文 → 用户语言
    if let Some(e) = make("zh-Hans-CN") {
        return Ok(e);
    }
    if let Some(e) = make("en-US") {
        return Ok(e);
    }
    OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|_| "OCR_LANG_MISSING:auto".to_string())
}

fn engine_for(lang: &str) -> Result<windows::Media::Ocr::OcrEngine, String> {
    let mut guard = ENGINES.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if let Some(e) = map.get(lang) {
        return Ok(e.clone());
    }
    let engine = create_engine(lang)?;
    map.insert(lang.to_string(), engine.clone());
    Ok(engine)
}

/// WinRT 实现（Windows.Media.Ocr；spike 代码复用，windows 0.61 API 形态备忘见
/// spike 文档 §6.5）
struct WinRtOcr;

impl OcrProvider for WinRtOcr {
    fn recognize(
        &self,
        lang: &str,
        bgra: &[u8],
        width: i32,
        height: i32,
    ) -> Result<Vec<OcrLineOut>, String> {
        use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
        use windows::Storage::Streams::DataWriter;
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

        // 命令线程 COM 初始化（幂等；已初始化返回 S_FALSE 同为成功）
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };

        let engine = engine_for(lang)?;
        let t0 = std::time::Instant::now();
        // WinRT 方法在 windows 0.61 为 safe（仅 Win32 指针类调用需 unsafe）
        let lines = {
            // BGRA 像素 → IBuffer（DataWriter 最省事构造法，spike 验证）
            let writer = DataWriter::new().map_err(|e| e.to_string())?;
            writer.WriteBytes(bgra).map_err(|e| e.to_string())?;
            let buffer = writer.DetachBuffer().map_err(|e| e.to_string())?;
            // CreateCopyFromBuffer 宽高为 i32（spike 备忘）
            let bmp = SoftwareBitmap::CreateCopyFromBuffer(
                &buffer,
                BitmapPixelFormat::Bgra8,
                width,
                height,
            )
            .map_err(|e| format!("像素缓冲构造失败: {e}"))?;
            // IAsyncOperation → .get() 阻塞拍平（Agile 组件，命令线程可阻塞）
            let result = engine
                .RecognizeAsync(&bmp)
                .map_err(|e| e.to_string())?
                .get()
                .map_err(|e| format!("OCR 识别失败: {e}"))?;
            let view = result.Lines().map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            // IVectorView 迭代 Item = 元素本身（windows 0.61，非 Result 包装）
            for line in view {
                let text = line.Text().map_err(|e| e.to_string())?;
                let mut words = Vec::new();
                for word in line.Words().map_err(|e| e.to_string())? {
                    let wt = word.Text().map_err(|e| e.to_string())?;
                    // 中文逐字、英文逐词（spike H3）；BoundingRect 像素 f32
                    let r = word.BoundingRect().map_err(|e| e.to_string())?;
                    words.push(OcrWordOut {
                        text: wt.to_string(),
                        x: r.X as i32,
                        y: r.Y as i32,
                        w: r.Width as i32,
                        h: r.Height as i32,
                    });
                }
                // 行级 rect = words 并集（二期行级叠加；空 words = 全 0 → 前端跳过）
                let mut rect = (0i32, 0i32, 0i32, 0i32);
                if !words.is_empty() {
                    let x1 = words.iter().map(|w| w.x).min().unwrap_or(0);
                    let y1 = words.iter().map(|w| w.y).min().unwrap_or(0);
                    let x2 = words.iter().map(|w| w.x + w.w).max().unwrap_or(0);
                    let y2 = words.iter().map(|w| w.y + w.h).max().unwrap_or(0);
                    rect = (x1, y1, x2 - x1, y2 - y1);
                }
                out.push(OcrLineOut {
                    text: text.to_string(),
                    x: rect.0,
                    y: rect.1,
                    w: rect.2,
                    h: rect.3,
                    words,
                });
            }
            out
        };
        tracing::debug!(target: "ocr", lines = lines.len(), ms = t0.elapsed().as_millis() as u64, "识别完成");
        Ok(lines)
    }

    fn available_languages(&self) -> Vec<String> {
        use windows::Media::Ocr::OcrEngine;
        let mut out = Vec::new();
        if let Ok(langs) = OcrEngine::AvailableRecognizerLanguages() {
            for l in langs {
                if let Ok(tag) = l.LanguageTag() {
                    out.push(tag.to_string());
                }
            }
        }
        out
    }
}

/// 全局 provider（单实现；trait 为引擎切换对冲留位）
fn provider() -> &'static dyn OcrProvider {
    static PROVIDER: WinRtOcr = WinRtOcr;
    &PROVIDER
}

// ── 截屏（GDI，spike Step 3 链路）──

/// 虚拟屏物理 bounds（x, y, w, h；多显示器并集。per-monitor DPI aware 进程中
/// GetSystemMetrics 返回物理像素）。仅作鼠标位置取屏失败时的兜底。
fn virtual_bounds() -> (i32, i32, i32, i32) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

/// **鼠标所在显示器**的整屏物理 bounds（微信截图式：覆盖层只铺当前屏）。
/// 多屏铺虚拟屏整面的教训（实测）：提示条落在窗口中心 = 多屏交界处，
/// 用户主屏看不到任何反馈。单屏窗口同时规避混合 DPI 的 scale 混淆。
/// 取鼠标失败回退虚拟屏并集。
fn monitor_bounds_at_cursor() -> (i32, i32, i32, i32) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    unsafe {
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt).is_ok() {
            let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
            if !hmon.is_invalid() {
                let mut info = MONITORINFO::default();
                info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
                if GetMonitorInfoW(hmon, &mut info).as_bool() {
                    let rc = info.rcMonitor;
                    return (rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top);
                }
            }
        }
    }
    virtual_bounds()
}

/// 抓屏幕区域 → GetDIBits 取 BGRA top-down（spike H4 验证链路）。
/// `scale` > 1 时用 StretchBlt(HALFTONE) **放大后再取像素**——Windows OCR 对小字号
/// 识别弱（实测密集中文漏字/错字），2x 上采样显著提升；返回 (像素, 放大后宽, 高)。
fn capture_region(x: i32, y: i32, w: i32, h: i32, scale: u32) -> Result<(Vec<u8>, i32, i32), String> {
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER,
        DIB_RGB_COLORS, HALFTONE, SRCCOPY, HGDIOBJ,
    };
    let dw = w * scale as i32;
    let dh = h * scale as i32;
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("取屏幕 DC 失败".into());
        }
        let mem = CreateCompatibleDC(Some(screen));
        let hbm = CreateCompatibleBitmap(screen, dw, dh);
        let old = SelectObject(mem, HGDIOBJ(hbm.0));
        let blt_ok = if scale > 1 {
            // HALFTONE 平滑插值（放大文字边缘）；该模式要求重设画刷原点
            let _ = SetStretchBltMode(mem, HALFTONE);
            let _ = windows::Win32::Graphics::Gdi::SetBrushOrgEx(mem, 0, 0, None);
            StretchBlt(mem, 0, 0, dw, dh, Some(screen), x, y, w, h, SRCCOPY).as_bool()
        } else {
            BitBlt(mem, 0, 0, w, h, Some(screen), x, y, SRCCOPY).is_ok()
        };

        // top-down = biHeight 取负（spike 实测坑）
        let mut hdr: BITMAPINFOHEADER = std::mem::zeroed();
        hdr.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        hdr.biWidth = dw;
        hdr.biHeight = -dh;
        hdr.biPlanes = 1;
        hdr.biBitCount = 32;
        let mut bmi = BITMAPINFO {
            bmiHeader: hdr,
            bmiColors: [Default::default()],
        };
        let mut buf = vec![0u8; (dw as usize) * (dh as usize) * 4];
        let lines = GetDIBits(
            mem,
            hbm,
            0,
            dh as u32,
            Some(buf.as_mut_ptr().cast::<std::ffi::c_void>()),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        SelectObject(mem, old);
        let _ = DeleteObject(HGDIOBJ(hbm.0));
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);

        if !blt_ok || lines == 0 {
            return Err("屏幕区域截取失败".into());
        }
        Ok((buf, dw, dh))
    }
}

/// BGRA 像素 → PNG dataURL（WinRT BitmapEncoder，系统内置零新依赖）。
/// 失败仅告警返回空串——快照是体验增强，不阻断识别翻译主线。
fn encode_png_dataurl(bgra: &[u8], w: i32, h: i32) -> String {
    use base64::Engine as _;
    let out = (|| -> Result<String, String> {
        use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapEncoder, BitmapPixelFormat};
        use windows::Storage::Streams::{DataReader, InMemoryRandomAccessStream};
        // WinRT 方法在 windows 0.61 为 safe（同 recognize）
        {
            let stream = InMemoryRandomAccessStream::new().map_err(|e| e.to_string())?;
            let encoder = BitmapEncoder::CreateAsync(
                BitmapEncoder::PngEncoderId().map_err(|e| e.to_string())?,
                &stream,
            )
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;
            encoder
                .SetPixelData(
                    BitmapPixelFormat::Bgra8,
                    BitmapAlphaMode::Ignore,
                    w as u32,
                    h as u32,
                    96.0,
                    96.0,
                    bgra,
                )
                .map_err(|e| e.to_string())?;
            encoder
                .FlushAsync()
                .map_err(|e| e.to_string())?
                .get()
                .map_err(|e| e.to_string())?;
            let size = stream.Size().map_err(|e| e.to_string())? as u32;
            let reader = DataReader::CreateDataReader(&stream).map_err(|e| e.to_string())?;
            reader
                .LoadAsync(size)
                .map_err(|e| e.to_string())?
                .get()
                .map_err(|e| e.to_string())?;
            let mut bytes = vec![0u8; size as usize];
            reader.ReadBytes(&mut bytes).map_err(|e| e.to_string())?;
            Ok(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ))
        }
    })();
    match out {
        Ok(url) => url,
        Err(e) => {
            tracing::warn!(target: "ocr", error = %e, "快照 PNG 编码失败（降级无快照）");
            String::new()
        }
    }
}

// ── 覆盖层流程 ──

/// 启动截图框选（全局快捷键 / 托盘菜单）：覆盖层铺满**鼠标所在显示器**物理
/// bounds → show + 置前 → 通知前端进选框态。OCR 是独立显式入口，不走 selection
/// 触发模式门。**快捷键路径必须 Released 触发**（主键未松开时 show+focus =
/// WebView2 卡输入，见 tray.rs OcrLookup 注释）。
pub fn launch_capture(app: &AppHandle) {
    let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
        tracing::warn!(target: "ocr", "ocr-capture 窗口缺失");
        return;
    };
    let (mx, my, mw, mh) = monitor_bounds_at_cursor();
    if mw <= 0 || mh <= 0 {
        tracing::warn!(target: "ocr", "显示器尺寸异常 ({mx},{my},{mw},{mh})");
        return;
    }
    *CAPTURE_ORIGIN
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = (mx, my);
    let _ = win.set_position(Position::Physical(PhysicalPosition::new(mx, my)));
    let _ = win.set_size(PhysicalSize::new(mw as u32, mh as u32));
    let _ = win.set_always_on_top(true);
    // 鼠标 CSS 坐标（窗口定位后取 sf，覆盖层只铺该屏所以换算一致）：放大镜
    // 初始位置——唤起后未动鼠标也有放大镜（实测：只依赖 mousemove 会出现
    // 「直接拖框则整场无放大镜」的边界）
    let (css_mx, css_my) = {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let sf = win.scale_factor().unwrap_or(1.0);
        let mut pt = POINT { x: 0, y: 0 };
        let _ = unsafe { GetCursorPos(&mut pt) };
        ((pt.x as f64 - mx as f64) / sf, (pt.y as f64 - my as f64) / sf)
    };
    // show **前**截全屏（放大镜底图）：覆盖层未上屏 = 画面纯净。内联 ~10-30ms
    // 可接受（快捷键 → 模式出现无感）；失败置空，前端放大镜降级隐藏
    match capture_region(mx, my, mw, mh, 1) {
        Ok((bgra, w, h)) => {
            *SCREEN_SHOT.lock().unwrap_or_else(|e| e.into_inner()) =
                (encode_png_dataurl(&bgra, w, h), w, h, css_mx, css_my);
        }
        Err(e) => {
            tracing::warn!(target: "ocr", error = %e, "全屏底图截取失败（放大镜降级）");
            *SCREEN_SHOT.lock().unwrap_or_else(|e| e.into_inner()) =
                (String::new(), 0, 0, 0.0, 0.0);
        }
    }
    let _ = win.show();
    // **零焦点唤起**（⑪双层根因实测）：①快捷键必须
    // Released 触发（主键未释放时激活 = WebView2 接管不完整键盘状态而卡死，
    // 见 tray.rs OcrLookup）；②show 后立即抢焦点（force_focus 组合拳 /
    // set_focus）= 首帧 present 滞留、输入驱动才上屏的根因（baseline A/B：
    // 全移除后彻底正常，含主窗口最小化场景）。键盘焦点 = 拖框确认后由
    // `ocr_focus_capture` 延迟补上（此刻合成管线已被交互解锁，安全）；
    // select 态静止不交互的退出走右键（鼠标消息不依赖焦点）
    // 前端重置到选框态（重复唤起/上次残留的错误态）
    if let Err(e) = app.emit("ocr://capture-started", ()) {
        tracing::warn!(target: "ocr", error = %e, "capture-started 广播失败");
    }
    tracing::info!(target: "ocr", bounds = ?(mx, my, mw, mh), "截图框选已启动");
}

/// 上次截屏帧缓存（截屏/识别拆分的桥接 截图默认不自动
/// 识别）：截屏帧落此缓存，用户点工具条「识别文字」时对**同一帧像素**识别——
/// 不重截屏（背景画面可能已变：视频/动画，识别必须与钉住快照同源），也不走
/// PNG 编解码往返。单槽覆盖写；覆盖层 hide 即清（释放内存）。
struct CapturedFrame {
    /// BGRA 像素（2x 上采样判定后的同源帧——OCR 与快照编码共用）
    bgra: Vec<u8>,
    /// 图像实际尺寸（scale=2 时为选区物理尺寸 ×2；capture_region 同款 i32）
    dw: i32,
    dh: i32,
    /// 选区屏幕物理原点与尺寸（行坐标换算 + 结果 region 回填）
    sx: i32,
    sy: i32,
    pw: i32,
    ph: i32,
    /// 上采样倍率（行/词坐标 ÷scale 回物理）
    scale: u32,
}

static LAST_CAPTURE: Mutex<Option<CapturedFrame>> = Mutex::new(None);

/// 截屏公共前置（自动识别/只截屏两路径共用）：窗口缩放换算 + 尺寸钳制 + 2x
/// 小选区上采样判定 + BitBlt 截屏；成功帧写入 LAST_CAPTURE，返回选区物理
/// 几何 (sx, sy, pw, ph) 供结果回填。
///
/// **不隐藏覆盖层直接截屏**（实测）：定格选框只画外部
/// 阴影（box-shadow 框外），选框内是纯透屏像素——BitBlt 选区即真实屏幕。
/// 此前的 hide→60ms→show 序列是「第二个错位框/闪退/乱序失焦」一连串问题的根源。
fn prepare_capture(
    app: &AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(i32, i32, i32, i32), String> {
    let win = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("覆盖层窗口不存在")?;
    // 混合 DPI 多屏为已知限制（scale_factor 取窗口主屏）；主屏精确
    let sf = win
        .scale_factor()
        .map_err(|e| format!("取缩放系数失败: {e}"))?;
    let px = (x * sf).round() as i32;
    let py = (y * sf).round() as i32;
    let pw = (width * sf).round() as i32;
    let ph = (height * sf).round() as i32;
    if pw < 8 || ph < 8 {
        return Err("选区过小".into());
    }
    // MaxImageDimension 实测 10000（spike）；钳制防御异常值
    if pw > 10000 || ph > 10000 {
        return Err("选区过大".into());
    }
    // 小选区 2x 上采样（Windows OCR 对小字号弱，实测密集中文漏字/错字）——
    // 阈值 ~800×500 像素；放大后 ≤1.6M 像素，识别 ~50-80ms 仍远低于门限
    let scale: u32 = if (pw as i64) * (ph as i64) < 400_000 { 2 } else { 1 };

    let (ox, oy) = *CAPTURE_ORIGIN.lock().unwrap_or_else(|e| e.into_inner());
    let sx = ox + px;
    let sy = oy + py;
    let (bgra, dw, dh) = capture_region(sx, sy, pw, ph, scale)?;
    *LAST_CAPTURE.lock().unwrap_or_else(|e| e.into_inner()) = Some(CapturedFrame {
        bgra,
        dw,
        dh,
        sx,
        sy,
        pw,
        ph,
        scale,
    });
    Ok((sx, sy, pw, ph))
}

/// 对 LAST_CAPTURE 缓存帧跑识别管线（语言链容错 + 行/词坐标映射 + 快照编码）。
/// 识别与截屏拆分后的公共后段（自动识别 / 工具条手动识别共用）。识别路径重编码
/// 快照（~30ms 无感）保证返回结构与截屏路径一致——前端单一回填函数无分支。
fn recognize_frame(t0: std::time::Instant) -> Result<OcrRegionResult, String> {
    let guard = LAST_CAPTURE.lock().unwrap_or_else(|e| e.into_inner());
    let frame = guard.as_ref().ok_or("没有可识别的截图，请先框选区域")?;
    let (sx, sy, scale, dw, dh) = (frame.sx, frame.sy, frame.scale, frame.dw, frame.dh);
    // **OCR 语言全自动**（实测⑩语言判断本就该 OCR 引擎自己做；
    // 「源语言」是给 LLM 的翻译提示，不控制识别引擎）+ 容错链：
    // zh 优先（中英混合最准，spike 实测）→ en 补空 → 系统用户语言兜底。
    // 结果为空沿链补识别；缺包语言静默跳过；全候选失败时优先返回缺包
    // 错误（前端据此显示装语言包引导）。
    let mut langs: Vec<String> = vec!["zh-Hans-CN".to_string(), "en-US".to_string()];
    if let Some(tag) = provider()
        .available_languages()
        .into_iter()
        .find(|t| t != "zh-Hans-CN" && t != "en-US")
    {
        langs.push(tag);
    }
    let join_text = |ls: &[OcrLineOut]| -> String {
        ls.iter()
            .map(|l| l.text.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    };
    let mut chosen: Option<Vec<OcrLineOut>> = None;
    let mut first_err: Option<String> = None;
    for lang in &langs {
        match provider().recognize(lang, &frame.bgra, dw, dh) {
            Ok(l) => {
                // 首选语言的空结果兜底保留（全链空时按原语义返回空文本）
                if chosen.is_none() || l.iter().any(|x| !x.text.trim().is_empty()) {
                    let has_text = l.iter().any(|x| !x.text.trim().is_empty());
                    chosen = Some(l);
                    if has_text {
                        break;
                    }
                }
            }
            Err(e) => {
                first_err.get_or_insert(e);
            }
        }
    }
    let lines = match chosen {
        Some(l) => l,
        None => return Err(first_err.unwrap_or_else(|| "未识别到文字".into())),
    };
    let text = join_text(&lines);
    // 词/行坐标（放大图内）→ 屏幕物理（÷scale 回原尺寸 + 选区原点偏移）；
    // 行 rect 非空时略扩（1/+3/+2）防叠加色块盖不全字形
    let sc = scale as i32;
    let lines = lines
        .into_iter()
        .map(|mut l| {
            if l.w > 0 && l.h > 0 {
                l.x = l.x / sc + sx - 1;
                l.y = l.y / sc + sy - 1;
                l.w = l.w / sc + 3;
                l.h = l.h / sc + 2;
            }
            for w in &mut l.words {
                w.x = w.x / sc + sx;
                w.y = w.y / sc + sy;
                w.w /= sc;
                w.h /= sc;
            }
            l
        })
        .collect();
    Ok(OcrRegionResult {
        lines,
        text,
        snapshot: encode_png_dataurl(&frame.bgra, dw, dh),
        region_x: sx,
        region_y: sy,
        region_w: frame.pw,
        region_h: frame.ph,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

/// 框选截屏（前端拖框松开后调用；**只截屏不识别**—— 默认
/// 路径）：快照 PNG 返回，文本/行为空；截屏帧进 LAST_CAPTURE 等工具条
/// 「识别文字」（ocr_recognize_captured）或 AI 识别消费。同步返回（编码数十 ms）。
#[tauri::command]
pub fn ocr_capture_region(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<OcrRegionResult, String> {
    let t0 = std::time::Instant::now();
    let (sx, sy, pw, ph) = prepare_capture(&app, x, y, width, height)?;
    let guard = LAST_CAPTURE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(frame) = guard.as_ref() else {
        return Err("截屏缓存异常".into());
    };
    let snapshot = encode_png_dataurl(&frame.bgra, frame.dw, frame.dh);
    drop(guard);
    tracing::info!(target: "ocr", ms = t0.elapsed().as_millis() as u64, "截图完成（未识别）");
    Ok(OcrRegionResult {
        lines: Vec::new(),
        text: String::new(),
        snapshot,
        region_x: sx,
        region_y: sy,
        region_w: pw,
        region_h: ph,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

/// 对**上次截屏帧**识别（工具条「识别文字」按钮）：见 LAST_CAPTURE/recognize_frame。
#[tauri::command]
pub fn ocr_recognize_captured() -> Result<OcrRegionResult, String> {
    let t0 = std::time::Instant::now();
    match recognize_frame(t0) {
        Ok(r) => {
            tracing::info!(target: "ocr", ms = r.elapsed_ms, lines = r.lines.len(), chars = r.text.chars().count(), "OCR 完成（手动）");
            Ok(r)
        }
        Err(e) => {
            tracing::warn!(target: "ocr", error = %e, "OCR 识别失败（手动）");
            Err(e)
        }
    }
}

/// 框选区域识别（**自动识别路径**，设置开启「截图后自动识别」时前端调用）：
/// 截屏 + 识别一体（语义同 拆分前原命令）。
///
/// **不隐藏覆盖层**：定格选框只有外部阴影，选框内是纯透屏像素，BitBlt 选区即
/// 真实屏幕（旧 hide→show 序列是错位框/闪退/乱序失焦的根源，见 实测⑦）。
#[tauri::command]
pub fn ocr_recognize_region(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<OcrRegionResult, String> {
    let t0 = std::time::Instant::now();
    prepare_capture(&app, x, y, width, height)?;
    match recognize_frame(t0) {
        Ok(r) => {
            tracing::info!(target: "ocr", ms = r.elapsed_ms, lines = r.lines.len(), chars = r.text.chars().count(), "OCR 完成");
            Ok(r)
        }
        Err(e) => {
            tracing::warn!(target: "ocr", error = %e, "OCR 识别失败");
            Err(e)
        }
    }
}

/// OCR 结果打开动作面板/查词（点词 text=词 + action_id=dict；全文动作
/// action_id=translate/explain/...）：隐藏覆盖层 → 复用 selection 面板管线
/// （PanelTextEvent 带显式文本，不依赖划词 last_text）。
#[tauri::command]
pub fn ocr_open_panel(
    app: AppHandle,
    text: String,
    action_id: Option<String>,
    x: i32,
    y: i32,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("内容为空".into());
    }
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        let _ = win.hide();
    }
    crate::selection::open_panel_with_text(
        &app,
        x,
        y,
        action_id.unwrap_or_else(|| "dict".to_string()),
        text,
        None,
    );
    Ok(())
}

/// 系统可用 OCR 语言标签（设置页下拉；走同一 provider 抽象）
#[tauri::command]
pub fn ocr_languages() -> Vec<String> {
    provider().available_languages()
}

/// 全屏底图 + 鼠标初始 CSS 坐标（前端放大镜用；launch_capture 写入）
#[tauri::command]
pub fn ocr_screen_snapshot() -> (String, i32, i32, f64, f64) {
    SCREEN_SHOT.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// 拖框确认后补键盘焦点（⑪折中）：select 态零焦点（show 后立即抢
/// 焦点 = 首帧 present 滞留的根因之一，baseline A/B 实测）；此刻合成管线
/// 已被交互解锁，set_focus 安全，此后 Esc 等键盘可用。
#[tauri::command]
pub fn ocr_focus_capture(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("覆盖层窗口不存在")?;
    let _ = win.set_focus();
    Ok(())
}

/// 隐藏覆盖层（Esc / 右键取消 / 前端完成态关闭）；顺带清截屏帧缓存
/// （默认不识别路径下 LAST_CAPTURE 驻留像素——hide 即无消费可能，释放内存）
#[tauri::command]
pub fn ocr_hide_capture(app: AppHandle) {
    *LAST_CAPTURE.lock().unwrap_or_else(|e| e.into_inner()) = None;
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        let _ = win.hide();
    }
}

/// 覆盖层失焦收起（去抖 + 复查，`selection::hide_panel_on_blur` 同款模式）：
/// `ocr_recognize_region` 的 hide→60ms→show 序列会产生**乱序 Focused(false)**——
/// hide 时失焦事件入队，show+set_focus 后才被处理，若立即隐藏会把刚 show 回的
/// 覆盖层误杀（实测「松开选框即闪退」的根因）。250ms 后复查 is_focused，
/// 重新获焦（识别序列 show 回）则取消收起；真失焦（用户点了其他应用）照常收起。
pub fn hide_capture_on_blur(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
            return;
        };
        match win.is_focused() {
            Ok(true) => {}
            _ => {
                let _ = win.hide();
            }
        }
    });
}
