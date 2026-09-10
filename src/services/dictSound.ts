/**
 * 词条发音资源获取（自 DictionaryTab.playSound 抽出，主窗口与动作面板共用）。
 * invoke dictionary_sound 取原始字节 → .spx 走 speex wasm 解码为 WAV（pickdict
 * finishResource 语义：解码失败抛错由调用方提示，查词不受阻）。
 * 播放由调用方决定（回传 iframe postMessage 或直接 Audio）。
 */
import { invoke } from "@tauri-apps/api/core";
import { base64ToBytes, bytesToBase64, decodeSpxToWav } from "./spxDecoder";

/** MDD 无此资源 */
export class SoundMissingError extends Error {}

export async function fetchSoundData(
  dictId: string,
  key: string,
): Promise<{ mime: string; base64: string }> {
  const r = await invoke<{ base64: string | null; mime: string }>("dictionary_sound", {
    dictId,
    key,
  });
  if (!r.base64) {
    throw new SoundMissingError(`发音资源 ${key} 在该词典 MDD 中不存在`);
  }
  let { mime, base64 } = r;
  if (mime === "audio/speex") {
    // Chromium 不支持 Speex：wasm 解码为 WAV；失败抛错提示（pickdict 语义）
    try {
      const { wav } = decodeSpxToWav(base64ToBytes(base64));
      base64 = bytesToBase64(wav);
      mime = "audio/wav";
    } catch (e) {
      throw new Error(`.spx 解码失败（${String(e)}），该条不可播`);
    }
  }
  return { mime, base64 };
}
