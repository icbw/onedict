//! 生词卡卡面数据（EntryCard）：词典释义复用 + AI 兜底，前端管线组装。
//!
//! 职责划分：卡面内容由**主窗口前端管线**生产（`services/vocabCard.ts`——在线
//! 词典引擎结构化输出（bing/youdao/cambridge）+ 本地 O8C 提取 + AI 兜底与原句
//! 对译；在线词典解析与 AI 流式基建都在前端），Rust 负责触发与落盘：
//! - 触发：`vocabulary_add` 成功 / `vocabulary_card_generate`（手动重试）→
//!   emit `vocabulary-card-request`，主窗口前端监听执行（面板窗口短生命周期，
//!   不能作为执行体）；
//! - 落盘：`vocabulary_card_set` → 清洗截断 → persist → `vocabulary-card` 回灌。
//!
//! 边界：语境义（EntrySense）与原句（EntryContext）永远来自真实语境；释义/例句
//! 优先复用词典内容（source 记录来源词典 id），AI 仅在词典源全空时兜底
//! （per-item source = "ai"，卡面明确标注）。

use serde::{Deserialize, Serialize};

/// 释义条数上限（卡面 340px 高的密度约束）
pub const SENSES_MAX: usize = 5;
/// 独立例句条数上限（词典例句区）
const SENTENCES_MAX: usize = 3;
const POS_MAX_CHARS: usize = 16;
const DEFINITION_MAX_CHARS: usize = 120;
const EXAMPLE_MAX_CHARS: usize = 240;
const PHONETIC_MAX_CHARS: usize = 64;
/// 对齐 EntryContext 句长上限（对译与原句长期驻留复习卡与备份）
const SENTENCE_ZH_MAX_CHARS: usize = 500;

/// 一条常用释义（卡面「常用释义」区）。definition 为中文释义（中文向源优先），
/// definition_en 为英文定义（双解词典才有）；example 为义项绑定例句。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CardSense {
    /// 词性 / 标签（n. / v. / 网络 …；None = 未标注）
    pub pos: Option<String>,
    /// 释义（复用词典内容；AI 兜底条目为 AI 生成）
    pub definition: String,
    /// 英文定义（O8C / 剑桥等双解源）
    pub definition_en: Option<String>,
    /// 义项绑定例句（O8C 例证 / 剑桥 def-block）
    pub example: Option<String>,
    /// 例句中文对译
    pub example_zh: Option<String>,
    /// 来源词典 id（"O8C" / "web-cambridge" / "web-bing" / "web-youdao" / "ai"）
    pub source: Option<String>,
}

/// 词典独立例句区的例句（原文 + 对译；非义项绑定）
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CardSentence {
    pub en: String,
    pub zh: Option<String>,
    pub source: Option<String>,
}

/// 卡面数据：收藏后由前端管线整理（词典复用 + AI 兜底）。材料快照语义
/// （同 EntrySense）——词典文件更新不失效；复习时规则化渲染，任何词（含未收录
/// 词组）都有可复习内容。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EntryCard {
    /// 常用释义（≤5 条，最贴合收藏语境的排前）
    pub senses: Vec<CardSense>,
    /// 词典独立例句（≤3 条）
    pub sentences: Vec<CardSentence>,
    /// 音标（材料可得时；None = 未提取到）
    pub phonetic: Option<String>,
    /// 语境原句的中文对译（无语境 = None；AI 翻译）
    pub sentence_zh: Option<String>,
    /// 主来源（"web" 词典复用 / "ai" AI 生成 / "mixed"；v1 旧数据为 "ai"）
    pub source: String,
    pub generated_at: i64,
}

impl Default for EntryCard {
    fn default() -> Self {
        Self {
            senses: Vec::new(),
            sentences: Vec::new(),
            phonetic: None,
            sentence_zh: None,
            source: "web".to_string(),
            generated_at: 0,
        }
    }
}

/// 卡面整理请求（`vocabulary-card-request` 事件 payload）：主窗口前端管线的
/// 执行凭据。force = 手动重试（覆盖已有卡面）；收藏触发的自动整理 force=false
/// （已有卡面跳过）。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRequest {
    pub id: String,
    #[serde(default)]
    pub force: bool,
}

/// 空白折叠 + 逐字符截断（前端组装的数据同样不可信，入库前统一清洗）
fn clamp_chars(s: &str, max: usize) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

fn clamp_opt(s: &str, max: usize) -> Option<String> {
    let v = clamp_chars(s, max);
    (!v.is_empty()).then_some(v)
}

/// 入库前清洗：空释义过滤、条数钳制、逐字段截断。全空 senses 不报错
/// （上层管线允许纯例句/纯对译的卡面，但正常管线应保证至少一条释义）。
pub(crate) fn sanitize_card(mut card: EntryCard) -> EntryCard {
    card.senses = card
        .senses
        .drain(..)
        .take(SENSES_MAX)
        .filter(|s| !s.definition.trim().is_empty())
        .take(SENSES_MAX)
        .map(|s| CardSense {
            pos: s.pos.as_deref().and_then(|p| clamp_opt(p, POS_MAX_CHARS)),
            definition: clamp_chars(&s.definition, DEFINITION_MAX_CHARS),
            definition_en: s.definition_en.as_deref().and_then(|d| clamp_opt(d, DEFINITION_MAX_CHARS)),
            example: s.example.as_deref().and_then(|e| clamp_opt(e, EXAMPLE_MAX_CHARS)),
            example_zh: s.example_zh.as_deref().and_then(|e| clamp_opt(e, EXAMPLE_MAX_CHARS)),
            source: s.source.as_deref().and_then(|c| clamp_opt(c, 64)),
        })
        .collect();
    card.sentences = card
        .sentences
        .drain(..)
        .take(SENTENCES_MAX)
        .filter(|s| !s.en.trim().is_empty())
        .take(SENTENCES_MAX)
        .map(|s| CardSentence {
            en: clamp_chars(&s.en, EXAMPLE_MAX_CHARS),
            zh: s.zh.as_deref().and_then(|z| clamp_opt(z, EXAMPLE_MAX_CHARS)),
            source: s.source.as_deref().and_then(|c| clamp_opt(c, 64)),
        })
        .collect();
    card.phonetic = card.phonetic.as_deref().and_then(|p| clamp_opt(p, PHONETIC_MAX_CHARS));
    card.sentence_zh = card
        .sentence_zh
        .as_deref()
        .and_then(|s| clamp_opt(s, SENTENCE_ZH_MAX_CHARS));
    if card.source.trim().is_empty() {
        card.source = "web".into();
    }
    card
}

/// 触发广播（vocabulary-add / 手动重试 → 主窗口前端管线）
pub(crate) fn broadcast_request(app: &tauri::AppHandle, req: &CardRequest) {
    use tauri::Emitter;
    if let Err(error) = app.emit("vocabulary-card-request", req) {
        tracing::error!(target: "vocabulary", error = %error, "vocabulary-card-request 广播失败");
    }
}

/// 卡面就绪广播（payload = 更新后的完整词条；发起窗口也收到，刷新幂等无害）
pub(crate) fn broadcast_entry(app: &tauri::AppHandle, entry: &super::VocabularyEntry) {
    use tauri::Emitter;
    if let Err(error) = app.emit("vocabulary-card", entry) {
        tracing::error!(target: "vocabulary", error = %error, "vocabulary-card 广播失败");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_card_clamps_and_filters() {
        let long = "词".repeat(300);
        let card = sanitize_card(EntryCard {
            senses: vec![
                CardSense {
                    pos: Some("noun.".into()),
                    definition: long.clone(),
                    definition_en: Some(" x ".into()),
                    example: Some("".into()),
                    example_zh: None,
                    source: Some("O8C".into()),
                },
                CardSense {
                    definition: "   ".into(),
                    ..Default::default()
                },
            ],
            sentences: vec![
                CardSentence { en: long.clone(), zh: Some("中译".into()), source: None },
                CardSentence { en: "".into(), zh: None, source: None },
            ],
            phonetic: Some(long.clone()),
            sentence_zh: Some(long),
            source: "".into(),
            generated_at: 1,
        });
        assert_eq!(card.senses.len(), 1, "空释义过滤");
        assert_eq!(card.senses[0].definition.chars().count(), DEFINITION_MAX_CHARS);
        assert_eq!(card.senses[0].definition_en.as_deref(), Some("x"), "空白折叠");
        assert_eq!(card.senses[0].example, None, "空例句转 None");
        assert_eq!(card.senses[0].pos.as_deref(), Some("noun."));
        assert_eq!(card.sentences.len(), 1, "空例句条过滤");
        assert_eq!(card.sentences[0].en.chars().count(), EXAMPLE_MAX_CHARS);
        assert_eq!(card.phonetic.as_ref().map(|p| p.chars().count()), Some(PHONETIC_MAX_CHARS));
        assert_eq!(card.sentence_zh.as_ref().map(|s| s.chars().count()), Some(300), "短于上限不截断");
        assert_eq!(card.source, "web", "空主来源回默认");
    }

    #[test]
    fn card_schema_serializes_camel_case() {
        // 与 pickdict 互迁零破坏：card 字段缺省 None；camelCase 键名
        let json = r#"{"senses":[{"definition":"碎片","definitionEn":"pieces","source":"O8C"}],"sentences":[],"source":"web","generatedAt":9}"#;
        let card: EntryCard = serde_json::from_str(json).unwrap();
        assert_eq!(card.senses[0].definition_en.as_deref(), Some("pieces"));
        assert_eq!(card.senses[0].pos, None, "缺省字段 → None");
        assert!(card.phonetic.is_none());
        let back = serde_json::to_value(&card).unwrap();
        assert!(back["senses"][0]["definitionEn"].is_string());
    }
}
