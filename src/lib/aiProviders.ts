/**
 * AI provider 预设：预设 + 弹出设置窗为通用编辑范式，单一激活配置；cherry
 * 主仓 AGPL 只读参考未复制。
 * endpoint 为各官方 base URL（数据对齐本地 cherry 仓库 provider 基线）；model 仅为
 * 弹窗示例预填值，可改或拉取列表后速选。**note 只写运维事实（获取 Key / 端点兼容
 * 形态）**——不写模型代际与能力解释（时效性内容以端点实拉的 /models 为准）。
 */
export interface ProviderPreset {
  id: string;
  name: string;
  /** 预填的 base URL */
  endpoint: string;
  /** 示例默认模型（可改/可拉取列表） */
  model: string;
  /** 获取 API Key 的入口页（可选） */
  keyUrl?: string;
  /** 备注说明（可选，仅运维事实） */
  note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    keyUrl: "https://platform.deepseek.com/api_keys",
    note: "也支持 Anthropic 协议（API 类型可选；端点用 https://api.deepseek.com/anthropic）",
  },
  {
    id: "doubao",
    name: "火山引擎（豆包）",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-1-6-flash-250715",
    keyUrl: "https://console.volcengine.com/ark",
    note: "需在方舟控制台开通模型并创建 API Key",
  },
  {
    id: "dashscope",
    name: "阿里云百炼",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-flash",
    keyUrl: "https://bailian.console.aliyun.com/",
  },
  {
    id: "opencode",
    name: "OpenCode Go",
    endpoint: "https://opencode.ai/zen/go/v1",
    model: "glm-5.3",
    keyUrl: "https://opencode.ai/auth",
  },
  {
    id: "custom",
    name: "自定义",
    endpoint: "",
    model: "",
  },
];

export function providerPresetById(id: string | null | undefined): ProviderPreset | null {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? null;
}
