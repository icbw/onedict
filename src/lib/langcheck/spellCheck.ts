/**
 * 词典拼写检查：英文词存在性判定。词典侧（check_spell_lookup）只做 key 索引
 * 二分；本模块负责取词与英文形态还原——词典词头是原形，屈折变形须还原后再查
 * （-s/-es/-ies/-ing/-ed 多候选回查，任一候选命中即视为收录）。
 *
 * 取词的误报豁免（专有名词是拼写误报大户，宁可漏报不误报）：
 * - 全大写 = 缩写（NASA / CSS），跳过；内部含大写 = 驼峰标识符（JavaScript），跳过；
 * - 句中大写词 = 专名（John works at…），跳过；句首大写是正常拼写，按小写查；
 * - 白名单压残余误报（用户自建，持久化在 check-terms.json）。
 *
 * 协议容错：词典探针失败 / 返回形状不符 → 整层静默降级（宁可不提示，不误报）。
 */
import { ruleFinding, type Finding } from "./finding.ts";

export interface SpellToken {
  raw: string;
  index: number;
  length: number;
  /** 查询用小写形态 */
  check: string;
}

const TOKEN_RE = /[A-Za-z][A-Za-z'’-]*/g;

/** 词前是否句末标点 / 文首（决定首字母大写是正常拼写还是专名） */
function isSentenceStart(text: string, at: number): boolean {
  for (let i = at - 1; i >= 0; i--) {
    const c = text[i];
    if (!/\s/.test(c)) return ".!?…。！？；;:".includes(c);
  }
  return true;
}

export function extractSpellTokens(text: string, whitelist: Set<string>): SpellToken[] {
  const out: SpellToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    // 尾部悬挂的连字符/撇号按标点处理（断词连字符），不参与判定与高亮
    const raw = m[0].replace(/[-'’]+$/, "");
    if (raw.length < 2) continue;
    if (raw === raw.toUpperCase() && /[A-Z]/.test(raw)) continue;
    if (/[A-Z]/.test(raw.slice(1))) continue;
    if (/^[A-Z]/.test(raw) && !isSentenceStart(text, m.index)) continue;
    const word = raw.toLowerCase();
    if (whitelist.has(word)) continue;
    out.push({ raw, index: m.index, length: raw.length, check: word });
  }
  return out;
}

/** 英文形态还原：原词 + 逐步剥后缀的候选原形列表（去重，≥2 字） */
export function spellCandidates(word: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    if (s.length >= 2 && !out.includes(s)) out.push(s);
  };
  push(word);
  let w = word;
  if (/[’']s$/.test(w)) {
    w = w.replace(/[’']s$/, "");
    push(w);
  }
  // ies→y 需长度门槛：dies/lies 这类短词正确还原是去掉 s（die/lie）
  if (w.endsWith("ies") && w.length >= 5) push(w.slice(0, -3) + "y");
  if (w.endsWith("es")) push(w.slice(0, -2));
  if (w.endsWith("s") && !w.endsWith("ss")) push(w.slice(0, -1));
  if (w.endsWith("ing") && w.length >= 5) {
    const stem = w.slice(0, -3);
    push(stem);
    push(stem + "e"); // coming → come
    if (/(.)\1$/.test(stem)) push(stem.slice(0, -1)); // running → run
  }
  if (w.endsWith("ed") && w.length >= 4) {
    const stem = w.slice(0, -2);
    push(stem);
    push(w.slice(0, -1)); // organized → organize
    if (/(.)\1$/.test(stem)) push(stem.slice(0, -1)); // stopped → stop
  }
  // 复合连字符词按整体查不到时，两半各自成词即视为正常（well-known）
  if (w.includes("-")) {
    for (const part of w.split("-")) push(part);
  }
  return out;
}

/**
 * 全流程：取词 → 候选池去重 → 批量探针（一次 IPC）→ 未收录词出 typo finding。
 * lookup = 存在性批量探针（返回与入参对齐的布尔数组），由 UI 注入 Tauri invoke。
 */
export async function runSpellChecks(
  text: string,
  whitelist: string[],
  lookup: (words: string[]) => Promise<boolean[]>,
): Promise<Finding[]> {
  const wl = new Set(whitelist.map((w) => w.trim().toLowerCase()).filter(Boolean));
  const tokens = extractSpellTokens(text, wl);
  if (tokens.length === 0) return [];
  const candidateIndex = new Map<string, number>();
  const flat: string[] = [];
  for (const t of tokens) {
    for (const c of spellCandidates(t.check)) {
      if (!candidateIndex.has(c)) {
        candidateIndex.set(c, flat.length);
        flat.push(c);
      }
    }
  }
  let found: boolean[];
  try {
    found = await lookup(flat);
  } catch {
    return [];
  }
  if (!Array.isArray(found) || found.length !== flat.length) return [];
  const out: Finding[] = [];
  for (const t of tokens) {
    const known = spellCandidates(t.check).some((c) => found[candidateIndex.get(c)!]);
    if (known) continue;
    out.push(
      ruleFinding(
        text,
        {
          ruleId: "spell",
          category: "typo",
          severity: "warning",
          message: `词典未收录「${t.raw}」——可能拼写有误；若为专有名词或行业用语，可加入白名单。`,
          index: t.index,
          length: t.length,
          replacement: null,
        },
        out.length,
      ),
    );
  }
  return out;
}
