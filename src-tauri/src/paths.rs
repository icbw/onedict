//! 数据目录分流（安装包测试）：dev 与安装版共用 identifier →
//! app_data_dir 相同，不隔离则安装版首启即读到 dev 期的偏好/查词历史/生词本/
//! 词典缓存（已被实测踩中）。约定：
//!   release（安装包） = app_data_dir            （%APPDATA%\com.onedict.app）
//!   dev（pnpm tauri dev） = app_data_dir\dev    （同一 identifier 下的隔离子目录）
//! 判定用 cargo profile（debug_assertions）而非运行时参数——release 包绝不带 dev 标记。
//!
//! 全部落盘数据（logs / preferences / vocabulary / review-log / history /
//! translate-history / dict-cache / 备份恢复写回）一律经 data_root 取根，
//! 禁止各处直呼 app.path().app_data_dir()（新增落盘点先查本文件）。
//!
//! 用户数据不放安装目录（有意设计）：Program Files 普通权限不可写；NSIS 覆盖
//! 安装/卸载会清安装目录——数据与程序分离才能保证「更新不覆盖用户记录、
//! 卸载重装数据仍在」。

use tauri::Manager;

/// 便携模式标记文件名：与 onedict.exe 同目录放置此空文件 → 数据全部落
/// exe 旁 Data\（随安装目录整体迁移，拷走文件夹 = 带走全部数据）。
/// NSIS 卸载器只删安装清单内文件（installer.nsi：逐文件 Delete + 非空
/// RMDir 失败），自建 Data\ 与标记文件不受升级/卸载影响。
pub const PORTABLE_MARKER: &str = "onedict.portable";

/// 数据位置指针文件名：位于**默认数据根**下（标准模式 = app_data_dir，
/// dev = app_data_dir\dev；便携模式不读——数据已在 exe 旁无需自定义）。
/// 内容一行 = 实际数据目录绝对路径；缺失/空 = 用默认根。
/// 设置页「迁移数据」写此文件（data_migrate），不进偏好（偏好本身在数据目录里，
/// 存偏好会鸡生蛋）。文件分类见 data.rs：用户记录 JSON 随目录迁移，
/// dict-cache 可再生随迁省重解析，logs 不迁。
pub const DATA_ROOT_POINTER: &str = "data-root.txt";

/// 应用标识符（= tauri.conf.json 的 `identifier`，**两处须同步修改**）：
/// 早期路径解析 `data_root_early` 在 AppHandle 可用之前，需要按同一规则拼出
/// app_data_dir 的等价路径（Windows = `%APPDATA%\<identifier>`）。
pub const APP_IDENTIFIER: &str = "com.onedict.app";

/// 便携模式数据根 = exe 同目录 `Data\`（无标记文件 → None）
fn portable_root() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    dir.join(PORTABLE_MARKER).is_file().then(|| dir.join("Data"))
}

/// 标准模式数据根：dev/release 分流（隔离；指针文件互不可见）+ 自定义位置指针
/// （设置页迁移写入：指针非空且目标存在 → 生效）
fn pick_std_root(base: &std::path::Path) -> std::path::PathBuf {
    let std_root = if cfg!(debug_assertions) {
        base.join("dev")
    } else {
        base.to_path_buf()
    };
    if let Ok(text) = std::fs::read_to_string(std_root.join(DATA_ROOT_POINTER)) {
        let custom = text.trim();
        if !custom.is_empty() && std::path::Path::new(custom).is_dir() {
            return std::path::PathBuf::from(custom);
        }
    }
    std_root
}

/// 早期数据根解析（**不依赖 AppHandle**）：须在窗口创建前可用——tauri.conf.json 的
/// `app.windows` 在 setup 之前创建并加载页面，其前端可能早于 setup 内读取偏好。
/// 规则与 data_root 完全一致。
pub fn data_root_early() -> Result<std::path::PathBuf, String> {
    if let Some(dir) = portable_root() {
        return Ok(dir);
    }
    let base = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .ok_or("APPDATA 环境变量缺失")?
        .join(APP_IDENTIFIER);
    Ok(pick_std_root(&base))
}

pub fn data_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    // 便携模式优先（不管 dev/release）：exe 同目录有标记 → exe_dir\Data。
    // Program Files 等系统目录普通权限不可写——便携用户应装在自选可写目录。
    if let Some(dir) = portable_root() {
        return Ok(dir);
    }
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取 app_data_dir 失败: {e}"))?;
    Ok(pick_std_root(&base))
}

/// 数据位置元信息（设置页展示）：portable = 便携标记生效；custom = 指针文件生效
pub struct DataLocation {
    pub dir: std::path::PathBuf,
    pub portable: bool,
    pub custom: bool,
}

/// 词典索引缓存目录（应用依赖，固定安装目录 `dict-cache\`，惰性创建——本函数
/// 只算路径不建目录，创建时机见 dictionary::Registry::ensure_cache_dir）
pub fn cache_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            return dir.join("dict-cache");
        }
    }
    // exe 路径不可得的极端兜底：退数据根（不可写时惰性创建自然失败降级）
    data_root(app).unwrap_or_else(|_| std::path::PathBuf::from(".")).join("dict-cache")
}

pub fn data_location(app: &tauri::AppHandle) -> Result<DataLocation, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if dir.join(PORTABLE_MARKER).is_file() {
                return Ok(DataLocation {
                    dir: dir.join("Data"),
                    portable: true,
                    custom: false,
                });
            }
        }
    }
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取 app_data_dir 失败: {e}"))?;
    let std_root = if cfg!(debug_assertions) {
        base.join("dev")
    } else {
        base
    };
    let ptr = std_root.join(DATA_ROOT_POINTER);
    let custom = std::fs::read_to_string(&ptr)
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false);
    Ok(DataLocation {
        dir: data_root(app)?,
        portable: false,
        custom,
    })
}
