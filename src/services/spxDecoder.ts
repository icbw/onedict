/**
 * .spx（Ogg-Speex）解码 —— from pickdict (MIT), adapted for Tauri。
 *
 * vendor：自编译 libspeex 1.2.1（Xiph BSD）→ 单文件 wasm（emscripten，MIT；
 * `SINGLE_FILE=1` 内嵌 base64 + `MODULARIZE=1` + `ENVIRONMENT=web`，仅导出解码
 * 所需 API）。来源与许可见 ../vendor/speex/README.md（BSD 声明按要求保留）。
 *
 * 相对 pickdict 原版（node:vm 主进程沙箱）的适配：
 *   1) vendor 代码与求值器**注入化**——webview 侧 `?raw` import + `new Function`
 *      求值（同源可信代码，无需沙箱）；node 回归脚本 readFileSync + node:vm
 *      （test/spx.mjs 直接覆盖本文件，无内联副本漂移）；
 *   2) Buffer → Uint8Array/DataView（无 node Buffer）；
 *   3) logger → 注入式 logError（默认 console.error，仅错误路径）。
 *
 * 解码管线（自写胶水，参考 Ogg 规范与 libspeex API）：
 *   Ogg 页解析（定长 27B 页头 + lacing 表，含跨页续包）→ 包序列
 *   → SpeexHeader（80B 定长小端，DataView 直读）
 *   → 逐包 `speex_bits_read_from` + 循环 `speex_decode_int`（天然支持
 *   frames_per_packet>1）→ Int16 PCM → WAV（mono 16bit，采样率取自头）。
 * 每 .spx 文件新建/销毁 decoder（跨文件复用状态会串音）。
 */

// speex.h 常量（.cache 构建时以头文件为准核对过）
const SPEEX_SET_ENH = 0
const SPEEX_GET_FRAME_SIZE = 3
const SPEEX_SET_SAMPLING_RATE = 24

interface SpeexModule {
  _malloc(size: number): number
  _free(ptr: number): void
  _speex_bits_init(bits: number): void
  _speex_bits_destroy(bits: number): void
  _speex_bits_read_from(bits: number, bytes: number, len: number): void
  _speex_decoder_init(mode: number): number
  _speex_decoder_destroy(state: number): void
  _speex_decoder_ctl(state: number, request: number, ptr: number): number
  _speex_decode_int(state: number, bits: number, out: number): number
  _speex_lib_get_mode(mode: number): number
  HEAPU8: Uint8Array
  HEAP16: Int16Array
  getValue(ptr: number, type: 'i32' | 'i16' | 'i8'): number
  setValue(ptr: number, value: number, type: 'i32' | 'i16' | 'i8'): void
}

interface SpeexHeader {
  rate: number
  mode: number
  nb_channels: number
  vbr: number
  frames_per_packet: number
}

export interface SpxDecoderOptions {
  /** vendor speex.min.js 的完整代码文本（webview: ?raw import；node: readFileSync） */
  code: string
  /** 在当前环境求值 vendor 脚本并返回 SpeexFactory（见 initSpxDecoder 说明） */
  evaluate(code: string): unknown
  logError?: (message: string) => void
}

let mod: SpeexModule | null = null
let logError: (message: string) => void = (m) => console.error(`[spx] ${m}`)

/**
 * 激活期调用一次（幂等）；失败则 .spx 解码禁用，走原字节回退。
 * evaluate 的实现约定：求值 options.code 后返回 SpeexFactory 工厂
 * （webview：`new Function(code + ';return SpeexFactory;')`；
 * node：vm.runInContext 后取 sandbox.SpeexFactory）。
 */
export async function initSpxDecoder(options: SpxDecoderOptions): Promise<void> {
  if (mod) return
  logError = options.logError ?? logError
  const factory = options.evaluate(options.code) as (() => Promise<SpeexModule>) | undefined
  if (typeof factory !== 'function') throw new Error('vendor speex.js 未导出 SpeexFactory')
  mod = await factory()
}

export function isSpxDecoderReady(): boolean {
  return mod !== null
}

const OGGS = 0x5367674f // "OggS" 小端读取（'O' 为 LSB）

function findOggS(bytes: Uint8Array, from: number): number {
  let i = Math.max(0, from)
  while (i + 4 <= bytes.length) {
    if (
      bytes[i] === 0x4f && bytes[i + 1] === 0x67 && bytes[i + 2] === 0x67 && bytes[i + 3] === 0x53
    ) {
      return i
    }
    i++
  }
  return -1
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/**
 * Ogg 页解析 → 包序列。定长页头 27B（含 lacing 表长度字节），每段 <255 即包完
 * 结、=255 表示续到下一段/下一页（acc 携带）。MDict .spx 页结构规整，容错
 * 滑动仅防御非 Ogg 开头的脏数据。
 */
function parseOggPackets(bytes: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = []
  let acc: Uint8Array | null = null
  let pos = 0
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (;;) {
    if (pos + 27 > bytes.length) break
    if (dv.getUint32(pos, true) !== OGGS) {
      const next = findOggS(bytes, pos + 1)
      if (next < 0) break
      pos = next
      continue
    }
    const nSegs = bytes[pos + 26]
    let payload = pos + 27 + nSegs
    for (let s = 0; s < nSegs; s++) {
      const segLen = bytes[pos + 27 + s]
      const chunk = bytes.subarray(payload, payload + segLen)
      payload += segLen
      if (acc) {
        const merged = concat(acc, chunk)
        acc = null
        if (segLen < 255) packets.push(merged)
        else acc = merged
      } else if (segLen === 255) {
        acc = new Uint8Array(chunk)
      } else {
        packets.push(new Uint8Array(chunk))
      }
    }
    pos = payload
  }
  if (acc) packets.push(acc) // 截断容错
  return packets
}

/** SpeexHeader（80B 定长小端）：8B id + 20B version + 13×i32 */
function parseSpeexHeader(packet: Uint8Array): SpeexHeader {
  const dv = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  const id = String.fromCharCode(...packet.subarray(0, 8)).trim()
  if (id !== 'Speex') throw new Error(`not a speex id header: "${id}"`)
  const header: SpeexHeader = {
    rate: dv.getInt32(36, true),
    mode: dv.getInt32(40, true),
    nb_channels: dv.getInt32(48, true),
    vbr: dv.getInt32(60, true),
    frames_per_packet: dv.getInt32(64, true),
  }
  if (header.mode < 0 || header.mode > 2) throw new Error(`unsupported mode ${header.mode}`)
  return header
}

/** 16bit mono WAV（44B 头 + PCM） */
function toWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const n = pcm.length
  const out = new Uint8Array(44 + n * 2)
  const dv = new DataView(out.buffer)
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i)
  }
  writeStr(0, 'RIFF')
  dv.setUint32(4, 36 + n * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true) // PCM
  dv.setUint16(22, 1, true) // mono
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  writeStr(36, 'data')
  dv.setUint32(40, n * 2, true)
  for (let i = 0; i < n; ++i) dv.setInt16(44 + i * 2, pcm[i], true)
  return out
}

/**
 * 解码一段 Ogg-Speex 字节为 WAV（mono 16bit，采样率取自 Speex 头）。
 * 须先 `initSpxDecoder()` 成功（未就绪抛错，调用方走原字节回退）。
 * 解不开（非 Speex/unsupported 形态/数据损坏）时抛错。
 */
export function decodeSpxToWav(bytes: Uint8Array): { wav: Uint8Array; sampleRate: number } {
  if (!mod) throw new Error('spx decoder not initialized')
  const t0 = performance.now()

  const packets = parseOggPackets(bytes)
  if (packets.length < 3) throw new Error(`not enough ogg packets (${packets.length})`)
  const header = parseSpeexHeader(packets[0])

  // 一次性分配：bits 结构 / ctl 传出参 / 单帧输出缓冲 / 输入暂存
  const bitsPtr = mod._malloc(64) // SpeexBits 为指针+整型小结构，chars 由库内部分配
  const i32 = mod._malloc(4)
  let frameSize = 0
  let outPtr = 0
  let pktPtr = 0
  try {
    mod._speex_bits_init(bitsPtr)
    const state = mod._speex_decoder_init(mod._speex_lib_get_mode(header.mode))
    if (!state) throw new Error('speex_decoder_init failed')
    try {
      mod.setValue(i32, 1, 'i32') // 后滤波（enh）开启，speexdec 默认行为
      mod._speex_decoder_ctl(state, SPEEX_SET_ENH, i32)
      mod.setValue(i32, header.rate, 'i32')
      mod._speex_decoder_ctl(state, SPEEX_SET_SAMPLING_RATE, i32)
      mod._speex_decoder_ctl(state, SPEEX_GET_FRAME_SIZE, i32)
      frameSize = mod.getValue(i32, 'i32')
      if (frameSize <= 0 || frameSize > 65536) throw new Error(`bad frame_size ${frameSize}`)
      outPtr = mod._malloc(frameSize * 2)

      const out: number[] = []
      for (const pkt of packets.slice(2)) {
        // 头两包 = id header / comment，其后为帧数据
        if (pktPtr) mod._free(pktPtr)
        pktPtr = mod._malloc(pkt.length)
        mod.HEAPU8.set(pkt, pktPtr)
        mod._speex_bits_read_from(bitsPtr, pktPtr, pkt.length)
        // 循环解码至位流耗尽（返回 -1/-2）；天然支持 frames_per_packet>1
        for (;;) {
          const ret = mod._speex_decode_int(state, bitsPtr, outPtr)
          if (ret !== 0) break
          const base = outPtr >> 1
          for (let i = 0; i < frameSize; i++) out.push(mod.HEAP16[base + i])
        }
      }
      const pcm = Int16Array.from(out)
      if (pcm.length === 0) throw new Error('empty decode output')
      const elapsed = performance.now() - t0
      if (elapsed > 200) logError(`slow spx decode ${Math.round(elapsed)}ms ${bytes.length}B`)
      return { wav: toWav(pcm, header.rate), sampleRate: header.rate }
    } finally {
      mod._speex_decoder_destroy(state)
      mod._speex_bits_destroy(bitsPtr)
    }
  } finally {
    if (outPtr) mod._free(outPtr)
    if (pktPtr) mod._free(pktPtr)
    mod._free(i32)
    mod._free(bitsPtr)
  }
}

/** base64 → 字节（webview atob；输入为 Rust 侧 base64 编码的资源字节） */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 字节 → base64（分块避免 String.fromCharCode 爆栈，WAV 可达数百 KB） */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}
