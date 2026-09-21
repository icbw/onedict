/**
 * 词条发音资源获取（自 DictionaryTab.playSound 抽出，主窗口与动作面板共用）。
 * invoke dictionary_sound 取原始字节 → .spx 走 speex wasm 解码为 WAV（pickdict
 * finishResource 语义：解码失败抛错由调用方提示，查词不受阻）。
 * 播放由调用方决定（回传 iframe postMessage 或直接 Audio）。
 */
import { invoke } from "@tauri-apps/api/core";
import { base64ToBytes, bytesToBase64, decodeSpxToWav } from "./spxDecoder";

/** MDD 无此资源（词典确实没收录这条发音）——「按链降级」的正常情形 */
export class SoundMissingError extends Error {}

/**
 * 资源取到了但本机放不出来（.spx 解码失败 / 解码器不可用）——**故障**，不是「词典没收录」。
 * 调用方须把原因上屏；把它当 MISS 静默换音源，用户就会以为听到的是本地真人音。
 */
export class SoundDecodeError extends Error {}

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
    // Chromium 不支持 Speex：wasm 解码为 WAV（pickdict 语义）。解不开是故障而非缺资源：
    // 抛 SoundDecodeError 让调用方上屏（含解码器初始化原因，可直接排查）
    try {
      const { wav } = decodeSpxToWav(base64ToBytes(base64));
      base64 = bytesToBase64(wav);
      mime = "audio/wav";
    } catch (e) {
      throw new SoundDecodeError(`.spx 解码失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { mime, base64 };
}
