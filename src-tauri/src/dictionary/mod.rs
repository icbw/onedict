//! 词典模块：opendict-rs（MIT）。最小应用侧闭环：
//!   dictionary_list      扫描词典根目录（test/dicts，dev 期约定；偏好持久化留）
//!   dictionary_load      打开词典目录（opendict open(dir) 自动聚合多 MDD）
//!   dictionary_lookup    查词：@@@LINK 重定向（pickdict resolveEntry 语义，剥尾 \0\r\n）
//!                        + 词条内相对资源 dataURL 内联（pickdict dictEntry 管线的 Rust 版；
//!                        顺序 = 各 MDD → 词典目录散装文件，pickdict #16/#21 结论）
//!   dictionary_associate 输入联想（search_prefix）
//!
//! sound:// 与 entry:// 语义留给前端（iframe 内点击委托 postMessage）；
//! 音频播放（.spx 解码）由前端负责，此处不改写不播放。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::SystemTime;

use base64::Engine as _;
use opendict::mdict::{MdictDictionary, StyleSheetEntry};
use opendict::Dictionary;
use regex::Regex;
use serde::Serialize;

/// 资源扩展白名单（**不含 js**——脚本非词典内容刚需，且内联成 data: 后会在帧内执行，
/// 第三方 mdx 词条可借此注入脚本；剔除后 script 引用留在 HTML 内成为死链，无害）
const RESOURCE_EXTS: &str = r"(?:css|png|jpe?g|gif|svg|woff2?|ttf|eot)";

/// 移除词典（设置页词典列表删除按钮 删除三语义）：
/// delete_files=false 仅删除引用（词典文件保留在磁盘，扫描不再发现；
/// removed_dicts 永久忽略，换词典根目录时清空恢复）；true 额外删除词典
/// 目录（不可恢复，前端红色按钮 + 二次确认）。只收 id 不收路径，目录恒为
/// root 下以 id 命名的子目录（id 白名单校验防路径逃逸）。
#[tauri::command]
pub fn dictionary_remove(
    dict_id: String,
    delete_files: bool,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    if dict_id.is_empty()
        || dict_id.contains('/')
        || dict_id.contains('\\')
        || dict_id.contains("..")
    {
        return Err(format!("非法词典 id: {dict_id}"));
    }
    let registry = app.state::<Registry>();
    let root = registry.ensure_root()?;
    let dir = root.join(&dict_id);
    if delete_files {
        if !dir.is_dir() {
            return Err(format!("词典目录不存在: {}", dir.display()));
        }
        std::fs::remove_dir_all(&dir).map_err(|e| format!("删除词典目录失败: {e}"))?;
        tracing::warn!(target: "dictionary", dict = %dict_id, dir = %dir.display(), "词典目录已删除（不可恢复）");
    }
    crate::prefs::add_removed_dict(&dict_id);
    registry.reset();
    if let Err(e) = app.emit("dictionary-changed", ()) {
        tracing::warn!(target: "dictionary", error = %e, "移除词典后广播失败");
    }
    tracing::info!(target: "dictionary", dict = %dict_id, delete_files, "词典已移除");
    Ok(())
}

/// 词典注册表：dictId → 已打开实例。
/// inner 用 RwLock：查词/联想/发音全是 `&self` 读操作，读读并发
/// ——原单 Mutex 下全部词典共用一把锁，查词+资源内联串行化，associate 随输入
/// 逐字符调用是热点。
pub struct Registry {
    inner: RwLock<HashMap<String, MdictDictionary>>,
    root: Mutex<Option<PathBuf>>,
    /// 词典索引磁盘缓存目录（vendor opendict 本地改造；惰性创建于安装目录
    /// dict-cache\，见 ensure_cache_dir—— 依赖数据目录）
    cache_dir: Mutex<Option<PathBuf>>,
    /// 词典目录扫描缓存：每次 lookup/associate 入口 is_enabled →
    /// merged_items 原本都做全目录 read_dir。按 root + mtime 失效（新增/删除词典
    /// 目录 mtime 变化自然失效）；启停/排序在偏好侧，不进此缓存。
    scan_cache: Mutex<Option<(PathBuf, Option<SystemTime>, Vec<String>)>>,
}

impl Registry {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
            root: Mutex::new(None),
            cache_dir: Mutex::new(None),
            scan_cache: Mutex::new(None),
        }
    }

    /// 词典索引缓存目录（应用依赖，可再生）：安装目录
    /// `dict-cache\`，**惰性创建**——首次词典打开时才建（无词典无缓存，启动
    /// 绝不预建目录）。创建失败（Program Files 等系统位置）→ `allow_elevate`
    /// 时弹 UAC 提权（mkdir + icacls 放开 Users 修改权）；用户取消/失败 →
    /// None（本会话冷解析，不影响功能，下次词典打开再试）。缓存文件按源文件
    /// 指纹失效，损坏自动重建。
    /// warmup 后台预热传 false（启动后绝不弹窗），用户真实查询路径传 true。
    fn ensure_cache_dir(&self, allow_elevate: bool) -> Option<PathBuf> {
        let mut guard = self.cache_dir.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(d) = guard.as_ref() {
            return Some(d.clone());
        }
        let dir = std::env::current_exe()
            .ok()?
            .parent()?
            .join("dict-cache");
        if std::fs::create_dir_all(&dir).is_ok() {
            *guard = Some(dir.clone());
            return Some(dir);
        }
        if allow_elevate && crate::fsutil::create_dir_elevated(&dir) {
            *guard = Some(dir.clone());
            return Some(dir);
        }
        tracing::warn!(
            target: "dictionary", dir = %dir.display(), allow_elevate,
            "缓存目录不可用（本会话无索引缓存，冷解析）"
        );
        None
    }

    /// 词典根目录：偏好里的 dict_root 优先（设置页写入），无/失效则 dev 探测
    /// （cwd = src-tauri 及其父链向上找 test/dicts）；打包后无偏好且探测不到则报错
    fn ensure_root(&self) -> Result<PathBuf, String> {
        let mut root = self.root.lock().map_err(|_| "锁中毒")?;
        if let Some(p) = root.as_ref() {
            return Ok(p.clone());
        }
        if let Some(configured) = crate::prefs::dict_root() {
            let cand = PathBuf::from(&configured);
            if cand.is_dir() {
                tracing::info!(target: "dictionary", root = %cand.display(), "词典根目录就绪（偏好）");
                *root = Some(cand.clone());
                return Ok(cand);
            }
            tracing::warn!(target: "dictionary", configured = %configured, "偏好词典根目录不存在，回退自动探测");
        }
        // 安装目录 \dicts 约定：用户把词典文件拷进应用目录
        // 的免配置位置——随 app 走（属应用依赖，非用户数据）；优先级在偏好之后
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let cand = dir.join("dicts");
                if cand.is_dir() {
                    tracing::info!(target: "dictionary", root = %cand.display(), "词典根目录就绪（安装目录 dicts）");
                    *root = Some(cand.clone());
                    return Ok(cand);
                }
            }
        }
        // dev 期便利：cwd（src-tauri）父链向上找 test/dicts。仅 debug profile——
        // 安装包绝不依赖仓库/测试目录布局（安装包测试）
        if cfg!(debug_assertions) {
            let cwd = std::env::current_dir().map_err(|e| format!("取 cwd 失败: {e}"))?;
            let mut cur = Some(cwd.as_path());
            while let Some(dir) = cur {
                let cand = dir.join("test").join("dicts");
                if cand.is_dir() {
                    tracing::info!(target: "dictionary", root = %cand.display(), "词典根目录就绪");
                    *root = Some(cand.clone());
                    return Ok(cand);
                }
                cur = dir.parent();
            }
        }
        Err("未找到词典目录：请在「设置 → 词典 → 词典目录」选择存放词典的文件夹（每个含 .mdx 的子目录视为一部词典）".into())
    }

    fn with_dict<T>(
        &self,
        dict_id: &str,
        f: impl FnOnce(&MdictDictionary) -> Result<T, String>,
    ) -> Result<T, String> {
        {
            // 读锁：命中即查（读读并发，associate/lookup/sound 互不阻塞）
            let map = self.inner.read().map_err(|_| "锁中毒")?;
            if let Some(d) = map.get(dict_id) {
                return f(d);
            }
        }
        let root = self.ensure_root()?;
        let dir = root.join(dict_id);
        if !dir.is_dir() {
            return Err(format!("词典目录不存在: {}", dir.display()));
        }
        // 用户真实查询路径：允许 UAC 提权建缓存目录（惰性，仅首次）
        let cache_dir = self.ensure_cache_dir(true);
        let t = std::time::Instant::now();
        // 锁外打开（索引解析 CPU 密集，预热/首查不阻塞其他词典查询）
        let dict = MdictDictionary::open_with_cache(dir.as_path(), cache_dir.as_deref())
            .map_err(|e| format!("打开词典失败: {e}"))?;
        let from_cache = cache_dir.is_some();
        tracing::info!(target: "dictionary", dict = %dict_id, ms = t.elapsed().as_millis() as u64, from_cache, "词典已打开");
        let mut map = self.inner.write().map_err(|_| "锁中毒")?;
        // 双检：并发 open 同一词典时以先写入者为准（避免重复解析互相覆盖）
        if let Some(d) = map.get(dict_id) {
            return f(d);
        }
        map.insert(dict_id.to_string(), dict);
        let d = map.get(dict_id).expect("just inserted");
        f(d)
    }

    fn dict_dir(&self, dict_id: &str) -> Result<PathBuf, String> {
        Ok(self.ensure_root()?.join(dict_id))
    }

    /// 词典（首个 .mdx）的索引缓存是否已建（指纹一致），供预热分级决策
    fn has_cached_index(&self, dict_id: &str) -> bool {
        let cache_dir = self
            .cache_dir
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let Some(cache_dir) = cache_dir else {
            return false;
        };
        let Ok(root) = self.ensure_root() else {
            return false;
        };
        MdictDictionary::cached_index_path(&root.join(dict_id), &cache_dir)
            .map(|p| p.exists())
            .unwrap_or(false)
    }

    /// 词典目录扫描（带缓存）：root + mtime 匹配即返回缓存，
    /// 否则 read_dir 全目录扫描后回填。缓存只含扫描到的目录 id 集——
    /// 启停/排序在偏好（dict_items）里，读取仍实时。
    fn scan_dict_ids_cached(&self, root: &Path) -> Result<Vec<String>, String> {
        let mtime = std::fs::metadata(root).and_then(|m| m.modified()).ok();
        let mut cache = self.scan_cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((cached_root, cached_mtime, ids)) = cache.as_ref() {
            if cached_root == root && *cached_mtime == mtime {
                return Ok(ids.clone());
            }
        }
        let ids = scan_dict_ids(root)?;
        *cache = Some((root.to_path_buf(), mtime, ids.clone()));
        Ok(ids)
    }

    /// 词典管理合并视图：扫描目录 ∪ 偏好配置——偏好序优先，新发现词典
    /// 追加尾部（默认启用），目录中已删除的偏好条目忽略。返回 (id, enabled)。
    pub fn merged_items(&self, root: &Path) -> Result<Vec<(String, bool)>, String> {
        let scanned = self.scan_dict_ids_cached(root)?;
        // 已移除词典（用户显式删除 三语义）：扫描/偏好序双双排除
        let removed = crate::prefs::removed_dicts();
        let not_removed = |id: &String| !removed.iter().any(|r| r == id);
        let Some(items) = crate::prefs::dict_items() else {
            return Ok(scanned
                .into_iter()
                .filter(not_removed)
                .map(|id| (id, true))
                .collect());
        };
        let mut out: Vec<(String, bool)> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for item in items {
            if not_removed(&item.id)
                && scanned.iter().any(|id| id == &item.id)
                && seen.insert(item.id.clone())
            {
                out.push((item.id, item.enabled));
            }
        }
        for id in scanned {
            if not_removed(&id) && seen.insert(id.clone()) {
                out.push((id, true)); // 新发现词典默认启用
            }
        }
        Ok(out)
    }

    /// 词典是否启用（查询/联想/发音命令的入口过滤）
    pub fn is_enabled(&self, dict_id: &str) -> bool {
        let Ok(root) = self.ensure_root() else {
            return false;
        };
        self.merged_items(&root)
            .map(|items| {
                items
                    .iter()
                    .any(|(id, enabled)| id == dict_id && *enabled)
            })
            .unwrap_or(false)
    }

    /// 后台预热单轮（在低优先级线程内由 `spawn_warmup` 调用）：
    /// 仅遍历启用词典——已缓存毫秒级装入注册表；未缓存的就地解析并写缓存——
    /// 解析为 CPU 密集，调用方已保证延迟启动 + 本线程已降优先级，不影响前台。
    /// 返回（命中缓存数，现场解析数）。
    pub fn warmup(&self) -> Result<(usize, usize), String> {
        let root = self.ensure_root()?;
        // 后台预热绝不弹 UAC：缓存目录未就绪（安装目录不可写且未经用户查询
        // 提权创建）→ 直接跳过预热，冷解析留给用户首次查询时（会触发提权）
        if self.ensure_cache_dir(false).is_none() {
            tracing::info!(target: "dictionary", "缓存目录未就绪，本轮预热跳过");
            return Ok((0, 0));
        }
        let mut n_cached = 0usize;
        let mut n_parsed = 0usize;
        for (id, enabled) in self.merged_items(&root)? {
            if !enabled {
                continue;
            }
            if !self.has_cached_index(&id) {
                set_low_thread_priority();
                n_parsed += 1;
            } else {
                n_cached += 1;
            }
            self.with_dict(&id, |_| Ok(()))?;
        }
        Ok((n_cached, n_parsed))
    }

    /// 换词典根目录后清空缓存（已打开实例 + root + 扫描缓存），下次命令按新 root 重开
    pub fn reset(&self) {
        if let Ok(mut map) = self.inner.write() {
            map.clear();
        }
        if let Ok(mut root) = self.root.lock() {
            *root = None;
        }
        if let Ok(mut cache) = self.scan_cache.lock() {
            *cache = None;
        }
    }
}

#[derive(Serialize)]
pub struct DictMeta {
    pub id: String,
    pub dir: String,
    /// 启用状态（词典管理：禁用词典不参与查询/联想/预热）
    pub enabled: bool,
}

#[derive(Serialize)]
pub struct LoadResult {
    pub word_count: usize,
}

#[derive(Serialize)]
pub struct LookupResult {
    /// 查询词
    pub word: String,
    /// 已内联资源的词条 HTML；None = MISS
    pub html: Option<String>,
    /// @@@LINK 重定向终到词头（透明跳转记录，供调试显示）
    pub redirected_to: Option<String>,
}

/// 扫描词典根目录下的词典子目录 id（含 .mdx 即视为词典；id 升序）
fn scan_dict_ids(root: &Path) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(root).map_err(|e| format!("读目录失败: {e}"))?;
    let mut ids = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let has_mdx = std::fs::read_dir(&p)
            .map(|rd| {
                rd.flatten()
                    .any(|f| f.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("mdx")))
            })
            .unwrap_or(false);
        if has_mdx {
            ids.push(p.file_name().unwrap_or_default().to_string_lossy().into_owned());
        }
    }
    ids.sort();
    Ok(ids)
}

/// 词典列表（词典管理合并视图：偏好序 + 新发现尾随 + 启用标志）
#[tauri::command]
pub fn dictionary_list(registry: tauri::State<'_, Registry>) -> Result<Vec<DictMeta>, String> {
    let root = registry.ensure_root()?;
    Ok(registry
        .merged_items(&root)?
        .into_iter()
        .map(|(id, enabled)| {
            let dir = root.join(&id).to_string_lossy().into_owned();
            DictMeta { id, dir, enabled }
        })
        .collect())
}

/// 后台启动预热：延迟 2.5s（等主窗口首帧渲染完成），再以低优先级线程遍历词典——
/// 已缓存的毫秒级装入；未缓存的就地解析并写缓存。主程序启动流程完全不等待预热，
/// 避免词典解析与 webview 启动抢 CPU 拖慢前台（用户可感的启动时间）。
/// 换词典根目录后再次调用即对新目录重新预热。
pub fn spawn_warmup(handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2500));
        let t = std::time::Instant::now();
        use tauri::Manager;
        let registry = handle.state::<Registry>();
        match registry.warmup() {
            Ok((cached, parsed)) => tracing::info!(
                target: "dictionary",
                cached, parsed, ms = t.elapsed().as_millis() as u64,
                "词典预热完成（后台低优先级）"
            ),
            Err(e) => tracing::warn!(target: "dictionary", error = %e, "词典预热失败"),
        }
    });
}

/// 预热线程降优先级：解析是 CPU 密集型，后台静默让路给前台交互
#[cfg(windows)]
fn set_low_thread_priority() {
    use windows::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
    };
    // SAFETY: 伪句柄（当前线程）+ 常量优先级，无资源竞争
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}

#[cfg(not(windows))]
fn set_low_thread_priority() {}

/// 打开词典（预热；首次查词也会自动打开）
#[tauri::command]
pub fn dictionary_load(
    registry: tauri::State<'_, Registry>,
    dict_id: String,
) -> Result<LoadResult, String> {
    registry.with_dict(&dict_id, |d| Ok(LoadResult { word_count: d.word_count() }))
}

/// 查询词归一化（pickdict DictionaryService.lookup 同款）：划词捕获/手输可能带
/// 首尾空白或换行、词中含连续空白——trim + 空白序列折叠为单空格后再查，
/// 否则「词前后有空格查不到」。大小写折叠由引擎内置（opendict lookup）。
fn normalize_query(word: &str) -> String {
    word.trim().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// MDict 紧凑格式标记还原：把词条文本中的 `` `N` `` 占位符展开为 StyleSheet
/// 定义的 HTML（「文字版」词典——Compact="Yes" 且带 StyleSheet 表——的唯一
/// 样式来源，表为空时词典正文即最终 HTML，此函数直接原样返回）。
///
/// 展开语义对齐 GoldenDict `MdictParser::substituteStylesheet`（官方客户端闭源，
/// 该实现是社区验证过的还原行为）：**每个标记 = 关闭上一个样式 + 开启新样式**，
/// 只挂起一层待闭合后缀（style_sheet 的后缀留空即"只插入前缀、不闭合"，
/// 文字版 hydcd 全是这种形态）。表外编号整条丢弃——官方客户端成品里不残留
/// 编号数字，保留反而会把 `` `23` `` 之类的噪声渲染给用户；词条结尾补上
/// 未闭合的收尾标签，避免标签悬空污染后续排版。
fn substitute_stylesheet(text: &str, sheet: &[StyleSheetEntry]) -> String {
    if sheet.is_empty() || !text.contains('`') {
        return text.to_string();
    }
    static MARKER: OnceLock<Regex> = OnceLock::new();
    let marker = MARKER.get_or_init(|| Regex::new(r"`(\d+)`").expect("标记正则"));
    let mut out = String::with_capacity(text.len() + 64);
    let mut pending_end = "";
    let mut last = 0usize;
    for cap in marker.captures_iter(text) {
        let whole = cap.get(0).expect("整体匹配");
        out.push_str(&text[last..whole.start()]);
        last = whole.end();
        let entry = cap[1]
            .parse::<u32>()
            .ok()
            .and_then(|id| sheet.iter().find(|e| e.id == id));
        out.push_str(pending_end);
        pending_end = match entry {
            Some(e) => {
                out.push_str(&e.prefix);
                &e.suffix
            }
            None => "",
        };
    }
    out.push_str(&text[last..]);
    out.push_str(pending_end);
    out
}

/// 查词（含 @@@LINK 重定向 + 资源内联；禁用词典拒绝）
#[tauri::command]
pub fn dictionary_lookup(
    registry: tauri::State<'_, Registry>,
    dict_id: String,
    word: String,
) -> Result<LookupResult, String> {
    if !registry.is_enabled(&dict_id) {
        return Err(format!("词典已禁用: {dict_id}"));
    }
    let dict_dir = registry.dict_dir(&dict_id)?;
    let word = normalize_query(&word);
    registry.with_dict(&dict_id, |d| {
        let mut current = word.clone();
        let mut redirected_to: Option<String> = None;
        let mut html: Option<String> = None;
        // 紧凑格式（StyleSheet）还原 + 资源内联：先展开 `` `N` `` 标记，再内联
        // src/href 相对资源——样式前缀本身也可能带资源引用，顺序不可反
        let sheet = d.style_sheet();
        let render =
            |raw: &str| inline_with_engine(&substitute_stylesheet(raw, sheet), d, &dict_dir);
        // @@@LINK 链深度限制（防环；pickdict resolveEntry 同款语义）
        for _ in 0..3 {
            let raw = match d.lookup(&current) {
                Ok(Some(entries)) => entries.into_iter().next().map(|e| e.data),
                Ok(None) => None,
                Err(e) => return Err(format!("查询失败: {e}")),
            };
            let Some(bytes) = raw else {
                break; // MISS
            };
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let trimmed = text.trim();
            if trimmed.is_empty() {
                // 空定义存根条目（MDX 里存在有词头无内容的记录，如实测 O8C「收」
                // definition 为空）→ 视为 MISS：否则前端拿到空 html 会渲染出一个
                // 空白 iframe（用户报的查词面板白屏块根因）
                break;
            }
            if let Some(target) = trimmed.strip_prefix("@@@LINK=") {
                let target = target
                    .trim_matches(|c: char| c == '\0' || c == '\r' || c == '\n' || c == ' ')
                    .trim();
                if target.is_empty() || target == current {
                    // 空目标 / 自指：返回原条目（pickdict #20 行为）
                    html = Some(render(&text));
                    break;
                }
                redirected_to = Some(target.to_string());
                current = target.to_string();
                continue;
            }
            html = Some(render(&text));
            break;
        }
        Ok(LookupResult { word, html, redirected_to })
    })
}

/// 输入联想（禁用词典拒绝）
#[tauri::command]
pub fn dictionary_associate(
    registry: tauri::State<'_, Registry>,
    dict_id: String,
    prefix: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    if !registry.is_enabled(&dict_id) {
        return Err(format!("词典已禁用: {dict_id}"));
    }
    registry.with_dict(&dict_id, |d| Ok(d.search_prefix(&prefix, limit.unwrap_or(50))))
}

#[derive(Serialize)]
pub struct SoundResult {
    /// 资源字节 base64；None = MDD 无此资源
    pub base64: Option<String>,
    /// 原始资源 MIME（audio/speex / audio/mpeg / audio/wav / audio/ogg）
    pub mime: String,
}

/// 发音资源原始字节（.spx 解码在前端 wasm 做——pickdict 语义对齐：
/// 解码失败回退原字节，查词不受阻）。key = sound:// 后的路径（`uk/xxx.spx` 或 `\uk\xxx.spx`）。
#[tauri::command]
pub fn dictionary_sound(
    registry: tauri::State<'_, Registry>,
    dict_id: String,
    key: String,
) -> Result<SoundResult, String> {
    let ext = key.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
    let mime = match ext.as_str() {
        "spx" => "audio/speex",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    };
    let mdd_key = format!("\\{}", key.replace('/', "\\").trim_start_matches('\\'));
    registry.with_dict(&dict_id, |d| {
        Ok(SoundResult {
            base64: d
                .lookup_resource(&mdd_key)
                .map(|bytes| base64::engine::general_purpose::STANDARD.encode(&bytes)),
            mime: mime.into(),
        })
    })
}

// ── 资源内联（词条 HTML → dataURL） ──

fn mime_of(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "css" => "text/css",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "eot" => "application/vnd.ms-fontobject",
        _ => "application/octet-stream",
    }
}

/// 词条内相对资源 → dataURL 内联。
/// 收集范围：src/href 属性中无协议相对路径 + file:/// 引用（汉典 #21，剥协议即 MDD 键）。
/// 键形：`\a\b` 反斜杠（pickdict #16）。命中顺序：MDD（引擎大小写不敏感）→ 词典目录散装文件
/// （C.css / XHDCD.css 等，pickdict 资源解析顺序）。
/// sound:// 与 entry:// 不处理（前端交互语义）。
fn inline_with_engine(html: &str, dict: &MdictDictionary, dict_dir: &Path) -> String {
    let attr_re = Regex::new(r#"(?i)(?:src|href)="([^"]+)""#).expect("attr regex");
    let ext_re = Regex::new(&format!(r#"\.{RESOURCE_EXTS}(?:[?#].*)?$"#)).expect("ext regex");

    let mut candidates: Vec<(String, String)> = Vec::new();
    let mut push = |raw: &str, mdd_key: String| {
        if ext_re.is_match(&mdd_key.replace('\\', "/"))
            && !candidates.iter().any(|(_, k)| k == &mdd_key)
        {
            candidates.push((raw.to_string(), mdd_key));
        }
    };
    for cap in attr_re.captures_iter(html) {
        let raw = cap[1].to_string();
        if raw.starts_with('#') || raw.starts_with("data:") {
            continue; // 页内锚点 / 已内联
        }
        if raw.starts_with("sound://") || raw.starts_with("entry://") {
            continue;
        }
        if raw.starts_with("file:///") {
            // 汉典 #21：剥协议即相对路径；先剥残留斜杠再加单前缀（对齐 toMddKey 语义，
            // 否则 `/a/b` 会构造出 `\\a\b` 双开头键而 MISS）
            let key = format!(
                "\\{}",
                raw["file:///".len()..]
                    .replace('/', "\\")
                    .trim_start_matches('\\')
            );
            push(&raw, key);
            continue;
        }
        if raw.contains(':') || raw.contains('{') || raw.contains('%') {
            continue; // http(s):/javascript: 等协议；模板占位符；percent-encoded（保持原样防误伤）
        }
        let key = format!("\\{}", raw.replace('/', "\\").trim_start_matches('\\'));
        push(&raw, key);
    }

    let mut out = html.to_string();
    let mut miss_keys: Vec<String> = Vec::new();
    for (raw, key) in candidates {
        // 1) MDD 命中优先；2) 词典目录散装文件兜底（路径规范化防目录逃逸）
        let bytes = dict.lookup_resource(&key).or_else(|| {
            let rel = key.trim_start_matches('\\').replace('\\', "/");
            // 词条 HTML 可携带任意相对路径（`../../x.png`），规范化后必须仍在
            // 词典目录内才允许读盘（canonicalize 均为 verbatim 形式，前缀可比）
            let base = dict_dir.canonicalize().ok()?;
            let target = dict_dir.join(&rel).canonicalize().ok()?;
            if !target.starts_with(&base) {
                tracing::debug!(target: "dictionary", rel = %rel, "资源路径越出词典目录，拒绝读取");
                return None;
            }
            std::fs::read(target).ok()
        });
        let Some(bytes) = bytes else {
            miss_keys.push(key.trim_start_matches('\\').to_string());
            continue;
        };
        let ext = key.rsplit('.').next().unwrap_or_default();
        let mime = mime_of(ext);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        out = out.replace(&raw, &format!("data:{mime};base64,{b64}"));
    }
    if !miss_keys.is_empty() {
        tracing::debug!(target: "dictionary", miss = ?miss_keys, "词条资源未命中（MDD+散装均未找到）");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 样式表测试夹具：`(编号, 前缀, 后缀)` 列表 → StyleSheetEntry
    fn sheet_of(pairs: &[(u32, &str, &str)]) -> Vec<StyleSheetEntry> {
        pairs
            .iter()
            .map(|(id, prefix, suffix)| StyleSheetEntry {
                id: *id,
                prefix: prefix.to_string(),
                suffix: suffix.to_string(),
            })
            .collect()
    }

    #[test]
    fn stylesheet_switches_style_by_closing_previous() {
        // 每个标记 = 关旧 + 开新（GoldenDict 语义）：`2` 处先补 1 的后缀
        let sheet = sheet_of(&[(1, "<big>", "</big>"), (2, "<i>", "</i>")]);
        assert_eq!(
            substitute_stylesheet("`1`A`2`B", &sheet),
            "<big>A</big><i>B</i>"
        );
    }

    #[test]
    fn stylesheet_same_id_toggles_off_then_on() {
        let sheet = sheet_of(&[(1, "<big>", "</big>")]);
        assert_eq!(
            substitute_stylesheet("`1`A`1`B", &sheet),
            "<big>A</big><big>B</big>"
        );
    }

    #[test]
    fn stylesheet_unknown_id_dropped_and_closes_current() {
        let sheet = sheet_of(&[(1, "<big>", "</big>")]);
        assert_eq!(substitute_stylesheet("`1`A`99`B", &sheet), "<big>A</big>B");
    }

    #[test]
    fn stylesheet_insert_only_prefix_when_suffix_empty() {
        // 文字版（hydcd）形态：后缀全空 = 纯插入，无自动闭合
        let sheet = sheet_of(&[
            (20, "<h>", ""),
            (21, "</h><br>", ""),
            (9, "&nbsp;", ""),
            (12, "", ""),
        ]);
        assert_eq!(
            substitute_stylesheet("`20`木`21``9``12`", &sheet),
            "<h>木</h><br>&nbsp;"
        );
    }

    #[test]
    fn stylesheet_closes_dangling_suffix_at_end() {
        let sheet = sheet_of(&[(1, "<big>", "</big>")]);
        assert_eq!(substitute_stylesheet("`1`A", &sheet), "<big>A</big>");
    }

    #[test]
    fn stylesheet_noop_without_sheet_or_marker() {
        let sheet = sheet_of(&[(1, "<big>", "</big>")]);
        assert_eq!(substitute_stylesheet("`1`A", &[]), "`1`A");
        assert_eq!(substitute_stylesheet("纯文本", &sheet), "纯文本");
        // 反引号但非数字标记（正文中的行内代码）不动
        assert_eq!(substitute_stylesheet("`x`", &sheet), "`x`");
    }

    #[test]
    #[ignore = "需要本地黄金语料 test/dicts（gitignore，不入库）"]
    fn text_dicts_stylesheet_expands_clean() {
        // hydcd（漢語大詞典文字版，纯插入式表）与 hydzd（汉语大词典简体精排，
        // 开合式表）：展开后不残留任何 `N` 占位符，且词头样式片段出现
        let expectations = [
            ("hydcd", "<font size=+1 color=maroon><b>木</b></font>"),
            ("hydzd", "<font size=+2><B>木"),
        ];
        for (dict, head_html) in expectations {
            let dir = PathBuf::from("../test/dicts").join(dict);
            if !dir.is_dir() {
                println!("跳过 {dict}（语料缺失）");
                continue;
            }
            let d = MdictDictionary::open(dir.as_path()).unwrap();
            assert!(!d.style_sheet().is_empty(), "{dict} 应有 StyleSheet 表");
            let raw = String::from_utf8_lossy(&d.lookup("木").unwrap().unwrap()[0].data).into_owned();
            let html = substitute_stylesheet(&raw, d.style_sheet());
            assert!(!html.contains('`'), "{dict} 展开后仍残留标记");
            assert!(html.contains(head_html), "{dict} 词头样式缺失: {}", &html[..html.len().min(300)]);
        }
    }

    #[test]
    #[ignore = "需要本地黄金语料 test/dicts（gitignore，不入库）"]
    fn o8c_sit_down_resource_inline() {
        let dir = PathBuf::from("../test/dicts/O8C");
        let dict = MdictDictionary::open(dir.as_path()).unwrap();

        // 命中性隔离：直接 probe 键
        let direct = dict.lookup_resource("\\symbols\\xsym.png");
        println!("直接 probe \\symbols\\xsym.png → {:?}", direct.as_ref().map(|b| b.len()));

        // 收集性隔离：正则捕获的 raw
        let entries = dict.lookup("sit down").unwrap().unwrap();
        let html = String::from_utf8_lossy(&entries[0].data).into_owned();
        let attr_re = Regex::new(r#"(?i)(?:src|href)="([^"]+)""#).unwrap();
        let raws: Vec<String> = attr_re
            .captures_iter(&html)
            .map(|c| c[1].to_string())
            .filter(|r| r.contains("xsym") || r.contains("symbols"))
            .collect();
        println!("symbols 相关 raw: {raws:?}");

        let out = inline_with_engine(&html, &dict, &dir);
        let dataurl_png = out.matches("data:image/png;base64,").count();
        let leftover = out.matches("/symbols/xsym.png").count();
        println!("dataURL png 数: {dataurl_png}；残留 /symbols/xsym.png: {leftover}");
        assert_eq!(leftover, 0, "xsym.png 未被内联");
    }
}
