/**
 *  AI 翻译动作（动作面板）：源语言「自动检测」+ 目标语言选择（偏好持久化）+
 * 显示原文 + 流式正文 + 页脚。行为基线 pickdict ActionTranslate（MIT 白名单，
 * // from pickdict (MIT), adapted for Tauri：i18n/usePreference 换最小实现，
 * Markdown 换 Minimark，AI 会话层走 Rust ai_stream 代理）。
 * 提示词：偏好覆盖（编辑弹窗）优先，内置模板取 lib/actionPrompts（cherry
 * TRANSLATE_PROMPT 语义）；默认非思考（快响应），动作编辑弹窗可开（仍受卡能力门禁）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, Globe2 } from "lucide-react";
import { applyPromptTemplate, builtinPrompt } from "../../lib/actionPrompts";
import { activeProvider, effectiveModelName, modelThinking } from "../../lib/aiConfig";
import { targetLangByCode } from "../../lib/translate";
import LangSelect from "../../components/LangSelect";
import type { AiStreamConfig, AiStreamMessage } from "../../services/aiStream";
import type { PrefsPayload } from "../../types/prefs";
import { AiBody, AiFooter, ShowOriginal, useAiStream } from "./aiParts";

export default function ActionTranslate({
  text,
  prompt,
  model,
  allowThink = false,
  scrollToBottom,
}: {
  /** 划词选中文本 */
  text: string;
  /** 提示词覆盖（设置页编辑弹窗可配）；留空用内置语言模板 */
  prompt?: string;
  /** 动作级模型覆盖 */
  model?: string;
  /** 动作级思考开关（实际生效 = 开关 && 激活卡推理模型标记） */
  allowThink?: boolean;
  scrollToBottom?: () => void;
}) {
  const [langCode, setLangCode] = useState("zh-cn");
  const [cardThinking, setCardThinking] = useState(false);
  const { content, error, loading, run, stop } = useAiStream();

  // 目标语言偏好（pickdict feature.translate.action.preferred_lang 语义，与翻译 Tab 共享）
  // + 激活卡思考能力标记（门禁）
  useEffect(() => {
    void invoke<PrefsPayload>("prefs_get")
      .then((p) => {
        if (p.translateLang) setLangCode(p.translateLang);
        // 思考门禁逐模型化：动作模型覆盖 ?? 全局默认（与 ai_stream 回退序一致）
        setCardThinking(modelThinking(activeProvider(p.ai), effectiveModelName(model, p.ai)));
      })
      .catch(() => {});
  }, []);

  const changeLang = (code: string) => {
    setLangCode(code);
    void invoke("prefs_set_translate_lang", { lang: code }).catch(() => {});
  };

  const targetLang = targetLangByCode(langCode);

  const messages = useMemo<AiStreamMessage[]>(() => {
    if (!text.trim()) return [];
    const content = prompt?.trim()
      ? applyPromptTemplate(prompt, text)
      : applyPromptTemplate(builtinPrompt("translate", targetLang.promptName), text);
    return [{ role: "user", content }];
  }, [text, prompt, targetLang.promptName]);

  const fetchResult = useCallback(() => {
    if (!messages.length) return;
    // 思考：动作开关 && 实际模型推理标记（门禁）；翻译默认非思考，编辑弹窗可开
    const config: AiStreamConfig = {
      model,
      noThink: !(allowThink && cardThinking),
    };
    void run(messages, config, { scrollToBottom });
  }, [messages, model, allowThink, cardThinking, run, scrollToBottom]);

  useEffect(() => {
    void fetchResult();
  }, [fetchResult]);

  return (
    <div className="flex w-full flex-1 flex-col items-center">
      <div className="flex w-full flex-wrap items-center gap-x-1.5 gap-y-1">
        <div className="flex min-w-0 shrink items-center gap-1.5">
          <div className="flex min-w-0 items-center rounded bg-muted px-2 py-1 text-foreground-secondary text-xs whitespace-nowrap">
            <Globe2 className="mr-1 inline size-3.5 align-[-2px]" />
            <span className="min-w-0 truncate">自动检测</span>
          </div>
          <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
          <LangSelect
            value={targetLang.code}
            disabled={loading}
            onChange={changeLang}
            className="max-w-[160px] min-w-[100px] justify-between rounded bg-muted px-2 py-1 text-sm transition-colors hover:bg-accent"
          />
        </div>
        <div className="ml-auto flex shrink-0 items-center">
          <ShowOriginal text={text} />
        </div>
      </div>

      <AiBody content={content} error={error} loading={loading} className="mt-3" />
      <AiFooter
        loading={loading}
        content={content}
        onStop={stop}
        onRegenerate={fetchResult}
      />
    </div>
  );
}
