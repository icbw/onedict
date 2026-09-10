/** 在线词典错误类型化（对齐 saladict helpers：NO_RESULT / NETWORK_ERROR /
 *  MANUAL_VERIFICATION 三类；本项目把人工验证收敛为 FORBIDDEN——错误态给
 *  「在浏览器中打开」入口，语义同 saladict MANUAL_VERIFICATION） */

export type WebdictErrorType = "NO_RESULT" | "NETWORK_ERROR" | "FORBIDDEN";

export class WebdictError extends Error {
  constructor(
    public readonly type: WebdictErrorType,
    detail?: string,
  ) {
    super(detail ? `${type}: ${detail}` : type);
    this.name = "WebdictError";
  }
}

/** Rust 侧错误字符串（webdict/mod.rs 约定：TIMEOUT / FORBIDDEN / HTTP xxx /
 *  NETWORK: xxx）→ 类型化错误；未知形态一律 NETWORK_ERROR */
export function toWebdictError(e: unknown): WebdictError {
  if (e instanceof WebdictError) return e;
  const msg = String(e instanceof Error ? e.message : e);
  if (msg.includes("FORBIDDEN")) return new WebdictError("FORBIDDEN");
  return new WebdictError("NETWORK_ERROR", msg);
}
