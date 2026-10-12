/**
 * 检查页签（长文工作台）：二级分类侧栏 + 编辑区/结果双栏 + 忽略/术语表/白名单管理。
 *
 * 外壳职责 = 数据与检查管线（范式照抄设置页：aside w-44 左条选中态 + 事件节拍）：
 * - 事件节拍：check-terms-changed 广播后重拉配置（数据恢复 / 外部写入收口）。
 *   **不监听 check-session-changed**——会话每轮检查保存即广播，监听会与检查
 *   管线形成回环（保存 → 广播 → 重拉 → 新引用 → 重查 → 再保存…）。
 * - 检查管线：文本 / 术语表 / 白名单任一变更，停顿后自动跑规则层（同步毫秒级）
 *   + 词典拼写探针（异步，一次 IPC，失败整层静默降级）→ 合并 findings，
 *   完成即落会话（findings 快照 + 摘要；全文不落盘，只落哈希）。
 * - 忽略 = 展示期过滤（ruleId+quote 键控），不触发重查；清单持久化后
 *   重开不复发。术语表/白名单变更驱动重查（即改即生效）。
 * - 单点修复按「span 区段仍等于 quote」验证后才应用——停顿窗口内未触及
 *   该区段的编辑不会导致错误替换。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cn } from "../lib/utils";
import { applyFixes, runRuleChecks } from "../lib/langcheck/engine";
import { runSpellChecks } from "../lib/langcheck/spellCheck";
import { ignoreKey, textHash } from "../lib/langcheck/session";
import { CATEGORY_LABELS } from "../lib/langcheck/labels";
import type { Finding } from "../lib/langcheck/finding";
import type { CheckTermsPayload, IgnoredEntry, TermEntry } from "../types/check";
import Workbench, { type CategoryFilter } from "./check/Workbench";
import TermsSection from "./check/TermsSection";
import WhitelistSection from "./check/WhitelistSection";
import IgnoredSection from "./check/IgnoredSection";

type Section = CategoryFilter | "terms" | "whitelist" | "ignored";

const CATEGORIES: CategoryFilter[] = ["all", "layout", "typo", "terminology", "style", "ai-tell"];

/** 停顿自动检查（规则层毫秒级但拼写探针是 IPC——停顿触发，不逐键） */
const CHECK_DEBOUNCE_MS = 500;

/** 会话摘要首行（展示标签；全文不落盘） */
function previewOf(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 40);
}

export default function CheckTab() {
  const [section, setSection] = useState<Section>("all");

  // ── 用户检查配置（check-terms.json）──
  const [tick, setTick] = useState(0);
  const [terms, setTerms] = useState<TermEntry[]>([]);
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [ignored, setIgnored] = useState<IgnoredEntry[]>([]);

  const reload = useCallback(() => {
    void invoke<CheckTermsPayload>("check_terms_get")
      .then((p) => {
        setTerms(p.terms);
        setWhitelist(p.whitelist);
        setIgnored(p.ignored);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    reload();
  }, [reload, tick]);

  useEffect(() => {
    const un = listen("check-terms-changed", () => setTick((t) => t + 1));
    return () => {
      void un.then((f) => f(), () => {});
    };
  }, []);

  // ── 检查管线（文本 + 规则层 + 拼写探针）──
  const [text, setText] = useState("");
  const [findings, setFindings] = useState<Finding[]>([]);
  /** 生成当前 findings 时的文本快照（「检查结果是否仍对应当前文本」判据） */
  const [checkedText, setCheckedText] = useState("");
  const [checking, setChecking] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!text.trim()) {
      setFindings([]);
      setCheckedText("");
      return;
    }
    const seq = ++seqRef.current;
    const timer = window.setTimeout(() => {
      setChecking(true);
      const ruleFindings = runRuleChecks(text, { terms });
      void runSpellChecks(text, whitelist, (words) =>
        invoke<boolean[]>("check_spell_lookup", { words }),
      ).then((spellFindings) => {
        if (seqRef.current !== seq) return;
        const all = [...ruleFindings, ...spellFindings].sort(
          (a, b) => (a.span?.index ?? 0) - (b.span?.index ?? 0),
        );
        setFindings(all);
        setCheckedText(text);
        setChecking(false);
        // 会话落盘：findings 快照 + 摘要（全文不入库，隐私 + 体积）
        void invoke("check_session_save", {
          entry: {
            createdAt: Date.now(),
            textHash: textHash(text),
            charCount: text.length,
            preview: previewOf(text),
            summary: { total: all.length, fixable: all.filter((f) => f.fixable).length },
            findings: all,
          },
        }).catch(() => {});
      }).catch(() => {
        // 探针层自身已静默降级，这里只兜 then 回调的意外异常，防止 checking 卡死
        if (seqRef.current === seq) setChecking(false);
      });
    }, CHECK_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, terms, whitelist]);

  // ── 忽略过滤与分类计数（展示期，不触发重查）──
  const ignoredSet = useMemo(
    () => new Set(ignored.map((e) => ignoreKey(e.ruleId, e.quote))),
    [ignored],
  );
  const visibleFindings = useMemo(
    () => findings.filter((f) => !ignoredSet.has(ignoreKey(f.ruleId, f.quote))),
    [findings, ignoredSet],
  );
  const ignoredVisibleCount = findings.length - visibleFindings.length;
  const counts = useMemo(() => {
    const map = new Map<CategoryFilter, number>([["all", visibleFindings.length]]);
    for (const f of visibleFindings) {
      map.set(f.category, (map.get(f.category) ?? 0) + 1);
    }
    return map;
  }, [visibleFindings]);

  // ── 编辑与修复动作 ──
  const handleText = useCallback((next: string) => {
    setText(next);
    setSelectedId(null);
  }, []);

  /** 单点修复：span 区段仍与 quote 吻合才应用（停顿窗口内未触及该区段可安全修） */
  const applyFix = useCallback((f: Finding) => {
    setText((cur) => {
      if (!f.span || f.replacement === null) return cur;
      if (cur.slice(f.span.index, f.span.index + f.span.length) !== f.quote) return cur;
      return cur.slice(0, f.span.index) + f.replacement + cur.slice(f.span.index + f.span.length);
    });
    setSelectedId(null);
  }, []);

  /** 批量修复：只应用区段仍吻合的可修复项 */
  const applyAllFixes = useCallback((list: Finding[]) => {
    setText((cur) => {
      const safe = list.filter(
        (f) =>
          f.span !== null &&
          cur.slice(f.span.index, f.span.index + f.span.length) === f.quote,
      );
      return applyFixes(cur, safe);
    });
    setSelectedId(null);
  }, []);

  // ── 配置变更动作（变更即广播 → 节拍重拉；返回值就地更新省一轮往返）──
  const saveTerms = useCallback((list: TermEntry[]) => {
    return invoke<CheckTermsPayload>("check_terms_save", { terms: list }).then((p) => {
      setTerms(p.terms);
      setWhitelist(p.whitelist);
      setIgnored(p.ignored);
    });
  }, []);

  const ignoreFinding = useCallback((ruleId: string, quote: string) => {
    void invoke<IgnoredEntry[]>("check_ignored_add", { ruleId, quote })
      .then(setIgnored)
      .catch(() => {});
  }, []);

  const addWhitelist = useCallback((word: string) => {
    return invoke<string[]>("check_whitelist_add", { word }).then(setWhitelist);
  }, []);

  const removeWhitelist = useCallback((word: string) => {
    return invoke<string[]>("check_whitelist_remove", { word }).then(setWhitelist);
  }, []);

  const removeIgnored = useCallback((ruleId: string, quote: string) => {
    return invoke<IgnoredEntry[]>("check_ignored_remove", { ruleId, quote }).then(setIgnored);
  }, []);

  const restoreAllIgnored = useCallback(() => {
    return Promise.all(
      ignored.map((e) =>
        invoke("check_ignored_remove", { ruleId: e.ruleId, quote: e.quote }).catch(() => {}),
      ),
    ).then(() => reload());
  }, [ignored, reload]);

  const isCategorySection = (section: Section): section is CategoryFilter =>
    CATEGORIES.includes(section as CategoryFilter);

  return (
    <div className="flex h-full min-h-0">
      {/* 子导航：分类（过滤当前检查结果）+ 管理（术语表 / 白名单 / 忽略） */}
      <aside className="flex w-44 shrink-0 flex-col gap-4 border-r border-border px-3 py-4">
        <div className="flex flex-col gap-1">
          <p className="px-3 pb-1 text-muted-foreground text-xs select-none">分类</p>
          {CATEGORIES.map((c) => (
            <SideBtn
              key={c}
              label={c === "all" ? "全部" : CATEGORY_LABELS[c]}
              count={counts.get(c) ?? 0}
              active={section === c}
              onClick={() => setSection(c)}
            />
          ))}
        </div>
        <div className="flex flex-col gap-1">
          <p className="px-3 pb-1 text-muted-foreground text-xs select-none">管理</p>
          <SideBtn
            label="术语表"
            count={terms.length}
            active={section === "terms"}
            onClick={() => setSection("terms")}
          />
          <SideBtn
            label="拼写白名单"
            count={whitelist.length}
            active={section === "whitelist"}
            onClick={() => setSection("whitelist")}
          />
          <SideBtn
            label="已忽略"
            count={ignored.length}
            active={section === "ignored"}
            onClick={() => setSection("ignored")}
          />
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {/* 工作台常挂载（hidden 切换）：切去管理页不丢编辑文本与结果，
            术语/白名单在外壳层变更即触发重查 */}
        <div className={isCategorySection(section) ? "h-full" : "hidden"}>
          <Workbench
            category={isCategorySection(section) ? section : "all"}
            text={text}
            findings={visibleFindings}
            checking={checking}
            fresh={text === checkedText}
            selectedId={selectedId}
            ignoredCount={ignoredVisibleCount}
            onText={handleText}
            onSelect={setSelectedId}
            onFix={applyFix}
            onFixAll={applyAllFixes}
            onIgnore={ignoreFinding}
            onWhitelist={(word) => void addWhitelist(word).catch(() => {})}
          />
        </div>
        {section === "terms" && <TermsSection terms={terms} onSave={saveTerms} />}
        {section === "whitelist" && (
          <WhitelistSection
            whitelist={whitelist}
            onAdd={addWhitelist}
            onRemove={removeWhitelist}
          />
        )}
        {section === "ignored" && (
          <IgnoredSection ignored={ignored} onRemove={removeIgnored} onRestoreAll={restoreAllIgnored} />
        )}
      </div>
    </div>
  );
}

/** 侧栏条目（设置页同款语言：左条选中 + 计数徽标） */
function SideBtn({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex w-full cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-left text-sm transition-colors",
        active
          ? "font-medium text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {active && (
        <span className="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">{count}</span>
    </button>
  );
}
