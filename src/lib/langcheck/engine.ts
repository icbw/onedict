/**
 * 语言检查规则层引擎：本地同步执行，毫秒级、零网络、零 AI 依赖。
 *
 * 组成（provider 可插拔）：
 * - aiTells：自建中文 AI 式表达规则（aiTells.ts 数据文件）；
 * - terms：用户术语表（terms.ts；主窗口检查页签传入，划词 bar 快速检查不传）；
 * - zhlint：中文排版检查（vendored provider）；
 * - 词典拼写（spellCheck.ts）是异步 IPC 探针，由 UI 层并联后合并——引擎保持
 *   纯同步函数（node 基线零 mock 可跑），不做引擎内 await。
 * - LLM 层走 ai_stream（非本引擎职责）。
 *
 * 幂等性：finding id = ruleId + 全局序号，provider 顺序固定 → 同文本重跑结果
 * 一致；applyFixes 应用可修复项后，对应规则不再命中（如「进行了分析」→「分析」）。
 *
 * 纯函数、无 React/Tauri 依赖——node test/langcheck.mjs 基线覆盖。
 */
import { AI_TELL_RULES, splitSentences } from "./aiTells.ts";
import { ruleFinding, type Finding } from "./finding.ts";
import { runTermChecks } from "./terms.ts";
import { runZhlintChecks } from "./zhlintRules.ts";
import type { TermEntry } from "../../types/check";

export interface RuleCheckOptions {
  /** 用户术语表（terminology 类 findings 的数据源） */
  terms?: TermEntry[];
}

/** 引擎输出：findings 按原文位置升序（列表顺序稳定，UI 直接渲染） */
export function runRuleChecks(text: string, opts: RuleCheckOptions = {}): Finding[] {
  if (!text.trim()) return [];
  const findings: Finding[] = [];

  // provider: 自建 AI 腔规则
  for (const rule of AI_TELL_RULES) {
    if (rule.kind === "pattern") {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const replacement = rule.replacement ? rule.replacement(m) : null;
        findings.push(
          ruleFinding(
            text,
            {
              ruleId: rule.id,
              category: rule.category,
              severity: rule.severity,
              message: rule.message,
              index: m.index,
              length: m[0].length,
              replacement,
            },
            findings.length,
          ),
        );
        if (m[0].length === 0) re.lastIndex++; // 零宽匹配防死循环
      }
    } else {
      for (const [start, end] of splitSentences(text)) {
        for (const hit of rule.scan(text.slice(start, end), start)) {
          findings.push(
            ruleFinding(
              text,
              {
                ruleId: rule.id,
                category: rule.category,
                severity: rule.severity,
                message: hit.message,
                index: hit.index,
                length: hit.length,
                replacement: null,
              },
              findings.length,
            ),
          );
        }
      }
    }
  }

  // provider: 用户术语表（terminology）
  findings.push(...runTermChecks(text, opts.terms ?? []));

  // provider: zhlint（vendored）——纯文本排版检查（中英空格 / 全半角标点等）
  findings.push(...runZhlintChecks(text));

  return findings.sort((a, b) => (a.span?.index ?? 0) - (b.span?.index ?? 0));
}

/** 应用全部可修复项（从后往前替换避免偏移失效），返回修复后全文。
 *  不可修复 / 无 replacement / span 越界的项跳过。 */
export function applyFixes(text: string, findings: Finding[]): string {
  const fixable = findings
    .filter(
      (f): f is Finding & { span: NonNullable<Finding["span"]> } =>
        f.fixable &&
        f.replacement !== null &&
        f.span !== null &&
        f.span.index >= 0 &&
        f.span.index + f.span.length <= text.length,
    )
    .sort((a, b) => b.span.index - a.span.index);
  let out = text;
  for (const f of fixable) {
    out = out.slice(0, f.span.index) + f.replacement + out.slice(f.span.index + f.span.length);
  }
  return out;
}
