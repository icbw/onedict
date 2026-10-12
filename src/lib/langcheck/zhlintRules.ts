/**
 * zhlint provider（vendored 0.8.2，MIT——见 src/vendor/zhlint/README.md）：
 * 纯文本排版检查 → 统一 Finding。
 *
 * hyperParse 传空数组禁用 markdown / hexo / ignore 注释预处理——划词文本不是
 * Markdown 源文，`#`、`*` 不应被当作标记（否则纯文本误报 markdown 规则、
 * 标记内文本被跳过检查）。
 *
 * zhlint 的 validation 自带中文 message（上游 0.8.2 的 name 字段声明了但
 * 恒为空串，见函数内注释）；severity 统一 warning——排版问题确定性高但多为
 * 风格层面，不与自建规则中「明确建议改」的 warning 混淆层级（自建规则纪律：
 * LC1 不出 error）。
 *
 * 引擎异常（个别输入触发上游解析 bug）整体静默降级：排版层缺失不致命，
 * 自建规则层照常工作。
 */
import "./nodeShim.ts";
import { run } from "../../vendor/zhlint/zhlint.es.js";
import { ruleFinding, type Finding } from "./finding.ts";

/** 上游规则预设（缺省不传 = 全部规则关闭，必须显式启用默认集） */
const ZHLINT_RULES = { preset: "default" };

export function runZhlintChecks(text: string): Finding[] {
  if (!text.trim()) return [];
  let validations;
  try {
    validations = run(text, { hyperParse: [], rules: ZHLINT_RULES }).validations;
  } catch {
    return [];
  }
  const out: Finding[] = [];
  for (const v of validations) {
    // 0.8.2 的 run() 输出中 validation.name 恒为空串（d.ts 声明但生成器未填，
    // message 才是稳定键）——name 有值时带上便于未来按规则粒度豁免
    const ruleId = v.name ? `zhlint:${v.name}` : "zhlint";
    out.push(
      ruleFinding(
        text,
        {
          ruleId,
          category: "layout",
          severity: "warning",
          message: v.message,
          index: v.index,
          length: Math.max(1, v.length),
        },
        out.length,
      ),
    );
  }
  return out;
}
