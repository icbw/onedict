//! 本地系统朗读（WinRT `Windows.Media.SpeechSynthesis`）。
//!
//! 语音库与「讲述人」同源（OneCore）：`AllVoices()` 枚举到的 Natural / HD 语音即
//! 设置页「选择语音」里那些条目。选型理由（SAPI5 排除、webview speechSynthesis 排除）
//! 见 `docs/plans/2026-09-19-local-tts-pronounce-plan.md`。
//!
//! 合成到内存流 → base64 返回，与 `dictionary_sound` / `webdict_audio` **同构**
//! （复用前端既有单通道播放通道）；播放与排队由前端决定。
//!
//! 无包标识直调 WinRT 与 `CoInitializeEx(MTA)` + `IAsyncOperation::get()` 阻塞拍平
//! 沿用 `ocr.rs` 已验证范式。

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use windows::core::HSTRING;
use windows::Media::SpeechSynthesis::{
    SpeechSynthesisStream, SpeechSynthesizer, VoiceGender, VoiceInformation,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::dictionary::SoundResult;

/// 语速可调区间（SSML prosody rate；1.0 = 原速）
const RATE_MIN: f32 = 0.5;
const RATE_MAX: f32 = 1.5;

/// 语音条目（设置页下拉 / 试听标注）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOut {
    pub id: String,
    pub name: String,
    /// BCP-47 语言标签（en-US / zh-CN …）
    pub language: String,
    /// "female" / "male"
    pub gender: String,
    /// 显示名含 Natural（Natural / Natural HD 语音；仅展示标注，不作门禁）
    pub natural: bool,
    pub description: String,
}

/// 合成器实例缓存：voiceId（"" = 系统默认）→ 实例。
/// WinRT 语音类为 Agile，跨线程共享安全（同 `ocr.rs` 的引擎缓存模式）；
/// `SetVoice` 是有状态设置，故按语音各持一份。
static SYNTHS: Mutex<Option<HashMap<String, SpeechSynthesizer>>> = Mutex::new(None);

/// 命令线程 COM 初始化（幂等；已初始化返回 S_FALSE 同为成功，同 ocr.rs）
fn com_init() {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
}

/// HSTRING 取值的宽松语义：读不到给空串，不让单个属性拖垮整个列表
fn hs(value: windows::core::Result<HSTRING>) -> String {
    value.map(|v| v.to_string()).unwrap_or_default()
}

fn voice_out(v: &VoiceInformation) -> VoiceOut {
    let name = hs(v.DisplayName());
    let description = hs(v.Description());
    let natural = name.to_lowercase().contains("natural") || description.to_lowercase().contains("natural");
    VoiceOut {
        id: hs(v.Id()),
        language: hs(v.Language()),
        gender: match v.Gender() {
            Ok(VoiceGender::Male) => "male".into(),
            _ => "female".into(),
        },
        natural,
        name,
        description,
    }
}

/// 语音清单（设置页下拉；含 Natural / HD——与讲述人列表同库）
#[tauri::command]
pub fn tts_voices() -> Result<Vec<VoiceOut>, String> {
    com_init();
    let t0 = std::time::Instant::now();
    let voices =
        SpeechSynthesizer::AllVoices().map_err(|e| format!("TTS_ENUM_FAILED:{e}"))?;
    let out: Vec<VoiceOut> = voices.into_iter().map(|v| voice_out(&v)).collect();
    tracing::info!(
        target: "tts",
        voices = out.len(),
        natural = out.iter().filter(|v| v.natural).count(),
        ms = t0.elapsed().as_millis() as u64,
        "语音列表"
    );
    Ok(out)
}

/// 按 id 找语音（id 来自 `tts_voices`；用户卸载语音后陈旧 id 以
/// `TTS_VOICE_MISSING:` 前缀报错，前端回退默认语音并提示）
fn find_voice(voice_id: &str) -> Result<VoiceInformation, String> {
    let voices = SpeechSynthesizer::AllVoices().map_err(|e| format!("TTS_ENUM_FAILED:{e}"))?;
    for v in voices {
        if hs(v.Id()) == voice_id {
            return Ok(v);
        }
    }
    Err(format!("TTS_VOICE_MISSING:{voice_id}"))
}

/// 取（或建）指定语音的合成器实例；voice_id 空 = 系统默认语音
fn synth_for(voice_id: Option<&str>) -> Result<SpeechSynthesizer, String> {
    let key = voice_id.unwrap_or_default().to_string();
    let mut guard = SYNTHS.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if let Some(synth) = map.get(&key) {
        return Ok(synth.clone());
    }
    let synth = SpeechSynthesizer::new().map_err(|e| format!("TTS_SYNTH_FAILED:{e}"))?;
    if !key.is_empty() {
        let voice = find_voice(&key)?;
        synth
            .SetVoice(&voice)
            .map_err(|e| format!("TTS_SYNTH_FAILED:{e}"))?;
    }
    map.insert(key, synth.clone());
    Ok(synth)
}

/// XML 文本节点转义（SSML 内嵌文本；与 HTML 属性值同纪律：五个字符全转）
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

/// SSML 包装（语速用 prosody rate；xml:lang 与语音语言一致——不匹配会合成失败）
fn build_ssml(text: &str, lang: &str, rate: f32) -> String {
    let lang = if lang.is_empty() { "en-US" } else { lang };
    let rate = rate.clamp(RATE_MIN, RATE_MAX);
    format!(
        "<speak version=\"1.0\" xmlns=\"http://www.w3.org/2001/10/synthesis\" xml:lang=\"{lang}\">\
         <prosody rate=\"{rate:.2}\">{}</prosody></speak>",
        escape_xml(text)
    )
}

fn text_to_stream(synth: &SpeechSynthesizer, text: &str) -> Result<SpeechSynthesisStream, String> {
    synth
        .SynthesizeTextToStreamAsync(&HSTRING::from(text))
        .map_err(|e| format!("TTS_SYNTH_FAILED:{e}"))?
        .get()
        .map_err(|e| format!("TTS_SYNTH_FAILED:{e}"))
}

/// 合成流 → base64（读法与 ocr.rs 的 DataReader 链同款）
fn stream_to_result(stream: &SpeechSynthesisStream) -> Result<SoundResult, String> {
    use base64::Engine as _;
    let mime = stream
        .ContentType()
        .map(|c| c.to_string())
        .unwrap_or_else(|_| "audio/wav".into());
    let size = stream.Size().map_err(|e| format!("TTS_SYNTH_FAILED:{e}"))? as u32;
    let reader = DataReader::CreateDataReader(stream).map_err(|e| format!("TTS_SYNTH_FAILED:{e}"))?;
    reader
        .LoadAsync(size)
        .map_err(|e| format!("TTS_SYNTH_FAILED:{e}"))?
        .get()
        .map_err(|e| format!("TTS_SYNTH_FAILED:{e}"))?;
    let mut bytes = vec![0u8; size as usize];
    reader
        .ReadBytes(&mut bytes)
        .map_err(|e| format!("TTS_SYNTH_FAILED:{e}"))?;
    Ok(SoundResult {
        base64: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
        mime,
    })
}

/// 阻塞合成（在 spawn_blocking 线程执行）
fn synthesize_blocking(
    text: &str,
    voice_id: Option<&str>,
    rate: f32,
) -> Result<SoundResult, String> {
    com_init();
    let synth = synth_for(voice_id)?;
    // 非原速才走 SSML；SSML 失败（语音与 xml:lang 不匹配等）回退纯文本——语速失效
    // 但不丢朗读（同 noThink 剥参重试的既有习惯）
    let stream = if (rate.clamp(RATE_MIN, RATE_MAX) - 1.0).abs() > 0.01 {
        let lang = synth
            .Voice()
            .ok()
            .map(|v| hs(v.Language()))
            .unwrap_or_default();
        let ssml = build_ssml(text, &lang, rate);
        match synth
            .SynthesizeSsmlToStreamAsync(&HSTRING::from(ssml))
            .map_err(|e| format!("TTS_SYNTH_FAILED:{e}"))
            .and_then(|op| op.get().map_err(|e| format!("TTS_SYNTH_FAILED:{e}")))
        {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(target: "tts", error = %e, "SSML 合成失败，回退纯文本（语速失效）");
                text_to_stream(&synth, text)?
            }
        }
    } else {
        text_to_stream(&synth, text)?
    };
    stream_to_result(&stream)
}

/// 文本 → 音频（WAV，base64）。`voice_id` 空/None = 系统默认语音；
/// `rate` 1.0 = 原速（区间 0.5–1.5）。
#[tauri::command]
pub async fn tts_synthesize(
    text: String,
    voice_id: Option<String>,
    rate: Option<f32>,
) -> Result<SoundResult, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("TTS_EMPTY:文本为空".into());
    }
    let rate = rate.unwrap_or(1.0);
    let chars = text.chars().count();
    let t0 = std::time::Instant::now();
    let voice = voice_id.filter(|v| !v.is_empty());
    let result = tauri::async_runtime::spawn_blocking(move || {
        synthesize_blocking(&text, voice.as_deref(), rate)
    })
    .await
    .map_err(|e| format!("TTS_SYNTH_FAILED:任务中止 {e}"))?;
    match &result {
        Ok(r) => tracing::info!(
            target: "tts",
            chars,
            rate,
            kb = r.base64.as_ref().map_or(0, |b| b.len()) / 1024,
            ms = t0.elapsed().as_millis() as u64,
            "合成完成"
        ),
        Err(e) => tracing::warn!(target: "tts", chars, error = %e, "合成失败"),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_xml_covers_attribute_breaking_chars() {
        assert_eq!(escape_xml("a<b>&\"c'"), "a&lt;b&gt;&amp;&quot;c&apos;");
        assert_eq!(escape_xml("普通文本"), "普通文本");
    }

    #[test]
    fn ssml_wraps_text_and_clamps_rate() {
        let s = build_ssml("hi", "en-US", 9.0);
        assert!(s.contains("rate=\"1.50\""), "越界语速被夹到上限: {s}");
        assert!(s.contains("xml:lang=\"en-US\""));
        assert!(s.ends_with(">hi</prosody></speak>"));
        // 空语言回退 en-US（xml:lang 不能为空）
        assert!(build_ssml("hi", "", 1.0).contains("xml:lang=\"en-US\""));
    }
}
