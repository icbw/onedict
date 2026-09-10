//!  AI 管线：自研多协议流式薄层（不引 AI SDK 编排框架）。
//!
//! 选型决策：协议面只有聊天补全与 models 两个端点，自写
//! 百行内可控且零重依赖；协议行为基线 pickdict aiStream.ts（MIT 白名单）。
//!
//! 传输层放 Rust（前端 fetch 受 CORS 限制，多数网关不发 CORS 头）：reqwest 流式拉取
//! + 手工 SSE 解析 + `tauri::ipc::Channel` 增量回传（Tauri 2 官方流式通道）。
//!
//! API 协议类型（ProviderConfig.api_type，值对齐 cherry ENDPOINT_TYPE
//! 聊天三形态——「OpenAI 兼容」并非单一协议，端点真实兼容语义必须写清可选）：
//! - `openai-chat-completions`（默认）：POST {endpoint}/chat/completions
//!   （DeepSeek / Qwen / GLM / 火山方舟等兼容网关通用形态）
//! - `openai-responses`：POST {endpoint}/responses（OpenAI Responses API，
//!   system 消息映射 instructions，SSE 事件 response.output_text.delta）
//! - `anthropic-messages`：POST {endpoint}/v1/messages（Anthropic Messages 兼容，
//!   x-api-key + anthropic-version 头，system 单独字段，max_tokens 必填，
//!   SSE 事件 content_block_delta；DeepSeek 官方另提供 {base}/anthropic 兼容端点）
//!
//! 非思考模式（noThink）：OpenAI 兼容生态无统一「关思考」参数，适配层同时携带各家
//! 广为支持的形态——`reasoning_effort`(OpenAI) / `enable_thinking`(Qwen·vLLM) /
//! `reasoning`(OpenRouter) / `thinking`(智谱系)；严格网关（如 OpenAI 官方）会对未知
//! 参数回 400，此时按错误体特征**剥除思考参数重试一次**（记日志，同一请求只重试一回）。
//! anthropic 协议思考默认即关（不发 thinking 参数即非思考），无需参数适配。

use std::sync::{Mutex, OnceLock};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// 流式事件（Channel 回传；serde tag=type，camelCase）
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiStreamEvent {
    Delta { text: String },
    Done,
    Error { message: String },
}

/// 消息（前端入参 + 请求体两用）。images 非空 = 多模态消息（content 为提示文本
/// 部分，images 为图片 data URL）；各协议 body 构造时转换为对应 parts 格式。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
}

/// openai-chat-completions 消息：无图 = 纯文本 content（兼容旧端点）；有图 =
/// content parts（text + image_url，data URL 直传）
fn openai_chat_message(m: &ChatMessage) -> serde_json::Value {
    if m.images.is_empty() {
        serde_json::json!({ "role": m.role, "content": m.content })
    } else {
        let mut parts = vec![serde_json::json!({ "type": "text", "text": m.content })];
        for url in &m.images {
            parts.push(serde_json::json!({
                "type": "image_url",
                "image_url": { "url": url }
            }));
        }
        serde_json::json!({ "role": m.role, "content": parts })
    }
}

/// openai-responses 消息：image 部分为 input_image（url 顶层字段）
fn responses_message(m: &ChatMessage) -> serde_json::Value {
    if m.images.is_empty() {
        serde_json::json!({ "role": m.role, "content": m.content })
    } else {
        let mut parts = vec![serde_json::json!({ "type": "input_text", "text": m.content })];
        for url in &m.images {
            parts.push(serde_json::json!({ "type": "input_image", "image_url": url }));
        }
        serde_json::json!({ "role": m.role, "content": parts })
    }
}

/// data URL 解析（"data:image/jpeg;base64,XXXX" → (media_type, base64)）；非
/// data URL 原样按 jpeg 处理（调用方保证传 data URL）
fn parse_data_url(url: &str) -> (String, &str) {
    if let Some(rest) = url.strip_prefix("data:") {
        if let Some((meta, data)) = rest.split_once(",") {
            let media = meta
                .strip_suffix(";base64")
                .unwrap_or(meta)
                .trim()
                .to_string();
            return (if media.is_empty() { "image/jpeg".into() } else { media }, data);
        }
    }
    ("image/jpeg".into(), url)
}

/// anthropic-messages 消息：image 部分为 base64 source 块（media_type + data）
fn anthropic_message(m: &ChatMessage) -> serde_json::Value {
    if m.images.is_empty() {
        serde_json::json!({ "role": m.role, "content": m.content })
    } else {
        let mut blocks = vec![serde_json::json!({ "type": "text", "text": m.content })];
        for url in &m.images {
            let (media, data) = parse_data_url(url);
            blocks.push(serde_json::json!({
                "type": "image",
                "source": { "type": "base64", "media_type": media, "data": data }
            }));
        }
        serde_json::json!({ "role": m.role, "content": blocks })
    }
}

/// 取消语义（修订）：已请求取消的 req_id 列表；流循环每 chunk 前
/// 比对，流结束（完成/出错/取消）时移除复位。原单 AtomicU64 槽位设计下多流取消
/// 互相覆盖、且取消后不复位（同 id 复用误判）。
/// 用 Vec 而非 HashSet：static 需要 const 构造（HashSet::new 非 const），
/// 并发流个位数量级，线性查找无性能差异。
static CANCELLED: Mutex<Vec<u64>> = Mutex::new(Vec::new());

/// SSE 行缓冲上限（1MB）：正常单个 delta JSON < 64KB；无 \n 的流（故障/恶意服务端）
/// 此前可无界增长直至 OOM。
const MAX_SSE_BUF: usize = 1024 * 1024;
/// 单次 read 空闲超时：服务端挂起不吐 chunk 时终结流（SSE 不能用总超时——长回答
/// 会被整体误杀；read_timeout 只惩罚「连接空闲」）。
const SSE_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .read_timeout(SSE_READ_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

#[tauri::command]
pub fn ai_stream_cancel(req_id: u64) {
    let mut list = CANCELLED.lock().unwrap_or_else(|e| e.into_inner());
    if !list.contains(&req_id) {
        list.push(req_id);
    }
}

#[derive(Serialize)]
struct ChatBody {
    model: String,
    /// 已转换为 openai-chat parts 格式的消息（多模态 = content parts 数组）
    messages: Vec<serde_json::Value>,
    stream: bool,
    /// noThink 适配参数组（None = 不携带，尊重模型默认行为）
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enable_thinking: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<serde_json::Value>,
}

fn build_body(model: &str, messages: &[ChatMessage], no_think: bool) -> ChatBody {
    let (reasoning_effort, enable_thinking, reasoning, thinking) = if no_think {
        (
            Some("minimal"),
            Some(false),
            Some(serde_json::json!({ "enabled": false, "exclude": true })),
            Some(serde_json::json!({ "type": "disabled" })),
        )
    } else {
        (None, None, None, None)
    };
    ChatBody {
        model: model.to_string(),
        messages: messages.iter().map(openai_chat_message).collect(),
        stream: true,
        reasoning_effort,
        enable_thinking,
        reasoning,
        thinking,
    }
}

/// API 协议类型（ProviderConfig.api_type → 请求/SSE 解析分支）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ApiKind {
    /// POST {base}/chat/completions（默认；OpenAI 兼容网关通用）
    OpenAiChat,
    /// POST {base}/responses（OpenAI Responses API）
    OpenAiResponses,
    /// POST {base}/v1/messages（Anthropic Messages 兼容）
    Anthropic,
}

fn api_kind(api_type: &str) -> ApiKind {
    match api_type {
        "openai-responses" => ApiKind::OpenAiResponses,
        "anthropic-messages" => ApiKind::Anthropic,
        _ => ApiKind::OpenAiChat,
    }
}

/// system 消息拼接（responses → instructions / anthropic → system；多个合并）
fn join_system(messages: &[ChatMessage]) -> Option<String> {
    let parts: Vec<&str> = messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| m.content.as_str())
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

/// OpenAI Responses API 请求体：system → instructions，其余 → input[]
fn build_responses_body(model: &str, messages: &[ChatMessage], no_think: bool) -> serde_json::Value {
    let input: Vec<serde_json::Value> = messages
        .iter()
        .filter(|m| m.role != "system")
        .map(responses_message)
        .collect();
    let mut body = serde_json::json!({
        "model": model,
        "input": input,
        "stream": true,
    });
    if let Some(instructions) = join_system(messages) {
        body["instructions"] = serde_json::json!(instructions);
    }
    // noThink：Responses API 关思考 = reasoning.effort minimal（网关不认时剥参重试）
    if no_think {
        body["reasoning"] = serde_json::json!({ "effort": "minimal" });
    }
    body
}

/// Anthropic Messages 请求体：system 单独字段、messages 只收 user/assistant、
/// max_tokens 必填（取宽裕默认 8192）；思考默认即关，不携带 thinking 参数
fn build_anthropic_body(model: &str, messages: &[ChatMessage]) -> serde_json::Value {
    let msgs: Vec<serde_json::Value> = messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .map(anthropic_message)
        .collect();
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": 8192,
        "stream": true,
        "messages": msgs,
    });
    if let Some(system) = join_system(messages) {
        body["system"] = serde_json::json!(system);
    }
    body
}

/// 按协议构造请求（url + headers + body）。api_key：openai 系 Bearer，anthropic x-api-key。
fn build_request(
    kind: ApiKind,
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    messages: &[ChatMessage],
    no_think: bool,
) -> (String, reqwest::RequestBuilder) {
    let base = endpoint.trim().trim_end_matches('/');
    match kind {
        ApiKind::OpenAiChat => {
            let url = format!("{base}/chat/completions");
            let mut req = client().post(&url).json(&build_body(model, messages, no_think));
            if let Some(k) = api_key.filter(|k| !k.trim().is_empty()) {
                req = req.bearer_auth(k);
            }
            (url, req)
        }
        ApiKind::OpenAiResponses => {
            let url = format!("{base}/responses");
            let mut req = client()
                .post(&url)
                .json(&build_responses_body(model, messages, no_think));
            if let Some(k) = api_key.filter(|k| !k.trim().is_empty()) {
                req = req.bearer_auth(k);
            }
            (url, req)
        }
        ApiKind::Anthropic => {
            // base 已带 /v1 结尾时防重复拼接
            let base = base.strip_suffix("/v1").unwrap_or(base);
            let url = format!("{base}/v1/messages");
            let mut req = client()
                .post(&url)
                .header("anthropic-version", "2023-06-01")
                .json(&build_anthropic_body(model, messages));
            if let Some(k) = api_key.filter(|k| !k.trim().is_empty()) {
                req = req.header("x-api-key", k);
            }
            (url, req)
        }
    }
}

/// 错误体是否提及思考参数（400 剥参重试的判定依据）
fn mentions_think_params(body: &str) -> bool {
    let lower = body.to_lowercase();
    ["reasoning_effort", "enable_thinking", "reasoning", "thinking"]
        .iter()
        .any(|k| lower.contains(k))
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

/// SSE 行解析（纯函数，单测覆盖）。`data: [DONE]`（openai 系结束标记）按协议处理：
/// chat/completions 结束；responses/anthropic 无 [DONE]，靠各自的完成事件。
enum SseLine {
    Delta(String),
    Done,
    Ignore,
}

fn parse_sse_line(line: &str, kind: ApiKind) -> SseLine {
    let trimmed = line.trim();
    let Some(data) = trimmed.strip_prefix("data:") else {
        return SseLine::Ignore;
    };
    let data = data.trim();
    if data == "[DONE]" {
        // Anthropic 不用 [DONE]（保留防御：当作结束不致挂流）
        return SseLine::Done;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
        return SseLine::Ignore;
    };
    match kind {
        ApiKind::OpenAiChat => {
            // reasoning_content/reasoning 等思考字段天然不读，不回传
            let delta = v["choices"][0]["delta"]["content"].as_str().unwrap_or("");
            if delta.is_empty() {
                SseLine::Ignore
            } else {
                SseLine::Delta(delta.to_string())
            }
        }
        ApiKind::OpenAiResponses => {
            // {"type":"response.output_text.delta","delta":"…"} /
            // {"type":"response.completed", …}
            match v["type"].as_str() {
                Some("response.output_text.delta") => {
                    let delta = v["delta"].as_str().unwrap_or("");
                    if delta.is_empty() {
                        SseLine::Ignore
                    } else {
                        SseLine::Delta(delta.to_string())
                    }
                }
                Some("response.completed") | Some("response.incomplete") => SseLine::Done,
                _ => SseLine::Ignore,
            }
        }
        ApiKind::Anthropic => {
            // {"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}} /
            // {"type":"message_stop"}
            match v["type"].as_str() {
                Some("content_block_delta") => {
                    let delta = v["delta"]["text"].as_str().unwrap_or("");
                    if delta.is_empty() {
                        SseLine::Ignore
                    } else {
                        SseLine::Delta(delta.to_string())
                    }
                }
                Some("message_stop") => SseLine::Done,
                _ => SseLine::Ignore,
            }
        }
    }
}

/// content 通用取文本：string 直返；parts 数组拼 text/output_text 部分
/// （anthropic 非流式文本块 type=text，responses 为 output_text）
fn parts_text(v: &serde_json::Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string()).filter(|s| !s.trim().is_empty());
    }
    let arr = v.as_array()?;
    let mut out = String::new();
    for p in arr {
        if matches!(p["type"].as_str(), Some("text") | Some("output_text")) {
            if let Some(s) = p["text"].as_str() {
                out.push_str(s);
            }
        }
    }
    Some(out).filter(|s| !s.trim().is_empty())
}

/// 非流式 JSON 兜底解析：部分端点/专用模型（OCR 模型常见）不支持 stream=true，
/// 200 返回整体 JSON（无 data: 前缀）——SSE 行解析全 Ignore = 正文空静默失败。
/// 流结束仍无正文 delta 时按响应体整体解析三协议正文；思考字段
/// （reasoning_content / thinking）一律不取。
fn extract_nonstream_text_from(raw: &[u8], kind: ApiKind) -> Option<String> {
    let v = serde_json::from_slice::<serde_json::Value>(raw).ok()?;
    extract_nonstream_text(&v, kind)
}

fn extract_nonstream_text(v: &serde_json::Value, kind: ApiKind) -> Option<String> {
    match kind {
        // {"choices":[{"message":{"content":"…"}}]}
        ApiKind::OpenAiChat => {
            let msg = v["choices"].as_array()?.first()?;
            parts_text(&msg["message"]["content"])
        }
        // {"output":[{"type":"message","content":[{"type":"output_text","text":"…"}]}]}
        // （部分实现提供便捷聚合字段 output_text）
        ApiKind::OpenAiResponses => {
            if let Some(s) = v["output_text"].as_str() {
                return Some(s.to_string()).filter(|s| !s.trim().is_empty());
            }
            let mut out = String::new();
            for item in v["output"].as_array()? {
                if item["type"].as_str() == Some("message") {
                    if let Some(t) = parts_text(&item["content"]) {
                        out.push_str(&t);
                    }
                }
            }
            Some(out).filter(|s| !s.trim().is_empty())
        }
        // {"content":[{"type":"text","text":"…"}]}
        ApiKind::Anthropic => parts_text(&v["content"]),
    }
}

/// 流结束统一收尾：有正文 = 正常 Done；无正文先尝试非流式 JSON 兜底（整体响应
/// 直发 Delta+Done）；仍无正文发诊断 Error（可能仅输出思考字段/不支持流式）。
/// 前端 settled（abort/error 竞态）后事件自动忽略，取消场景复用安全。
async fn finish_stream(raw: &[u8], got_text: bool, kind: ApiKind, on: &Channel<AiStreamEvent>) {
    if got_text {
        let _ = on.send(AiStreamEvent::Done);
        return;
    }
    if let Some(text) = extract_nonstream_text_from(raw, kind) {
        tracing::info!(target: "ai", "端点返回非流式 JSON 响应，兜底解析正文");
        let _ = on.send(AiStreamEvent::Delta { text });
        let _ = on.send(AiStreamEvent::Done);
        return;
    }
    let _ = on.send(AiStreamEvent::Error {
        message: "模型未返回文本内容（可能仅输出思考字段，或端点不支持流式返回了无法解析的响应）——请更换模型或检查端点兼容性".into(),
    });
}

/// 流式调用（按激活卡 api_type 选协议）。端点/Key/协议取激活 provider 卡，
/// model 缺省用全局默认模型（可动作级覆盖），noThink 由调用方按场景开关算好传入
/// （缺省 true 保守非思考——场景开关 && 卡能力的判定在前端 aiConfig 统一）。
/// 配置缺失 / 请求失败 → Err（前端 catch）；流中断 → Error 事件。
#[tauri::command]
pub async fn ai_stream(
    req_id: u64,
    messages: Vec<ChatMessage>,
    model: Option<String>,
    no_think: Option<bool>,
    provider: Option<String>,
    on: Channel<AiStreamEvent>,
) -> Result<(), String> {
    let prefs = crate::prefs::ai();
    // 卡路由（AI 词典跨卡选模型）：provider 缺省用激活卡；显式指定则用该卡
    // （模型绑定卡——「model · 卡名」下拉的请求侧对齐，不动全局激活卡）
    let active = provider
        .as_deref()
        .and_then(|id| prefs.providers.iter().find(|c| c.id == id))
        .or_else(|| prefs.active_config());
    let endpoint = active
        .map(|c| c.endpoint.clone())
        .filter(|s| !s.trim().is_empty())
        .ok_or("未配置 AI 端点（设置 → 模型服务）")?;
    let api_key = active.and_then(|c| c.api_key.clone());
    let kind = api_kind(active.map(|c| c.api_type.as_str()).unwrap_or_default());
    // 思考决策（场景化）：前端传「场景开关 && 卡能力」的结果；
    // 缺省 true = 保守非思考（快响应语义）
    let no_think = no_think.unwrap_or(true);
    let model = model
        .or(prefs.model)
        .filter(|s| !s.trim().is_empty())
        .ok_or("未配置模型（设置 → 模型服务）")?;

    let (url, req) = build_request(
        kind,
        &endpoint,
        api_key.as_deref(),
        &model,
        &messages,
        no_think,
    );
    tracing::debug!(target: "ai", %url, ?kind, no_think, "AI 请求");
    let mut resp = req.send().await.map_err(|e| format!("AI 请求失败: {e}"))?;

    // 严格网关拒绝思考参数 → 剥参重试一次（仅 openai 系 + noThink 且错误体提及思考参数；
    // anthropic 默认即非思考、不携带参数，无此重试路径）
    if resp.status() == reqwest::StatusCode::BAD_REQUEST
        && no_think
        && kind != ApiKind::Anthropic
    {
        let text = resp.text().await.unwrap_or_default();
        if mentions_think_params(&text) {
            tracing::info!(target: "ai", "网关拒绝思考参数，剥除后重试一次");
            let (_, plain) = build_request(
                kind,
                &endpoint,
                api_key.as_deref(),
                &model,
                &messages,
                false,
            );
            resp = plain
                .send()
                .await
                .map_err(|e| format!("AI 请求失败: {e}"))?;
        } else {
            return Err(format!("AI 请求失败（400）: {}", truncate(&text, 300)));
        }
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "AI 请求失败（{status}）: {}",
            truncate(&text, 300)
        ));
    }

    // SSE 流式解析：bytes 缓冲按 \n 切完整行（防跨 chunk 截断多字节
    // 字符）。流体包独立 async 块——全部出口统一走取消集合复位；buf 设上限防 OOM。
    // 模型适配：raw 同步累积原始响应体——流结束仍无正文 delta 时按
    // 整体 JSON 兜底解析（部分端点/OCR 专用模型不支持 stream=true）；仍无正文发
    // 诊断 Error，不再静默空结果。
    let result: Result<(), String> = async move {
        let mut stream = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        let mut raw: Vec<u8> = Vec::new();
        let mut got_text = false;
        loop {
            if CANCELLED
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains(&req_id)
            {
                tracing::debug!(target: "ai", req_id, "流式请求已取消");
                break;
            }

            let chunk = match stream.next().await {
                Some(Ok(b)) => b,
                Some(Err(e)) => {
                    let _ = on.send(AiStreamEvent::Error {
                        message: format!("连接中断: {e}"),
                    });
                    return Ok(());
                }
                None => break,
            };
            if buf.len() + chunk.len() > MAX_SSE_BUF {
                tracing::warn!(target: "ai", req_id, "SSE 缓冲超限，终止流");
                let _ = on.send(AiStreamEvent::Error {
                    message: "响应缓冲超限，连接已终止".into(),
                });
                return Ok(());
            }
            buf.extend_from_slice(&chunk);
            if raw.len() + chunk.len() <= MAX_SSE_BUF {
                raw.extend_from_slice(&chunk);
            }
            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = buf.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line[..line.len() - 1]);
                match parse_sse_line(line.trim_end_matches('\r'), kind) {
                    SseLine::Delta(text) => {
                        got_text = true;
                        let _ = on.send(AiStreamEvent::Delta { text });
                    }
                    SseLine::Done => {
                        finish_stream(&raw, got_text, kind, &on).await;
                        return Ok(());
                    }
                    SseLine::Ignore => {}
                }
            }
        }
        finish_stream(&raw, got_text, kind, &on).await;
        Ok(())
    }
    .await;
    CANCELLED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|&id| id != req_id);
    result
}

#[derive(Deserialize)]
struct ModelsResp {
    #[serde(default)]
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

/// 拉取模型列表（openai 系 GET {base}/models Bearer；anthropic GET {base}/v1/models
/// x-api-key + anthropic-version——两者响应同形 {data:[{id}]}）。参数化直传端点/Key/
/// 协议——模型卡弹窗内对未保存的草稿配置即可检测 Key / 拉取列表。
#[tauri::command]
pub async fn ai_models(
    endpoint: String,
    api_key: Option<String>,
    api_type: Option<String>,
) -> Result<Vec<String>, String> {
    let endpoint = endpoint.trim().to_string();
    if endpoint.is_empty() {
        return Err("请先填写 AI 端点".into());
    }
    // scheme 白名单：拒绝 ftp/file 等协议形态。注意不拒绝内网/
    // 回环——Ollama / LM Studio 等本地模型（http://127.0.0.1:11434）是真实用户
    // 场景；调用方收紧来源校验后只剩设置页 UI（本机用户）。
    if !(endpoint.starts_with("http://") || endpoint.starts_with("https://")) {
        return Err("AI 端点须为 http(s) URL".into());
    }
    let kind = api_kind(api_type.as_deref().unwrap_or_default());
    let base = endpoint.trim_end_matches('/');
    let req = match kind {
        ApiKind::Anthropic => {
            let base = base.strip_suffix("/v1").unwrap_or(base);
            let mut req = client()
                .get(format!("{base}/v1/models"))
                .header("anthropic-version", "2023-06-01");
            if let Some(k) = api_key.as_deref().filter(|s| !s.trim().is_empty()) {
                req = req.header("x-api-key", k);
            }
            req
        }
        _ => {
            let mut req = client().get(format!("{base}/models"));
            if let Some(k) = api_key.as_deref().filter(|s| !s.trim().is_empty()) {
                req = req.bearer_auth(k);
            }
            req
        }
    };
    let resp = req.send().await.map_err(|e| format!("连接失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("获取模型列表失败（{}）", resp.status()));
    }
    let parsed: ModelsResp = resp.json().await.map_err(|e| format!("响应解析失败: {e}"))?;
    let mut ids: Vec<String> = parsed.data.into_iter().map(|m| m.id).collect();
    ids.sort();
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_delta_and_done() {
        let line = r#"data: {"choices":[{"delta":{"content":"你好"}}]}"#;
        assert!(matches!(parse_sse_line(line, ApiKind::OpenAiChat), SseLine::Delta(t) if t == "你好"));
        assert!(matches!(parse_sse_line("data: [DONE]", ApiKind::OpenAiChat), SseLine::Done));
    }

    #[test]
    fn sse_ignores_noise_and_thinking_fields() {
        // 注释 / 事件头 / 空行
        assert!(matches!(parse_sse_line(": keep-alive", ApiKind::OpenAiChat), SseLine::Ignore));
        assert!(matches!(parse_sse_line("event: ping", ApiKind::OpenAiChat), SseLine::Ignore));
        assert!(matches!(parse_sse_line("", ApiKind::OpenAiChat), SseLine::Ignore));
        // 思考增量（reasoning_content）不进正文
        let think = r#"data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}"#;
        assert!(matches!(parse_sse_line(think, ApiKind::OpenAiChat), SseLine::Ignore));
        // role-only 首帧（content 缺省）
        let role = r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#;
        assert!(matches!(parse_sse_line(role, ApiKind::OpenAiChat), SseLine::Ignore));
        // 非 JSON data 行忽略
        assert!(matches!(parse_sse_line("data: hello", ApiKind::OpenAiChat), SseLine::Ignore));
    }

    #[test]
    fn sse_responses_events() {
        let delta = r#"data: {"type":"response.output_text.delta","delta":"你好"}"#;
        assert!(matches!(parse_sse_line(delta, ApiKind::OpenAiResponses), SseLine::Delta(t) if t == "你好"));
        let done = r#"data: {"type":"response.completed","response":{}}"#;
        assert!(matches!(parse_sse_line(done, ApiKind::OpenAiResponses), SseLine::Done));
        // 其他事件（创建/进行中）忽略
        let created = r#"data: {"type":"response.created","response":{}}"#;
        assert!(matches!(parse_sse_line(created, ApiKind::OpenAiResponses), SseLine::Ignore));
    }

    #[test]
    fn sse_anthropic_events() {
        let delta = r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}"#;
        assert!(matches!(parse_sse_line(delta, ApiKind::Anthropic), SseLine::Delta(t) if t == "你好"));
        let done = r#"data: {"type":"message_stop"}"#;
        assert!(matches!(parse_sse_line(done, ApiKind::Anthropic), SseLine::Done));
        // thinking_delta / ping 等忽略
        let think = r#"data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"…"}}"#;
        assert!(matches!(parse_sse_line(think, ApiKind::Anthropic), SseLine::Ignore));
    }

    #[test]
    fn body_no_think_params() {
        let msgs = vec![ChatMessage { role: "user".into(), content: "hi".into(), ..Default::default() }];
        let off = build_body("m", &msgs, false);
        assert!(off.reasoning_effort.is_none());
        let on = build_body("m", &msgs, true);
        assert_eq!(on.reasoning_effort, Some("minimal"));
        assert_eq!(on.enable_thinking, Some(false));
        // serde：noThink=false 时四参数不序列化
        let text = serde_json::to_string(&off).unwrap();
        assert!(!text.contains("reasoning"));
        let text_on = serde_json::to_string(&on).unwrap();
        assert!(text_on.contains("reasoning_effort"));
        assert!(text_on.contains("enable_thinking"));
    }

    #[test]
    fn responses_and_anthropic_bodies() {
        let msgs = vec![
            ChatMessage { role: "system".into(), content: "系统提示".into(), ..Default::default() },
            ChatMessage { role: "user".into(), content: "hi".into(), ..Default::default() },
        ];
        let rb = build_responses_body("m", &msgs, true);
        assert_eq!(rb["instructions"], "系统提示");
        assert_eq!(rb["input"][0]["role"], "user");
        assert_eq!(rb["reasoning"]["effort"], "minimal");
        let rb2 = build_responses_body("m", &msgs, false);
        assert!(rb2.get("reasoning").is_none());

        let ab = build_anthropic_body("m", &msgs);
        assert_eq!(ab["system"], "系统提示");
        assert_eq!(ab["max_tokens"], 8192);
        assert_eq!(ab["messages"][0]["role"], "user");
        assert!(ab.get("thinking").is_none(), "anthropic 默认非思考：不携带 thinking 参数");
    }

    #[test]
    fn request_urls_by_protocol() {
        let msgs = vec![ChatMessage { role: "user".into(), content: "hi".into(), ..Default::default() }];
        // openai 系直接拼端点路径
        let (url, _) = build_request(ApiKind::OpenAiChat, "https://api.x.com/v1", None, "m", &msgs, true);
        assert_eq!(url, "https://api.x.com/v1/chat/completions");
        let (url, _) = build_request(ApiKind::OpenAiResponses, "https://api.x.com/v1", None, "m", &msgs, true);
        assert_eq!(url, "https://api.x.com/v1/responses");
        // anthropic：base 尾部 /v1 防重复 + 固定 /v1/messages
        let (url, _) = build_request(ApiKind::Anthropic, "https://api.anthropic.com", None, "m", &msgs, true);
        assert_eq!(url, "https://api.anthropic.com/v1/messages");
        let (url, _) = build_request(ApiKind::Anthropic, "https://api.deepseek.com/anthropic", None, "m", &msgs, true);
        assert_eq!(url, "https://api.deepseek.com/anthropic/v1/messages");
        let (url, _) = build_request(ApiKind::Anthropic, "https://api.x.com/v1/", None, "m", &msgs, true);
        assert_eq!(url, "https://api.x.com/v1/messages");
    }

    #[test]
    fn mentions_think_params_detection() {
        assert!(mentions_think_params("Unrecognized request argument: enable_thinking"));
        assert!(mentions_think_params(r#"{"error":{"message":"reasoning_effort is not supported"}}"#));
        assert!(!mentions_think_params(r#"{"error":{"message":"invalid api key"}}"#));
    }

    #[test]
    fn nonstream_fallback_extraction() {
        // openai-chat：message.content 字符串
        let chat = r#"{"choices":[{"message":{"role":"assistant","content":"你好世界"}}]}"#;
        assert_eq!(
            extract_nonstream_text_from(chat.as_bytes(), ApiKind::OpenAiChat).as_deref(),
            Some("你好世界")
        );
        // openai-chat：message.content parts 数组
        let chat_parts = r#"{"choices":[{"message":{"content":[{"type":"text","text":"A"},{"type":"text","text":"B"}]}}]}"#;
        assert_eq!(
            extract_nonstream_text_from(chat_parts.as_bytes(), ApiKind::OpenAiChat).as_deref(),
            Some("AB")
        );
        // 思考字段不误取（正文空 = None，思考不进正文）
        let chat_think = r#"{"choices":[{"message":{"reasoning_content":"思考","content":""}}]}"#;
        assert_eq!(extract_nonstream_text_from(chat_think.as_bytes(), ApiKind::OpenAiChat), None);
        // responses：output[] 标准结构与便捷聚合字段
        let resp = r#"{"output":[{"type":"message","content":[{"type":"output_text","text":"R"}]}]}"#;
        assert_eq!(
            extract_nonstream_text_from(resp.as_bytes(), ApiKind::OpenAiResponses).as_deref(),
            Some("R")
        );
        let resp_short = r#"{"output_text":"R2"}"#;
        assert_eq!(
            extract_nonstream_text_from(resp_short.as_bytes(), ApiKind::OpenAiResponses).as_deref(),
            Some("R2")
        );
        // anthropic：content[] text 块
        let anth = r#"{"content":[{"type":"text","text":"hi"}]}"#;
        assert_eq!(
            extract_nonstream_text_from(anth.as_bytes(), ApiKind::Anthropic).as_deref(),
            Some("hi")
        );
        // 非 JSON（正常 SSE 流累积体）= None（走诊断 Error 而非误取）
        assert_eq!(extract_nonstream_text_from(b"data: [DONE]\n\n", ApiKind::OpenAiChat), None);
    }
}
