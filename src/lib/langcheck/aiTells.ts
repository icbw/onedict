/**
 * 自建中文 AI 式表达规则（数据与执行分离：本文件是可版本化的规则数据，
 * 规则资产随「AI 词保质期」更新，不混入引擎代码）。
 *
 * 来源与许可：检查点设计派生自 Humanizer-zh（MIT，https://github.com/op7418/Humanizer-zh，
 * F 类中文补充：长定语 / 进行＋动词 / 被字句堆叠 / 四字词排比 / 万能背景 / 套话收尾）
 * 与 stop-slop（MIT，https://github.com/hardikpandya/stop-slop 的禁用短语与结构性陈词分类），
 * 规则正文为本仓逐条重写，未整段复制任何来源文本。Wikipedia: Signs of AI writing
 * （CC BY-SA 4.0）仅作分类观察来源，未复制其词表。
 *
 * 质量纪律（误报豁免是规则质量分水岭）：
 * - 词表只收判别力强的条目（「可以说」句中出现是正常中文，仅句首 + 逗号形态命中）；
 * - severity 定级保守：明确建议改 = warning，仅风格提示 = info；LC1 不出 error
 *   （error 留给排版层的确定性错误）；
 * - 通用虚词 / 单字副词 / 正常学术用语不收。
 */
import type { CheckCategory, CheckSeverity } from "./finding";

/** 词表类规则：正则逐处命中（global flag 必须） */
export interface PatternRule {
  kind: "pattern";
  id: string;
  category: CheckCategory;
  severity: CheckSeverity;
  pattern: RegExp;
  message: string;
  /** 建议替换（命中片段 → 新文本）；null = 需人工重写，不可单点修复 */
  replacement?: (m: RegExpExecArray) => string | null;
}

/** 句式类规则：句子级统计（句内多次命中 / 结构特征） */
export interface SentenceRule {
  kind: "sentence";
  id: string;
  category: CheckCategory;
  severity: CheckSeverity;
  /** 单句扫描：返回命中（index/length 相对全文由引擎换算） */
  scan: (sentence: string, offset: number) => {
    index: number;
    length: number;
    message: string;
  }[];
}

export type AiTellRule = PatternRule | SentenceRule;

/** 句子切分（中文句末标点 + 换行；返回 [start, end) 区间，含标点） */
export function splitSentences(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ("。！？；\n".includes(c)) {
      out.push([start, i + 1]);
      start = i + 1;
    }
  }
  if (start < text.length) out.push([start, text.length]);
  return out.filter(([s, e]) => text.slice(s, e).trim().length > 0);
}

const RULES: AiTellRule[] = [
  // ── 套路开头（万能背景） ──
  {
    kind: "pattern",
    id: "cliche-opening",
    category: "ai-tell",
    severity: "warning",
    pattern:
      /(在(当今|如今|当下)[^，。；！？\n]{0,12}(发展|变化|演进|变革|爆炸)的?(时代|社会)(中|下)?)|(随着(数字|信息|人工|网络|科技|经济|全球化)[^，。；！？\n]{0,8}的?(不断|快速|飞速|日益)?(发展|进步|普及|深入|推进))/g,
    message: "万能背景开头：先铺大背景再入正题是典型套话结构，建议直接从具体事实写起。",
  },
  // ── 强调口头禅（句首 + 逗号锚定，句中「可以说」是正常中文不收） ──
  {
    kind: "pattern",
    id: "filler-prefix",
    category: "ai-tell",
    severity: "warning",
    // 句首锚定用 lookbehind：前面不是句末标点/行首 = 句中（正常中文，不命中）
    pattern: /(?<![^\n。！？；])(众所周知|毋庸置疑|不可否认|不言而喻|可以说|不得不说|值得(特别)?注意的是|值得(一提|关注|强调)的是)[，,]/g,
    message: "强调口头禅：此类前缀多为凑强调语气，删除后语义通常不受损。",
    replacement: () => "",
  },
  // ── 机械总结收尾 ──
  {
    kind: "pattern",
    id: "mechanical-summary",
    category: "ai-tell",
    severity: "warning",
    pattern: /(总而言之|综上所述)[，,]/g,
    message: "套路化总结开头：结论段以固定套话起手是常见 AI 腔，建议直接陈述结论。",
  },
  // ── 宣传腔用词（判别力强的少量条目；「致力于/旨在」在机构文体中正常，不收） ──
  {
    kind: "pattern",
    id: "promo-tone",
    category: "ai-tell",
    severity: "warning",
    pattern: /(赋能|深度融合|全方位(提升|布局|覆盖|赋能)|强强联合)/g,
    message: "宣传腔用词：抽象拔高词替换具体表述是典型 AI 腔，建议改写为具体动作或事实。",
  },
  // ── 模糊归因 ──
  {
    kind: "pattern",
    id: "vague-attribution",
    category: "ai-tell",
    severity: "warning",
    pattern: /(据悉|业内人士(指出|认为|表示)?|有观点认为|有分析(指出|认为)|有关(方面|部门)(指出|认为|表示))/g,
    message: "模糊归因：无具体来源的「据悉 / 有观点认为」削弱可信度，建议补明出处或删除。",
  },
  // ── 空洞程度副词（info：正常写作偶用，仅提示） ──
  {
    kind: "pattern",
    id: "padding-adverb",
    category: "ai-tell",
    severity: "info",
    pattern: /(极大地|充分(地)?(彰显|证明|表明)|有力地(证明|推动))/g,
    message: "空洞强调：「极大地 / 充分彰显」类程度堆叠代替具体程度描述，建议给出量化或事实。",
  },
  // ── 三段式排比（「更X、更Y、更Z」拔高结构） ──
  {
    kind: "pattern",
    id: "rule-of-three",
    category: "ai-tell",
    severity: "info",
    pattern: /更(加)?[^，。；！？\n]{1,8}(?:\s*[、，]\s*更(加)?[^，。；！？\n]{1,8}){2,}/g,
    message: "三段式排比：「更X、更Y、更Z」的拔高结构高频见于 AI 生成文本，若非有意修辞建议打散。",
  },
  // ──「进行 + 动词」冗余（fixable） ──
  {
    kind: "pattern",
    id: "redundant-jinhang",
    category: "style",
    severity: "warning",
    pattern:
      /进行(了|着)?(分析|研究|讨论|调查|总结|优化|改进|处理|解决|管理|实施|评估|审查|检查|测试|验证|确认|比较|说明|解释|汇报|整理|修改|调整|部署|开发|设计|规划|安排|准备|执行|落实|推进|开展|协商|沟通|统计|排查|维护|升级|迭代|重构|交付|验收|审批|登记|记录)/g,
    message: "「进行＋动词」冗余：直接用动词更简洁。",
    replacement: (m) => m[2],
  },
  // ── 被字句堆叠（句级统计） ──
  {
    kind: "sentence",
    id: "passive-pileup",
    category: "style",
    severity: "info",
    scan(sentence, offset) {
      const hits: Array<{ index: number; length: number; message: string }> = [];
      let count = 0;
      for (let i = 0; i < sentence.length - 1; i++) {
        if (sentence[i] === "被" && /[\u4e00-\u9fff]/.test(sentence[i + 1])) {
          count++;
          if (count === 2) {
            hits.push({
              index: offset + i,
              length: 1,
              message: "一句内多个「被」字被动：连续被动可读性差，建议部分改为主动句。",
            });
            break; // 每句只报一次
          }
        }
      }
      return hits;
    },
  },
];

export { RULES as AI_TELL_RULES };
