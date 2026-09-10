//! API Key 落盘加密（用户指定：不再明文保存，用 Windows 系统密钥加密）。
//!
//! 方案 = **DPAPI（Data Protection API，CryptProtectData/CryptUnprotectData）**：
//! 用户级系统密钥加密，密文只有本机当前用户可解，零外部依赖（windows crate 自带），
//! 「系统密钥加密保存」语义与逐字吻合。密文带 `dpapi:` base64 前缀落盘；
//! **旧明文自动迁移**——unprotect 对无前缀值原样返回，下次落盘自动加密。
//!
//! 转换边界（prefs/mod.rs）：仅 **文件读写**（save_to 前加密 / load_from 后解密）；
//! 内存态与 IPC（prefs_get/prefs_set_ai）始终明文——威胁模型是「文件不被读」，
//! 本进程内传递不落盘即可。

/// 密文前缀（识别用；解密失败回退明文的 legacy 兼容也因此判定健壮）
const PREFIX: &str = "dpapi:";

/// 加密（仅 windows；其他平台原样返回——项目 Windows 优先，不做伪装加密）
#[cfg(target_os = "windows")]
pub fn protect(plain: &str) -> String {
    use base64::Engine;
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let bytes = plain.as_bytes();
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut out = CRYPT_INTEGER_BLOB::default();
    let result = unsafe {
        CryptProtectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    };
    if let Err(error) = result {
        // 实机 DPAPI（用户级）不失败；万一失败：降级明文落盘 + error 日志（可用性优先，
        // 用户目录 ACL 兜底），下次保存重试加密
        tracing::error!(target: "prefs", error = %error, "DPAPI 加密失败，API Key 降级明文落盘");
        return plain.to_string();
    }
    let data =
        unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
    unsafe {
        let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(out.pbData.cast())));
    }
    format!("{PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(data))
}

/// 解密：`dpapi:` 前缀 → DPAPI 解密（失败 = 密文损坏或跨用户拷贝 → None 丢弃，
/// 由用户重填）；无前缀 → legacy 明文原样返回（自动迁移到下次落盘加密）
#[cfg(target_os = "windows")]
pub fn unprotect(value: &str) -> Option<String> {
    use base64::Engine;
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let Some(encoded) = value.strip_prefix(PREFIX) else {
        return Some(value.to_string()); // legacy 明文
    };
    let Ok(data) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
        tracing::error!(target: "prefs", "API Key 密文 base64 损坏，已丢弃");
        return None;
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut out = CRYPT_INTEGER_BLOB::default();
    if let Err(error) = unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    } {
        // 跨用户/跨机器拷贝 preferences.json 的典型失败：密钥系于本机用户，无法解
        tracing::error!(target: "prefs", error = %error, "DPAPI 解密失败（密文不可用），API Key 已丢弃");
        return None;
    }
    let plain =
        unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
    unsafe {
        let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(out.pbData.cast())));
    }
    String::from_utf8(plain).ok()
}

#[cfg(not(target_os = "windows"))]
pub fn protect(plain: &str) -> String {
    plain.to_string()
}

#[cfg(not(target_os = "windows"))]
pub fn unprotect(value: &str) -> Option<String> {
    Some(value.to_string())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn protect_unprotect_roundtrip() {
        let cipher = protect("sk-secret-中文-🎉");
        assert!(cipher.starts_with(PREFIX));
        assert!(!cipher.contains("sk-secret"), "密文不含明文片段");
        assert_eq!(unprotect(&cipher).as_deref(), Some("sk-secret-中文-🎉"));
    }

    #[test]
    fn unprotect_plain_passthrough_is_legacy_migration_path() {
        // 旧明文文件：无前缀原样返回（load 后内存明文可用，下次落盘自动加密）
        assert_eq!(unprotect("sk-legacy-plain").as_deref(), Some("sk-legacy-plain"));
        // 带前缀但 base64 损坏 → 丢弃（None），不返回垃圾
        assert_eq!(unprotect("dpapi:!!!not-base64!!!"), None);
    }
}
