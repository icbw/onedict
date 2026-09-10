/** 在线词典抓取（前端入口）：invoke webdict_lookup（Rust 按注册表构造 URL 并
 *  传输，绕 webview CORS）→ DOMParser 解析为 Document。语义理解留在前端
 *  （saladict fetchDirtyDOM 的对应物）。 */
import { invoke } from "@tauri-apps/api/core";
import { WebdictError, toWebdictError } from "./errors";

export interface WebdictLookupPayload {
  html: string;
  fromCache: boolean;
  srcPage: string;
}

export interface WebdictDom {
  doc: Document;
  fromCache: boolean;
  /** 来源页 URL（错误态「在浏览器中打开」入口） */
  srcPage: string;
}

/** 词头归一（saladict 同款：空白折叠单空格）+ 抓取 + 解析 */
export async function fetchWebDictDom(dictId: string, word: string): Promise<WebdictDom> {
  const w = word.replace(/\s+/g, " ").trim();
  if (!w) throw new WebdictError("NO_RESULT");
  try {
    const r = await invoke<WebdictLookupPayload>("webdict_lookup", { dictId, word: w });
    return {
      doc: new DOMParser().parseFromString(r.html, "text/html"),
      fromCache: r.fromCache,
      srcPage: r.srcPage,
    };
  } catch (e) {
    throw toWebdictError(e);
  }
}
