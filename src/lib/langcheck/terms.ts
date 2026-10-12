/**
 * 用户术语表 provider：禁用词 → 首选词的替换规则（Vale substitution 四元组
 * 形态——匹配词 / 替换词 / 说明 / 级别；条目为用户自建，持久化在
 * check-terms.json，Rust 侧只存取，匹配在前端）。
 *
 * 匹配语义：
 * - 大小写不敏感，逐字符比较而非整体 toLowerCase——个别 Unicode 字符的小写化
 *   会改变字符串长度（如下标对齐敏感场景），整体折叠会破坏命中位置换算；
 * - 纯 ASCII 术语要求词边界（前后不能是字母数字），避免「nodejs」命中
 *   「nodejsbook」；含 CJK 的术语无边界要求（中文书写无空格分隔）；
 * - 命中段不重叠推进，避免「进行」在「进行进行」里重复计数。
 */
import type { TermEntry } from "../../types/check";
import { ruleFinding, type Finding } from "./finding.ts";

const ASCII_ONLY = /^[\x20-\x7E]+$/;
const WORD_CHAR = /[A-Za-z0-9]/;

function matchesAt(text: string, start: number, needleLower: string): boolean {
  for (let j = 0; j < needleLower.length; j++) {
    if (text[start + j]?.toLowerCase() !== needleLower[j]) return false;
  }
  return true;
}

export function runTermChecks(text: string, terms: TermEntry[]): Finding[] {
  const out: Finding[] = [];
  for (const term of terms) {
    if (!term.enabled) continue;
    const wrong = term.wrong.trim();
    const right = term.right.trim();
    if (!wrong || wrong === right) continue;
    const needle = wrong.toLowerCase();
    const bounded = ASCII_ONLY.test(wrong);
    for (let i = 0; i + wrong.length <= text.length; i++) {
      if (!matchesAt(text, i, needle)) continue;
      if (bounded && WORD_CHAR.test(text[i - 1] ?? "")) continue;
      if (bounded && WORD_CHAR.test(text[i + wrong.length] ?? "")) continue;
      const note = term.note?.trim();
      out.push(
        ruleFinding(
          text,
          {
            ruleId: `term:${term.id}`,
            category: "terminology",
            severity: term.level,
            message: `术语不统一：建议用「${right}」替换「${wrong}」${note ? `（${note}）` : ""}`,
            index: i,
            length: wrong.length,
            replacement: right,
          },
          out.length,
        ),
      );
      i += wrong.length - 1;
    }
  }
  return out;
}
