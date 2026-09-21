import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowUpRight, ChevronUp, Copy, Loader2, ScanText, Sparkles, TextSelect, Volume2 } from "lucide-react";
import { buildLineTranslatePrompt, buildStructuredOcrPrompt, buildVisionOcrPrompt } from "../lib/actionPrompts";
import { aiReady } from "../lib/aiConfig";
import { targetLangByCode, sourceLangCompat } from "../lib/translate";
import { extractOcrItems, joinTranslations, parseNumberedLines } from "../lib/lineTranslate";
import { mergeOcrResult } from "../lib/ocrAlign";
import LangSelect from "../components/LangSelect";
import CaptureBar from "../components/CaptureBar";
import { AiBody, useAiStream } from "./panel/aiParts";
import { speakSentence, type PronounceHint } from "../services/pronounce";
import type { AiStreamConfig, AiStreamMessage } from "../services/aiStream";
import type { PrefsPayload, PronouncePrefs } from "../types/prefs";

/** OCR 识别行（Rust OcrLineOut；x/y/w/h = 屏幕物理坐标 words 并集，空 = 0） */
interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 位置为估算（AI 回填插值行；渲染层不消费，排错区分 rect 来源） */
  est?: boolean;
}

/** 全屏底图（Rust ocr_screen_snapshot；放大镜采样用，物理尺寸） */
interface OcrScreenShot {
  image: string;
  width: number;
  height: number;
}

/** OCR 识别结果（Rust ocr_recognize_region payload；选区为屏幕物理坐标） */
interface OcrRegionResult {
  lines: OcrLine[];
  text: string;
  /** 选区截图快照（PNG dataURL；编码失败为空串，降级无快照） */
  snapshot: string;
  regionX: number;
  regionY: number;
  regionW: number;
  regionH: number;
  elapsedMs: number;
}

type Phase = "select" | "working" | "result";

/** 拖框矩形（窗口内 CSS 像素） */
interface DragRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 结构化 OCR 模型特征（解耦）：id 含 ocr 词段 = OCR 专用模型族
 *  （qwen3.5-ocr / qwen-vl-ocr / deepseek-ocr…），原生输出 rotate_rect 坐标 JSON，
 *  识别**不依赖系统 OCR**（L2 坐标直建）；普通视觉模型（qwen3-vl-flash 等）无
 *  坐标，位置维度路由到系统 OCR 骨架（识别前自动补跑缓存帧识别）。词段匹配
 *  防误伤（process 等普通词不命中） */
const isStructuredOcrModel = (id: string) => /(?:^|[-._/])ocr(?:[-._]|$)/i.test(id);

const MIN_SIZE = 8;
const CARD_MIN_W = 380;
/** 翻译卡估算高（定位翻转判断用；实际 maxHeight 70vh 可滚动） */
const CARD_EST_H = 320;
/** 折叠 bar 估宽（右缘钳制预留；实际 max-content） */
const BAR_EST_W = 340;
/** 放大镜（PixPin 式）：显示边长与放大倍率（采样进模式时的全屏底图） */
const LENS_SIZE = 150;
const LENS_ZOOM = 3;

/** 解析生效目标语言（废止旧「中→英其他→中」智能方向）：
 *  auto = 自动检测源语言 → **一律译为中文**（对齐微信截图翻译高频路径）——
 *  旧逻辑把英文内容判成译英，英文原文 as-is 返回 = 观感「没翻译」（实测反馈） */
function resolveTargetCode(pref: string): string {
  return pref === "auto" || pref === "" ? "zh-cn" : pref;
}

/** 快照 dataURL → CF_DIB（BITMAPINFOHEADER + 32bpp BGRA 自底向上）base64：
 *  「复制截图」用——像素组装在前端（canvas 已解码 PNG，Rust 免图片解码依赖），
 *  Rust 只把字节写进剪贴板（clipboard_write_image）。解码失败抛错由调用方兜底 */
async function snapshotToDib(dataUrl: string): Promise<string> {
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("snapshot decode failed"));
    img.src = dataUrl;
  });
  const w = img.width;
  const h = img.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data; // RGBA
  // 40 字节 BITMAPINFOHEADER：biHeight 正值 = 自底向上行序（剪贴板惯例）
  const header = new DataView(new ArrayBuffer(40));
  header.setUint32(0, 40, true);
  header.setInt32(4, w, true);
  header.setInt32(8, h, true);
  header.setUint16(12, 1, true);
  header.setUint16(14, 32, true);
  header.setUint32(20, w * h * 4, true);
  const out = new Uint8Array(40 + w * h * 4);
  out.set(new Uint8Array(header.buffer));
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4; // 自底向上
    const dst = 40 + y * w * 4;
    for (let x = 0; x < w; x++) {
      out[dst + x * 4] = data[src + x * 4 + 2]; // B
      out[dst + x * 4 + 1] = data[src + x * 4 + 1]; // G
      out[dst + x * 4 + 2] = data[src + x * 4]; // R
      out[dst + x * 4 + 3] = 255; // 截屏不透明
    }
  }
  // 分块转 base64（String.fromCharCode 大数组有栈限制）
  let bin = "";
  for (let i = 0; i < out.length; i += 0x8000) {
    bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** 快照 PNG dataURL → JPEG 重编码（长边 ≤2000px、质量 0.85）——vision 上传
 *  体积优化（PNG 截图可达数 MB，JPEG 通常 <300KB）；解码失败原样返回（PNG 大
 *  一点也能用，不阻断主流程） */
async function reencodeJpeg(dataUrl: string): Promise<string> {
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("decode failed"));
      img.src = dataUrl;
    });
    const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return dataUrl;
  }
}

/** 截图翻译覆盖层（二期改手动翻译 + PixPin 式折叠 bar）：
 *  拖框松开 → 定格选框上屏 → Rust 直截透屏识别（语言全自动 + 快照 PNG）→
 *  **快照钉选框原位 + 原文块按行叠加（可选中复制）**，**不自动翻译**——折叠
 *  bar 点「译」才启动流式翻译；**默认显示原文态**，翻译启动后联动切译文态。
 *  **遮罩纯透明**（暗色遮罩会被 BitBlt 合成进快照致偏黑——模式指示 =
 *  十字光标 + **PixPin 式放大镜**（采样 launch 时 show 前截取的全屏底图，选框
 *  态全程跟随鼠标 ×3 + 十字线，**拖框中也跟随**、松开进 working 才隐藏，⑪）
 * + 顶部提示条）。**零焦点唤起 + 拖框确认后延迟补焦点**（⑪快捷键
 *  Released 触发（主键未释放层）+ select 态零焦点（show 后抢焦点 = 首帧
 *  present 滞留层）；拖框后 ocr_focus_capture 补键盘焦点，Esc 可用；select
 *  态退出走右键）。**整体可拖动**（按住快照拖：快照+行块+bar/卡一起平移）。
 *  **点空白不退出**，退出走 **Esc（拖框后）/ 右键 / ×**（原文块右键 = 复制
 *  菜单不退出）。**无 error 弹窗**：空结果直接进 bar 态，真异常展开卡内显示。
 *  「复制截图」= CF_DIB 进剪贴板后退出。**✨ = AI OCR 兜底（只识别不翻译）**：
 *  识别文本回填行数据，翻译仍走手动「译」；失败/空输出在展开卡可见反馈。
 *  「源」下拉 = 源语言提示，不控制 OCR 识别引擎（全自动）。每次唤起 reset 流
 *  内容。透明窗口须显式清 html/body 背景（ToolbarApp 同款）。 */
export default function OcrCaptureApp() {
  const [phase, setPhase] = useState<Phase>("select");
  /** 拖动中的框（select 态实时跟随鼠标） */
  const [drag, setDrag] = useState<DragRect | null>(null);
  /** 松开即锁定的框（working 态快照/翻译卡定位用——冻结副本，鼠标事件不再影响） */
  const [rect, setRect] = useState<DragRect | null>(null);
  const [snapshot, setSnapshot] = useState("");
  const [ocrText, setOcrText] = useState("");
  /** 参与翻译/叠加的行（识别结果过滤空行；rect 为屏幕物理坐标） */
  const [ocrLines, setOcrLines] = useState<OcrLine[]>([]);
  /** 选区屏幕物理坐标（行 rect 物理 → CSS 换算标定用） */
  const [region, setRegion] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  /** 译文叠加开关（**默认关 = 原文态**识别完成先看原文；点「译」
   *  启动翻译后自动切 true 联动；关 = 露出快照原文） */
  const [showOverlay, setShowOverlay] = useState(false);
  /** 视图整体平移偏移（快照+行块+bar/卡一起拖；框在屏幕边缘行块超界时拖回视口） */
  const [viewOffset, setViewOffset] = useState({ x: 0, y: 0 });
  /** 全屏底图（放大镜采样；launch 时 Rust 在覆盖层 show 前截取，画面纯净） */
  const [screenShot, setScreenShot] = useState<OcrScreenShot | null>(null);
  /** 选框态鼠标位置（放大镜跟随——含拖框中 ⑪） */
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);
  /** AI OCR 进行中（✨ 视觉识别兜底）：流内容是编号原文非译文，渲染期必须隔离 */
  const [aiOcrMode, setAiOcrMode] = useState(false);
  /** 截图后自动系统识别（偏好快照，唤起时读取； 默认
   *  false = 只截屏钉原位，点 bar「识别文字」手动触发） */
  const [autoRecognize, setAutoRecognize] = useState(false);
  /** 系统 OCR 识别进行中（bar ScanText 按钮转圈；与翻译/AI 流互斥） */
  const [ocrLoading, setOcrLoading] = useState(false);
  /** 翻译卡展开态：默认折叠 = PixPin 式截图 bar（点「翻译」展开并启动；
   *  流式在后台继续，折叠/展开只控显隐） */
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [aiMissing, setAiMissing] = useState(false);
  /** AI 图译模型未设置提示（点击图译按钮时校验；展开卡内提示引导） */
  const [visionHint, setVisionHint] = useState(false);
  const [error, setError] = useState("");
  /** 发音偏好（朗读识别结果；null = 未读到） */
  const [pronounce, setPronounce] = useState<PronouncePrefs | null>(null);
  /** 朗读状态提示（合成中 / 失败；完成清空） */
  const [speakHint, setSpeakHint] = useState<PronounceHint | null>(null);
  /** 目标语言（"auto" = 译为中文）。**会话级临时选择**（废止「即改
   *  即存写回偏好」）：截图浮层内一切语言选择不写偏好，设置页是唯一默认入口 */
  const [targetPref, setTargetPref] = useState("auto");
  /** 默认目标 = 本次唤起时的偏好快照（bar「还原为默认」按钮的还原目标） */
  const [defaultTarget, setDefaultTarget] = useState("auto");
  /** 源语言提示（"" = 自动）：**只告知 LLM 原文语言**（防误判相似语言），
   *  不控制 OCR 识别引擎（识别语言全自动）。值 = 统一语言表 code（cherry 对齐），
   *  旧偏好存过系统 BCP-47 tag 由 sourceLangCompat 归一化。浮层下拉即改即存 */
  const [sourceLang, setSourceLang] = useState("");
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  /** 框选最新坐标（ref 同步记录——mouseup 闭包里的 drag state 滞后一次渲染，
   *  手抖松开时会冻结旧坐标造成偏移，实测；渲染用 state、取值用 ref） */
  const dragRef = useRef<DragRect | null>(null);
  /** 整体拖动基准（快照 img 按下记录鼠标与当前偏移；根层 move/up 驱动） */
  const panBase = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const { content, error: aiError, loading, run, reset } = useAiStream();

  // 发音偏好（朗读按钮用）：挂载读取 + prefs-changed 即时跟随（设置页改语音即生效）
  useEffect(() => {
    const load = () => {
      void invoke<PrefsPayload>("prefs_get")
        .then((p) => setPronounce(p.pronounce ?? null))
        .catch(() => {});
    };
    load();
    const un = listen("prefs-changed", load);
    return () => {
      void un.then((f) => f(), () => {});
    };
  }, []);

  // 行级协议流式解析：增量全量重解析（行数小零成本），部分行就绪即渲染叠加。
  // degraded 仅在流式结束后判定（首 token 空窗/前导语不得触发降级）
  const parsed = useMemo(() => parseNumberedLines(content), [content]);
  const lineDegraded = !loading && !aiError && content.length > 0 && parsed.degraded;
  /** 已就绪行拼译文全文（卡内显示 + 复制译文用） */
  const translatedText = useMemo(
    () => joinTranslations(parsed.map, ocrLines.length),
    [parsed, ocrLines.length],
  );

  // 透明窗口：清根层背景（app.css 主题背景会盖住透屏效果）
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  /** 原「焦点恢复强刷」（focus → setFocusTick 重渲染）
   * 与心跳探针 HUD（raf/timer/pointer 诊断）已撤——双层根因快捷键
   *  Released 触发（主键未释放层）+ select 态零焦点（show 后抢焦点 = 首帧
   *  present 滞留层）。键盘焦点 = 拖框确认后 ocr_focus_capture 延迟补上 */

  /** 每次唤起重置到选框态（重复唤起 / 上次残留），并回读源语言偏好（与设置页同步）。
   *  **必须 reset 流内容**：覆盖层窗口复用不卸载，残留译文会按行号套在新截图上
   *  （默认叠加态下 = 观感「自动翻译」 实测 bug 根因） */
  useEffect(() => {
    const un = listen("ocr://capture-started", () => {
      // [baseline 诊断版] window.focus() 已删（焦点类手段 A/B 清单）
      reset();
      setPhase("select");
      setDrag(null);
      setRect(null);
      setSnapshot("");
      setOcrText("");
      setOcrLines([]);
      setRegion(null);
      setShowOverlay(false);
      setViewOffset({ x: 0, y: 0 });
      setMouse(null);
      setAiOcrMode(false);
      setExpanded(false);
      setVisionHint(false);
      setError("");
      setAiMissing(false);
      setOcrLoading(false);
      setAiDebug("");
      skeletonRef.current = null;
      dragStart.current = null;
      dragRef.current = null;
      panBase.current = null;
      void invoke<PrefsPayload>("prefs_get")
        .then((p) => {
          setSourceLang(sourceLangCompat(p.ocrLang));
          setAutoRecognize(Boolean(p.ocrAutoRecognize));
        })
        .catch(() => {});
      // 全屏底图 + 鼠标初始坐标（Rust launch 时已备好；空图 = 放大镜降级隐藏）。
      // 初始坐标让放大镜「唤起即显示」——不依赖首条 mousemove（未动鼠标直接
      // 拖框时 mousemove 从未触发的实测边界）
      void invoke<[string, number, number, number, number]>("ocr_screen_snapshot")
        .then(([image, width, height, mx, my]) => {
          setScreenShot(image ? { image, width, height } : null);
          if (image) setMouse({ x: mx, y: my });
        })
        .catch(() => setScreenShot(null));
    });
    return () => {
      void un.then((f) => f(), () => {});
    };
  }, [reset]);

  const hide = useCallback(() => {
    void invoke("ocr_hide_capture").catch(() => {});
  }, []);

  /** 朗读识别结果：优先已就绪的译文（逐行拼接），无译文读原文 */
  const speakResult = useCallback(() => {
    if (!pronounce) return;
    const text = (translatedText || ocrText).trim();
    if (!text) return;
    void speakSentence(text, pronounce, setSpeakHint).catch((e) => {
      setSpeakHint({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    });
  }, [pronounce, translatedText, ocrText]);

  /** 复制截图快照后退出（复制即完成使命）。复制失败同样退出——
   *  低频兜底不阻塞；剪贴板写入是系统调用，失败无恢复动作可做 */
  const copySnapshotAndHide = useCallback(() => {
    if (!snapshot) return;
    void snapshotToDib(snapshot)
      .then((dib) => invoke("clipboard_write_image", { dib }))
      .catch(() => {})
      .finally(() => hide());
  }, [snapshot, hide]);

  // Esc / 右键退出（右键恢复为退出，对齐主流截图工具）。原文块的右键
  // 复制菜单在其上 stopPropagation 拦截（React root 先于 window 触发），
  // bar/展开卡容器也拦截（preventDefault 不退出，防误触丢操作上下文）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      hide();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("contextmenu", onCtx);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onCtx);
    };
  }, [hide]);

  /** 启动/重启翻译（全局默认模型；固定非思考快响应）。
   *  二期行级协议：lines = OCR 行文本数组（编号后发送），LLM 逐行回 "N. 译文"
   *  供叠加层按行渲染；格式走样时降级全文模式（lineDegraded）。
   * auto = 译为中文。srcTag = 源语言提示（统一表 code；空 = 自动）
   *  ——只告知 LLM 原文语言（防误判相似语言），不控制 OCR 识别引擎（全自动） */
  const startTranslate = useCallback(
    (lines: string[], pref: string, srcTag: string) => {
      const code = resolveTargetCode(pref);
      const sourceName = srcTag ? targetLangByCode(srcTag).promptName : undefined;
      const prompt = buildLineTranslatePrompt(
        lines,
        targetLangByCode(code).promptName,
        sourceName,
      );
      const messages: AiStreamMessage[] = [
        {
          role: "user",
          content: prompt,
        },
      ];
      void invoke<PrefsPayload>("prefs_get")
        .then((p) => {
          if (!aiReady(p.ai)) {
            setAiMissing(true);
            return;
          }
          // 清残留提示（AI OCR 失败写入的 error / 引导等）：error 显示优先级
          // 最高，不清会永久屏蔽译文展示
          setError("");
          setAiMissing(false);
          setVisionHint(false);
          const config: AiStreamConfig = { model: p.ai?.model ?? undefined, noThink: true };
          void run(messages, config);
        })
        .catch(() => setAiMissing(true));
    },
    [run],
  );

  /** 整体拖动的偏移钳制：快照至少留 48px 在视口内（防拖丢找不回） */
  const clampOffset = (ox: number, oy: number) => {
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.min(Math.max(ox, -rect.x - rect.w + 48), window.innerWidth - 48 - rect.x),
      y: Math.min(Math.max(oy, -rect.y - rect.h + 48), window.innerHeight - 48 - rect.y),
    };
  };

  /** 快照上按下 = 开始整体拖动（快照+行块+bar/卡一起平移）；原文块 mousedown
   *  已阻断冒泡（选字优先），译文块 pointer-events-none 穿透到快照可拖 */
  const onSnapshotMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    panBase.current = { x: e.clientX, y: e.clientY, ox: viewOffset.x, oy: viewOffset.y };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    // working/result 态点遮罩空白**不退出**（对齐主流截图工具：复制/选字时点
    // 到框外不得丢结果；退出只走 Esc / 右键 / × 按钮）
    if (phase !== "select" || e.button !== 0) return;
    dragStart.current = { x: e.clientX, y: e.clientY };
    const r = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
    dragRef.current = r;
    setDrag(r);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    // 整体拖动中：平移视图（优先于框选——两者不同态不会并存）
    const pb = panBase.current;
    if (pb) {
      setViewOffset(clampOffset(pb.ox + e.clientX - pb.x, pb.oy + e.clientY - pb.y));
      return;
    }
    const s = dragStart.current;
    if (!s || phase !== "select") {
      // 未拖框时记录鼠标位置（放大镜跟随）
      if (phase === "select") setMouse({ x: e.clientX, y: e.clientY });
      return;
    }
    const r = {
      x: Math.min(s.x, e.clientX),
      y: Math.min(s.y, e.clientY),
      w: Math.abs(e.clientX - s.x),
      h: Math.abs(e.clientY - s.y),
    };
    // ref 同步更新（state 滞后一次渲染），mouseup 从 ref 取最终值
    dragRef.current = r;
    setDrag(r);
    // 拖框中放大镜继续跟随（⑪：终点精确定位；松开进 working 态才隐藏）
    setMouse({ x: e.clientX, y: e.clientY });
  };

  /** 区域结果统一回填（自动识别 / 工具条手动识别两路共用）：快照
   *  钉原位 + 行级数据 + 空态处理 + 目标语言偏好随识别读取（用户可能在截图间隙
   *  改了设置）——**不自动翻译**：进 bar 态，点「翻译」手动启动 */
  const applyRegionResult = (res: OcrRegionResult) => {
    setSnapshot(res.snapshot);
    setRegion({ x: res.regionX, y: res.regionY, w: res.regionW, h: res.regionH });
    if (!res.text.trim()) {
      // 空结果**不弹窗**（删提示重新框选的弹窗，重按快捷键即可
      // 重选）——直接进 bar 态，快照在：识别文字/AI 图译兜底/复制截图/关闭都可用
      setPhase("result");
      return;
    }
    setOcrText(res.text);
    // 行级数据（过滤空行；行 rect 物理坐标随 region 存，叠加换算标定用）
    const usable = res.lines.filter((l) => l.text.trim());
    setOcrLines(usable);
    setElapsed(res.elapsedMs);
    setPhase("result");
    void invoke<PrefsPayload>("prefs_get")
      .then((p) => {
        const d = p.ocrTargetLang || "auto";
        setTargetPref(d);
        setDefaultTarget(d);
      })
      .catch(() => {});
  };

  const onMouseUp = () => {
    // 整体拖动结束（panBase 在 capture-started/retake 也会清）
    if (panBase.current) {
      panBase.current = null;
      return;
    }
    if (!dragStart.current || phase !== "select") return;
    dragStart.current = null;
    // 从 ref 取最终框（state 闭包值滞后一次渲染——手抖松开必偏移）
    const r = dragRef.current;
    dragRef.current = null;
    // 点按/过小视为取消（保留选框态）
    if (!r || r.w < MIN_SIZE || r.h < MIN_SIZE) {
      setDrag(null);
      return;
    }
    // **松开即锁定**：冻结副本供快照/翻译卡定位（此后任何鼠标事件不影响位置）
    setRect({ ...r });
    setPhase("working");
    // 拖框确认后补键盘焦点（⑪折中）：select 态零焦点（show 后立即抢
    // 焦点 = 首帧 present 滞留的根因之一，baseline A/B 实测）；此刻合成管线
    // 已被交互解锁，set_focus 安全，此后 Esc 等键盘可用（select 态静止不交互
    // 的退出走右键——鼠标消息不依赖焦点）
    void invoke("ocr_focus_capture").catch(() => {});
    // **先等定格态上屏，再让 Rust 截屏**（实测双框/抖动根因）：invoke 会立即
    // 触发 BitBlt，而 React 卸载 drag 选框（白边框 + blue-400/10 填充）要等下一帧
    // 合成——竞态时白线与半透明填充被定格进快照：钉回后 = img 外框 + 快照内定格
    // 框（双框）+ 内容整体灰蓝偏色 + 定格位置落后最后一帧（抖动）。时好时坏即
    // 合成快慢的竞态。双 rAF（提交新帧）+ 一帧兜底，确保上屏的是纯透屏定格态。
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        setTimeout(() => {
          // 默认只截屏不识别；设置开启「截图后自动识别」
          // 才走一体识别（语义同拆分前）。两路结果同构，统一 applyRegionResult 回填
          const cmd = autoRecognize ? "ocr_recognize_region" : "ocr_capture_region";
          void invoke<OcrRegionResult>(cmd, {
            x: r.x,
            y: r.y,
            width: r.w,
            height: r.h,
          })
            .then(applyRegionResult)
            .catch((e) => {
              // 真异常（如系统缺 OCR 语言包）：也进 result 态，展开卡内显示错误
              // 信息（弹窗已删）；error 非空时卡自动展开
              setError(String(e));
              setPhase("result");
              setExpanded(true);
            });
        }, 16),
      ),
    );
  };

  /** 工具条「识别文字」（系统 OCR 手动入口 截图默认不识别）：
   *  对**上次截屏帧**（Rust 缓存，与钉住快照同源）跑 Windows OCR——不重截屏
   *  （背景画面可能已变：视频/动画），结果统一回填。与翻译/AI 流互斥（识别
   *  期间再点忽略）；失败展开卡显示（同自动识别路径） */
  const runSystemOcr = () => {
    if (loading || ocrLoading || !snapshot) return;
    setOcrLoading(true);
    void invoke<OcrRegionResult>("ocr_recognize_captured")
      .then((res) => {
        applyRegionResult(res);
        setOcrLoading(false);
      })
      .catch((e) => {
        setOcrLoading(false);
        setError(String(e));
        setExpanded(true);
      });
  };

  /** 手动翻译（bar「翻译」按钮）：**不展开卡**（译文叠加逐行替换即
   *  反馈，展开是低频需求走 bar 展开按钮）；未翻过才启动流，已有译文再点 =
   *  按当前下拉重译；loading 中按钮不可达。启动即**联动切译文态**（
   *  默认原文态 → 翻译后自动切译文） */
  const doTranslate = () => {
    if (loading) return;
    setShowOverlay(true);
    startTranslate(ocrLines.map((l) => l.text), targetPref, sourceLang);
  };

  /** AI OCR 兜底（改造：**只识别不翻译**——识别纯粹兜底本地 OCR，翻译仍走
   *  手动「译」）：快照重编码 JPEG 直发视觉模型，行编号输出与本地 OCR 协议
   *  同构；流结束回填 ocrLines/ocrText（见 aiOcrMode effect）。模型 = 偏好
   *  `ocrVisionModel`（`providerId:model` 跨卡路由）；未设置时展开卡提示引导 */
  /** 普通视觉模型的本地骨架（两段式显示修复）：路由补跑的系统识别
   *  结果**不入 ocrLines state**——入 state 会立即渲染行块（先见系统结果再见
   *  AI 结果的两段式跳变，用户否定）；存 ref 待回填时一次性融合 */
  const skeletonRef = useRef<OcrLine[] | null>(null);
  /** AI 原始输出（识别成功也保留，格式标定调试用——L2 坐标语义未定，展开卡
   *  可见模型实际返回形态，免反复实机验证盲猜） */
  const [aiDebug, setAiDebug] = useState("");

  const startVisionOcr = useCallback(() => {
    if (loading || !snapshot) return;
    void invoke<PrefsPayload>("prefs_get")
      .then(async (p) => {
        if (!aiReady(p.ai)) {
          setAiMissing(true);
          setExpanded(true);
          return;
        }
        const route = p.ocrVisionModel || "";
        const sep = route.indexOf(":");
        if (sep <= 0 || sep === route.length - 1) {
          setVisionHint(true);
          setExpanded(true);
          return;
        }
        setVisionHint(false);
        setExpanded(false);
        // 产出是**原文**非译文：保持原文态，翻译由用户点「译」触发
        setShowOverlay(false);
        const provider = route.slice(0, sep);
        const model = route.slice(sep + 1);
        // **模型特征路由（解耦）**：结构化 OCR 模型（qwen3.5-ocr
        // 族，id 含 ocr 词段）自带 rotate_rect 坐标，识别完全独立不碰系统 OCR；
        // 普通视觉模型无坐标 → 位置维度路由到系统 OCR——本地无行（默认不识别
        // 路径）先对缓存帧补识别拿骨架（~100ms 无感），失败不阻塞（结构化模型
        // 不受影响；纯文本模型降级零 rect 由回填层兜底）
        const structured = isStructuredOcrModel(model);
        if (!structured && !ocrLines.length) {
          try {
            const res = await invoke<OcrRegionResult>("ocr_recognize_captured");
            const usable = res.lines.filter((l) => l.text.trim());
            // 只入 ref 不入 state：骨架是融合中间数据，入 state = 行块立即渲染
            // （先系统后 AI 两段式跳变 用户否定）
            if (usable.length) skeletonRef.current = usable;
          } catch {
            // 骨架补齐失败不阻塞 AI 识别（error 在回填层按实际数据兜底）
          }
        }
        const jpeg = await reencodeJpeg(snapshot);
        setAiOcrMode(true);
        void run(
          [{ role: "user", content: structured ? buildStructuredOcrPrompt() : buildVisionOcrPrompt(), images: [jpeg] }],
          {
            model,
            provider,
            noThink: true,
          },
        );
      })
      .catch(() => {
        setVisionHint(true);
        setExpanded(true);
      });
  }, [loading, snapshot, run, ocrLines]);

  // AI OCR 结果回填（流结束一次性应用，**无论成败必须退出 aiOcrMode**）：AI 项
  // 经 mergeOcrResult 与本地行融合（方案 -ocr-ai-backfill-alignment.md）：
  // 编号原文（普通模型，无坐标）走 L1/L3；编号解析为空走 extractOcrItems 宽容
  // 降级——结构化模型（qwen3.5-ocr 族）JSON 输出**带 rotate_rect**，本地无行时
  // L2 坐标直建（解耦系统 OCR），其余零 rect 兜底。随后 reset 流内容——编号
  // 原文不得流入译文管线（parsed/translatedText）。ocrText = 融合行 join（含
  // 本地保留行，行号与叠加/译文协议一致）。
  // **失败/空输出必须可见反馈**（实测静默 bug 双根因）：①流失败时
  // content 为空，旧逻辑 `!content` 直接 return → aiOcrMode 卡死「AI 识别中…」
  // 永久转圈且 aiError 被屏蔽（零提示）；②模型不守编号格式时解析为空静默跳过
  // = 观感「提取结果毫无变化」。现统一：失败/解析为空 → error 写入展开卡展示。
  // （传输层对不支持流式/仅思考输出的端点会给出具体诊断）
  useEffect(() => {
    if (!aiOcrMode || loading) return;
    const numbered = aiError
      ? []
      : [...parseNumberedLines(content).map.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
    const items = numbered.length
      ? numbered.map((t) => ({ text: t }))
      : aiError
        ? []
        : extractOcrItems(content);
    if (items.length) {
      // 融合回填（A 期）：L1 行数一致直通 / L3 对齐+插值 / L2 坐标
      // 直建（本地无行 + 全 rect）。骨架 ref（普通模型路由补跑的本地识别）优先
      // 于空 ocrLines——一次性融合入 state，无「先系统后 AI」两段式显示。
      // region/ocrLines 在 aiOcrMode 期间无变化源（识别完成后才进 AI 模式，AI
      // 模式中无其他写入方）；setAiOcrMode(false) 同批提交 → ocrLines 变化触发
      // 的重跑被 aiOcrMode 守卫拦截，无重复回填
      setAiDebug(content.trim().slice(0, 500));
      const skeleton = skeletonRef.current;
      skeletonRef.current = null;
      const merged = mergeOcrResult(items, skeleton ?? ocrLines, region ?? { x: 0, y: 0, w: 0, h: 0 });
      setOcrLines(merged);
      setOcrText(merged.map((l) => l.text).join("\n"));
    } else {
      // 诊断附原始输出开头（实机验证二轮）：提取为空时让用户直接看到
      // 模型返回形态，免「坐标污染/格式未知」类问题二次排查盲猜
      skeletonRef.current = null;
      setError(
        aiError
          ? String(aiError)
          : `AI 识别未返回有效结果——请确认所选模型支持视觉（vision）输入后重试。${
              content.trim() ? `（原始输出开头：${content.trim().slice(0, 160)}）` : ""
            }`,
      );
      setExpanded(true);
    }
    setAiOcrMode(false);
    reset();
  }, [aiOcrMode, loading, content, aiError, reset, ocrLines, region]);

  /** 指定目标语言（bar 下拉/展开卡共用）：**只改会话级选择不写偏好**（设置页是
   * 唯一默认入口）；已有译文/在翻 = 立即按新语言重译 */
  const changeTarget = (code: string) => {
    setTargetPref(code);
    if (ocrLines.length && (loading || translatedText))
      startTranslate(ocrLines.map((l) => l.text), code, sourceLang);
  };

  /** 还原为默认目标（偏好快照）；已有译文/在翻 = 按默认重译 */
  const resetTarget = () => changeTarget(defaultTarget);

  /** 翻译卡定位：默认快照下方 10px；下方空间 < 估高放快照上方；水平钳制视口 */
  const cardStyle = (() => {
    if (!rect) return null;
    const width = Math.max(CARD_MIN_W, Math.min(rect.w, 640));
    const left = Math.min(Math.max(rect.x, 8), Math.max(8, window.innerWidth - width - 8));
    const below = rect.y + rect.h + 10;
    const top =
      window.innerHeight - below >= CARD_EST_H ? below : Math.max(8, rect.y - CARD_EST_H - 10);
    return { left, top, width };
  })();

  /** 折叠 bar 定位：宽度按内容自适应（不设 width——首轮实测按钮撑破定宽容器
   *  溢出屏外），left 预留估宽钳制右缘 */
  const barStyle = (() => {
    if (!rect) return null;
    const left = Math.min(Math.max(rect.x, 8), Math.max(8, window.innerWidth - BAR_EST_W - 8));
    const below = rect.y + rect.h + 10;
    const top = window.innerHeight - below >= 48 ? below : Math.max(8, rect.y - 58);
    return { left, top };
  })();

  const langMissing = error.includes("OCR_LANG_MISSING");

  return (
    <div
      className={`fixed inset-0 select-none ${phase === "select" ? "[cursor:crosshair]" : ""}`}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {/* 选框（仅选框态）：**无暗色遮罩**（遮罩色会被 BitBlt 合成进快照
          致偏黑；模式指示交给十字光标 + 放大镜 + 提示条）。白边 + 淡蓝填充
          （填充只在拖框中，invoke 前已卸载不进快照） */}
      {drag && phase === "select" && (
        <div
          className="absolute border-2 border-white/90 bg-blue-400/10 [cursor:crosshair]"
          style={{ left: drag.x, top: drag.y, width: drag.w, height: drag.h }}
        >
          <span className="absolute -top-6 left-0 rounded bg-black/70 px-1.5 py-0.5 text-white text-xs tabular-nums">
            {drag.w} × {drag.h}
          </span>
        </div>
      )}

      {phase === "select" && !drag && (
        <div className="absolute left-1/2 top-6 -translate-x-1/2 rounded-full bg-black/70 px-4 py-1.5 text-white/90 text-xs">
          拖拽框选识别文字 · 右键退出
        </div>
      )}

      {/* PixPin 式放大镜（选框态全程跟随 ⑪）：采样进模式时的全屏底图（launch 时
          show 前截取，纯净画面），中心对齐鼠标 ×3 放大 + 十字线辅助定位。
          **拖框中继续跟随**（终点精确定位），松开进 working 态才隐藏；
          贴右缘自动翻到鼠标左侧；底图缺失（截屏失败）降级隐藏 */}
      {phase === "select" && mouse && screenShot && (
        (() => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          let lx = mouse.x + 24;
          if (lx + LENS_SIZE > vw - 8) lx = mouse.x - 24 - LENS_SIZE;
          const ly = Math.min(Math.max(mouse.y - LENS_SIZE / 2, 8), Math.max(8, vh - LENS_SIZE - 8));
          const imgW = vw * LENS_ZOOM;
          const imgH = vh * LENS_ZOOM;
          const tx = Math.min(Math.max(-(mouse.x * LENS_ZOOM - LENS_SIZE / 2), -(imgW - LENS_SIZE)), 0);
          const ty = Math.min(Math.max(-(mouse.y * LENS_ZOOM - LENS_SIZE / 2), -(imgH - LENS_SIZE)), 0);
          return (
            <div
              className="pointer-events-none absolute overflow-hidden rounded-md border-2 border-white/90 shadow-xl"
              style={{ left: lx, top: ly, width: LENS_SIZE, height: LENS_SIZE }}
            >
              <img
                src={screenShot.image}
                alt=""
                draggable={false}
                className="absolute max-w-none"
                style={{
                  width: imgW,
                  height: imgH,
                  transform: `translate(${tx}px, ${ty}px) translateZ(0)`,
                  willChange: "transform",
                }}
              />
              {/* 中心十字线（框选起点定位） */}
              <div className="absolute left-0 right-0 top-1/2 h-px bg-red-500/80" />
              <div className="absolute bottom-0 top-0 left-1/2 w-px bg-red-500/80" />
            </div>
          );
        })()
      )}

      {/* 定格选框（working 态快照未就绪时）：**无边框无遮罩**——框内纯透屏供
          Rust 直截；快照返回后由 img 在同一位置无缝覆盖 */}
      {phase !== "select" && rect && !snapshot && (
        <div
          className="absolute"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        >
          <div className="absolute -top-7 left-0 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-white/90 text-xs">
            <Loader2 className="size-3 animate-spin" />
            识别中…
          </div>
        </div>
      )}

      {/* 快照钉在选框原位（识别完成，无缝接替定格选框）+ **整体拖动手柄**：
          按住快照拖 = 快照+行块+bar/卡一起平移（框在屏幕边缘行块超界时拖回
          视口）。outline 不占内容盒——border 会把 img 内容盒缩 1px，
          快照不再 1:1 铺满。cursor-move 提示可拖；原文块选字不受影响（其
          mousedown 已阻断冒泡） */}
      {phase !== "select" && rect && snapshot && (
        <img
          src={snapshot}
          alt="截图快照"
          draggable={false}
          onMouseDown={onSnapshotMouseDown}
          className="absolute cursor-move shadow-lg outline outline-1 outline-white/70"
          style={{
            left: rect.x + viewOffset.x,
            top: rect.y + viewOffset.y,
            width: rect.w,
            height: rect.h,
          }}
        />
      )}

      {/* 二期行级叠加（有次序产生）：OCR 完成 → 每行原文块立即贴在原行位置
          （白底黑字、select-text 可选中复制——QQ/PixPin「还原文字」主流做法）；
          译文流式就绪一行替换一行（深底白字、鼠标穿透）。「原文」档 = 全部原文
          可复制；「译文」档 = 就绪行显示译文、未就绪/漏行保持原文。
          坐标 = 选区 CSS 原点 +（行物理 rect − 选区物理原点）÷ sf——sf 用
          regionW/rectW 标定（首轮实测跑偏根因：漏加选区原点）。原文块 mousedown
          阻断冒泡（根层 working 态点空白 = 关闭）；右键放行默认菜单（复制）不关窗。 */}
      {phase !== "select" && rect && region && ocrLines.length > 0 && (
        <>
          {ocrLines.map((ln, i) => {
            if (ln.w <= 0 || ln.h <= 0) return null;
            const t = parsed.map.get(i + 1);
            const isTrans = showOverlay && Boolean(t);
            const sf = rect.w > 0 ? region.w / rect.w : 1;
            const cssH = ln.h / sf;
            return (
              <div
                key={i}
                className={`absolute flex items-center overflow-hidden rounded-[3px] px-1 shadow-sm ${
                  isTrans
                    ? "pointer-events-none bg-slate-900/85 text-white"
                    : "cursor-text select-text border border-neutral-200 bg-white/95 text-neutral-900"
                }`}
                style={{
                  left: rect.x + viewOffset.x + (ln.x - region.x) / sf,
                  top: rect.y + viewOffset.y + (ln.y - region.y) / sf,
                  maxWidth: Math.max((ln.w / sf) * (isTrans ? 1.8 : 1.4), 140),
                  minWidth: Math.max(ln.w / sf, 8),
                  minHeight: Math.max(cssH, 12),
                  fontSize: Math.min(Math.max(cssH * 0.72, 10), 17),
                  lineHeight: 1.15,
                }}
                onMouseDown={isTrans ? undefined : (e) => e.stopPropagation()}
                onContextMenu={isTrans ? undefined : (e) => e.stopPropagation()}
              >
                <span className="min-w-0 truncate">{isTrans ? t : ln.text}</span>
              </div>
            );
          })}
        </>
      )}

      {/* 折叠 bar（result 默认态）：共享 CaptureBar（设置页「截图助手」预览同源）。
          [目标▾][↺] | [译][✨AI][ScanText 复制文字][Languages 切换][Copy 复制截图]
          | [▾ 展开][×]。语言选择 = 会话级；空结果也显示 bar（AI 图译兜底/复制截图
          入口），ocrText 为空时复制文字 no-op；点空白不退出，退出走 Esc/右键/× */}
      {phase === "result" && !expanded && barStyle && snapshot && (
        <div
          className="absolute"
          style={{ left: barStyle.left + viewOffset.x, top: barStyle.top + viewOffset.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <CaptureBar
            targetValue={targetPref === "auto" ? "" : targetPref}
            defaultTarget={defaultTarget === "auto" ? "" : defaultTarget}
            loading={loading && !aiOcrMode}
            aiOcrLoading={aiOcrMode}
            showOverlay={showOverlay}
            onTargetChange={(code) => changeTarget(code || "auto")}
            onResetTarget={resetTarget}
            onTranslate={doTranslate}
            onVisionTranslate={startVisionOcr}
            onSystemOcr={runSystemOcr}
            ocrLoading={ocrLoading}
            onCopySource={() => {
              if (ocrText) void invoke("clipboard_write", { text: ocrText }).catch(() => {});
            }}
            onToggleOverlay={() => setShowOverlay((v) => !v)}
            onCopySnapshot={copySnapshotAndHide}
            onExpand={() => setExpanded(true)}
            onClose={hide}
          />
        </div>
      )}

      {/* 翻译卡（展开态）：bar 点「▾ 展开」进入；头部可收起回 bar（流式后台继续）。
          渲染不设内容前置条件——空文本也进卡显示空态（旧版按内容源过滤，空文本时
          bar 已收起而卡不渲染 = 整体消失 实测 100% 复现已修）；
          识别异常（缺语言包等）也在此显示（弹窗已删） */}
      {phase === "result" && expanded && cardStyle && (
        <div
          className="absolute flex flex-col rounded-lg border border-neutral-200 bg-white text-neutral-800 shadow-xl"
          style={{
            ...cardStyle,
            left: cardStyle.left + viewOffset.x,
            top: cardStyle.top + viewOffset.y,
            maxHeight: "70vh",
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-neutral-200 px-3 py-2 text-xs">
            {/* 源语言下拉占标签位：[源] → [目标]。
                自绘 LangSelect——原生 select 无法嵌国旗 SVG（Windows 亦无国旗 emoji） */}
            <LangSelect
              value={sourceLang}
              auto="自动"
              onChange={(code) => {
                // 源语言提示（告知 LLM 原文语言）：会话级选择（设置页是默认入口）
                setSourceLang(code);
              }}
              title="源语言提示"
              className="rounded bg-neutral-100 px-1.5 py-0.5 hover:bg-neutral-200"
            />
            <span className="text-neutral-400">→</span>
            <LangSelect
              value={targetPref === "auto" ? "" : targetPref}
              auto="自动（译为中文）"
              onChange={(code) => changeTarget(code || "auto")}
              title="翻译目标语言"
              className="rounded bg-neutral-100 px-1.5 py-0.5 font-medium hover:bg-neutral-200"
            />
            <span className="flex-1" />
            {/* 叠加开关：译文/原文（选中 = 主题色文字，与 bar Languages 图标同款语义；
                默认原文态，翻译启动后联动切译文） */}
            <div className="flex overflow-hidden rounded border border-neutral-200 text-[11px]">
              <button
                type="button"
                onClick={() => setShowOverlay(true)}
                className={`px-1.5 py-0.5 [cursor:pointer] ${
                  showOverlay ? "font-medium text-primary" : "hover:bg-neutral-100"
                }`}
              >
                译文
              </button>
              <button
                type="button"
                onClick={() => setShowOverlay(false)}
                className={`px-1.5 py-0.5 [cursor:pointer] ${
                  !showOverlay ? "font-medium text-primary" : "hover:bg-neutral-100"
                }`}
              >
                原文
              </button>
            </div>
            {loading && !aiOcrMode && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            )}
            <span className="text-muted-foreground text-[10px]">识别 {elapsed}ms</span>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              title="收起"
              className="rounded p-0.5 text-neutral-500 hover:bg-neutral-100 [cursor:pointer]"
            >
              <ChevronUp className="size-3.5" />
            </button>
          </div>
          <div className="overflow-y-auto px-3 py-2.5">
            {error ? (
              /* 识别异常（弹窗已删 迁入卡内）：缺语言包给可操作指引 */
              langMissing ? (
                <p className="text-neutral-500 text-xs">
                  系统缺少 OCR 语言包——请在「设置 → 时间和语言 → 语言」中添加对应语言，并在其可选功能中勾选「光学字符识别」，然后重启应用。
                </p>
              ) : (
                <p className="break-all text-neutral-500 text-xs">{error}</p>
              )
            ) : aiMissing ? (
              <p className="text-neutral-500 text-xs">
                未配置 AI 服务，暂无法自动翻译——请到主窗口「设置 → 模型服务」配置端点与模型。
              </p>
            ) : visionHint ? (
              <p className="text-neutral-500 text-xs">
                未设置 AI 识别模型——请到「设置 → 截图助手」选择支持视觉的模型（如
                qwen3-vl-flash）。
              </p>
            ) : aiOcrMode ? (
              /* AI OCR 进行中：流内容是编号原文，隔离不进译文渲染管线 */
              <div className="flex items-center gap-2 text-muted-foreground text-xs">
                <Loader2 className="size-3.5 animate-spin" />
                AI 识别中…
              </div>
            ) : lineDegraded ? (
              /* 降级全文模式：模型不守行级格式，回退一期全文翻译展示 */
              <AiBody content={content} error={aiError} loading={loading} />
            ) : !ocrText && !translatedText && !loading && !aiError ? (
              /* 空文本空态（本地 OCR 未提取到文字）：给可操作指引，不再静默 */
              <p className="text-neutral-500 text-xs">
                未在截图区提取到文本——可点「✨」用 AI 识别兜底，或复制截图后自行处理。
              </p>
            ) : !translatedText && !loading && !aiError ? (
              /* 未翻译空态（手动翻译模式）：aiError 落到下方 else 分支显示红条
                  ——翻译流失败不得静默。文案按叠加有效性分流：本地骨架残缺
                  （AI 行零 rect 不渲染）时不说「已按行叠加」 */
              <p className="text-neutral-500 text-xs">
                {ocrLines.some((l) => l.w > 0)
                  ? "框内原文已按行叠加，可直接选中复制；点击「翻译」生成译文。"
                  : "AI 识别结果如下，可直接选中复制；点击「翻译」生成译文。"}
              </p>
            ) : (
              <>
                {loading && !translatedText && (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                )}
                {translatedText && (
                  <p className="min-w-0 break-words text-sm whitespace-pre-wrap select-text">
                    {translatedText}
                  </p>
                )}
                {aiError && (
                  <div className="mt-3 break-all rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
                    {aiError}
                  </div>
                )}
              </>
            )}
            {ocrText && (
              <details className="mt-2">
                <summary className="cursor-pointer text-muted-foreground text-[11px] hover:text-neutral-700">
                  识别原文
                </summary>
                <p className="mt-1 rounded bg-neutral-100 p-2 text-neutral-600 text-xs whitespace-pre-wrap select-text">
                  {ocrText}
                </p>
              </details>
            )}
            {aiDebug && (
              <details className="mt-2">
                <summary className="cursor-pointer text-muted-foreground text-[11px] hover:text-neutral-700">
                  AI 原始输出（格式标定调试）
                </summary>
                <p className="mt-1 rounded bg-neutral-100 p-2 text-neutral-600 text-xs whitespace-pre-wrap select-text">
                  {aiDebug}
                </p>
              </details>
            )}
          </div>
          {/* 底栏：复制 bar 不重复按钮——展开态 bar 已收起，翻译/图译/
              复制功能不得丢失（语言/切换/还原/关闭卡内已有同款不重复）。按钮
              行为与 bar 完全一致（复制截图含退出）；样式对齐 CaptureBar 配色 */}
          <div className="flex flex-wrap items-center gap-2 border-t border-neutral-200 px-3 py-2 text-xs">
            {loading && !aiOcrMode ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <button
                type="button"
                onClick={doTranslate}
                title="翻译"
                className="shrink-0 rounded px-2.5 py-1 font-medium text-neutral-700 hover:bg-neutral-100 hover:text-primary [cursor:pointer]"
              >
                译
              </button>
            )}
            <button
              type="button"
              onClick={runSystemOcr}
              title="识别文字（系统 OCR）"
              className="shrink-0 rounded p-1.5 text-neutral-600 hover:bg-neutral-100 hover:text-primary [cursor:pointer]"
            >
              {ocrLoading ? <Loader2 className="size-3.5 animate-spin" /> : <ScanText className="size-3.5" />}
            </button>
            <button
              type="button"
              onClick={startVisionOcr}
              title="AI 识别"
              className="shrink-0 rounded p-1.5 text-neutral-600 hover:bg-neutral-100 hover:text-primary [cursor:pointer]"
            >
              {aiOcrMode ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={speakResult}
              title="朗读（优先译文，无译文读原文）"
              className="shrink-0 rounded p-1.5 text-neutral-600 hover:bg-neutral-100 hover:text-primary [cursor:pointer]"
            >
              <Volume2 className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (ocrText) void invoke("clipboard_write", { text: ocrText }).catch(() => {});
              }}
              title="复制当前文字"
              className="shrink-0 rounded p-1.5 text-neutral-600 hover:bg-neutral-100 hover:text-primary [cursor:pointer]"
            >
              <TextSelect className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={copySnapshotAndHide}
              title="复制截图"
              className="shrink-0 rounded p-1.5 text-neutral-600 hover:bg-neutral-100 hover:text-primary [cursor:pointer]"
            >
              <Copy className="size-3.5" />
            </button>
            {speakHint && (
              <span
                className={
                  speakHint.kind === "error"
                    ? "truncate text-destructive text-xs"
                    : "truncate text-neutral-500 text-xs"
                }
              >
                {speakHint.text}
              </span>
            )}
            <span className="flex-1" />
            <button
              type="button"
              onClick={() =>
                void invoke("ocr_open_panel", {
                  text: ocrText,
                  actionId: "translate",
                  x: rect?.x ?? 0,
                  y: rect?.y ?? 0,
                }).catch(() => {})
              }
              title="在面板中打开"
              className="shrink-0 rounded p-1.5 text-neutral-600 hover:bg-neutral-100 hover:text-primary [cursor:pointer]"
            >
              <ArrowUpRight className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={hide}
              className="shrink-0 rounded px-2 py-1 text-neutral-500 hover:bg-neutral-100 [cursor:pointer]"
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
