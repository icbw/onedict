/** 查词历史条目（src-tauri/src/history/mod.rs HistoryEntry，camelCase 对齐） */
export interface HistoryEntry {
  word: string;
  normKey: string;
  count: number;
  lastAt: number;
}

/** 翻译历史条目（src-tauri/src/history/translate.rs TranslateHistoryEntry，camelCase 对齐）。
 *  不去重：每次成功完成的翻译记一条（cherry 同语义），id 自增供回填定位 */
export interface TranslateHistoryEntry {
  id: number;
  sourceText: string;
  targetText: string;
  /** 源语言代码；null = 自动检测 */
  sourceLang: string | null;
  /** 目标语言代码（如 zh-cn） */
  targetLang: string;
  createdAt: number;
}
