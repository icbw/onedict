/**
 *  本地词典查词面板（划词动作面板内容区）——同时供主窗口词典 Tab 复用。
 * // from pickdict (MIT), adapted for Tauri —— DictionaryPanel.tsx / LookupPage 平移
 *
 * 两种形制（variant），折叠行为一致：每部词典一个折叠分区，每次查询结果就绪后
 * 重置折叠状态，**未命中词典默认折叠**（栏头标注「未收录」，pickdict LookupPage
 * 策略；iframe display:none 隐藏不丢加载状态）：
 * - card（主窗口词典 Tab）：rounded 边框卡片分区（pickdict LookupPage 形制）
 * - flat（划词动作面板，用户修订）：通栏无边框——词典标签行按钮承担
 *   折叠切换与区块分隔，iframe 铺满容器宽度（原「全高展开不折叠」决策被用户
 *   二轮修订：面板同样要折叠）
 *
 * 高度自适应：BOOT_SCRIPT 高度上报携带查询轮次 token，父页面丢弃旧文档残留上报
 * （跳词瞬间旧帧 resize 触发，会把高度锁死在历史最大值）；上报值为 html 盒实高
 * （offsetHeight，无视口下限）。event.source 匹配出发帧（沙箱 opaque origin 下
 * 父页面无法读 iframe DOM，一律 postMessage）。
 * entry:// 内链经 postMessage 回父页面重查；sound:// → dictionary_sound 取字节 →
 * speex wasm 解码（独立 webview 需各自 init，单例幂等）→ postMessage 回帧播放。
 * 空定义存根条目（MDX 有词头无内容）由 Rust 侧判 MISS，前端再兜底 trim 判定。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, Globe, Loader2, Volume2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { buildSrcdoc, isIpaOnlyText, type SayButtonSpec } from "../../services/dictFrame";
import { fetchSoundData, SoundMissingError } from "../../services/dictSound";
import {
  synthesizeWordData,
  ttsBeforeResource,
  wordChainOf,
} from "../../services/pronounce";
import type { SoundData } from "../../services/tts";
import { sayButtonsOf, type Accent, type VoiceScene } from "../../services/voiceRouter";
import { initSpxDecoder, isSpxDecoderReady } from "../../services/spxDecoder";
import {
  WEB_DICTS,
  webItemsFromDictItems,
  wordFromExternalLink,
} from "../../services/webdict";
import { toWebdictError } from "../../services/webdict/errors";
import speexCode from "../../vendor/speex/speex.min.js?raw";
import type { DictMeta, LookupResult } from "../../types/dictionary";
import type { DictItemPref, PrefsPayload, PronouncePrefs } from "../../types/prefs";
import AiDictSection from "./AiDictSection";

interface Frame {
  dictId: string;
  found: boolean;
  /** 已注入查询 token 的 srcdoc（高度上报据此识别归属轮次） */
  srcDoc: string | null;
}

/** 在线词典分区（webdict）。miss/error 均默认折叠；error 态带
 *  「在浏览器中打开」（FORBIDDEN 人工验证入口，报告 §8 头号风险兜底） */
interface WebFrame {
  dictId: string;
  found: boolean;
  state: "ok" | "miss" | "error";
  errMsg?: string;
  srcPage?: string;
  srcDoc: string | null;
}

/** iframe 高度上限（防异常上报撑爆布局） */
const FRAME_MAX_H = 12000;

/** 帧内发音锚点携带的朗读文本（空 = 父页回落查询词） */
function frameSpeakText(d: { text?: string }): string {
  return typeof d.text === "string" ? d.text.trim() : "";
}

/** 帧内发音锚点携带的口音提示（英 / 美发音按钮；其他值忽略） */
function frameAccent(d: { accent?: string }): Accent {
  return d.accent === "gb" || d.accent === "us" ? d.accent : "";
}

/** 展开中的 iframe 上限：每部命中词典一个沙箱 webview，
 *  超过上限只挂前 N 部 + 「展开其余」，防单页 10+ 帧卡顿（折叠已卸载） */
const MAX_FRAMES = 8;

/** 发音状态提示（info = 获取中，error = 失败；null = 完成清除） */
export interface SoundHint {
  text: string;
  kind: "info" | "error";
}

export default function DictionaryPanel({
  word,
  onWordChange,
  variant = "card",
  reloadKey = 0,
  onStatus,
}: {
  word: string;
  onWordChange: (w: string) => void;
  /** card = 边框卡片分区（主窗口）；flat = 通栏无边框（动作面板） */
  variant?: "card" | "flat";
  /** 变更时重列词典（词典根目录保存后由外层递增） */
  reloadKey?: number;
  /** 发音状态上抛（主窗口词典页统一到搜索行右侧临时提示位，不再挤词典布局）。
   *  不传时内部悬浮 pill 显示（划词动作面板），与「查询中」pill 同款不占布局 */
  onStatus?: (hint: SoundHint | null) => void;
}) {
  const [dicts, setDicts] = useState<DictMeta[] | null>(null);
  /** 词典列表错误（dictionary_list 失败 = 词典目录未配置/不可用）：null = 无错误。
   *  打包安装后 dev 探测失效，必须把失败显式上屏引导用户去设置页配置，禁止静默 */
  const [listError, setListError] = useState<string | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  /** 在线词典分区（本地结果之后流式上屏；null 段未用 pending 布尔） */
  const [webFrames, setWebFrames] = useState<WebFrame[]>([]);
  const [webPending, setWebPending] = useState(false);
  /** 统一显示序（设置页 dictItems 偏好序，含 web- 前缀在线条目；null = 无偏好，
   * 本地序 + 在线尾随）—— 在线词典与本地词典并列排序*/
  const [orderIds, setOrderIds] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  /** 各词典 iframe 自适应高度（onedict-height 上报 + token 门禁） */
  const [heights, setHeights] = useState<Record<string, number>>({});
  /** 手动折叠集（§6.0）：用户点栏头折叠 = **会话级意图**，
   *  跨跳词/前进/后退保持；手动展开即移出。进程退出组件卸载即清空（临时性） */
  const [manualCollapsed, setManualCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  /** 未命中自动折叠（§6.0 追加修复）：仅描述「当前词未收录」的即时反馈，
   *  每轮查询重算、**不跨轮持久**——拖选跳词产生的 miss 折叠在后退回原词时
   *  自动解除（原词命中，用户并未手动关闭）。渲染折叠 = manual ∪ autoMiss */
  const [autoMissCollapsed, setAutoMissCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  /** 展开其余词典（iframe 上限截断后的手动展开；新查询重置） */
  const [showAllDicts, setShowAllDicts] = useState(false);
  const [soundHint, setSoundHint] = useState<SoundHint | null>(null);
  /** 词典外链走向（偏好 webExternal）：true = 系统浏览器打开（默认），
   *  false = 转词典内部查词（wordFromExternalLink 提取词）。
   *  prefs-changed 广播驱动重读（设置页切换即时生效于主窗与面板） */
  const [webExternal, setWebExternal] = useState(true);
  /** 发音偏好（朗读源链 / 语音 / 语速；null = 未读到，帧内发音退回资源原路径） */
  const [pronounce, setPronounce] = useState<PronouncePrefs | null>(null);
  /** 例句朗读双按钮外观快照（srcdoc 注入初值；偏好变化另经消息刷新在挂帧） */
  const sayButtonsRef = useRef<SayButtonSpec[] | null>(null);
  /** 发音状态分流：传 onStatus 的宿主（词典页）统一显示；否则内部悬浮 pill */
  const reportSound = useCallback(
    (hint: SoundHint | null) => {
      if (onStatus) onStatus(hint);
      else setSoundHint(hint);
    },
    [onStatus],
  );
  const iframeRefs = useRef(new Map<string, HTMLIFrameElement>());
  /** 查询轮次（srcdoc token 与上报门禁共用） */
  const lookupSeq = useRef(0);

  /** speex wasm 就绪保障：挂载预热 + 取 .spx 前兜底重试（幂等）。
   *  面板是独立 webview，解码器单例按窗口各自 init；若只在挂载时预热一次，
   *  首载失败或前端热更新重建模块后 `mod` 会一直停在未就绪——此后每个 .spx
   *  都取不出来，而失败原因只进 devtools，用户侧表现为「本地发音点了却走合成音」。 */
  const ensureSpx = useCallback(async () => {
    if (isSpxDecoderReady()) return;
    await initSpxDecoder({
      code: speexCode,
      evaluate: (code) =>
        new Function(`${code}\n;return typeof SpeexFactory !== "undefined" ? SpeexFactory : undefined;`)(),
      logError: (m) => console.error(m),
    }).catch(() => {
      // 失败原因由 spxDecoder 记录，取数时随 SoundDecodeError 一并上屏
    });
  }, []);

  useEffect(() => {
    void ensureSpx();
  }, [ensureSpx]);

  /** 在线词典查询：engine 前端解析 + 消毒 + 分区拼装 → srcdoc（css 注入 + 外链放行）。
   *  单源失败降级为错误态行，不拖垮其它源（与本地词典同款容错）。
   *  声明在 lookupAll 之前（后者 useCallback 依赖数组引用本回调，避免 TDZ）。 */
  const lookupWeb = useCallback(async (items: DictItemPref[], target: string, seq: number) => {
    const results = await Promise.all(
      items.map(async (item): Promise<WebFrame> => {
        const def = WEB_DICTS[item.id];
        if (!def) return { dictId: item.id, found: false, state: "miss", srcDoc: null };
        try {
          const r = await def.search(target);
          return {
            dictId: item.id,
            found: true,
            state: "ok",
            srcDoc: buildSrcdoc(r.html, seq, {
              css: def.css,
              allowExternal: true,
              sayButtons: sayButtonsRef.current ?? undefined,
            }),
          };
        } catch (e) {
          const werr = toWebdictError(e);
          if (werr.type === "NO_RESULT") {
            return { dictId: item.id, found: false, state: "miss", srcDoc: null };
          }
          return {
            dictId: item.id,
            found: false,
            state: "error",
            errMsg: werr.type === "FORBIDDEN" ? "站点要求人工验证" : "网络错误或超时",
            srcPage: def.srcPage(target),
            srcDoc: null,
          };
        }
      }),
    );
    if (seq !== lookupSeq.current) return;
    setWebFrames(results);
    // 未命中/错误默认折叠（并入 autoMiss：本地先上屏时已完成autoMiss 重置）
    setAutoMissCollapsed((prev) => {
      const next = new Set(prev);
      results.filter((f) => !f.found).forEach((f) => next.add(f.dictId));
      return next;
    });
  }, []);

  const lookupAll = useCallback(async (list: DictMeta[], target: string) => {
    if (!target.trim()) {
      setFrames([]);
      setWebFrames([]);
      setWebPending(false);
      return;
    }
    const seq = ++lookupSeq.current;
    setLoading(true);
    try {
      const results = await Promise.all(
        list.map(async (d) => {
          // 单词典失败降级为「未收录」行，不拖垮整轮查询
          const r = await invoke<LookupResult>("dictionary_lookup", { dictId: d.id, word: target }).catch(
            () => null,
          );
          const html = r?.html ?? null;
          const found = html !== null && html.trim().length > 0;
          return {
            dictId: d.id,
            found,
            srcDoc: found
              ? buildSrcdoc(html, seq, { sayButtons: sayButtonsRef.current ?? undefined })
              : null,
          } as Frame;
        }),
      );
      if (seq !== lookupSeq.current) return; // 已有更新一轮查询，丢弃本轮结果
      setFrames(results);
      setHeights({}); // 新一轮查询重置帧高（等各 iframe 重新上报）
      setShowAllDicts(false); // 新一轮查询恢复 iframe 上限
      // 未命中自动折叠：每轮重算（§6.0 追加修复）——只描述miss，不污染
      // 手动折叠集。手动折叠的词典跨轮保持（见 manualCollapsed）
      setAutoMissCollapsed(new Set(results.filter((f) => !f.found).map((f) => f.dictId)));

      // ── 在线词典（webdict）：本地结果已上屏，随后流式补入 ──
      // 面板（flat，轻量场景）恒 fallback-only（调研报告 §9.3 建议）；主窗口按偏好
      const prefs = await invoke<PrefsPayload>("prefs_get").catch(() => null);
      if (seq !== lookupSeq.current) return;
      setOrderIds(prefs?.dictItems ? prefs.dictItems.map((i) => i.id) : null);
      const webItems = webItemsFromDictItems(prefs?.dictItems).filter((w) => w.enabled);
      const fallbackOnly = variant === "flat" ? true : (prefs?.webFallbackOnly ?? false);
      if (webItems.length === 0 || (fallbackOnly && results.some((f) => f.found))) {
        setWebFrames([]);
        setWebPending(false);
        return;
      }
      setWebPending(true);
      await lookupWeb(webItems, target, seq);
      if (seq === lookupSeq.current) setWebPending(false);
    } finally {
      if (seq === lookupSeq.current) setLoading(false);
    }
  }, [variant, lookupWeb]);

  useEffect(() => {
    let cancelled = false;
    invoke<DictMeta[]>("dictionary_list")
      .then((list) => {
        if (cancelled) return;
        setDicts(list);
        setListError(null);
      })
      .catch((e) => {
        if (!cancelled) setListError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // 词典外链走向偏好：挂载读取 + prefs-changed 广播重读（设置页切换即时生效；
  // 面板常挂载于 MainApp/PanelApp，监听不失聪）
  useEffect(() => {
    const load = () => {
      void invoke<PrefsPayload>("prefs_get")
        .then((p) => {
          setWebExternal(p.webExternal ?? true);
          setPronounce(p.pronounce ?? null);
        })
        .catch(() => {});
    };
    load();
    const unlisten = listen("prefs-changed", load);
    return () => {
      void unlisten.then((f) => f(), () => {});
    };
  }, []);

  /** 帧加载完成后补发按钮外观（广播可能早于帧脚本就绪而被丢弃） */
  const pushSayButtons = useCallback((el: HTMLIFrameElement | null) => {
    const buttons = sayButtonsRef.current;
    if (el?.contentWindow && buttons) {
      el.contentWindow.postMessage({ type: "onedict-say-buttons", buttons }, "*");
    }
  }, []);

  // 例句朗读按钮外观：偏好就绪 / 变化时刷新快照并向在挂帧广播（颜色与提示即时更新）
  useEffect(() => {
    if (!pronounce) return;
    const buttons = sayButtonsOf(pronounce).map(({ accent, gender }) => ({ accent, gender }));
    sayButtonsRef.current = buttons;
    for (const el of iframeRefs.current.values()) {
      el.contentWindow?.postMessage({ type: "onedict-say-buttons", buttons }, "*");
    }
  }, [pronounce]);

  useEffect(() => {
    // 仅查询启用的词典（词典管理；顺序 = 设置页拖拽序）
    if (dicts) void lookupAll(dicts.filter((d) => d.enabled), word);
  }, [dicts, word, lookupAll]);

  /** 帧内音频回帧播放（seq 原样带回，帧内单通道门禁照旧） */
  const sendFrameAudio = (dictId: string, seq: unknown, data: SoundData) => {
    iframeRefs.current
      .get(dictId)
      ?.contentWindow?.postMessage({ type: "onedict-sound-data", ...data, seq }, "*");
  };

  /**
   * 帧内发音请求：按朗读链决策后再取数——
   * ① 链中「合成源」排在资源源之前 → 直接合成（用户显式把合成拖到了前面）；
   * ② 否则按原路径取真人资源；
   * ③ 取资源失败且链含合成源 + 开启「无发音时自动用系统语音」→ 合成兜底，
   *    其中**词典没收录**（SoundMissingError）静默兜底，**有资源却取不出 / 解不开**
   *    属于故障，兜底时把原因一并上屏——静默换音源会让用户以为播的是本地真人音，
   *    真实原因也再无迹可循。
   * 音频一律回帧播放（帧内播放被拒 / 停滞经 onedict-sound-error 上屏）。
   */
  const handleFrameAudio = useCallback(
    async (
      dictId: string,
      seq: unknown,
      resource: "dict" | "webdict",
      load: () => Promise<SoundData>,
      speakText: string,
      accent: Accent,
    ) => {
      const prefs = pronounce;
      // 合成源 = Edge 在线自然语音 / 本地系统语音（任一在链中即具备兜底能力）
      const synthEnabled = prefs
        ? wordChainOf(prefs).some((s) => s === "edge" || s === "tts")
        : false;
      const synthFirst = prefs ? synthEnabled && ttsBeforeResource(prefs, resource) : false;
      const playTts = async (degraded?: string): Promise<boolean> => {
        if (!prefs) return false;
        try {
          reportSound({ text: "语音合成中…", kind: "info" });
          // 锚点带上下文文本（例句音频缺失时读例句，而非查询词）→ 场景随之切换；
          // 音标窗口（UK /teɪk/、美 [teɪk]）不是可读文本：按单词口径读查询词，
          // 否则词条发音按钮会被当成句子（读音标 + 走错场景设置）
          const query = word.trim();
          const snippet = speakText.trim();
          const isWordAnchor = !snippet || snippet === query || isIpaOnlyText(snippet);
          const target = isWordAnchor ? query : snippet;
          const scene: VoiceScene = isWordAnchor ? "word" : "sentence";
          const data = await synthesizeWordData(target, prefs, scene, accent);
          if (!data?.base64) return false;
          // 降级说明留在提示位（不清空）：用户才知道这次为什么不是本地真人音
          reportSound(degraded ? { text: degraded, kind: "info" } : null);
          sendFrameAudio(dictId, seq, data);
          return true;
        } catch (err) {
          reportSound({
            text: `系统语音失败（${err instanceof Error ? err.message : String(err)}）`,
            kind: "error",
          });
          return false;
        }
      };
      if (synthFirst && (await playTts())) return;
      try {
        reportSound({ text: "发音获取中…", kind: "info" });
        // .spx 需 wasm 解码：就绪保障放在取数前（未就绪 / 曾失败在此自愈重试）
        if (resource === "dict") await ensureSpx();
        const data = await load();
        reportSound(null);
        sendFrameAudio(dictId, seq, data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 降级只对「词典确实没收录这条真人音频」（SoundMissingError）静默；取数 / 解码
        // 故障要连同原因上屏——静默换合成会让用户以为播的是本地真人音，正是「发音优先级
        // 没生效」的观感来源（且真实原因再也看不到）
        const missing = err instanceof SoundMissingError;
        if (!synthFirst && synthEnabled && prefs?.fallbackMissing) {
          const ok = missing
            ? await playTts()
            : await playTts(`本地发音不可用（${msg}），已改用合成语音`);
          if (ok) return;
        }
        reportSound({ text: msg, kind: "error" });
      }
    },
    [pronounce, word, reportSound, ensureSpx],
  );

  /** 帧内例句朗读按钮（`say://`）：按「句子」场景 + 按钮槽合成 → 回帧播放
   *  （同音频通道；按钮 a / b 的音色由设置页「朗读按钮」分配） */
  const handleFrameSpeak = useCallback(
    async (dictId: string, seq: unknown, text: string, which: "a" | "b") => {
      const prefs = pronounce;
      if (!prefs) return;
      try {
        reportSound({ text: "语音合成中…", kind: "info" });
        const button = sayButtonsOf(prefs)[which === "b" ? 1 : 0];
        const data = await synthesizeWordData(text, prefs, "sentence", "", button);
        if (!data?.base64) throw new Error("没有可用的合成语音源（设置页「发音」中启用）");
        reportSound(null);
        sendFrameAudio(dictId, seq, data);
      } catch (err) {
        reportSound({ text: err instanceof Error ? err.message : String(err), kind: "error" });
      }
    },
    [pronounce, reportSound],
  );

  // iframe 消息：entry:// 重查 + 高度上报（token 门禁）+ sound:// 播放（event.source
  // 匹配出发帧）
  useEffect(() => {
    const findDictId = (source: MessageEventSource | null): string | null => {
      for (const [dictId, el] of iframeRefs.current) {
        if (el.contentWindow === source) return dictId;
      }
      return null;
    };
    const onMessage = (e: MessageEvent) => {
      const d = e.data as {
        type?: string;
        word?: string;
        via?: string;
        key?: string;
        url?: string;
        text?: string;
        h?: number;
        t?: number | null;
        /** 发音点击轮次（帧内登记，回传时原样带回：丢弃被后续点击取代的过期响应） */
        seq?: number;
        /** 口音提示（英 / 美发音按钮：'gb' / 'us'） */
        accent?: string;
        /** 例句朗读按钮位（a / b：两个并列按钮各自的音色槽） */
        which?: string;
        /** 帧内播放失败原因（音频管线停滞 / 自动播放被拒） */
        msg?: string;
      };
      if (d?.type === "onedict-entry" && typeof d.word === "string") {
        // source 校验（安全修复）：仅词典帧可驱动重查。同窗口其他 iframe
        //（如复习卡释义帧）发出的同型消息一律丢弃——词典 Tab keep-alive 常驻监听，
        // 无校验时复习卡帧内取词会静默改掉隐藏词典页的词头并重查
        if (!findDictId(e.source)) return;
        onWordChange(d.word.replace(/\/+$/, ""));
      } else if (d?.type === "onedict-word" && typeof d.word === "string") {
        // 帧内取词（词条内词索引）：与 entry:// 内链同路径重查（父层决定入导航栈）。
        // source 校验同上（复习卡帧不在词典帧注册表内，天然被拒——「卡面不查词」
        // 由此强制保证，不再依赖「无监听者」的巧合前提）。
        // via==="select" = 拖选词组查询（BOOT_SCRIPT 400ms 延迟后触发）——同源拖选
        // 会触发全局划词捕获（捕获链无自身窗口豁免），调 selection_hide_toolbar
        // 隐藏浮标 + 700ms 抑制窗压过 UIA 慢链路晚到的 show，防双重反应
        if (!findDictId(e.source)) return;
        if (d.via === "select") void invoke("selection_hide_toolbar").catch(() => {});
        if (d.word.trim()) onWordChange(d.word);
      } else if (d?.type === "onedict-height" && typeof d.h === "number" && d.h > 0) {
        // 旧文档残留上报（跳词瞬间视口 resize 触发）按轮次丢弃，防高度锁死
        if (d.t !== lookupSeq.current) return;
        for (const [dictId, el] of iframeRefs.current) {
          if (el.contentWindow === e.source) {
            const h = Math.min(d.h + 12, FRAME_MAX_H);
            setHeights((prev) => (prev[dictId] === h ? prev : { ...prev, [dictId]: h }));
            break;
          }
        }
      } else if (d?.type === "onedict-sound" && typeof d.key === "string") {
        const dictId = findDictId(e.source);
        const key = d.key; // 闭包内需局部常量（TS 不对可变属性跨闭包收窄）
        if (!dictId || !key) return;
        void handleFrameAudio(
          dictId,
          d.seq,
          "dict",
          () => fetchSoundData(dictId, key),
          frameSpeakText(d),
          frameAccent(d),
        );
      } else if (d?.type === "onedict-webaudio" && typeof d.url === "string") {
        // 在线词典发音：webdict_audio 下载（host 白名单在 Rust 校验）→ 同通道回播
        const dictId = findDictId(e.source);
        const url = d.url;
        if (!dictId || !url) return;
        void handleFrameAudio(
          dictId,
          d.seq,
          "webdict",
          async () => {
            const r = await invoke<SoundData>("webdict_audio", { url });
            if (!r.base64) throw new Error("发音资源下载失败");
            return r;
          },
          frameSpeakText(d),
          frameAccent(d),
        );
      } else if (d?.type === "onedict-speak" && typeof d.text === "string") {
        // 帧内例句朗读按钮：合成后回帧播放（单通道 + seq 门禁沿用音频通道）
        const dictId = findDictId(e.source);
        const sayText = d.text.trim();
        if (!dictId || !sayText) return;
        void handleFrameSpeak(dictId, d.seq, sayText, d.which === "b" ? "b" : "a");
      } else if (d?.type === "onedict-sound-error" && typeof d.msg === "string") {
        // 帧内起播失败（自动播放被拒 / 音频管线停滞）→ 上屏提示（此前静默丢弃，
        // 表现为「点了没声音也没反应」，无从判断）
        if (!findDictId(e.source)) return;
        reportSound({ text: d.msg, kind: "error" });
      } else if (d?.type === "onedict-external" && typeof d.url === "string") {
        // 在线源帧 http(s) 真外链 → 按偏好 webExternal 分流：
        // 开 = 系统浏览器；关 = 转词典内部查词（URL/链接文本提取词，提取不到忽略）。
        // source 校验（安全修复）+ 仅限在线源帧（web- 前缀）：本地词条帧
        // 保持 http 死链语义（设计而非缺陷），非词典帧不得驱动 open_external
        const srcDictId = findDictId(e.source);
        if (!srcDictId?.startsWith("web-")) return;
        if (webExternal) {
          void invoke("open_external", { url: d.url }).catch(() => {});
        } else {
          const w = wordFromExternalLink(d.url, typeof d.text === "string" ? d.text : undefined);
          if (w) onWordChange(w);
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onWordChange, reportSound, webExternal, handleFrameAudio, handleFrameSpeak]);

  /** 栏头点击：当前折叠态 = 手动 ∪ miss 自动。展开 = 双集合移出（对 miss
   *  自动折叠的手动展开视为「想看」，下一轮它再 miss 会重新自动折叠）；
   *  折叠 = 写入手动集（跨轮持久的用户意图） */
  const toggleDict = (dictId: string) => {
    const nowCollapsed =
      manualCollapsed.has(dictId) || autoMissCollapsed.has(dictId);
    if (nowCollapsed) {
      setManualCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(dictId);
        return next;
      });
      setAutoMissCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(dictId);
        return next;
      });
    } else {
      setManualCollapsed((prev) => new Set(prev).add(dictId));
    }
  };

  if (dicts === null) {
    return (
      <div className="flex flex-col gap-2.5">
        {listError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-3">
            <p className="text-destructive text-sm">词典不可用：{listError}</p>
            <p className="mt-1 text-muted-foreground text-xs">
              请到「设置 → 词典 → 词典目录」配置存放词典的文件夹（每个含 .mdx
              的子目录视为一部词典）。
            </p>
          </div>
        ) : (
          <div className="py-2 text-muted-foreground text-sm">加载中…</div>
        )}
      </div>
    );
  }

  const anyFound = frames.some((f) => f.found) || webFrames.some((f) => f.found);

  // ── 统一显示序（在线词典与本地词典并列排序）：
  // 设置页 dictItems 偏好序（含 web- 在线条目）优先；结果未就绪或偏好缺失的
  // 条目按「本地序 → 在线内置序」补尾，与设置页合并语义一致。
  const localMap = new Map(frames.map((f) => [f.dictId, f]));
  const webMap = new Map(webFrames.map((f) => [f.dictId, f]));
  const unified: Array<{ id: string; web: boolean }> = [];
  const seenIds = new Set<string>();
  for (const id of orderIds ?? []) {
    const web = id.startsWith("web-");
    if (!seenIds.has(id) && (web ? webMap : localMap).has(id)) {
      unified.push({ id, web });
      seenIds.add(id);
    }
  }
  for (const f of frames) {
    if (!seenIds.has(f.dictId)) {
      unified.push({ id: f.dictId, web: false });
      seenIds.add(f.dictId);
    }
  }
  for (const f of webFrames) {
    if (!seenIds.has(f.dictId)) {
      unified.push({ id: f.dictId, web: true });
      seenIds.add(f.dictId);
    }
  }

  //  渲染截断：按统一序累计命中分区，超过 MAX_FRAMES 后的行不渲染（未命中行
  // 便宜、随行渲染；截断边界 = 第 MAX_FRAMES+1 个命中行处）。展开按钮兜底。
  let cutoff = unified.length;
  if (!showAllDicts) {
    let foundCount = 0;
    for (let i = 0; i < unified.length; i++) {
      const item = unified[i];
      const found = item.web ? webMap.get(item.id)?.found : localMap.get(item.id)?.found;
      if (found) {
        foundCount += 1;
        if (foundCount > MAX_FRAMES) {
          cutoff = i;
          break;
        }
      }
    }
  }
  const visible = showAllDicts ? unified : unified.slice(0, cutoff);

  const renderLocalSection = (frame: Frame) => {
    const collapsed = manualCollapsed.has(frame.dictId) || autoMissCollapsed.has(frame.dictId);
    return (
      <div
        key={frame.dictId}
        className={cn(
          variant === "card" ? "overflow-hidden rounded-md border border-border" : "",
        )}
      >
        {/* 栏头 = 折叠切换（两种形制同款行为；flat 形态兼作区块分隔条）。
            单词发音入口只有词条内的发音锚点一处（真人音频优先、缺失时按链回退
            合成），栏头不再重复放按钮。 */}
        <div
          className={cn(
            "flex w-full items-center gap-1 text-muted-foreground text-xs",
            variant === "card" ? "bg-muted px-3 py-1" : "bg-muted/60 px-3 py-1",
          )}
        >
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={() => toggleDict(frame.dictId)}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
          >
            <ChevronDown
              className={cn("size-3 shrink-0 transition-transform", collapsed && "-rotate-90")}
            />
            <span className="flex-1 truncate">{frame.dictId}</span>
            {!frame.found && <span className="text-foreground-tertiary">未收录</span>}
          </button>
        </div>
        {frame.found ? (
          <div className="relative">
            {/*  折叠即卸载（原仅 hidden——帧内 ResizeObserver +
                mousemove hit-test 常驻是 N 部词典 N 份的开销）；srcDoc/found
                状态保留，重展开重挂并重新上报高度 */}
            {!collapsed && (
              <iframe
                title={frame.dictId}
                sandbox="allow-scripts"
                // allow="autoplay"：帧内发音走 new Audio(dataURL).play()，而沙箱帧是
                // opaque origin（对父页跨源）——Permissions Policy 的 autoplay 默认值为
                // self，缺这条则跨源子帧一律 NotAllowedError（上屏即「浏览器阻止了自动
                // 播放，请再点一次」，实际再点也没用）。进程级 --autoplay-policy 管的是
                // 用户手势检查，不覆盖这层权限策略。
                allow="autoplay"
                srcDoc={frame.srcDoc ?? undefined}
                ref={(el) => {
                  if (el) iframeRefs.current.set(frame.dictId, el);
                  else iframeRefs.current.delete(frame.dictId);
                }}
                onLoad={(e) => pushSayButtons(e.currentTarget)}
                className="block w-full border-0 bg-white"
                style={{
                  //高度兜底 420 → 0 + 骨架——新查询/新挂载未上报前的白尾与闪烁
                  height: heights[frame.dictId] ?? 0,
                }}
              />
            )}
            {!collapsed && heights[frame.dictId] === undefined && (
              <div className="absolute inset-x-0 top-0 h-24 animate-pulse bg-muted/50" />
            )}
          </div>
        ) : (
          !collapsed && (
            <div className="px-3 py-4 text-foreground-tertiary text-sm">该词未被此词典收录</div>
          )
        )}
      </div>
    );
  };

  const renderWebSection = (frame: WebFrame) => {
    const collapsed = manualCollapsed.has(frame.dictId) || autoMissCollapsed.has(frame.dictId);
    const label = WEB_DICTS[frame.dictId]?.label ?? frame.dictId;
    return (
      <div
        key={frame.dictId}
        className={cn(variant === "card" ? "overflow-hidden rounded-md border border-border" : "")}
      >
        <div
          className={cn(
            "flex w-full items-center gap-1 text-muted-foreground text-xs",
            variant === "card" ? "bg-muted px-3 py-1" : "bg-muted/60 px-3 py-1",
          )}
        >
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={() => toggleDict(frame.dictId)}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
          >
            <ChevronDown
              className={cn("size-3 shrink-0 transition-transform", collapsed && "-rotate-90")}
            />
            <Globe className="size-3 shrink-0" />
            <span className="flex-1 truncate">{label}</span>
            {!frame.found && (
              <span className="text-foreground-tertiary">
                {frame.state === "error" ? "查询失败" : "未收录"}
              </span>
            )}
          </button>
        </div>
        {frame.found ? (
          <div className="relative">
            {!collapsed && (
              <iframe
                title={frame.dictId}
                sandbox="allow-scripts"
                // allow="autoplay"：在线源帧同样在帧内播放回传音频（音频锚点 / 合成），
                // 缺这条跨源沙箱帧一律被权限策略拒（同本地帧注释）
                allow="autoplay"
                srcDoc={frame.srcDoc ?? undefined}
                ref={(el) => {
                  if (el) iframeRefs.current.set(frame.dictId, el);
                  else iframeRefs.current.delete(frame.dictId);
                }}
                onLoad={(e) => pushSayButtons(e.currentTarget)}
                className="block w-full border-0 bg-white"
                style={{
                  height: heights[frame.dictId] ?? 0,
                }}
              />
            )}
            {!collapsed && heights[frame.dictId] === undefined && (
              <div className="absolute inset-x-0 top-0 h-24 animate-pulse bg-muted/50" />
            )}
          </div>
        ) : frame.state === "error" ? (
          !collapsed && (
            <div className="flex flex-wrap items-center gap-2 px-3 py-3 text-foreground-tertiary text-sm">
              <span>{frame.errMsg}</span>
              {frame.srcPage && (
                <button
                  type="button"
                  onClick={() =>
                    void invoke("open_external", { url: frame.srcPage }).catch(() => {})
                  }
                  className="cursor-pointer border-0 bg-transparent p-0 text-xs text-blue-600 hover:underline"
                >
                  在浏览器中打开 ↗
                </button>
              )}
            </div>
          )
        ) : (
          !collapsed && (
            <div className="px-3 py-4 text-foreground-tertiary text-sm">该词未被此词典收录</div>
          )
        )}
      </div>
    );
  };

  // 查询中指示（本地/在线两态互斥切换）：右上角悬浮 pill——absolute 不占布局，
  // 出现/消失不推挤下方分区（实测：流内提示行导致整列下移抖动）。
  // 发音状态 pill 同位堆叠（onStatus 宿主上抛后不在内部显示）——发音提示也从流内
  // 挪到悬浮（实测：解码中/失败提示同样挤压词典布局）
  const pendingLabel = loading ? "查询中…" : webPending ? "在线词典查询中…" : null;
  const internalSoundHint = onStatus ? null : soundHint;

  return (
    <div className={cn("relative flex flex-col", variant === "card" ? "gap-3" : "gap-2")}>
      {(pendingLabel || internalSoundHint) && (
        <div className="pointer-events-none absolute top-0 right-0 z-10 flex flex-col items-end gap-1">
          {pendingLabel && (
            <div className="flex items-center gap-1 rounded-full border border-border bg-muted/90 px-2 py-0.5 text-muted-foreground text-xs shadow-sm">
              <Loader2 className="size-3 animate-spin" />
              {pendingLabel}
            </div>
          )}
          {internalSoundHint && (
            <div
              className={cn(
                "flex items-center gap-1 rounded-full border border-border bg-muted/90 px-2 py-0.5 text-xs shadow-sm",
                internalSoundHint.kind === "error" ? "text-destructive" : "text-amber-600",
              )}
            >
              <Volume2 className="size-3" />
              {internalSoundHint.text}
            </div>
          )}
        </div>
      )}
      {dicts.length === 0 && (
        <div
          className={cn(
            "text-sm",
            variant === "card"
              ? "rounded-md border border-border bg-muted px-3 py-4"
              : "my-2 rounded-md bg-muted px-3 py-4",
          )}
        >
          未找到词典——请到「设置 → 词典 → 词典目录」配置存放词典的文件夹（每个含
          .mdx 的子目录视为一部词典）。
        </div>
      )}
      {/* ── 统一分区流（本地 + 在线并列按设置页排序；在线分区本地已上屏后流式补入；
          命中超过 MAX_FRAMES 截断 + 展开按钮） ── */}
      {visible.map((item) =>
        item.web ? renderWebSection(webMap.get(item.id)!) : renderLocalSection(localMap.get(item.id)!),
      )}
      {!showAllDicts && cutoff < unified.length && (
        <button
          type="button"
          onClick={() => setShowAllDicts(true)}
          className="cursor-pointer rounded-md border border-border bg-muted px-3 py-1.5 text-muted-foreground text-xs transition-colors hover:bg-accent"
        >
          展开其余 {unified.length - cutoff} 部词典
        </button>
      )}
      {dicts.length > 0 && !loading && !webPending && !anyFound && frames.length > 0 && (
        <div className={cn("text-foreground-tertiary text-sm", variant === "flat" && "px-3 py-2")}>
          「{word}」在所有词典中均未命中
        </div>
      )}
      {/*  AI 词典：在线词典形态（本地词典之后；未配置/关闭时不渲染） */}
      <AiDictSection word={word} variant={variant} />
    </div>
  );
}
