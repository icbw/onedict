/**
 * AI 配置存取 helper（模型卡重构； 模型卡改版：能力标记逐模型化）。
 * 所有消费方（浮标/词典页/面板/设置页）统一走这里，不直接摸 AiPrefs 字段。
 */
import type { AiPrefs, ModelCapability, ProviderConfig } from "../types/prefs";

/** 激活 provider 卡（未激活/未配置 → null） */
export function activeProvider(ai: AiPrefs | null | undefined): ProviderConfig | null {
  if (!ai?.provider) return null;
  return ai.providers.find((p) => p.id === ai.provider) ?? null;
}

/** 激活卡的模型 id 列表（默认模型可选项来源） */
export function activeModels(ai: AiPrefs | null | undefined): string[] {
  return (activeProvider(ai)?.models ?? []).map((m) => m.id);
}

/** 激活卡端点 */
export function activeEndpoint(ai: AiPrefs | null | undefined): string | null {
  return activeProvider(ai)?.endpoint.trim() || null;
}

/** AI 配置就绪（激活卡端点 + 全局默认模型均已配置）——AI 动作点亮与设置页门禁共用 */
export function aiReady(ai: AiPrefs | null | undefined): boolean {
  return !!activeEndpoint(ai) && !!ai?.model?.trim();
}

/** 卡内模型的能力集（未登记模型/空名/缺卡 = 空集——能力是标记不是开关） */
export function modelCaps(
  card: ProviderConfig | null | undefined,
  model: string | null | undefined,
): ModelCapability[] {
  const m = model?.trim();
  if (!card || !m) return [];
  return card.models.find((e) => e.id === m)?.caps ?? [];
}

/** 卡内模型是否标记推理能力（思考门禁）。
 * 场景统一范式（翻译页）：实际思考 = 场景开关 && modelThinking(路由卡, 实际模型)，
 *  传给 streamChat 的 noThink = 两者与的取反——能力是传递的标记，不是总开关。 */
export function modelThinking(
  card: ProviderConfig | null | undefined,
  model: string | null | undefined,
): boolean {
  return modelCaps(card, model).includes("thinking");
}

/** 场景实际生效模型名：显式覆盖 ?? 全局默认（与 Rust ai_stream 回退序一致；
 *  undefined = 未配置，由 Rust 报错兜底） */
export function effectiveModelName(
  override: string | null | undefined,
  ai: AiPrefs | null | undefined,
): string | undefined {
  return override?.trim() || ai?.model?.trim() || undefined;
}

/** AI 词典模型绑定值解析：`"{providerId}:{model}"` → 路由卡 + 模型；
 *  null/空 = 跟随全局默认模型（不指定卡）。 */
export function splitDictModel(
  v: string | null | undefined,
): { provider?: string; model?: string } {
  if (!v) return {};
  const i = v.indexOf(":");
  if (i < 0) return { model: v };
  return { provider: v.slice(0, i), model: v.slice(i + 1) };
}

/** 场景模型绑定值（`"{providerId}:{model}"`）实际路由的卡：绑定了卡则用该卡，
 *  否则回退全局激活卡（无前缀的旧值 = 跟随激活卡，天然兼容）。
 *  思考开关门禁与请求路由共用此判定。 */
export function routeCard(
  ai: AiPrefs | null | undefined,
  binding: string | null | undefined,
): ProviderConfig | null {
  const { provider } = splitDictModel(binding);
  if (provider) {
    return ai?.providers.find((c) => c.id === provider) ?? null;
  }
  return activeProvider(ai);
}

/** AI 词典请求实际路由的卡（dictModel 绑定卡优先） */
export function dictRouteCard(ai: AiPrefs | null | undefined): ProviderConfig | null {
  return routeCard(ai, ai?.dictModel);
}
