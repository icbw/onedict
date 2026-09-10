/**  词典 IPC 类型（对应 src-tauri/src/dictionary/mod.rs 命令返回） */

export interface DictMeta {
  id: string;
  dir: string;
  /** 启用状态（词典管理：禁用词典不参与查询/联想/预热） */
  enabled: boolean;
}

export interface LookupResult {
  word: string;
  html: string | null;
  redirected_to: string | null;
}
