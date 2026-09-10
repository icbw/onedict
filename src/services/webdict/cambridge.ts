/** 剑桥词典 engine（英汉简体站）。分区拼装对齐 youdao engine 形态。
 *
 *  站别：/dictionary/english-chinese-simplified/<word>（实测 200 直连，
 *  无 Cloudflare 拦截；调研报告 §8 的 403 头号风险在当前环境未复现——FORBIDDEN
 *  兜底入口仍在）。未收录词 302 → spellcheck 页（无 .di-title）→ NO_RESULT；
 * 拼写建议采集待后续实现。
 *
 *  发音：.dpron-i 内 audio > source[type="audio/mpeg"][src]（站内 /media/english/...）
 *  → 完整 URL 进 webaudio:// 锚点，委托父页 webdict_audio 下载回播（host 已在
 *  Rust AUDIO_HOSTS 白名单内）。
 *
 *  词内链：a.query（定义/例句内站内词链，/dictionary/<站别>/<word> 完整 URL）
 *  → wordLink 钩子提取词，消毒出口改写 entry:// → 词典内跳转；.trans 内的
 *  a.Ref（中英反查固定链接，非词链）textContent 即翻译文本，消毒后原样保留。
 */
import { fetchWebDictDom } from "./fetchDom";
import { WebdictError } from "./errors";
import { sanitizeInner } from "./sanitize";
import { speaker } from "./youdao";
import type { WebDictResult } from "./index";

const HOST = "https://dictionary.cambridge.org";

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

/** 剑桥站内词查询链接 → 词文本（定义/例句内的 a.query：/dictionary/english[
 *  -chinese-simplified]/<word>，完整 URL）。反查链接（/dictionary/chinese-simplified-
 *  english/）、帮助页等非词链接返回 null 维持外链委托。 */
export function cambridgeWordFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.host !== "dictionary.cambridge.org") return null;
  const m = /^\/dictionary\/english(?:-chinese-simplified)?\/([^/]+)\/?$/.exec(u.pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** 消毒出口统一传词链接改写钩子（cambridgeSearch 各分区共用） */
const WORD_LINK_OPTS = { wordLink: cambridgeWordFromUrl };

export async function cambridgeSearch(word: string): Promise<WebDictResult> {
  const { doc } = await fetchWebDictDom("web-cambridge", word);

  // 每个词性组一个 .pr.entry-body__el（英汉版多义词会出多块； miss 页无此结构）
  const entries = Array.from(doc.querySelectorAll(".pr.entry-body__el"));
  if (entries.length === 0) throw new WebdictError("NO_RESULT");

  const parts: string[] = [];
  let hit = false;

  for (const entry of entries) {
    const title = getText(entry, ".di-title .hw").trim();
    if (!title) continue;
    hit = true;

    const pos = getText(entry, ".posgram .pos").trim();
    const gram = getText(entry, ".posgram .gram").trim();

    // 发音（uk/us：region + ipa + mp3）
    const prons: Array<{ region: string; ipa: string; url: string | null }> = [];
    entry.querySelectorAll(".dpron-i").forEach(($p) => {
      const region = getText($p, ".dreg").trim();
      const ipa = getText($p, ".ipa").trim();
      const src = $p
        .querySelector<HTMLSourceElement>('.daud audio source[type="audio/mpeg"]')
        ?.getAttribute("src");
      prons.push({
        region,
        ipa,
        url: src ? new URL(src, HOST).toString() : null,
      });
    });

    // 词头区
    parts.push(
      `<div class="dictCambridge-Header"><h1 class="dictCambridge-Title">${escapeHtml(title)}</h1>` +
        (pos ? `<span class="dictCambridge-Pos">${escapeHtml(pos)}${gram ? ` ${escapeHtml(gram)}` : ""}</span>` : "") +
        `</div>`,
    );
    if (prons.length > 0) {
      parts.push(
        `<div class="dictCambridge-Header">` +
          prons
            .map(({ region, ipa, url }) => {
              const label = [
                region ? `<span class="dictCambridge-Region">${escapeHtml(region)}</span>` : "",
                ipa ? `/${escapeHtml(ipa)}/` : "",
              ].join(" ");
              return `<span class="dictCambridge-Pron">${label}${url ? speaker(url) : ""}</span>`;
            })
            .join("") +
          `</div>`,
      );
    }

    // 释义块（.def-block：等级 + 英文定义 + 中文翻译 + 例句[+例句翻译]）
    const senses: string[] = [];
    entry.querySelectorAll(".def-block").forEach(($block) => {
      const level = getText($block, ".ddef_h .dxref").trim();
      const defHtml = sanitizeInner(HOST, $block, ".ddef_h .ddef_d", WORD_LINK_OPTS);
      const trans = Array.from($block.querySelectorAll(".def-body > .trans.dtrans"))
        .map(($t) => ($t.textContent || "").trim())
        .filter(Boolean);
      const examples: string[] = [];
      $block.querySelectorAll(".def-body .examp.dexamp").forEach(($ex) => {
        const eg = sanitizeInner(HOST, $ex, ".eg.deg", WORD_LINK_OPTS);
        const t = ($ex.querySelector(".trans.dtrans")?.textContent || "").trim();
        if (eg || t) {
          examples.push(
            `<div class="dictCambridge-Example">${eg}${t ? `<span class="dictCambridge-Trans">${escapeHtml(t)}</span>` : ""}</div>`,
          );
        }
      });

      senses.push(
        `<div class="dictCambridge-Sense">` +
          `<div class="dictCambridge-Def">` +
          (level ? `<span class="dictCambridge-Level">${escapeHtml(level)}</span>` : "") +
          defHtml +
          `</div>` +
          (trans.length > 0
            ? `<div class="dictCambridge-Trans">${trans.map(escapeHtml).join("；")}</div>`
            : "") +
          examples.join("") +
          `</div>`,
      );
    });
    if (senses.length > 0) {
      parts.push(
        `<div class="webdict-box"><div class="webdict-box-title">剑桥英汉双解</div>${senses.join("")}</div>`,
      );
    }
  }

  if (!hit) throw new WebdictError("NO_RESULT");
  return { html: parts.join("") };
}
