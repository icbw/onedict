/**
 *  设置页：左侧子导航 + 子设置页（用户修订：单页滚动不利于扩展，拆分为模型
 * 服务 / 划词助手 / 词典，默认首页 = 模型服务）。
 * - 模型服务（AI）：provider 预设卡片（OpenAI/DeepSeek/火山引擎/阿里云百炼/
 *   OpenCode Go/自定义）→ **弹出设置窗口**（端点预填 + Key + 默认模型；预设+弹窗
 *   为通用编辑范式，AGPL 仓库仅只读参考未复制）+ 测试连接
 *   （/models 速选）+ 非思考开关。
 * - 划词助手：划词开关 / 剪贴板兜底 / 紧凑模式（浮标只显示图标，pickdict
 *   feature.selection.compact 语义）；划词栏动作列表 **@hello-pangea/dnd 整行拖拽**
 *   （cherry/pickdict 同款库；整行可拖无把手）；自定义 AI 动作增删改 + 内置 AI 动作
 *   编辑弹窗（图标/模型/提示词覆盖）+ 搜索引擎编辑弹窗（pickdict 同构：预设 + 自定义）。
 * - 词典：目录 + 拖拽排序 + 启停（dnd-kit）；**AI 词典组**（启用/系统提示词，
 *   用户修订自模型服务页移入）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { BookOpenText, Check, ChevronDown, ChevronRight, Dices, ExternalLink, Globe, Keyboard, OctagonX, Pencil, Plus, RotateCcw, Settings2, Trash2, X } from "lucide-react";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import ToolbarPill from "../components/ToolbarPill";
import { Button } from "@onedict/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onedict/ui/components/dialog";
import { Input } from "@onedict/ui/components/input";
import { Textarea } from "@onedict/ui/components/textarea";
import { Switch } from "@onedict/ui/components/switch";
import { Tooltip } from "@onedict/ui/components/tooltip";
import {
  SettingDescription,
  SettingGroup,
  SettingRow,
  SettingRowTitle,
  SettingTitle,
  SettingsContentColumn,
} from "../components/SettingsPrimitives";
import { ActionIcon, isValidIconName } from "../components/ActionIcon";
import { ProviderLogo } from "../components/ProviderLogo";
import {
  aiReady,
  builtinIconName,
  resolveActions,
  type ActionPref,
  type ResolvedAction,
} from "../lib/actions";
import {
  activeModels,
  activeProvider,
  dictRouteCard,
  modelThinking,
  splitDictModel,
} from "../lib/aiConfig";
import { builtinPrompt } from "../lib/actionPrompts";
import { targetLangByCode, sourceLangCompat } from "../lib/translate";
import LangSelect from "../components/LangSelect";
import CaptureBar from "../components/CaptureBar";
import { PROVIDER_PRESETS, providerPresetById, type ProviderPreset } from "../lib/aiProviders";
import {
  comboFromEvent,
  DEFAULT_HOTKEY_OCR_LOOKUP,
  DEFAULT_HOTKEY_SHOW_MAIN,
  DEFAULT_HOTKEY_TOGGLE,
  formatHotkey,
  isModifierCode,
  typingRiskWarning,
} from "../lib/hotkeys";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { cn } from "../lib/utils";
import { WEB_DICTS, webItemsFromDictItems } from "../services/webdict";
import { DEFAULT_AI_DICT_PROMPT } from "./panel/AiDictSection";
import AboutSection from "./panel/AboutSection";
import { useUpdateAvailable } from "../lib/useUpdateAvailable";
import type { AiPrefs, ApiType, DictItemPref, ModelCapability, ModelEntry, PrefsPayload, ProviderConfig } from "../types/prefs";
import type { DictMeta } from "../types/dictionary";

type Section = "models" | "selection" | "capture" | "dictionary" | "hotkeys" | "data" | "general" | "about";

const SECTIONS: Array<{ value: Section; label: string }> = [
  { value: "models", label: "模型服务" },
  { value: "selection", label: "划词助手" },
  { value: "capture", label: "截图助手" },
  { value: "dictionary", label: "词典" },
  { value: "hotkeys", label: "快捷键" },
  { value: "data", label: "数据" },
  // 通用殿后：默认落点（模型服务）不变；环境级开关与侧栏底部的版本/日志区相邻
  { value: "general", label: "通用" },
  { value: "about", label: "关于" },
];

/** API 协议类型选项（值对齐 cherry ENDPOINT_TYPE 聊天三形态；顺序 = 默认优先）。
 *  弹窗解释标签纵向过长——协议名自明，不再配说明文字。 */
const API_TYPE_OPTIONS: Array<{ value: ApiType; label: string }> = [
  { value: "openai-chat-completions", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
];

/** 自定义动作的默认提示词（= 默认行为：{{text}} 纯文本直发；预填可见可改，
 *  与默认相同视为未覆盖不落盘——对齐内置动作与 AI 词典的预填语义） */
const CUSTOM_DEFAULT_PROMPT = "{{text}}";

/** 读取当前 AI 配置（null = 未配置） */
async function fetchAi(): Promise<AiPrefs | null> {
  const p = await invoke<PrefsPayload>("prefs_get");
  return p.ai;
}

/** 以 patch 方式保存 AI 配置（读全量 → 合并 → 落盘；ai-changed 由 Rust 广播） */
async function patchAi(patch: Partial<AiPrefs>): Promise<AiPrefs> {
  const merged: AiPrefs = {
    provider: null,
    model: null,
    dictEnabled: true,
    dictPrompt: null,
    dictAllowThink: false,
    dictModel: null,
    providers: [],
    ...(await fetchAi()),
    ...patch,
  };
  await invoke("prefs_set_ai", { ai: merged });
  return merged;
}

/** 列表项移动（拖拽排序共用；dnd-kit arrayMove 的零依赖替代） */
function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** invoke 超时竞速：Tauri invoke 无内置超时——后端重启窗口期（tauri dev 重编译
 *  替换进程）或异常挂起时 promise 永不落定，busy 永卡「保存中…」（
 *  模型卡保存卡死实测）。超时按错误落定，调用方 catch 复位 busy 可重试。 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(
        () =>
          rej(
            new Error(
              `${label}超时（${Math.round(ms / 1000)}s）——若刚更新过程序请重启后重试`,
            ),
          ),
        ms,
      ),
    ),
  ]);
}

export default function SettingsTab({ active = true }: { active?: boolean }) {
  const [section, setSection] = useState<Section>("models");
  const [appVersion, setAppVersion] = useState("");
  // 启动检查命中（或本次会话已检出）时在「关于」项上标点；进过关于页即收起
  const updateAvailable = useUpdateAvailable();
  const [aboutSeen, setAboutSeen] = useState(false);
  // 偏好变更节拍（收尾实测修复）：prefs-changed 监听上提到常挂载的外壳。
  // 子页是条件渲染，SelectionSection 只在激活时挂载、自身监听不活——托盘/快捷键
  // 改划词开关时子页会错过事件，切回子页才看到新状态（实测坑）。tick 下发驱动
  // 子页重读；未挂载的子页重挂载时本就 load 最新，无需处理。
  const [prefsTick, setPrefsTick] = useState(0);

  useEffect(() => {
    void getVersion().then(setAppVersion).catch(() => {});
    const unPrefs = listen("prefs-changed", () => setPrefsTick((t) => t + 1));
    return () => {
      void unPrefs.then((f) => f(), () => {});
    };
  }, []);

  useEffect(() => {
    if (section === "about") setAboutSeen(true);
  }, [section]);

  return (
    <div className="flex h-full min-h-0">
      {/* 子导航：左侧文字导航列表（通用设置页范式） */}
      <aside className="flex w-44 shrink-0 flex-col border-r border-border px-3 py-4">
        <div className="flex flex-col gap-1">
          {SECTIONS.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setSection(s.value)}
              className={cn(
                "w-full cursor-pointer rounded-md px-3 py-1.5 text-left text-sm transition-colors",
                section === s.value
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {s.label}
              {s.value === "about" && updateAvailable && !aboutSeen && (
                <span className="ml-1.5 inline-block size-1.5 rounded-full bg-primary align-middle" />
              )}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {/* 应用级操作：打开日志目录（收尾；固定 app_data_dir/logs，Rust 侧
            不收路径参数无注入面） */}
        <button
          type="button"
          onClick={() => void invoke("open_logs_dir").catch(() => {})}
          className="mb-2 w-full cursor-pointer rounded-md px-3 py-1.5 text-left text-muted-foreground text-xs transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          打开日志目录
        </button>
        <Tooltip content="查看版本与更新" placement="top-start">
          <button
            type="button"
            onClick={() => setSection("about")}
            className="w-full cursor-pointer rounded-md px-3 py-1.5 text-left text-muted-foreground text-xs transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            onedict{appVersion ? ` v${appVersion}` : ""}
          </button>
        </Tooltip>
      </aside>

      {/* 子页内容 */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {section === "models" && <ModelsSection active={active} />}
        {section === "selection" && <SelectionSection prefsTick={prefsTick} />}
        {section === "capture" && <CaptureSection />}
        {section === "dictionary" && <DictionarySection />}
        {section === "hotkeys" && <HotkeysSection prefsTick={prefsTick} />}
        {section === "data" && <DataSection />}
        {section === "general" && <GeneralSection />}
        {section === "about" && <AboutSection />}
      </div>
    </div>
  );
}

/** 开机启动状态（对应 Rust `autostart::AutostartStatus`）：supported = false 时开关置灰，
 *  原因见 reason（便携模式不注册） */
interface AutostartStatus {
  enabled: boolean;
  supported: boolean;
  reason: string;
}

/** 通用（环境级行为）。开机启动即改即存，状态回读以注册表实测为准——注册表是自启状态的
 *  唯一事实源（不落偏好：偏好会随备份恢复到新机，注册表不会，双写即成幽灵态）。
 *  开关含义只在 hover 说一句，组内不再重复（组描述与 hover 同义即冗余）。 */
function GeneralSection() {
  const [status, setStatus] = useState<AutostartStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    void invoke<AutostartStatus>("autostart_status")
      .then(setStatus)
      .catch((e) => setErr(String(e)));
  }, []);

  const toggle = (next: boolean) => {
    setBusy(true);
    setErr("");
    void invoke<AutostartStatus>("autostart_set", { enabled: next })
      .then(setStatus)
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <SettingsContentColumn>
      <SettingGroup>
        <SettingTitle>启动</SettingTitle>
        <SettingRow className="mt-3">
          <SettingRowTitle>开机启动</SettingRowTitle>
          <Tooltip
            content={
              status?.supported === false
                ? status.reason
                : "登录 Windows 后自动启动 onedict"
            }
            placement="top"
          >
            <Switch
              checked={status?.enabled ?? false}
              disabled={status === null || !status.supported || busy}
              onCheckedChange={toggle}
            />
          </Tooltip>
        </SettingRow>
        {err && <p className="mt-2 text-destructive text-xs">{err}</p>}
      </SettingGroup>
    </SettingsContentColumn>
  );
}

/** 截图助手（二期独立 tab，自划词助手页迁入）：
 *  工具条预览（与覆盖层共用 CaptureBar——所见即所得，新增按钮自动同步出现，
 *  与划词助手 ToolbarPill 预览同一模式；预览可点按体验行为、不执行实际动作）+
 *  翻译语言默认值（源提示 ocrLang / 目标 ocrTargetLang——**浮层内选择为会话级
 *  临时，此处是唯一默认入口**）。 */
function CaptureSection() {
  const [ocrLang, setOcrLang] = useState("");
  const [ocrTarget, setOcrTarget] = useState("auto");
  const [ai, setAi] = useState<AiPrefs | null>(null);
  const [visionModel, setVisionModel] = useState("");
  const [autoRecognize, setAutoRecognize] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // 预览交互态：切换译文/原文按钮可点按体验（不落任何状态）
  const [previewOverlay, setPreviewOverlay] = useState(true);

  useEffect(() => {
    void invoke<PrefsPayload>("prefs_get")
      .then((p) => {
        setOcrLang(sourceLangCompat(p.ocrLang));
        setOcrTarget(p.ocrTargetLang || "auto");
        setAi(p.ai);
        setVisionModel(p.ocrVisionModel || "");
        setAutoRecognize(Boolean(p.ocrAutoRecognize));
        setLoaded(true);
      })
      .catch(() => {});
  }, []);

  /** 截图后自动识别开关（即改即存； 默认 false =
   *  只截屏钉原位，工具条「识别文字」按钮手动触发） */
  const saveAutoRecognize = (v: boolean) => {
    setAutoRecognize(v);
    void invoke("prefs_set_ocr_auto_recognize", { value: v }).catch(() => {});
  };

  /** 图译模型可选卡（有端点 + 有模型列表），同全局默认模型下拉的分组样式 */
  const visionCards = (ai?.providers ?? []).filter(
    (c) => c.models.length > 0 && c.endpoint.trim(),
  );

  return (
    <SettingsContentColumn>
      <SettingGroup>
        <SettingTitle>截图工具条</SettingTitle>
        <SettingDescription>
          快捷键框选屏幕区域（图片、视频、扫描件等不可选中文字；默认 Ctrl+Alt+O，在「快捷键」页修改）→
          截图钉在原位；默认不自动识别，点工具条「识别文字」（或「AI 识别」）提取文字，
          识别后原文按行叠加、可直接选中复制；点「译」按目标语言翻译，译文逐行替换原文。
          工具条预览（与截图时一致）：
        </SettingDescription>
        <div className="my-3 flex justify-center overflow-x-auto rounded-md py-3">
          <CaptureBar
            targetValue=""
            defaultTarget=""
            loading={false}
            showOverlay={previewOverlay}
            onTargetChange={() => {}}
            onResetTarget={() => {}}
            onTranslate={() => {}}
            onVisionTranslate={() => {}}
            onSystemOcr={() => {}}
            onCopySource={() => {}}
            onToggleOverlay={() => setPreviewOverlay((v) => !v)}
            onCopySnapshot={() => {}}
            onExpand={() => {}}
            onClose={() => {}}
          />
        </div>
        <SettingRow className="my-3">
          <div className="min-w-0 flex-1">
            <SettingRowTitle>截图后自动识别</SettingRowTitle>
            <SettingDescription>
              开启后恢复拖框即自动识别的原行为；默认关闭，识别由工具条按钮手动触发。
            </SettingDescription>
          </div>
          <Switch checked={autoRecognize} onCheckedChange={saveAutoRecognize} />
        </SettingRow>
        <p className="text-muted-foreground text-xs">
          预览可点按体验按钮行为（不执行实际动作）。自动 = 自动检测源语言并译为中文；
          「识别文字」= 系统 OCR 对当前截图识别；「复制当前文字」复制识别出的全部文字；
          展开查看逐行译文详情。
        </p>
      </SettingGroup>

      <SettingGroup>
        <SettingTitle>翻译语言默认值</SettingTitle>
        <SettingDescription>
          浮层内的语言选择只对本次截图生效，此处为每次截图的初始默认。
        </SettingDescription>
        <div className="mt-3 flex flex-col gap-3">
          {loaded ? (
            <>
              <SettingRow>
                <SettingRowTitle>源语言提示</SettingRowTitle>
                <LangSelect
                  value={ocrLang}
                  auto="自动"
                  onChange={(code) => {
                    setOcrLang(code);
                    void invoke("prefs_set_ocr_lang", { lang: code }).catch(() => {});
                  }}
                  title="仅作为翻译提示告知 AI 原文语言（防误判相似语言）；OCR 识别语言自动判断"
                  className="h-7 w-44 justify-between rounded-md border border-border bg-background px-2 text-xs"
                />
              </SettingRow>
              <SettingRow>
                <SettingRowTitle>翻译目标</SettingRowTitle>
                <LangSelect
                  value={ocrTarget === "auto" ? "" : ocrTarget}
                  auto="自动（译为中文）"
                  onChange={(code) => {
                    const v = code || "auto";
                    setOcrTarget(v);
                    void invoke("prefs_set_ocr_target_lang", { lang: v }).catch(() => {});
                  }}
                  className="h-7 w-44 justify-between rounded-md border border-border bg-background px-2 text-xs"
                />
              </SettingRow>
              <SettingRow>
                <div className="min-w-0 flex-1">
                  <SettingRowTitle>AI 图译模型</SettingRowTitle>
                  <SettingDescription>
                    本地识别失败或手写/复杂版面时，快照直发该视觉模型识别+翻译（走模型计费）。
                  </SettingDescription>
                </div>
                <select
                  tabIndex={-1}
                  value={visionModel}
                  onChange={(e) => {
                    setVisionModel(e.target.value);
                    void invoke("prefs_set_ocr_vision_model", { value: e.target.value }).catch(() => {});
                  }}
                  className="h-7 w-44 cursor-pointer rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-primary/40"
                >
                  <option value="">未设置（图译不可用）</option>
                  {visionCards.map((card) => (
                    <optgroup key={card.id} label={providerPresetById(card.id)?.name ?? card.id}>
                      {card.models.map((e) => (
                        <option key={`${card.id}:${e.id}`} value={`${card.id}:${e.id}`} title={`${e.id}`}>
                          {e.id}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </SettingRow>
            </>
          ) : (
            <div className="py-2 text-muted-foreground text-xs">加载中…</div>
          )}
          <p className="text-muted-foreground text-xs">
            识别语言自动判断（中文优先，无需配置）。源语言提示仅告知 AI 原文语言，
            用于纠正相似语言的误判。翻译目标独立于「翻译」页。图译模型建议选支持视觉的
            小模型（如 qwen3-vl-flash）。
          </p>
        </div>
      </SettingGroup>
    </SettingsContentColumn>
  );
}

/** 模型服务（默认首页）：模型卡（provider 预设 → 弹出设置窗口）+ 全局默认模型。
 *  精简：去提示文案/测试连接按钮——连通性验证在卡弹窗内
 *  （检测 Key/拉取列表），默认模型语义经 hover 提示自明。 */
function ModelsSection({ active = true }: { active?: boolean }) {
  const [ai, setAi] = useState<AiPrefs | null>(null);
  const [editing, setEditing] = useState<ProviderPreset | null>(null);
  /** 首帧偏好加载完成（用户实测：启动即点模型卡弹窗读到空 ai 显示
   *  未配置，切 tab 才加载——网格在就绪前渲染占位，杜绝过早打开弹窗） */
  const [loaded, setLoaded] = useState(false);
  /** 首载失败重试标记（最多一次；重试仍失败按「未配置」呈现） */
  const retriedRef = useRef(false);

  const load = useCallback(() => {
    void fetchAi()
      .then((a) => {
        setAi(a);
        setLoaded(true);
      })
      .catch(() => {
        // 0.1.5 实机验证：keep-alive 常挂载下启动期首载偶发失败被旧实现
        // `.catch(() => {})` 吞掉 → ai=null 化石态（网格/弹窗全按「未配置」
        // 呈现，直到切子页重挂载）。保持「加载中」占位，500ms 后静默重试一次。
        if (retriedRef.current) {
          setLoaded(true);
          return;
        }
        retriedRef.current = true;
        setTimeout(load, 500);
      });
  }, []);

  useEffect(() => {
    load();
    const un = listen("ai-changed", load);
    return () => {
      void un.then((f) => f(), () => {});
    };
  }, [load]);

  /** 主窗 tab 激活自愈：keep-alive 挂载下启动期首载若定格为空 ai（失败/竞态
   *  化石态），进入设置页时补拉一次。仅「已加载完成为空」才触发——正常态与
   *  全新安装（ai 本就为 null）只多一次轻量 invoke，无副作用。 */
  useEffect(() => {
    if (active && loaded && !ai) load();
  }, [active, loaded, ai, load]);

  // 默认模型跨卡下拉（跨卡重名模型需后缀卡名区分）：
  // 合并所有已配置卡的模型列表，按卡分组；选中即把该卡设为激活（模型绑定卡路由）
  const defaultModelCards = (ai?.providers ?? []).filter(
    (c) => c.models.length > 0 && c.endpoint.trim(),
  );
  const defaultModelValue = ai?.provider && ai?.model ? `${ai.provider}:${ai.model}` : "";

  const changeDefaultModel = (value: string) => {
    if (!value) return;
    const i = value.indexOf(":");
    const provider = value.slice(0, i);
    const model = value.slice(i + 1);
    void patchAi({ provider, model }).then(setAi);
  };

  return (
    <SettingsContentColumn>
      <SettingGroup>
        <SettingTitle>模型服务</SettingTitle>
        <SettingDescription>
          点击模型卡配置端点与 API Key，「保存并启用」后此卡生效。
        </SettingDescription>
        {!loaded ? (
          <div className="mt-3 rounded-md border border-border bg-background px-3 py-6 text-center text-muted-foreground text-xs">
            偏好加载中…
          </div>
        ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {PROVIDER_PRESETS.map((p) => {
            const card = ai?.providers.find((c) => c.id === p.id);
            const configured = !!card && card.endpoint.trim().length > 0;
            return (
              <Tooltip
                key={p.id}
                content={configured ? "已配置，点击编辑" : "点击配置端点与 API Key"}
                placement="top"
              >
                <button
                  type="button"
                  onClick={() => setEditing(p)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-left transition-colors hover:bg-accent/60"
                >
                  <ProviderLogo providerId={p.id} size={24} />
                  <span className="min-w-0 truncate text-foreground text-sm">{p.name}</span>
                  {configured && (
                    <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-[10px]">
                      已配置
                    </span>
                  )}
                </button>
              </Tooltip>
            );
          })}
        </div>
        )}
        <div className="mt-4 flex items-center gap-2">
          <SettingRowTitle className="shrink-0">默认模型</SettingRowTitle>
          {/* 即时 Tooltip（原生 title 有 ~0.5s 延迟）；短文案单行不抢眼 */}
          <Tooltip content="划词AI动作、AI词典与翻译页的默认模型" placement="bottom">
            <select
              value={defaultModelValue}
              onChange={(e) => changeDefaultModel(e.target.value)}
              disabled={defaultModelCards.length === 0}
              className="h-7 min-w-0 flex-1 cursor-pointer rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">
                {defaultModelCards.length
                  ? "未设置——从下方列表选择（模型 · 卡名）"
                  : "先配置模型卡并拉取模型列表"}
              </option>
              {defaultModelCards.map((card) => {
                const cardName = providerPresetById(card.id)?.name ?? card.id;
                return (
                  <optgroup key={card.id} label={cardName}>
                    {card.models.map((e) => (
                      <option key={`${card.id}:${e.id}`} value={`${card.id}:${e.id}`} title={`${e.id} · ${cardName}`}>
                        {e.id} · {cardName}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </Tooltip>
        </div>
      </SettingGroup>

      <ProviderDialog
        preset={editing}
        ai={ai}
        onClose={() => setEditing(null)}
        onSaved={(next) => {
          setAi(next);
          setEditing(null);
        }}
      />
    </SettingsContentColumn>
  );
}

/** 编辑目标：自定义动作（全字段）/ 内置 AI 动作（图标/模型/提示词覆盖）/ 搜索引擎 */
type EditTarget =
  | { kind: "custom"; item: ActionPref }
  | { kind: "builtin-ai"; item: ActionPref }
  | { kind: "search"; item: ActionPref };

/** 划词助手：开关 / 兜底 / 紧凑模式 + 动作列表（hello-pangea/dnd 整行拖拽）+
 *  自定义动作增删改 + 内置 AI 动作与搜索引擎编辑弹窗。
 *  prefsTick：外壳的 prefs-changed 节拍（子页条件渲染期间自身监听可能未挂，
 *  由常挂载外壳代收后经 tick 驱动本组件重读偏好——托盘/快捷键改开关即时同步）。 */
function SelectionSection({ prefsTick = 0 }: { prefsTick?: number }) {
  const [enabled, setEnabled] = useState(true);
  const [clipboardFallback, setClipboardFallback] = useState(true);
  const [clipboardLookup, setClipboardLookup] = useState(false);
  const [compact, setCompact] = useState(false);
  const [actionPrefs, setActionPrefs] = useState<ActionPref[] | null>(null);
  const [aiOk, setAiOk] = useState(false);
  //触发方式 + 进程过滤（filterListText = textarea 原始文本，blur 提交归一）
  const [selectionTrigger, setSelectionTrigger] = useState<"selected" | "ctrlkey" | "shortcut">("selected");
  const [filterMode, setFilterMode] = useState<"default" | "whitelist" | "blacklist">("default");
  const [filterListText, setFilterListText] = useState("");
  const [hotkeyBound, setHotkeyBound] = useState(false);
  /** 首次偏好读取完成（子页条件渲染挂载，首帧前不渲染开关——防止「默认值 → 实际值」
   *  的视觉闪跳 已关闭的开关每次切页都显示从开到关） */
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<EditTarget | null>(null);

  useEffect(() => {
    const load = () => {
      void invoke<PrefsPayload>("prefs_get")
        .then((p) => {
          setEnabled(p.selectionEnabled);
          setClipboardFallback(p.clipboardFallback);
          setClipboardLookup(p.clipboardLookup);
          setCompact(p.toolbarCompact);
          setActionPrefs(p.actionItems);
          setAiOk(aiReady(p.ai));
          setSelectionTrigger(p.selectionTrigger || "selected");
          setFilterMode(p.selectionFilterMode || "default");
          setFilterListText((p.selectionFilterList || []).join("\n"));
          setHotkeyBound(Boolean(p.hotkeys?.triggerLookup));
          setLoaded(true);
        })
        .catch(() => {});
    };
    load();
    // prefs-changed（动作/紧凑模式/划词开关）与 ai-changed（AI 门禁）都驱动重载；
    // prefsTick 变化（外壳代收事件）同样重读
    const unPrefs = listen("prefs-changed", load);
    const unAi = listen("ai-changed", load);
    // 划词开关直推通道（托盘/快捷键路径，Rust 携带新状态广播）：不经 prefs 往返
    // 即时对齐开关 UI——prefs-changed 间链条路之外的确定性保险
    const unSelEnabled = listen<boolean>("selection://enabled-changed", (e) => {
      setEnabled(e.payload);
    });
    return () => {
      void unPrefs.then((f) => f(), () => {});
      void unAi.then((f) => f(), () => {});
      void unSelEnabled.then((f) => f(), () => {});
    };
  }, [prefsTick]);

  const toggleEnabled = (next: boolean) => {
    setEnabled(next);
    void invoke("selection_set_enabled", { enabled: next });
  };

  const toggleClipboard = (next: boolean) => {
    setClipboardFallback(next);
    void invoke("selection_set_clipboard_fallback", { enabled: next });
  };

  const toggleClipboardLookup = (next: boolean) => {
    setClipboardLookup(next);
    void invoke("selection_set_clipboard_lookup", { enabled: next });
  };

  const toggleCompact = (next: boolean) => {
    setCompact(next);
    // 广播 prefs-changed：浮标常驻隐藏不销毁，需即时切换渲染
    void invoke("prefs_set_toolbar_compact", { compact: next });
  };

  /** 保存划词捕获配置（触发方式 / 过滤模式 / 过滤列表；一次提交三项——Rust 侧
   *  同步 selection static 并落盘，广播 prefs-changed 回读对齐）。
   *  列表 = textarea 逐行 → 数组（trim + 去空行；Rust 侧再归一小写）。 */
  const saveCapture = (patch?: { trigger?: string; mode?: string; list?: string }) => {
    const trigger = patch?.trigger ?? selectionTrigger;
    const mode = patch?.mode ?? filterMode;
    const list = (patch?.list ?? filterListText).split("\n").map((s) => s.trim()).filter(Boolean);
    void invoke("prefs_set_selection_capture", { trigger, filterMode: mode, filterList: list }).catch(() => {});
  };

  const resolved = resolveActions(actionPrefs);

  /** 保存动作配置（提交全量有序列表，含自定义字段） */
  const saveActions = (list: ActionPref[]) => {
    const prefs: ActionPref[] = list.map(({ id, enabled: en, searchEngine, name, prompt, model, icon }) => ({
      id,
      enabled: en,
      ...(searchEngine ? { searchEngine } : {}),
      ...(name ? { name } : {}),
      ...(prompt ? { prompt } : {}),
      ...(model ? { model } : {}),
      ...(icon ? { icon } : {}),
    }));
    setActionPrefs(prefs);
    void invoke("prefs_set_action_items", { items: prefs }).catch(() => {});
  };

  const toggleAction = (id: string, en: boolean) => {
    saveActions(resolved.map((a) => (a.id === id ? { ...a, enabled: en } : a)));
  };

  /** upsert（新动作追加尾部；内置动作保留当前启停态，避免默认开关被覆盖） */
  const upsertAction = (item: ActionPref) => {
    const cur = resolved.find((a) => a.id === item.id);
    const enabled = cur?.enabled ?? item.enabled;
    const next = cur
      ? resolved.map((a) => (a.id === item.id ? { ...a, ...item, enabled } : a))
      : [...resolved, { ...item, enabled }];
    saveActions(next);
    setEditing(null);
  };

  const deleteCustom = (id: string) => {
    saveActions(resolved.filter((a) => a.id !== id));
  };

  const openEdit = (a: ResolvedAction) => {
    if (a.id === "search") {
      setEditing({ kind: "search", item: { id: a.id, enabled: a.enabled, searchEngine: a.searchEngine ?? "" } });
      return;
    }
    setEditing({
      kind: a.custom ? "custom" : "builtin-ai",
      item: {
        id: a.id,
        enabled: a.enabled,
        name: a.name ?? "",
        prompt: a.prompt ?? "",
        model: a.model ?? "",
        icon: a.icon ?? "",
      },
    });
  };

  const onDragEnd = (result: DropResult) => {
    if (!result.destination || result.destination.index === result.source.index) return;
    saveActions(moveItem(resolved, result.source.index, result.destination.index));
  };

  return (
    <SettingsContentColumn>
      <SettingGroup>
        <SettingTitle>划词捕获</SettingTitle>
        <SettingDescription>
          在任意应用拖选/双击文本 → 浮标出现，点动作打开处理面板；点外部/滚轮/按键隐藏浮标。
        </SettingDescription>
        <div className="mt-3 flex flex-col gap-3">
          {loaded ? (
            <>
              <SettingRow>
                <SettingRowTitle>启用划词捕获</SettingRowTitle>
                <Switch checked={enabled} onCheckedChange={toggleEnabled} />
              </SettingRow>
              <SettingRow>
                <SettingRowTitle>触发方式</SettingRowTitle>
                <select
                  value={selectionTrigger}
                  onChange={(e) => {
                    const v = e.target.value as typeof selectionTrigger;
                    setSelectionTrigger(v);
                    saveCapture({ trigger: v });
                  }}
                  className="h-7 w-44 cursor-pointer rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-primary/40"
                >
                  <option value="selected">拖选/双击即查</option>
                  <option value="ctrlkey">按住 Ctrl 查词</option>
                  <option value="shortcut">快捷键查词</option>
                </select>
              </SettingRow>
              {selectionTrigger !== "selected" && (
                <p className="text-muted-foreground text-xs">
                  {selectionTrigger === "ctrlkey"
                    ? "按住 Ctrl ≥0.35 秒捕获当前选区弹浮标；拖选/双击不再触发。"
                    : "只有「划词查词」快捷键会弹浮标；拖选/双击不再触发。"}
                </p>
              )}
              {selectionTrigger === "shortcut" && !hotkeyBound && (
                <p className="text-amber-600 text-xs">
                  尚未绑定「划词查词」快捷键——请到「快捷键」子页录制后生效。
                </p>
              )}
              <SettingRow>
                <SettingRowTitle>进程过滤</SettingRowTitle>
                <select
                  value={filterMode}
                  onChange={(e) => {
                    const v = e.target.value as typeof filterMode;
                    setFilterMode(v);
                    saveCapture({ mode: v });
                  }}
                  className="h-7 w-44 cursor-pointer rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-primary/40"
                >
                  <option value="default">默认（预定义黑名单）</option>
                  <option value="whitelist">白名单（仅列表内）</option>
                  <option value="blacklist">黑名单（列表 + 预定义）</option>
                </select>
              </SettingRow>
              {filterMode !== "default" && (
                <div className="flex flex-col gap-1.5">
                  <SettingRowTitle>
                    {filterMode === "whitelist" ? "白名单进程" : "黑名单进程"}
                  </SettingRowTitle>
                  <textarea
                    value={filterListText}
                    onChange={(e) => setFilterListText(e.target.value)}
                    onBlur={() => saveCapture()}
                    rows={4}
                    spellCheck={false}
                    placeholder={"每行一个进程名（子串匹配），如：\nnotepad.exe\nchrome"}
                    className="w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-xs outline-none focus:ring-1 focus:ring-primary/40"
                  />
                  <p className="text-muted-foreground text-xs">
                    {filterMode === "whitelist"
                      ? "仅列表内程序触发划词；黑名单模式下Ctrl/快捷键触发不受预定义黑名单限制。"
                      : "黑名单（拖选/双击触发）自动并入预定义清单（截图、Office 表格、CAD、远程桌面等）。"}
                  </p>
                </div>
              )}
              <SettingRow>
                <SettingRowTitle>剪贴板兜底</SettingRowTitle>
                <Switch checked={clipboardFallback} onCheckedChange={toggleClipboard} />
              </SettingRow>
              <SettingRow>
                <SettingRowTitle>剪贴板监听查词</SettingRowTitle>
                <Switch checked={clipboardLookup} onCheckedChange={toggleClipboardLookup} />
              </SettingRow>
              {clipboardLookup && (
                <p className="text-muted-foreground text-xs">
                  任意程序复制文本后自动弹出划词栏（词/短语；本应用内复制不触发）。
                </p>
              )}
              <SettingRow>
                <SettingRowTitle>紧凑模式</SettingRowTitle>
                <Switch checked={compact} onCheckedChange={toggleCompact} />
              </SettingRow>
            </>
          ) : (
            <div className="py-2 text-muted-foreground text-xs">加载中…</div>
          )}
          <p className="text-muted-foreground text-xs">
            兜底用于 Acrobat/微信等 UIA 不可达场景，会短暂改写剪贴板并恢复；紧凑模式浮标只显示图标，悬停查看名称。
          </p>
        </div>
      </SettingGroup>

      <SettingGroup>
        <SettingTitle>划词栏动作</SettingTitle>
        <SettingDescription>
          AI 动作需先在「模型服务」配置端点与模型；拖动整行调整顺序（顺序即浮标上从左到右）。
        </SettingDescription>
        {/* 实时预览（所见即所得）：浮标单击外部即消失，设置页内实时反映——
            启停/排序/紧凑模式/编辑即时反映。正常页面底色 + pill 自带阴影；保留
            hover 高亮特效，点击不做实际动作（无 onAction）。 */}
        {!loaded ? (
          <div className="my-3 py-2 text-muted-foreground text-xs">加载中…</div>
        ) : (
          <>
            <div className="my-3 flex justify-center overflow-x-auto rounded-md py-3">
              <ToolbarPill
                actions={resolved.filter((a) => a.enabled && (!a.ai || aiOk))}
                compact={compact}
                className="overflow-hidden bg-card shadow-[0_2px_3px_rgb(50_50_50_/_0.1)]"
              />
            </div>
            <DragDropContext onDragEnd={onDragEnd}>
              <Droppable droppableId="action-items">
                {(prov) => (
                  <div ref={prov.innerRef} {...prov.droppableProps} className="mt-2 mb-1">
                    {resolved.map((a, i) => (
                  <Draggable key={a.id} draggableId={a.id} index={i}>
                    {(drag, snapshot) => (
                      <div
                        ref={drag.innerRef}
                        {...drag.draggableProps}
                        {...drag.dragHandleProps}
                        className={cn(
                          "mb-2 flex select-none items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5",
                          "cursor-move transition-colors last:mb-0 hover:bg-accent/40",
                          snapshot.isDragging && "z-10 shadow-md",
                          !a.enabled && "opacity-60",
                        )}
                      >
                        <ActionIcon action={a} className="size-4 shrink-0 text-muted-foreground" />
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                          <SettingRowTitle className="min-w-0 truncate">{a.label}</SettingRowTitle>
                          {a.custom && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-[10px]">
                              自定义
                            </span>
                          )}
                          {a.ai && !aiOk && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-[10px]">
                              需配置模型服务
                            </span>
                          )}
                          {a.id === "search" && a.searchEngine && (
                            <span className="truncate text-muted-foreground text-xs">
                              {a.searchEngine.split("|")[0]}
                            </span>
                          )}
                          {a.model && (
                            <span className="max-w-[140px] truncate text-muted-foreground text-xs">
                              {a.model}
                            </span>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {(a.custom || a.ai || a.id === "search") && (
                            <Tooltip content="编辑" placement="top">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`编辑 ${a.label}`}
                                onClick={() => openEdit(a)}
                              >
                                {a.id === "search" ? (
                                  <Settings2 className="size-3.5" />
                                ) : (
                                  <Pencil className="size-3.5" />
                                )}
                              </Button>
                            </Tooltip>
                          )}
                          {a.custom && (
                            <Tooltip content="删除" placement="top">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`删除 ${a.label}`}
                                onClick={() => deleteCustom(a.id)}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </Tooltip>
                          )}
                          <Switch
                            checked={a.enabled}
                            disabled={a.ai && !aiOk}
                            onCheckedChange={(checked) => toggleAction(a.id, checked)}
                          />
                        </div>
                      </div>
                    )}
                  </Draggable>
                ))}
                {prov.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>
        <div className="mt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!aiOk}
            onClick={() =>
              setEditing({
                kind: "custom",
                item: { id: "", enabled: false, name: "", prompt: "", model: "", icon: "" },
              })
            }
          >
            <Plus className="size-4" />
            添加自定义动作
          </Button>
          {!aiOk && (
            <p className="mt-1.5 text-muted-foreground text-xs">
              配置模型服务后可添加自定义 AI 动作；内置 AI 动作（翻译/解释/总结/润色）与搜索引擎可直接点编辑图标调整。
            </p>
          )}
        </div>
          </>
        )}
      </SettingGroup>

      <CustomActionDialog
        target={editing?.kind === "search" ? null : editing}
        onOk={upsertAction}
        onCancel={() => setEditing(null)}
      />
      <SearchEngineDialog target={editing} onOk={upsertAction} onCancel={() => setEditing(null)} />
    </SettingsContentColumn>
  );
}

/** 模型卡弹出设置窗口：端点 / API 类型 / Key（检测 Key）/ 拉取模型列表 / 推理模型标记。
 *  API 类型 = 端点真实兼容协议（值对齐 cherry ENDPOINT_TYPE 聊天三形态）：
 *  「OpenAI 兼容」并非单一协议，chat-completions / responses / anthropic-messages
 *  的路径、鉴权头与消息结构各不相同，必须可选。
 *  推理模型 = 能力标记（传递给各场景做门禁），非思考总开关。
 *  「保存」只存卡，「保存并启用」同时切换激活 provider。 */
/** 逐模型能力预设标签（值与 Rust ModelEntry.caps 约定对齐；files 未实现仅预留标记位） */
const MODEL_CAP_DEFS: Array<{ value: ModelCapability; label: string; short: string }> = [
  { value: "thinking", label: "推理", short: "推理" },
  { value: "vision", label: "图片输入", short: "图片" },
  { value: "files", label: "文件上传（未实现）", short: "文件" },
];

/** 可用模型分组键（cherry deriveModelGroupName 同规则）：id 含 `/` 取首段，
 *  否则取第一个 `-` 前 token（qwen-max → qwen）；均不适用归「其他」（组间沉底） */
function modelGroupId(id: string): string {
  const slash = id.indexOf("/");
  if (slash > 0) return id.slice(0, slash);
  const dash = id.indexOf("-");
  if (dash > 0) return id.slice(0, dash);
  return "其他";
}

function ProviderDialog({
  preset,
  ai,
  onClose,
  onSaved,
}: {
  preset: ProviderPreset | null;
  ai: AiPrefs | null;
  onClose: () => void;
  onSaved: (ai: AiPrefs) => void;
}) {
  const open = preset !== null;
  const [endpoint, setEndpoint] = useState("");
  const [apiType, setApiType] = useState<ApiType>("openai-chat-completions");
  const [apiKey, setApiKey] = useState("");
  /** 已配置模型（保存即此列表；逐模型能力标记） */
  const [models, setModels] = useState<ModelEntry[]>([]);
  /** 可用模型池（拉取到的全量 id 列表；右侧侧边面板展示） */
  const [available, setAvailable] = useState<string[]>([]);
  /** 右侧侧边扩展面板开关（拉取成功自动展开；可单独收起，「+ 添加」重开） */
  const [poolOpen, setPoolOpen] = useState(false);
  /** 能力标记编辑展开中的模型 id（单开） */
  const [capsOpenId, setCapsOpenId] = useState<string | null>(null);
  /** 池内已折叠分组（默认全展开） */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"detect" | "fetch" | "save" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (preset) {
      const card = ai?.providers.find((c) => c.id === preset.id);
      setEndpoint(card?.endpoint ?? preset.endpoint);
      setApiType(card?.apiType ?? "openai-chat-completions");
      setApiKey(card?.apiKey ?? "");
      setModels(card?.models ?? []);
      setAvailable((card?.models ?? []).map((e) => e.id));
      setPoolOpen(false);
      setCapsOpenId(null);
      setCollapsedGroups(new Set());
      setMsg(null);
      // 打开任何卡强制干净态：上一次会话的 busy 残留会让全部按钮 disabled
      setBusy(null);
    }
    // 依赖含 ai：页面挂载早于偏好加载完成时（用户极速点开弹窗），ai 晚到后
    // 重新填充已保存配置（用户实测「弹窗显示未配置，切 tab 才加载」）
  }, [preset, ai]);

  /** 直传表单草稿调 /models（未保存也可检测/拉取）；45s 竞速兜底 */
  const callModels = () =>
    withTimeout(
      invoke<string[]>("ai_models", {
        endpoint: endpoint.trim(),
        apiKey: apiKey.trim() || null,
        apiType,
      }),
      45_000,
      "请求",
    );

  const detectKey = () => {
    setBusy("detect");
    setMsg(null);
    callModels()
      .then((list) =>
        setMsg(list.length ? `Key 有效，端点可用（${list.length} 个模型）` : "Key 有效，连接成功"),
      )
      .catch((e) => setMsg(`检测失败：${String(e)}`))
      .finally(() => setBusy(null));
  };

  const fetchModels = () => {
    setBusy("fetch");
    setMsg(null);
    callModels()
      .then((list) => {
        // 只刷新可用池；是否添加由用户在右侧面板点选——云服务可用模型动辄上百个，
        // 全量直写列表会爆炸（改版为侧边面板点选）
        setAvailable(list);
        setPoolOpen(true);
        setMsg(`已拉取 ${list.length} 个可用模型，在右侧点选添加`);
      })
      .catch((e) => setMsg(`拉取失败：${String(e)}`))
      .finally(() => setBusy(null));
  };

  /** 池内模型添加/移除（toggle；新添加模型能力集为空） */
  const togglePoolModel = (id: string) =>
    setModels((cur) =>
      cur.some((e) => e.id === id) ? cur.filter((e) => e.id !== id) : [...cur, { id, caps: [] }],
    );

  const removeConfigured = (id: string) => {
    setModels((cur) => cur.filter((e) => e.id !== id));
    setCapsOpenId((cur) => (cur === id ? null : cur));
  };

  /** 逐模型能力标记 toggle */
  const toggleCap = (id: string, cap: ModelCapability) =>
    setModels((cur) =>
      cur.map((e) =>
        e.id === id
          ? {
              ...e,
              caps: e.caps.includes(cap) ? e.caps.filter((c) => c !== cap) : [...e.caps, cap],
            }
          : e,
      ),
    );

  const toggleGroup = (name: string) =>
    setCollapsedGroups((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  /** 可用池分组（组内保持拉取序，组间按首现序，「其他」沉底——稳定排序） */
  const poolGroups = useMemo(() => {
    const groups: Array<{ name: string; models: string[] }> = [];
    const index = new Map<string, number>();
    for (const m of available) {
      const g = modelGroupId(m);
      let i = index.get(g);
      if (i === undefined) {
        i = groups.length;
        index.set(g, i);
        groups.push({ name: g, models: [] });
      }
      groups[i].models.push(m);
    }
    return groups.sort((a, b) => (a.name === "其他" ? 1 : b.name === "其他" ? -1 : 0));
  }, [available]);

  const save = (activate: boolean) => {
    if (!preset) return;
    setBusy("save");
    setMsg(null);
    const card: ProviderConfig = {
      id: preset.id,
      endpoint: endpoint.trim(),
      apiKey: apiKey.trim() || null,
      models,
      apiType,
    };
    void (async () => {
      const base: AiPrefs = {
        provider: null,
        model: null,
        dictEnabled: true,
        dictPrompt: null,
        dictAllowThink: false,
        dictModel: null,
        providers: [],
        ...(await withTimeout(fetchAi(), 15_000, "读取配置")),
      };
      // 默认模型绑定保护（「每次更新模型卡链接都会重置模型」）：
      // 全局默认模型路由 = 激活卡 + model 配对，「保存并启用」切激活卡会破坏绑定
      // （默认模型不属于新卡 = 下拉显示重置 + 请求路由断裂）。故仅当默认模型属于
      // 本卡 / 未设置 / 本卡已是激活卡时才切换激活；否则只保存卡配置并保持弹窗
      // 说明——卡编辑永不破坏既有默认模型绑定。
      const defaultModelSafe =
        !base.model || base.provider === card.id || card.models.some((e) => e.id === base.model);
      const activateNow = activate && defaultModelSafe;
      const merged: AiPrefs = {
        ...base,
        providers: [...base.providers.filter((c) => c.id !== card.id), card],
        ...(activateNow ? { provider: card.id } : {}),
      };
      await withTimeout(invoke("prefs_set_ai", { ai: merged }), 15_000, "保存");
      // **必须复位 busy**：弹窗组件常挂载，busy 不随 preset 重置——成功路径若
      // 残留 "save"，下次打开任何卡全部按钮 disabled（检测/拉取永久灰，即
      // 「无法回到拉取模型列表的状态」 实测）
      setBusy(null);
      if (activate && !activateNow) {
        const currentName = providerPresetById(base.provider ?? "")?.name ?? base.provider;
        setMsg(
          `已保存。默认模型仍指向「${currentName}」，激活卡未切换——如需启用本卡，请在「默认模型」下拉选择本卡模型。`,
        );
        return;
      }
      onSaved(merged);
    })().catch((e) => {
      setMsg(`保存失败：${String(e)}`);
      setBusy(null);
    });
  };

  const connectionForm = (
    <>
      {preset?.note && (
        <p className="rounded bg-muted/60 px-2.5 py-1.5 text-muted-foreground text-xs">{preset.note}</p>
      )}
      <div className="flex flex-col gap-1.5">
        <SettingRowTitle>API 类型</SettingRowTitle>
        <select
          tabIndex={-1}
          value={apiType}
          onChange={(e) => setApiType(e.target.value as ApiType)}
          className="h-8 w-full cursor-pointer rounded-md border border-border bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-primary/40"
        >
          {API_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <SettingRowTitle>API 端点</SettingRowTitle>
        <Input
          autoFocus
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="base URL"
          className="h-8 px-2 text-sm"
          spellCheck={false}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <SettingRowTitle>API Key</SettingRowTitle>
          {preset?.keyUrl && (
            <button
              type="button"
              onClick={() => void invoke("open_external", { url: preset.keyUrl }).catch(() => {})}
              className="inline-flex cursor-pointer items-center gap-0.5 bg-transparent p-0 text-primary text-xs hover:underline"
            >
              获取 API Key
              <ExternalLink className="size-3" />
            </button>
          )}
        </div>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-…"
          className="h-8 px-2 text-sm"
          spellCheck={false}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={detectKey}
          disabled={busy !== null || !endpoint.trim()}
        >
          {busy === "detect" ? "检测中…" : "检测 Key"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={fetchModels}
          disabled={busy !== null || !endpoint.trim()}
        >
          {busy === "fetch" ? "拉取中…" : "拉取模型列表"}
        </Button>
      </div>
      {msg && (
        <p
          className={cn(
            "text-xs",
            msg.startsWith("检测失败") || msg.startsWith("拉取失败") || msg.startsWith("保存失败")
              ? "text-destructive"
              : "text-green-600",
          )}
        >
          {msg}
        </p>
      )}
    </>
  );

  /** 左栏：已配置模型平铺（行展开 = 逐模型能力标记编辑） */
  const configuredList = (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <SettingRowTitle>已配置模型（{models.length}）</SettingRowTitle>
        {/* 仅池收起时显示：职责是重开池（免重拉列表）；池可见时点击右侧行即添加，按钮纯属冗余 */}
        {!poolOpen && available.length > 0 && (
          <button
            type="button"
            onClick={() => setPoolOpen(true)}
            className="inline-flex cursor-pointer items-center gap-0.5 rounded px-1.5 py-0.5 text-primary text-xs transition-colors hover:bg-accent/60"
          >
            <Plus className="size-3" />
            添加
          </button>
        )}
      </div>
      {models.length === 0 ? (
        <p className="rounded-md border border-border border-dashed px-2.5 py-3 text-center text-muted-foreground text-xs">
          {available.length
            ? poolOpen
              ? "从右侧可用模型中点击添加"
              : "点右上「添加」重新打开可用模型列表"
            : "填写端点后「拉取模型列表」，再从可用模型中选取"}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {models.map((entry) => {
            const capsOpen = capsOpenId === entry.id;
            return (
              <div key={entry.id} className="rounded-md border border-border bg-background">
                <div className="flex items-center gap-1.5 px-1.5 py-1">
                  <button
                    type="button"
                    onClick={() => setCapsOpenId(capsOpen ? null : entry.id)}
                    className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                  >
                    {capsOpen ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                  </button>
                  <span className="min-w-0 flex-1 truncate text-xs">{entry.id}</span>
                  {!capsOpen &&
                    entry.caps.map((c) => {
                      const def = MODEL_CAP_DEFS.find((d) => d.value === c);
                      return def ? (
                        <span
                          key={c}
                          className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {def.short}
                        </span>
                      ) : null;
                    })}
                  <button
                    type="button"
                    onClick={() => removeConfigured(entry.id)}
                    className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
                {capsOpen && (
                  <div className="flex flex-wrap gap-1.5 border-border border-t px-2 py-1.5">
                    {MODEL_CAP_DEFS.map((def) => {
                      const on = entry.caps.includes(def.value);
                      return (
                        <button
                          key={def.value}
                          type="button"
                          onClick={() => toggleCap(entry.id, def.value)}
                          title={def.label}
                          className={cn(
                            "cursor-pointer rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                            on
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border text-muted-foreground hover:bg-accent/60",
                          )}
                        >
                          {def.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  /** 右栏：可用模型池（分组可折叠；点选添加/移除；已配置模型标记选中） */
  const poolPanel = (
    <div className="flex min-w-0 flex-col rounded-lg border border-border bg-muted/30">
      <div className="flex items-center gap-2 border-border border-b px-2.5 py-2">
        <span className="font-medium text-foreground text-xs">可用模型（{available.length}）</span>
        <button
          type="button"
          onClick={() => setPoolOpen(false)}
          className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          收起
          <X className="size-3" />
        </button>
      </div>
      <div className="max-h-96 overflow-y-auto p-1.5">
        {poolGroups.map((g) => {
          const collapsed = collapsedGroups.has(g.name);
          return (
            <div key={g.name} className="mb-1">
              <button
                type="button"
                onClick={() => toggleGroup(g.name)}
                className="flex w-full cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/40"
              >
                {collapsed ? (
                  <ChevronRight className="size-3 shrink-0" />
                ) : (
                  <ChevronDown className="size-3 shrink-0" />
                )}
                <span className="min-w-0 truncate">{g.name}</span>
                <span className="ml-auto shrink-0">{g.models.length}</span>
              </button>
              {!collapsed &&
                g.models.map((m) => {
                  const selected = models.some((e) => e.id === m);
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => togglePoolModel(m)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 rounded px-1.5 py-1 pl-5 text-left text-xs transition-colors hover:bg-accent/40",
                        selected ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-3.5 shrink-0 items-center justify-center rounded-sm border",
                          selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border",
                        )}
                      >
                        {selected && <Check className="size-2.5" />}
                      </span>
                      <span className="min-w-0 truncate">{m}</span>
                      {selected && <span className="ml-auto shrink-0 text-[10px]">已添加</span>}
                    </button>
                  );
                })}
            </div>
          );
        })}
        {available.length === 0 && (
          <p className="px-1.5 py-2 text-center text-muted-foreground text-xs">
            暂无可用模型——请先拉取列表
          </p>
        )}
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className={poolOpen ? "sm:max-w-3xl" : "sm:max-w-md"}
      >
        <DialogHeader>
          <DialogTitle>配置 {preset?.name}</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[70vh] min-h-0 flex-col gap-4 overflow-y-auto py-1 pr-1">
          {poolOpen ? (
            <div className="grid items-start gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
              <div className="flex min-w-0 flex-col gap-4">
                {connectionForm}
                {configuredList}
              </div>
              {poolPanel}
            </div>
          ) : (
            <div className="flex min-w-0 flex-col gap-4">
              {connectionForm}
              {configuredList}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button type="button" variant="outline" onClick={() => save(false)} disabled={busy !== null}>
            {busy === "save" ? "保存中…" : "保存"}
          </Button>
          <Button type="button" onClick={() => save(true)} disabled={busy !== null}>
            保存并启用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** AI 动作对话框：custom = 全字段增改；
 *  builtin-ai = 内置动作的覆盖编辑（名称固定，提示词/模型/图标留空即回内置默认）。
 *  cherry 的「使用助手/选择助手」依赖其助手体系，onedict 无此概念不搬。 */
function CustomActionDialog({
  target,
  onOk,
  onCancel,
}: {
  target: EditTarget | null;
  onOk: (item: ActionPref) => void;
  onCancel: () => void;
}) {
  const open = target !== null;
  const isBuiltin = target?.kind === "builtin-ai";
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  /** 动作级思考开关（默认关；实际模型无推理标记时禁用——能力标记传递，非总开关） */
  const [allowThink, setAllowThink] = useState(false);
  /** 激活卡（逐模型能力标记：思考门禁按 动作模型 ?? 全局默认 实时求值） */
  const [activeCard, setActiveCard] = useState<ProviderConfig | null>(null);
  /** 内置动作的预填提示词原文（提交时相同则视为未覆盖，不落盘） */
  const [builtinPrefill, setBuiltinPrefill] = useState("");
  /** 全局默认模型（select 默认项展示）+ 激活卡模型列表（可选项） */
  const [aiModel, setAiModel] = useState("");
  const [cardModels, setCardModels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** 思考门禁：编辑中动作的实际生效模型是否标记「推理」能力 */
  const cardThinking = modelThinking(activeCard, model || aiModel || undefined);

  useEffect(() => {
    if (!target) return;
    const item = target.item;
    setName(item.name ?? "");
    // 图标显示当前生效值：内置动作未覆盖时显示内置图标名（而非留空）。
    // 注意用 ||：item.icon 为空串（未覆盖）时 ?? 不会回退（?? 只认 null/undefined）
    setIcon(item.icon || (target.kind === "builtin-ai" ? builtinIconName(item.id) : ""));
    setModel(item.model ?? "");
    setAllowThink(item.allowThink ?? false);
    setError(null);
    void invoke<PrefsPayload>("prefs_get")
      .then((p) => {
        setAiModel(p.ai?.model ?? "");
        setCardModels(activeModels(p.ai));
        setActiveCard(activeProvider(p.ai));
        // 提示词默认填充（可见可改，与默认相同视为未覆盖； 对齐 AI 词典）。
        // 必须用 ||：openEdit 把未覆盖的 prompt 归一成空串，?? 只认 null/undefined 会漏
        // （同 icon 字段教训）
        if (target.kind === "builtin-ai") {
          const prefill = item.prompt || builtinPrompt(item.id, targetLangByCode(p.translateLang).promptName);
          setPrompt(prefill);
          setBuiltinPrefill(prefill);
        } else {
          setPrompt(item.prompt || CUSTOM_DEFAULT_PROMPT);
          setBuiltinPrefill("");
        }
      })
      .catch(() => {
        setPrompt(
          item.prompt ||
            (target.kind === "builtin-ai"
              ? builtinPrompt(item.id, targetLangByCode("zh-cn").promptName)
              : CUSTOM_DEFAULT_PROMPT),
        );
        setBuiltinPrefill("");
      });
  }, [target]);

  const randomIcon = () => {
    setIcon(iconNames[Math.floor(Math.random() * iconNames.length)]);
  };

  const submit = () => {
    if (!target) return;
    const trimmedIcon = icon.trim();
    if (trimmedIcon && !isValidIconName(trimmedIcon)) {
      setError("图标名无效，可点「查看所有图标」查可用名称，或留空使用默认图标");
      return;
    }
    const base = target.item;
    const trimmedPrompt = prompt.trim();
    // 提示词与默认相同 → 视为未覆盖（内置 = 内置模板；自定义 = {{text}} 直发默认）
    const promptOverridden =
      trimmedPrompt.length > 0 &&
      !(isBuiltin && trimmedPrompt === builtinPrefill.trim()) &&
      !(!isBuiltin && trimmedPrompt === CUSTOM_DEFAULT_PROMPT);
    // 内置动作：图标与内置相同 → 同理不落盘
    const iconOverridden =
      trimmedIcon.length > 0 && !(isBuiltin && trimmedIcon === builtinIconName(base.id));
    const next: ActionPref = {
      id: base.id || `user-${Date.now()}`,
      enabled: base.enabled,
      ...(target.kind === "custom" && name.trim() ? { name: name.trim() } : {}),
      ...(iconOverridden ? { icon: trimmedIcon } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(promptOverridden ? { prompt } : {}),
      // 思考开关：仅开启时落盘（关闭 = 默认非思考）；卡无能力时开关已禁用恒为关
      ...(allowThink ? { allowThink: true } : {}),
    };
    onOk(next);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {target?.kind === "custom" ? "编辑自定义动作" : isBuiltin ? "编辑内置 AI 动作" : "添加自定义动作"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto py-1 pr-1">
          {isBuiltin && target && (
            <p className="rounded bg-muted/60 px-2.5 py-1.5 text-muted-foreground text-xs">
              「{builtinActionName(target.item.id)}」为内置动作，以下设置留空即恢复默认。
            </p>
          )}
          {target?.kind === "custom" && (
            <div className="flex flex-col gap-1.5">
              <SettingRowTitle>名称</SettingRowTitle>
              <Input
                autoFocus
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
                maxLength={16}
                placeholder="显示在划词栏上（最多 16 字）"
                aria-invalid={!!error}
                className="h-8 px-2 text-sm"
              />
              {error && <p className="text-destructive text-xs">{error}</p>}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <SettingRowTitle>图标</SettingRowTitle>
              <button
                type="button"
                onClick={() =>
                  void invoke("open_external", { url: "https://lucide.dev/icons/" }).catch(() => {})
                }
                className="inline-flex cursor-pointer items-center gap-0.5 bg-transparent p-0 text-primary text-xs hover:underline"
              >
                查看所有图标
                <ExternalLink className="size-3" />
              </button>
              <button
                type="button"
                title="随机图标"
                aria-label="随机图标"
                onClick={randomIcon}
                className="cursor-pointer bg-transparent p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                <Dices className="size-3.5" />
              </button>
            </div>
            <div className="flex gap-2">
              <Input
                value={icon}
                onChange={(e) => {
                  setIcon(e.target.value);
                  setError(null);
                }}
                placeholder="languages / sparkle / book-open …"
                className="h-8 flex-1 px-2 text-sm"
                spellCheck={false}
              />
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
                {icon.trim() ? (
                  isValidIconName(icon.trim()) ? (
                    <DynamicIcon name={icon.trim() as IconName} size={16} />
                  ) : (
                    <OctagonX className="size-4 text-destructive" />
                  )
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <SettingRowTitle>模型</SettingRowTitle>
            <SettingDescription>
              默认使用「模型服务」的默认模型；拉取过模型列表后可在此切换（动作级覆盖）。
            </SettingDescription>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="h-8 w-full cursor-pointer rounded-md border border-border bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-primary/40"
            >
              <option value="">默认模型{aiModel ? `（${aiModel}）` : ""}</option>
              {model && !cardModels.includes(model) && <option value={model}>{model}</option>}
              {cardModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <SettingRowTitle>允许思考</SettingRowTitle>
            <SettingDescription>
              {cardThinking
                ? "开启后本动作允许模型思考（响应变慢、质量更优）；默认关闭走快响应"
                : "当前模型未标记「推理」能力，思考不可用；需先在模型服务的卡内为该模型打标"}
            </SettingDescription>
            <div>
              <Switch
                checked={allowThink && cardThinking}
                disabled={!cardThinking}
                onCheckedChange={(v) => setAllowThink(v)}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <SettingRowTitle>用户提示词（可选）</SettingRowTitle>
            <SettingDescription>
              {isBuiltin
                ? "留空使用内置提示词；填写后作为完整提示词，{{text}} 代表选中的文本。"
                : "使用占位符 {{text}} 代表选中的文本；不填写占位符时，选中的文本将添加到本提示词的末尾。"}
            </SettingDescription>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder={"例如：将以下文本改写为正式商务风格：\n{{text}}"}
              className="max-h-40 resize-none px-2 py-1.5 text-sm"
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button type="button" onClick={submit}>
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 内置 AI 动作显示名（弹窗提示用） */
function builtinActionName(id: string): string {
  const map: Record<string, string> = {
    translate: "翻译",
    explain: "解释",
    summary: "总结",
    refine: "润色",
  };
  return map[id] ?? id;
}

/** 搜索引擎编辑弹窗（pickdict SelectionActionSearchModal 同构简化：预设 + 自定义） */
function SearchEngineDialog({
  target,
  onOk,
  onCancel,
}: {
  target: EditTarget | null;
  onOk: (item: ActionPref) => void;
  onCancel: () => void;
}) {
  const open = target !== null && target.kind === "search";
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const presets = [
    { name: "Google", url: "https://www.google.com/search?q={{queryString}}" },
    { name: "百度", url: "https://www.baidu.com/s?wd={{queryString}}" },
    { name: "Bing", url: "https://www.bing.com/search?q={{queryString}}" },
  ];

  useEffect(() => {
    if (open) {
      const engine = target.item.searchEngine ?? "";
      const idx = engine.indexOf("|");
      setName(idx >= 0 ? engine.slice(0, idx) : engine);
      setUrl(idx >= 0 ? engine.slice(idx + 1) : "");
      setError(null);
    }
  }, [open, target]);

  const submit = () => {
    if (!name.trim() || !url.trim()) {
      setError("请填写名称与搜索 URL（含 {{queryString}} 占位符）");
      return;
    }
    if (!url.includes("{{queryString}}")) {
      setError("URL 需包含 {{queryString}} 占位符，划词内容将替换该占位符");
      return;
    }
    onOk({ id: "search", enabled: true, searchEngine: `${name.trim()}|${url.trim()}` });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>编辑搜索引擎</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto py-1 pr-1">
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => {
                  setName(p.name);
                  setUrl(p.url);
                  setError(null);
                }}
                className={cn(
                  "cursor-pointer rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                  name === p.name && url === p.url
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-muted/60 text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <SettingRowTitle>名称</SettingRowTitle>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              className="h-8 px-2 text-sm"
              maxLength={16}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <SettingRowTitle>搜索 URL</SettingRowTitle>
            <SettingDescription>{"{{queryString}} 占位符将替换为划词内容"}</SettingDescription>
            <Input
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              placeholder="https://example.com/search?q={{queryString}}"
              className="h-8 px-2 text-sm"
              spellCheck={false}
            />
          </div>
          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button type="button" onClick={submit}>
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 快捷键子页：全局快捷键录制与持久化。
 *  录制 = 点击进入捕获态，按下「修饰键+主键」即提交（Esc 取消）；保存经
 *  prefs_set_hotkeys → Rust 参数化重注册，冲突/格式无效返回 Err → 降级提示，
 *  显示值经 prefs-changed 回读对齐（偏好未落盘 = 保留旧键）。 */
function HotkeysSection({ prefsTick = 0 }: { prefsTick?: number }) {
  const [toggleKey, setToggleKey] = useState(DEFAULT_HOTKEY_TOGGLE);
  const [showKey, setShowKey] = useState(DEFAULT_HOTKEY_SHOW_MAIN);
  /** 划词查词槽：空串 = 未绑定（无内置默认，不注册不占键） */
  const [triggerKey, setTriggerKey] = useState("");
  /** OCR 取词槽：空串回内置默认 ctrl+alt+o */
  const [ocrKey, setOcrKey] = useState(DEFAULT_HOTKEY_OCR_LOOKUP);
  const [recording, setRecording] = useState<"toggle" | "show" | "trigger" | "ocr" | null>(null);
  const [hint, setHint] = useState<{ text: string; error: boolean } | null>(null);
  /** 首次偏好读取完成（同划词助手页：防切页闪跳） */
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const load = () => {
      void invoke<PrefsPayload>("prefs_get")
        .then((p) => {
          // `||` 兜底：偏好未覆盖（null/空串）回内置默认；trigger 槽回未绑定
          setToggleKey(p.hotkeys?.toggleSelection || DEFAULT_HOTKEY_TOGGLE);
          setShowKey(p.hotkeys?.showMain || DEFAULT_HOTKEY_SHOW_MAIN);
          setTriggerKey(p.hotkeys?.triggerLookup || "");
          setOcrKey(p.hotkeys?.ocrLookup || DEFAULT_HOTKEY_OCR_LOOKUP);
          setLoaded(true);
        })
        .catch(() => {});
    };
    load();
    const unPrefs = listen("prefs-changed", load);
    return () => {
      void unPrefs.then((f) => f(), () => {});
    };
  }, [prefsTick]);

  /** 保存（token null = 恢复默认槽位；trigger 槽的默认 = 清除绑定）。
   *  不乐观更新本地值——成功经 prefs-changed 回读，失败显示值自然不变（保留旧键） */
  const save = async (slot: "toggle" | "show" | "trigger" | "ocr", token: string | null) => {
    setHint(null);
    const nextToggle = slot === "toggle" ? token : toggleKey;
    const nextShow = slot === "show" ? token : showKey;
    const nextTrigger = slot === "trigger" ? token : triggerKey;
    const nextOcr = slot === "ocr" ? token : ocrKey;
    try {
      await invoke("prefs_set_hotkeys", {
        hotkeys: {
          toggleSelection: nextToggle || null,
          showMain: nextShow || null,
          triggerLookup: nextTrigger || null,
          ocrLookup: nextOcr || null,
        },
      });
      setHint({ text: "已保存并生效", error: false });
    } catch (e) {
      setHint({ text: `${String(e)}，已保留原快捷键`, error: true });
    }
  };

  // 录制捕获：window 级 keydown（capture 阶段拦截，避免录制期间触发页面快捷键）
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      if (isModifierCode(e.code)) return; // 修饰键本身：等待完整组合
      const token = comboFromEvent(e);
      if (!token) {
        setHint({ text: "不支持的按键", error: true });
        return;
      }
      if (!(e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)) {
        setHint({ text: "需包含修饰键（Ctrl / Alt / Shift / Win）", error: true });
        return;
      }
      setRecording(null);
      void save(recording, token);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, toggleKey, showKey, ocrKey]);

  const startRecord = (slot: "toggle" | "show" | "trigger" | "ocr") => {
    setHint(null);
    setRecording((cur) => (cur === slot ? null : slot));
  };

  return (
    <SettingsContentColumn>
      <SettingGroup>
        <SettingTitle>全局快捷键</SettingTitle>
        <SettingDescription>
          应用在后台任意界面生效；组合键需包含修饰键。若组合键已被其他程序占用则无法注册，将保留原快捷键。
        </SettingDescription>
        <div className="mt-3 flex flex-col gap-3">
          {!loaded ? (
            <div className="py-2 text-muted-foreground text-xs">加载中…</div>
          ) : (
            <>
              <HotkeyRow
                label="划词开关"
                description="开启/关闭划词捕获（与托盘菜单等效）"
                value={toggleKey}
                defaultToken={DEFAULT_HOTKEY_TOGGLE}
                recording={recording === "toggle"}
                onRecord={() => startRecord("toggle")}
                onReset={() => void save("toggle", null)}
              />
              <HotkeyRow
                label="查词呼出"
                description="显示并聚焦主窗口"
                value={showKey}
                defaultToken={DEFAULT_HOTKEY_SHOW_MAIN}
                recording={recording === "show"}
                onRecord={() => startRecord("show")}
                onReset={() => void save("show", null)}
              />
              <HotkeyRow
                label="划词查词"
                description="捕获当前选区弹出划词栏（配合「划词助手」的快捷键触发方式；未设置 = 不注册）"
                value={triggerKey}
                defaultToken=""
                recording={recording === "trigger"}
                onRecord={() => startRecord("trigger")}
                onReset={() => void save("trigger", null)}
              />
              <HotkeyRow
                label="截图翻译"
                description="框选屏幕区域识别文字并翻译（默认与语言设置见「截图助手」页）"
                value={ocrKey}
                defaultToken={DEFAULT_HOTKEY_OCR_LOOKUP}
                recording={recording === "ocr"}
                onRecord={() => startRecord("ocr")}
                onReset={() => void save("ocr", null)}
              />
              {hint && (
                <p className={cn("text-xs", hint.error ? "text-destructive" : "text-green-600")}>
                  {hint.text}
                </p>
              )}
            </>
          )}
        </div>
      </SettingGroup>
    </SettingsContentColumn>
  );
}

/** 快捷键行：名称 + 录制按钮（点击进入捕获态显示实时组合）+ 恢复默认 */
function HotkeyRow({
  label,
  description,
  value,
  defaultToken,
  recording,
  onRecord,
  onReset,
}: {
  label: string;
  description: string;
  value: string;
  /** 本槽位的内置默认值（恢复默认按钮的禁用判定按槽位区分） */
  defaultToken: string;
  recording: boolean;
  onRecord: () => void;
  onReset: () => void;
}) {
  const isDefault = value === defaultToken;
  // 会向当前应用输入字符的组合（无 Ctrl/Alt + 可打印主键）：告警但不拦——用户可能就要这个键
  const warning = typingRiskWarning(value);
  return (
    <div>
      <SettingRow>
        <div className="min-w-0 flex-1">
          <SettingRowTitle>{label}</SettingRowTitle>
          <SettingDescription>{description}</SettingDescription>
        </div>
        <button
          type="button"
          onClick={onRecord}
          aria-label={`设置${label}快捷键`}
          className={cn(
            "flex h-7 min-w-[130px] cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
            recording
              ? "border-primary bg-primary/10 text-primary"
              : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <Keyboard className="size-3.5" />
          {recording ? "按下新组合键…（Esc 取消）" : value ? formatHotkey(value) : "未设置"}
        </button>
        <Tooltip content="恢复默认" placement="top">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`恢复${label}默认快捷键`}
            disabled={isDefault}
            onClick={onReset}
          >
            <RotateCcw className="size-3.5" />
          </Button>
        </Tooltip>
      </SettingRow>
      {warning && <p className="mt-1 text-amber-600 text-xs">{warning}</p>}
    </div>
  );
}

/** 数据：一键备份/恢复 + 生词本 Anki CSV 导出。
 *  备份 = 四份数据 JSON 单文件内嵌（preferences 的 apiKey 为 DPAPI 密文——同机
 *  恢复免重填，跨机需重填，系统级加密不可迁移）；恢复 = 覆盖式，Rust 侧内存态
 *  重读 + 全量广播（data_restore），前端各页经既有事件监听自动重拉。 */
function DataSection() {
  const [busy, setBusy] = useState<string | null>(null);
  const [hint, setHint] = useState<{ text: string; kind: "success" | "error" } | null>(null);
  /** 数据存储位置：dir = 用户数据目录；cacheDir = 词典缓存目录
   *  （固定安装目录）；portable = 便携标记生效；custom = 位置指针生效。null = 查询中 */
  const [loc, setLoc] = useState<{
    dir: string;
    cacheDir: string;
    portable: boolean;
    custom: boolean;
  } | null>(null);
  /** 备份内容选项（导出时生效）：用户数据默认开；词典缓存体积大默认关 */
  const [backupUserData, setBackupUserData] = useState(true);
  const [backupCache, setBackupCache] = useState(false);

  useEffect(() => {
    invoke<{ dir: string; cacheDir: string; portable: boolean; custom: boolean }>("data_location")
      .then(setLoc)
      .catch(() => {});
  }, []);

  /** 迁移数据（复制用户记录 JSON + 词典缓存 → 新目录 → 写位置指针 → 重启接管；
   *  原目录保留为安全副本） */
  const migrateData = async () => {
    try {
      const picked = await openFileDialog({ directory: true, title: "选择新的数据存储目录" });
      if (!picked || Array.isArray(picked)) return;
      if (
        !window.confirm(
          "将把全部用户记录与词典缓存复制到所选目录，完成后应用自动重启（原目录数据保留作为安全副本）。确定继续？",
        )
      ) {
        return;
      }
      setBusy("migrate");
      const r = await invoke<{ files: number; bytes: number }>("data_migrate", { target: picked });
      setHint({
        text: `已迁移 ${r.files} 个数据文件，应用即将重启以切换到新目录…`,
        kind: "success",
      });
      setTimeout(() => void invoke("app_restart").catch(() => {}), 800);
    } catch (e) {
      setHint({ text: `迁移失败：${String(e)}`, kind: "error" });
      setBusy(null);
    }
  };

  /** 恢复默认数据位置（删除位置指针；重启后回到系统用户数据目录） */
  const resetDataLocation = async () => {
    try {
      setBusy("reset-loc");
      await invoke("data_reset_location");
      setHint({ text: "已恢复默认数据位置，应用即将重启…", kind: "success" });
      setTimeout(() => void invoke("app_restart").catch(() => {}), 800);
    } catch (e) {
      setHint({ text: `恢复默认失败：${String(e)}`, kind: "error" });
      setBusy(null);
    }
  };

  const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

  const exportBackup = async () => {
    try {
      const path = await saveFileDialog({
        defaultPath: `onedict-backup-${stamp()}.json`,
        filters: [{ name: "onedict 备份", extensions: ["json"] }],
      });
      if (!path) return;
      if (!backupUserData && !backupCache) {
        setHint({ text: "请先在下方选择至少一项备份内容", kind: "error" });
        return;
      }
      setBusy("backup");
      const r = await invoke<{ files: number; bytes: number }>("data_backup", {
        path,
        includeCache: backupCache,
      });
      setHint({ text: `已导出 ${r.files} 个文件到 ${path}`, kind: "success" });
    } catch (e) {
      setHint({ text: `导出失败：${String(e)}`, kind: "error" });
    } finally {
      setBusy(null);
    }
  };

  const importBackup = async () => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        filters: [{ name: "onedict 备份", extensions: ["json"] }],
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      if (
        !window.confirm(
          "恢复将覆盖当前的全部偏好、生词本与历史数据（不可撤销），确定继续？",
        )
      ) {
        return;
      }
      setBusy("restore");
      const r = await invoke<{ restored: number; cache: number }>("data_restore", { path });
      setHint({
        text:
          r.cache > 0
            ? `已恢复 ${r.restored} 个数据文件 + ${r.cache} 个缓存文件（各页面已刷新）`
            : `已恢复 ${r.restored} 个数据文件（各页面已刷新）`,
        kind: "success",
      });
    } catch (e) {
      setHint({ text: `恢复失败：${String(e)}`, kind: "error" });
    } finally {
      setBusy(null);
    }
  };

  const exportAnki = async () => {
    try {
      const path = await saveFileDialog({
        defaultPath: `onedict-vocabulary-${stamp()}.csv`,
        filters: [{ name: "Anki CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      setBusy("anki");
      const count = await invoke<number>("vocabulary_export_anki", { path });
      setHint({ text: `已导出 ${count} 条生词到 ${path}`, kind: "success" });
    } catch (e) {
      setHint({ text: `导出失败：${String(e)}`, kind: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsContentColumn>
      <SettingGroup>
        <SettingTitle>数据存储位置</SettingTitle>
        <SettingDescription>
          用户记录的存放目录；词典索引缓存属应用依赖数据，固定在安装目录（可随时重建）。
        </SettingDescription>
        <SettingRow className="mt-3">
          <SettingRowTitle>用户数据目录</SettingRowTitle>
          <Tooltip
            content="preferences.json（模型配置与 API Key、划词/词典等全部偏好）+ vocabulary.json（生词本）+ history.json / translate-history.json（查词与翻译历史）+ review-log.json（复习记录）。API Key 经系统级 DPAPI 加密存储。"
            placement="top"
          >
            <span className="max-w-[55%] cursor-help truncate text-muted-foreground text-xs" title={loc?.dir}>
              {loc?.dir ?? "查询中…"}
            </span>
          </Tooltip>
        </SettingRow>
        <SettingRow>
          <SettingRowTitle>词典缓存目录</SettingRowTitle>
          <span className="max-w-[55%] truncate text-muted-foreground text-xs" title={loc?.cacheDir}>
            {loc?.cacheDir ?? "…"}
          </span>
        </SettingRow>
        <SettingRow>
          <SettingRowTitle>迁移用户数据</SettingRowTitle>
          <Tooltip
            content="复制全部用户记录（含模型配置与 API Key、生词本、历史）到所选目录，完成后自动重启；原目录数据保留为安全副本。词典缓存不迁移（随应用走）。便携模式下无需迁移。"
            placement="top"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null || (loc?.portable ?? false)}
              onClick={() => void migrateData()}
            >
              {busy === "migrate" ? "迁移中…" : "选择新目录…"}
            </Button>
          </Tooltip>
        </SettingRow>
        {loc?.custom && (
          <SettingRow>
            <SettingRowTitle>恢复默认位置</SettingRowTitle>
            <Tooltip
              content="删除位置指针，重启后回到系统用户数据目录；已迁出的文件保留在原处。"
              placement="top"
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void resetDataLocation()}
              >
                {busy === "reset-loc" ? "处理中…" : "恢复默认"}
              </Button>
            </Tooltip>
          </SettingRow>
        )}
      </SettingGroup>

      <SettingGroup>
        <SettingTitle>备份与恢复</SettingTitle>
        <SettingDescription>
          备份导出为单 JSON 文件；恢复为覆盖式，只覆盖备份中包含的内容。
        </SettingDescription>
        <SettingRow className="mt-3">
          <SettingRowTitle>包含用户数据（模型配置/偏好/生词本/历史）</SettingRowTitle>
          <Tooltip
            content="模型配置与 API Key 在 preferences.json 内——API Key 以加密形态内嵌备份，同机恢复免重填，跨机恢复需重新填写。"
            placement="top"
          >
            <div>
              <Switch checked={backupUserData} onCheckedChange={setBackupUserData} />
            </div>
          </Tooltip>
        </SettingRow>
        <SettingRow>
          <SettingRowTitle>包含词典缓存</SettingRowTitle>
          <Tooltip
            content="安装目录 dict-cache 内的索引缓存，体积可能较大。恢复后免去重新解析；也可随时自动重建，一般无需备份。"
            placement="top"
          >
            <div>
              <Switch checked={backupCache} onCheckedChange={setBackupCache} />
            </div>
          </Tooltip>
        </SettingRow>
        <SettingRow>
          <SettingRowTitle>导出备份</SettingRowTitle>
          <Tooltip
            content={
              backupUserData && backupCache
                ? "导出用户数据 + 词典缓存到单个 JSON 文件。"
                : backupCache
                  ? "仅导出词典缓存到单个 JSON 文件。"
                  : "导出用户数据（偏好/生词本/历史）到单个 JSON 文件。"
            }
            placement="top"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void exportBackup()}
            >
              {busy === "backup" ? "导出中…" : "导出…"}
            </Button>
          </Tooltip>
        </SettingRow>
        <SettingRow>
          <SettingRowTitle>导入恢复</SettingRowTitle>
          <Tooltip
            content="选择备份文件，覆盖式恢复其中包含的内容；备份未包含的项目不受影响。"
            placement="top"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void importBackup()}
            >
              {busy === "restore" ? "恢复中…" : "选择备份文件…"}
            </Button>
          </Tooltip>
        </SettingRow>
      </SettingGroup>

      <SettingGroup>
        <SettingTitle>生词本导出</SettingTitle>
        <SettingDescription>生词本导出为 Anki 可导入的 CSV 文件。</SettingDescription>
        <SettingRow className="mt-3">
          <SettingRowTitle>导出生词本</SettingRowTitle>
          <Tooltip
            content="全部生词导出 CSV（UTF-8 BOM + CRLF，Excel 直开不乱码）；Anki 导入映射 word / note 两列即可，其余列为留档元数据（单元、SM-2 调度状态）。"
            placement="top"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void exportAnki()}
            >
              {busy === "anki" ? "导出中…" : "导出…"}
            </Button>
          </Tooltip>
        </SettingRow>
      </SettingGroup>

      {hint && (
        <p
          className={cn(
            "text-xs",
            hint.kind === "error" ? "text-destructive" : "text-green-600",
          )}
        >
          {hint.text}
        </p>
      )}
    </SettingsContentColumn>
  );
}

/** 词典：目录 + 管理列表（拖拽排序即查询序 + 启停）+ AI 词典组（自
 *  模型服务页移入；启用 + 系统提示词，改动即存并广播 ai-changed） */
function DictionarySection() {
  const [dictRoot, setDictRoot] = useState("");
  const [savingRoot, setSavingRoot] = useState(false);
  const [rootHint, setRootHint] = useState<string | null>(null);
  const [dicts, setDicts] = useState<DictMeta[] | null>(null);
  const [aiDictEnabled, setAiDictEnabled] = useState(true);
  const [aiDictOpen, setAiDictOpen] = useState(false);
  /** 词典管理统一偏好（本地 + 在线条目混排，id 前缀 web-；null = 全启用按扫描序） */
  const [dictItemsPref, setDictItemsPref] = useState<DictItemPref[] | null>(null);
  const [webFallbackOnly, setWebFallbackOnly] = useState(false);
  /** 词典外链走向（true = 浏览器打开；false = 转词典内部查词） */
  const [webExternal, setWebExternal] = useState(true);
  /** 学习卡自动发音（生词本复习卡弹窗；prefs-changed 广播实时生效于会话中） */
  const [reviewAutoPronounce, setReviewAutoPronounce] = useState(false);
  /** 首次偏好读取完成（同划词助手页：防止切页时开关默认值→实际值闪跳） */
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void invoke<PrefsPayload>("prefs_get")
      .then((p) => {
        setDictRoot(p.dictRoot ?? "");
        setAiDictEnabled(p.ai?.dictEnabled ?? true);
        setDictItemsPref(p.dictItems);
        setWebFallbackOnly(p.webFallbackOnly ?? false);
        setWebExternal(p.webExternal ?? true);
        setReviewAutoPronounce(p.reviewAutoPronounce ?? false);
        setLoaded(true);
      })
      .catch(() => {});
    invoke<DictMeta[]>("dictionary_list")
      .then(setDicts)
      .catch(() => setDicts([]));
    // 词典变更（目录/启停/排序，任意入口）→ 刷新列表与偏好序
    const unlisten = listen("dictionary-changed", () => {
      invoke<DictMeta[]>("dictionary_list").then(setDicts).catch(() => {});
      void invoke<PrefsPayload>("prefs_get")
        .then((p) => {
          setDictItemsPref(p.dictItems);
          setWebFallbackOnly(p.webFallbackOnly ?? false);
        })
        .catch(() => {});
    });
    return () => {
      void unlisten.then((f) => f(), () => {});
    };
  }, []);

  const saveDictRoot = useCallback(() => {
    setSavingRoot(true);
    setRootHint(null);
    invoke("prefs_set_dict_root", { root: dictRoot.trim() || null })
      .then(() => setRootHint("已保存，词典列表已刷新"))
      .catch((e) => setRootHint(`保存失败：${String(e)}`))
      .finally(() => setSavingRoot(false));
  }, [dictRoot]);

  /** 浏览选词典目录（打包安装后无 dev 探测兜底，选完即存即刷新——一步到位） */
  const browseDictRoot = useCallback(async () => {
    try {
      const picked = await openFileDialog({ directory: true, title: "选择词典目录" });
      if (!picked || Array.isArray(picked)) return;
      setDictRoot(picked);
      setSavingRoot(true);
      setRootHint(null);
      try {
        await invoke("prefs_set_dict_root", { root: picked });
        setRootHint("已保存，词典列表已刷新");
      } catch (e) {
        setRootHint(`保存失败：${String(e)}`);
      } finally {
        setSavingRoot(false);
      }
    } catch {
      /* 用户取消或对话框失败：不动现有输入 */
    }
  }, []);

  /** 统一行列表：本地词典 ∪ 在线词典（id 前缀 web-），dictItems 偏好序优先；
   *  新发现本地词典 / 内置在线源补尾默认启用——与 Rust merged_items、
   * webItemsFromDictItems 同一合并语义（并列排序） */
  const unifiedRows: Array<{ id: string; label: string; web: boolean; enabled: boolean }> = (() => {
    const rows: Array<{ id: string; label: string; web: boolean; enabled: boolean }> = [];
    const seen = new Set<string>();
    const dictsById = new Map((dicts ?? []).map((d) => [d.id, d]));
    const webList = webItemsFromDictItems(dictItemsPref);
    for (const item of dictItemsPref ?? []) {
      if (seen.has(item.id)) continue;
      if (item.id.startsWith("web-")) {
        if (WEB_DICTS[item.id]) {
          rows.push({ id: item.id, label: WEB_DICTS[item.id].label, web: true, enabled: item.enabled });
          seen.add(item.id);
        }
      } else if (dictsById.has(item.id)) {
        rows.push({ id: item.id, label: item.id, web: false, enabled: item.enabled });
        seen.add(item.id);
      }
    }
    for (const d of dicts ?? []) {
      if (!seen.has(d.id)) {
        rows.push({ id: d.id, label: d.id, web: false, enabled: d.enabled });
        seen.add(d.id);
      }
    }
    for (const w of webList) {
      if (!seen.has(w.id)) {
        rows.push({ id: w.id, label: WEB_DICTS[w.id]?.label ?? w.id, web: true, enabled: w.enabled });
        seen.add(w.id);
      }
    }
    return rows;
  })();

  /** 保存统一列表（全量有序：本地+在线条目 id/enabled）+ fallback 开关一次提交；
   *  Rust 侧广播 dictionary-changed 驱动各页刷新 */
  const saveUnified = (rows: Array<{ id: string; enabled: boolean }>) => {
    setDictItemsPref(rows);
    void invoke("prefs_set_dict_items", { items: rows, webFallbackOnly }).catch(() => {});
  };

  const saveFallback = (v: boolean) => {
    setWebFallbackOnly(v);
    void invoke("prefs_set_dict_items", { items: dictItemsPref, webFallbackOnly: v }).catch(() => {});
  };

  /** 词典外链走向开关（即改即存 + prefs-changed 广播，查询管线实时跟随） */
  const saveWebExternal = (v: boolean) => {
    setWebExternal(v);
    void invoke("prefs_set_web_external", { enabled: v }).catch(() => {});
  };

  /** 学习卡自动发音开关（即改即存 + prefs-changed 广播，复习会话实时跟随） */
  const saveReviewAutoPronounce = (v: boolean) => {
    setReviewAutoPronounce(v);
    void invoke("prefs_set_review_auto_pronounce", { enabled: v }).catch(() => {});
  };

  /** 移除词典（删除三语义；停用 = 行内开关已有）：
   *  仅删引用 = 列表移除 + 扫描永久忽略（文件保留，换词典根目录可恢复）；
   *  删除文件 = 引用 + 词典目录（不可恢复，红色按钮 + 二次点击确认） */
  const [removing, setRemoving] = useState<{ id: string; label: string } | null>(null);
  const [fileDeleteArmed, setFileDeleteArmed] = useState(false);
  const [removeMsg, setRemoveMsg] = useState<string | null>(null);

  const openRemove = (id: string, label: string) => {
    setRemoving({ id, label });
    setFileDeleteArmed(false);
    setRemoveMsg(null);
  };

  const removeDict = async (deleteFiles: boolean) => {
    if (!removing) return;
    if (deleteFiles && !fileDeleteArmed) {
      setFileDeleteArmed(true); // 二次确认：第一次点击只武装按钮
      return;
    }
    try {
      await invoke("dictionary_remove", { dictId: removing.id, deleteFiles });
      setRemoving(null); // dictionary-changed 广播驱动词典列表重拉
    } catch (e) {
      setRemoveMsg(String(e));
    }
  };

  return (
    <SettingsContentColumn>
      <SettingGroup>
        <SettingTitle>词典目录</SettingTitle>
        <SettingDescription>
          目录内每个含 .mdx 的子目录视为一部词典；索引按词典磁盘缓存，启动免重复解析。
        </SettingDescription>
        <div className="mt-3 flex items-center gap-2">
          <Input
            value={dictRoot}
            onChange={(e) => setDictRoot(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveDictRoot();
            }}
            placeholder="选择或输入存放词典的文件夹绝对路径"
            className="h-7 flex-1 px-2 text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={browseDictRoot}
            disabled={savingRoot}
          >
            浏览…
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={saveDictRoot}
            disabled={savingRoot}
          >
            {savingRoot ? "保存中…" : "保存"}
          </Button>
        </div>
        {rootHint && (
          <p
            className={cn(
              "mt-2 text-xs",
              rootHint.startsWith("保存失败") ? "text-destructive" : "text-green-600",
            )}
          >
            {rootHint}
          </p>
        )}
      </SettingGroup>

      <SettingGroup>
        <SettingTitle>词典列表</SettingTitle>
        <SettingDescription>
          拖动整行调整顺序（即查词显示顺序，复习取第一部启用词典）；禁用的词典不参与查询与预热。
        </SettingDescription>
        {!loaded || dicts === null ? (
          <SettingRowTitle className="mt-2 text-muted-foreground">加载中…</SettingRowTitle>
        ) : (
          <>
            {unifiedRows.length === 0 && (
              <SettingDescription>当前目录下未发现词典（子目录需含 .mdx）。</SettingDescription>
            )}
            {unifiedRows.length > 0 && (
              /* 拖拽效果与划词栏动作列表对齐（hello-pangea/dnd 整行拖动，用户修订
                  dnd-kit 把手式观感不佳）；本地与在线词典并列混排
                 ，Globe 图标区分在线源 */
              <DragDropContext
                onDragEnd={(result) => {
                  if (!result.destination || result.destination.index === result.source.index) return;
                  saveUnified(
                    moveItem(unifiedRows, result.source.index, result.destination.index).map(
                      ({ id, enabled }) => ({ id, enabled }),
                    ),
                  );
                }}
              >
                <Droppable droppableId="dict-items">
                  {(prov) => (
                    <div ref={prov.innerRef} {...prov.droppableProps} className="mt-2 mb-1">
                      {unifiedRows.map((row, i) => (
                        <Draggable key={row.id} draggableId={row.id} index={i}>
                          {(drag, snapshot) => (
                            <div
                              ref={drag.innerRef}
                              {...drag.draggableProps}
                              {...drag.dragHandleProps}
                              className={cn(
                                "mb-2 flex select-none items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5",
                                "cursor-move transition-colors last:mb-0 hover:bg-accent/40",
                                snapshot.isDragging && "z-10 shadow-md",
                                !row.enabled && "opacity-60",
                              )}
                            >
                              {row.web ? (
                                <Globe className="size-4 shrink-0 text-muted-foreground" />
                              ) : (
                                <BookOpenText className="size-4 shrink-0 text-muted-foreground" />
                              )}
                              <SettingRowTitle className="min-w-0 flex-1 truncate">
                                {row.label}
                              </SettingRowTitle>
                              <span className="shrink-0 text-muted-foreground text-xs">
                                {row.enabled ? "已启用" : "已停用"}
                              </span>
                              <Switch
                                checked={row.enabled}
                                onCheckedChange={(en) =>
                                  saveUnified(
                                    unifiedRows.map((x) =>
                                      x.id === row.id ? { id: x.id, enabled: en } : x,
                                    ),
                                  )
                                }
                              />
                              {!row.web ? (
                                <Tooltip content="移除词典" placement="top">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`移除词典 ${row.label}`}
                                    className="text-muted-foreground hover:text-destructive"
                                    onClick={() => openRemove(row.id, row.label)}
                                  >
                                    <Trash2 className="size-3.5" />
                                  </Button>
                                </Tooltip>
                              ) : (
                                <Tooltip content="内置在线源不可移除（可停用）" placement="top">
                                  <span className="inline-flex">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon-sm"
                                      aria-label={`在线词典 ${row.label} 不可移除`}
                                      disabled
                                      className="text-muted-foreground"
                                    >
                                      <Trash2 className="size-3.5" />
                                    </Button>
                                  </span>
                                </Tooltip>
                              )}
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {prov.placeholder}
                    </div>
                  )}
                </Droppable>
              </DragDropContext>
            )}
          </>
        )}
      </SettingGroup>

      {/* 移除词典弹窗（删除三语义）：停用走行内开关；
          删除引用 = 永久忽略；删除文件 = 红色 + 二次点击确认 */}
      <Dialog
        open={removing !== null}
        onOpenChange={(next) => !next && setRemoving(null)}
      >
        <DialogContent aria-describedby={undefined} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>移除词典「{removing?.label}」</DialogTitle>
          </DialogHeader>
          <div className="text-muted-foreground text-sm">
            <p>停用词典请使用列表中的开关；移除有以下两种方式：</p>
            <ul className="mt-1.5 list-disc pl-5 text-xs">
              <li>仅删除引用：词典从列表移除且不再被发现，文件保留在磁盘（更换词典目录后可恢复）</li>
              <li>删除引用并删除文件：额外删除词典目录，不可恢复</li>
            </ul>
            {removeMsg && <p className="mt-2 text-destructive">{removeMsg}</p>}
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="ghost" onClick={() => setRemoving(null)}>
              取消
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={fileDeleteArmed}
              onClick={() => void removeDict(false)}
            >
              仅删除引用
            </Button>
            <Button
              type="button"
              variant="outline"
              className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => void removeDict(true)}
            >
              {fileDeleteArmed ? "再次点击确认删除文件" : "删除引用并删除文件"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 在线词典组：在线行为开关自词典列表组独立——
          与 AI 词典组同形态；有道等在线源条目本身仍留在上方词典列表参与拖拽
          排序与启停（并列排序不变）。组描述只讲外链行为（用户
          反馈：设置组布局说明属冗余，删） */}
      <SettingGroup>
        <SettingTitle>在线词典</SettingTitle>
        <SettingDescription>
          关闭后，在线词典结果里的外部网页链接不再打开浏览器，改为提取词走词典内部查询。
        </SettingDescription>
        <div className="mt-3 flex flex-col gap-3">
          {!loaded ? (
            <div className="py-2 text-muted-foreground text-xs">加载中…</div>
          ) : (
            <>
              <SettingRow>
                <SettingRowTitle>仅本地词典未命中时查询在线</SettingRowTitle>
                <Switch checked={webFallbackOnly} onCheckedChange={saveFallback} />
              </SettingRow>
              <SettingRow>
                <SettingRowTitle>词典外链在浏览器中打开</SettingRowTitle>
                <Switch checked={webExternal} onCheckedChange={saveWebExternal} />
              </SettingRow>
            </>
          )}
        </div>
      </SettingGroup>

      <SettingGroup>
        <SettingTitle>AI 词典</SettingTitle>
        <SettingDescription>
          在查词结果中内置「AI 词典」在线词典形态（词典列表之后），需先在「模型服务」配置端点与模型。
        </SettingDescription>
        <div className="mt-3 flex flex-col gap-3">
          {!loaded ? (
            <div className="py-2 text-muted-foreground text-xs">加载中…</div>
          ) : (
            <SettingRow>
              <SettingRowTitle>启用 AI 词典</SettingRowTitle>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setAiDictOpen(true)}
                >
                  设置
                </Button>
                <Switch
                  checked={aiDictEnabled}
                  onCheckedChange={(v) => {
                    setAiDictEnabled(v);
                    void patchAi({ dictEnabled: v });
                  }}
                />
              </div>
            </SettingRow>
          )}
        </div>
      </SettingGroup>

      <SettingGroup>
        <SettingTitle>复习卡</SettingTitle>
        <SettingDescription>生词本学习卡弹窗（复习单词）的发音行为。</SettingDescription>
        <SettingRow className="mt-3">
          <SettingRowTitle>卡片出现时自动发音</SettingRowTitle>
          <Switch checked={reviewAutoPronounce} onCheckedChange={saveReviewAutoPronounce} />
        </SettingRow>
        <SettingDescription>
          关闭时仍可点击卡面发音按钮手动发音；翻面后释义内的发音按钮始终可用。
        </SettingDescription>
      </SettingGroup>

      <AiDictDialog open={aiDictOpen} onClose={() => setAiDictOpen(false)} />
    </SettingsContentColumn>
  );
}

/** AI 词典配置弹窗（用户指定：词典子页仅留启用开关，模型/提示词/思考入弹窗）。
 *  模型下拉跨卡（合并所有已配置卡，optgroup 按卡分组 + `模型 · 卡名` 后缀——跨卡重名
 *  可辨，显示截断有完整 hover）；选「默认模型」= 跟随全局默认；提示词预填内置默认全文
 *  （与默认相同/清空 = 未覆盖不落盘，对齐内置动作弹窗预填语义）；允许思考开关受
 *  路由卡（绑定卡 ?? 激活卡）能力门禁。 */
function AiDictDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [ai, setAi] = useState<AiPrefs | null>(null);
  const [dictModel, setDictModel] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_AI_DICT_PROMPT);
  const [allowThink, setAllowThink] = useState(false);

  useEffect(() => {
    if (!open) return;
    void invoke<PrefsPayload>("prefs_get")
      .then((p) => {
        setAi(p.ai);
        setDictModel(p.ai?.dictModel ?? "");
        setPrompt(p.ai?.dictPrompt?.trim() ? p.ai.dictPrompt : DEFAULT_AI_DICT_PROMPT);
        setAllowThink(p.ai?.dictAllowThink ?? false);
      })
      .catch(() => {});
  }, [open]);

  const modelCards = (ai?.providers ?? []).filter(
    (c) => c.models.length > 0 && c.endpoint.trim(),
  );
  /** 思考门禁逐模型化：绑定模型 ?? 全局默认，在路由卡内查推理标记 */
  const routeThinking = modelThinking(
    dictRouteCard(ai),
    splitDictModel(dictModel).model || ai?.model || undefined,
  );

  const save = () => {
    const promptOverridden =
      prompt.trim().length > 0 && prompt.trim() !== DEFAULT_AI_DICT_PROMPT.trim();
    void patchAi({
      dictModel: dictModel || null,
      dictPrompt: promptOverridden ? prompt : null,
      dictAllowThink: allowThink,
    });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>AI 词典设置</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto py-1 pr-1">
          <div className="flex flex-col gap-1.5">
            <SettingRowTitle>模型</SettingRowTitle>
            <select
              value={dictModel}
              onChange={(e) => setDictModel(e.target.value)}
              className="h-8 w-full cursor-pointer rounded-md border border-border bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-primary/40"
            >
              <option value="">
                {ai?.model ? `默认模型（${ai.model}）` : "默认模型（未设置）"}
              </option>
              {modelCards.map((card) => {
                const cardName = providerPresetById(card.id)?.name ?? card.id;
                return (
                  <optgroup key={card.id} label={cardName}>
                    {card.models.map((e) => (
                      <option
                        key={`${card.id}:${e.id}`}
                        value={`${card.id}:${e.id}`}
                        title={`${e.id} · ${cardName}`}
                      >
                        {e.id} · {cardName}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <SettingRowTitle>允许思考</SettingRowTitle>
            <SettingDescription>
              {routeThinking
                ? "开启后允许模型思考（更严谨、更慢）；默认关闭走快响应"
                : "当前模型未标记「推理模型」，思考不可用"}
            </SettingDescription>
            <div>
              <Switch
                checked={allowThink && routeThinking}
                disabled={!routeThinking}
                onCheckedChange={setAllowThink}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <SettingRowTitle>系统提示词</SettingRowTitle>
            <SettingDescription>
              已预填内置默认；改动后作为完整提示词，恢复默认可直接保存。
            </SettingDescription>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={6}
              className="max-h-48 resize-y px-2 py-1.5 text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button type="button" onClick={save}>
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
