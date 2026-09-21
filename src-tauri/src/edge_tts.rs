//! Edge「大声朗读」在线语音合成（非官方接口）。
//!
//! 这批复刻讲述人音色的自然语音（Xiaoxiao / Aria / Yunxi …）以 MSIX 语音包形式
//! 只对第一方开放，第三方 TTS API（SAPI5 / WinRT `SpeechSynthesizer`）枚举不到；
//! Edge 网页端「大声朗读」走的是公开的 Azure 前端 WebSocket 端点，本模块按社区
//! 通行做法接入：语音列表走 HTTP，合成走 WSS（`Sec-MS-GEC` 时间签名 + 扩展 Origin）。
//!
//! 非官方接口的维护点（服务端校验，缺一即 403）：
//! - `TrustedClientToken`（Edge 内置固定值）
//! - `Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold`（朗读扩展）
//! - `Sec-MS-GEC`：SHA256(「5 分钟对齐的 Windows FILETIME」+ token) 大写十六进制
//! - `Sec-MS-GEC-Version: 1-<Edge 版本>`：**随 Edge 更新维护**（见 `EDGE_VERSION`）
//!
//! 失败一律给出 `EDGE_TTS:` 前缀错误，由前端朗读链降级到下一源（本地系统语音兜底）。

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message, WebSocket};

use crate::dictionary::SoundResult;

/// Edge 朗读可信客户端 token（Edge 客户端内置，社区公开）
const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
/// 模拟 Edge 版本（`Sec-MS-GEC-Version`；服务端校验下限，随 Edge 更新维护）
const EDGE_VERSION: &str = "1-143.0.3650.75";
/// 朗读扩展 Origin（服务端校验）
const ORIGIN: &str = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
/// 浏览器 UA（服务端校验）
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
const WSS_URL: &str =
    "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const LIST_URL: &str =
    "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list";
/// 输出格式：24kHz / 48kbps 单声道 mp3（Edge 网页端同款，Chromium 直接可播）
const AUDIO_FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";
/// 单次合成总时长上限（网络卡死保护）
const SYNTH_TIMEOUT: Duration = Duration::from_secs(30);

/// 在线语音条目（前端设置页下拉）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EdgeVoice {
    /// 语音 id（`zh-CN-XiaoxiaoNeural`），合成请求用
    pub short_name: String,
    /// 显示名（`Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)`）
    pub friendly_name: String,
    pub locale: String,
    pub gender: String,
}

/// 列表接口原始条目（只取用到的字段）
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawVoice {
    short_name: String,
    #[serde(default)]
    friendly_name: String,
    #[serde(default)]
    locale: String,
    #[serde(default)]
    gender: String,
}

/// Windows FILETIME（100ns，1601 起）→ 5 分钟对齐 → SHA256 大写十六进制。
/// 服务端按同一窗口校验（窗口滚动即失效重建）。
fn sec_ms_gec() -> String {
    const WIN_EPOCH: u64 = 11_644_473_600;
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let ticks = (secs + WIN_EPOCH) / 300 * 300 * 10_000_000;
    let mut hasher = Sha256::new();
    hasher.update(format!("{ticks}{TRUSTED_CLIENT_TOKEN}").as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect()
}

/// XML 文本节点转义（SSML 内嵌文本）
fn escape_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

/// 语速倍率（0.5–1.5）→ SSML 百分比（1.0 = +0%）
fn rate_percent(rate: f32) -> String {
    let pct = ((rate.clamp(0.5, 1.5) - 1.0) * 100.0).round() as i32;
    format!("{pct:+}%")
}

/// 语音语言标签（SSML `xml:lang`；取 locale，如 zh-CN）
fn voice_lang(voice: &str) -> String {
    // shortName 形如 `zh-CN-XiaoxiaoNeural` → 前两段即 locale
    let mut parts = voice.split('-');
    match (parts.next(), parts.next()) {
        (Some(a), Some(b)) => format!("{a}-{b}"),
        _ => "en-US".into(),
    }
}

/// 设置读写超时（网络卡死保护；TLS 流取底层 TcpStream）
fn apply_timeouts(ws: &mut WebSocket<MaybeTlsStream<std::net::TcpStream>>) {
    let t = Some(SYNTH_TIMEOUT);
    match ws.get_mut() {
        MaybeTlsStream::Plain(s) => {
            let _ = s.set_read_timeout(t);
        }
        MaybeTlsStream::NativeTls(s) => {
            let _ = s.get_ref().set_read_timeout(t);
        }
        _ => {}
    }
}

/// 阻塞合成（在 spawn_blocking 线程执行）：返回 mp3 字节
fn synthesize_blocking(text: &str, voice: &str, rate: f32) -> Result<Vec<u8>, String> {
    let gec = sec_ms_gec();
    let conn_id = uuid::Uuid::new_v4().simple().to_string();
    let url = format!(
        "{WSS_URL}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={gec}\
         &Sec-MS-GEC-Version={EDGE_VERSION}&ConnectionId={conn_id}"
    );
    let mut request = url
        .into_client_request()
        .map_err(|e| format!("EDGE_TTS_REQUEST:{e}"))?;
    {
        let headers = request.headers_mut();
        headers.insert("Origin", HeaderValue::from_static(ORIGIN));
        headers.insert("User-Agent", HeaderValue::from_static(UA));
        headers.insert("Pragma", HeaderValue::from_static("no-cache"));
        headers.insert("Cache-Control", HeaderValue::from_static("no-cache"));
        headers.insert(
            "Sec-MS-GEC",
            HeaderValue::from_str(&gec).map_err(|e| format!("EDGE_TTS_REQUEST:{e}"))?,
        );
        headers.insert("Sec-MS-GEC-Version", HeaderValue::from_static(EDGE_VERSION));
    }
    let (mut ws, _resp) = connect(request).map_err(|e| format!("EDGE_TTS_CONNECT:{e}"))?;
    apply_timeouts(&mut ws);

    // ① 合成配置（输出格式）
    let rid = uuid::Uuid::new_v4().simple().to_string();
    let config = format!(
        "X-RequestId:{rid}\r\nContent-Type:application/json; charset=utf-8\r\n\
         Path:speech.config\r\n\r\n{{\"context\":{{\"synthesis\":{{\"audio\":{{\
         \"metadataoptions\":{{\"sentenceBoundaryEnabled\":\"false\",\
         \"wordBoundaryEnabled\":\"false\"}},\"outputFormat\":\"{AUDIO_FORMAT}\"}}}}}}}}"
    );
    ws.send(Message::Text(config.into()))
        .map_err(|e| format!("EDGE_TTS_SEND:{e}"))?;

    // ② SSML（语音 + 语速）
    let rid = uuid::Uuid::new_v4().simple().to_string();
    let ssml = format!(
        "<speak version=\"1.0\" xmlns=\"http://www.w3.org/2001/10/synthesis\" \
         xml:lang=\"{}\"><voice name=\"{}\"><prosody rate=\"{}\">{}</prosody></voice></speak>",
        voice_lang(voice),
        voice,
        rate_percent(rate),
        escape_xml(text)
    );
    let ssml_msg = format!(
        "X-RequestId:{rid}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n{ssml}"
    );
    ws.send(Message::Text(ssml_msg.into()))
        .map_err(|e| format!("EDGE_TTS_SEND:{e}"))?;

    // ③ 收流：二进制帧携带 2 字节大端头长 + 头文本（Path:audio）+ mp3 数据；
    //    文本帧 `Path:turn.end` 结束本轮
    let started = std::time::Instant::now();
    let mut audio: Vec<u8> = Vec::new();
    let mut first_ms: Option<u128> = None;
    loop {
        if started.elapsed() > SYNTH_TIMEOUT {
            return Err("EDGE_TTS_TIMEOUT:合成超时（网络或服务端异常）".into());
        }
        let msg = ws.read().map_err(|e| format!("EDGE_TTS_READ:{e}"))?;
        if msg.is_text() {
            let text = String::from_utf8_lossy(&msg.into_data()).to_string();
            if text.contains("Path:turn.end") {
                break;
            }
        } else if msg.is_binary() {
            let bytes = msg.into_data();
            if first_ms.is_none() {
                first_ms = Some(started.elapsed().as_millis());
            }
            let mut payload: &[u8] = &bytes;
            if bytes.len() >= 2 {
                let hlen = ((bytes[0] as usize) << 8) | bytes[1] as usize;
                if hlen > 0 && 2 + hlen <= bytes.len() {
                    let header = String::from_utf8_lossy(&bytes[2..2 + hlen]);
                    if header.contains("Path:audio") {
                        payload = &bytes[2 + hlen..];
                    }
                }
            }
            audio.extend_from_slice(payload);
        } else if msg.is_close() {
            break;
        }
    }
    let _ = ws.close(None);
    if audio.is_empty() {
        return Err("EDGE_TTS_EMPTY:服务端未返回音频（语音不可用或接口变更）".into());
    }
    tracing::info!(
        target: "edge_tts",
        chars = text.chars().count(),
        kb = audio.len() / 1024,
        first_ms = first_ms.unwrap_or(0) as u64,
        total_ms = started.elapsed().as_millis() as u64,
        "Edge 合成完成"
    );
    Ok(audio)
}

/// 在线语音清单（设置页下拉；列表接口 5 分钟内无变化，前端会话缓存即可）
#[tauri::command]
pub async fn edge_tts_voices() -> Result<Vec<EdgeVoice>, String> {
    let client = reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("EDGE_TTS_HTTP:{e}"))?;
    let resp = client
        .get(format!("{LIST_URL}?trustedclienttoken={TRUSTED_CLIENT_TOKEN}"))
        .send()
        .await
        .map_err(|e| format!("EDGE_TTS_HTTP:{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("EDGE_TTS_HTTP:列表接口 {}", resp.status()));
    }
    let raw: Vec<RawVoice> = resp
        .json()
        .await
        .map_err(|e| format!("EDGE_TTS_HTTP:列表解析失败 {e}"))?;
    let out: Vec<EdgeVoice> = raw
        .into_iter()
        .map(|v| EdgeVoice {
            short_name: v.short_name,
            friendly_name: if v.friendly_name.is_empty() {
                v.locale.clone()
            } else {
                v.friendly_name
            },
            locale: v.locale,
            gender: v.gender,
        })
        .collect();
    tracing::info!(target: "edge_tts", voices = out.len(), "在线语音列表");
    Ok(out)
}

/// 文本 → mp3（base64）。`rate` 1.0 = 原速（0.5–1.5）。
#[tauri::command]
pub async fn edge_tts_synthesize(
    text: String,
    voice: String,
    rate: Option<f32>,
) -> Result<SoundResult, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("EDGE_TTS_EMPTY:文本为空".into());
    }
    if voice.trim().is_empty() {
        return Err("EDGE_TTS_VOICE:未指定在线语音".into());
    }
    let rate = rate.unwrap_or(1.0);
    let voice = voice.trim().to_string();
    let audio = tauri::async_runtime::spawn_blocking(move || {
        synthesize_blocking(&text, &voice, rate)
    })
    .await
    .map_err(|e| format!("EDGE_TTS_TASK:{e}"))??;
    Ok(SoundResult {
        base64: Some(base64::engine::general_purpose::STANDARD.encode(&audio)),
        mime: "audio/mpeg".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gec_is_uppercase_sha256_hex() {
        let gec = sec_ms_gec();
        assert_eq!(gec.len(), 64, "SHA256 十六进制长度");
        assert!(gec.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase()));
    }

    #[test]
    fn rate_percent_maps_and_clamps() {
        assert_eq!(rate_percent(1.0), "+0%");
        assert_eq!(rate_percent(0.9), "-10%");
        assert_eq!(rate_percent(1.5), "+50%");
        assert_eq!(rate_percent(9.0), "+50%", "越界夹到上限");
        assert_eq!(rate_percent(0.1), "-50%", "越界夹到下限");
    }

    #[test]
    fn voice_lang_from_short_name() {
        assert_eq!(voice_lang("zh-CN-XiaoxiaoNeural"), "zh-CN");
        assert_eq!(voice_lang("en-US-AriaNeural"), "en-US");
        assert_eq!(voice_lang("weird"), "en-US");
    }

    #[test]
    fn ssml_escapes_text() {
        assert_eq!(escape_xml("a<b>&'c'"), "a&lt;b&gt;&amp;&apos;c&apos;");
    }

    /// 实机探针（`cargo test --lib -- --ignored --nocapture probe_synthesize`）：
    /// 联网跑一次完整链路（签名 / 握手 / SSML / 收流），打印字节数与耗时。
    #[test]
    #[ignore = "需要联网访问 Edge 朗读接口"]
    fn probe_synthesize() {
        let t0 = std::time::Instant::now();
        let audio =
            synthesize_blocking("你好，这是本地实现的合成测试。", "zh-CN-XiaoxiaoNeural", 1.0)
                .expect("Edge 合成失败");
        println!(
            "edge probe: bytes={} ms={}",
            audio.len(),
            t0.elapsed().as_millis()
        );
        assert!(audio.len() > 2000, "音频过短（疑似错误响应）");
    }
}
