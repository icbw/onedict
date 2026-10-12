/**
 * 检查会话辅助：文本指纹与忽略键（纯前端计算——全文不进 check-session.json，
 * 只落哈希与 findings，隐私与体积双收）。
 *
 * 指纹 = 正序 + 逆序两个 FNV-1a 32 位拼接：不用 BigInt（tsconfig 目标兼容面
 * 更稳）的同时把碰撞面降一档；同一文本恒同值即满足去重键需求——Rust 侧只做
 * 字符串比较，跨语言哈希一致性无关紧要。
 */
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function fnv1a32(s: string, from: number, step: number): number {
  let h = FNV_OFFSET;
  for (let i = from; i >= 0 && i < s.length; i += step) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/** trim 后全文指纹（16 位 hex）——同文重查的会话去重键 */
export function textHash(text: string): string {
  const t = text.trim();
  const fwd = fnv1a32(t, 0, 1);
  const bwd = fnv1a32(t, t.length - 1, -1);
  return fwd.toString(16).padStart(8, "0") + bwd.toString(16).padStart(8, "0");
}

/** 忽略键：ruleId + US 分隔符 + quote（同规则命中不同文本仍会提示） */
export function ignoreKey(ruleId: string, quote: string): string {
  return `${ruleId}\u001f${quote}`;
}
