/**
 * 词条帧脚本组装（纯函数，零依赖）：引导脚本文本 + srcdoc 拼装 + 音标窗口判定。
 *
 * 与 `dictFrame.ts` 分开是为了**可基线化**：`node test/frame.mjs` 直接跑本模块
 * （node 不认 vite 的 `?raw`，故取源文本的活留给 `dictFrame.ts` 那层薄封装）。
 * 帧脚本正文见 `dictFrame.boot.js`、帧内语言分段见 `saySegments.js`。
 */

/** 注入 srcdoc 的引导脚本：`saySegments.js`（去 ESM 关键字，作经典脚本顶层函数）+
 *  `dictFrame.boot.js`（IIFE 正文），同一个 `<script>` 里先后执行。
 *
 *  为什么取真实 .js 文本而不是写 TS 模板字符串（含 `String.raw`）：打包器会改写
 *  模板内容——实测产物里 `\s+` 变 `s+`（转义被吃）、内联函数源码被折成 `,`，
 *  帧脚本不报错但静默失效（查词照常，例句按钮 / 帧内取词 / 拖选词组全失灵）。 */
export function assembleFrameScript(bootSrc: string, saySegmentsSrc: string): string {
  const seg = saySegmentsSrc.replace(/^export /gm, "");
  return `<script>\n${seg}\n${bootSrc}</script>`;
}

/** 例句朗读按钮外观：颜色 = 性别（f 红 / m 蓝）；accent 只并入英文文本的悬停提示 */
export interface SayButtonSpec {
  accent: "us" | "gb";
  gender: "f" | "m";
}

/** srcdoc 组装参数（扩展位 webdict）：
 *  css = 帧内样式（在线词典 opaque origin 不继承父页，必须自带；vite ?raw 注入）
 *  allowExternal = 帧内 http(s) 链接委托父页面内置网页窗口（open_webview）；
 *                   本地词条帧保持 http 链接 preventDefault 的死链语义不变
 *  sayButtons = 例句朗读双按钮的外观（缺省帧内用「女声 / 男声」占位）
 *  say = 是否注入例句朗读按钮（缺省注入）；宿主不接 `onedict-speak` 时须显式关掉，
 *        否则帧里全是点了没反应的喇叭（复习卡帧即此情形） */
export interface SrcdocOptions {
  css?: string;
  allowExternal?: boolean;
  sayButtons?: SayButtonSpec[];
  say?: boolean;
}

/** 发音锚点文本是否只是「音标窗口」（`UK /teɪk/`、`美 [teɪk]` 之类）——
 *  是则按单词口径朗读；与帧内 isIpaOnly 同规则（父页场景判定复用）。 */
export function isIpaOnlyText(text: string): boolean {
  const rest = text
    .replace(/\/[^/\n]{0,80}\//g, " ")
    .replace(/\[[^\]\n]{0,80}\]/g, " ")
    .replace(/\b(uk|us|gb|br|ame|bre)\b/gi, " ")
    .replace(/[英美·]/g, " ");
  return !/[\u3400-\u9fff\u3040-\u30ffa-z]/i.test(rest);
}

export function buildSrcdoc(
  entryHtml: string,
  lookupToken: number | undefined,
  opts: SrcdocOptions | undefined,
  bootScript: string,
): string {
  const token = typeof lookupToken === "number" ? lookupToken : "null";
  const buttons = opts?.sayButtons ? JSON.stringify(opts.sayButtons) : "null";
  const flags =
    `<script>var ONEDICT_LOOKUP_TOKEN=${token};` +
    `var ONEDICT_ALLOW_EXTERNAL=${opts?.allowExternal ? "true" : "false"};` +
    `var ONEDICT_SAY_BUTTONS=${buttons};` +
    `var ONEDICT_SAY_ENABLED=${opts?.say === false ? "false" : "true"};<\/script>`;
  const css = opts?.css ? `<style>${opts.css}</style>` : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_self">${flags}${css}${bootScript}</head><body>${entryHtml}</body></html>`;
}
