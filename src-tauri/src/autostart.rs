//! 开机启动（Windows 登录自启）：注册项读写经官方插件 tauri-plugin-autostart，
//! **状态唯一事实源 = 注册表实测**（不落 preferences.json——偏好会随备份恢复到
//! 新机，而注册表不会，双写即成幽灵态）。
//!
//! 环境守卫（不支持时开关置灰，`autostart_set` 亦拒绝写入）：便携模式——自启项存 exe
//! 绝对路径，目录一移动即失效。dev（debug_assertions）**不拦截**：开发期需要实测开关与
//! 注册表回读，仅落一条告警（此时 Run 项指向调试版程序路径，测毕需手动关闭）。
//!
//! 卸载清理与覆盖升级保留由 Tauri 自带 NSIS 模板完成（按 `${PRODUCTNAME}` 删 Run 值，
//! 且以 `$UpdateMode <> 1` 守卫），值名与本插件默认 app_name（productName）同源对齐，
//! 无需 installerHooks。运行时附加 `--autostart`，启动期据此识别「本次由登录自启拉起」。

use serde::Serialize;
use tauri_plugin_autostart::ManagerExt;

/// 登录自启注册值时附加的命令行参数（随 exe 路径写入 Run 值；lib.rs 启动期比对此值）
pub const AUTOSTART_ARG: &str = "--autostart";

/// 开机启动状态快照（设置页按此渲染开关的可点性与说明）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    /// 注册表实测是否已注册（环境不支持时恒 false）
    pub enabled: bool,
    /// 本环境是否允许开关（dev / 便携模式为 false）
    pub supported: bool,
    /// 不可用原因（supported = true 时为空串）
    pub reason: String,
}

/// 环境不支持时的原因（None = 可注册）
fn unsupported_reason() -> Option<&'static str> {
    crate::paths::is_portable()
        .then_some("便携模式不注册开机启动（自启项指向固定路径，移动文件夹后失效）")
}

/// 开机启动状态（设置页加载/回读）。注册表读取失败按未注册处理并留痕——
/// 开关显示关闭比显示一个点不动的「已开启」更诚实。
#[tauri::command]
pub fn autostart_status(app: tauri::AppHandle) -> AutostartStatus {
    if let Some(reason) = unsupported_reason() {
        return AutostartStatus {
            enabled: false,
            supported: false,
            reason: reason.into(),
        };
    }
    let enabled = match app.autolaunch().is_enabled() {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(target: "autostart", error = %e, "开机启动状态读取失败");
            false
        }
    };
    AutostartStatus {
        enabled,
        supported: true,
        reason: String::new(),
    }
}

/// 开关开机启动。成功后回读注册表实测值返回（任务管理器「禁用」等外部覆写以实测为准，
/// 界面不撒谎）。
#[tauri::command]
pub fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<AutostartStatus, String> {
    if let Some(reason) = unsupported_reason() {
        return Err(reason.into());
    }
    // dev 无守卫但留痕：Run 项此时指向调试版程序路径，与安装版同名同值（值名 = productName）
    if enabled && cfg!(debug_assertions) {
        tracing::warn!(target: "autostart", "开发模式注册开机启动：Run 项指向调试版程序路径，测毕请关闭");
    }
    let manager = app.autolaunch();
    let applied = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    if let Err(e) = applied {
        // 关闭时 Run 值本就不存在（已卸载清理 / 从未注册）→ 视为已关闭，不报错：
        // delete_value 对缺失值返回 NotFound，而状态回读的 false 即用户期望的结果
        if enabled || manager.is_enabled().unwrap_or(true) {
            let action = if enabled { "开启" } else { "关闭" };
            tracing::error!(target: "autostart", error = %e, "开机启动{action}失败");
            return Err(format!("{action}开机启动失败: {e}"));
        }
    }
    let now = manager.is_enabled().unwrap_or(enabled);
    tracing::info!(target: "autostart", enabled = now, "开机启动已更新");
    Ok(AutostartStatus {
        enabled: now,
        supported: true,
        reason: String::new(),
    })
}
