//! 应用内更新（设置页「关于」）：官方 updater 插件的 Rust 侧包装。
//!
//! 为什么自建命令而不走插件 IPC：插件默认路径需要 npm 包与 capabilities 授权，
//! 而本应用全部后端能力都从自建命令进出（对齐 global-shortcut / autostart
//! 「仅 Rust 侧调用」的先例），错误文案与进度事件也按本应用口径给出。
//!
//! 职责边界：网络检查、下载、签名校验、NSIS 覆盖安装全部由插件承担；本模块只做
//! 三件事——把已检出的更新在进程内缓存供「下载」「安装」两步复用、把下载进度经
//! Channel 回传前端、按运行环境拦截不该发生的动作（便携副本被装成安装版、开发版
//! 触发安装）。**签名校验不可关闭**：下载完成即验签，失败不落盘、不进安装流程。

use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::Emitter;
use tauri_plugin_updater::{Update, UpdaterExt};

/// 检查超时：网络不可达时不让界面长时间空等（下载不限时——安装包 4MB 量级）
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// 启动检查延迟：避开启动期词典预热与首帧渲染的资源竞争
const STARTUP_DELAY: Duration = Duration::from_secs(8);
/// 便携模式统一拒绝文案
const PORTABLE_MSG: &str = "便携模式不支持在线更新";

/// 已检出的更新（bytes 仅在下载完成后有值）
struct Pending {
    info: UpdateInfo,
    update: Update,
    bytes: Option<Vec<u8>>,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

/// 更新信息（前端展示用；下载地址与签名不出后端）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 远端版本号
    pub version: String,
    /// 当前版本号
    pub current: String,
    /// 发布说明（Markdown）
    pub notes: Option<String>,
    /// 发布日期（远端 JSON 的 pub_date，RFC3339）
    pub date: Option<String>,
}

/// 下载进度事件（Channel 回传；字段名 camelCase，与前端类型一一对应）
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum UpdateEvent {
    #[serde(rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: usize },
    Finished,
}

/// 运行环境（前端据此置灰按钮并给出原因）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEnv {
    /// 便携模式：程序与数据在用户自有目录，更新由用户自行替换
    pub portable: bool,
    /// 开发模式：检查与下载可用于联调，安装被拦截
    pub dev: bool,
}

fn pending() -> MutexGuard<'static, Option<Pending>> {
    PENDING.lock().unwrap_or_else(|e| e.into_inner())
}

/// 运行环境（便携 / 开发）
#[tauri::command]
pub fn update_env() -> UpdateEnv {
    UpdateEnv {
        portable: crate::paths::is_portable(),
        dev: cfg!(debug_assertions),
    }
}

/// 已检出的更新（不联网：启动检查或上次手动检查的结果）
#[tauri::command]
pub fn update_pending() -> Option<UpdateInfo> {
    pending().as_ref().map(|p| p.info.clone())
}

/// 联网检查更新；远端版本不高于当前时返回 null（同时清掉旧结果）
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    check(&app).await
}

/// 下载安装包（进度经 Channel 回传）。下载完成即验签，通过后才可进入安装。
#[tauri::command]
pub async fn update_download(on: Channel<UpdateEvent>) -> Result<(), String> {
    if crate::paths::is_portable() {
        return Err(PORTABLE_MSG.into());
    }
    let update = pending()
        .as_ref()
        .map(|p| p.update.clone())
        .ok_or("尚未检查到可用更新")?;
    // 首块到达时发 Started（总长来自 Content-Length，可能缺省）
    let mut first = true;
    let bytes = update
        .download(
            |chunk_length, content_length| {
                if first {
                    first = false;
                    let _ = on.send(UpdateEvent::Started { content_length });
                }
                let _ = on.send(UpdateEvent::Progress { chunk_length });
            },
            || {
                // 字节收完（随后插件验签）——完成事件在此发出，命令落定才代表可安装
                let _ = on.send(UpdateEvent::Finished);
            },
        )
        .await
        .map_err(download_msg)?;
    if let Some(p) = pending().as_mut() {
        p.bytes = Some(bytes);
    }
    Ok(())
}

/// 运行安装程序并退出（安装器以 /P /UPDATE /R 覆盖安装，装完自动重启应用）。
/// 成功路径不返回——脚本在启动安装程序后即结束进程。
#[tauri::command]
pub fn update_install() -> Result<(), String> {
    if crate::paths::is_portable() {
        return Err(PORTABLE_MSG.into());
    }
    if cfg!(debug_assertions) {
        return Err("开发版不执行安装".into());
    }
    let (update, bytes) = {
        let mut guard = pending();
        let p = guard.as_mut().ok_or("尚未检查到可用更新")?;
        let bytes = p.bytes.take().ok_or("安装包尚未下载完成")?;
        (p.update.clone(), bytes)
    };
    match update.install(&bytes) {
        Ok(()) => Ok(()),
        Err(e) => {
            // 安装程序未启动：已下载的包放回缓存供重试
            if let Some(p) = pending().as_mut() {
                p.bytes = Some(bytes);
            }
            Err(format!("安装失败：{e}"))
        }
    }
}

/// 检查失败文案：可自行处理的两类给出口（发布页手动下载），其余透出原文便于排查
fn check_msg(e: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match e {
        // 端点无可解析的清单：发布页尚未上传 latest.json，或该版本被删除
        E::ReleaseNotFound => "未找到更新清单，可前往发布页手动下载".into(),
        // 清单里没有当前平台的键（正常发布不会出现，多半是清单写错）
        E::TargetsNotFound(_) => "更新清单缺少当前平台，可前往发布页手动下载".into(),
        E::Reqwest(err) if err.is_connect() || err.is_timeout() => {
            "网络不可达，可前往发布页手动下载".into()
        }
        other => format!("检查更新失败：{other}"),
    }
}

/// 下载失败文案：网络两类归一，验签失败给明确结论（安装包已丢弃，不会进入安装）
fn download_msg(e: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) => "安装包签名校验未通过，已丢弃".into(),
        E::Reqwest(err) if err.is_connect() || err.is_timeout() => "下载失败：网络不可达".into(),
        other => format!("下载失败：{other}"),
    }
}

/// 检查实现：便携模式拒绝，其余交给插件（插件按 semver 比较远端与当前版本）
async fn check(app: &tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    if crate::paths::is_portable() {
        return Err(PORTABLE_MSG.into());
    }
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| format!("更新组件不可用：{e}"))?;
    let update = updater.check().await.map_err(check_msg)?;
    let Some(update) = update else {
        // 已是最新：清掉上一次结果，避免界面停留在旧提示
        *pending() = None;
        return Ok(None);
    };
    let info = UpdateInfo {
        version: update.version.clone(),
        current: update.current_version.clone(),
        notes: update.body.clone(),
        // 日期读远端 JSON 原字段（插件只在 IPC 路径做 RFC3339 格式化）
        date: update
            .raw_json
            .get("pub_date")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
    };
    *pending() = Some(Pending {
        info: info.clone(),
        update,
        bytes: None,
    });
    tracing::info!(target: "update", version = %info.version, "发现新版本");
    Ok(Some(info))
}

/// 启动检查（偏好开启时）：延迟后台执行，发现新版本广播 `update-available`
/// 供主窗标记入口。失败只记日志——启动期网络异常不该产生任何界面打扰。
pub fn spawn_startup_check(app: tauri::AppHandle) {
    if crate::paths::is_portable() || !crate::prefs::get().check_update_on_startup {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(STARTUP_DELAY);
        tauri::async_runtime::spawn(async move {
            match check(&app).await {
                Ok(Some(info)) => {
                    if let Err(e) = app.emit("update-available", info) {
                        tracing::warn!(target: "update", error = %e, "update-available 广播失败");
                    }
                }
                Ok(None) => tracing::info!(target: "update", "启动检查：已是最新版本"),
                Err(e) => tracing::warn!(target: "update", error = %e, "启动检查失败"),
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前端类型与本模块的序列化契约（改名即破约）
    #[test]
    fn update_info_serializes_camel_case() {
        let info = UpdateInfo {
            version: "0.1.16".into(),
            current: "0.1.15".into(),
            notes: Some("说明".into()),
            date: Some("2026-09-16T00:00:00Z".into()),
        };
        let v = serde_json::to_value(&info).unwrap();
        assert_eq!(v["version"], "0.1.16");
        assert_eq!(v["current"], "0.1.15");
        assert_eq!(v["notes"], "说明");
        assert_eq!(v["date"], "2026-09-16T00:00:00Z");
    }

    /// 配置段是插件初始化的硬前提：缺 `plugins.updater` 段会以 null 反序列化失败
    /// （pubkey 为必填字段），端点非 https 在 release 构建被拒。
    #[test]
    fn updater_config_is_valid() {
        let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"))
            .expect("读 tauri.conf.json 失败");
        let conf: serde_json::Value =
            serde_json::from_str(&raw).expect("tauri.conf.json 不是合法 JSON");
        let section = conf
            .get("plugins")
            .and_then(|p| p.get("updater"))
            .cloned()
            .expect("tauri.conf.json 缺少 plugins.updater 段");
        let cfg: tauri_plugin_updater::Config =
            serde_json::from_value(section).expect("plugins.updater 无法反序列化");
        assert_eq!(cfg.endpoints.len(), 1, "更新端点数量应为 1");
        assert_eq!(cfg.endpoints[0].scheme(), "https", "release 构建只允许 https 端点");
        assert!(!cfg.pubkey.is_empty(), "更新公钥缺失");
    }

    #[test]
    fn download_event_shape() {
        let started =
            serde_json::to_value(UpdateEvent::Started { content_length: Some(1024) }).unwrap();
        assert_eq!(started["event"], "Started");
        assert_eq!(started["data"]["contentLength"], 1024);

        let progress = serde_json::to_value(UpdateEvent::Progress { chunk_length: 8 }).unwrap();
        assert_eq!(progress["event"], "Progress");
        assert_eq!(progress["data"]["chunkLength"], 8);

        let finished = serde_json::to_value(UpdateEvent::Finished).unwrap();
        assert_eq!(finished["event"], "Finished");
    }
}
