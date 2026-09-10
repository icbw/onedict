/**
 *  AI 流式调用——自研 OpenAI 兼容薄层。
 * // from pickdict (MIT), adapted for Tauri —— aiStream.ts 平移：协议行为基线保留
 * （chat/completions 流式、增量拼接、AbortError 取消语义），传输层由前端直接 fetch
 * 换为 Rust `ai_stream` 代理（webview CORS 受限，任意 OpenAI 兼容网关需走原生请求；
 * SSE 解析与 noThink 思考参数适配在 src-tauri/src/ai/），增量经 tauri Channel 回传。
 * 配置（endpoint/apiKey/全局 noThink）由 Rust 每次请求从偏好读取，前端只传消息与
 * 动作级 model 覆盖，保证设置页与各窗口实时同步。
 */
import { Channel, invoke } from "@tauri-apps/api/core";

export interface AiStreamMessage {
  role: "system" | "user" | "assistant";
  /** 提示文本部分（多模态时 images 非空，本字段为文本 part） */
  content: string;
  /** 多模态图片（data URL 含 base64）；Rust 按协议转换为 parts/blocks 透传 */
  images?: string[];
}

export interface AiStreamConfig {
  /** 动作级模型覆盖（留空用全局配置） */
  model?: string;
  /** 非思考模式覆盖（true 强制关闭；缺省用激活 provider 卡设置） */
  noThink?: boolean;
  /** 卡路由（AI 词典跨卡选模型）：指定 provider 卡 id，
   *  请求用该卡的端点/Key/协议；缺省用全局激活卡 */
  provider?: string;
}

/** Rust AiStreamEvent（tag=type camelCase） */
type StreamEvent =
  | { type: "delta"; text?: string }
  | { type: "done" }
  | { type: "error"; message?: string };

export class AiAbortedError extends Error {
  constructor() {
    super("已停止");
    this.name = "AbortError";
  }
}

let nextReqId = 1;

/**
 * 流式调用 chat/completions，增量经 onDelta 逐段回调（参数为累计全文）。
 * 返回最终全文；失败抛 Error（AbortError = 调用方取消）。
 */
export async function streamChat(
  messages: AiStreamMessage[],
  config: AiStreamConfig,
  signal: AbortSignal | undefined,
  onDelta: (full: string) => void,
): Promise<string> {
  if (signal?.aborted) throw new AiAbortedError();
  const reqId = nextReqId++;
  return new Promise<string>((resolve, reject) => {
    let full = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      void invoke("ai_stream_cancel", { reqId }).catch(() => {});
      finish(() => reject(new AiAbortedError()));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const channel = new Channel<StreamEvent>((e) => {
      if (e.type === "delta" && e.text) {
        full += e.text;
        onDelta(full);
      } else if (e.type === "error") {
        finish(() => reject(new Error(e.message || "AI 请求失败")));
      } else if (e.type === "done") {
        finish(() => resolve(full));
      }
    });
    invoke("ai_stream", {
      reqId,
      messages,
      model: config.model,
      noThink: config.noThink,
      provider: config.provider,
      on: channel,
    }).catch((err) => {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    });
  });
}
