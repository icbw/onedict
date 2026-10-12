/**
 * 语言检查 IPC 形状（与 src-tauri/src/check.rs 的 serde camelCase 序列化同构）。
 */
import type { Finding } from "../lib/langcheck/finding";

export type TermLevel = "info" | "warning" | "error";

/** 术语表条目（Vale substitution 四元组：wrong 匹配词 / right 首选词 /
 *  note 说明 / level 级别；enabled 软停用） */
export interface TermEntry {
  id: number;
  wrong: string;
  right: string;
  note: string | null;
  level: TermLevel;
  enabled: boolean;
}

/** 忽略记录：ruleId + quote 双字段键控，跨重启与跨文档不复发 */
export interface IgnoredEntry {
  ruleId: string;
  quote: string;
  at: number;
}

export interface CheckTermsPayload {
  terms: TermEntry[];
  whitelist: string[];
  ignored: IgnoredEntry[];
}

export interface CheckSummary {
  total: number;
  fixable: number;
}

/** 会话保存入参（id 由 Rust 侧分配/复用；全文不入库，只落哈希与 findings） */
export interface CheckSessionInput {
  createdAt: number;
  textHash: string;
  charCount: number;
  preview: string;
  summary: CheckSummary;
  findings: Finding[];
}

export interface CheckSessionEntry extends CheckSessionInput {
  id: number;
}
