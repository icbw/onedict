//! 划词进程过滤（pickdict SelectionService.filter 语义基线）。
//!
//! 三种模式（偏好 `selection_filter_mode`）：
//! - `default`   仅预定义黑名单生效（截图/Office/设计/CAD 等无需划词、拖选语义
//!   冲突的程序默认不触发浮标）
//! - `whitelist` 仅用户列表内程序触发
//! - `blacklist` 用户列表 ∪ 预定义黑名单（仅触发方式 = selected 时并入预定义——
//!   ctrlkey/shortcut 是用户显式动作，尊重用户意图不做静默拦截）
//!
//! 匹配语义（pickdict 基线）：进程名与列表项都小写后**子串**包含判定；
//! 取不到进程名 → 放行（不因查询失败丢可用性）。
//!
//! 配置缓存：worker/钩子回调读本模块 static（Mutex 短临界区），不每次 clone
//! 整个 Preferences；写方 = `prefs_set_selection_capture` 命令与 `restore_from_prefs`。

use std::sync::Mutex;

/// 过滤模式（小写字符串，与偏好值同形）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterMode {
    Default,
    Whitelist,
    Blacklist,
}

impl FilterMode {
    pub fn parse(s: &str) -> Self {
        match s {
            "whitelist" => Self::Whitelist,
            "blacklist" => Self::Blacklist,
            _ => Self::Default,
        }
    }
}

/// 预定义黑名单（Windows 进程名，小写子串匹配）。
/// 事实性数据清单：这些程序以拖选/双击为交互主语义（截图框选、表格选格、
/// 画布拖拽），划词浮标会干扰操作且文本捕获无意义。对齐 pickdict 行为基线。
pub const PREDEFINED_BLACKLIST: &[&str] = &[
    // 资源管理器 / 桌面
    "explorer.exe",
    // 截图工具（框选即截屏）
    "snipaste.exe",
    "pixpin.exe",
    "sharex.exe",
    // Office 表格/演示（拖选 = 选格/选对象）
    "excel.exe",
    "powerpnt.exe",
    // 设计/图像（拖选 = 框选画布）
    "photoshop.exe",
    "illustrator.exe",
    // 视频/音频/3D 编辑（拖选 = 时间线/视图操作）
    "adobe premiere pro.exe",
    "afterfx.exe",
    "adobe audition.exe",
    "blender.exe",
    "3dsmax.exe",
    "maya.exe",
    // CAD（拖选 = 图元框选）
    "acad.exe",
    "sldworks.exe",
    // 远程桌面（跨机会话内划词不可达）
    "mstsc.exe",
];

/// 过滤判定（纯函数，可测）。
///
/// - `program`: 前台进程名（None = 取不到，放行）
/// - `merge_predefined`: 黑名单模式下是否并入预定义清单（触发方式 = selected 时 true）
pub fn allows(
    mode: FilterMode,
    user_list: &[String],
    program: Option<&str>,
    merge_predefined: bool,
) -> bool {
    let Some(program) = program else {
        return true;
    };
    let program = program.to_lowercase();
    let in_user = user_list.iter().any(|item| program.contains(item.as_str()));
    match mode {
        FilterMode::Whitelist => in_user,
        FilterMode::Blacklist => {
            let in_predefined = merge_predefined
                && PREDEFINED_BLACKLIST.iter().any(|item| program.contains(item));
            !in_user && !in_predefined
        }
        FilterMode::Default => {
            !PREDEFINED_BLACKLIST.iter().any(|item| program.contains(item))
        }
    }
}

/// 生效配置快照（static 缓存；读方 = capture worker / hook 回调，写方 = 偏好命令）
struct FilterConfig {
    mode: FilterMode,
    list: Vec<String>,
    /// 触发方式是否 selected（黑名单模式并入预定义清单的依据）
    trigger_selected: bool,
}

static CONFIG: Mutex<FilterConfig> = Mutex::new(FilterConfig {
    mode: FilterMode::Default,
    list: Vec::new(),
    trigger_selected: true,
});

/// 偏好 → 缓存同步（prefs_set_selection_capture / restore_from_prefs 调用）
pub fn apply(trigger: &str, filter_mode: &str, filter_list: &[String]) {
    let mut cfg = CONFIG.lock().unwrap_or_else(|e| e.into_inner());
    cfg.mode = FilterMode::parse(filter_mode);
    cfg.list = filter_list.iter().map(|s| s.to_lowercase()).collect();
    cfg.trigger_selected = trigger == "selected";
}

/// 当前配置下 `program` 是否允许触发划词
pub fn allowed(program: Option<&str>) -> bool {
    let cfg = CONFIG.lock().unwrap_or_else(|e| e.into_inner());
    allows(cfg.mode, &cfg.list, program, cfg.trigger_selected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn default_mode_blocks_predefined_only() {
        assert!(!allows(FilterMode::Default, &[], Some("Snipaste.exe"), false));
        assert!(!allows(FilterMode::Default, &[], Some("explorer.exe"), true));
        assert!(allows(FilterMode::Default, &[], Some("notepad.exe"), false));
        assert!(allows(FilterMode::Default, &list(&["chrome.exe"]), Some("msedge.exe"), false));
    }

    #[test]
    fn whitelist_only_allows_listed() {
        let l = list(&["code.exe", "chrome"]);
        assert!(allows(FilterMode::Whitelist, &l, Some("Code.exe"), false));
        // 子串匹配：chrome 命中 chrome.exe / msedge 不命中
        assert!(allows(FilterMode::Whitelist, &l, Some("chrome.exe"), false));
        assert!(!allows(FilterMode::Whitelist, &l, Some("msedge.exe"), false));
    }

    #[test]
    fn blacklist_merges_predefined_by_trigger_mode() {
        let l = list(&["notepad.exe"]);
        // selected 触发：预定义并入
        assert!(!allows(FilterMode::Blacklist, &l, Some("excel.exe"), true));
        assert!(!allows(FilterMode::Blacklist, &l, Some("notepad.exe"), true));
        assert!(allows(FilterMode::Blacklist, &l, Some("word.exe"), true));
        // ctrlkey/shortcut 触发：不并入（用户显式动作不被静默拦截）
        assert!(allows(FilterMode::Blacklist, &l, Some("excel.exe"), false));
    }

    #[test]
    fn unknown_program_always_allowed() {
        assert!(allows(FilterMode::Default, &[], None, false));
        assert!(allows(FilterMode::Blacklist, &list(&["a.exe"]), None, true));
        // whitelist 模式取不到进程名也放行（不因查询失败丢可用性）
        assert!(allows(FilterMode::Whitelist, &list(&["a.exe"]), None, false));
    }

    #[test]
    fn case_insensitive_substring() {
        let l = list(&["sublime"]);
        assert!(allows(FilterMode::Whitelist, &l, Some("SUBLIME_TEXT.EXE"), false));
        assert!(!allows(FilterMode::Default, &[], Some("EXPLORER.EXE"), false));
    }

    #[test]
    fn mode_parse_falls_back_to_default() {
        assert_eq!(FilterMode::parse("whitelist"), FilterMode::Whitelist);
        assert_eq!(FilterMode::parse("blacklist"), FilterMode::Blacklist);
        assert_eq!(FilterMode::parse(""), FilterMode::Default);
        assert_eq!(FilterMode::parse("bogus"), FilterMode::Default);
    }
}
