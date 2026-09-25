//!  偏好持久化：app_data_dir()/preferences.json 单文件（自写 JSON，
//! 非必要依赖不引入——tauri-plugin-store 对几个字段过重；schema/损坏语义
//! 与 vocabulary 模块同款）。
//!
//! 全局 RwLock 静态（selection / dictionary / 命令三方读取，与 selection::SHARED
//! 同模式）；字段级 setter 各自整文件落盘（规模小，写放大可忽略）。
//!
//! 字段：
//!   dict_root          词典根目录绝对路径；None = dev 探测（cwd 父链找 test/dicts）
//!   selection_enabled  划词开关（默认开）
//!   clipboard_fallback 剪贴板兜底开关（默认开）
//!   clipboard_lookup   剪贴板监听查词（复制即查，默认关）
//!   ai                 AI 服务配置（OpenAI 兼容端点；None = 未配置）
//!   translate_lang     AI 翻译目标语言（pickdict feature.translate.action.preferred_lang 语义）
//!   pronounce          发音（朗读源链 + 系统语音选择；本地 TTS 接入）

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

mod dpapi;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub dict_root: Option<String>,
    pub selection_enabled: bool,
    pub clipboard_fallback: bool,
    /// 剪贴板监听查词：复制即查（默认关——按需开启，避免打扰）
    #[serde(default)]
    pub clipboard_lookup: bool,
    /// 划词栏动作配置（id/启停/搜索引擎；顺序即栏上顺序。None = 前端默认集。
    /// name/icon/ai 依赖由前端内置目录定义，不落盘）
    pub action_items: Option<Vec<ActionItemPref>>,
    /// 词典管理（id/启用；数组序即查询序。None = 全启用按扫描序。
    /// 新发现词典自动追加启用；目录中已删除的条目被忽略）
    pub dict_items: Option<Vec<DictItemPref>>,
    /// AI 服务配置（AI OpenAI 兼容端点。None = 未配置，AI 动作与 AI 词典不可用）
    pub ai: Option<AiPrefs>,
    /// AI 翻译目标语言（语言代码如 zh-cn / en-us；None = 默认 zh-cn）
    pub translate_lang: Option<String>,
    /// 翻译页源语言（自动检测原是死的不许调，改为可指定）：
    /// 语言代码（zh-cn/en-us/…，与 TARGET_LANGS 表一致）；None = 自动检测。
    /// 仅作为翻译提示告知 LLM 原文语言，不参与任何本地识别
    #[serde(default)]
    pub translate_source_lang: Option<String>,
    /// 划词浮标紧凑模式（只显示图标不显示文字，pickdict feature.selection.compact 语义）
    pub toolbar_compact: bool,
    /// 翻译页模型覆盖（None = 用全局默认模型）
    pub translate_model: Option<String>,
    /// 翻译页提示词覆盖（{{target_language}}/{{text}} 占位；None = 内置模板）
    pub translate_prompt: Option<String>,
    /// 翻译页允许思考（默认 false 快响应；实际生效还需激活卡 thinking=true）
    pub translate_allow_think: bool,
    /// 全局快捷键配置（可配置化。None = 全部用内置默认；
    /// 单槽 None = 该槽用默认）。注册在 tray.rs，变更经 prefs_set_hotkeys 参数化重注册。
    pub hotkeys: Option<HotkeysPref>,
    /// 仅本地词典全部未命中才查在线（节能 + 降请求量 + 降封禁风险三合一）。
    /// 在线词典条目并入 dict_items 统一列表（id 前缀 `web-`
    /// 与本地词典并列拖动排序；merged_items 按扫描集过滤非目录条目，dictionary_*
    /// 命令天然不会路由到 web id，在线词典消费方在读取端过滤）
    pub web_fallback_only: bool,
    /// 在线词典词条内真外链的走向：true = 系统浏览器打开
    /// （默认）；false = 转词典内部查词路径（链接提取词，提取不到忽略）。
    /// 内置网页查看器形态因 WebView2 卡死实测废弃，本开关取代之。
    pub web_external: bool,
    /// 学习卡出现时自动发音（生词本重构追加；关闭仍可点卡面发音按钮）
    pub review_auto_pronounce: bool,
    /// 划词触发方式：selected = 拖选/双击即触发（默认）/
    /// ctrlkey = 按住 Ctrl ≥350ms（期间无其他键/滚轮/鼠标按下）捕获当前选区 /
    /// shortcut = 全局快捷键触发（槽位 hotkeys.trigger_lookup，默认未绑定）
    #[serde(default)]
    pub selection_trigger: String,
    /// 划词进程过滤模式：default = 仅预定义黑名单（截图/Office 等
    /// 无需划词且易冲突的程序）/ whitelist = 仅用户列表内程序 / blacklist =
    /// 用户列表 ∪（selected 触发模式下的预定义黑名单）
    #[serde(default)]
    pub selection_filter_mode: String,
    /// 截图翻译源语言提示（引入； 实测⑩语义迁移）：
    /// BCP-47 标签（如 en-US）；空串 = 自动。**只作为翻译提示告知 LLM 原文
    /// 语言（防误判相似语言），不控制 OCR 引擎**——OCR 语言全自动（zh 优先 →
    /// en 补空 → 用户语言兜底）。字段名 ocr_lang 保留不迁移（先例 ocr_lookup）
    #[serde(default)]
    pub ocr_lang: String,
    /// 截图翻译目标语言（实测：与翻译 Tab 的 translateLang 解耦）：
    /// 空串 = 自动（智能方向：中文→英文，其他→中文，前端按识别文本 CJK 占比
    /// 判定）；其他值 = 固定目标语言 code（TARGET_LANGS，如 zh-cn/en-us）
    #[serde(default)]
    pub ocr_target_lang: String,
    /// 截图 AI 图译模型（二期兜底：本地 OCR 失败可选 AI 识别+翻译）：
    /// 格式 `provider_id:model`（跨卡路由，同 dictModel 先例）；空串 = 未设置
    /// （图译按钮点击时前端提示配置）
    #[serde(default)]
    pub ocr_vision_model: String,
    /// 截图后自动系统识别（默认 false = 只截屏钉原位，
    /// 工具条「识别文字」按钮手动触发；true = 保留拖框即识别的原行为）
    #[serde(default)]
    pub ocr_auto_recognize: bool,
    /// 识别后自动翻译（默认 false = 识别后点「译」手动启动；true = 识别
    /// 回填即按偏好目标语言自动启动逐行翻译，语义同手动「译」）
    #[serde(default)]
    pub ocr_auto_translate: bool,
    /// 用户过滤列表（进程名子串匹配，小写存储；仅 whitelist/blacklist 模式消费）
    #[serde(default)]
    pub selection_filter_list: Vec<String>,
    /// 已移除词典（词典删除三语义）：仅删引用时记录 id，
    /// 扫描不再发现（文件保留在磁盘）；换词典根目录时清空（全新视图）
    #[serde(default)]
    pub removed_dicts: Vec<String>,
    /// 启动时检查更新（默认关——无提示的后台请求按需开启；开关只在下次启动生效）
    #[serde(default)]
    pub check_update_on_startup: bool,
    /// 发音（朗读源链 + 系统语音选择；本地 TTS 接入）
    #[serde(default)]
    pub pronounce: PronouncePrefs,
    // ── legacy 字段（反序列化捕获后由 migrate_web_dicts 迁入 dict_items，不再序列化）──
    #[serde(default, skip_serializing)]
    pub web_dicts: Option<Vec<WebDictItemPref>>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            dict_root: None,
            selection_enabled: true,
            clipboard_fallback: true,
            clipboard_lookup: false,
            action_items: None,
            dict_items: None,
            ai: None,
            translate_lang: None,
            translate_source_lang: None,
            toolbar_compact: false,
            translate_model: None,
            translate_prompt: None,
            translate_allow_think: false,
            hotkeys: None,
            web_fallback_only: false,
            web_external: true,
            review_auto_pronounce: false,
            selection_trigger: "selected".into(),
            selection_filter_mode: "default".into(),
            selection_filter_list: Vec::new(),
            removed_dicts: Vec::new(),
            check_update_on_startup: false,
            pronounce: PronouncePrefs::default(),
            ocr_lang: String::new(),
            ocr_target_lang: String::new(),
            ocr_vision_model: String::new(),
            ocr_auto_recognize: false,
            ocr_auto_translate: false,
            web_dicts: None,
        }
    }
}

/// 划词栏动作配置项（对应 pickdict SelectionActionItem 的持久化子集）。
/// name/prompt/model/icon 为自定义 AI 动作字段（id 形如 user-* 时生效，语义对齐
/// pickdict/cherry：name=栏上显示名 / prompt=提示词（{{text}} 占位）/
/// model=动作级模型覆盖 / icon=lucide 图标名）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionItemPref {
    pub id: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_engine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// 允许思考（动作级思考开关 思考语义场景化）：None = 默认非思考；
    /// 实际生效 = 动作开关 && 激活卡「推理模型」标记（卡能力是门禁不是开关）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_think: Option<bool>,
}

/// AI 服务配置（OpenAI 兼容端点）。
/// 安全决策：api_key 与其余偏好同文件落盘（app_data_dir/preferences.json，用户目录
/// ACL 保护）——单用户本机威胁模型下与浏览器保存密码同级，不为此引入 keyring
/// 原生凭据库（非必要依赖不引入）；密钥不出本机，仅本进程读用。
///
/// 结构（模型卡重构）：providers[] 为每家供应商的持久配置（模型卡：
/// 端点/Key/逐模型能力集），顶层只留激活标记与**全局默认模型**（其他功能在
/// 手动选择前默认生效）。legacy 顶层字段（endpoint/apiKey/noThink）反序列化捕获后
/// 由 migrate_legacy 迁入首张卡；卡级 thinking（遗留）由
/// migrate_model_caps 摊平为逐模型能力标记。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AiPrefs {
    /// 当前激活的 provider 预设 id（openai/deepseek/doubao/dashscope/opencode/custom）
    pub provider: Option<String>,
    /// 全局默认模型（划词 AI 动作 / AI 词典 / 翻译页在手动选择前默认生效）
    pub model: Option<String>,
    /// AI 词典：查词结果内置「AI 词典」在线词典形态（配置 AI 后默认启用）
    pub dict_enabled: bool,
    /// AI 词典系统提示词；None = 前端内置默认
    pub dict_prompt: Option<String>,
    /// AI 词典允许思考（思考语义场景化；默认 false 快响应。
    /// 实际生效 = 本开关 && 激活卡 thinking——卡能力是门禁不是开关）
    #[serde(default)]
    pub dict_allow_think: bool,
    /// AI 词典模型（弹窗化：`"{providerId}:{model}"` 绑定卡+模型，
    /// 请求经 ai_stream provider 参数路由该卡；None = 用全局默认模型）
    #[serde(default)]
    pub dict_model: Option<String>,
    /// 每家供应商的持久配置（模型卡）
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
    // ── legacy 字段（反序列化捕获，migrate_legacy 迁移后清空，不再序列化）──
    #[serde(default, skip_serializing)]
    endpoint: Option<String>,
    #[serde(default, skip_serializing)]
    api_key: Option<String>,
    #[serde(default, skip_serializing)]
    no_think: bool,
}

/// 逐模型能力标记条目（模型卡改版：能力从卡级总开关改为逐模型集合）。
/// 能力值约定：thinking = 推理（唯一有运行时效果的思考门禁标记）/ vision = 图片输入
/// （信息标记）/ files = 文件上传（未实现，仅预留标记位）。未知值原样保留不拦截。
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    /// 模型 id（API 调用名，与 /models 返回一致）
    pub id: String,
    /// 能力标记集（空 = 无任何标记 → 思考门禁保守关闭）
    #[serde(default)]
    pub caps: Vec<String>,
}

impl<'de> Deserialize<'de> for ModelEntry {
    /// 兼容旧版（卡级 thinking 时代）models 数组的裸字符串形式：
    /// `"qwen-flash"` → `ModelEntry { id: "qwen-flash", caps: [] }`
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Str(String),
            Obj {
                id: String,
                #[serde(default)]
                caps: Vec<String>,
            },
        }
        match Raw::deserialize(deserializer)? {
            Raw::Str(id) => Ok(ModelEntry { id, caps: Vec::new() }),
            Raw::Obj { id, caps } => Ok(ModelEntry { id, caps }),
        }
    }
}

/// 模型卡：单家供应商的持久配置
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderConfig {
    pub id: String,
    pub endpoint: String,
    #[serde(default)]
    pub api_key: Option<String>,
    /// 已配置模型（拉取列表后添加；逐模型能力标记见 ModelEntry。
    /// 反序列化兼容旧版裸字符串数组——自动转空能力集，迁移见 migrate_model_caps）
    #[serde(default)]
    pub models: Vec<ModelEntry>,
    /// legacy（遗留）卡级思考开关：反序列化捕获，migrate_model_caps
    /// 摊平到逐模型 caps 后清零，不再序列化
    #[serde(default, skip_serializing)]
    thinking: bool,
    /// API 协议类型（值对齐 cherry ENDPOINT_TYPE 的聊天三形态）：
    /// "openai-chat-completions"（默认，POST {endpoint}/chat/completions）/
    /// "openai-responses"（POST {endpoint}/responses）/
    /// "anthropic-messages"（POST {endpoint}/v1/messages，x-api-key 头）
    #[serde(default = "default_api_type")]
    pub api_type: String,
}

fn default_api_type() -> String {
    "openai-chat-completions".into()
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            endpoint: String::new(),
            api_key: None,
            models: Vec::new(),
            thinking: false,
            api_type: default_api_type(),
        }
    }
}

impl Default for AiPrefs {
    fn default() -> Self {
        Self {
            provider: None,
            model: None,
            dict_enabled: true,
            dict_prompt: None,
            dict_allow_think: false,
            dict_model: None,
            providers: Vec::new(),
            endpoint: None,
            api_key: None,
            no_think: false,
        }
    }
}

impl AiPrefs {
    /// 激活 provider 的配置（未找到/未激活 → None）
    pub fn active_config(&self) -> Option<&ProviderConfig> {
        let id = self.provider.as_deref()?;
        self.providers.iter().find(|p| p.id == id)
    }

    /// legacy 顶层字段迁移：providers 为空且旧 endpoint 存在 → 构造首张卡
    /// （id 用旧 provider 标记兜底 custom；旧顶层 noThink=true 语义「关思考」→
    /// 新 thinking=false「非推理模型」等价映射）。迁移后清 legacy 字段。
    fn migrate_legacy(&mut self) {
        if !self.providers.is_empty() || self.endpoint.is_none() {
            self.endpoint = None;
            self.api_key = None;
            return;
        }
        self.providers.push(ProviderConfig {
            id: self.provider.clone().unwrap_or_else(|| "custom".into()),
            endpoint: self.endpoint.take().unwrap_or_default(),
            api_key: self.api_key.take(),
            models: Vec::new(),
            thinking: !self.no_think,
            api_type: default_api_type(),
        });
        self.no_think = false;
    }

    /// 卡级 thinking（遗留 legacy）→ 逐模型能力集：thinking=true 时
    /// 该卡全部已登记模型补 thinking（推理）标记；模型列表为空则无处摊平（标记
    /// 丢失，用户拉取列表后重配）。迁移后卡级字段清零（skip_serializing 不再落盘）。
    /// 幂等：false 即跳过，重复执行无副作用。
    fn migrate_model_caps(&mut self) {
        for card in &mut self.providers {
            if !card.thinking {
                continue;
            }
            for m in &mut card.models {
                if !m.caps.iter().any(|c| c == "thinking") {
                    m.caps.push("thinking".into());
                }
            }
            card.thinking = false;
        }
    }
}

/// 词典管理配置项（统一列表：id = 词典子目录名，或在线词典内置 id（前缀 `web-`，
///与本地词典并列拖动排序；显示名/实现由前端定义，不落盘）。
/// 数组序即查询显示序）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DictItemPref {
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// legacy 在线词典条目（的独立数组； 并入 dictItems 后
/// 仅作反序列化捕获用，迁移清空不再写出）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebDictItemPref {
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// 全局快捷键配置。字符串格式 = tauri-plugin-global-shortcut
/// 解析格式（global-hotkey crate，大小写不敏感，如 "ctrl+alt+d"）；单槽 None/空串 =
/// 用内置默认。注册与冲突处理在 tray::apply_hotkeys（占用时降级告警保留旧键）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HotkeysPref {
    /// 划词开关快捷键
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toggle_selection: Option<String>,
    /// 查词呼出快捷键（显示并聚焦主窗口）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_main: Option<String>,
    /// 划词查词快捷键（触发方式 = shortcut 时捕获当前选区；**无内置默认**，
    /// None/空串 = 不注册，避免无谓占用全局组合键）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_lookup: Option<String>,
    /// OCR 取词快捷键（框选屏幕区域识别；None/空串回内置默认
    /// ctrl+alt+o——OCR 是独立显式入口，与划词触发方式无关）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ocr_lookup: Option<String>,
}

/// 内置默认组合键（历史上硬编码于 tray.rs 的常量，可配置化后为缺省值）
pub const DEFAULT_HOTKEY_TOGGLE_SELECTION: &str = "ctrl+alt+d";
pub const DEFAULT_HOTKEY_SHOW_MAIN: &str = "ctrl+alt+space";
pub const DEFAULT_HOTKEY_OCR_LOOKUP: &str = "ctrl+alt+o";

impl Default for HotkeysPref {
    fn default() -> Self {
        Self {
            toggle_selection: None,
            show_main: None,
            trigger_lookup: None,
            ocr_lookup: None,
        }
    }
}

impl HotkeysPref {
    /// 槽位生效值（None/空串回默认——空串兜底用语义同前端 `||`）
    pub fn toggle_selection(&self) -> &str {
        match self.toggle_selection.as_deref() {
            Some(s) if !s.is_empty() => s,
            _ => DEFAULT_HOTKEY_TOGGLE_SELECTION,
        }
    }

    pub fn show_main(&self) -> &str {
        match self.show_main.as_deref() {
            Some(s) if !s.is_empty() => s,
            _ => DEFAULT_HOTKEY_SHOW_MAIN,
        }
    }

    /// 划词查词槽位（可空：None/空串 = 未绑定，tray 侧跳过注册）
    pub fn trigger_lookup(&self) -> Option<&str> {
        self.trigger_lookup.as_deref().filter(|s| !s.is_empty())
    }

    /// OCR 取词槽位（None/空串回内置默认）
    pub fn ocr_lookup(&self) -> &str {
        match self.ocr_lookup.as_deref() {
            Some(s) if !s.is_empty() => s,
            _ => DEFAULT_HOTKEY_OCR_LOOKUP,
        }
    }
}

/// 发音偏好（本地 TTS 接入）：朗读源链 + 语音选择 + 场景路由。
///
/// 链语义：数组序即优先级，逐项尝试取第一个可用；项缺席 = 停用。
/// 值域：`dict`（本地词典 MDD 录音）/ `webdict`（在线词典音频）/ `edge`（Edge 在线自然
/// 语音）/ `tts`（本地系统语音）。
///
/// 语音选择分两层：
/// 1. **语音槽**（`voice_slots`）——按 `语言-口音-性别` 指定音源，六槽：
///    `zh-f` / `zh-m` / `en-us-f` / `en-us-m` / `en-gb-f` / `en-gb-m`；
///    值 = `local:<语音id>` 或 `edge:<shortName>`。**没有「自动」态**：键缺失即补
///    `default_voice_slots()` 的默认音源，配置始终完整。
/// 2. **朗读按钮**（`say_btn_a` / `say_btn_b`）——并列按钮的英文口音倾向；性别固定
///    （按钮 1 = 女、按钮 2 = 男），无按钮入口按语言 / 口音取女声槽。
/// 槽内音色实际不可用（列表拉取失败 / 语音已卸载 / 引擎不可达）时不另挑同类音色，
/// 由朗读链降级到**本机引擎**（系统语音）兜底。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PronouncePrefs {
    /// 单词发音链（缺省 dict → webdict → edge → tts）
    pub word_chain: Vec<String>,
    /// 句子朗读链（缺省 edge → tts）
    pub sentence_chain: Vec<String>,
    /// 六槽音源（键非法或值非 `local:`/`edge:` 前缀的条目在归一化时丢弃；
    /// 缺槽由 `default_voice_slots()` 补齐）
    #[serde(default)]
    pub voice_slots: std::collections::BTreeMap<String, String>,
    /// 朗读按钮 A 的英文口音倾向（`us` / `gb`）：两个并列按钮（例句 / 译文 /
    /// AI 词典原词旁）的**性别固定**——按钮 1（A）= 女声、按钮 2（B）= 男声，
    /// 这里只选英文的美音 / 英音倾向；中文文本没有口音维度，固定取「中文 ·
    /// 女声 / 男声」槽，与倾向无关。
    #[serde(default)]
    pub say_btn_a: String,
    /// 朗读按钮 B 的英文口音倾向（语义同 A）
    #[serde(default)]
    pub say_btn_b: String,
    /// 英文默认口音（"" = 自动（美音优先）/ "us" / "gb"）
    #[serde(default)]
    pub en_accent: String,
    /// 语速（0.5–1.5；1.0 = 原速）
    pub rate: f32,
    /// 词条无发音资源时自动回退合成语音（合成文本取锚点附近内容，见前端帧脚本）
    pub fallback_missing: bool,
}

impl Default for PronouncePrefs {
    fn default() -> Self {
        Self {
            word_chain: vec!["dict".into(), "webdict".into(), "edge".into(), "tts".into()],
            sentence_chain: vec!["edge".into(), "tts".into()],
            voice_slots: default_voice_slots(),
            say_btn_a: "us".into(),
            say_btn_b: "gb".into(),
            en_accent: String::new(),
            rate: 1.0,
            fallback_missing: true,
        }
    }
}

/// 链归一化：值域过滤 + 去空/去重（大小写归一）；语速夹到可调区间。
/// 空链保留为空（= 该场景全部停用），不补默认项——归一化只做收窄不做扩张。
pub fn normalize_pronounce(mut p: PronouncePrefs) -> PronouncePrefs {
    fn clean(chain: &[String], allowed: &[&str]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for item in chain {
            let item = item.trim().to_lowercase();
            if allowed.contains(&item.as_str()) && !out.contains(&item) {
                out.push(item);
            }
        }
        out
    }
    p.word_chain = clean(&p.word_chain, &["dict", "webdict", "edge", "tts"]);
    p.sentence_chain = clean(&p.sentence_chain, &["edge", "tts"]);
    p.rate = p.rate.clamp(0.5, 1.5);
    // 语音槽：键限六槽、值限 local:/edge: 前缀（其余条目丢弃；空值不落盘），
    // 再把缺失的槽补上默认音源——槽位没有「自动」态，配置始终完整
    let mut slots = std::collections::BTreeMap::new();
    for (key, value) in p.voice_slots.iter() {
        let key = key.trim().to_lowercase();
        let value = value.trim();
        if !VOICE_SLOT_KEYS.contains(&key.as_str()) || value.is_empty() {
            continue;
        }
        if value.starts_with("local:") || value.starts_with("edge:") {
            slots.insert(key, value.to_string());
        }
    }
    for (key, value) in default_voice_slots() {
        slots.entry(key).or_insert(value);
    }
    p.voice_slots = slots;
    // 朗读按钮：值限英文口音倾向（非法 / 空 → 按按钮位回落默认：1 = 美音 / 2 = 英音）
    p.say_btn_a = normalize_button_accent(&p.say_btn_a, "us");
    p.say_btn_b = normalize_button_accent(&p.say_btn_b, "gb");
    p.en_accent = match p.en_accent.trim().to_lowercase().as_str() {
        "us" => "us".into(),
        "gb" => "gb".into(),
        _ => String::new(),
    };
    p
}

static PREFS: RwLock<Option<PrefState>> = RwLock::new(None);

struct PrefState {
    value: Preferences,
    path: PathBuf,
}

/// 是否已完成 init（早期初始化与 setup 兜底共用判定 时序竞态修复）
pub fn is_initialized() -> bool {
    PREFS
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .is_some()
}

/// 初始化：读文件（损坏/缺失回退默认值，损坏改名 .corrupt 留档）。
/// **调用时机 = 窗口创建之前**（见 lib.rs::run 的早期初始化）：setup 晚于
/// tauri.conf 配置窗口的创建与页面加载，窗口前端可能早于 setup 读偏好。
pub fn init(data_dir: &Path) {
    let path = data_dir.join("preferences.json");
    let value = load_from(&path);
    if let Err(e) = std::fs::create_dir_all(data_dir) {
        tracing::error!(target: "prefs", dir = %data_dir.display(), error = %e, "数据目录创建失败（落盘将持续报错）");
    }
    *PREFS.write().unwrap_or_else(|e| e.into_inner()) = Some(PrefState { value, path });
    log_loaded();
}

/// 偏好加载摘要日志（脱敏：`?value` 会打印整个 Preferences，
/// 而 api_key 此时已解密回内存明文——只打非敏感摘要）。
/// 早期初始化（窗口创建前）发生在 tracing subscriber 就绪之前，其日志会被丢弃；
/// 由 lib.rs 在 subscriber 装好后判定 `is_initialized()` 补打一次。
pub fn log_loaded() {
    let (path, p) = with(|s| (s.path.clone(), s.value.clone()));
    tracing::info!(
        target: "prefs", path = %path.display(),
        selection_enabled = p.selection_enabled,
        clipboard_fallback = p.clipboard_fallback,
        clipboard_lookup = p.clipboard_lookup,
        dict_root = p.dict_root.as_deref().unwrap_or(""),
        providers = p.ai.as_ref().map_or(0, |a| a.providers.len()),
        has_model = p.ai.as_ref().and_then(|a| a.model.as_deref()).map_or(false, |m| !m.trim().is_empty()),
        "偏好已加载（apiKey 等敏感字段不落日志）"
    );
}

/// 纯函数：从文件加载（缺失 → 默认；解析失败 → 改名 .corrupt 留档后默认；
/// 字段缺省由 serde(default) 兜底——旧文件缺新字段可正常读）。
/// API Key 落盘为 DPAPI 密文，读后解密回内存明文；旧明文原样通过
/// （dpapi::unprotect 对无前缀值 passthrough），下次落盘自动加密——自动迁移。
fn load_from(path: &Path) -> Preferences {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Preferences::default();
    };
    match serde_json::from_str::<Preferences>(&text) {
        Ok(mut p) => {
            decrypt_api_keys(&mut p);
            // legacy AI 顶层字段 → providers[] 模型卡（幂等：非空 providers 即跳过）
            if let Some(ai) = p.ai.as_mut() {
                ai.migrate_legacy();
                // 卡级 thinking → 逐模型能力集（模型卡改版，幂等）
                ai.migrate_model_caps();
            }
            //  过渡迁移：在线词典独立 webDicts 数组并入统一 dictItems
            // 尾部（id 前缀 web-），与本地词典并列排序。幂等：字段缺省即跳过。
            migrate_web_dicts(&mut p);
            // 发音偏好同样在**读取路径**归一化：六槽补齐默认音源、链与语速收窄——
            // 否则前端可能读到不完整的槽表（保存路径的归一化要等下次写盘才生效）
            p.pronounce = normalize_pronounce(p.pronounce);
            p
        }
        Err(error) => {
            let backup = path.with_extension("json.corrupt");
            match std::fs::rename(path, &backup) {
                Ok(()) => tracing::error!(target: "prefs", backup = %backup.display(), error = %error, "preferences.json 解析失败，已改名留档并回退默认"),
                Err(rename_error) => tracing::error!(target: "prefs", error = %rename_error, "preferences.json 解析失败且留档失败，回退默认"),
            }
            Preferences::default()
        }
    }
}

/// 纯函数：整文件落盘。API Key 加密为 DPAPI 密文（内存/IPC 始终明文——
/// 威胁模型是「文件不被读」，见 dpapi 模块头注释）。
/// 原子写（temp+rename）——半截文件曾导致偏好与 API Key 全丢。
fn save_to(path: &Path, value: &Preferences) -> Result<(), String> {
    let mut snapshot = value.clone();
    encrypt_api_keys(&mut snapshot);
    let text = serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?;
    crate::fsutil::write_atomic(path, &text)
}

/// 文件出口：providers[].apiKey → DPAPI 密文（空串不落）
fn encrypt_api_keys(p: &mut Preferences) {
    if let Some(ai) = p.ai.as_mut() {
        for card in &mut ai.providers {
            if let Some(key) = card.api_key.as_deref() {
                if !key.is_empty() {
                    card.api_key = Some(dpapi::protect(key));
                }
            }
        }
    }
}

/// 文件入口：providers[].apiKey 密文 → 明文（legacy 明文原样通过 = 自动迁移）
fn decrypt_api_keys(p: &mut Preferences) {
    if let Some(ai) = p.ai.as_mut() {
        for card in &mut ai.providers {
            if let Some(key) = card.api_key.as_deref() {
                match dpapi::unprotect(key) {
                    Some(plain) => card.api_key = Some(plain),
                    None => card.api_key = None, // 密文损坏/跨机不可解：丢弃待重填
                }
            }
        }
    }
}

fn with<T>(f: impl FnOnce(&PrefState) -> T) -> T {
    let guard = PREFS.read().unwrap_or_else(|e| e.into_inner());
    // init 前（理论上不发生）：以默认值兜底，不落盘
    let fallback = PrefState {
        value: Preferences::default(),
        path: PathBuf::from("preferences.json"),
    };
    let state = guard.as_ref().unwrap_or(&fallback);
    f(state)
}

pub fn get() -> Preferences {
    with(|s| s.value.clone())
}

pub fn dict_root() -> Option<String> {
    with(|s| s.value.dict_root.clone())
}

/// 已移除词典 id 集（merged_items 扫描过滤用）
pub fn removed_dicts() -> Vec<String> {
    with(|s| s.value.removed_dicts.clone())
}

/// 记录已移除词典（幂等；词典列表「仅删除引用」/「删除文件」共用）
pub fn add_removed_dict(id: &str) {
    update(|p| {
        if !p.removed_dicts.iter().any(|v| v == id) {
            p.removed_dicts.push(id.to_string());
        }
    });
}

/// 清空已移除词典（换词典根目录 = 全新视图；用户可重新放置同名目录）
pub fn clear_removed_dicts() {
    update(|p| {
        if !p.removed_dicts.is_empty() {
            p.removed_dicts.clear();
        }
    });
}

fn update(f: impl FnOnce(&mut Preferences)) {
    let mut guard = PREFS.write().unwrap_or_else(|e| e.into_inner());
    let Some(state) = guard.as_mut() else {
        tracing::warn!(target: "prefs", "prefs 未初始化，更新丢弃");
        return;
    };
    f(&mut state.value);
    if let Err(e) = save_to(&state.path, &state.value) {
        tracing::error!(target: "prefs", error = %e, "preferences.json 落盘失败");
    }
}

pub fn set_dict_root(root: Option<String>) {
    update(|p| p.dict_root = root);
}

pub fn set_selection_enabled(enabled: bool) {
    update(|p| p.selection_enabled = enabled);
}

pub fn set_clipboard_fallback(enabled: bool) {
    update(|p| p.clipboard_fallback = enabled);
}

pub fn set_clipboard_lookup(enabled: bool) {
    update(|p| p.clipboard_lookup = enabled);
}

pub fn set_action_items(items: Option<Vec<ActionItemPref>>) {
    update(|p| p.action_items = items);
}

pub fn dict_items() -> Option<Vec<DictItemPref>> {
    with(|s| s.value.dict_items.clone())
}

pub fn set_dict_items(items: Option<Vec<DictItemPref>>) {
    update(|p| p.dict_items = items);
}

///  过渡迁移：webDicts（独立数组）→ dictItems 统一列表尾部（幂等去重）
fn migrate_web_dicts(p: &mut Preferences) {
    let Some(web) = p.web_dicts.take() else {
        return;
    };
    let items = p.dict_items.get_or_insert_with(Vec::new);
    for w in web {
        if !items.iter().any(|i| i.id == w.id) {
            items.push(DictItemPref {
                id: w.id,
                enabled: w.enabled,
            });
        }
    }
}

/// AI 配置快照（ai 模块每次请求读取；未配置回退默认值）
pub fn ai() -> AiPrefs {
    with(|s| s.value.ai.clone().unwrap_or_default())
}

pub fn set_ai(ai: Option<AiPrefs>) {
    update(|p| p.ai = ai);
}

/// Rust 侧暂无消费方（前端经 prefs_get 读取）；预留对称 getter 保持模块 API 完整
#[allow(dead_code)]
pub fn translate_lang() -> Option<String> {
    with(|s| s.value.translate_lang.clone())
}

pub fn set_translate_lang(lang: Option<String>) {
    update(|p| p.translate_lang = lang);
}

pub fn set_translate_source_lang(lang: Option<String>) {
    update(|p| p.translate_source_lang = lang);
}

pub fn set_toolbar_compact(compact: bool) {
    update(|p| p.toolbar_compact = compact);
}

/// 全局快捷键快照（tray.rs 注册与重注册读取；未配置回退默认）
pub fn hotkeys() -> HotkeysPref {
    with(|s| s.value.hotkeys.clone().unwrap_or_default())
}

pub fn set_hotkeys(hotkeys: Option<HotkeysPref>) {
    update(|p| p.hotkeys = hotkeys);
}

/// 划词触发方式快照（非法值归一 selected；selection 模块 static 同步用）
#[allow(dead_code)] // 预留对称 getter：restore_from_prefs 走 Preferences 全量读取
pub fn selection_trigger() -> String {
    let v = with(|s| s.value.selection_trigger.clone());
    match v.as_str() {
        "ctrlkey" | "shortcut" => v,
        _ => "selected".into(),
    }
}

/// 划词进程过滤快照（mode 归一 default；list 全小写归一）
#[allow(dead_code)] // 预留对称 getter：restore_from_prefs 走 Preferences 全量读取
pub fn selection_filter() -> (String, Vec<String>) {
    let (mode, list) = with(|s| {
        (
            s.value.selection_filter_mode.clone(),
            s.value.selection_filter_list.clone(),
        )
    });
    let mode = match mode.as_str() {
        "whitelist" | "blacklist" => mode,
        _ => "default".into(),
    };
    let list = list.into_iter().map(|s| s.to_lowercase()).collect();
    (mode, list)
}

pub fn set_selection_capture(trigger: String, filter_mode: String, filter_list: Vec<String>) {
    update(|p| {
        p.selection_trigger = trigger;
        p.selection_filter_mode = filter_mode;
        p.selection_filter_list = filter_list;
    });
}

/// 截图翻译源语言提示快照（空串 = 自动；仅提示 LLM，不控制 OCR 引擎）。
/// 前端经 prefs_get 快照读取；Rust 侧无消费方（识别语言全自动）
pub fn set_ocr_lang(lang: String) {
  update(|p| p.ocr_lang = lang.trim().to_string());
}

/// 截图翻译目标语言快照（空串 = 自动智能方向；前端经 prefs_get 读取，预留对称 getter）
#[allow(dead_code)]
pub fn ocr_target_lang() -> String {
    with(|s| s.value.ocr_target_lang.clone())
}

pub fn set_ocr_target_lang(lang: String) {
    update(|p| p.ocr_target_lang = lang.trim().to_string());
}

pub fn set_ocr_vision_model(value: String) {
    update(|p| p.ocr_vision_model = value.trim().to_string());
}

/// 截图后自动系统识别开关（false = 只截屏，工具条按钮手动识别）
pub fn set_ocr_auto_recognize(value: bool) {
    update(|p| p.ocr_auto_recognize = value);
}

/// 识别后自动翻译开关（false = 识别后手动「译」）
pub fn set_ocr_auto_translate(value: bool) {
    update(|p| p.ocr_auto_translate = value);
}

/// 发音偏好快照（前端经 prefs_get 读取；Rust 侧暂无消费方——朗读链执行在前端）
#[allow(dead_code)]
pub fn pronounce() -> PronouncePrefs {
    with(|s| s.value.pronounce.clone())
}

pub fn set_pronounce(prefs: PronouncePrefs) {
    let normalized = normalize_pronounce(prefs);
    update(|p| p.pronounce = normalized);
}

/// Rust 侧暂无消费方（前端经 prefs_get 读取）；预留对称 getter 保持模块 API 完整
#[allow(dead_code)]
pub fn translate_model() -> Option<String> {
    with(|s| s.value.translate_model.clone())
}

pub fn set_translate_config(model: Option<String>, prompt: Option<String>, allow_think: bool) {
    update(|p| {
        p.translate_model = model;
        p.translate_prompt = prompt;
        p.translate_allow_think = allow_think;
    });
}

/// 语音槽 key 全集（语言-口音-性别；前端路由与设置页共用同一值域）
pub const VOICE_SLOT_KEYS: [&str; 6] = ["zh-f", "zh-m", "en-us-f", "en-us-m", "en-gb-f", "en-gb-m"];

/// 六槽缺省音源（Edge 在线自然语音；中英 × 性别 × 口音各一）。
/// 槽位无「自动」态：键缺失即取此默认，用户可在设置页逐槽改成本机语音或其他音色。
fn default_voice_slots() -> std::collections::BTreeMap<String, String> {
    [
        ("zh-f", "edge:zh-CN-XiaoxiaoNeural"),
        ("zh-m", "edge:zh-CN-YunjianNeural"),
        ("en-us-f", "edge:en-US-AvaNeural"),
        ("en-us-m", "edge:en-US-AndrewNeural"),
        ("en-gb-f", "edge:en-GB-SoniaNeural"),
        ("en-gb-m", "edge:en-GB-RyanNeural"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

/// 朗读按钮的英文口音倾向归一化：`us` / `gb` 原样（小写），其余回落默认
fn normalize_button_accent(value: &str, fallback: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "us" => "us".into(),
        "gb" => "gb".into(),
        _ => fallback.to_string(),
    }
}



// ── Tauri commands ──

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefsPayload {
    pub dict_root: Option<String>,
    pub selection_enabled: bool,
    pub clipboard_fallback: bool,
    pub clipboard_lookup: bool,
    pub action_items: Option<Vec<ActionItemPref>>,
    pub dict_items: Option<Vec<DictItemPref>>,
    pub ai: Option<AiPrefs>,
    pub translate_lang: Option<String>,
    pub translate_source_lang: Option<String>,
    pub toolbar_compact: bool,
    pub translate_model: Option<String>,
    pub translate_prompt: Option<String>,
    pub translate_allow_think: bool,
    pub hotkeys: Option<HotkeysPref>,
    pub web_fallback_only: bool,
    pub web_external: bool,
    pub review_auto_pronounce: bool,
    pub selection_trigger: String,
    pub selection_filter_mode: String,
    pub selection_filter_list: Vec<String>,
    pub ocr_lang: String,
    pub ocr_target_lang: String,
    pub ocr_vision_model: String,
    pub ocr_auto_recognize: bool,
    pub ocr_auto_translate: bool,
    pub check_update_on_startup: bool,
    pub pronounce: PronouncePrefs,
}

/// 偏好快照。**未初始化时返回 Err**：旧实现在此静默返回默认值，前端
/// 无从区分「读到的是空壳」与「用户确实未配置」——划词栏动作数与设置页不一致的
/// 直接来源之一。正常路径下 init 已在窗口创建前完成（lib.rs::run），此分支仅兜底。
#[tauri::command]
pub fn prefs_get() -> Result<PrefsPayload, String> {
    if !is_initialized() {
        tracing::warn!(target: "prefs", "prefs_get 在偏好初始化完成前被调用");
        return Err("偏好未就绪".into());
    }
    let p = get();
    Ok(PrefsPayload {
        dict_root: p.dict_root,
        selection_enabled: p.selection_enabled,
        clipboard_fallback: p.clipboard_fallback,
        clipboard_lookup: p.clipboard_lookup,
        action_items: p.action_items,
        dict_items: p.dict_items,
        ai: p.ai,
        translate_lang: p.translate_lang,
        translate_source_lang: p.translate_source_lang,
        toolbar_compact: p.toolbar_compact,
        translate_model: p.translate_model,
        translate_prompt: p.translate_prompt,
        translate_allow_think: p.translate_allow_think,
        hotkeys: p.hotkeys,
        web_fallback_only: p.web_fallback_only,
        web_external: p.web_external,
        review_auto_pronounce: p.review_auto_pronounce,
        selection_trigger: p.selection_trigger,
        selection_filter_mode: p.selection_filter_mode,
        selection_filter_list: p.selection_filter_list,
        ocr_lang: p.ocr_lang,
        ocr_target_lang: p.ocr_target_lang,
        ocr_vision_model: p.ocr_vision_model,
        ocr_auto_recognize: p.ocr_auto_recognize,
        ocr_auto_translate: p.ocr_auto_translate,
        check_update_on_startup: p.check_update_on_startup,
        pronounce: p.pronounce,
    })
}

/// 保存划词捕获配置（触发方式 + 进程过滤；设置页一次提交三项）。
/// selection 模块 static 同步在此（worker/钩子读 static 不读偏好快照），
/// 广播 prefs-changed 驱动设置页回读。
#[tauri::command]
pub fn prefs_set_selection_capture(
    app: tauri::AppHandle,
    trigger: String,
    filter_mode: String,
    filter_list: Vec<String>,
) {
    // 归一（前端可能传空串/未值）
    let trigger = match trigger.as_str() {
        "ctrlkey" | "shortcut" => trigger,
        _ => "selected".into(),
    };
    let filter_mode = match filter_mode.as_str() {
        "whitelist" | "blacklist" => filter_mode,
        _ => "default".into(),
    };
    let filter_list: Vec<String> = filter_list
        .into_iter()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    set_selection_capture(trigger.clone(), filter_mode.clone(), filter_list.clone());
    crate::selection::apply_capture_prefs(&trigger, &filter_mode, &filter_list);
    use tauri::Emitter;
    if let Err(e) = app.emit("prefs-changed", ()) {
        tracing::warn!(target: "prefs", error = %e, "prefs-changed 广播失败");
    }
    tracing::info!(target: "prefs", trigger = %trigger, filter = %filter_mode, list = filter_list.len(), "划词捕获配置已更新");
}

/// 保存划词栏动作配置（前端解析内置目录后提交全量有序列表，含自定义 AI 动作）。
/// 广播 `prefs-changed`：浮标常驻隐藏不销毁，需即时刷新动作集（含 AI 点亮状态）。
#[tauri::command]
pub fn prefs_set_action_items(app: tauri::AppHandle, items: Option<Vec<ActionItemPref>>) {
    set_action_items(items);
    use tauri::Emitter;
    if let Err(e) = app.emit("prefs-changed", ()) {
        tracing::warn!(target: "prefs", error = %e, "prefs-changed 广播失败");
    }
}

/// 保存 AI 服务配置（endpoint/apiKey/model/非思考/AI 词典）。广播 `ai-changed`
/// 驱动浮标动作点亮状态与 AI 词典分区刷新。
#[tauri::command]
pub fn prefs_set_ai(app: tauri::AppHandle, ai: Option<AiPrefs>) {
    set_ai(ai);
    use tauri::Emitter;
    if let Err(e) = app.emit("ai-changed", ()) {
        tracing::warn!(target: "prefs", error = %e, "ai-changed 广播失败");
    }
    tracing::info!(target: "prefs", "AI 服务配置已更新");
}

/// 保存 AI 翻译目标语言（动作面板选择器即改即存）
#[tauri::command]
pub fn prefs_set_translate_lang(lang: Option<String>) {
    set_translate_lang(lang);
}

/// 保存翻译页源语言（None/空串 = 自动检测；仅作为翻译提示告知 LLM）
#[tauri::command]
pub fn prefs_set_translate_source_lang(lang: Option<String>) {
    set_translate_source_lang(lang.filter(|s| !s.trim().is_empty()));
}

/// 保存划词浮标紧凑模式（浮标常驻，广播 prefs-changed 即时生效）。
/// 附直推通道 `toolbar://compact`（携带新值）：实测 prefs-changed 广播疑似
/// 未被浮标窗口消费（紧凑从未生效），直推让浮标渲染不依赖间链条路——与划词开关
/// 的 `selection://enabled-changed` 同款确定性同步。
#[tauri::command]
pub fn prefs_set_toolbar_compact(app: tauri::AppHandle, compact: bool) {
    set_toolbar_compact(compact);
    use tauri::Emitter;
    if let Err(e) = app.emit("prefs-changed", ()) {
        tracing::warn!(target: "prefs", error = %e, "prefs-changed 广播失败");
    }
    if let Err(e) = app.emit("toolbar://compact", compact) {
        tracing::warn!(target: "prefs", error = %e, "toolbar://compact 直推失败");
    }
    tracing::info!(target: "prefs", compact, "toolbar compact updated");
}

/// 保存学习卡自动发音开关（生词本重构；广播 prefs-changed 即时生效，
/// 复习会话中开关也实时跟随）
#[tauri::command]
pub fn prefs_set_review_auto_pronounce(app: tauri::AppHandle, enabled: bool) {
    update(|p| p.review_auto_pronounce = enabled);
    use tauri::Emitter;
    if let Err(e) = app.emit("prefs-changed", ()) {
        tracing::warn!(target: "prefs", error = %e, "prefs-changed 广播失败");
    }
    tracing::info!(target: "prefs", enabled, "review auto pronounce updated");
}

/// 保存「启动时检查更新」开关（广播 prefs-changed 即时回读；检查动作本身
/// 只在下次启动执行——设置页内仍可手动检查）
#[tauri::command]
pub fn prefs_set_check_update_on_startup(app: tauri::AppHandle, enabled: bool) {
    update(|p| p.check_update_on_startup = enabled);
    use tauri::Emitter;
    if let Err(e) = app.emit("prefs-changed", ()) {
        tracing::warn!(target: "prefs", error = %e, "prefs-changed 广播失败");
    }
    tracing::info!(target: "prefs", enabled, "check update on startup updated");
}

/// 保存发音偏好（朗读源链 / 语音选择 / 语速 / 兜底开关；设置页即改即存）。
/// 归一化在 `set_pronounce` 内完成（值域过滤 + 去重 + 语速夹取）；广播
/// `prefs-changed` 驱动各窗口朗读链即时生效。
#[tauri::command]
pub fn prefs_set_pronounce(app: tauri::AppHandle, pronounce: PronouncePrefs) {
    let normalized = normalize_pronounce(pronounce);
    tracing::info!(
        target: "prefs",
        word_chain = ?normalized.word_chain,
        sentence_chain = ?normalized.sentence_chain,
        rate = normalized.rate,
        fallback_missing = normalized.fallback_missing,
        slots = normalized.voice_slots.len(),
        btn_a = %normalized.say_btn_a,
        btn_b = %normalized.say_btn_b,
        "发音偏好已更新"
    );
    set_pronounce(normalized);
    use tauri::Emitter;
    if let Err(e) = app.emit("prefs-changed", ()) {
        tracing::warn!(target: "prefs", error = %e, "prefs-changed 广播失败");
    }
}

/// 保存词典外链走向开关（true = 浏览器打开，false = 转词典内部查词；
/// 广播 prefs-changed 即时生效于主窗与划词面板的查询管线）
#[tauri::command]
pub fn prefs_set_web_external(app: tauri::AppHandle, enabled: bool) {
    update(|p| p.web_external = enabled);
    use tauri::Emitter;
    if let Err(e) = app.emit("prefs-changed", ()) {
        tracing::warn!(target: "prefs", error = %e, "prefs-changed 广播失败");
    }
    tracing::info!(target: "prefs", enabled, "web external updated");
}

/// 保存翻译页配置（模型覆盖/提示词覆盖/允许思考；一次提交三项）
#[tauri::command]
pub fn prefs_set_translate_config(
    model: Option<String>,
    prompt: Option<String>,
    allow_think: bool,
) {
    set_translate_config(model, prompt, allow_think);
}

/// 保存全局快捷键（可配置化）。先经 tray::apply_hotkeys 参数化
/// 重注册（格式/互斥/占用校验，占用时保留旧键并返回 Err），成功才落盘并广播
/// `prefs-changed`（快捷键子页经外壳 tick 重读对齐）。
#[tauri::command]
pub fn prefs_set_hotkeys(
    app: tauri::AppHandle,
    hotkeys: Option<HotkeysPref>,
) -> Result<(), String> {
    let next = hotkeys.clone().unwrap_or_default();
    crate::tray::apply_hotkeys(&app, &next)?;
    set_hotkeys(hotkeys);
    use tauri::Emitter;
    if let Err(e) = app.emit("prefs-changed", ()) {
        tracing::warn!(target: "prefs", error = %e, "prefs-changed 广播失败");
    }
    tracing::info!(target: "prefs", toggle = next.toggle_selection(), show = next.show_main(), "全局快捷键已更新");
    Ok(())
}

/// 保存截图翻译源语言提示（浮层/设置页下拉即改即存；空串 = 自动。
/// 仅作为翻译提示告知 LLM 原文语言，不控制 OCR 识别引擎——识别语言全自动）
#[tauri::command]
pub fn prefs_set_ocr_lang(lang: String) {
  set_ocr_lang(lang);
}

/// 保存截图翻译目标语言（截图浮层/设置页共用；空串 = 自动智能方向，
/// 具体值 = 固定目标；即改即存——浮层下拉指定后同步更新设置）
#[tauri::command]
pub fn prefs_set_ocr_target_lang(lang: String) {
    set_ocr_target_lang(lang);
}

/// 保存截图 AI 图译模型（`provider_id:model` 跨卡路由；空串 = 未设置）
#[tauri::command]
pub fn prefs_set_ocr_vision_model(value: String) {
    set_ocr_vision_model(value);
}

/// 保存截图后自动识别开关（设置页即改即存；false = 只截屏手动识别）
#[tauri::command]
pub fn prefs_set_ocr_auto_recognize(value: bool) {
    set_ocr_auto_recognize(value);
}

/// 保存识别后自动翻译开关（设置页即改即存；false = 识别后手动「译」）
#[tauri::command]
pub fn prefs_set_ocr_auto_translate(value: bool) {
    set_ocr_auto_translate(value);
}

/// 保存词典管理配置（启停 + 顺序；统一列表含在线词典条目 id 前缀 `web-`——
/// merged_items 自动过滤，dictionary_* 命令不受影响）。
/// web_fallback_only = Some 时顺带更新 fallback 开关（设置页一次提交）。
/// 变更后：清词典注册表 + 广播 `dictionary-changed`（词典页重列重查）+ 后台重预热
/// （仅启用集）。
#[tauri::command]
pub fn prefs_set_dict_items(
    app: tauri::AppHandle,
    items: Option<Vec<DictItemPref>>,
    web_fallback_only: Option<bool>,
) -> Result<(), String> {
    set_dict_items(items);
    if let Some(only) = web_fallback_only {
        update(|p| p.web_fallback_only = only);
    }
    use tauri::{Emitter, Manager};
    let registry: tauri::State<crate::dictionary::Registry> = app.state();
    registry.reset();
    if let Err(e) = app.emit("dictionary-changed", ()) {
        tracing::warn!(target: "prefs", error = %e, "dictionary-changed 广播失败");
    }
    crate::dictionary::spawn_warmup(app);
    tracing::info!(target: "prefs", "词典管理配置已更新（启停/顺序）");
    Ok(())
}

/// 设置词典根目录（None = 恢复自动探测）；换目录后清词典缓存，下次命令按新 root 重开
#[tauri::command]
pub fn prefs_set_dict_root(
    app: tauri::AppHandle,
    root: Option<String>,
) -> Result<(), String> {
    if let Some(r) = &root {
        let path = PathBuf::from(r);
        if !path.is_dir() {
            return Err(format!("目录不存在: {}", path.display()));
        }
    }
    set_dict_root(root);
    // 换根 = 全新视图：清空已移除词典记录（旧根的移除决定不带到新根）
    clear_removed_dicts();
    use tauri::{Emitter, Manager};
    let registry: tauri::State<crate::dictionary::Registry> = app.state();
    registry.reset();
    tracing::info!(target: "prefs", "词典根目录已更新并清空词典缓存");
    // 广播目录变更：词典 Tab 收到后重列词典并对当前词重查（结论：emit_to 不可靠，一律广播）
    if let Err(e) = app.emit("dictionary-changed", ()) {
        tracing::warn!(target: "prefs", error = %e, "dictionary-changed 广播失败");
    }
    // 新目录后台重预热（已缓存词典秒装；未缓存的低优先级解析建缓存）
    crate::dictionary::spawn_warmup(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "onedict-prefs-test-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("preferences.json")
    }

    #[test]
    fn missing_file_yields_defaults() {
        let path = temp_path("missing");
        assert_eq!(load_from(&path), Preferences::default());
    }

    #[test]
    fn roundtrip_keeps_fields() {
        let path = temp_path("roundtrip");
        let mut p = Preferences::default();
        p.dict_root = Some("E:\\dicts".into());
        p.selection_enabled = false;
        save_to(&path, &p).unwrap();
        assert_eq!(load_from(&path), p);

        // camelCase 字段名（与前端 payload 对齐）
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"dictRoot\""));
        assert!(text.contains("\"selectionEnabled\""));
        assert!(text.contains("\"clipboardFallback\""));
    }

    #[test]
    fn legacy_web_dicts_migrate_into_dict_items() {
        //  独立 webDicts 数组→ 并入统一 dictItems 尾部（幂等去重），
        // webDicts 不再序列化
        let path = temp_path("legacy-webdicts");
        std::fs::write(
            &path,
            r#"{"dictItems":[{"id":"oxford8","enabled":true}],"webDicts":[{"id":"web-youdao","enabled":false}],"webFallbackOnly":true}"#,
        )
        .unwrap();
        let p = load_from(&path);
        let items = p.dict_items.as_ref().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "oxford8");
        assert_eq!(items[1].id, "web-youdao", "web 条目迁至统一列表尾部");
        assert!(!items[1].enabled, "enabled 值随迁移保留");
        assert!(p.web_fallback_only);

        // 迁移幂等：再存再读不重复、webDicts 字段不再写出
        save_to(&path, &p).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("\"webDicts\""), "legacy 字段不再序列化");
        let p2 = load_from(&path);
        assert_eq!(p2.dict_items.as_ref().unwrap().len(), 2);
    }

    #[test]
    fn web_fallback_only_roundtrip() {
        let path = temp_path("webfallback");
        let mut p = Preferences::default();
        p.web_fallback_only = true;
        save_to(&path, &p).unwrap();
        assert_eq!(load_from(&path), p);

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"webFallbackOnly\""));

        // 旧文件缺字段：逐键回默认 false，其余保留
        let path2 = temp_path("webfallback-legacy");
        std::fs::write(&path2, r#"{"selectionEnabled":true}"#).unwrap();
        let p2 = load_from(&path2);
        assert!(!p2.web_fallback_only);
    }

    #[test]
    fn web_external_roundtrip() {
        // 默认 true（浏览器打开）；关闭后落盘/回读保留
        let path = temp_path("webexternal");
        let mut p = Preferences::default();
        assert!(p.web_external, "默认走浏览器");
        p.web_external = false;
        save_to(&path, &p).unwrap();
        assert_eq!(load_from(&path), p);

        // 旧文件缺字段：回默认 true
        let path2 = temp_path("webexternal-legacy");
        std::fs::write(&path2, r#"{"selectionEnabled":true}"#).unwrap();
        assert!(load_from(&path2).web_external);
    }

    #[test]
    fn missing_fields_fall_back_per_key() {
        // 旧文件缺 clipboardFallback 字段：该字段用默认值，其余保留
        let path = temp_path("partial");
        std::fs::write(&path, r#"{"dictRoot":"D:\\x","selectionEnabled":false}"#).unwrap();
        let p = load_from(&path);
        assert_eq!(p.dict_root.as_deref(), Some("D:\\x"));
        assert!(!p.selection_enabled);
        assert!(p.clipboard_fallback, "缺省字段取默认值 true");
    }

    #[test]
    fn ai_prefs_roundtrip_and_camel_case() {
        let path = temp_path("ai");
        let mut p = Preferences::default();
        p.ai = Some(AiPrefs {
            provider: Some("deepseek".into()),
            model: Some("deepseek-chat".into()),
            dict_enabled: false,
            dict_prompt: Some("自定义提示词".into()),
            dict_allow_think: true,
            dict_model: None,
            providers: vec![ProviderConfig {
                id: "deepseek".into(),
                endpoint: "https://api.deepseek.com/v1".into(),
                api_key: Some("sk-test".into()),
                models: vec![
                    ModelEntry {
                        id: "deepseek-chat".into(),
                        caps: Vec::new(),
                    },
                    ModelEntry {
                        id: "deepseek-reasoner".into(),
                        caps: vec!["thinking".into()],
                    },
                ],
                thinking: false,
                api_type: "openai-chat-completions".into(),
            }],
            endpoint: None,
            api_key: None,
            no_think: false,
        });
        p.translate_lang = Some("en-us".into());
        save_to(&path, &p).unwrap();
        assert_eq!(load_from(&path), p);

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"apiKey\""));
        assert!(text.contains("\"caps\""), "逐模型能力集字段");
        assert!(text.contains("\"thinking\""), "能力值：推理标记");
        assert!(text.contains("\"dictEnabled\""));
        assert!(text.contains("\"translateLang\""));
        assert!(text.contains("\"providers\""));
        assert!(!text.contains("\"noThink\""), "legacy 顶层 noThink 不再序列化");
        // API Key 不再明文落盘——DPAPI 密文（dpapi: 前缀）
        assert!(!text.contains("sk-test"), "落盘文本不得含 API Key 明文");
        assert!(text.contains("\"apiKey\": \"dpapi:"), "落盘为 DPAPI 密文");
        // 往返语义：load 解密回内存明文（上面 assert_eq!(load_from(&path), p) 已证）
    }

    #[test]
    fn legacy_ai_fields_migrate_into_first_provider_card() {
        // 模型卡重构前的旧文件：顶层 endpoint/apiKey/noThink → 迁入首卡
        let path = temp_path("legacy-ai-migrate");
        std::fs::write(
            &path,
            r#"{"selectionEnabled":true,"clipboardFallback":true,"ai":{"provider":"deepseek","endpoint":"https://api.deepseek.com/v1","apiKey":"sk-old","model":"deepseek-chat","noThink":true,"dictEnabled":true},"translateLang":"en-us"}"#,
        )
        .unwrap();
        let p = load_from(&path);
        let ai = p.ai.as_ref().unwrap();
        assert_eq!(ai.providers.len(), 1);
        let card = &ai.providers[0];
        assert_eq!(card.id, "deepseek");
        assert_eq!(card.endpoint, "https://api.deepseek.com/v1");
        assert_eq!(card.api_key.as_deref(), Some("sk-old"));
        assert!(!card.thinking, "旧顶层 noThink=true（关思考）→ 新 thinking=false（非推理）");
        assert_eq!(ai.model.as_deref(), Some("deepseek-chat"));
        // 迁移幂等：再存再读不重复建卡
        save_to(&path, &p).unwrap();
        let p2 = load_from(&path);
        assert_eq!(p2.ai.unwrap().providers.len(), 1);
    }

    #[test]
    fn legacy_card_level_thinking_migrates_to_per_model_caps() {
        // 模型卡遗留的旧文件：models 裸字符串 + 卡级 thinking=true →
        // 全部已登记模型补「推理」标记；卡级字段清零不再落盘
        let path = temp_path("legacy-card-thinking");
        std::fs::write(
            &path,
            r#"{"ai":{"provider":"dashscope","model":"qwen-flash","dictEnabled":true,"providers":[{"id":"dashscope","endpoint":"https://dashscope.aliyuncs.com/compatible-mode/v1","apiKey":"sk-x","thinking":true,"models":["qwen-flash","qwen3-max"]}]}}"#,
        )
        .unwrap();
        let p = load_from(&path);
        let card = &p.ai.as_ref().unwrap().providers[0];
        assert!(!card.thinking, "卡级 thinking 迁移后清零");
        assert_eq!(card.models.len(), 2);
        for m in &card.models {
            assert_eq!(
                m.caps,
                vec!["thinking".to_string()],
                "裸字符串模型 {} 摊平推理标记",
                m.id
            );
        }
        // 幂等：往返后不重复加标记、不复活卡级字段
        save_to(&path, &p).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"caps\""), "新结构逐模型能力集落盘");
        assert!(!text.contains("\"thinking\": true"), "卡级 thinking 不再序列化");
        let p2 = load_from(&path);
        assert_eq!(p2.ai, p.ai);
        assert_eq!(p2.ai.unwrap().providers[0].models[0].caps, vec!["thinking"]);

        // 无卡级标记的旧文件：裸字符串只转结构，caps 保持空
        let path2 = temp_path("legacy-strings-no-thinking");
        std::fs::write(
            &path2,
            r#"{"ai":{"provider":"deepseek","model":"deepseek-chat","dictEnabled":true,"providers":[{"id":"deepseek","endpoint":"https://api.deepseek.com","apiKey":"sk-y","thinking":false,"models":["deepseek-chat"]}]}}"#,
        )
        .unwrap();
        let card2 = &load_from(&path2).ai.unwrap().providers[0];
        assert!(!card2.thinking);
        assert_eq!(card2.models[0].id, "deepseek-chat");
        assert!(card2.models[0].caps.is_empty(), "无标记 → 空能力集");
    }

    #[test]
    fn legacy_file_missing_ai_yields_none() {
        // 旧文件无 ai/translateLang：整体为 None（未配置），其余字段不受影响
        let path = temp_path("legacy-ai");
        std::fs::write(&path, r#"{"selectionEnabled":true,"clipboardFallback":true}"#).unwrap();
        let p = load_from(&path);
        assert!(p.ai.is_none());
        assert!(p.translate_lang.is_none());
        assert!(p.dict_items.is_none());
    }

    #[test]
    fn corrupt_file_backed_up_as_corrupt() {
        let path = temp_path("corrupt");
        std::fs::write(&path, "{ not json").unwrap();
        load_from(&path);
        assert!(!path.exists(), "损坏文件应被改名");
        assert!(path.with_extension("json.corrupt").exists());
    }

    #[test]
    fn hotkeys_roundtrip_camel_case_and_resolve() {
        let path = temp_path("hotkeys");
        let mut p = Preferences::default();
        p.hotkeys = Some(HotkeysPref {
            toggle_selection: Some("ctrl+shift+9".into()),
            show_main: None,
            trigger_lookup: Some("ctrl+shift+l".into()),
            ocr_lookup: None,
        });
        save_to(&path, &p).unwrap();
        assert_eq!(load_from(&path), p);

        // camelCase 字段名
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"toggleSelection\""));
        assert!(text.contains("\"showMain\"") == false, "None 槽不序列化");

        // 槽位解析：None/空串回内置默认；trigger_lookup 无内置默认（None = 不注册）
        let h = HotkeysPref::default();
        assert_eq!(h.toggle_selection(), DEFAULT_HOTKEY_TOGGLE_SELECTION);
        assert_eq!(h.show_main(), DEFAULT_HOTKEY_SHOW_MAIN);
        assert!(h.trigger_lookup().is_none());
        assert_eq!(h.ocr_lookup(), DEFAULT_HOTKEY_OCR_LOOKUP);
        let h2 = HotkeysPref {
            toggle_selection: Some(String::new()),
            show_main: Some("ctrl+shift+q".into()),
            trigger_lookup: None,
            ocr_lookup: Some("ctrl+shift+o".into()),
        };
        assert_eq!(h2.toggle_selection(), DEFAULT_HOTKEY_TOGGLE_SELECTION, "空串回默认");
        assert_eq!(h2.show_main(), "ctrl+shift+q");
        assert_eq!(h2.ocr_lookup(), "ctrl+shift+o");
    }

    #[test]
    fn legacy_file_without_hotkeys_yields_none() {
        let path = temp_path("legacy-hotkeys");
        std::fs::write(&path, r#"{"selectionEnabled":true}"#).unwrap();
        let p = load_from(&path);
        assert!(p.hotkeys.is_none());
        // 快照 getter 回退默认
        assert_eq!(p.hotkeys.unwrap_or_default().toggle_selection(), "ctrl+alt+d");
    }

    #[test]
    fn pronounce_roundtrip_and_legacy_default() {
        let path = temp_path("pronounce");
        let mut p = Preferences::default();
        assert_eq!(
            p.pronounce.word_chain,
            vec!["dict", "webdict", "edge", "tts"]
        );
        assert_eq!(p.pronounce.sentence_chain, vec!["edge", "tts"]);
        assert!(p.pronounce.fallback_missing);
        p.pronounce.word_chain = vec!["tts".into(), "dict".into()];
        p.pronounce.rate = 1.2;
        p.pronounce = normalize_pronounce(p.pronounce);
        save_to(&path, &p).unwrap();
        // 读取路径同样归一化（六槽补齐默认），故往返前后完全一致
        assert_eq!(load_from(&path), p);
        assert_eq!(
            p.pronounce.voice_slots.len(),
            6,
            "六槽无「自动」态：默认即已填满"
        );
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"wordChain\""));
        assert!(text.contains("\"fallbackMissing\""));
        assert!(text.contains("\"voiceSlots\""));

        // 旧文件缺 pronounce：整段回默认（链仍是完整三项）
        let path2 = temp_path("pronounce-legacy");
        std::fs::write(&path2, r#"{"selectionEnabled":true}"#).unwrap();
        assert_eq!(load_from(&path2).pronounce, PronouncePrefs::default());
    }

    #[test]
    fn pronounce_normalize_filters_and_clamps() {
        let raw = PronouncePrefs {
            word_chain: vec![
                " TTS ".into(),
                "tts".into(),
                " EDGE ".into(),
                "bogus".into(),
                "dict".into(),
            ],
            sentence_chain: vec!["dict".into()],
            voice_slots: [
                (" EN-GB-M ".to_string(), " edge:en-GB-RyanNeural ".to_string()),
                ("bogus".to_string(), "edge:x".to_string()),
                ("zh-f".to_string(), "bad:value".to_string()),
            ]
            .into_iter()
            .collect(),
            say_btn_a: " US ".into(),
            say_btn_b: "bogus".into(),
            en_accent: " GB ".into(),
            rate: 9.0,
            fallback_missing: true,
        };
        let n = normalize_pronounce(raw);
        assert_eq!(n.voice_slots.len(), 6, "槽位恒满：非法槽键被丢弃后由默认补齐");
        assert_eq!(
            n.voice_slots.get("en-gb-m").map(String::as_str),
            Some("edge:en-GB-RyanNeural"),
            "槽键归一化 + 值去空白 + 用户值优先于默认"
        );
        assert_eq!(
            n.voice_slots.get("zh-f").map(String::as_str),
            Some("edge:zh-CN-XiaoxiaoNeural"),
            "非法值（bad:value）丢弃后回落该槽默认音源"
        );
        assert_eq!(n.say_btn_a, "us", "按钮口音倾向归一化（小写 + 去空白）");
        assert_eq!(n.say_btn_b, "gb", "非法倾向回落按钮位默认（按钮 2 = 英音）");
        assert_eq!(n.en_accent, "gb");
        assert_eq!(
            n.word_chain,
            vec!["tts", "edge", "dict"],
            "去重 + 大小写归一 + 非法值过滤"
        );
        assert!(
            n.sentence_chain.is_empty(),
            "句子链只认 edge/tts：非法项过滤后保持空（不补默认）"
        );
        assert_eq!(n.rate, 1.5, "语速夹到上限");
    }
}
