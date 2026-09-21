/**  偏好（对应 src-tauri/src/prefs/mod.rs 命令出入参） */

/** 划词栏动作配置项（持久化子集；label/icon/ai 依赖由前端内置目录定义）。
 *  name/prompt/model/icon 为自定义 AI 动作字段（id 形如 user-* 时生效，语义对齐
 *  pickdict SelectionActionItem 的扩展：{{text}} 占位选中文本，model 覆盖全局，
 *  icon = lucide 图标名）；内置 AI 动作可用 prompt/model/icon 覆盖（留空回默认）。
 *  allowThink = 动作级思考开关（默认非思考；实际生效还需激活卡 thinking=true） */
export interface ActionItemPref {
  id: string;
  enabled: boolean;
  searchEngine?: string;
  name?: string;
  prompt?: string;
  model?: string;
  icon?: string;
  allowThink?: boolean;
}

/** 词典管理配置项（统一列表：id = 词典子目录名，或在线词典内置 id（前缀 `web-`，
 * 与本地词典并列拖动排序——）；数组序即查询显示序） */
export interface DictItemPref {
  id: string;
  enabled: boolean;
}

/** 全局快捷键偏好（对应 Rust HotkeysPref；前两槽 null/空串 = 用内置默认，
 *  triggerLookup null/空串 = 未绑定不注册）。默认值见 lib/hotkeys.ts */
export interface HotkeysPref {
  /** 划词开关快捷键 */
  toggleSelection?: string | null;
  /** 查词呼出快捷键（显示并聚焦主窗口） */
  showMain?: string | null;
  /** 划词查词快捷键（触发方式 = shortcut 时捕获当前选区；无内置默认） */
  triggerLookup?: string | null;
  /** OCR 取词快捷键（null/空串 = 内置默认 ctrl+alt+o） */
  ocrLookup?: string | null;
}

/** API 协议类型（值对齐 cherry ENDPOINT_TYPE 聊天三形态） */
export type ApiType = "openai-chat-completions" | "openai-responses" | "anthropic-messages";

/** 逐模型能力标记（预设标签； 模型卡改版：能力从卡级总开关改为逐模型集合）。
 *  thinking = 推理（唯一有运行时效果的思考门禁标记）/ vision = 图片输入（信息标记）/
 *  files = 文件上传（未实现，仅预留标记位） */
export type ModelCapability = "thinking" | "vision" | "files";

/** 已配置模型条目（模型卡内的单条模型） */
export interface ModelEntry {
  /** 模型 id（API 调用名，与 /models 返回一致） */
  id: string;
  /** 能力标记集（空 = 无任何标记 → 思考门禁保守关闭） */
  caps: ModelCapability[];
}

/** 模型卡：单家供应商的持久配置（模型服务重构，对应 Rust ProviderConfig） */
export interface ProviderConfig {
  id: string;
  endpoint: string;
  apiKey: string | null;
  /** 已配置模型（拉取列表后添加；逐模型能力标记） */
  models: ModelEntry[];
  /** API 协议类型（默认 openai-chat-completions） */
  apiType: ApiType;
}

/**  AI 服务配置（对应 Rust AiPrefs）。
 *  安全决策：apiKey 随偏好明文落盘（app_data_dir/preferences.json，用户目录 ACL
 *  保护，单用户本机威胁模型），不出本机；不为此引入 keyring。 */
export interface AiPrefs {
  /** 当前激活的 provider 预设 id（openai/deepseek/doubao/dashscope/opencode/custom） */
  provider: string | null;
  /** 全局默认模型（划词 AI 动作 / AI 词典 / 翻译页在手动选择前默认生效） */
  model: string | null;
  /** AI 词典：查词结果内置「AI 词典」在线词典形态 */
  dictEnabled: boolean;
  /** AI 词典系统提示词；null = 前端内置默认 */
  dictPrompt: string | null;
  /** AI 词典允许思考（默认 false 快响应；实际生效还需激活卡 thinking=true） */
  dictAllowThink: boolean;
  /** AI 词典模型（`"{providerId}:{model}"` 绑定卡+模型；null = 用全局默认模型） */
  dictModel: string | null;
  /** 每家供应商的持久配置（模型卡） */
  providers: ProviderConfig[];
}

/** 发音偏好（对应 Rust PronouncePrefs；本地 TTS 接入）。
 *  链 = 有序优先级列表，逐项尝试取第一个可用；项缺席 = 停用。
 *  值域：dict = 本地词典 MDD 录音 / webdict = 在线词典音频 / tts = 系统语音 */
export interface PronouncePrefs {
  /** 单词发音链（缺省 dict → webdict → edge → tts） */
  wordChain: Array<"dict" | "webdict" | "edge" | "tts">;
  /** 句子朗读链（缺省 edge → tts） */
  sentenceChain: Array<"dict" | "webdict" | "edge" | "tts">;
  /** 六槽音源（key = zh-f / zh-m / en-us-f / en-us-m / en-gb-f / en-gb-m；
   *  值 = "local:<语音id>" | "edge:<shortName>"）。**没有「自动」态**：缺槽由后端
   *  补默认音源（配置始终完整）；槽内音色不可用时由朗读链降级到本机引擎 */
  voiceSlots: Record<string, string>;
  /** 朗读按钮 A / B 的英文口音倾向（"us" / "gb"）：并列两个按钮（例句 / 译文 /
   *  AI 词典原词旁）**性别固定**——按钮 1（A）= 女声、按钮 2（B）= 男声，
   *  这里只选英文读美音还是英音；中文文本没有口音维度，固定取「中文 ·
   *  女声 / 男声」槽，与倾向无关 */
  sayBtnA: string;
  sayBtnB: string;
  /** 英文默认口音（"" = 自动（美音优先）/ "us" / "gb"） */
  enAccent: string;
  /** 语速（0.5–1.5；1.0 = 原速） */
  rate: number;
  /** 词条无发音资源时自动回退系统语音 */
  fallbackMissing: boolean;
}

export interface PrefsPayload {
  /** 词典根目录绝对路径；null = 自动探测（dev：cwd 父链找 test/dicts） */
  dictRoot: string | null;
  selectionEnabled: boolean;
  clipboardFallback: boolean;
  /** 剪贴板监听查词（复制即查；默认关） */
  clipboardLookup: boolean;
  /** 划词栏动作配置；null = 前端默认集 */
  actionItems: ActionItemPref[] | null;
  /** 词典管理配置；null = 全启用按扫描序 */
  dictItems: DictItemPref[] | null;
  /** AI 服务配置；null = 未配置（AI 动作与 AI 词典不可用） */
  ai: AiPrefs | null;
  /** AI 翻译目标语言（动作面板选择器持久化）；null = 默认 zh-cn */
  translateLang: string | null;
  /** 翻译页源语言（null/空 = 自动检测；仅作为翻译提示告知 LLM） */
  translateSourceLang: string | null;
  /** 划词浮标紧凑模式（只显示图标） */
  toolbarCompact: boolean;
  /** 翻译页模型覆盖；null = 全局默认模型 */
  translateModel: string | null;
  /** 翻译页提示词覆盖（{{target_language}}/{{text}} 占位）；null = 内置模板 */
  translatePrompt: string | null;
  /** 翻译页允许思考（默认 false 快响应；实际生效还需激活卡 thinking=true） */
  translateAllowThink: boolean;
  /** 全局快捷键配置；null = 全部用内置默认（单槽 null = 该槽用默认） */
  hotkeys: HotkeysPref | null;
  /** 仅本地词典全部未命中才查在线（面板侧恒为 true，不受此偏好影响） */
  webFallbackOnly: boolean;
  /** 词典外链走向：true = 系统浏览器打开（默认）；false = 转词典内部查词 */
  webExternal: boolean;
  /** 学习卡出现时自动发音（关闭仍可点卡面发音按钮手动发音） */
  reviewAutoPronounce: boolean;
  /** 划词触发方式：selected = 拖选/双击即查（默认）/ ctrlkey = 按住 Ctrl /
   *  shortcut = 快捷键（hotkeys.triggerLookup 槽位） */
  selectionTrigger: "selected" | "ctrlkey" | "shortcut";
  /** 划词进程过滤模式：default = 预定义黑名单 / whitelist = 仅列表内 /
   *  blacklist = 用户列表（selected 触发下并入预定义） */
  selectionFilterMode: "default" | "whitelist" | "blacklist";
  /** 用户过滤列表（进程名子串匹配，小写） */
  selectionFilterList: string[];
  /** OCR 识别语言（BCP-47 标签；空串 = 自动链 zh-Hans-CN → en-US → 用户语言） */
  ocrLang: string;
  /** 截图 AI 图译模型（本地 OCR 失败的 AI 兜底 + bar 常驻按钮）：
   *  格式 `providerId:model`（跨卡路由，同 dictModel）；空串 = 未设置 */
  ocrVisionModel: string;
  /** 截图翻译目标语言：空串/"auto" = 自动检测源语言并译为中文（
   *，对齐微信截图翻译；废止旧「中→英其他→中」启发式）；
   *  其他 = 固定目标语言 code（TARGET_LANGS）。与翻译 Tab 的 translateLang 解耦 */
  ocrTargetLang: string;
  /** 截图后自动系统识别：false（默认）= 只截屏钉原位，
   *  工具条「识别文字」按钮手动触发；true = 保留拖框即识别的原行为 */
  ocrAutoRecognize: boolean;
  /** 启动时检查更新（默认关；检查动作只在下次启动生效，设置页内仍可手动检查） */
  checkUpdateOnStartup: boolean;
  /** 发音（朗读源链 + 系统语音选择；旧文件缺字段由后端取默认） */
  pronounce: PronouncePrefs;
}
