//! 数据可携性：一键备份/恢复 + 生词本 Anki CSV 导出。
//!
//! 备份格式 = 单 JSON 文件（四份数据文件文本内嵌，零 zip 依赖）：
//! `{ app: "onedict", version: 1, exportedAt, files: { <文件名>: <原文> } }`。
//! preferences.json 内 apiKey 为 DPAPI 密文——同机恢复免重填；**跨机恢复密文
//! 无法解密**（DPAPI 用户级绑定），需在设置页重填 Key（设计边界，UI 已提示）。
//!
//! 恢复语义 = **覆盖式**（回到备份时点）：白名单文件逐个原子写回 app_data_dir，
//! 然后 prefs 重入 init + 三个 store 整 state 重读 + 全量广播（前端各页重拉）。
//!
//! 安全面：restore 的 files key 走白名单（BACKUP_FILES），备份内容不落到
//! data_dir 之外的任何路径；目标路径来自前端文件对话框（用户本人操作）。

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;
use tauri::Manager;

use crate::history::HistoryStore;
use crate::history::translate::TranslateHistoryStore;
use crate::vocabulary::{INBOX_UNIT_ID, VocabularyStore};

/// 允许备份/恢复的数据文件白名单（restore 按此过滤，防备份文件携带任意写入路径）
const BACKUP_FILES: &[&str] = &[
    "preferences.json",
    "vocabulary.json",
    "history.json",
    "translate-history.json",
    "review-log.json",
    "unit-log.json",
];

/// 备份容器版本：v1 = 仅文本数据文件；v2 = 追加可选 `cache`（词典索引缓存，
/// base64 内嵌，key = dict-cache 相对路径）。恢复端 v1/v2 均收。
const BACKUP_VERSION: u32 = 2;

/// 词典缓存备份体积上限（base64 与 JSON 全程驻内存，防失控；实际索引缓存
/// 通常几 MB～几十 MB）
const CACHE_BACKUP_LIMIT: u64 = 256 * 1024 * 1024;

/// 备份容器（序列化导出 + 反序列化校验双用）。app 用 String 而非 &'static str：
/// 反序列化借不来输入的生命周期（E0597）。
#[derive(serde::Serialize, serde::Deserialize)]
struct BackupFile {
    app: String,
    version: u32,
    exported_at: i64,
    files: BTreeMap<String, String>,
    /// v2 可选：词典索引缓存（base64，key = dict-cache 内相对路径）；
    /// v1 备份/未勾选缓存项时缺省（serde default 兼容读旧）
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    cache: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStats {
    pub files: usize,
    pub bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreStats {
    pub restored: usize,
    /// 恢复的词典缓存文件数（备份未含缓存/目标目录不可写时为 0）
    pub cache: usize,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    crate::paths::data_root(app)
}

// ── 数据存储位置：数据分层迁移 ──
// 用户记录 JSON（小、重要）= 可迁数据；dict-cache（可再生索引缓存）随迁省重解析；
// logs（诊断留档）不迁。指针文件机制见 paths::DATA_ROOT_POINTER——偏好存在数据
// 目录里无法自举，指针固定放默认根下。迁移语义 = 复制非破坏：原目录数据保留作
// 安全副本，指针写成功才生效（失败目标目录残留可手动清理），重启后新目录接管。

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataLocationInfo {
    pub dir: String,
    pub cache_dir: String,
    pub portable: bool,
    pub custom: bool,
}

/// 当前数据存储位置（设置页展示：用户数据目录 + 词典缓存目录）
#[tauri::command]
pub fn data_location(app: tauri::AppHandle) -> Result<DataLocationInfo, String> {
    let loc = crate::paths::data_location(&app)?;
    Ok(DataLocationInfo {
        dir: loc.dir.to_string_lossy().into_owned(),
        cache_dir: crate::paths::cache_dir(&app).to_string_lossy().into_owned(),
        portable: loc.portable,
        custom: loc.custom,
    })
}

/// 迁移数据到新目录（设置页「迁移数据」）：复制用户记录 JSON → 写位置指针 →
/// 前端提示重启。不做内存态热切换（store 已按旧根打开），重启接管。
/// dict-cache 不迁（应用依赖缓存随安装目录走，非用户数据）。
#[tauri::command]
pub fn data_migrate(target: String, app: tauri::AppHandle) -> Result<BackupStats, String> {
    let target = std::path::PathBuf::from(target.trim());
    if !target.is_absolute() || target.file_name().is_none() {
        return Err(format!("目标必须是绝对目录路径: {}", target.display()));
    }
    let current = data_dir(&app)?;
    if target == current {
        return Err("新目录与当前数据目录相同".into());
    }
    if target.starts_with(&current) {
        return Err("新目录不能位于当前数据目录内部".into());
    }
    // 便携模式数据已在 exe 旁，指针机制不生效——拒绝迁移避免误导
    let loc = crate::paths::data_location(&app)?;
    if loc.portable {
        return Err("便携模式数据已随安装目录走，无需迁移".into());
    }
    std::fs::create_dir_all(&target).map_err(|e| format!("创建 {} 失败: {e}", target.display()))?;
    let mut files = 0usize;
    let mut bytes = 0u64;
    for name in BACKUP_FILES {
        if let Ok(text) = std::fs::read_to_string(current.join(name)) {
            bytes += text.len() as u64;
            crate::fsutil::write_atomic(&target.join(name), &text)
                .map_err(|e| format!("迁移 {name} 失败: {e}"))?;
            files += 1;
        }
    }
    if files == 0 {
        return Err("当前数据目录没有任何用户记录（无需迁移）".into());
    }
    // 指针写入默认根（data_location 的 std_root）——成功即生效，重启后接管
    let ptr = pointer_path(&app)?;
    crate::fsutil::write_atomic(
        &ptr,
        &target.to_string_lossy(),
    )
    .map_err(|e| format!("写位置指针失败: {e}"))?;
    tracing::info!(
        target: "data", files, bytes, to = %target.display(),
        "数据已迁移（重启后新目录生效；原目录保留为安全副本）"
    );
    Ok(BackupStats { files, bytes })
}

/// 恢复默认数据位置（删除指针文件；已迁出的目录数据保留在原地）
#[tauri::command]
pub fn data_reset_location(app: tauri::AppHandle) -> Result<(), String> {
    let loc = crate::paths::data_location(&app)?;
    if loc.portable {
        return Err("便携模式不使用位置指针".into());
    }
    if !loc.custom {
        return Ok(()); // 本就默认，幂等
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
    std::fs::remove_file(std_root.join(crate::paths::DATA_ROOT_POINTER))
        .map_err(|e| format!("删除位置指针失败: {e}"))?;
    tracing::info!(target: "data", "数据位置已恢复默认（重启后生效）");
    Ok(())
}

/// 位置指针文件路径（默认数据根下）
fn pointer_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取 app_data_dir 失败: {e}"))?;
    Ok(if cfg!(debug_assertions) {
        base.join("dev").join(crate::paths::DATA_ROOT_POINTER)
    } else {
        base.join(crate::paths::DATA_ROOT_POINTER)
    })
}

/// 递归收集词典缓存文件进备份容器（base64；key = dict-cache 内相对路径）。
/// 总量超 CACHE_BACKUP_LIMIT 报错（防 base64 + JSON 全程驻内存失控）。
fn collect_cache_files(
    dir: &Path,
    prefix: &str,
    out: &mut BTreeMap<String, String>,
    total: &mut u64,
) -> Result<(), String> {
    use base64::Engine as _;
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("读取 {} 失败: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let rel = if prefix.is_empty() {
            entry.file_name().to_string_lossy().into_owned()
        } else {
            format!("{prefix}/{}", entry.file_name().to_string_lossy())
        };
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_dir() {
            collect_cache_files(&entry.path(), &rel, out, total)?;
        } else {
            let bytes = std::fs::read(entry.path())
                .map_err(|e| format!("读取 {} 失败: {e}", entry.path().display()))?;
            *total += bytes.len() as u64;
            if *total > CACHE_BACKUP_LIMIT {
                return Err(
                    "词典缓存体积超过备份上限（256MB），建议关闭「备份词典缓存」后重试".into(),
                );
            }
            out.insert(rel, base64::engine::general_purpose::STANDARD.encode(&bytes));
        }
    }
    Ok(())
}

/// 导出备份（path 来自前端 save 对话框；include_cache = 是否包含词典索引缓存）
#[tauri::command]
pub fn data_backup(
    path: String,
    include_cache: bool,
    app: tauri::AppHandle,
) -> Result<BackupStats, String> {
    let dir = data_dir(&app)?;
    let mut files = BTreeMap::new();
    for name in BACKUP_FILES {
        if let Ok(text) = std::fs::read_to_string(dir.join(name)) {
            files.insert(name.to_string(), text);
        }
    }
    let mut cache = BTreeMap::new();
    if include_cache {
        let cache_dir = crate::paths::cache_dir(&app);
        if cache_dir.is_dir() {
            let mut total = 0u64;
            collect_cache_files(&cache_dir, "", &mut cache, &mut total)?;
        }
    }
    if files.is_empty() {
        return Err("没有可备份的数据文件（尚未产生任何数据）".into());
    }
    let file_count = files.len() + cache.len();
    let backup = BackupFile {
        app: "onedict".to_string(),
        version: BACKUP_VERSION,
        exported_at: now_ms(),
        files,
        cache,
    };
    let text = serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())?;
    crate::fsutil::write_atomic(Path::new(&path), &text)?;
    Ok(BackupStats {
        files: file_count,
        bytes: text.len() as u64,
    })
}

/// 恢复备份（覆盖式；内存态重读 + 全量广播）。v1/v2 兼容；v2 缓存项解 base64
/// 写回安装目录 dict-cache（相对路径防逃逸；目标不可写时跳过缓存并计数 0）。
#[tauri::command]
pub fn data_restore(path: String, app: tauri::AppHandle) -> Result<RestoreStats, String> {
    use base64::Engine as _;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取备份失败: {e}"))?;
    let backup: BackupFile = serde_json::from_str(&text)
        .map_err(|e| format!("备份文件无效（非 onedict 备份或已损坏）: {e}"))?;
    if backup.app != "onedict" {
        return Err(format!("非 onedict 备份文件（app = {}）", backup.app));
    }
    if backup.version != 1 && backup.version != BACKUP_VERSION {
        return Err(format!("备份版本不支持（v{}）", backup.version));
    }
    let dir = data_dir(&app)?;
    let mut restored = 0usize;
    for name in BACKUP_FILES {
        if let Some(content) = backup.files.get(*name) {
            crate::fsutil::write_atomic(&dir.join(name), content)
                .map_err(|e| format!("恢复 {name} 失败: {e}"))?;
            restored += 1;
        }
    }
    if restored == 0 {
        return Err("备份中没有任何数据文件".into());
    }

    // 词典缓存写回（安装目录 dict-cache；相对路径白名单语义，拒逃逸）。
    // 目录不可写（系统位置且从未提权）→ 跳过缓存（用户记录已恢复），下次
    // 提权建目录后缓存自愈重建，不作为整体失败。
    let mut cache_restored = 0usize;
    if !backup.cache.is_empty() {
        let cache_dir = crate::paths::cache_dir(&app);
        if std::fs::create_dir_all(&cache_dir).is_ok() {
            for (rel, b64) in &backup.cache {
                let rel_path = Path::new(rel);
                if rel_path.is_absolute() || rel.split(['/', '\\']).any(|seg| seg == "..") {
                    tracing::warn!(target: "data", rel = %rel, "缓存条目路径可疑，跳过");
                    continue;
                }
                let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) else {
                    tracing::warn!(target: "data", rel = %rel, "缓存条目 base64 无效，跳过");
                    continue;
                };
                if std::fs::write(cache_dir.join(rel_path), &bytes).is_ok() {
                    cache_restored += 1;
                }
            }
        } else {
            tracing::warn!(
                target: "data",
                dir = %cache_dir.display(),
                "缓存目录不可写，词典缓存未恢复（后续按需重建）"
            );
        }
    }

    // 内存态重读：prefs（重入 init，DPAPI 自动解密/迁移）+ 三个 store 整 state 替换；
    // 词典根目录可能随偏好变化 → registry reset（下次查询按新 root 重开）
    crate::prefs::init(&dir);
    app.state::<VocabularyStore>()
        .reload_from(dir.join("vocabulary.json"))?;
    app.state::<HistoryStore>()
        .reload_from(dir.join("history.json"))?;
    app.state::<TranslateHistoryStore>()
        .reload_from(dir.join("translate-history.json"))?;
    app.state::<crate::reviewlog::ReviewLogStore>()
        .reload_from(dir.join("review-log.json"))?;
    app.state::<crate::unitlog::UnitLogStore>()
        .reload_from(dir.join("unit-log.json"))?;
    app.state::<crate::dictionary::Registry>().reset();

    // 全量广播：设置页/生词本/历史/词典页监听重拉
    use tauri::Emitter;
    for event in [
        "prefs-changed",
        "dictionary-changed",
        "vocabulary-changed",
        "history-changed",
        "translate-history-changed",
    ] {
        if let Err(e) = app.emit(event, ()) {
            tracing::warn!(target: "data", event, error = %e, "恢复后广播失败");
        }
    }
    tracing::info!(target: "data", restored, cache = cache_restored, from = %path, "数据恢复完成");
    Ok(RestoreStats {
        restored,
        cache: cache_restored,
    })
}

/// CSV 字段转义（含逗号/引号/换行时双引号包裹 + 引号翻倍）
fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// 生词本导出 Anki 可导入 CSV（UTF-8 BOM + CRLF，Excel 直开不乱码）。
/// 列：word, note, unit, addedAt, dueAt, easeFactor, intervalDays, repetitions,
///     reviewCount, lapses, lastReviewedAt（时间 = epoch ms；Anki 导入仅映射
///     word/note 列，其余为留档元数据）。返回导出条数。
#[tauri::command]
pub fn vocabulary_export_anki(
    path: String,
    state: tauri::State<'_, VocabularyStore>,
) -> Result<usize, String> {
    let (entries, units) = state.entries_and_units()?;
    let unit_name = |id: &str| -> String {
        units
            .iter()
            .find(|u| u.id == id)
            .map(|u| u.name.clone())
            .unwrap_or_else(|| {
                if id == INBOX_UNIT_ID {
                    "收词箱".into()
                } else {
                    id.to_string()
                }
            })
    };
    let mut csv = String::from(
        "\u{feff}word,note,unit,addedAt,dueAt,easeFactor,intervalDays,repetitions,reviewCount,lapses,lastReviewedAt\r\n",
    );
    for e in &entries {
        csv.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{}\r\n",
            csv_escape(&e.word),
            csv_escape(&e.note),
            csv_escape(&unit_name(&e.unit_id)),
            e.added_at,
            e.due_at,
            e.ease_factor,
            e.interval_days,
            e.repetitions,
            e.review_count,
            e.lapses,
            e.last_reviewed_at
                .map(|v| v.to_string())
                .unwrap_or_default(),
        ));
    }
    crate::fsutil::write_atomic(Path::new(&path), &csv)?;
    tracing::info!(target: "data", count = entries.len(), to = %path, "Anki CSV 导出完成");
    Ok(entries.len())
}
