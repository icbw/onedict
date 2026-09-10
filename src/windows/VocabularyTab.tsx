/**
 * // from pickdict (MIT), adapted for Tauri —— VocabularyPage.tsx 平移（剥壳适配）。
 * 生词本（复习并入本页，导航删「复习」Tab）：
 * 顶部统计卡（生词 / 待复习 / 今日已复习 + 全局「开始复习」按钮）→
 * 单元制列表：收词箱（固定首位，查词页加词落点，不可删改名）+ 自建单元
 * （inline 新建 / 重命名 / 删除——词条自动回收进收词箱）；单元卡可折叠，
 * 词行点击词头跳词典页查词（onLookup），hover 显示移入单元 / 删除；
 * 页底「学习方案」配置组承载 SM-2 说明（原复习页退化形态）。
 * 复习会话 = ReviewDialog 学习卡弹窗（全部 / 单元两种范围；到期优先——范围内
 * 无到期词自动切「重复练习」提前过全量卡，按钮形态随 dueCount 双色切换）。
 * 数据经 vocabulary_* 全量拉取；vocabulary-changed 事件驱动刷新。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ChevronDown,
  FolderInput,
  GraduationCap,
  Inbox,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@onedict/ui/components/button";
import { Input } from "@onedict/ui/components/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onedict/ui/components/dropdown-menu";
import {
  SettingDescription,
  SettingGroup,
  SettingRow,
  SettingRowTitle,
  SettingTitle,
  SettingsContentColumn,
} from "../components/SettingsPrimitives";
import { cn } from "../lib/utils";
import { INBOX_UNIT_ID, type ReviewDayCount, type VocabularyEntry, type VocabularyUnit } from "../types/vocabulary";
import {
  dueCountsByDay,
  stackReviewDays,
  statusBuckets,
  type ReviewLog,
} from "../lib/stats";
import { DueBars, ReviewBars, StatusBar } from "../components/charts/ReviewCharts";

/** 单元词表默认渲染上限（止血），超出出「显示全部」 */
const WORDS_WINDOW = 50;
import ReviewDialog, { type ReviewSession } from "./vocabulary/ReviewDialog";

/** 单元渲染视图：收词箱 + 自建单元统一形态（词表按加入时间倒序） */
interface UnitView {
  id: string;
  name: string;
  isInbox: boolean;
  entries: VocabularyEntry[];
  dueCount: number;
}

const fmtDate = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export default function VocabularyTab({ onLookup }: { onLookup: (word: string) => void }) {
  const [entries, setEntries] = useState<VocabularyEntry[] | null>(null);
  const [units, setUnits] = useState<VocabularyUnit[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  /** 已展开全量词表的单元（止血 词表默认渲染前 50 条，防千词
   *  单元上千 DOM 节点；keep-alive 常挂载不释放） */
  const [expandedUnits, setExpandedUnits] = useState<Set<string>>(() => new Set());
  /** 新建单元 inline 输入态 */
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  /** 重命名中的单元 id + 草稿（Enter 提交，Esc/blur 取消） */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  /** 复习会话（null = 关闭） */
  const [session, setSession] = useState<ReviewSession | null>(null);
  /** 学习统计：按天聚合的复习日志（vocabulary_review_log，随 refresh 同刷） */
  const [reviewLog, setReviewLog] = useState<ReviewLog>({});

  const refresh = useCallback(() => {
    setNow(Date.now());
    void invoke<VocabularyEntry[]>("vocabulary_list").then(setEntries);
    void invoke<VocabularyUnit[]>("vocabulary_unit_list").then(setUnits);
    void invoke<Record<string, ReviewDayCount>>("vocabulary_review_log").then(setReviewLog);
  }, []);

  useEffect(() => {
    refresh();
    // 生词本任何变更（加词/删除/移动/复习评分，任意窗口）→ 刷新
    const unlisten = listen("vocabulary-changed", () => refresh());
    return () => {
      void unlisten.then((f) => f(), () => {});
    };
  }, [refresh]);

  /** 单元视图派生：收词箱固定首位，自建单元按创建序；词按加入时间倒序 */
  const unitViews = useMemo<UnitView[]>(() => {
    if (entries === null) return [];
    const bucket = (unitId: string): VocabularyEntry[] =>
      entries.filter((e) => e.unitId === unitId).sort((a, b) => b.addedAt - a.addedAt);
    const views: UnitView[] = [
      { id: INBOX_UNIT_ID, name: "收词箱", isInbox: true, entries: [], dueCount: 0 },
    ];
    for (const u of units) {
      const list = bucket(u.id);
      views.push({
        id: u.id,
        name: u.name,
        isInbox: false,
        entries: list,
        dueCount: list.filter((e) => e.dueAt <= now).length,
      });
    }
    views[0].entries = bucket(INBOX_UNIT_ID);
    views[0].dueCount = views[0].entries.filter((e) => e.dueAt <= now).length;
    return views;
  }, [entries, units, now]);

  const total = entries?.length ?? 0;
  const dueCount = useMemo(
    () => entries?.filter((e) => e.dueAt <= now).length ?? 0,
    [entries, now],
  );
  const todayReviewed = useMemo(() => {
    const start = startOfToday();
    return entries?.filter((e) => e.lastReviewedAt != null && e.lastReviewedAt >= start).length ?? 0;
  }, [entries]);
  /** 下一批到期时间（无到期词时显示） */
  const nextDueAt = useMemo(() => {
    const future = entries?.filter((e) => e.dueAt > now).map((e) => e.dueAt) ?? [];
    return future.length ? Math.min(...future) : null;
  }, [entries, now]);

  // ── 学习统计：三图数据派生（reviewLog 随 refresh 与 entries 同批刷新）──
  const reviewDays = useMemo(() => stackReviewDays(reviewLog, 30, now), [reviewLog, now]);
  const dueDays = useMemo(() => (entries ? dueCountsByDay(entries, 14, now) : []), [entries, now]);
  const buckets = useMemo(
    () => (entries ? statusBuckets(entries) : { fresh: 0, learning: 0, reviewing: 0 }),
    [entries],
  );
  const hasReviewHistory = reviewDays.some((d) => d.total > 0);

  /** 开始复习 / 重复练习：范围 = 全部生词（无参）或单元。
   *  到期优先——范围内有到期词只出到期（dueAt 升序，最逾期在前）；清空后切换
   *  「重复练习」提前过全量卡（正常 SM-2 评分：提前复习把间隔按易度因子推远）。
   *  按钮形态由 dueCount 驱动切换（调用方），本函数只按到期日决定队列。 */
  const startReview = useCallback(
    (view?: UnitView) => {
      if (!entries) return;
      const inScope = entries.filter((e) => !view || e.unitId === view.id);
      if (inScope.length === 0) return;
      const due = inScope.filter((e) => e.dueAt <= Date.now());
      const repeat = due.length === 0;
      const queue = [...(repeat ? inScope : due)].sort(
        (a, b) => a.dueAt - b.dueAt || a.addedAt - b.addedAt,
      );
      const label = view ? view.name : "全部生词";
      setSession({ scopeLabel: repeat ? `${label} · 重复练习` : label, queue });
    },
    [entries],
  );

  const toggleCollapse = (id: string) => {
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submitCreate = () => {
    const name = draftName.trim();
    if (!name) {
      setCreating(false);
      return;
    }
    void invoke("vocabulary_unit_create", { name })
      .then(() => setDraftName(""))
      .catch(() => {})
      .finally(() => setCreating(false));
  };

  const submitRename = () => {
    const id = renamingId;
    const name = renameDraft.trim();
    setRenamingId(null);
    if (!id || !name) return;
    void invoke("vocabulary_unit_rename", { id, name }).catch(() => {});
  };

  const removeUnit = (id: string) => {
    void invoke("vocabulary_unit_remove", { id }).catch(() => {});
  };

  const moveEntry = (entryId: string, unitId: string) => {
    void invoke("vocabulary_move", { id: entryId, unitId }).catch(() => {});
  };

  const removeEntry = (id: string) => {
    void invoke("vocabulary_remove", { id });
  };

  return (
    <SettingsContentColumn className="h-full">
      {/* 顶部统计卡：三数字 + 全局开始复习 */}
      <SettingGroup>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex items-center gap-6">
            {[
              { label: "生词", value: total },
              { label: "待复习", value: dueCount, accent: dueCount > 0 },
              { label: "今日已复习", value: todayReviewed },
            ].map(({ label, value, accent }) => (
              <div key={label} className="flex items-baseline gap-1.5">
                <span
                  className={cn(
                    "font-semibold text-2xl tabular-nums",
                    accent ? "text-orange-600" : "text-foreground",
                  )}
                >
                  {value}
                </span>
                <span className="text-muted-foreground text-xs">{label}</span>
              </div>
            ))}
          </div>
          <Button
            type="button"
            variant={dueCount > 0 ? "default" : "outline"}
            disabled={total === 0}
            title={
              dueCount > 0
                ? undefined
                : "到期前主动练习（评分照常计入调度，间隔会按掌握度拉长）"
            }
            className={
              dueCount > 0
                ? undefined
                : "border-sky-600/40 text-sky-700 hover:bg-sky-500/10 hover:text-sky-700 focus-visible:text-sky-700"
            }
            onClick={() => startReview()}
          >
            <GraduationCap className="size-4" />
            {dueCount > 0 ? `开始复习（${dueCount}）` : "重复练习"}
          </Button>
        </div>
        <SettingDescription>
          {dueCount === 0 && nextDueAt !== null
            ? `今日到期已清空，下一批 ${fmtDate(nextDueAt)}。`
            : "查词页将词头加入生词本（收词箱），学习卡中 Space 翻面、1–4 评分。"}
        </SettingDescription>
      </SettingGroup>

      {/* 学习统计：复习量按天记录（自开启统计起积累）+ 快照派生两图 */}
      <SettingGroup>
        <SettingTitle>学习统计</SettingTitle>
        <SettingDescription>
          复习量按天记录（四档评分着色，随复习积累）；到期分布与记忆状态取自当前生词快照。
        </SettingDescription>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="flex flex-col gap-1.5 md:col-span-2">
            <div className="text-foreground/80 text-xs font-medium">近 30 天复习量</div>
            {hasReviewHistory ? (
              <>
                <ReviewBars days={reviewDays} />
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  {(
                    [
                      ["again", "重来", "#dc2626"],
                      ["hard", "困难", "#d97706"],
                      ["good", "良好", "#16a34a"],
                      ["easy", "简单", "#2563eb"],
                    ] as const
                  ).map(([k, label, color]) => (
                    <span key={k} className="flex items-center gap-1.5 text-muted-foreground text-xs">
                      <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
                      {label}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-muted-foreground text-xs">暂无复习记录——完成一轮学习卡后这里会按天积累。</p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="text-foreground/80 text-xs font-medium">近 14 天到期分布</div>
            <DueBars days={dueDays} />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="text-foreground/80 text-xs font-medium">记忆状态</div>
            <StatusBar buckets={buckets} />
          </div>
        </div>
      </SettingGroup>

      {/* 单元卡列表 */}
      {entries === null && (
        <SettingGroup>
          <SettingRowTitle className="text-muted-foreground">加载中…</SettingRowTitle>
        </SettingGroup>
      )}
      {unitViews.map((view) => {
        const isCollapsed = collapsed.has(view.id);
        return (
          <SettingGroup key={view.id} className="p-0">
            {/* 头部：名称区（点击折叠）+ 操作区（互不嵌套 button） */}
            <div className="flex items-center justify-between gap-3 p-4 pb-3">
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                onClick={() => toggleCollapse(view.id)}
                aria-expanded={!isCollapsed}
              >
                {view.isInbox ? (
                  <Inbox className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <span className="flex size-4 shrink-0 items-center justify-center rounded bg-primary/10 font-semibold text-[10px] text-primary">
                    {view.name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                {renamingId === view.id ? (
                  <Input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitRename();
                      else if (e.key === "Escape") setRenamingId(null);
                    }}
                    onBlur={submitRename}
                    onClick={(e) => e.stopPropagation()}
                    className="h-7 text-sm"
                    spellCheck={false}
                  />
                ) : (
                  <>
                    <span className="truncate font-semibold text-[15px]">{view.name}</span>
                    <span className="shrink-0 text-muted-foreground text-xs">
                      {view.entries.length} 词
                      {view.dueCount > 0 && (
                        <span className="text-orange-600"> · {view.dueCount} 待复习</span>
                      )}
                    </span>
                  </>
                )}
                <ChevronDown
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-transform",
                    !isCollapsed && "rotate-180",
                  )}
                />
              </button>
              <div className="flex shrink-0 items-center gap-1.5">
                {view.entries.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    title={
                      view.dueCount > 0
                        ? undefined
                        : "到期前主动练习（评分照常计入调度）"
                    }
                    className={
                      view.dueCount > 0
                        ? "border-orange-600/40 text-orange-600 hover:bg-orange-500/10 hover:text-orange-600"
                        : "border-sky-600/40 text-sky-700 hover:bg-sky-500/10 hover:text-sky-700"
                    }
                    onClick={() => startReview(view)}
                  >
                    {view.dueCount > 0 ? `复习 ${view.dueCount}` : "重复练习"}
                  </Button>
                )}
                {!view.isInbox && renamingId !== view.id && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none"
                      aria-label="单元操作"
                    >
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => {
                          setRenameDraft(view.name);
                          setRenamingId(view.id);
                        }}
                      >
                        重命名
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => removeUnit(view.id)}
                      >
                        删除单元
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </div>

            {/* 词表（可折叠） */}
            {!isCollapsed && (
              <div className="px-4 pb-3">
                {view.entries.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    {view.isInbox ? "还没有生词 — 到词典页查询并加入。" : "暂无生词，从词行菜单移入。"}
                  </p>
                ) : (
                  <>
                    {view.entries
                      .slice(0, expandedUnits.has(view.id) ? undefined : WORDS_WINDOW)
                      .map((entry, i) => {
                    const dueNow = entry.dueAt <= now;
                    return (
                      <div key={entry.id}>
                        {i > 0 && <div className="border-border-subtle border-t" />}
                        <div className="group flex items-center justify-between gap-3 py-2">
                          <div className="min-w-0">
                            <button
                              type="button"
                              onClick={() => onLookup(entry.word)}
                              title={`查询 ${entry.word}`}
                              className="block max-w-full cursor-pointer truncate text-left font-medium text-sm transition-colors hover:text-primary"
                            >
                              {entry.word}
                            </button>
                            <div className="text-muted-foreground text-xs">
                              添加于 {fmtDate(entry.addedAt)}
                              {" · "}
                              {dueNow ? (
                                <span className="text-orange-600">待复习</span>
                              ) : (
                                `到期 ${fmtDate(entry.dueAt)}`
                              )}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none"
                                aria-label="移入单元"
                                title="移入单元"
                              >
                                <FolderInput className="size-4" />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuLabel>移入单元</DropdownMenuLabel>
                                {entry.unitId !== INBOX_UNIT_ID && (
                                  <DropdownMenuItem
                                    onClick={() => moveEntry(entry.id, INBOX_UNIT_ID)}
                                  >
                                    收词箱
                                  </DropdownMenuItem>
                                )}
                                {unitViews
                                  .filter((u) => !u.isInbox && u.id !== entry.unitId)
                                  .map((u) => (
                                    <DropdownMenuItem
                                      key={u.id}
                                      onClick={() => moveEntry(entry.id, u.id)}
                                    >
                                      {u.name}
                                    </DropdownMenuItem>
                                  ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label="删除"
                              title="从生词本删除"
                              onClick={() => removeEntry(entry.id)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                      })
                    }
                    {!expandedUnits.has(view.id) && view.entries.length > WORDS_WINDOW && (
                      <button
                        type="button"
                        onClick={() => setExpandedUnits((prev) => new Set(prev).add(view.id))}
                        className="mt-2 w-full cursor-pointer rounded-md border border-border-subtle py-1.5 text-muted-foreground text-xs transition-colors hover:bg-accent"
                      >
                        显示全部 {view.entries.length} 词
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </SettingGroup>
        );
      })}

      {/* 新建单元 */}
      {creating ? (
        <div className="mt-4 flex items-center gap-2">
          <Input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCreate();
              else if (e.key === "Escape") setCreating(false);
            }}
            placeholder="单元名称，回车创建"
            className="h-8 text-sm"
            spellCheck={false}
          />
          <Button type="button" size="sm" onClick={submitCreate}>
            创建
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
            取消
          </Button>
        </div>
      ) : (
        <button
          type="button"
          className="mt-4 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2.5 text-muted-foreground text-sm transition-colors hover:bg-accent/60 hover:text-foreground"
          onClick={() => {
            setDraftName("");
            setCreating(true);
          }}
        >
          <Plus className="size-4" />
          新建单元
        </button>
      )}

      {/* 学习方案配置组（原复习页退化形态：方案说明 + 快捷键提示） */}
      <SettingGroup>
        <SettingTitle>学习方案</SettingTitle>
        <SettingRow className="mt-3">
          <SettingRowTitle>SM-2 间隔重复</SettingRowTitle>
          <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">内置</span>
        </SettingRow>
        <SettingDescription>
          按记忆曲线到期复习，评分四档「重来 / 困难 / 良好 / 简单」——重来次日再学，其余按易度因子
          拉长间隔；新词加入即到期。删除单元时词条自动回收进收词箱。
        </SettingDescription>
      </SettingGroup>

      {/* 学习卡弹窗 */}
      <ReviewDialog session={session} onClose={() => setSession(null)} />
    </SettingsContentColumn>
  );
}
