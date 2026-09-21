/**
 * 词条 iframe 沙箱帧组装（自 src/windows/DictionaryTab.tsx 抽出 复习页复用）。
 *
 * 本文件是**薄封装**：取两个帧脚本文本（vite `?raw`）→ 组装出 `BOOT_SCRIPT`，
 * 把 `frameScript.ts` 的纯函数与引导脚本绑成应用可直接调用的形态。这样分层是为了
 * `node test/frame.mjs` 能在不认 `?raw` 的 node 里跑同一套组装与帧脚本基线。
 *
 * 帧脚本正文 `dictFrame.boot.js`：点击委托（entry:// 重查 / sound://·webaudio://
 * 播放回传 / say:// 例句朗读）+ 高度上报 + 例句朗读按钮注入（异步、按语言分段）；
 * 帧内语言分段 `saySegments.js`（与父页 `textLang.ts` 同判据，单测对拍）。
 * 复习页只监听高度消息、不监听 entry:// → 词条内链不跟随（pickdict ReviewPage 语义）。
 */
import bootSrc from "./dictFrame.boot.js?raw";
import saySegmentsSrc from "./saySegments.js?raw";
import {
  assembleFrameScript,
  buildSrcdoc as build,
  type SayButtonSpec,
  type SrcdocOptions,
} from "./frameScript";

export const BOOT_SCRIPT = assembleFrameScript(bootSrc, saySegmentsSrc);

export type { SayButtonSpec, SrcdocOptions };
export { isIpaOnlyText } from "./frameScript";

export function buildSrcdoc(
  entryHtml: string,
  lookupToken?: number,
  opts?: SrcdocOptions,
): string {
  return build(entryHtml, lookupToken, opts, BOOT_SCRIPT);
}
