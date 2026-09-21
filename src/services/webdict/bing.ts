/** 必应词典 engine（cn.bing.com 客户端条目页，分区拼装对齐 youdao/cambridge engine 形态）。
 *
 *  站别：/dict/clientsearch?mkt=zh-CN&setLang=zh&…&q=<word>——站点给客户端用的轻量
 *  条目页（实测 200 直连）。英汉/英英/网络三个标签面板同在一份 HTML 里（后两个
 *  display:none 预置），可见面板是**文档序第一个** .client_def_container——解析
 *  必须收敛到它，否则释义块会成倍重复。未收录词落 client_no_result_* 空态页
 *  （无 .client_def_hd_hd）→ NO_RESULT。
 *
 *  发音：.client_def_hd_pn_list 内发音节点的站内相对 mp3（/dict/mediamp3?blob=…）
 *  → 完整 URL 进 webaudio:// 锚点，委托父页 webdict_audio 下载回播（host 已在
 *  Rust AUDIO_HOSTS 白名单内）。
 *
 *  词内链：释义里的 a.client_def_list_word_en[data-url] 在站点上点即检索该词，
 *  故在消毒出口改写 entry:// → 词典内跳转；词形变化项由 data-word 直接生成
 *  entry:// 锚点。例句的分词锚点（英文按词、中文按字）与网络释义的来源站链接是
 *  站点的分词/检索产物，展开为纯文本（留死链或转外链都不是用户要的）。
 */
import { fetchWebDictDom } from "./fetchDom";
import { WebdictError } from "./errors";
import { sanitizeInner } from "./sanitize";
import { accentFromLabel, speaker } from "./speaker";
import type { WebDictResult } from "./index";

const HOST = "https://cn.bing.com";

/** 例句上限（站点默认给 10 条，面板里过长；对齐 saladict 必应默认取值 4） */
const SENTENCE_LIMIT = 4;

/** 发音节点属性探测顺序（客户端页给相对路径，词头与例句分属不同属性） */
const AUDIO_ATTRS = ["data-pronunciation", "data-mp3link", "audiomd5"] as const;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function getText(parent: ParentNode | null, selector?: string): string {
  if (!parent) return "";
  const child = selector ? parent.querySelector(selector) : (parent as HTMLElement);
  return child?.textContent ?? "";
}

/** 空白折叠（词性/音标/来源文本里的 &#160; 与换行） */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 必应站内词查询链接 → 词文本：/dict/search?q=<word>（词内链改写后的形态）与
 *  /dict/clientsearch?…&q=<word>（站点原文形态）。发音 mediamp3 无 q 参数，
 *  非 /dict/ 路径（站点检索 /search?q=…）一律返回 null 维持原样。 */
export function bingWordFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)bing\.com$/i.test(u.host)) return null;
  if (!u.pathname.startsWith("/dict/")) return null;
  const q = u.searchParams.get("q");
  return q && q.trim() ? q.trim() : null;
}

/** 消毒出口统一传词链接改写钩子（bingSearch 各分区共用） */
const WORD_LINK_OPTS = { wordLink: bingWordFromUrl };

/** 取发音资源绝对 URL（先看节点自身再看后代，对齐 saladict getBingAudioURL 的探测顺序） */
function bingAudioUrl(parent: ParentNode | null): string | null {
  if (!parent) return null;
  const candidates: Element[] = parent instanceof Element ? [parent] : [];
  candidates.push(
    ...Array.from(
      parent.querySelectorAll("[data-pronunciation], [data-mp3link], [audiomd5]"),
    ),
  );
  for (const el of candidates) {
    for (const attr of AUDIO_ATTRS) {
      const v = (el.getAttribute(attr) || "").trim();
      // 站内相对路径或绝对 URL 才算发音资源（同页 new-word 节点把音标文本放在
      // data-pronunciation 上，形态过滤避免把音标当音频地址送出去）
      if (/^(https?:\/\/|\/)/i.test(v)) return new URL(v, HOST).toString();
    }
  }
  return null;
}

/** 释义区内锚点整形：词链改写为站内查询 URL（消毒出口会再转 entry://），
 *  检索/来源站链接与无词锚点展开为纯文本。 */
function shapeDefList(doc: Document, $list: Element): void {
  $list.querySelectorAll<HTMLAnchorElement>("a.client_def_list_word_en").forEach(($a) => {
    const w = ($a.dataset.url || "").trim();
    if (w) {
      $a.setAttribute("href", `${HOST}/dict/search?q=${encodeURIComponent(w)}`);
    } else {
      $a.replaceWith(doc.createTextNode($a.textContent || ""));
    }
  });
  $list.querySelectorAll("a.client_sen_link, a.client_web_count").forEach(($a) => {
    $a.replaceWith(doc.createTextNode($a.textContent || ""));
  });
}

/** 例句内锚点整形：分词锚点（英文按词/中文按字）展开为纯文本，命中词转高亮 span，
 *  来源站链接展开为纯文本。站点给的句子由大量碎锚点拼成，不整形则整句都是死链。 */
function shapeSentence(doc: Document, $item: Element): void {
  $item.querySelectorAll("a.client_sen_en_word, a.client_sen_cn_word").forEach(($a) => {
    $a.replaceWith(doc.createTextNode($a.textContent || ""));
  });
  $item.querySelectorAll(".client_sentence_search").forEach(($s) => {
    const span = doc.createElement("span");
    span.className = "dictBing-HL";
    span.textContent = $s.textContent || "";
    $s.replaceWith(span);
  });
  $item.querySelectorAll("a.client_sen_link").forEach(($a) => {
    $a.replaceWith(doc.createTextNode($a.textContent || ""));
  });
}

export async function bingSearch(word: string): Promise<WebDictResult> {
  const { doc } = await fetchWebDictDom("web-bing", word);

  // ── 词头区（标题 + 音标/发音） ──
  const title = collapse(getText(doc, ".client_def_hd_hd"));
  const prons: Array<{ label: string; url: string | null }> = [];
  doc.querySelectorAll(".client_def_hd_pn_list").forEach(($list) => {
    const label = collapse(getText($list, ".client_def_hd_pn"));
    const url = bingAudioUrl($list);
    if (label || url) prons.push({ label, url });
  });

  // ── 释义区（可见面板：英汉 + 网络；隐藏面板同名结构，取文档序第一个容器） ──
  const defs: Array<{ pos: string; html: string }> = [];
  const $container = doc.querySelector(".client_def_container");
  $container?.querySelectorAll(".client_def_bar").forEach(($bar) => {
    const $list = $bar.querySelector(".client_def_list");
    if (!$list) return;
    shapeDefList(doc, $list);
    const html = sanitizeInner(HOST, $list, undefined, WORD_LINK_OPTS);
    if (html) defs.push({ pos: collapse(getText($bar, ".client_def_title_bar")), html });
  });

  // ── 词形变化（title = 形态名，data-word = 可查词形） ──
  const infs: Array<{ form: string; word: string }> = [];
  doc.querySelectorAll(".client_word_change_word").forEach(($w) => {
    const word = ($w.getAttribute("data-word") || $w.textContent || "").trim();
    if (word) infs.push({ form: collapse($w.getAttribute("title") || ""), word });
  });

  // ── 例句（原文 + 译文 + 来源 + 发音） ──
  const sentences: Array<{ en: string; cn: string; source: string; mp3: string | null }> = [];
  for (const $item of Array.from(doc.querySelectorAll(".client_sentence_list"))) {
    if (sentences.length >= SENTENCE_LIMIT) break;
    shapeSentence(doc, $item);
    const en = sanitizeInner(HOST, $item, ".client_sen_en");
    const cn = sanitizeInner(HOST, $item, ".client_sen_cn");
    if (!en && !cn) continue;
    sentences.push({
      en,
      cn,
      source: collapse(getText($item, ".client_sentence_list_link")),
      mp3: bingAudioUrl($item),
    });
  }

  // 命中判定：空态页无标题亦无释义（英英面板不采集）
  if (!title && defs.length === 0) throw new WebdictError("NO_RESULT");

  // ── 分区拼装 ──
  const parts: string[] = [];
  if (title) {
    parts.push(`<div class="dictBing-Header"><h1 class="dictBing-Title">${escapeHtml(title)}</h1></div>`);
  }
  if (prons.length > 0) {
    parts.push(
      `<div class="dictBing-Header">` +
        prons
          .map(
            // 音标标签（英 / 美）→ 锚点口音标记：合成兜底按它选音色
            ({ label, url }) =>
              `<span class="dictBing-Pron">${escapeHtml(label)}${url ? ` ${speaker(url, accentFromLabel(label))}` : ""}</span>`,
          )
          .join("") +
        `</div>`,
    );
  }
  if (defs.length > 0) {
    parts.push(
      `<div class="webdict-box"><div class="webdict-box-title">简明释义</div>` +
        defs
          .map(
            ({ pos, html }) =>
              `<div class="dictBing-CdefItem">` +
              `<span class="dictBing-CdefPos">${escapeHtml(pos)}</span>` +
              `<span class="dictBing-CdefDef">${html}</span>` +
              `</div>`,
          )
          .join("") +
        `</div>`,
    );
  }
  if (infs.length > 0) {
    parts.push(
      `<div class="webdict-box"><div class="webdict-box-title">词形变化</div><div class="dictBing-Inf">` +
        infs
          .map(
            ({ form, word }) =>
              `<span class="dictBing-InfItem">` +
              (form ? `<span class="dictBing-InfForm">${escapeHtml(form)}</span>` : "") +
              `<a href="entry://${encodeURIComponent(word)}">${escapeHtml(word)}</a>` +
              `</span>`,
          )
          .join("") +
        `</div></div>`,
    );
  }
  if (sentences.length > 0) {
    parts.push(
      `<div class="webdict-box"><div class="webdict-box-title">例句</div><ol class="dictBing-SentenceList">` +
        sentences
          .map(
            ({ en, cn, source, mp3 }) =>
              `<li class="dictBing-SentenceItem">` +
              (en ? `<p>${en}${mp3 ? ` ${speaker(mp3)}` : ""}</p>` : "") +
              (cn ? `<p>${cn}</p>` : "") +
              (source ? `<footer class="dictBing-SentenceSource">${escapeHtml(source)}</footer>` : "") +
              `</li>`,
          )
          .join("") +
        `</ol></div>`,
    );
  }
  return { html: parts.join("") };
}
