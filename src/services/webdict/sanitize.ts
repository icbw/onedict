/** 在线 HTML 消毒与取值（saladict getHTML 的移植）：**入口不消毒、出口才消毒**
 *  ——先按 host 补全相对链接（iframe 内相对路径图片/链接全是死链，补全必须发生在
 *  渲染前），再 DOMPurify 剥 script/iframe/style（词条帧 sandbox="allow-scripts"，
 *  不消毒等于执行第三方脚本）。 */
import DOMPurify from "dompurify";

const FORBID_TAGS = ["style", "script", "iframe", "object", "embed", "form"];
const FORBID_ATTR = ["style"];

/** DOMPurify 默认 URI 白名单（3.4.x）为基底追加本应用自定义协议：`entry://`（词内链
 *  词典内跳转）与 `webaudio://`（在线发音锚点）。**不放行会被整条剥掉 href**——
 *  链接退化为无 href 死链（I-beam 不可点） 实测坑。两协议的 href
 *  内容均由本项目生成（encodeURIComponent 词文本/绝对 URL），无注入面。 */
const ALLOWED_URI =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|entry|webaudio):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

/** 相对地址补全为站点绝对地址（saladict getFullLink 同款） */
export function getFullLink(host: string, el: Element, attr: string): string {
  const h = host.endsWith("/") ? host.slice(0, -1) : host;
  const protocol = h.startsWith("https") ? "https:" : "http:";
  const link = el.getAttribute(attr);
  if (!link) return "";
  if (link.startsWith("#")) return link; // 页内锚点原样（补全会把 "#" 变外链 → 点开浏览器）
  if (/^[a-zA-Z0-9]+:/.test(link)) return link; // 已带协议
  if (link.startsWith("//")) return protocol + link;
  if (/^.?\/+/.test(link)) return h + "/" + link.replace(/^.?\/+/, "");
  return h + "/" + link;
}

/** 词链接改写钩子（词典内部跳转）：命中返回词文本 → href 改写为 entry:// 内链，
 *  点击走帧内 onedict-entry 管道重查（与本地词典内链同路径）；返回 null 保持
 *  原链接（真外链维持帧内 onedict-external 委托 → 内置网页窗口）。 */
export interface SanitizeOptions {
  wordLink?: (url: string) => string | null;
}

/** 取 node（或 selector 命中的子节点）的**消毒后 innerHTML**。
 *  FORBID style 标签/属性：词典版式由注入的 CSS 提供（saladict 同款决策）。 */
export function sanitizeInner(
  host: string,
  parent: ParentNode,
  selector?: string,
  opts?: SanitizeOptions,
): string {
  const node = selector
    ? parent.querySelector<HTMLElement>(selector)
    : (parent as HTMLElement | null);
  if (!node) return "";

  if (host) {
    const fill = (el: Element) => {
      if (el.getAttribute("href")) {
        const full = getFullLink(host, el, "href");
        const w = opts?.wordLink ? opts.wordLink(full) : null;
        el.setAttribute("href", w ? "entry://" + encodeURIComponent(w) : full);
      }
      if (el.getAttribute("src")) el.setAttribute("src", getFullLink(host, el, "src"));
    };
    if (node.tagName === "A" || node.tagName === "IMG") fill(node);
    node.querySelectorAll("a").forEach(fill);
    node.querySelectorAll("img").forEach(fill);
  }

  const frag = DOMPurify.sanitize(node, {
    FORBID_TAGS,
    FORBID_ATTR,
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_URI_REGEXP: ALLOWED_URI,
  }) as unknown as DocumentFragment;
  const first = frag.firstChild as HTMLElement | null;
  return first ? first.innerHTML : "";
}
