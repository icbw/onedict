/** 有道词典 engine（移植自 saladict components/dictionaries/youdao，MIT）。
 *  「结构型」移植：分区 HTML 由本项目拼装（saladict 是 React View，我们进 iframe），
 *  选择器与命中判定照搬 engine.ts；相关词分支不移植（2026-09 实测已漂移，
 *  见调研报告 §3.3——未命中直接 NO_RESULT）。机器翻译分区默认关（saladict 默认值）。
 *
 *  发音：`.dictvoice[data-rel]` 拼 dictvoice URL → `webaudio://<encoded>` 锚点，
 *  由帧内 BOOT_SCRIPT 委托父页面 `webdict_audio` 下载回播（对齐 saladict 把音频
 *  节点替换成统一占位锚点的手法）。
 *  词内链：站内词查询链接（关联词/词组短语/词义辨析等）在消毒出口改写为
 *  entry:// → 帧内 onedict-entry 管道词典内跳转；非词链接维持 onedict-external
 *  委托 → 内置网页窗口（不跳系统浏览器）。 */
import { fetchWebDictDom } from "./fetchDom";
import { WebdictError } from "./errors";
import { sanitizeInner } from "./sanitize";
import type { WebDictResult } from "./index";

const HOST = "https://dict.youdao.com";

/** Material volume_up 通用喇叭形状（发音锚点视觉） */
const SPEAKER_PATH =
  "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z";

/** 星级路径（saladict youdao/engine.ts 同款自绘 5 星） */
const STAR_PATH =
  "M213.33 10.44l65.92 133.58 147.42 21.42L320 269.4l25.17 146.83-131.84-69.32-131.85 69.34 25.2-146.82L0 165.45l147.4-21.42";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/** 发音喇叭锚点（youdao/cambridge 共用；webaudio:// 由帧内 BOOT_SCRIPT 委托下载） */
export function speaker(url: string): string {
  return `<a class="webdict-Speaker" href="webaudio://${encodeURIComponent(url)}" aria-label="播放发音"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="${SPEAKER_PATH}"/></svg></a>`;
}

function starSvgs(rate: number, cls = "dictYoudao-Stars"): string {
  let out = "";
  for (let i = 0; i < 5; i++) {
    out += `<svg viewBox="0 0 426.67 426.67" width="1em" height="1em"${i !== 4 ? ' style="margin-right:1px"' : ""}><path fill="${i < rate ? "#FAC917" : "#d1d8de"}" d="${STAR_PATH}"/></svg>`;
  }
  return `<span class="${cls}">${out}</span>`;
}

function getText(parent: ParentNode | null, selector?: string): string {
  if (!parent) return "";
  const child = selector ? parent.querySelector(selector) : (parent as HTMLElement);
  return child?.textContent ?? "";
}

/** 有道站内词查询链接 → 词文本（关联词/词组短语/词义辨析等词内链在消毒出口改写
 *  为 entry://，点击走词典内部跳转重查而非开浏览器）。覆盖 /w/<word>（percent
 *  编码、#keyfrom 尾巴、尾斜杠均兼容）与 /result?word=、/lookup?q=；发音
 *  dictvoice、Collins 版权页等非词链接返回 null 维持外链委托。后续源（剑桥）
 *  各自实现同形钩子。 */
export function youdaoWordFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.host !== "dict.youdao.com") return null;
  const q = u.searchParams.get("word") ?? u.searchParams.get("q");
  if (q && q.trim()) return q.trim();
  if (u.pathname.startsWith("/w/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(u.pathname.slice(3));
    } catch {
      seg = u.pathname.slice(3);
    }
    seg = seg.replace(/\/+$/, "");
    if (seg && !seg.includes("/")) return seg;
  }
  return null;
}

/** 消毒出口统一传词链接改写钩子（youdaoSearch 各分区共用） */
const WORD_LINK_OPTS = { wordLink: youdaoWordFromUrl };

export async function youdaoSearch(word: string): Promise<WebDictResult> {
  const { doc } = await fetchWebDictDom("web-youdao", word);

  // ── 词头区（engine.ts handleDOM 同款字段） ──
  const title = getText(doc, ".keyword").trim();
  const pattern = getText(doc, ".pattern").trim();
  const rank = getText(doc, ".rank").trim();
  let stars = 0;
  const $star = doc.querySelector(".star");
  if ($star) {
    stars = Number(($star.className.match(/\d+/) || ["0"])[0]);
  }

  const prons: Array<{ phsym: string; url: string }> = [];
  doc.querySelectorAll(".baav .pronounce").forEach(($pron) => {
    const phsym = ($pron.textContent || "").trim();
    const rel = $pron.querySelector<HTMLAnchorElement>(".dictvoice")?.dataset.rel;
    if (rel) prons.push({ phsym, url: `https://dict.youdao.com/dictvoice?audio=${rel}` });
  });

  // ── 分区采集（消毒在 sanitizeInner 出口做；词查询链接出口改写 entry:// 内链） ──
  const basic = sanitizeInner(HOST, doc, "#phrsListTab .trans-container", WORD_LINK_OPTS);

  const collins: Array<{ title: string; content: string }> = [];
  doc.querySelectorAll("#collinsResult .wt-container").forEach(($container) => {
    let itemTitle = "";
    const $title = $container.querySelector(":scope > .title.trans-tip");
    if ($title) {
      $title.querySelector(".do-detail")?.remove();
      itemTitle = ($title.textContent || "").trim();
      $title.remove();
    }
    // 星级 class 数字 → 5 颗自绘 SVG（在消毒前替换节点，DOMPurify 放行 svg/path）
    const $cStar = $container.querySelector(".star");
    const m = $cStar ? /star(\d+)/.exec(String($cStar.className)) : null;
    if ($cStar && m) {
      const span = doc.createElement("span");
      span.className = "dictYoudao-Stars";
      span.innerHTML = starSvgs(Number(m[1]), "");
      $cStar.replaceWith(span);
    }
    // 例句发音：.dictvoice[data-rel] → webaudio:// 锚点（同词头手法，消毒后残留
    // 的 dictvoice 绝对链接会走外链委托开浏览器）
    $container.querySelectorAll<HTMLElement>(".dictvoice").forEach(($v) => {
      const rel = $v.dataset.rel;
      if (!rel) return;
      const span = doc.createElement("span");
      span.innerHTML = speaker(`https://dict.youdao.com/dictvoice?audio=${rel}`);
      const first = span.firstChild;
      if (first) $v.replaceWith(first);
    });
    const content = sanitizeInner(HOST, $container, undefined, WORD_LINK_OPTS);
    if (content) collins.push({ title: itemTitle, content });
  });

  const discrimination = sanitizeInner(HOST, doc, "#discriminate", WORD_LINK_OPTS);
  const sentence = sanitizeInner(HOST, doc, "#authority .ol", WORD_LINK_OPTS);

  // 命中判定（saladict: result.title || result.translation；机器翻译分区未采集）
  if (!title) throw new WebdictError("NO_RESULT");

  // ── 分区拼装（View.tsx 结构 → HTML） ──
  const parts: string[] = [];
  parts.push(
    `<div class="dictYoudao-HeaderContainer"><h1 class="dictYoudao-Title">${escapeHtml(title)}</h1>` +
      (pattern ? `<span class="dictYoudao-Pattern">${escapeHtml(pattern)}</span>` : "") +
      `</div>`,
  );
  if (stars > 0 || prons.length > 0) {
    parts.push(
      `<div class="dictYoudao-HeaderContainer">` +
        (stars > 0 ? starSvgs(stars) : "") +
        prons
          .map(
            ({ phsym, url }) =>
              `<span class="dictYoudao-Pron">${escapeHtml(phsym)} ${speaker(url)}</span>`,
          )
          .join("") +
        (rank ? `<span class="dictYoudao-Rank">${escapeHtml(rank)}</span>` : "") +
        `</div>`,
    );
  }
  if (basic) parts.push(`<div class="dictYoudao-Basic">${basic}</div>`);
  if (collins.length > 0) {
    const items = collins
      .map((c, i) => {
        const order = collins.length > 1 ? `<span class="collinsOrder">${i + 1}.</span>` : "";
        const t = c.title ? `<h4>${order}<span class="title">${escapeHtml(c.title)}</span></h4>` : "";
        return `<div class="dictYoudao-Collins">${t}${c.content}</div>`;
      })
      .join("");
    parts.push(
      `<div class="webdict-box"><div class="webdict-box-title">柯林斯英汉双解</div>${items}</div>`,
    );
  }
  if (discrimination) {
    parts.push(
      `<div class="webdict-box dictYoudao-Discrimination"><div class="webdict-box-title">词义辨析</div>${discrimination}</div>`,
    );
  }
  if (sentence) {
    parts.push(
      `<div class="webdict-box"><div class="webdict-box-title">权威例句</div><ol class="dictYoudao-Sentence">${sentence}</ol></div>`,
    );
  }
  return { html: parts.join("") };
}
