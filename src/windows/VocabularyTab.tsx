/**
 * // from pickdict (MIT), adapted for Tauri —— VocabularyPage.tsx 平移（剥壳适配）。
 * 生词本（单元 = 复习单位）：
 * 顶部统计卡（生词 / 待复习 / 今日已复习 / 已完成单元 + 主按钮「开始今日复习」）→
 * 今日计划（打分选出的可复习单元，做完自动进入下一轮）→ 学习统计 →
 * 单元卡列表（收词箱固定首位 + 自建 / 自动聚合单元）。
 *
 * 单元卡承载：进度（`第 N 轮`、`12/20 词`、完成时间、毕业徽章）、
 * 复习 / 抽查 / 不确定词专项入口、收词箱的「智能分组 / 撤销分组」。
 * 复习会话 = ReviewDialog 学习卡弹窗（队列由 lib/reviewPlan 组装：到期 → 不确定 → 熟词抽查）；
 * 完成回调用后提交轮次或抽查记录（`vocabulary_unit_round_commit` / `_check_commit`）。
 * 数据经 vocabulary_* 全量拉取；vocabulary-changed 事件驱动刷新。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  ChevronDown,
  GraduationCap,
  Inbox,
  MoreHorizontal,
  Plus,
  Sparkles,
  Undo2,
} from "lucide-react";
import { Button } from "@onedict/ui/components/button";
import { Input } from "@onedict/ui/components/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { planGroups } from "../lib/grouping";
import {
  buildUnitStats,
  isUnsure,
  MASTERED_REPETITIONS,
  pickCheckSample,
  pickQueue,
  planUnits,
  shouldGraduate,
} from "../lib/reviewPlan";
import {
  DEFAULT_UNIT_CAPACITY,
  INBOX_UNIT_ID,
  type ReviewDayCount,
  type RoundRecord,
  type UnitLogSnapshot,
  type VocabularyEntry,
  type VocabularyUnit,
} from "../types/vocabulary";
import {
  dayKeyOf,
  dueCountsByDay,
  stackReviewDays,
  statusBuckets,
  type ReviewLog,
} from "../lib/stats";
import { DueBars, ReviewBars, StatusBar } from "../components/charts/ReviewCharts";
import ReviewDialog, {
  type ReviewSession,
  type SessionKind,
  type SessionSummary,
} from "./vocabulary/ReviewDialog";
import WordList from "./vocabulary/WordList";

/** 抽查抽样词数（单元抽查固定 5 词快验） */
const CHECK_SAMPLE_SIZE = 5;
/** 「全部生词」会话单次上限（约 3 个满员单元） */
const ALL_BATCH_SIZE = 60;
/** 今日计划默认单元数 */
const PLAN_UNITS = 3;

const EMPTY_UNIT_LOG: UnitLogSnapshot = { rounds: [], checks: [], groups: [] };

/** 单元渲染视图：收词箱 + 自建 / 自动单元统一形态（词表按加入时间倒序） */
interface UnitView {
  id: string;
  name: string;
  isInbox: boolean;
  entries: VocabularyEntry[];
  dueCount: number;
  /** 不确定词数（再次错过的词） */
  unsureCount: number;
  /** 收词箱无实体单元 */
  unit: VocabularyUnit | null;
}

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
  /** 新建单元 inline 输入态 */
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  /** 单元 inline 编辑（重命名 / 设置生词上限） */
  const [editing, setEditing] = useState<{ id: string; kind: "name" | "capacity" } | null>(null);
  const [editDraft, setEditDraft] = useState("");
  /** 复习会话（null = 关闭） */
  const [session, setSession] = useState<ReviewSession | null>(null);
  /** 学习统计：按天聚合的复习日志（vocabulary_review_log） */
  const [reviewLog, setReviewLog] = useState<ReviewLog>({});
  /** 单元日志：轮次 / 抽查 / 分组（vocabulary_unit_log） */
  const [unitLog, setUnitLog] = useState<UnitLogSnapshot>(EMPTY_UNIT_LOG);

  const refresh = useCallback(() => {
    setNow(Date.now());
    void invoke<VocabularyEntry[]>("vocabulary_list").then(setEntries);
    void invoke<VocabularyUnit[]>("vocabulary_unit_list").then(setUnits);
    void invoke<Record<string, ReviewDayCount>>("vocabulary_review_log").then(setReviewLog);
    void invoke<UnitLogSnapshot>("vocabulary_unit_log").then(setUnitLog);
  }, []);

  useEffect(() => {
    refresh();
    // 生词本任何变更（加词/删除/移动/评分/分组/轮次）→ 刷新
    const unlisten = listen("vocabulary-changed", () => refresh());
    return () => {
      void unlisten.then((f) => f(), () => {});
    };
  }, [refresh]);

  /** 单元统计（打分与展示同源） */
  const unitStats = useMemo(
    () => buildUnitStats(units, entries ?? [], now),
    [units, entries, now],
  );

  /** 单元视图派生：收词箱固定首位，自建单元按创建序；词按加入时间倒序 */
  const unitViews = useMemo<UnitView[]>(() => {
    if (entries === null) return [];
    const bucket = (unitId: string): VocabularyEntry[] =>
      entries.filter((e) => e.unitId === unitId).sort((a, b) => b.addedAt - a.addedAt);
    const unsureOf = (list: VocabularyEntry[]) => list.filter(isUnsure).length;
    const views: UnitView[] = [
      {
        id: INBOX_UNIT_ID,
        name: "收词箱",
        isInbox: true,
        entries: [],
        dueCount: 0,
        unsureCount: 0,
        unit: null,
      },
    ];
    for (const unit of units) {
      const list = bucket(unit.id);
      views.push({
        id: unit.id,
        name: unit.name,
        isInbox: false,
        entries: list,
        dueCount: list.filter((e) => e.dueAt <= now).length,
        unsureCount: unsureOf(list),
        unit,
      });
    }
    const inbox = bucket(INBOX_UNIT_ID);
    views[0].entries = inbox;
    views[0].dueCount = inbox.filter((e) => e.dueAt <= now).length;
    views[0].unsureCount = unsureOf(inbox);
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
  const doneUnits = useMemo(() => units.filter((u) => u.status === "done").length, [units]);

  /** 今日复习计划：打分排序取前 N 个单元 */
  const plan = useMemo(() => planUnits(unitStats, PLAN_UNITS), [unitStats]);
  const planFirst = useMemo(
    () => (plan.length > 0 ? units.find((u) => u.id === plan[0].id) ?? null : null),
    [plan, units],
  );

  // ── 学习统计：三图数据派生（reviewLog 随 refresh 与 entries 同批刷新）──
  const reviewDays = useMemo(() => stackReviewDays(reviewLog, 30, now), [reviewLog, now]);
  const dueDays = useMemo(() => (entries ? dueCountsByDay(entries, 14, now) : []), [entries, now]);
  const buckets = useMemo(
    () => (entries ? statusBuckets(entries) : { fresh: 0, learning: 0, reviewing: 0 }),
    [entries],
  );
  const hasReviewHistory = reviewDays.some((d) => d.total > 0);

  /** 启动单元会话：轮次（到期→不确定→熟词抽查）/ 抽查 / 不确定词专项 */
  const startUnitSession = useCallback(
    (unit: VocabularyUnit, kind: SessionKind) => {
      if (!entries) return;
      const own = entries.filter((e) => e.unitId === unit.id);
      const batchSize = unit.capacity > 0 ? unit.capacity : DEFAULT_UNIT_CAPACITY;
      const ref = { id: unit.id, name: unit.name, round: unit.round };
      const startedAt = Date.now();
      if (kind === "check") {
        const sample = pickCheckSample(own, CHECK_SAMPLE_SIZE);
        if (sample.length === 0) return;
        setSession({
          scopeLabel: `${unit.name} · 抽查`,
          queue: sample,
          unit: ref,
          kind,
          startedAt,
        });
        return;
      }
      if (kind === "focus") {
        const unsure = own.filter(isUnsure).slice(0, batchSize);
        if (unsure.length === 0) return;
        setSession({
          scopeLabel: `${unit.name} · 不确定词`,
          queue: unsure,
          unit: ref,
          kind,
          startedAt,
        });
        return;
      }
      const { queue, repeat } = pickQueue(own, { batchSize });
      if (queue.length === 0) return;
      setSession({
        scopeLabel: repeat ? `${unit.name} · 重复练习` : unit.name,
        queue,
        unit: ref,
        kind: "round",
        startedAt,
      });
    },
    [entries],
  );

  /** 越过计划：全部生词一次性复习（次级入口） */
  const startAllSession = useCallback(() => {
    const all = entries ?? [];
    const { queue, repeat } = pickQueue(all, { batchSize: ALL_BATCH_SIZE });
    if (queue.length === 0) return;
    setSession({
      scopeLabel: repeat ? "全部生词 · 重复练习" : "全部生词",
      queue,
      unit: null,
      kind: "round",
      startedAt: Date.now(),
    });
  }, [entries]);

  /** 收词箱范围复习（收词箱不是实体单元，不记轮次） */
  const startInboxSession = useCallback(() => {
    const inbox = (entries ?? []).filter((e) => e.unitId === INBOX_UNIT_ID);
    const { queue, repeat } = pickQueue(inbox, { batchSize: DEFAULT_UNIT_CAPACITY });
    if (queue.length === 0) return;
    setSession({
      scopeLabel: repeat ? "收词箱 · 重复练习" : "收词箱",
      queue,
      unit: null,
      kind: "round",
      startedAt: Date.now(),
    });
  }, [entries]);

  /** 会话完成：提交单元轮次（含毕业判定）或抽查记录；全部生词/专项不落记录 */
  const handleComplete = useCallback(
    (summary: SessionSummary) => {
      if (!summary.unitId) return;
      if (summary.kind === "check") {
        void invoke("vocabulary_unit_check_commit", {
          unitId: summary.unitId,
          sampled: summary.size,
          missed: summary.missedWords,
        }).catch(() => {});
        return;
      }
      if (summary.kind !== "round") return;
      const unit = units.find((u) => u.id === summary.unitId);
      if (!unit) return;
      const own = (entries ?? []).filter((e) => e.unitId === unit.id);
      const mastered = own.filter((e) => e.repetitions >= MASTERED_REPETITIONS).length;
      const record: RoundRecord = {
        unitId: unit.id,
        unitName: unit.name,
        round: unit.round + 1,
        startedAt: summary.startedAt,
        completedAt: summary.completedAt,
        size: summary.size,
        again: summary.grades.again,
        hard: summary.grades.hard,
        good: summary.grades.good,
        easy: summary.grades.easy,
        againPending: summary.againWords.length,
      };
      const graduate = shouldGraduate(
        [...unitLog.rounds, record],
        unit.id,
        mastered,
        own.length,
      );
      void invoke("vocabulary_unit_round_commit", {
        unitId: unit.id,
        record: {
          round: record.round,
          startedAt: record.startedAt,
          size: record.size,
          again: record.again,
          hard: record.hard,
          good: record.good,
          easy: record.easy,
          againPending: record.againPending,
          status: graduate ? "done" : undefined,
        },
      }).catch(() => {});
    },
    [units, entries, unitLog],
  );

  /** 收词箱智能分组：时间批次 + 词形族（落盘走 group_apply，可撤销） */
  const runGrouping = useCallback(() => {
    const inbox = (entries ?? []).filter((e) => e.unitId === INBOX_UNIT_ID);
    if (inbox.length < 2) return;
    const plans = planGroups(
      inbox.map((e) => ({ id: e.id, word: e.word, addedAt: e.addedAt })),
      { capacity: DEFAULT_UNIT_CAPACITY },
    );
    if (plans.length === 0) return;
    void invoke("vocabulary_group_apply", {
      groups: plans.map((p) => ({
        name: p.name,
        seed: p.seed,
        capacity: DEFAULT_UNIT_CAPACITY,
        entryIds: p.entryIds,
      })),
    }).catch(() => {});
  }, [entries]);

  const undoGrouping = () => {
    void invoke("vocabulary_group_undo").catch(() => {});
  };

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

  /** 单元 inline 编辑提交：重命名 / 生词上限（0 = 不限） */
  const submitEdit = () => {
    const current = editing;
    setEditing(null);
    if (!current) return;
    const draft = editDraft.trim();
    if (current.kind === "name") {
      if (!draft) return;
      void invoke("vocabulary_unit_rename", { id: current.id, name: draft }).catch(() => {});
      return;
    }
    const capacity = Number.parseInt(draft, 10);
    if (!Number.isFinite(capacity) || capacity < 0) return;
    void invoke("vocabulary_unit_update", {
      id: current.id,
      patch: { capacity },
    }).catch(() => {});
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
      {/* 顶部统计卡：四数字 + 今日复习主入口 */}
      <SettingGroup>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {[
              { label: "生词", value: String(total) },
              { label: "待复习", value: String(dueCount), accent: dueCount > 0 },
              { label: "今日已复习", value: String(todayReviewed) },
              {
                label: "已完成单元",
                value: `${doneUnits}/${units.length}`,
                accent: doneUnits > 0,
                accentClass: "text-green-600",
              },
            ].map(({ label, value, accent, accentClass }) => (
              <div key={label} className="flex items-baseline gap-1.5">
                <span
                  className={cn(
                    "font-semibold text-2xl tabular-nums",
                    accent ? (accentClass ?? "text-orange-600") : "text-foreground",
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
            variant={dueCount > 0 || planFirst !== null ? "default" : "outline"}
            disabled={total === 0}
            title={
              planFirst !== null
                ? `按到期排序：${plan.map((s) => s.name).join(" / ")}`
                : dueCount > 0
                  ? undefined
                  : "到期前主动练习（评分照常计入调度，间隔会按掌握度拉长）"
            }
            className={
              dueCount > 0 || planFirst !== null
                ? undefined
                : "border-sky-600/40 text-sky-700 hover:bg-sky-500/10 hover:text-sky-700 focus-visible:text-sky-700"
            }
            onClick={() => {
              if (planFirst) startUnitSession(planFirst, "round");
              else startAllSession();
            }}
          >
            <GraduationCap className="size-4" />
            {planFirst !== null
              ? plan.length > 1
                ? `开始今日复习（${plan.length} 单元）`
                : `开始今日复习（${planFirst.name}）`
              : dueCount > 0
                ? `开始复习（${dueCount}）`
                : "重复练习"}
          </Button>
        </div>
        <SettingDescription>
          {dueCount === 0 && nextDueAt !== null
            ? `今日到期已清空，下一批 ${dayKeyOf(nextDueAt)}。`
            : "单元为复习单位：一次复习一个单元，完成后进入下一轮；已掌握单元转入抽查维持。"}
        </SettingDescription>
      </SettingGroup>

      {/* 今日复习计划：打分选出的单元（次级入口「全部生词」保留在页底单元列表） */}
      {plan.length > 0 && (
        <SettingGroup>
          <SettingTitle>今日复习计划</SettingTitle>
          <SettingDescription>
            按到期密度与逾期程度排序；做完一个再做下一个，单元轮次进度即时更新。
          </SettingDescription>
          <div className="mt-3 flex flex-col">
            {plan.map((stat, i) => {
              const unit = units.find((u) => u.id === stat.id);
              if (!unit) return null;
              return (
                <div key={stat.id}>
                  {i > 0 && <div className="border-border-subtle border-t" />}
                  <div className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-sm">{stat.name}</div>
                      <div className="text-muted-foreground text-xs">
                        {stat.size} 词 · <span className="text-orange-600">{stat.dueCount} 待复习</span>
                        {stat.round > 0 && ` · 第 ${stat.round} 轮`}
                        {stat.unsureCount > 0 && (
                          <span className="text-orange-600"> · 不确定 {stat.unsureCount}</span>
                        )}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="border-orange-600/40 text-orange-600 hover:bg-orange-500/10 hover:text-orange-600"
                      onClick={() => startUnitSession(unit, "round")}
                    >
                      开始
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-muted-foreground text-xs">
              计划外：全部生词（{total} 词，单次最多 {ALL_BATCH_SIZE}）
            </span>
            <Button type="button" size="sm" variant="ghost" onClick={startAllSession}>
              全部生词
            </Button>
          </div>
        </SettingGroup>
      )}

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
        const unit = view.unit;
        const capacity = unit?.capacity ?? 0;
        const overCapacity = capacity > 0 && view.entries.length > capacity;
        const editingName = editing?.id === view.id && editing.kind === "name";
        const editingCapacity = editing?.id === view.id && editing.kind === "capacity";
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
                {editingName ? (
                  <Input
                    autoFocus
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitEdit();
                      else if (e.key === "Escape") setEditing(null);
                    }}
                    onBlur={submitEdit}
                    onClick={(e) => e.stopPropagation()}
                    className="h-7 text-sm"
                    spellCheck={false}
                  />
                ) : (
                  <>
                    <span className="truncate font-semibold text-[15px]">{view.name}</span>
                    <span className="shrink-0 text-muted-foreground text-xs">
                      {capacity > 0
                        ? `${view.entries.length}/${capacity} 词`
                        : `${view.entries.length} 词`}
                      {view.dueCount > 0 && (
                        <span className="text-orange-600"> · {view.dueCount} 待复习</span>
                      )}
                      {unit && unit.round > 0 && ` · 第 ${unit.round} 轮`}
                    </span>
                    {unit?.status === "done" && (
                      <span className="shrink-0 rounded-full bg-green-600/10 px-2 py-0.5 font-medium text-[11px] text-green-700">
                        已掌握
                      </span>
                    )}
                    {overCapacity && (
                      <span
                        className="shrink-0 text-orange-600 text-xs"
                        title={`超过单元上限 ${capacity} 词——建议移出或调高上限`}
                      >
                        超限
                      </span>
                    )}
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
                {view.unsureCount > 0 && unit && (
                  <button
                    type="button"
                    className="flex cursor-pointer items-center gap-1 rounded-md bg-orange-500/10 px-2 py-1 font-medium text-[11px] text-orange-700 transition-colors hover:bg-orange-500/20"
                    title="专项复习本单元的不确定词（评分照常计入 SM-2）"
                    onClick={() => startUnitSession(unit, "focus")}
                  >
                    <AlertTriangle className="size-3" />
                    不确定 {view.unsureCount}
                  </button>
                )}
                {view.entries.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    title={view.dueCount > 0 ? undefined : "到期前主动练习（评分照常计入调度）"}
                    className={
                      view.dueCount > 0
                        ? "border-orange-600/40 text-orange-600 hover:bg-orange-500/10 hover:text-orange-600"
                        : "border-sky-600/40 text-sky-700 hover:bg-sky-500/10 hover:text-sky-700"
                    }
                    onClick={() =>
                      unit ? startUnitSession(unit, "round") : startInboxSession()
                    }
                  >
                    {view.dueCount > 0 ? `复习 ${view.dueCount}` : "重复练习"}
                  </Button>
                )}
                {unit && unit.round > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    title="随机抽 5 词快验（不记轮次，只记抽查结果）"
                    onClick={() => startUnitSession(unit, "check")}
                  >
                    抽查
                  </Button>
                )}
                {view.isInbox && view.entries.length >= 2 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    title="按时间批次与词形族自动整理为单元"
                    onClick={runGrouping}
                  >
                    <Sparkles className="size-4" />
                    智能分组
                  </Button>
                )}
                {view.isInbox && unitLog.groups.length > 0 && (
                  <button
                    type="button"
                    className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label="撤销分组"
                    title="撤销最近一次智能分组（单元删除、词条回收进收词箱）"
                    onClick={undoGrouping}
                  >
                    <Undo2 className="size-4" />
                  </button>
                )}
                {!view.isInbox && !editingName && !editingCapacity && (
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
                          setEditDraft(view.name);
                          setEditing({ id: view.id, kind: "name" });
                        }}
                      >
                        重命名
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          setEditDraft(String(capacity || DEFAULT_UNIT_CAPACITY));
                          setEditing({ id: view.id, kind: "capacity" });
                        }}
                      >
                        设置生词上限
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

            {/* 上限 inline 编辑 */}
            {editingCapacity && (
              <div className="flex items-center gap-2 px-4 pb-3">
                <span className="shrink-0 text-muted-foreground text-xs">生词上限</span>
                <Input
                  autoFocus
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitEdit();
                    else if (e.key === "Escape") setEditing(null);
                  }}
                  onBlur={submitEdit}
                  inputMode="numeric"
                  className="h-7 w-24 text-sm"
                  spellCheck={false}
                />
                <span className="text-muted-foreground text-xs">0 = 不限（当前 {view.entries.length} 词）</span>
              </div>
            )}

            {/* 词表（可折叠；词数超阈值走虚拟滚动，见 vocabulary/WordList） */}
            {!isCollapsed && (
              <div className="px-4 pb-3">
                {view.entries.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    {view.isInbox ? "还没有生词 — 到词典页查询并加入。" : "暂无生词，从词行菜单移入。"}
                  </p>
                ) : (
                  <WordList
                    entries={view.entries}
                    now={now}
                    moveTargets={unitViews}
                    onLookup={onLookup}
                    onMove={moveEntry}
                    onRemove={removeEntry}
                  />
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
          拉长间隔；新词加入即到期。单元容量默认 {DEFAULT_UNIT_CAPACITY} 词，一次复习上限即单元容量；
          连续两轮无「重来」且八成词进入长间隔即视为已掌握，转入抽查维持。
        </SettingDescription>
      </SettingGroup>

      {/* 学习卡弹窗 */}
      <ReviewDialog
        session={session}
        onClose={() => setSession(null)}
        onComplete={handleComplete}
        onFocusAgain={
          session?.unit
            ? () => {
                const unit = units.find((u) => u.id === session.unit!.id);
                if (unit) startUnitSession(unit, "focus");
              }
            : undefined
        }
      />
    </SettingsContentColumn>
  );
}
