//! 朗读合成缓存（`voice-cache\`，M3）：Edge 在线合成的 write-through 磁盘缓存。
//!
//! 语义同 dict-cache——**可重建的派生数据**：不进备份（data.rs 白名单外）、不随
//! 迁移（data_migrate 只迁用户记录 JSON）、删除无损（未命中重新合成）。位置跟随
//! `paths::data_root` 分流（dev 隔离 / 便携 / 自定义根）。
//!
//! 缓存键在**本模块单点计算**：SHA-256(`edge|{voice}|{rate}|{text}`)——前端只传
//! 原始三元组，put/get/remove 三处口径天然一致（hash 放前端的话，主动清按当前
//! 配置重算的 key 必须与预取时逐位相同，跨语言浮点格式化是隐形雷区）。
//! 语音 / 语速 / 文本任一变化即换键，自然失效。
//!
//! 容量治理 = **LRU 主机制**：put 后总量超上限按 mtime 升序删最旧，直至回到
//! 上限内。收词箱永不毕业、毕业单元抽查仍复用发音、例句缓存无单元归属——
//! 单元生命周期管不到的三种场景靠它兜底；单元毕业 / 删除的主动清
//! （voice_cache_remove 按当前配置重算 key）只是加速器，语音 / 语速改过之后
//! 算不出的旧键同样由 LRU 最终回收。

use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// 缓存总容量上限（约 100MB；LRU 裁剪阈值）
const VOICE_CACHE_LIMIT: u64 = 100 * 1024 * 1024;

fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::paths::data_root(app)?.join("voice-cache"))
}

/// 缓存键：SHA-256 hex。text/voice 就地 trim（与前端合成入口同口径，未归一
/// 输入不影响命中）；rate 固定三位小数归一（前端 f64 与 Rust f32 的往返表示
/// 差异不再影响键）。
fn cache_key(text: &str, voice: &str, rate: f64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("edge|{}|{rate:.3}|{}", voice.trim(), text.trim()));
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in digest {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAudio {
    pub mime: String,
    pub base64: String,
}

/// 命中读缓存（None = 未命中，调用方现合成）。读取失败按未命中处理（半截文件
/// 等损坏场景由未命中合成覆盖自愈）。
#[tauri::command]
pub fn voice_cache_get(
    app: tauri::AppHandle,
    text: String,
    voice: String,
    rate: f64,
) -> Result<Option<CachedAudio>, String> {
    let key = cache_key(&text, &voice, rate);
    let path = cache_dir(&app)?.join(format!("{key}.mp3"));
    let bytes = match std::fs::read(&path) {
        Ok(b) if !b.is_empty() => b,
        _ => return Ok(None),
    };
    use base64::Engine as _;
    Ok(Some(CachedAudio {
        mime: "audio/mpeg".into(),
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}

/// 合成结果落盘（write-through 的写侧）；随后执行 LRU 容量裁剪。
/// 缓存目录建不出来（数据根只读等极端场景）直接报错，调用方按「本次不缓存」降级。
#[tauri::command]
pub fn voice_cache_put(
    app: tauri::AppHandle,
    text: String,
    voice: String,
    rate: f64,
    base64: String,
) -> Result<(), String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    if bytes.is_empty() {
        return Err("empty audio".into());
    }
    let key = cache_key(&text, &voice, rate);
    let dir = cache_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建缓存目录失败: {e}"))?;
    crate::fsutil::write_atomic_bytes(&dir.join(format!("{key}.mp3")), &bytes)?;
    enforce_limit(&dir);
    Ok(())
}

/// 主动清（单元毕业 / 删除的加速器）：按 (text, voice, rate) 列表重算 key 删除，
/// 返回实际删除数。传入的 voice/rate 应为当前发音偏好——用户改过配置后算不出
/// 旧键的残留由 LRU 兜底回收。
#[tauri::command]
pub fn voice_cache_remove(
    app: tauri::AppHandle,
    items: Vec<CachedKeyInput>,
) -> Result<usize, String> {
    let dir = cache_dir(&app)?;
    let mut removed = 0;
    for item in items {
        let key = cache_key(&item.text, &item.voice, item.rate);
        if std::fs::remove_file(dir.join(format!("{key}.mp3"))).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedKeyInput {
    pub text: String,
    pub voice: String,
    pub rate: f64,
}

/// LRU 容量裁剪：总量超上限时按 mtime 升序删最旧。失败静默（下一轮 put 再试）。
fn enforce_limit(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let size = meta.len();
        let mtime = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        total = total.saturating_add(size);
        files.push((entry.path(), size, mtime));
    }
    if total <= VOICE_CACHE_LIMIT {
        return;
    }
    files.sort_by_key(|(_, _, mtime)| *mtime);
    let mut excess = total - VOICE_CACHE_LIMIT;
    for (path, size, _) in files {
        if excess == 0 {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            excess = excess.saturating_sub(size);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_is_stable_and_sensitive() {
        let a = cache_key("take", "zh-CN-XiaoxiaoNeural", 1.0);
        let b = cache_key("take", "zh-CN-XiaoxiaoNeural", 1.0);
        assert_eq!(a, b, "同输入同键");
        assert_eq!(a.len(), 64, "SHA-256 hex 长度");
        assert_ne!(a, cache_key("take", "zh-CN-YunxiNeural", 1.0), "语音参与键");
        assert_ne!(a, cache_key("take", "zh-CN-XiaoxiaoNeural", 1.5), "语速参与键");
        assert_ne!(a, cache_key("took", "zh-CN-XiaoxiaoNeural", 1.0), "文本参与键");
        assert_eq!(
            cache_key("take", "v", 1.0),
            cache_key(" take ", " v ", 1.0),
            "trim 归一（与合成入口口径一致）"
        );
    }
}
