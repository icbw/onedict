/**
 * 语言分段（词条帧朗读按钮用）：把一段「可读文本」切成该给按钮的语言段（中英分开）。
 *
 * 本文件是**真实 JS 模块**，被两处共用，故不要写成模板字符串或 TS 函数：
 * - 帧内：`dictFrame.ts` 以 `?raw` 取源码、去掉 `export` 后内联进 srcdoc，
 *   `saySegmentsOf` 因此是帧脚本里的顶层函数；
 * - 单测：`test/frame.mjs` 直接 `import` 本模块（逐条断言分段规则），
 *   并对拍「帧内那份」的行为一致。
 *
 * 规则：
 * - 中文 ↔ 非中文边界处切段；短于 `FRAG` 个非空白字符的碎片随邻段
 *   （「这个 App 很好用。」不被切成三块），`\n`（换行 / 块边界）是硬断点；
 * - 合格判据：中文段 ≥ `MIN_ZH` 汉字且（末尾是句末标点 或 全长 ≥ 12）；
 *   非中文段 ≥ `MIN_WORDS` 词且 ≥ `MIN_LATIN` 非空白字符；音标窗口（`/teɪk/`、
 *   `[teɪk]`）与超长段（> `MAX`，多半是整段释义）不给按钮；
 * - `lang` 与父页 `services/textLang.ts` 的 `detectTextLang` 同判据——按钮提示
 *   与实际音色路由因此同源（一致性由 `test/frame.mjs` 断言）。
 *
 * @param {string} text 可读容器拼接出的文本（块边界 / `<br>` 以 `\n` 表示）
 * @returns {Array<{start: number, end: number, text: string, lang: "zh"|"en"|"other"}>}
 *   语言段：`start` / `end` 是段在该文本中的半开区间（`end` = 注入点，按钮紧跟段尾），
 *   `text` = 折叠空白后的待朗读文本
 */
export function saySegmentsOf(text) {
  // ── 常量 ──
  const MIN_ZH = 5; // 中文段下限：≥5 个汉字（含假名 / 谚文）
  const MIN_LATIN = 12; // 非中文段下限：≥12 个非空白字符
  const MIN_WORDS = 2; // 非中文段至少两个词（单词 / 词组不成句）
  const MAX = 500; // 上限：再长多半是整段释义，合成慢且读着没用
  const FRAG = 4; // 外来词碎片阈值：短于它随邻段（句中夹杂的外语词不切段）
  const FINAL = '。！？…!?.', // 句末标点（不含逗号 / 分号 / 冒号）
    REGION = ['uk', 'us', 'gb', 'br', 'bre', 'ame', 'nam']; // 音标区的口音标签

  const isCJK = (ch) => {
    const c = ch.codePointAt(0) || 0;
    return (
      (c >= 0x3040 && c <= 0x30ff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0xac00 && c <= 0xd7af) ||
      (c >= 0xf900 && c <= 0xfaff)
    );
  };
  const hasLetter = (s) => /[a-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff]/i.test(s);
  const dense = (s) => s.replace(/\s+/g, '');
  const cjkCount = (s) => {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (isCJK(s.charAt(i))) n += 1;
    return n;
  };
  const wordCount = (s) => s.split(/\s+/).filter((w) => hasLetter(w)).length;
  // 音标窗口（`UK /teɪk/`、`美 [teɪk]`）不是可读文本：去掉括注后没有实词
  const stripBrackets = (s) => {
    let out = '';
    let i = 0;
    while (i < s.length) {
      const ch = s.charAt(i);
      if (ch === '/' || ch === '[') {
        const close = ch === '/' ? '/' : ']';
        const j = s.indexOf(close, i + 1);
        if (j > i && j - i <= 80) {
          out += ' ';
          i = j + 1;
          continue;
        }
      }
      out += ch;
      i += 1;
    }
    return out;
  };
  const isIpaOnly = (s) => {
    const rest = stripBrackets(s).replace(/[英美·]/g, ' ');
    if (cjkCount(rest) > 0) return false;
    const toks = rest.toLowerCase().replace(/[^a-z]+/g, ' ').split(' ');
    for (let i = 0; i < toks.length; i++) {
      if (toks[i] && REGION.indexOf(toks[i]) < 0) return false;
    }
    return true;
  };
  // 语言判据 = textLang.detectTextLang（0.3 CJK 占比 → zh；含拉丁字母 / 数字且
  // 无其他文字系统 → en；其余 other）——帧脚本不能 import，故此处等价重写
  const langOf = (s) => {
    const d = dense(s);
    if (!d) return 'other';
    if (cjkCount(d) / d.length >= 0.3) return 'zh';
    if (!/[a-z0-9]/i.test(d)) return 'other';
    return /[\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff\u0900-\u097f]/.test(d)
      ? 'other'
      : 'en';
  };
  const qualifies = (s) => {
    const d = dense(s);
    if (!d || d.length > MAX) return false;
    const cjk = cjkCount(d);
    if (cjk / d.length >= 0.3) {
      const tail = s.charAt(s.length - 1);
      return cjk >= MIN_ZH && (FINAL.indexOf(tail) >= 0 || d.length >= 12);
    }
    const core = stripBrackets(s).trim();
    if (!core || isIpaOnly(core)) return false;
    return wordCount(core) >= MIN_WORDS && dense(core).length >= MIN_LATIN;
  };

  // ── 切段：先按「中文字符 / 其他」切 run，再合并——语言不同且两侧都够长才断，
  //    否则并入当前段（小块随大块，句子不被外来词切碎）──
  const parts = [];
  let cur = null;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '\n') {
      if (cur) parts.push(cur); // 换行 / 块边界 = 硬断点
      cur = null;
      i += 1;
      continue;
    }
    const cjk = isCJK(ch);
    let j = i + 1;
    while (j < text.length) {
      const c = text.charAt(j);
      if (c === '\n' || isCJK(c) !== cjk) break;
      j += 1;
    }
    const run = { start: i, end: j };
    if (!cur) {
      cur = run;
    } else if (cjk !== (langOf(text.slice(cur.start, cur.end)) === 'zh') && dense(text.slice(run.start, run.end)).length >= FRAG) {
      parts.push(cur);
      cur = run;
    } else {
      cur = { start: cur.start, end: run.end };
    }
    i = j;
  }
  if (cur) parts.push(cur);

  // ── 去空白 / 判定：段末即注入点，段内空白折叠后作朗读文本 ──
  const out = [];
  for (let k = 0; k < parts.length; k++) {
    const raw = text.slice(parts[k].start, parts[k].end);
    const seg = raw.trim();
    if (!seg || !qualifies(seg)) continue;
    const start = parts[k].start + (raw.length - raw.trimStart().length);
    out.push({ start, end: start + seg.length, text: seg.replace(/\s+/g, ' '), lang: langOf(seg) });
  }
  return out;
}
