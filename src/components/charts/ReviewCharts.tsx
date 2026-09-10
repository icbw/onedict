/**
 * 学习统计图表：自绘 SVG 零依赖——安装包体积敏感，
 * 不引图表库；柱状图 = 均分网格 + 堆叠/单层 rect。
 *
 * **刻度文字必须在 HTML 层**（实测坑：SVG preserveAspectRatio="none" 会把
 * <text> 与柱子一起非均匀拉伸——字体横向变形）；SVG 只画 rect，刻度用百分比
 * 定位层与柱位对齐，hover 数值用 SVG <title>（HTML Tooltip 原语管不到 SVG 子元素）。
 */

import type { DueDay, ReviewDay, StatusBuckets } from "../../lib/stats";

/** 四档评分着色（Tailwind 色板十六进制值；SVG fill 不吃工具类） */
const GRADE_COLORS = {
  again: "#dc2626", // red-600
  hard: "#d97706", // amber-600
  good: "#16a34a", // green-600
  easy: "#2563eb", // blue-600
} as const;

/** 横轴刻度步长：n 根柱最多标 ~6 个刻度 */
const labelStep = (n: number) => Math.ceil(n / 6);

/** 短日期 M/D（横轴刻度） */
const shortDate = (key: string) => {
  const [, m, d] = key.split("-");
  return `${Number(m)}/${Number(d)}`;
};

const BAR_H = 120; // 柱区高（viewBox 单位；纵向近 1:1 渲染）
const SLOT = 10; // 每根柱占位宽（viewBox 单位）
const BAR_W = 6;

/**
 * 横轴刻度行（HTML 层）：labels[i] = null 不显示；柱 i 中心在 ((i+0.5)/n)*100%。
 * 末位刻度右对齐防溢出；与前一 step 刻度恰合时跳过（防「+12 +13」重叠）。
 */
function AxisLabels({ labels }: { labels: (string | null)[] }) {
  const n = labels.length;
  const step = labelStep(n);
  return (
    <div className="relative h-4">
      {labels.map((label, i) => {
        if (label === null) return null;
        const isLast = i === n - 1;
        if (isLast && i % step === 0) return null; // 已被步长刻度覆盖
        const transform = i === 0 ? undefined : isLast ? "translateX(-100%)" : "translateX(-50%)";
        return (
          <span
            key={i}
            className="absolute top-0 text-[10px] leading-4 whitespace-nowrap text-muted-foreground/60"
            style={{ left: `${((i + 0.5) / n) * 100}%`, transform }}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}

/** 近 N 天复习量堆叠柱状图（四档评分着色；空天不出柱只留网格） */
export function ReviewBars({ days }: { days: ReviewDay[] }) {
  const n = days.length;
  const max = Math.max(...days.map((d) => d.total), 1);
  const labels = days.map((d, i) =>
    i % labelStep(n) === 0 || i === n - 1 ? shortDate(d.key) : null,
  );
  return (
    <div className="flex flex-col gap-1">
      <svg
        viewBox={`0 0 ${n * SLOT} ${BAR_H}`}
        preserveAspectRatio="none"
        className="h-28 w-full"
        role="img"
        aria-label="近 30 天复习量"
      >
        {/* 底线 */}
        <line x1={0} y1={BAR_H - 0.5} x2={n * SLOT} y2={BAR_H - 0.5} stroke="currentColor" strokeOpacity={0.2} strokeWidth={1} />
        {days.map((d, i) => {
          const x = i * SLOT + (SLOT - BAR_W) / 2;
          // 自底向上堆叠：again → hard → good → easy
          const segs = (["again", "hard", "good", "easy"] as const).map((g) => ({
            grade: g,
            v: d[g],
          }));
          let acc = 0;
          const total = d.total;
          return (
            <g key={d.key}>
              {total > 0 &&
                segs.map(({ grade, v }) => {
                  if (v === 0) return null;
                  const h = (v / max) * (BAR_H - 10);
                  const y = BAR_H - (acc + h);
                  acc += h;
                  return (
                    <rect key={grade} x={x} y={y} width={BAR_W} height={Math.max(h, 1)} fill={GRADE_COLORS[grade]}>
                      <title>{`${d.key}：共 ${total}（重来 ${d.again} / 困难 ${d.hard} / 良好 ${d.good} / 简单 ${d.easy}）`}</title>
                    </rect>
                  );
                })}
            </g>
          );
        })}
      </svg>
      <AxisLabels labels={labels} />
    </div>
  );
}

/** 未来 N 天到期分布（今日/逾期 = 橙强调，未来 = 蓝） */
export function DueBars({ days }: { days: DueDay[] }) {
  const n = days.length;
  const max = Math.max(...days.map((d) => d.count), 1);
  const labels = days.map((d, i) => (i % labelStep(n) === 0 || i === n - 1 ? d.label : null));
  return (
    <div className="flex flex-col gap-1">
      <svg
        viewBox={`0 0 ${n * SLOT} ${BAR_H}`}
        preserveAspectRatio="none"
        className="h-28 w-full"
        role="img"
        aria-label="未来 14 天到期分布"
      >
        <line x1={0} y1={BAR_H - 0.5} x2={n * SLOT} y2={BAR_H - 0.5} stroke="currentColor" strokeOpacity={0.2} strokeWidth={1} />
        {days.map((d, i) => {
          const x = i * SLOT + (SLOT - BAR_W) / 2;
          const h = d.count > 0 ? Math.max((d.count / max) * (BAR_H - 10), 2) : 0;
          const today = i === 0;
          return (
            <g key={d.key}>
              {d.count > 0 && (
                <rect x={x} y={BAR_H - h} width={BAR_W} height={h} fill={today ? "#ea580c" : "#60a5fa"}>
                  <title>{`${d.label}（${d.key}）：到期 ${d.count}`}</title>
                </rect>
              )}
            </g>
          );
        })}
      </svg>
      <AxisLabels labels={labels} />
    </div>
  );
}

const STATUS_SEGMENTS = [
  { key: "fresh", label: "新词", color: "#3b82f6" }, // blue-500
  { key: "learning", label: "学习中", color: "#f59e0b" }, // amber-500
  { key: "reviewing", label: "复习中", color: "#16a34a" }, // green-600
] as const;

/** 记忆状态分段横条 + 图例（数值即图例文字，无需 hover 提示） */
export function StatusBar({ buckets }: { buckets: StatusBuckets }) {
  const total = STATUS_SEGMENTS.reduce((s, seg) => s + (buckets[seg.key] ?? 0), 0);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
        {total > 0 &&
          STATUS_SEGMENTS.map(({ key, color }) => {
            const v = buckets[key] ?? 0;
            if (v === 0) return null;
            return <div key={key} style={{ width: `${(v / total) * 100}%`, backgroundColor: color }} />;
          })}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {STATUS_SEGMENTS.map(({ key, label, color }) => (
          <span key={key} className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
            {label}
            <span className="font-medium tabular-nums text-foreground">{buckets[key] ?? 0}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
