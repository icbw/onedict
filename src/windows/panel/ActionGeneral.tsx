/**
 *  通用 AI 动作（动作面板）：解释 / 总结 / 润色（内置提示词）与自定义动作
 * （名称/提示词/动作级模型，{{text}} 占位选中文本）。行为基线 pickdict
 * ActionGeneral（MIT 白名单，// from pickdict (MIT), adapted for Tauri：
 * i18n 换硬编码中文，Markdown 换 Minimark，AI 会话层走 Rust ai_stream 代理）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { applyPromptTemplate, builtinPrompt } from "../../lib/actionPrompts";
import { activeProvider, effectiveModelName, modelThinking } from "../../lib/aiConfig";
import type { AiStreamConfig, AiStreamMessage } from "../../services/aiStream";
import type { PrefsPayload } from "../../types/prefs";
import { AiBody, AiFooter, ShowOriginal, useAiStream } from "./aiParts";

/** 提示词组装：偏好覆盖优先（设置页编辑弹窗可给内置动作配 prompt），留空回内置模板 */
function composePrompt(actionId: string, prompt: string | undefined, text: string): string {
  if (prompt?.trim()) return applyPromptTemplate(prompt, text);
  const builtin = builtinPrompt(actionId);
  if (builtin) return applyPromptTemplate(builtin, text);
  return text;
}

export default function ActionGeneral({
  actionId,
  text,
  prompt,
  model,
  allowThink = false,
  scrollToBottom,
}: {
  /** 动作 id（内置 explain/summary/refine 或自定义 user-*） */
  actionId: string;
  /** 划词选中文本 */
  text: string;
  /** 自定义动作提示词（内置动作忽略） */
  prompt?: string;
  /** 动作级模型覆盖 */
  model?: string;
  /** 动作级思考开关（编辑弹窗配置；实际生效 = 开关 && 激活卡推理模型标记） */
  allowThink?: boolean;
  scrollToBottom?: () => void;
}) {
  const { content, error, loading, run, stop } = useAiStream();
  const [cardThinking, setCardThinking] = useState(false);

  // 实际模型的推理标记（门禁）——读一次即可（弹窗期配置变更少见，重新打开会话即刷新）
  useEffect(() => {
    void invoke<PrefsPayload>("prefs_get")
      .then((p) =>
        setCardThinking(modelThinking(activeProvider(p.ai), effectiveModelName(model, p.ai))),
      )
      .catch(() => {});
  }, []);

  const messages = useMemo<AiStreamMessage[]>(
    () => [{ role: "user", content: composePrompt(actionId, prompt, text) }],
    [actionId, prompt, text],
  );

  const fetchResult = useCallback(() => {
    const config: AiStreamConfig = { model, noThink: !(allowThink && cardThinking) };
    void run(messages, config, { scrollToBottom });
  }, [messages, model, allowThink, cardThinking, run, scrollToBottom]);

  useEffect(() => {
    void fetchResult();
  }, [fetchResult]);

  return (
    <div className="flex w-full flex-col items-center">
      <div className="flex w-full flex-row items-center justify-end">
        <ShowOriginal text={text} />
      </div>
      <AiBody content={content} error={error} loading={loading} className="mt-1" />
      <AiFooter
        loading={loading}
        content={content}
        onStop={stop}
        onRegenerate={fetchResult}
      />
    </div>
  );
}
